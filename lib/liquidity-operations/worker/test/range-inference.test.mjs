import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Percentage } from '@orca-so/common-sdk';
import { NO_TOKEN_EXTENSION_CONTEXT, PriceMath, TickUtil as OrcaTickUtil } from '@orca-so/whirlpools-sdk';
import { TickUtil } from '@raydium-io/raydium-sdk-v2';
import { inferTickRange, rangePrices, rangeWidthPct } from '../adapters/raydium-common.mjs';
import { clmmAmounts, clmmPositionRange, raydiumClmm } from '../adapters/raydium-clmm.mjs';
import { orcaPositionRange, fitOrcaLiquidity, orca } from '../adapters/orca.mjs';
import { inferBinRange, binPrice, strategy, adapter as dlmm } from '../adapters/meteora-dlmm.mjs';
import { BN } from '../adapters/meteora-common.mjs';
const DLMM=createRequire(import.meta.url)('@meteora-ag/dlmm');
const MIN=-443636,MAX=443636,sqrt=tick=>TickUtil.getSqrtPriceAtTick(tick);
const infer=(tick,amountA,amountB,tickSpacing=1,extra={})=>inferTickRange({sqrtPriceX64:sqrt(tick),tickSpacing,minTick:MIN,maxTick:MAX,amountA,amountB,rangeWidthPct:25,...extra});
// Deposit ratio B/A the SDK math produces for an arbitrary liquidity at the inferred range.
const ratio=(tick,r)=>{const v=clmmAmounts({sqrtPriceX64:sqrt(tick)},[{},{}],[r.tickLowerIndex,r.tickUpperIndex],10n**15n,0,true);return [v[0].expected,v[1].expected];};
const near=(x,y,rel)=>Math.abs(Number(x)-Number(y))<=rel*Math.max(Math.abs(Number(x)),Math.abs(Number(y)));

