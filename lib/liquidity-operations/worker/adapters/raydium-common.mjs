import { createHash } from 'node:crypto';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount, getTransferFeeConfig, getEpochFee, getTransferHook, getDefaultAccountState, getPausableConfig, AccountState, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { resolveOrCreateATAs } from '@orca-so/common-sdk';
import { Raydium, toApiV3Token } from '@raydium-io/raydium-sdk-v2';
export const U64=(1n<<64n)-1n,U128=(1n<<128n)-1n;
export function raw(value,label='Amount',maximum=U64){if(typeof value!=='string'||!/^[1-9]\d*$/.test(value)||BigInt(value)>maximum)throw new Error(`${label} must be a positive atomic integer`);return BigInt(value);}
export async function raydium(ctx){return Raydium.load({connection:ctx.connection,owner:ctx.owner,cluster:'mainnet',disableLoadToken:true,disableFeatureCheck:true});}
export async function account(ctx,address,program,label,layout,discriminator){const key=new PublicKey(address),info=await ctx.connection.getAccountInfo(key,'confirmed');if(!info||info.executable||!info.owner.equals(program)||info.data.length<layout.span)throw new Error(`Invalid ${label} account owner or size`);if(discriminator&&!info.data.subarray(0,8).equals(createHash('sha256').update(`account:${discriminator}`).digest().subarray(0,8)))throw new Error(`Invalid ${label} discriminator`);return layout.decode(info.data);}
export async function mint(ctx,address){const key=new PublicKey(address),info=await ctx.connection.getAccountInfo(key,'confirmed');if(!info||!info.owner.equals(TOKEN_PROGRAM_ID)&&!info.owner.equals(TOKEN_2022_PROGRAM_ID))throw new Error('Unsupported mint owner');const value=unpackMint(key,info,info.owner);if(!value.isInitialized)throw new Error('Mint is not initialized');if(getTransferHook(value)?.programId&&!getTransferHook(value).programId.equals(PublicKey.default))throw new Error('Raydium does not forward active transfer-hook accounts');if(getDefaultAccountState(value)?.state===AccountState.Frozen||getPausableConfig(value)?.paused)throw new Error('Mint is paused or creates frozen accounts');const config=getTransferFeeConfig(value),fee=config?getEpochFee(config,BigInt((await ctx.connection.getEpochInfo('confirmed')).epoch)):null;return {...toApiV3Token({address:key.toBase58(),decimals:value.decimals,programId:info.owner.toBase58()}),supplyRaw:value.supply.toString(),...(fee?{transferFee:{basisPoints:fee.transferFeeBasisPoints,maximumFeeRaw:fee.maximumFee.toString()}}:{})};}
export async function holding(ctx,mintAddress,program,amount=1n){const response=await ctx.connection.getTokenAccountsByOwner(ctx.owner,{mint:new PublicKey(mintAddress)},'confirmed');return response.value.find(({pubkey,account})=>{const token=unpackAccount(pubkey,account,new PublicKey(program));return token.mint.toBase58()===mintAddress&&token.owner.equals(ctx.owner)&&token.isInitialized&&!token.isFrozen&&token.amount>=amount;})?.pubkey;}
export function txPlan(built,extraSigners=[]){const data=built.builder.AllTxData;return{instructions:[...data.instructions,...data.endInstructions].filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId)),signers:[...data.signers,...extraSigners]};}
export function line(mint,expected,limit,direction){return{mint:mint.address,decimals:mint.decimals,expectedRaw:String(expected),limitRaw:String(limit),direction};}
export async function checkVault(ctx,address,mint,authority){const info=await ctx.connection.getAccountInfo(new PublicKey(address),'confirmed');const value=unpackAccount(new PublicKey(address),info,new PublicKey(mint.programId));if(!value.mint.equals(new PublicKey(mint.address))||!value.owner.equals(new PublicKey(authority))||!value.isInitialized||value.isFrozen)throw new Error('Pool vault identity or state is invalid');return value;}
// Amounts arrive bound to the UI's mint addresses, not an assumed token0/1 order.
export function canonicalRequest(request,a,b){
  if(request.mintA==null&&request.mintB==null)return request;
  if(request.mintA===a&&request.mintB===b)return request;
  if(request.mintA===b&&request.mintB===a)return{...request,mintA:a,mintB:b,amountA:request.amountB,amountB:request.amountA};
  throw new Error('Selected mints do not match the pool pair');
}

export async function tokenAccounts(ctx,mints,amounts,wrapSol=false){
 const addresses=[],instructions=[],cleanup=[],signers=[];
 for(let i=0;i<mints.length;i++){
  const key=new PublicKey(mints[i].address),program=new PublicKey(mints[i].programId);
  if(wrapSol&&key.equals(NATIVE_MINT)){
   const [ata]=await resolveOrCreateATAs(ctx.connection,ctx.owner,[{tokenMint:key,wrappedSolAmountIn:new BN(String(amounts[i]??0))}],()=>ctx.connection.getMinimumBalanceForRentExemption(165),ctx.owner,true,false,'keypair');
   addresses.push(ata.address);instructions.push(...ata.instructions);cleanup.unshift(...ata.cleanupInstructions);signers.push(...ata.signers);
  }else{
   const ata=getAssociatedTokenAddressSync(key,ctx.owner,false,program),info=await ctx.connection.getAccountInfo(ata,'confirmed');
   if(info){const value=unpackAccount(ata,info,program);if(!value.mint.equals(key)||!value.owner.equals(ctx.owner)||value.isFrozen||!value.isInitialized)throw new Error('Wallet token account is frozen or invalid');}
   else instructions.push(createAssociatedTokenAccountIdempotentInstruction(ctx.owner,ata,ctx.owner,key,program));
   addresses.push(ata);
  }
 }
 return{addresses,instructions,cleanup,signers};
}

