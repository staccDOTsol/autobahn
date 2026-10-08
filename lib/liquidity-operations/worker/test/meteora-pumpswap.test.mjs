import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Connection, PublicKey, Keypair, TransactionInstruction } from '@solana/web3.js';
import { BN, raw, maximum, minimum, alignRequest } from '../adapters/meteora-common.mjs';
import { withdrawalAmounts, enforceZeroBinSlippage, preserveQuotedBinWindow } from '../adapters/meteora-dlmm.mjs';
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
const files=fs.readdirSync(new URL('./fixtures/',import.meta.url)).filter(f=>/^(pumpswap|meteora-damm-v1|meteora-damm-v2|meteora-dlmm)-mainnet-(add|remove|initialize)\.json$/.test(f));
for(const filename of files) {
 const file=filename.split('-mainnet-')[0];
 test(`${filename}: real mainnet account replay builds a bounded V1 operation`,async()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL(`./fixtures/${filename}`,import.meta.url),'utf8'));
  const {default:adapter}=await import(`../adapters/${file}.mjs`);const ctx=replay(fixture);
  const quote=await adapter.quote(ctx,fixture.request);assert.deepEqual({...quote,warnings:undefined},{...fixture.quote,warnings:undefined});
  const plan=await adapter.build(ctx,fixture.request,quote);assert.ok(plan.transactions.length>0);
  const lifetime=await ctx.connection.getLatestBlockhash('confirmed');
  for(const bundle of plan.transactions){
   assert.ok(bundle.instructions.some(ix=>adapter.programIds.includes(ix.programId.toBase58())));
   assert.ok(bundle.instructions.every(ix=>!ix.keys.some(k=>k.isSigner && !k.pubkey.equals(ctx.owner) && !bundle.signers.some(s=>s.publicKey.equals(k.pubkey)))));
   const programIx=bundle.instructions.find(ix=>adapter.programIds.includes(ix.programId.toBase58()));
   let coder;
   if(file==='pumpswap')coder=require('@pump-fun/pump-swap-sdk').OFFLINE_PUMP_AMM_PROGRAM.coder;
   else if(file==='meteora-damm-v1')coder=require('@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils.js').createProgram(ctx.connection).ammProgram.coder;
   else if(file==='meteora-damm-v2')coder=new(require('@meteora-ag/cp-amm-sdk').CpAmm)(ctx.connection)._program.coder;
   else coder=DLMM.createProgram(ctx.connection).coder;
   const decoded=bundle.instructions.filter(ix=>adapter.programIds.includes(ix.programId.toBase58())).map(ix=>coder.instruction.decode(ix.data));
   assert.ok(decoded.every(Boolean));
   const main=decoded.find(ix=>['createPool','deposit','withdraw','addBalanceLiquidity','removeBalanceLiquidity','initializeCustomizablePermissionlessConstantProductPool','initializeCustomizablePool','addLiquidity','removeLiquidity','addLiquidityByStrategy2','removeLiquidityByRange2','initializeCustomizablePermissionlessLbPair2'].includes(ix.name));
   assert.ok(main,`SDK should encode the intended operation: ${decoded.map(i=>i.name)}`);
   if(file==='pumpswap'&&fixture.request.operation==='add') {assert.equal(main.data.maxBaseAmountIn.toString(),quote.amounts[0].limitRaw);assert.equal(main.data.maxQuoteAmountIn.toString(),quote.amounts[1].limitRaw);assert.equal(main.data.lpTokenAmountOut.toString(),quote.amounts[2].limitRaw);}
   if(file==='meteora-damm-v1'&&fixture.request.operation==='initialize')assert.equal(main.data.params.tradeFeeNumerator.toString(),String(fixture.request.parameters.feeBps*10));
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

test('PumpSwap boost pool rejects ordinary LP quote before preparing a transaction',async()=>{
 const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/pumpswap-mainnet-boost-rejected.json',import.meta.url),'utf8'));
 const {default:adapter}=await import('../adapters/pumpswap.mjs');
 await assert.rejects(adapter.quote(replay(fixture),fixture.request),/boost pools do not support LP/);
});

test('DLMM rebuild preserves the quoted active bin and never rounds its price bound up',()=>{
 const program=DLMM.createProgram(new Connection('http://fixture.invalid'));const name='addLiquidityByStrategy2';const spec=program.idl.instructions.find(i=>i.name===name);const strategy=DLMM.toStrategyParameters({minBinId:-10,maxBinId:10,strategyType:0});
 const data={[spec.args[0].name]:{amountX:new BN(1),amountY:new BN(2),activeId:1,maxActiveBinSlippage:3,strategyParameters:strategy},[spec.args[1].name]:{slices:[]}};
 const ix=new TransactionInstruction({programId:program.programId,keys:[],data:program.coder.instruction.encode(name,data)});
 const pool={program,lbPair:{activeId:1,binStep:25}};const quote={details:{activeId:0,slippageBps:50}};
 preserveQuotedBinWindow(pool,{instructions:[ix]},quote);
 const actual=program.coder.instruction.decode(ix.data).data[spec.args[0].name];assert.equal(actual.activeId,0);assert.equal(actual.maxActiveBinSlippage,1);
 assert.throws(()=>preserveQuotedBinWindow({...pool,lbPair:{activeId:2,binStep:25}},{instructions:[ix]},quote),/outside the approved range/);
});
