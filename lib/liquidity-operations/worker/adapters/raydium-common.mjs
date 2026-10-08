import { createHash } from 'node:crypto';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount, getTransferFeeConfig, getEpochFee, getTransferHook, getDefaultAccountState, getPausableConfig, AccountState, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import BN from 'bn.js';
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