// ---- Concentrated-liquidity range inference (shared by Raydium CLMM and Orca) ----
// Uniswap-v3 style: raw price P = (sqrtPriceX64 / 2^64)^2 in raw-B-per-raw-A, tick = floor(log_1.0001 P).
const Q64=new Decimal(2).pow(64),LN_TICK=Math.log(1.0001),DEFAULT_RANGE_WIDTH_PCT=25;
export const optional=value=>value===null?undefined:value;
// Deposit amounts treated as zero when omitted or '0'; any other value must be a positive atomic integer.
export const zeroable=(value,label)=>value==null||value==='0'?0n:raw(value,label);
export function rangeWidthPct(value){const n=optional(value)??DEFAULT_RANGE_WIDTH_PCT;if(typeof n!=='number'||!Number.isFinite(n)||n<1||n>500)throw new Error('rangeWidthPct must be a number between 1 and 500');return n;}
export function rawPriceFromSqrtPriceX64(sqrtPriceX64){return new Decimal(sqrtPriceX64.toString()).div(Q64).pow(2);}
export const rawPriceAtTick=tick=>new Decimal(1.0001).pow(tick);
export function displayPrice(rawPrice,decimalsA,decimalsB){return new Decimal(rawPrice).mul(Decimal.pow(10,decimalsA-decimalsB)).toSignificantDigits(12).toString();}
export function rangePrices(range,sqrtPriceX64,decimalsA,decimalsB){return{priceLower:displayPrice(rawPriceAtTick(range[0]),decimalsA,decimalsB),priceUpper:displayPrice(rawPriceAtTick(range[1]),decimalsA,decimalsB),priceCurrent:displayPrice(rawPriceFromSqrtPriceX64(sqrtPriceX64),decimalsA,decimalsB)};}
// Solve t in (0,1) so the deposit at P consumes amountA and amountB as fully as possible for the
// range [P·e^(−w·t), P·e^(w·(1−t))]: amountB/amountA = P·(1−e^(−w·t/2))/(1−e^(−w·(1−t)/2)), monotone in t.
export function solveRangeSplit(lnP,w,amountA,amountB){
 const target=Math.log(Number(amountB))-Math.log(Number(amountA));
 const f=t=>lnP+Math.log1p(-Math.exp(-w*t/2))-Math.log1p(-Math.exp(-w*(1-t)/2))-target;
 let lo=1e-9,hi=1-1e-9;
 for(let i=0;i<200&&hi-lo>1e-15;i++){const mid=(lo+hi)/2;if(f(mid)<0)lo=mid;else hi=mid;}
 return (lo+hi)/2;
}
// Returns null when both amounts are zero (callers keep their existing default), otherwise the
// aligned, clamped tick pair. amountA/amountB are raw bigint amounts.
export function inferTickRange({sqrtPriceX64,tickSpacing,minTick,maxTick,amountA,amountB,rangeWidthPct:pct}){
 const spacing=tickSpacing;if(!Number.isInteger(spacing)||spacing<1)throw new Error('Invalid tick spacing');
 if(amountA===0n&&amountB===0n)return null;
 const width=rangeWidthPct(pct),w=Math.log1p(width/100),lnP=rawPriceFromSqrtPriceX64(sqrtPriceX64).ln().toNumber();
 const minAligned=Math.ceil(minTick/spacing)*spacing,maxAligned=Math.floor(maxTick/spacing)*spacing;
 const down=t=>Math.floor(t/spacing)*spacing,up=t=>Math.ceil(t/spacing)*spacing;
 let side,t,lower,upper;
 if(amountB===0n){side='A';t=0;lower=up(Math.ceil(lnP/LN_TICK));upper=up(Math.floor((lnP+w)/LN_TICK));}            // single-sided above price: [P, P·e^w]
 else if(amountA===0n){side='B';t=1;lower=down(Math.floor((lnP-w)/LN_TICK));upper=down(Math.floor(lnP/LN_TICK));}   // single-sided below price: [P·e^(−w), P]
 else{side='both';t=solveRangeSplit(lnP,w,amountA,amountB);lower=down(Math.floor((lnP-w*t)/LN_TICK));upper=up(Math.floor((lnP+w*(1-t))/LN_TICK));}
 lower=Math.min(Math.max(lower,minAligned),maxAligned);upper=Math.min(Math.max(upper,minAligned),maxAligned);
 if(lower>=upper){if(side==='B'||lower+spacing>maxAligned)lower=upper-spacing;else upper=lower+spacing;if(lower<minAligned){lower=minAligned;upper=minAligned+spacing;}}
 if(lower>=upper||lower<minAligned||upper>maxAligned)throw new Error('Could not infer a valid tick range for this pool');
 const cur=lnP/LN_TICK;if(side==='A'&&upper<=cur||side==='B'&&lower>=cur)throw new Error('Price is at the edge of the tick range; a single-sided position cannot be placed there. Provide both ticks explicitly');
 return{tickLowerIndex:lower,tickUpperIndex:upper,rangeWidthPct:width,side,split:t};
}
