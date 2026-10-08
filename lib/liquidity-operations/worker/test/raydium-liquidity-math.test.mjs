import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Percentage } from '@orca-so/common-sdk';
import { NO_TOKEN_EXTENSION_CONTEXT, PriceMath, increaseLiquidityQuoteByLiquidityWithParams } from '@orca-so/whirlpools-sdk';
import { TickUtil } from '@raydium-io/raydium-sdk-v2';
import { canonicalRequest } from '../adapters/raydium-common.mjs';
import { fitOrcaLiquidity, rangeForPool } from '../adapters/orca.mjs';
import { clmmAmounts, clmmRange } from '../adapters/raydium-clmm.mjs';
import { reservesAfterPnl, quoteAmmDeposit } from '../adapters/raydium-amm-v4.mjs';

test('mint-bound amounts reverse only for the exact pool pair',()=>{
 const request={mintA:'B',mintB:'A',amountA:'100',amountB:'7',liquidity:'3'};
 assert.deepEqual(canonicalRequest(request,'A','B'),{...request,mintA:'A',mintB:'B',amountA:'7',amountB:'100'});
 assert.throws(()=>canonicalRequest({...request,mintB:'C'},'A','B'),/pair/);
 assert.throws(()=>canonicalRequest({mintA:'A'},'A','B'),/pair/);
});
test('concentrated position ranges reject misalignment, reversal and out-of-bounds',()=>{
 for(const range of [{tickLowerIndex:1,tickUpperIndex:64},{tickLowerIndex:128,tickUpperIndex:64},{tickLowerIndex:-500000,tickUpperIndex:64}]) {
  assert.throws(()=>rangeForPool({tickSpacing:64},range));
  assert.throws(()=>clmmRange({tickSpacing:64},range));
 }
 assert.deepEqual(clmmRange({tickSpacing:64}),[-443584,443584]);
});
test('Orca budgets fit both maxima and choose the largest affordable exact liquidity',()=>{
 const params={tickCurrentIndex:0,sqrtPrice:PriceMath.tickIndexToSqrtPriceX64(0),tickLowerIndex:-64,tickUpperIndex:64,tokenExtensionCtx:NO_TOKEN_EXTENSION_CONTEXT,slippageTolerance:Percentage.fromFraction(100,10000)};
 const quote=fitOrcaLiquidity(params,{amountA:'10000000',amountB:'5000000'});
 assert.ok(BigInt(quote.tokenMaxA.toString())<=10000000n);
 assert.ok(BigInt(quote.tokenMaxB.toString())<=5000000n);
 const next=increaseLiquidityQuoteByLiquidityWithParams({...params,liquidity:quote.liquidityAmount.addn(1)});
 assert.ok(BigInt(next.tokenMaxA.toString())>10000000n||BigInt(next.tokenMaxB.toString())>5000000n);
});
test('CLMM amount math preserves large integers, rounds deposit limits up and includes transfer fees',()=>{
 const pool={sqrtPriceX64:TickUtil.getSqrtPriceAtTick(0)},range=[-64,64],liquidity=90071992547409930n;
 const plain=[{},{}],fee=[{transferFee:{basisPoints:100,maximumFeeRaw:'999999999999999999'}},{}];
 const base=clmmAmounts(pool,plain,range,liquidity,0,true),gross=clmmAmounts(pool,fee,range,liquidity,100,true);
 assert.ok(gross[0].expected>base[0].expected);
 for(const value of gross)assert.ok(value.limit>=value.expected);
 const exact=clmmAmounts(pool,plain,range,liquidity,0,false),limited=clmmAmounts(pool,plain,range,liquidity,137,false);
 exact.forEach((value,i)=>assert.equal(limited[i].limit,value.expected*9863n/10000n));
});
test('AMM reserve adjustment reproduces protocol PNL before LP valuation',()=>{
 const pool={systemDecimalValue:new BN(1),baseDecimal:new BN(0),quoteDecimal:new BN(0),pnlNumerator:new BN(12),pnlDenominator:new BN(100),status:new BN(6)};
 assert.deepEqual(reservesAfterPnl(pool,100n,100n,80n,80n),[98n,98n]);
 assert.deepEqual(reservesAfterPnl({...pool,status:new BN(3)},100n,100n,80n,80n),[100n,100n]);
 assert.throws(()=>reservesAfterPnl(pool,10n,10n,80n,80n),/invariant/);
});
test('AMM deposit reserves both-side budgets including slippage and floors actual LP output',()=>{
 const state={reserves:[100000n,200000n],supply:10000n};
 const quote=quoteAmmDeposit(state,{amountA:'1000',amountB:'2000',slippageBps:100});
 assert.ok(quote.limits[0]<=1000n&&quote.limits[1]<=2000n);
 assert.equal(quote.lp,quote.expected[0]*state.supply/state.reserves[0]);
 assert.equal(quote.fixed,0);
 const b=quoteAmmDeposit(state,{amountB:'2000',slippageBps:100});assert.equal(b.fixed,1);assert.equal(b.expected[1],2000n);
});
