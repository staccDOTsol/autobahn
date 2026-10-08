import { createRequire } from 'node:module';
import { BN, key, raw, integer, bps, pair, amount, limit, ephemeral, transactions, assertPool, alignRequest } from './meteora-common.mjs';
import Decimal from 'decimal.js';
const require=createRequire(import.meta.url); const DLMM=require('@meteora-ag/dlmm');
const MIN_BIN=-443636,MAX_BIN=443636,optional=value=>value===null?undefined:value;
const PROGRAM='LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
async function load(ctx,request) {
 const address=await assertPool(ctx,request.pool,PROGRAM),pool=await DLMM.create(ctx.connection,address);
 request=alignRequest(request,pool.lbPair.tokenXMint,pool.lbPair.tokenYMint); const [a,b]=await pair(ctx,pool.lbPair.tokenXMint,pool.lbPair.tokenYMint); return {pool,address,a,b,request};
}
export function assertPoolWithdrawalsActive(pool,clock) {
 const current=pool.activationType===0?clock.slot:clock.unixTimestamp;
 if(current.lte(pool.activationPoint))throw new Error('Withdrawals open after this pool’s activation point; wait for the next confirmed clock update');
}
async function owned(ctx,d,position,removable=false) {
 const {userPositions}=await d.pool.getPositionsByUserAndLbPair(ctx.owner); const p=userPositions.find(p=>p.publicKey.toBase58()===position);
 if(!p || !p.positionData.owner.equals(ctx.owner)) throw new Error('The wallet does not own this DLMM position');
 if(removable) {assertPoolWithdrawalsActive(d.pool.lbPair,d.pool.clock);const info=await ctx.connection.getAccountInfo(p.publicKey,'confirmed');if(!info || !info.owner.equals(d.pool.program.programId))throw new Error('Position account changed');const wrapped=DLMM.wrapPosition(d.pool.program,p.publicKey,info);const current=d.pool.lbPair.activationType===0?d.pool.clock.slot:d.pool.clock.unixTimestamp;if(wrapped.lockReleasePoint().gt(current))throw new Error('This position is still time-locked');}
 return p;
}
// Raw bin price (raw Y per raw X): (1 + binStep/10000)^binId, the same formula as DLMM.getPriceOfBinByBinId.
export const binPrice=(binId,binStep)=>new Decimal(1).add(new Decimal(binStep).div(10000)).pow(binId);
export const binDisplayPrice=(binId,binStep,decimalsX,decimalsY)=>binPrice(binId,binStep).mul(Decimal.pow(10,decimalsX-decimalsY)).toSignificantDigits(12).toString();
// Infer a bin span of binCount bins around the active bin from the deposit amounts (BN). Token X lives at
// and above the active bin, token Y at and below it; the span is split by value share at the active-bin price.
export function inferBinRange({activeId,binStep,amountX,amountY,binCount}) {
 if(amountX.isZero() && amountY.isZero())throw new Error('At least one deposit amount must be positive');
 const valueX=new Decimal(amountX.toString()).mul(binPrice(activeId,binStep)),valueY=new Decimal(amountY.toString());
 let binsAbove=Math.round(new Decimal(binCount).mul(valueX).div(valueX.add(valueY)).toNumber()),binsBelow=binCount-binsAbove;
 if(amountY.isZero()){binsAbove=binCount;binsBelow=0;}
 else if(amountX.isZero()){binsAbove=0;binsBelow=binCount;}
 else if(binsAbove===0){binsAbove=1;binsBelow=binCount-1;}
 const minBinId=activeId-binsBelow,maxBinId=binsAbove===0?activeId:binsBelow===0?activeId+binsAbove:activeId+binsAbove-1;
 return {minBinId,maxBinId,binsAbove,binsBelow};
}
export function strategy(request,d,p) {
 const params=request.parameters??{},lower=optional(params.minBinId),upper=optional(params.maxBinId);
 let minBinId,maxBinId,inferredRange=false,binCount=null;
 if(p) {
  // Existing position: keeps its stored range unless narrowed explicitly.
  minBinId=integer(lower,'minBinId',MIN_BIN,MAX_BIN,p.positionData.lowerBinId);
  maxBinId=integer(upper,'maxBinId',minBinId,MAX_BIN,p.positionData.upperBinId);
 } else if(lower===undefined && upper===undefined) {
  binCount=integer(optional(params.binCount),'binCount',2,69,40);
  const inferred=inferBinRange({activeId:d.pool.lbPair.activeId,binStep:d.pool.lbPair.binStep,amountX:raw(request.amountA??'0','amountA',{zero:true}),amountY:raw(request.amountB??'0','amountB',{zero:true}),binCount});
  minBinId=integer(inferred.minBinId,'minBinId',MIN_BIN,MAX_BIN);maxBinId=integer(inferred.maxBinId,'maxBinId',minBinId,MAX_BIN);inferredRange=true;
 } else {
  if(lower===undefined || upper===undefined)throw new Error('Provide both bin IDs or neither');
  minBinId=integer(lower,'minBinId',MIN_BIN,MAX_BIN);maxBinId=integer(upper,'maxBinId',minBinId,MAX_BIN);
 }
 if(maxBinId-minBinId>=70) throw new Error('This add builder accepts up to 70 bins per position; use separate positions for a wider range');
 if(p && (minBinId<p.positionData.lowerBinId || maxBinId>p.positionData.upperBinId)) throw new Error('Deposit range exceeds the existing position');
 return {minBinId,maxBinId,strategyType:integer(optional(params.strategyType),'strategyType',0,2,0),inferredRange,binCount};
}
async function init(ctx,request) {
 const [a,b]=await pair(ctx,request.mintA,request.mintB); const binStep=integer(request.parameters?.binStep,'binStep',1,400,25),feeBps=integer(request.parameters?.feeBps,'feeBps',1,1000,30);
 const price=request.parameters?.initialPrice; if(typeof price!=='string' || !/^\d+(\.\d+)?$/.test(price) || !(Number(price)>0) || !Number.isFinite(Number(price))) throw new Error('initialPrice must be a positive token B per token A decimal');
 const activeId=DLMM.getBinIdFromPrice(DLMM.getPricePerLamport(a.decimals,b.decimals,price),binStep,false);
 const [address]=DLMM.deriveCustomizablePermissionlessLbPair(a.address,b.address,key(PROGRAM));
 if(await ctx.connection.getAccountInfo(address,'confirmed')) throw new Error('A customizable DLMM pool already exists for this pair');
 return {a,b,binStep,feeBps,activeId,address};
}
// SDK treats zero slippage as a default. Re-encode the actual instruction to preserve an exact zero-bin limit.
export function enforceZeroBinSlippage(pool,txs,slip) {
 if(slip!==0)return;
 for(const tx of Array.isArray(txs)?txs:[txs])for(const ix of tx.instructions) {
  if(!ix.programId.equals(pool.program.programId)) continue;
  const decoded=pool.program.coder.instruction.decode(ix.data); if(!decoded || !decoded.name.startsWith('addLiquidity'))continue;
  const value=Object.values(decoded.data).find(v=>v && typeof v==='object' && 'maxActiveBinSlippage' in v);
  if(!value) throw new Error('DLMM liquidity instruction is missing its active-bin bound');
  value.maxActiveBinSlippage=0;ix.data=pool.program.coder.instruction.encode(decoded.name,decoded.data);
 }
}
export function preserveQuotedBinWindow(pool,txs,quote) {
 const activeId=integer(quote.details.activeId,'quoted active bin',-443636,443636);
 const slippageBps=integer(quote.details.slippageBps,'quoted slippage',0,1000);
 // Round down: rounding a fraction of a bin up would exceed the user's price tolerance.
 const binStep=pool.lbPair.binStep;
 const maxActiveBinSlippage=slippageBps===0?0:Math.floor(Math.log1p(slippageBps/10000)/Math.log1p(binStep/10000));
 if(Math.abs(pool.lbPair.activeId-activeId)>maxActiveBinSlippage)throw new Error('The active bin moved outside the approved range; request a new quote');
 for(const tx of Array.isArray(txs)?txs:[txs])for(const ix of tx.instructions) {
  if(!ix.programId.equals(pool.program.programId))continue;
  const decoded=pool.program.coder.instruction.decode(ix.data);if(!decoded?.name.startsWith('addLiquidity'))continue;
  const value=Object.values(decoded.data).find(v=>v&&typeof v==='object'&&'maxActiveBinSlippage' in v);
  if(!value||!('activeId' in value))throw new Error('DLMM liquidity instruction is missing its active-bin bound');
  value.activeId=activeId;value.maxActiveBinSlippage=maxActiveBinSlippage;
  ix.data=pool.program.coder.instruction.encode(decoded.name,decoded.data);
 }
}
export function withdrawalAmounts(position,bpsToRemove,minBinId,maxBinId) {
 let a=new BN(0),b=new BN(0);
 for(const bin of position.positionBinData) {
  if(bin.binId<minBinId || bin.binId>maxBinId)continue;
  const total=new BN(bin.binLiquidity); if(total.isZero())continue;
  const remove=new BN(bin.positionLiquidity).muln(bpsToRemove).divn(10000);
  a=a.add(remove.mul(new BN(bin.binXAmount)).div(total)); b=b.add(remove.mul(new BN(bin.binYAmount)).div(total));
 }
 return {a,b};
}
export const adapter={
 id:'meteora-dlmm',programIds:[PROGRAM],capabilities:['initialize','add','remove'],
 parameters:{initialize:[{name:'binStep',label:'Bin step',type:'integer',default:25,min:1,max:400},{name:'feeBps',label:'Trading fee (bps)',type:'integer',default:30,min:1,max:1000},{name:'initialPrice',label:'Initial price (B per A)',type:'decimal',required:true}],add:[{name:'minBinId',label:'Lower bin ID (advanced; inferred from amounts when blank)',type:'integer'},{name:'maxBinId',label:'Upper bin ID (advanced; inferred from amounts when blank)',type:'integer'},{name:'binCount',label:'Number of bins around the active bin',type:'integer',default:40,min:2,max:69},{name:'strategyType',label:'Strategy: 0 spot, 1 curve, 2 bid-ask',type:'integer',default:0,min:0,max:2}],remove:[{name:'removeBps',label:'Withdraw percentage (bps)',type:'integer',default:10000,min:1,max:10000}]},
 async positions(ctx,request) {
  let entries;
  if(request.pool){const d=await load(ctx,request);entries=[[request.pool,{lbPair:d.pool.lbPair,lbPairPositionsData:(await d.pool.getPositionsByUserAndLbPair(ctx.owner)).userPositions}]];}
  else entries=[...(await DLMM.getAllLbPairPositionsByUser(ctx.connection,ctx.owner)).entries()];
  return entries.flatMap(([pool,entry])=>entry.lbPairPositionsData.map(p=>({id:p.publicKey.toBase58(),position:p.publicKey.toBase58(),pool,owner:ctx.owner.toBase58(),mintA:entry.lbPair.tokenXMint.toBase58(),mintB:entry.lbPair.tokenYMint.toBase58(),liquidity:p.positionData.positionBinData.reduce((s,b)=>s.add(new BN(b.positionLiquidity)),new BN(0)).toString(),minBinId:p.positionData.lowerBinId,maxBinId:p.positionData.upperBinId,kind:'bin-position',removalMode:'percentage'})));
 },
 async quote(ctx,request) {
  if(request.operation==='initialize') {const d=await init(ctx,request);return {pool:d.address.toBase58(),slot:await ctx.connection.getSlot('confirmed'),amounts:[],details:{noTokenMovement:true,binStep:d.binStep,feeBps:d.feeBps,activeId:d.activeId},warnings:['Initialization creates an empty pool. Add liquidity after it confirms; initialization charges account rent and network fees. Your wallet must already hold at least one atomic unit of token A as launch ownership proof.']};}
  const d=await load(ctx,request); request=d.request;
  if(request.operation==='add') {
   const p=request.position?await owned(ctx,d,request.position):null,a=raw(request.amountA??'0','amountA',{zero:true}),b=raw(request.amountB??'0','amountB',{zero:true}),range=strategy(request,d,p);
   if(a.isZero() && b.isZero())throw new Error('At least one deposit amount must be positive');
   const pos=request.position??ephemeral(ctx,'meteora-dlmm-position').publicKey.toBase58();
   return {pool:request.pool,position:pos,slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(d.a,a,a,'debit'),amount(d.b,b,b,'debit')],details:{...range,priceLower:binDisplayPrice(range.minBinId,d.pool.lbPair.binStep,d.a.decimals,d.b.decimals),priceUpper:binDisplayPrice(range.maxBinId,d.pool.lbPair.binStep,d.a.decimals,d.b.decimals),priceCurrent:binDisplayPrice(d.pool.lbPair.activeId,d.pool.lbPair.binStep,d.a.decimals,d.b.decimals),activeId:d.pool.lbPair.activeId,slippageBps:bps(request)},warnings:['Deposit amounts are maximums. DLMM protects the active-bin range; resulting per-bin liquidity depends on execution state.']};
  }
  if(request.operation!=='remove')throw new Error('Unsupported liquidity operation');
  const p=await owned(ctx,d,request.position,true),removeBps=integer(request.parameters?.removeBps,'removeBps',1,10000,10000),minBinId=p.positionData.lowerBinId,maxBinId=p.positionData.upperBinId;
  if(!p.positionData.positionBinData.some(bin=>new BN(bin.positionLiquidity).gtn(0)))throw new Error('This position has no liquidity to withdraw');
  const values=withdrawalAmounts(p.positionData,removeBps,minBinId,maxBinId),epoch=(await ctx.connection.getEpochInfo('confirmed')).epoch;
  const a=DLMM.calculateTransferFeeExcludedAmount(values.a,d.a.state,epoch).amount,b=DLMM.calculateTransferFeeExcludedAmount(values.b,d.b.state,epoch).amount;
  return {pool:request.pool,position:request.position,slot:await ctx.connection.getSlot('confirmed'),amounts:[amount(d.a,a,new BN(0),'credit'),amount(d.b,b,new BN(0),'credit')],details:{removeBps,minBinId,maxBinId,nativeMinimumOutput:false},warnings:['DLMM withdrawals do not have an on-chain minimum-token-output parameter. Estimates can change before execution. Fees and rewards remain separately claimable.']};
 },
 async build(ctx,request,quote) {
  if(request.operation==='initialize') {const d=await init(ctx,request); const tx=await DLMM.createCustomizablePermissionlessLbPair2(ctx.connection,new BN(d.binStep),d.a.address,d.b.address,new BN(d.activeId),new BN(d.feeBps),1,false,ctx.owner,undefined,false,1,0);return {pool:d.address.toBase58(),transactions:transactions(tx)};}
  const d=await load(ctx,request); request=d.request;let txs,signers=[];
  if(request.operation==='add') {
   const p=request.position?await owned(ctx,d,request.position):null;
   const {minBinId,maxBinId,strategyType}=strategy({...request,parameters:{...request.parameters,minBinId:quote.details.minBinId,maxBinId:quote.details.maxBinId,strategyType:quote.details.strategyType}},d,p),range={minBinId,maxBinId,strategyType};
   const nft=p?null:ephemeral(ctx,'meteora-dlmm-position');if(nft)signers=[nft];
   const args={positionPubKey:p?.publicKey??nft.publicKey,totalXAmount:limit(quote,d.a,'debit'),totalYAmount:limit(quote,d.b,'debit'),strategy:range,user:ctx.owner,slippage:bps(request)/100};
   txs=p?await d.pool.addLiquidityByStrategy(args):await d.pool.initializePositionAndAddLiquidityByStrategy(args);preserveQuotedBinWindow(d.pool,txs,quote);
  } else {const p=await owned(ctx,d,request.position,true);txs=await d.pool.removeLiquidity({user:ctx.owner,position:p.publicKey,fromBinId:quote.details.minBinId,toBinId:quote.details.maxBinId,bps:new BN(quote.details.removeBps),shouldClaimAndClose:false});}
  return {pool:quote.pool,position:quote.position,transactions:transactions(txs,signers)};
 }
};
export default adapter;
