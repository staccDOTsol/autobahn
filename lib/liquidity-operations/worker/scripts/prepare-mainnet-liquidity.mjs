/** Prepare and simulate production-engine LP operations. This module never signs
 * with a funded key, broadcasts transactions, or requests an airdrop. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { LiquidityEngine, cleanError } from '../engine.mjs';
import cpmm from '../adapters/raydium-cpmm.mjs';
import clmm from '../adapters/raydium-clmm.mjs';
import orca from '../adapters/orca.mjs';
import amm from '../adapters/raydium-amm-v4.mjs';
import damm1 from '../adapters/meteora-damm-v1.mjs';
import damm2 from '../adapters/meteora-damm-v2.mjs';
import dlmm from '../adapters/meteora-dlmm.mjs';
import pump from '../adapters/pumpswap.mjs';

export async function prepareLiquidityPlan({connection,request}) {
  const engine = new LiquidityEngine({connection,adapters:[cpmm,clmm,orca,amm,damm1,damm2,dlmm,pump]});
  const quote = await engine.quote({...request,transactionVersion:'1'});
  const built = await engine.build({quoteId:quote.quoteId,owner:request.owner,transactionVersion:'1'});
  const owner = new PublicKey(request.owner), accountKeys = [owner.toBase58()];
  for (const mint of new Set(quote.amounts.map(a=>a.mint))) {
    const key = new PublicKey(mint), info = await connection.getAccountInfo(key,'confirmed');
    if (!info) continue; // A pool's LP mint is created by initialization itself.
    accountKeys.push(getAssociatedTokenAddressSync(key,owner,false,info.owner).toBase58());
    const accounts = await connection.getTokenAccountsByOwner(owner,{mint:key},'confirmed');
    accountKeys.push(...accounts.value.map(a=>a.pubkey.toBase58()));
  }
  const addresses = [...new Set(accountKeys)];
  const before = await connection.getMultipleAccountsInfo(addresses.map(a=>new PublicKey(a)),'confirmed');
  const simulations = [];
  for (const transaction of built.transactions) {
    const result = await connection._rpcRequest('simulateTransaction',[transaction.transaction,{
      encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed',
      accounts:{encoding:'base64',addresses},
    }]);
    const value=result.result?.value;
    simulations.push({error:result.error??value?.err??null,unitsConsumed:value?.unitsConsumed,logs:value?.logs,
      // Each transaction is simulated against current chain state independently.
      // A later transaction can require accounts created by its predecessor.
      payerLamportsBefore:before[0]?.lamports??null,payerLamportsAfter:value?.accounts?.[0]?.lamports??null,
      payerDebitLamports:before[0]&&value?.accounts?.[0]?before[0].lamports-value.accounts[0].lamports:null,
      accounts:addresses.map((address,i)=>({address,before:before[i]?{owner:before[i].owner.toBase58(),lamports:before[i].lamports,data:before[i].data.toString('base64')}:null,after:value?.accounts?.[i]??null})),
    });
  }
  return {preparedAt:new Date().toISOString(),request:{...request,transactionVersion:'1'},...built,simulations,
    notice:'Unsigned funded-wallet transaction(s); ephemeral signatures only. No transaction broadcast. Rebuild after expiry; simulate each dependent transaction immediately before signing and sending.'};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [requestPath,outputPath]=process.argv.slice(2);
    if (!requestPath||!outputPath||!process.env.RPC_URL) throw new Error('Usage: RPC_URL=<read-only endpoint> node scripts/prepare-mainnet-liquidity.mjs REQUEST.json OUTPUT.json');
    const request=JSON.parse(fs.readFileSync(requestPath,'utf8'));
    const result=await prepareLiquidityPlan({connection:new Connection(process.env.RPC_URL,'confirmed'),request});
    fs.writeFileSync(outputPath,JSON.stringify(result,null,2));
    console.log(JSON.stringify({venue:request.venue,operation:request.operation,pool:result.pool,position:result.position,transactions:result.transactions.length,simulations:result.simulations.map(({error,unitsConsumed,payerDebitLamports})=>({error,unitsConsumed,payerDebitLamports})),outputPath}));
  } catch(error) { console.error(cleanError(error));process.exitCode=1; }
}
