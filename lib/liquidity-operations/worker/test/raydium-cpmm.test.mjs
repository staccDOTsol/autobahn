import test from 'node:test';
import assert from 'node:assert/strict';
import { raydiumCpmm, liquidityForBudgets } from '../adapters/raydium-cpmm.mjs';
import { fixture, key, tokenInfo } from './cpmm-fixture.mjs';
import { getPoolSnapshot } from '../adapters/raydium-cpmm/rpc.mjs';
import { quoteDeposit } from '../adapters/raydium-cpmm/math.mjs';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
const ctx = f => ({ connection: f.ctx.connection, owner: f.owner, signers: new Map() });
const request = (f, operation, extra={}) => ({ venue: 'raydium-cpmm', operation, owner:f.owner.toBase58(), pool:f.keys.poolId.toBase58(), liquidity:'100', slippageBps:100, parameters:{}, ...extra });
test('CPMM add and remove retain reviewed amounts in real SDK instructions', async () => {
  const f=fixture(), c=ctx(f);
  for(const op of ['add','remove']) {
    const r=request(f,op),q=await raydiumCpmm.quote(c,r),p=await raydiumCpmm.build(c,r,q);
    assert.deepEqual(q.amounts.slice(0,2).map(x=>x.expectedRaw),['1000','2000']);
    const instruction=p.transactions[0].instructions.find(ix=>ix.programId.toBase58()===raydiumCpmm.programIds[0]);
    assert.ok(instruction);
    assert.equal(instruction.data.readBigUInt64LE(8),100n);
    assert.equal(instruction.data.readBigUInt64LE(16),BigInt(q.amounts[0].limitRaw));
    assert.equal(instruction.data.readBigUInt64LE(24),BigInt(q.amounts[1].limitRaw));
    assert.equal(q.amounts[2].direction,op==='add'?'credit':'debit');
  }
});
test('CPMM initialization uses the sorted canonical mint pair and seed debits', async()=>{
  const f=fixture({exists:false}),c=ctx(f),r=request(f,'initialize',{mintA:f.mintB.toBase58(),mintB:f.mintA.toBase58(),amountA:'4000',amountB:'1000'});
  const q=await raydiumCpmm.quote(c,r),p=await raydiumCpmm.build(c,r,q);
  assert.deepEqual(q.amounts.slice(0,2).map(x=>x.expectedRaw),['1000','4000']);
  assert.equal(q.amounts[2].expectedRaw,'1900');
  assert.equal(p.pool,q.pool);
  assert.ok(p.transactions[0].instructions.some(ix=>ix.programId.toBase58()===raydiumCpmm.programIds[0]));
});
test('CPMM budgets include slippage and choose the maximal affordable LP amount', async()=>{
  const f=fixture(),p=await getPoolSnapshot(f.ctx,f.keys.poolId.toBase58()),r={amountA:'1000',amountB:'2000',slippageBps:100};
  const l=liquidityForBudgets(p,r),q=quoteDeposit(p,l,100),next=quoteDeposit(p,(BigInt(l)+1n).toString(),100);
  assert.ok(q.limitAmountsRaw.every((x,i)=>BigInt(x)<=BigInt(i?'2000':'1000')));
  assert.ok(next.limitAmountsRaw.some((x,i)=>BigInt(x)>BigInt(i?'2000':'1000')));
});
test('CPMM invalid owner, vault authority, and disabled deposit remain rejected',async()=>{
  const f=fixture();f.accounts.get(f.keys.poolId.toBase58()).owner=TOKEN_PROGRAM_ID;
  await assert.rejects(raydiumCpmm.quote(ctx(f),request(f,'add')),/canonical/);
  const g=fixture();g.accounts.set(g.keys.vaultA.toBase58(),tokenInfo(g.mintA,key(42),100006n));
  await assert.rejects(raydiumCpmm.quote(ctx(g),request(g,'add')),/authority/);
  const h=fixture();h.pool.status=1;h.savePool();
  await assert.rejects(raydiumCpmm.quote(ctx(h),request(h,'add')),/disabled/);
});
test('CPMM pool deposit binds reversed UI amounts to their actual mints',async()=>{
 const f=fixture(),c=ctx(f),r=request(f,'add',{liquidity:undefined,mintA:f.mintB.toBase58(),mintB:f.mintA.toBase58(),amountA:'2000',amountB:'1000'});
 const q=await raydiumCpmm.quote(c,r);
 assert.equal(q.mintA,f.mintA.toBase58());assert.equal(q.mintB,f.mintB.toBase58());
 assert.ok(BigInt(q.amounts[0].limitRaw)<=1000n);assert.ok(BigInt(q.amounts[1].limitRaw)<=2000n);
 await assert.rejects(raydiumCpmm.quote(c,{...r,mintA:key(50).toBase58()}),/pair/);
});
