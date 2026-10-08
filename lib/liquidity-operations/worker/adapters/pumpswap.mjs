import { createRequire } from 'node:module';
import { unpackAccount } from '@solana/spl-token';
import { BN, key, raw, integer, bps, pair, mint, amount, limit, assertPool, assertMints } from './meteora-common.mjs';
const require = createRequire(import.meta.url);
const { OnlinePumpAmmSdk, PUMP_AMM_SDK } = require('@pump-fun/pump-swap-sdk');
const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
async function load(ctx, request) {
  const pool = await assertPool(ctx, request.pool, PROGRAM);
  const state = await new OnlinePumpAmmSdk(ctx.connection).liquiditySolanaState(pool, ctx.owner);
  if (state.pool.boostEnabled) throw new Error('Boost pools do not support deposit or withdrawal');
  assertMints(request, state.pool.baseMint, state.pool.quoteMint);
  const [a,b] = await pair(ctx,state.pool.baseMint,state.pool.quoteMint);
  const lp = await mint(ctx,state.pool.lpMint);
  return {state,a,b,lp};
}
function balance(state, lp) { return state.userPoolAccountInfo ? new BN(unpackAccount(state.userPoolTokenAccount,state.userPoolAccountInfo,lp.program).amount.toString()) : new BN(0); }
async function initialize(ctx,request) {
  const [a,b]=await pair(ctx,request.mintA,request.mintB);
  const state=await new OnlinePumpAmmSdk(ctx.connection).createPoolSolanaState(integer(request.parameters?.index,'index',1,65535,1),ctx.owner,a.address,b.address);
  if(await ctx.connection.getAccountInfo(state.poolKey,'confirmed')) throw new Error('This pool index already exists for this creator and pair');
  return {a,b,state,amountA:raw(request.amountA,'amountA'),amountB:raw(request.amountB,'amountB')};
}
export const adapter = {
 id:'pumpswap', programIds:[PROGRAM], capabilities:{initialize:true,add:true,remove:true,positions:true},
 parameters:{initialize:[{name:'index',type:'integer',default:1,min:1,max:65535}],add:[],remove:[]},
 async positions(ctx,request) {
  if(!request.pool) throw new Error('PumpSwap positions require a pool address');
  const {state,lp,a,b}=await load(ctx,request); const owned=balance(state,lp);
  return owned.isZero()?[]:[{id:state.userPoolTokenAccount.toBase58(),pool:request.pool,owner:ctx.owner.toBase58(),liquidity:owned.toString(),mintA:a.address.toBase58(),mintB:b.address.toBase58(),lpMint:lp.address.toBase58(),kind:'fungible-lp'}];
 },
 async quote(ctx,request) {
  if(request.operation==='initialize') { const d=await initialize(ctx,request); return {pool:d.state.poolKey.toBase58(),slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(d.a,d.amountA,d.amountA,'debit'),amount(d.b,d.amountB,d.amountB,'debit')],details:{index:d.state.index},warnings:['Pool initialization creates a permissionless pool; account rent and network fees are additional.']}; }
  const {state,a,b,lp}=await load(ctx,request); const slip=bps(request)/100;
  if(request.operation==='add') {
   const input=raw(request.amountA,'amountA'); const d=PUMP_AMM_SDK.depositBaseInput(state,input,slip);
   if(d.lpToken.isZero()) throw new Error('Deposit is too small to mint LP tokens');
   if(request.amountB && d.maxQuote.gt(raw(request.amountB,'amountB'))) throw new Error('amountB is below the required quote-token maximum');
   return {pool:request.pool,slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(a,input,d.maxBase,'debit'),amount(b,d.quote,d.maxQuote,'debit'),amount(lp,d.lpToken,d.lpToken,'credit')],details:{liquidity:d.lpToken.toString()}};
  }
  if(request.operation!=='remove') throw new Error('Unsupported liquidity operation');
  const input=raw(request.liquidity,'liquidity'); if(input.gt(balance(state,lp))) throw new Error('Insufficient unlocked LP token balance');
  const d=PUMP_AMM_SDK.withdrawInputs(state,input,slip);
  return {pool:request.pool,slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(lp,input,input,'debit'),amount(a,d.base,d.minBase,'credit'),amount(b,d.quote,d.minQuote,'credit')],details:{liquidity:input.toString()}};
 },
 async build(ctx,request,quote) {
  let instructions;
  if(request.operation==='initialize') {const d=await initialize(ctx,request); if(d.state.poolKey.toBase58()!==quote.pool) throw new Error('Pool identity changed'); instructions=await PUMP_AMM_SDK.createPoolInstructions(d.state,limit(quote,d.a,'debit'),limit(quote,d.b,'debit'));}
  else {const {state,a,b,lp}=await load(ctx,request);
   instructions=request.operation==='add' ? await PUMP_AMM_SDK.depositInstructionsInternal(state,limit(quote,lp,'credit'),limit(quote,a,'debit'),limit(quote,b,'debit')) : await PUMP_AMM_SDK.withdrawInstructionsInternal(state,limit(quote,lp,'debit'),limit(quote,a,'credit'),limit(quote,b,'credit'));
  }
  return {pool:quote.pool,transactions:[{instructions,signers:[]}]};
 }
};
export default adapter;
