import { createRequire } from 'node:module';
import { BN, key, raw, integer, bps, pair, mint, amount, limit, transactions, assertPool, alignRequest, minimum, maximum } from './meteora-common.mjs';
const require = createRequire(import.meta.url);
const sdk = require('@meteora-ag/dynamic-amm-sdk');
const {calculateWithdrawableAmount}=require('@meteora-ag/vault-sdk');
const Amm = sdk.default ?? sdk.AmmImpl;
const {deriveCustomizablePermissionlessConstantProductPoolAddress}=require('@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils.js');
const PROGRAM='Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
async function load(ctx,request) {
 const address=await assertPool(ctx,request.pool,PROGRAM); const pool=await Amm.create(ctx.connection,address);
 request=alignRequest(request,pool.poolState.tokenAMint,pool.poolState.tokenBMint);
 const [a,b]=await pair(ctx,pool.poolState.tokenAMint,pool.poolState.tokenBMint,true); const lp=await mint(ctx,pool.poolState.lpMint,true);
 return {pool,a,b,lp,request};
}
async function init(ctx,request) {
 const [a,b]=await pair(ctx,request.mintA,request.mintB,true); const amountA=raw(request.amountA,'amountA'), amountB=raw(request.amountB,'amountB');
 const address=deriveCustomizablePermissionlessConstantProductPoolAddress(a.address,b.address,key(PROGRAM));
 if(await ctx.connection.getAccountInfo(address,'confirmed')) throw new Error('A customizable DAMM v1 pool already exists for this pair');
 return {a,b,amountA,amountB,address,feeBps:integer(request.parameters?.feeBps,'feeBps',1,1000,30)};
}
export const adapter={
 id:'meteora-damm',programIds:[PROGRAM],capabilities:['initialize','add','remove'],
 parameters:{initialize:[{name:'feeBps',label:'Trading fee (bps)',type:'integer',default:30,min:1,max:1000}],add:[],remove:[]},
 async positions(ctx,request) {
  if(!request.pool) throw new Error('DAMM v1 positions require a pool address'); const {pool,a,b,lp}=await load(ctx,request); const balance=await pool.getUserBalance(ctx.owner);
  return balance.isZero()?[]:[{id:lp.address.toBase58(),pool:request.pool,owner:ctx.owner.toBase58(),liquidity:balance.toString(),mintA:a.address.toBase58(),mintB:b.address.toBase58(),lpMint:lp.address.toBase58(),kind:'fungible-lp'}];
 },
 async quote(ctx,request) {
  if(request.operation==='initialize') {const d=await init(ctx,request);return {pool:d.address.toBase58(),slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(d.a,d.amountA,d.amountA,'debit'),amount(d.b,d.amountB,d.amountB,'debit')],details:{feeBps:d.feeBps},warnings:['Account rent and network fees are additional. Locked LP is excluded from removable balances.']};}
  const loaded=await load(ctx,request); const {pool,a,b,lp}=loaded; request=loaded.request; const slip=bps(request)/100;
  if(request.operation==='add') {
   const isA=request.amountA!==undefined;const input=raw(isA?request.amountA:request.amountB,'deposit amount'); const x=isA?input:new BN(0),y=isA?new BN(0):input; const baseline=pool.getDepositQuote(x,y,true,0);
   if(!pool.isStablePool){
    // add_balance_liquidity takes an exact LP target, unlike stable-pool minimum-output deposits.
    const info=pool.accountsInfo,ceil=(n,d)=>n.add(d).subn(1).div(d);
    const underlying=(vaultLp,vaultSupply,vaultState)=>ceil(ceil(baseline.poolTokenAmountOut.mul(vaultLp),info.poolLpSupply).mul(calculateWithdrawableAmount(info.currentTime.toNumber(),vaultState)),vaultSupply);
    baseline.tokenAInAmount=underlying(info.poolVaultALp,info.vaultALpSupply,pool.vaultA.vaultState);
    baseline.tokenBInAmount=underlying(info.poolVaultBLp,info.vaultBLpSupply,pool.vaultB.vaultState);
   }
   const d={...baseline,minPoolTokenAmountOut:pool.isStablePool?minimum(baseline.poolTokenAmountOut,bps(request)):baseline.poolTokenAmountOut,tokenAInAmount:maximum(baseline.tokenAInAmount,bps(request)),tokenBInAmount:maximum(baseline.tokenBInAmount,bps(request))};
   if(d.minPoolTokenAmountOut.isZero()) throw new Error('Deposit is too small to mint LP tokens');
   if(isA && request.amountB && d.tokenBInAmount.gt(raw(request.amountB,'amountB'))) throw new Error('amountB is below the required quote-token maximum');
   return {pool:request.pool,slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(a,baseline.tokenAInAmount,d.tokenAInAmount,'debit'),amount(b,baseline.tokenBInAmount,d.tokenBInAmount,'debit'),amount(lp,d.poolTokenAmountOut,d.minPoolTokenAmountOut,'credit')],details:{mintA:a.address.toBase58(),mintB:b.address.toBase58(),liquidity:d.poolTokenAmountOut.toString()}};
  }
  if(request.operation!=='remove') throw new Error('Unsupported liquidity operation');
  const input=raw(request.liquidity,'liquidity'); if(input.gt(await pool.getUserBalance(ctx.owner))) throw new Error('Insufficient unlocked LP token balance');
  const d=pool.getWithdrawQuote(input,0);d.minTokenAOutAmount=minimum(d.tokenAOutAmount,bps(request));d.minTokenBOutAmount=minimum(d.tokenBOutAmount,bps(request));
  return {pool:request.pool,slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(lp,input,input,'debit'),amount(a,d.tokenAOutAmount,d.minTokenAOutAmount,'credit'),amount(b,d.tokenBOutAmount,d.minTokenBOutAmount,'credit')],details:{mintA:a.address.toBase58(),mintB:b.address.toBase58(),liquidity:input.toString()}};
 },
 async build(ctx,request,quote) {
  let tx;
  if(request.operation==='initialize') {const d=await init(ctx,request); if(d.address.toBase58()!==quote.pool) throw new Error('Pool identity changed'); tx=await Amm.createCustomizablePermissionlessConstantProductPool(ctx.connection,ctx.owner,d.a.address,d.b.address,limit(quote,d.a,'debit'),limit(quote,d.b,'debit'),{tradeFeeNumerator:d.feeBps*10,activationType:1,activationPoint:null,hasAlphaVault:false,padding:Array(90).fill(0)});}
  else {const {pool,a,b,lp}=await load(ctx,request); tx=request.operation==='add'?await pool.deposit(ctx.owner,limit(quote,a,'debit'),limit(quote,b,'debit'),limit(quote,lp,'credit')):await pool.withdraw(ctx.owner,limit(quote,lp,'debit'),limit(quote,a,'credit'),limit(quote,b,'credit'));}
  return {pool:quote.pool,transactions:transactions(tx)};
 }
};
export default adapter;
