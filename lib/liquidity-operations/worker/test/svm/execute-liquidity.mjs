/** Actual, isolated Agave SVM lifecycle verification. No mainnet sends.
 * Reads and pins mainnet program ELF/config accounts; funds synthetic wallets and
 * mints only in an ephemeral local ledger; executes the adapters' V1 wire output.
 * Run from worker: RPC_URL=<read-only endpoint> node test/svm/execute-liquidity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash,createPrivateKey,sign } from 'node:crypto';
import { Connection,PublicKey,Keypair,SystemProgram,Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,MintLayout,AccountLayout,AccountState,getAssociatedTokenAddressSync,unpackAccount } from '@solana/spl-token';
import { getTransactionDecoder,getTransactionEncoder } from '@solana/kit';
import { PersonalPositionLayout, METADATA_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2';
import { createRequire } from 'node:module';
const DLMM=createRequire(import.meta.url)('@meteora-ag/dlmm');
import { ParsablePosition } from '@orca-so/whirlpools-sdk';
import { compileOperation } from '../../transactions.mjs';
import cpmm from '../../adapters/raydium-cpmm.mjs';
import clmm from '../../adapters/raydium-clmm.mjs';
import orca from '../../adapters/orca.mjs';
import amm from '../../adapters/raydium-amm-v4.mjs';
import damm1 from '../../adapters/meteora-damm-v1.mjs';
import damm2 from '../../adapters/meteora-damm-v2.mjs';
import dlmm from '../../adapters/meteora-dlmm.mjs';
import pump from '../../adapters/pumpswap.mjs';

const root=path.resolve('../../../target/liquidity-svm'),accountsDir=path.join(root,'accounts'),programDir=path.join(root,'programs');
fs.rmSync(accountsDir,{recursive:true,force:true});fs.mkdirSync(accountsDir,{recursive:true});fs.mkdirSync(programDir,{recursive:true});
const endpoint=process.env.RPC_URL;if(!endpoint)throw new Error('RPC_URL is required for read-only mainnet capture');
async function retryRead(run){for(let attempt=0;;attempt++){try{return await run();}catch(error){if(attempt>=7||!/429|rate limit|fetch failed/i.test(String(error.message)))throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**attempt,15000)));}}}
const mainnet=new Connection(endpoint,{commitment:'confirmed',disableRetryOnRateLimit:true});
const slot=await retryRead(()=>mainnet.getSlot('confirmed')),owner=Keypair.generate(),mintA=Keypair.generate().publicKey,mintB=Keypair.generate().publicKey;
const synthetic=new Map(),captured=new Map(),programs=new Map();
const publicInfo=(owner,data,lamports=10000000)=>({owner:owner.toBase58(),data:[Buffer.from(data).toString('base64'),'base64'],lamports,executable:false,rentEpoch:0,space:data.length});
synthetic.set(owner.publicKey.toBase58(),publicInfo(SystemProgram.programId,Buffer.alloc(0),100_000_000_000));
for(const mint of [mintA,mintB]){
 const data=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:1,mintAuthority:owner.publicKey,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);synthetic.set(mint.toBase58(),publicInfo(TOKEN_PROGRAM_ID,data));
 const ata=getAssociatedTokenAddressSync(mint,owner.publicKey),token=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner:owner.publicKey,amount:1000000000000000n,delegateOption:0,delegate:PublicKey.default,state:AccountState.Initialized,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},token);synthetic.set(ata.toBase58(),publicInfo(TOKEN_PROGRAM_ID,token));
}
const headers={'content-type':'application/json'};
async function captureRpc(req){
 if(req.method==='sendTransaction'||req.method==='requestAirdrop')throw new Error('Mainnet writes are prohibited in capture');
 const p=req.params??[],reply={jsonrpc:'2.0',id:req.id};
 if(req.method==='getAccountInfo'&&synthetic.has(p[0]))return{...reply,result:{context:{slot},value:synthetic.get(p[0])}};
 if(req.method==='getTokenAccountsByOwner'&&p[0]===owner.publicKey.toBase58())return{...reply,result:{context:{slot},value:[...synthetic].filter(([,a])=>a.owner===TOKEN_PROGRAM_ID.toBase58()&&a.space===165).filter(([,a])=>!p[1].mint||new PublicKey(Buffer.from(a.data[0],'base64').subarray(0,32)).toBase58()===p[1].mint).map(([pubkey,account])=>({pubkey,account}))}};
 const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(req)});const json=JSON.parse(await response.text(),(key,value,context)=>key==='rentEpoch'&&typeof value==='number'&&!Number.isSafeInteger(value)?JSON.rawJSON(context.source):value);
 if(json.error)throw new Error(`Read-only capture ${req.method}: ${json.error.message}`);
 if(req.method==='getMultipleAccounts'){
  json.result.value=json.result.value.map((value,i)=>synthetic.get(p[0][i])??value);
  p[0].forEach((key,i)=>{if(json.result.value[i])captured.set(key,json.result.value[i]);});
 }else if(req.method==='getAccountInfo'&&json.result.value)captured.set(p[0],json.result.value);
 return json;
}
const capture=new Connection(endpoint,{commitment:'confirmed',fetch:async(_url,options)=>new Response(JSON.stringify(await retryRead(()=>captureRpc(JSON.parse(options.body)))),{status:200,headers})});
const adapters=[cpmm,orca,clmm,amm,damm1,damm2,dlmm,pump].filter(a=>!process.env.VENUES||process.env.VENUES.split(',').includes(a.id));
const initial=[];
for(const adapter of adapters){
 const ctx={connection:capture,owner:owner.publicKey,signers:new Map()},request={venue:adapter.id,operation:'initialize',owner:owner.publicKey.toBase58(),mintA:mintA.toBase58(),mintB:mintB.toBase58(),amountA:'1000000000000',amountB:'1000000000000',slippageBps:100,parameters:{configIndex:0,tickSpacing:64,initialPrice:'1',openTime:'0'}};
 const quote=await adapter.quote(ctx,request),plan=await adapter.build(ctx,request,quote);initial.push({adapter,ctx,request,quote,plan});
 const keys=[...new Set(plan.transactions.flatMap(t=>t.instructions.flatMap(ix=>[ix.programId.toBase58(),...ix.keys.map(k=>k.pubkey.toBase58())])))];
 for(let i=0;i<keys.length;i+=100)await capture.getMultipleAccountsInfo(keys.slice(i,i+100).map(x=>new PublicKey(x)),'confirmed');
 console.log(JSON.stringify({venue:adapter.id,stage:'captured-initialize',pool:quote.pool,transactions:plan.transactions.length}));
}
for(const [key,value]of synthetic)captured.set(key,value);
const basePrograms=[METADATA_PROGRAM_ID.toBase58(),TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58(),ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',...adapters.flatMap(a=>a.programIds),...[...captured].filter(([,a])=>a.executable&&a.owner.startsWith('BPFLoader')).map(([key])=>key)];
for(const key of new Set(basePrograms)){
 const cachedFile=path.join(programDir,key+'.so');if(fs.existsSync(cachedFile)){const bytes=fs.readFileSync(cachedFile);programs.set(key,{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});captured.delete(key);continue;}
 const account=await retryRead(()=>mainnet.getAccountInfo(new PublicKey(key),'confirmed'));if(!account?.executable)throw new Error(`Program is not executable: ${key}`);
 let bytes=account.data;
 if(account.owner.toBase58()==='BPFLoaderUpgradeab1e11111111111111111111111'){
  if(bytes.readUInt32LE(0)!==2)throw new Error('Invalid upgradeable Program state');const dataKey=new PublicKey(bytes.subarray(4,36));const data=await retryRead(()=>mainnet.getAccountInfo(dataKey,'confirmed'));if(!data||data.data.readUInt32LE(0)!==3)throw new Error('Missing ProgramData');bytes=data.data.subarray(45);captured.delete(dataKey.toBase58());
 }
 if(!bytes.subarray(0,4).equals(Buffer.from([127,69,76,70])))throw new Error(`Program has no ELF: ${key}`);
 fs.writeFileSync(path.join(programDir,key+'.so'),bytes);programs.set(key,{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});captured.delete(key);
}
// Loader/native/sysvar accounts belong to the local runtime, not the cloned state.
for(const [key,value]of captured){if(value.executable||key.startsWith('Sysvar')||key===SystemProgram.programId.toBase58())continue;fs.writeFileSync(path.join(accountsDir,key+'.json'),JSON.stringify({pubkey:key,account:value}));}
const rpcPort=18999,localUrl=`http://127.0.0.1:${rpcPort}`,ledger=path.join(root,'ledger');
const args=['--reset','--ledger',ledger,'--bind-address','127.0.0.1','--rpc-port',String(rpcPort),'--faucet-port','18998','--dynamic-port-range','19002-19040','--limit-ledger-size','1000','--account-dir',accountsDir,'--warp-slot',String(slot),'--log'];
for(const key of programs.keys())args.push('--bpf-program',key,path.join(programDir,key+'.so'));
const log=fs.openSync(path.join(root,'validator.log'),'w'),validator=spawn('solana-test-validator',args,{stdio:['ignore',log,log]});
const local=new Connection(localUrl,{commitment:'confirmed',confirmTransactionInitialTimeout:30000});
const evidence={capturedAt:new Date().toISOString(),mainnetSlot:slot,programs:Object.fromEntries(programs),syntheticSetup:{owner:owner.publicKey.toBase58(),mintA:mintA.toBase58(),mintB:mintB.toBase58(),funding:'Local ledger only;100SOL and1e15 raw units per mint'},executions:[],failures:[]};
function signOwner(wire){const decoded=getTransactionDecoder().decode(Buffer.from(wire,'base64'));const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(owner.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});return Buffer.from(getTransactionEncoder().encode({...decoded,signatures:{...decoded.signatures,[owner.publicKey.toBase58()]:new Uint8Array(sign(null,decoded.messageBytes,key))}})).toString('base64');}
async function balance(mint){if(!await local.getAccountInfo(new PublicKey(mint),'confirmed'))return 0n;const r=await local.getTokenAccountsByOwner(owner.publicKey,{mint:new PublicKey(mint)},'confirmed');return r.value.reduce((n,{pubkey,account})=>n+unpackAccount(pubkey,account,account.owner).amount,0n);}
async function positionLiquidity(adapter,address){if(!address)return null;const info=await local.getAccountInfo(new PublicKey(address),'confirmed');if(!info)return 0n;if(adapter.id==='orca')return BigInt(ParsablePosition.parse(new PublicKey(address),info).liquidity.toString());if(adapter.id==='raydium-clmm')return BigInt(PersonalPositionLayout.decode(info.data).liquidity.toString());return null;}
async function execute(adapter,operation,quote,plan){
 if(!/^http:\/\/127\.0\.0\.1:18999$/.test(local.rpcEndpoint))throw new Error('Writes are restricted to the isolated localhost validator');
 const positionBefore=await positionLiquidity(adapter,quote.position);
 const mints=[...new Set(quote.amounts.map(a=>a.mint))],before=new Map(await Promise.all(mints.map(async m=>[m,await balance(m)]))),signatures=[];
 for(const bundle of plan.transactions){const life=await local.getLatestBlockhash('confirmed'),wire=compileOperation(bundle,owner.publicKey,life,'1'),signed=signOwner(wire.transaction);
  const simulation=await local._rpcRequest('simulateTransaction',[signed,{encoding:'base64',sigVerify:true,commitment:'confirmed'}]);
  if(simulation.error||simulation.result?.value.err)throw new Error(JSON.stringify({stage:'local-simulation',venue:adapter.id,operation,error:simulation.error??simulation.result.value.err,logs:simulation.result?.value.logs}));
  const signature=await local.sendEncodedTransaction(signed,{skipPreflight:true,maxRetries:0});
  const confirmed=await local.confirmTransaction({signature,...life},'confirmed');if(confirmed.value.err)throw new Error(JSON.stringify(confirmed.value.err));
  signatures.push({signature,units:simulation.result.value.unitsConsumed,wireBytes:Buffer.from(signed,'base64').length});
 }
 const changes=[];
 for(const item of quote.amounts){const after=await balance(item.mint),delta=after-before.get(item.mint),magnitude=item.direction==='debit'?-delta:delta;
  if(magnitude<0n||(item.direction==='debit'?magnitude>BigInt(item.limitRaw):magnitude<BigInt(item.limitRaw)))throw new Error(`Economic bound violation ${adapter.id}/${operation} ${item.mint}: ${delta}`);
  changes.push({mint:item.mint,direction:item.direction,before:before.get(item.mint).toString(),after:after.toString(),actualRaw:magnitude.toString(),expectedRaw:item.expectedRaw,limitRaw:item.limitRaw});
 }
 const positionAfter=await positionLiquidity(adapter,quote.position);
 if(positionBefore!==null&&positionAfter!==null&&operation!=='initialize'){
  const movement=operation==='add'?positionAfter-positionBefore:positionBefore-positionAfter;
  if(movement!==BigInt(quote.details.liquidity))throw new Error(`Position liquidity differs from reviewed amount: ${movement}`);
 }
 const created=await local.getAccountInfo(new PublicKey(quote.pool),'confirmed');if(!created||!adapter.programIds.includes(created.owner.toBase58()))throw new Error('Executed pool has incorrect owner');
 const result={positionLiquidityBefore:positionBefore?.toString(),positionLiquidityAfter:positionAfter?.toString(),venue:adapter.id,operation,pool:quote.pool,position:quote.position,transactions:signatures,balances:changes};evidence.executions.push(result);fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({venue:adapter.id,operation,status:'executed-on-local-SVM',transactions:signatures.length,balances:changes.map(x=>({direction:x.direction,actualRaw:x.actualRaw,expectedRaw:x.expectedRaw}))}));
}
try{
 let ready=false;for(let i=0;i<120;i++){if(validator.exitCode!=null)throw new Error(`Local validator exited${validator.exitCode}; see ${root}/validator.log`);try{await local.getLatestBlockhash('confirmed');ready=true;break;}catch{}await new Promise(r=>setTimeout(r,500));}if(!ready)throw new Error('Local validator did not start');
 // These are mainnet program/config fixtures in a separate genesis. Only this
 // test transport supplies the known source-cluster identity to network guards.
 const fixtureConnection=new Proxy(local,{get(target,key){if(key==='getGenesisHash')return async()=> '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';const v=target[key];return typeof v==='function'?v.bind(target):v;}});
 for(const entry of initial){const{adapter,quote,plan}=entry;try{await execute(adapter,'initialize',quote,plan);const ctx={connection:fixtureConnection,owner:owner.publicKey,signers:new Map()};
  const add={venue:adapter.id,operation:'add',owner:owner.publicKey.toBase58(),pool:quote.pool,mintA:mintA.toBase58(),mintB:mintB.toBase58(),amountA:'1000000000',amountB:'1020000000',slippageBps:100,parameters:{}};
  const addQuote=await adapter.quote(ctx,add),addPlan=await adapter.build(ctx,add,addQuote);await execute(adapter,'add',addQuote,addPlan);
  if(adapter.id==='meteora-dlmm'){
   const pool=await DLMM.create(fixtureConnection,new PublicKey(quote.pool));
   // DLMM disallows withdrawal at the pool's activation timestamp. Advance by
   // actual local slots/time, without editing pool or clock accounts.
   for(let attempt=0;;attempt++){
    const clock=await local.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'),'confirmed');
    const point=pool.lbPair.activationType===0?clock.data.readBigUInt64LE(0):clock.data.readBigInt64LE(32);
    if(point>BigInt(pool.lbPair.activationPoint.toString()))break;
    if(attempt>=100)throw new Error('Local clock did not advance beyond DLMM activation');
    await new Promise(resolve=>setTimeout(resolve,250));
   }
   await pool.refetchStates();const info=await local.getAccountInfo(new PublicKey(addQuote.position),'confirmed');const p=DLMM.wrapPosition(pool.program,new PublicKey(addQuote.position),info);console.log(JSON.stringify({stage:'dlmm-lock-state',activationPoint:pool.lbPair.activationPoint.toString(),activationType:pool.lbPair.activationType,status:pool.lbPair.status,clockSlot:pool.clock.slot.toString(),clockUnixTimestamp:pool.clock.unixTimestamp.toString(),lockReleasePoint:p.lockReleasePoint().toString(),lastUpdatedAt:p.lastUpdatedAt().toString()}));
  }
  const remove={venue:adapter.id,operation:'remove',owner:owner.publicKey.toBase58(),pool:quote.pool,position:addQuote.position,...(addQuote.details.liquidity?{liquidity:(BigInt(addQuote.details.liquidity)/2n).toString()}:{}),slippageBps:100,parameters:adapter.id==='meteora-dlmm'?{removeBps:5000}:{}};
  const removeQuote=await adapter.quote(ctx,remove),removePlan=await adapter.build(ctx,remove,removeQuote);await execute(adapter,'remove',removeQuote,removePlan);
 }catch(error){const poolState=await local.getAccountInfo(new PublicKey(quote.pool),'confirmed');const clock=await local.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'),'confirmed');evidence.failures.push({venue:adapter.id,pool:quote.pool,poolData:poolState?.data.toString('base64'),clockData:clock?.data.toString('base64'),message:String(error.message),stack:error.stack});fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.error(JSON.stringify({venue:adapter.id,status:'failed',message:String(error.message)}));}}
 if(evidence.failures.length)throw new Error(`${evidence.failures.length} venue lifecycle(s) failed; see evidence.json`);
}catch(error){fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify({message:String(error.message),stack:error.stack},null,2));console.error(String(error.stack));process.exitCode=1;}finally{if(validator.exitCode===null){validator.kill('SIGTERM');await new Promise(resolve=>validator.once('exit',resolve));}fs.closeSync(log);}

// RPC subscriptions may retain reconnect timers after a local validator exits.
process.exit(process.exitCode??0);