test('symmetric amounts infer a range straddling the current price that consumes both tokens',()=>{
 for(const tick of [0,10000,-25000]){
  const r=infer(tick,10n**9n,10n**9n*BigInt(Math.round(1.0001**tick*1e6))/10n**6n);
  assert.ok(r.tickLowerIndex<tick&&tick<r.tickUpperIndex,`straddles ${tick}`);
  assert.equal(r.side,'both');assert.equal(r.rangeWidthPct,25);
  const [a,b]=ratio(tick,r);
  assert.ok(near(b,Number(a)*1.0001**tick,0.005),`B/A ratio tracks the entered ratio at tick ${tick}`);
 }
 const skewed=infer(0,10n**9n,4n*10n**9n);const [a,b]=ratio(0,skewed);
 assert.ok(near(Number(b)/Number(a),4,0.005));
 assert.ok(skewed.split>0.5&&skewed.tickUpperIndex-0<0-skewed.tickLowerIndex,'more B means the range extends further below the price');
 // Total log-price width is ln(1.25) regardless of how it is split.
 assert.ok(near(skewed.tickUpperIndex-skewed.tickLowerIndex,Math.log(1.25)/Math.log(1.0001),0.002));
});
test('single-sided amounts infer single-sided ranges that require none of the missing token',()=>{
 const above=infer(0,10n**9n,0n,64),below=infer(0,0n,10n**9n,64);
 assert.equal(above.side,'A');assert.ok(above.tickLowerIndex>=0);assert.deepEqual(ratio(0,above)[1],0n);assert.ok(ratio(0,above)[0]>0n);
 assert.equal(below.side,'B');assert.ok(below.tickUpperIndex<=0);assert.deepEqual(ratio(0,below)[0],0n);assert.ok(ratio(0,below)[1]>0n);
 assert.ok(near(above.tickUpperIndex,Math.log(1.25)/Math.log(1.0001),0.03));
 assert.ok(near(-below.tickLowerIndex,Math.log(1.25)/Math.log(1.0001),0.03));
 assert.equal(infer(0,0n,0n),null,'no amounts leaves the caller default in place');
});
test('inferred ticks align lower down and upper up to the pool tick spacing, and honour the width',()=>{
 const fine=infer(777,10n**9n,10n**9n,1),coarse=infer(777,10n**9n,10n**9n,64);
 assert.equal(Math.abs(coarse.tickLowerIndex%64),0);assert.equal(Math.abs(coarse.tickUpperIndex%64),0);
 assert.ok(coarse.tickLowerIndex<=fine.tickLowerIndex&&coarse.tickUpperIndex>=fine.tickUpperIndex);
 assert.ok(coarse.tickLowerIndex>fine.tickLowerIndex-64&&coarse.tickUpperIndex<fine.tickUpperIndex+64);
 const wide=infer(0,10n**9n,10n**9n,1,{rangeWidthPct:100});
 assert.ok(near(wide.tickUpperIndex-wide.tickLowerIndex,Math.log(2)/Math.log(1.0001),0.002));
 assert.equal(rangeWidthPct(undefined),25);assert.equal(rangeWidthPct(null),25);
 for(const bad of [0,0.5,501,'25',NaN])assert.throws(()=>rangeWidthPct(bad),/rangeWidthPct/);
});
test('inferred ticks clamp to protocol bounds and never reverse',()=>{
 const top=infer(443000,10n**9n,10n**9n,60),bottom=infer(-443000,10n**9n,10n**9n,60);
 assert.equal(top.tickUpperIndex,Math.floor(MAX/60)*60);assert.ok(top.tickLowerIndex<top.tickUpperIndex);
 assert.equal(bottom.tickLowerIndex,Math.ceil(MIN/60)*60);assert.ok(bottom.tickLowerIndex<bottom.tickUpperIndex);
 // A 1% width is narrower than one 128-tick spacing; the range widens to exactly one spacing.
 const narrow=infer(0,10n**9n,0n,128,{rangeWidthPct:1});assert.deepEqual([narrow.tickLowerIndex,narrow.tickUpperIndex],[0,128]);
 // At the very edge a single-sided position cannot be placed on the correct side; refuse rather than flip it.
 assert.throws(()=>infer(443600,10n**9n,0n,60),/edge of the tick range/);
 assert.throws(()=>infer(-443600,0n,10n**9n,60),/edge of the tick range/);
});
test('CLMM and Orca add quotes require both ticks or neither, and keep explicit ticks exactly',()=>{
 const pool={sqrtPriceX64:sqrt(0),tickSpacing:64},data={sqrtPrice:PriceMath.tickIndexToSqrtPriceX64(0),tickCurrentIndex:0,tickSpacing:64};
 for(const parameters of [{tickLowerIndex:-64},{tickUpperIndex:64},{tickLowerIndex:null,tickUpperIndex:64}]){
  assert.throws(()=>clmmPositionRange(pool,{amountA:'1000',amountB:'1000',parameters}),/Provide both ticks or neither/);
  assert.throws(()=>orcaPositionRange(data,{amountA:'1000',amountB:'1000',parameters}),/Provide both ticks or neither/);
 }
 assert.deepEqual(clmmPositionRange(pool,{amountA:'1000',amountB:'1000',parameters:{tickLowerIndex:-128,tickUpperIndex:64}}),{range:[-128,64],inferredRange:false,rangeWidthPct:null});
 assert.deepEqual(orcaPositionRange(data,{amountA:'1000',amountB:'1000',parameters:{tickLowerIndex:-128,tickUpperIndex:64}}),{range:[-128,64],inferredRange:false,rangeWidthPct:null});
 // No ticks and no amounts (exact-liquidity deposits) keep today's full-range default.
 assert.deepEqual(clmmPositionRange(pool,{liquidity:'5',parameters:{}}),{range:[-443584,443584],inferredRange:false,rangeWidthPct:null});
 assert.deepEqual(orcaPositionRange(data,{liquidity:'5',parameters:{}}),{range:OrcaTickUtil.getFullRangeTickIndex(64),inferredRange:false,rangeWidthPct:null});
 const inferred=clmmPositionRange(pool,{amountA:'1000',amountB:'1000',parameters:{tickLowerIndex:null,tickUpperIndex:null,rangeWidthPct:null}});
 assert.equal(inferred.inferredRange,true);assert.equal(inferred.rangeWidthPct,25);assert.ok(inferred.range[0]<0&&0<inferred.range[1]);
 assert.throws(()=>clmmPositionRange(pool,{amountA:'1000',amountB:'1000',parameters:{rangeWidthPct:999}}),/rangeWidthPct/);
});
test('Orca inferred range respects full-range-only pools and lets the budget fit consume both tokens',()=>{
 const fullOnly={sqrtPrice:PriceMath.tickIndexToSqrtPriceX64(0),tickCurrentIndex:0,tickSpacing:32896};
 assert.ok(OrcaTickUtil.isFullRangeOnly(fullOnly.tickSpacing));
 assert.deepEqual(orcaPositionRange(fullOnly,{amountA:'1000',amountB:'1000',parameters:{}}),{range:OrcaTickUtil.getFullRangeTickIndex(32896),inferredRange:false,rangeWidthPct:null});
 const data={sqrtPrice:PriceMath.tickIndexToSqrtPriceX64(1234),tickCurrentIndex:1234,tickSpacing:64};
 const request={amountA:'10000000',amountB:'5000000'},chosen=orcaPositionRange(data,request);
 assert.equal(chosen.inferredRange,true);assert.ok(chosen.range.every(t=>OrcaTickUtil.isTickInitializable(t,64)));
 const quote=fitOrcaLiquidity({...data,tickLowerIndex:chosen.range[0],tickUpperIndex:chosen.range[1],tokenExtensionCtx:NO_TOKEN_EXTENSION_CONTEXT,slippageTolerance:Percentage.fromFraction(50,10000)},request);
 assert.ok(BigInt(quote.tokenMaxA.toString())<=10000000n&&BigInt(quote.tokenMaxB.toString())<=5000000n);
 assert.ok(BigInt(quote.tokenEstA.toString())>=8500000n&&BigInt(quote.tokenEstB.toString())>=4250000n,'both budgets are mostly consumed');
 const single=orcaPositionRange(data,{amountA:'10000000'});const q=fitOrcaLiquidity({...data,tickLowerIndex:single.range[0],tickUpperIndex:single.range[1],tokenExtensionCtx:NO_TOKEN_EXTENSION_CONTEXT,slippageTolerance:Percentage.fromFraction(50,10000)},{amountA:'10000000'});
 assert.equal(q.tokenEstB.toString(),'0');assert.equal(q.tokenEstA.toString(),'10000000');
});
test('range prices are decimal-adjusted token B per token A',()=>{
 const prices=rangePrices([-64,64],sqrt(0),9,6);
 assert.equal(prices.priceCurrent,'1000');
 // Orca derives tick prices through Q64 sqrt prices; agree to 11 significant digits (string tie-rounding aside).
 assert.ok(near(prices.priceLower,PriceMath.tickIndexToPrice(-64,9,6).toString(),1e-11));
 assert.ok(near(prices.priceUpper,PriceMath.tickIndexToPrice(64,9,6).toString(),1e-11));
 assert.match(prices.priceLower,/^993\.62075431[67]$/);assert.match(prices.priceUpper,/^1006\.4202017[0-9]$/);
});
test('parameter schemas expose the advanced tick/bin fields and the new width controls',()=>{
 const names=p=>Object.fromEntries(p.map(x=>[x.name,x]));
 for(const venue of [raydiumClmm,orca]){
  const add=names(venue.parameters.add);
  assert.equal(add.tickLowerIndex.label,'Lower tick (advanced; inferred from amounts when blank)');
  assert.equal(add.tickUpperIndex.label,'Upper tick (advanced; inferred from amounts when blank)');
  assert.deepEqual({label:add.rangeWidthPct.label,type:add.rangeWidthPct.type,default:add.rangeWidthPct.default},{label:'Range width around current price (%)',type:'number',default:25});
 }
 const add=names(dlmm.parameters.add);
 assert.match(add.minBinId.label,/advanced; inferred from amounts when blank/);assert.match(add.maxBinId.label,/advanced; inferred from amounts when blank/);
 assert.deepEqual({type:add.binCount.type,default:add.binCount.default,min:add.binCount.min,max:add.binCount.max},{type:'integer',default:40,min:2,max:69});
 assert.equal(add.strategyType.default,0);
});

