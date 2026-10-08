import readline from 'node:readline';
import { boundedRpcFetch } from './rpc.mjs';
import { Connection } from '@solana/web3.js';
import { LiquidityEngine, cleanError } from './engine.mjs';
const write = value => process.stdout.write(JSON.stringify(value)+'\n');
console.log = (...args) => process.stderr.write(args.map(cleanError).join(' ')+'\n');
const definitions=[['raydium-cpmm','raydium-cpmm.mjs'],['raydium-clmm','raydium-clmm.mjs'],['raydium-amm','raydium-amm-v4.mjs'],['orca','orca.mjs'],['meteora-dlmm','meteora-dlmm.mjs'],['meteora-damm','meteora-damm-v1.mjs'],['meteora-damm-v2','meteora-damm-v2.mjs'],['pumpswap','pumpswap.mjs']];
const adapters=[],failures=[];
for(const[id,path]of definitions) {
  try {const module=await import(`./adapters/${path}`);const adapter=module.default??Object.values(module).find(value=>value?.id===id);if(!adapter)throw new Error('Adapter export missing');adapters.push(adapter);}
  catch(error){failures.push({venue:id,error:cleanError(error)});}
}
const url=process.env.LIQUIDITY_RPC_URL??process.env.RPC_HTTP_URL;
if(!url)throw new Error('Liquidity RPC is not configured');
const connection=new Connection(url,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:boundedRpcFetch()});
const engine=new LiquidityEngine({connection,adapters});
let network;
for await(const line of readline.createInterface({input:process.stdin})) {
  let id;
  try {
    if(line.length>64*1024)throw new Error('Operation request too large');
    const req=JSON.parse(line);id=req.id;
    if(req.method!=='capabilities'&&!network) {network=await connection.getGenesisHash();if(network!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {network=undefined;throw new Error('Liquidity operations require Solana mainnet');}}
    let result;
    if(req.method==='capabilities')result={...engine.capabilities(),unavailable:failures};
    else if(req.method==='quote')result=await engine.quote(req.data);
    else if(req.method==='build')result=await engine.build(req.data);
    else if(req.method==='positions')result=await engine.positions(req.data);
    else throw new Error('Unknown operation request');
    write({id,result});
  } catch(error) {write({id,error:cleanError(error)});}
}
