import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Connection, PublicKey, Keypair, TransactionInstruction } from '@solana/web3.js';
import { BN, raw, maximum, minimum, alignRequest } from '../adapters/meteora-common.mjs';
import { withdrawalAmounts, enforceZeroBinSlippage } from '../adapters/meteora-dlmm.mjs';
import { compileOperation } from '../transactions.mjs';
const require=createRequire(import.meta.url);
const {BorshCoder}=require('@coral-xyz/anchor');
const DLMM=require('@meteora-ag/dlmm');
function replay(fixture) {
 const calls=structuredClone(fixture.calls);
 const connection=new Connection('http://fixture.invalid',{commitment:'confirmed',fetch:async(_url,options)=>{
  const req=JSON.parse(options.body);const index=calls.findIndex(c=>c.request.method===req.method && JSON.stringify(c.request.params)===JSON.stringify(req.params));
  assert.notEqual(index,-1,`Unexpected fixture RPC ${req.method}`);const [entry]=calls.splice(index,1);
  return new Response(JSON.stringify({...entry.response,id:req.id}),{headers:{'content-type':'application/json'}});
 }});
 return {connection,owner:new PublicKey(fixture.request.owner),signers:new Map(['meteora-dlmm-position','meteora-damm-v2-position'].map(name=>[name,Keypair.fromSeed(Buffer.from(fixture.ephemeralTestSeedHex,'hex'))]))};
}
for(const file of ['pumpswap','meteora-damm-v1','meteora-damm-v2','meteora-dlmm']) {
 test(`${file}: real mainnet accounts quote and build a V1 liquidity deposit`,async()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL(`./fixtures/${file}-mainnet-add.json`,import.meta.url),'utf8'));
  const {default:adapter}=await import(`../adapters/${file}.mjs`);const ctx=replay(fixture);
  const quote=await adapter.quote(ctx,fixture.request);assert.deepEqual(quote,fixture.quote);
  const plan=await adapter.build(ctx,fixture.request,quote);assert.ok(plan.transactions.length>0);
  const lifetime=await ctx.connection.getLatestBlockhash('confirmed');
  for(const bundle of plan.transactions){
   assert.ok(bundle.instructions.some(ix=>adapter.programIds.includes(ix.programId.toBase58())));
   assert.ok(bundle.instructions.every(ix=>!ix.keys.some(k=>k.isSigner && !k.pubkey.equals(ctx.owner) && !bundle.signers.some(s=>s.publicKey.equals(k.pubkey)))));
   const tx=compileOperation(bundle,ctx.owner,lifetime,'1');const wire=Buffer.from(tx.transaction,'base64');assert.equal(wire[0],129);assert.ok(wire.length<=4096);assert.equal(tx.expectedSigners[0],fixture.request.owner);
  }
  for(const row of quote.amounts)assert.ok(row.direction==='debit'?BigInt(row.limitRaw)>=BigInt(row.expectedRaw):BigInt(row.limitRaw)<=BigInt(row.expectedRaw));
 });
}
test('atomic amounts and slippage remain exact above Number.MAX_SAFE_INTEGER',()=>{
 const amount=raw('18446744073709551615');assert.equal(maximum(amount,50).toString(),'18538977794078099374');assert.equal(minimum(amount,50).toString(),'18354510353341003856');
 assert.throws(()=>raw('1e9'));assert.throws(()=>raw('18446744073709551616'));assert.throws(()=>raw('0'));assert.equal(raw('0','zero',{zero:true}).toString(),'0');
});
test('reversed pool orientation preserves each input amount’s mint identity',()=>{
 const a=Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey,b=Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
 const req={mintA:b.toBase58(),mintB:a.toBase58(),amountA:'123',amountB:'456'};const aligned=alignRequest(req,a,b);
 assert.equal(aligned.mintA,a.toBase58());assert.equal(aligned.amountA,'456');assert.equal(aligned.amountB,'123');assert.equal(req.amountA,'123');
 assert.throws(()=>alignRequest({...req,mintB:PublicKey.default.toBase58()},a,b));
});
test('DLMM withdrawal rounds actual per-bin shares, excludes bins outside range',()=>{
 const p={positionBinData:[{binId:1,binLiquidity:'7',positionLiquidity:'3',binXAmount:'1000',binYAmount:'21'},{binId:2,binLiquidity:'100',positionLiquidity:'100',binXAmount:'9900',binYAmount:'500'}]};
 const q=withdrawalAmounts(p,5000,1,1);assert.equal(q.a.toString(),'142');assert.equal(q.b.toString(),'3');
});
test('DLMM zero slippage survives the SDK’s truthy default',()=>{
 const program=DLMM.createProgram(new Connection('http://fixture.invalid')); const coder=program.coder;const name='addLiquidityByStrategy2';

 // Use the IDL's canonical parameter names, which differ across SDK releases.
 const ix=program.idl.instructions.find(i=>i.name===name);const liquidityName=ix.args[0].name;const strategy=DLMM.toStrategyParameters({minBinId:-1,maxBinId:1,strategyType:0});
 const data={[liquidityName]:{amountX:new BN(1),amountY:new BN(2),activeId:0,maxActiveBinSlippage:3,strategyParameters:strategy},[ix.args[1].name]:{slices:[]}};
 const programId=new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');const instruction=new TransactionInstruction({programId,keys:[],data:coder.instruction.encode(name,data)});
 enforceZeroBinSlippage({program:{programId,coder}},{instructions:[instruction]},0);
 assert.equal(coder.instruction.decode(instruction.data).data[liquidityName].maxActiveBinSlippage,0);
});