const ACTIVE=-12317,STEP=10,P=binPrice(ACTIVE,STEP);
const yFor=(x,mult=1)=>P.mul(x).mul(mult).toFixed(0);
test('DLMM bin price matches the SDK and the split follows value share around the active bin',()=>{
 assert.ok(P.minus(DLMM.getPriceOfBinByBinId(ACTIVE,STEP).toString()).abs().div(P).lt(1e-18));
 const even=inferBinRange({activeId:ACTIVE,binStep:STEP,amountX:new BN('1000000000'),amountY:new BN(yFor(1e9)),binCount:40});
 assert.deepEqual(even,{minBinId:ACTIVE-20,maxBinId:ACTIVE+19,binsAbove:20,binsBelow:20});
 const yHeavy=inferBinRange({activeId:ACTIVE,binStep:STEP,amountX:new BN('1000000000'),amountY:new BN(yFor(1e9,3)),binCount:40});
 assert.deepEqual(yHeavy,{minBinId:ACTIVE-30,maxBinId:ACTIVE+9,binsAbove:10,binsBelow:30});
 const tinyX=inferBinRange({activeId:ACTIVE,binStep:STEP,amountX:new BN('1'),amountY:new BN('1000000000000'),binCount:40});
 assert.deepEqual(tinyX,{minBinId:ACTIVE-39,maxBinId:ACTIVE,binsAbove:1,binsBelow:39},'a non-zero X deposit always keeps the active bin');
 assert.deepEqual(inferBinRange({activeId:ACTIVE,binStep:STEP,amountX:new BN('5'),amountY:new BN('5'),binCount:2}),{minBinId:ACTIVE-1,maxBinId:ACTIVE,binsAbove:1,binsBelow:1});
 assert.throws(()=>inferBinRange({activeId:ACTIVE,binStep:STEP,amountX:new BN(0),amountY:new BN(0),binCount:40}),/positive/);
});
test('DLMM single-sided amounts give single-sided bin ranges that include the active bin',()=>{
 assert.deepEqual(inferBinRange({activeId:ACTIVE,binStep:STEP,amountX:new BN('1000000000'),amountY:new BN(0),binCount:40}),{minBinId:ACTIVE,maxBinId:ACTIVE+40,binsAbove:40,binsBelow:0});
 assert.deepEqual(inferBinRange({activeId:ACTIVE,binStep:STEP,amountX:new BN(0),amountY:new BN('1000'),binCount:40}),{minBinId:ACTIVE-40,maxBinId:ACTIVE,binsAbove:0,binsBelow:40});
});
test('DLMM strategy infers bins only for new positions without explicit bins and keeps the 70-bin ceiling',()=>{
 const d={pool:{lbPair:{activeId:ACTIVE,binStep:STEP}}};
 const inferred=strategy({amountA:'1000000000',amountB:yFor(1e9),parameters:{}},d,null);
 assert.deepEqual(inferred,{minBinId:ACTIVE-20,maxBinId:ACTIVE+19,strategyType:0,inferredRange:true,binCount:40});
 assert.deepEqual(strategy({amountA:'1000000000',parameters:{binCount:69,minBinId:null,maxBinId:null}},d,null),{minBinId:ACTIVE,maxBinId:ACTIVE+69,strategyType:0,inferredRange:true,binCount:69});
 assert.deepEqual(strategy({amountB:'1000',parameters:{binCount:69}},d,null),{minBinId:ACTIVE-69,maxBinId:ACTIVE,strategyType:0,inferredRange:true,binCount:69});
 for(const binCount of [1,70,40.5])assert.throws(()=>strategy({amountA:'1',amountB:'1',parameters:{binCount}},d,null),/binCount must be an integer between 2 and 69/);
 assert.throws(()=>strategy({amountA:'1',amountB:'1',parameters:{minBinId:ACTIVE}},d,null),/Provide both bin IDs or neither/);
 assert.deepEqual(strategy({amountA:'1',amountB:'1',parameters:{minBinId:ACTIVE-5,maxBinId:ACTIVE+5,strategyType:2}},d,null),{minBinId:ACTIVE-5,maxBinId:ACTIVE+5,strategyType:2,inferredRange:false,binCount:null});
 assert.throws(()=>strategy({amountA:'1',amountB:'1',parameters:{minBinId:ACTIVE-35,maxBinId:ACTIVE+35}},d,null),/up to 70 bins/);
 // An existing position keeps its stored range and ignores binCount.
 const p={positionData:{lowerBinId:ACTIVE-3,upperBinId:ACTIVE+2}};
 assert.deepEqual(strategy({amountA:'1000000000',parameters:{binCount:60}},d,p),{minBinId:ACTIVE-3,maxBinId:ACTIVE+2,strategyType:0,inferredRange:false,binCount:null});
 assert.throws(()=>strategy({amountA:'1',parameters:{minBinId:ACTIVE-4,maxBinId:ACTIVE+2}},d,p),/exceeds the existing position/);
});
