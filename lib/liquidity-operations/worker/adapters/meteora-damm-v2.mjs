import { createRequire } from 'node:module';
import { BN, raw, integer, bps, pair, amount, limit, minimum, maximum, ephemeral, transactions, assertPool, alignRequest } from './meteora-common.mjs';
const require=createRequire(import.meta.url); const sdk=require('@meteora-ag/cp-amm-sdk');
const PROGRAM='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
async function load(ctx,request) {
 const address=await assertPool(ctx,request.pool,PROGRAM); const client=new sdk.CpAmm(ctx.connection); const pool=await client.fetchPoolState(address);
 request=alignRequest(request,pool.tokenAMint,pool.tokenBMint); const [a,b]=await pair(ctx,pool.tokenAMint,pool.tokenBMint); const epoch=(await ctx.connection.getEpochInfo('confirmed')).epoch;
 return {client,address,pool,a,b,request,tokenAInfo:{mint:a.state,currentEpoch:epoch},tokenBInfo:{mint:b.state,currentEpoch:epoch}};
}
async function position(ctx,d,address) {
 const all=await d.client.getUserPositionByPool(d.address,ctx.owner); const found=all.find(x=>x.position.toBase58()===address);
 if(!found) throw new Error('The wallet does not own this position in this pool');
 const vestings=(await d.client.getAllVestingsByPosition(found.position)).map(v=>({account:v.publicKey,vestingState:v.account}));
 const currentPoint=await sdk.getCurrentPoint(ctx.connection,d.pool.activationType);
 const available=vestings.reduce((sum,v)=>sum.add(sdk.getAvailableVestingLiquidity(v.vestingState,currentPoint)),found.positionState.unlockedLiquidity.clone());
 return {...found,vestings,currentPoint,available};
}
function math(d) {return {minSqrtPrice:d.pool.sqrtMinPrice,maxSqrtPrice:d.pool.sqrtMaxPrice,sqrtPrice:d.pool.sqrtPrice,collectFeeMode:d.pool.collectFeeMode,tokenAAmount:d.pool.tokenAAmount,tokenBAmount:d.pool.tokenBAmount,liquidity:d.pool.liquidity};}
async function init(ctx,request) {
 const client=new sdk.CpAmm(ctx.connection), [a,b]=await pair(ctx,request.mintA,request.mintB), amountA=raw(request.amountA,'amountA'),amountB=raw(request.amountB,'amountB');
 const address=sdk.deriveCustomizablePoolAddress(a.address,b.address); if(await ctx.connection.getAccountInfo(address,'confirmed')) throw new Error('A customizable DAMM v2 pool already exists for this pair');
 const epoch=(await ctx.connection.getEpochInfo('confirmed')).epoch; const prepared=client.preparePoolCreationParams({tokenAAmount:amountA,tokenBAmount:amountB,minSqrtPrice:sdk.MIN_SQRT_PRICE,maxSqrtPrice:sdk.MAX_SQRT_PRICE,tokenAInfo:{mint:a.state,currentEpoch:epoch},tokenBInfo:{mint:b.state,currentEpoch:epoch},collectFeeMode:0});
 const nft=ephemeral(ctx,'meteora-damm-v2-position');
 return {client,a,b,amountA,amountB,address,prepared,nft,feeBps:integer(request.parameters?.feeBps,'feeBps',1,1000,30)};
}
export const adapter={
 id:'meteora-damm-v2',programIds:[PROGRAM],capabilities:['initialize','add','remove'],parameters:{initialize:[{name:'feeBps',label:'Trading fee (bps)',type:'integer',default:30,min:1,max:1000}],add:[],remove:[]},
 async positions(ctx,request) {
  const client=new sdk.CpAmm(ctx.connection); const entries=request.pool?await client.getUserPositionByPool(await assertPool(ctx,request.pool,PROGRAM),ctx.owner):await client.getPositionsByUser(ctx.owner);
  const pools=[...new Map(entries.map(p=>[p.positionState.pool.toBase58(),p.positionState.pool])).values()],states=new Map();
  for(let start=0;start<pools.length;start+=100){const batch=pools.slice(start,start+100),data=await client._program.account.pool.fetchMultiple(batch);batch.forEach((address,i)=>{if(data[i])states.set(address.toBase58(),data[i]);});}
  return entries.map(p=>{const state=states.get(p.positionState.pool.toBase58());if(!state)throw new Error('Position pool was not found');return {id:p.position.toBase58(),position:p.position.toBase58(),pool:p.positionState.pool.toBase58(),owner:ctx.owner.toBase58(),mintA:state.tokenAMint.toBase58(),mintB:state.tokenBMint.toBase58(),liquidity:p.positionState.unlockedLiquidity.toString(),lockedLiquidity:p.positionState.permanentLockedLiquidity.toString(),vestingLiquidity:p.positionState.vestedLiquidity.toString(),kind:'nft-position'};});
 },
 async quote(ctx,request) {
  if(request.operation==='initialize') {const d=await init(ctx,request);return {pool:d.address.toBase58(),position:sdk.derivePositionAddress(d.nft.publicKey).toBase58(),slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(d.a,d.amountA,d.amountA,'debit'),amount(d.b,d.amountB,d.amountB,'debit')],details:{liquidity:d.prepared.liquidityDelta.toString(),initSqrtPrice:d.prepared.initSqrtPrice.toString(),feeBps:d.feeBps},warnings:['Creates an unlocked full-range position. Account rent and network fees are additional.']};}
  const d=await load(ctx,request); request=d.request; const slip=bps(request);
  if(request.operation==='add') {
   if(request.position) await position(ctx,d,request.position);
   const isA=request.amountA!==undefined; const input=raw(isA?request.amountA:request.amountB,'deposit amount'); const q=d.client.getDepositQuote({...math(d),inAmount:input,isTokenA:isA,inputTokenInfo:isA?d.tokenAInfo:d.tokenBInfo,outputTokenInfo:isA?d.tokenBInfo:d.tokenAInfo}); const expectedA=isA?q.actualInputAmount:q.outputAmount,expectedB=isA?q.outputAmount:q.actualInputAmount;
   if(q.liquidityDelta.isZero()) throw new Error('Deposit is too small'); const maxA=maximum(expectedA,slip),maxB=maximum(expectedB,slip);
   if(isA && request.amountB && maxB.gt(raw(request.amountB,'amountB'))) throw new Error('amountB is below the required token B maximum');
   const pos=request.position??sdk.derivePositionAddress(ephemeral(ctx,'meteora-damm-v2-position').publicKey).toBase58();
   return {pool:request.pool,position:pos,slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(d.a,expectedA,maxA,'debit'),amount(d.b,expectedB,maxB,'debit')],details:{liquidity:q.liquidityDelta.toString()}};
  }
  if(request.operation!=='remove') throw new Error('Unsupported liquidity operation');
  const pos=await position(ctx,d,request.position), input=raw(request.liquidity,'liquidity',{bits:128}); if(input.gt(pos.available)) throw new Error('Requested liquidity exceeds the unlocked and vested amount');
  const q=d.client.getWithdrawQuote({...math(d),liquidityDelta:input,tokenATokenInfo:d.tokenAInfo,tokenBTokenInfo:d.tokenBInfo});
  return {pool:request.pool,position:request.position,slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(d.a,q.outAmountA,minimum(q.outAmountA,slip),'credit'),amount(d.b,q.outAmountB,minimum(q.outAmountB,slip),'credit')],details:{liquidity:input.toString()}};
 },
 async build(ctx,request,quote) {
  if(request.operation==='initialize') {
   const d=await init(ctx,request); const result=await d.client.createCustomPool({payer:ctx.owner,creator:ctx.owner,positionNft:d.nft.publicKey,tokenAMint:d.a.address,tokenBMint:d.b.address,tokenAAmount:limit(quote,d.a,'debit'),tokenBAmount:limit(quote,d.b,'debit'),sqrtMinPrice:sdk.MIN_SQRT_PRICE,sqrtMaxPrice:sdk.MAX_SQRT_PRICE,liquidityDelta:raw(quote.details.liquidity,'liquidity',{bits:128}),initSqrtPrice:raw(quote.details.initSqrtPrice,'initSqrtPrice',{bits:128}),poolFees:{baseFee:sdk.getBaseFeeParams({baseFeeMode:0,feeTimeSchedulerParam:{startingFeeBps:d.feeBps,endingFeeBps:d.feeBps,numberOfPeriod:0,totalDuration:0}}),compoundingFeeBps:0,padding:0,dynamicFee:null},hasAlphaVault:false,activationType:1,collectFeeMode:0,activationPoint:null,tokenAProgram:d.a.program,tokenBProgram:d.b.program,isLockLiquidity:false});
   if(result.pool.toBase58()!==quote.pool || result.position.toBase58()!==quote.position) throw new Error('Pool or position identity changed');
   return {pool:quote.pool,position:quote.position,transactions:transactions(result.tx,[d.nft])};
  }
  const d=await load(ctx,request), liquidityDelta=raw(quote.details.liquidity,'liquidity',{bits:128});
  const params={owner:ctx.owner,pool:d.address,tokenAMint:d.a.address,tokenBMint:d.b.address,tokenAVault:d.pool.tokenAVault,tokenBVault:d.pool.tokenBVault,tokenAProgram:d.a.program,tokenBProgram:d.b.program,liquidityDelta};
  let tx,signers=[];
  if(request.operation==='add') {
   Object.assign(params,{maxAmountTokenA:limit(quote,d.a,'debit'),maxAmountTokenB:limit(quote,d.b,'debit'),tokenAAmountThreshold:limit(quote,d.a,'debit'),tokenBAmountThreshold:limit(quote,d.b,'debit')});
   if(request.position) {const p=await position(ctx,d,request.position);tx=await d.client.addLiquidity({...params,position:p.position,positionNftAccount:p.positionNftAccount});}
   else {const nft=ephemeral(ctx,'meteora-damm-v2-position');signers=[nft];tx=await d.client.createPositionAndAddLiquidity({...params,positionNft:nft.publicKey});}
  } else {const p=await position(ctx,d,request.position);if(liquidityDelta.gt(p.available))throw new Error('Position liquidity changed');tx=await d.client.removeLiquidity({...params,position:p.position,positionNftAccount:p.positionNftAccount,tokenAAmountThreshold:limit(quote,d.a,'credit'),tokenBAmountThreshold:limit(quote,d.b,'credit'),vestings:p.vestings,currentPoint:p.currentPoint});}
  return {pool:quote.pool,position:quote.position,transactions:transactions(tx,signers)};
 }
};
export default adapter;
