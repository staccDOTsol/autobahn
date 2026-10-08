/** Build a controlled, ordinary SPL test mint for mainnet adapter verification.
 * No funded key is loaded; this script only prepares and simulates an unsigned
 * payer transaction. The coordinator is solely responsible for broadcasting. */
import fs from 'node:fs';
import {Connection,PublicKey,Keypair,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,MINT_SIZE,getAssociatedTokenAddressSync,createInitializeMint2Instruction,createAssociatedTokenAccountIdempotentInstruction,createMintToInstruction} from '@solana/spl-token';
import {compileOperation} from '../transactions.mjs';
import {cleanError} from '../engine.mjs';
try {
  const [ownerAddress,outputPath]=process.argv.slice(2);
  if(!ownerAddress||!outputPath||!process.env.RPC_URL)throw new Error('Usage: RPC_URL=<read-only endpoint> node scripts/prepare-test-mint.mjs OWNER OUTPUT.json');
  const connection=new Connection(process.env.RPC_URL,'confirmed'),owner=new PublicKey(ownerAddress),mint=Keypair.generate(),ata=getAssociatedTokenAddressSync(mint.publicKey,owner);
  const mintRent=await connection.getMinimumBalanceForRentExemption(MINT_SIZE),ataRent=await connection.getMinimumBalanceForRentExemption(165);
  const rawSupply=1000000000000000n;
  const instructions=[SystemProgram.createAccount({fromPubkey:owner,newAccountPubkey:mint.publicKey,lamports:mintRent,space:MINT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(mint.publicKey,6,owner,null),createAssociatedTokenAccountIdempotentInstruction(owner,ata,owner,mint.publicKey),createMintToInstruction(mint.publicKey,ata,owner,rawSupply)];
  const wire=compileOperation({instructions,signers:[mint]},owner,await connection.getLatestBlockhash('confirmed'),'1');
  const before=await connection.getBalance(owner,'confirmed'),result=await connection._rpcRequest('simulateTransaction',[wire.transaction,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed',accounts:{encoding:'base64',addresses:[ownerAddress]}}]);
  const data={owner:ownerAddress,mint:mint.publicKey.toBase58(),ata:ata.toBase58(),decimals:6,rawSupply:String(rawSupply),mintAuthority:ownerAddress,freezeAuthority:null,transaction:wire,mintRentLamports:mintRent,ataRentLamports:ataRent,simulation:{error:result.error??result.result?.value.err??null,unitsConsumed:result.result?.value.unitsConsumed,payerDebitLamports:result.result?.value.accounts?.[0]?before-result.result.value.accounts[0].lamports:null,logs:result.result?.value.logs},notice:'Preparation only. No transaction sent; no funded wallet key loaded. Mint ephemeral signer is already signed in the V1 wire.'};
  fs.writeFileSync(outputPath,JSON.stringify(data,null,2));console.log(JSON.stringify({mint:data.mint,simulation:data.simulation,outputPath}));
}catch(error){console.error(cleanError(error));process.exitCode=1;}
