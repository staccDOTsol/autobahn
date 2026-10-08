import { createPrivateKey, sign } from 'node:crypto';
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  address, blockhash, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  setTransactionMessageConfig, compileTransaction, getTransactionEncoder,
} from '@solana/kit';

export function compileOperation(bundle, owner, lifetime, version = '1') {
  if (!['0','1'].includes(version)) throw new Error('Unsupported transaction version');
  if (!Array.isArray(bundle.instructions) || !bundle.instructions.length) throw new Error('Empty operation transaction');
  const signers = bundle.signers ?? [];
  if (signers.some(s => s.publicKey.equals(owner))) throw new Error('The service must never sign for the user');
  const instructions = bundle.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId));
  if (!instructions.length || instructions.length > 64) throw new Error('Operation instruction count exceeds transaction capacity');
  // Protocol plans can contain many CPIs. Reserve the runtime maximum, then the
  // browser measures each stage with the current accounts before asking to sign.
  const computeUnitLimit = 1_400_000;
  const priorityFeeLamports = 14_000n;
  let bytes, expectedSigners;
  if (version === '1') {
    let message = createTransactionMessage({version:1});
    message = setTransactionMessageFeePayer(address(owner.toBase58()), message);
    message = setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(lifetime.blockhash), lastValidBlockHeight:BigInt(lifetime.lastValidBlockHeight)},message);
    message = appendTransactionMessageInstructions(instructions.map(ix => ({
      programAddress:address(ix.programId.toBase58()),
      accounts:ix.keys.map(k => ({address:address(k.pubkey.toBase58()),role:(k.isWritable?1:0)+(k.isSigner?2:0)})),
      data:Uint8Array.from(ix.data),
    })),message);
    message = setTransactionMessageConfig({computeUnitLimit,loadedAccountsDataSizeLimit:64*1024*1024,priorityFeeLamports},message);
    const tx = compileTransaction(message);
    expectedSigners = Object.keys(tx.signatures);
    const signatures = {...tx.signatures};
    for(const signer of signers) {
      const pub = signer.publicKey.toBase58();
      if (!expectedSigners.includes(pub)) throw new Error('Unexpected ephemeral signer');
      const key = createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(signer.secretKey.slice(0,32))]),format:'der',type:'pkcs8'});
      signatures[pub] = new Uint8Array(sign(null,tx.messageBytes,key));
    }
    bytes = Buffer.from(getTransactionEncoder().encode({...tx,signatures}));
  } else {
    const message = new TransactionMessage({payerKey:owner,recentBlockhash:lifetime.blockhash,instructions:[
      ComputeBudgetProgram.setComputeUnitLimit({units:computeUnitLimit}),
      ComputeBudgetProgram.setComputeUnitPrice({microLamports:10_000}),...instructions,
    ]}).compileToV0Message();
    const tx = new VersionedTransaction(message);
    if(signers.length) tx.sign(signers);
    expectedSigners = message.staticAccountKeys.slice(0,message.header.numRequiredSignatures).map(x=>x.toBase58());
    bytes = Buffer.from(tx.serialize());
  }
  if(expectedSigners[0] !== owner.toBase58() || expectedSigners.length>12) throw new Error('Invalid operation fee payer or signer count');
  for(const signer of expectedSigners.slice(1)) if(!signers.some(s=>s.publicKey.toBase58()===signer)) throw new Error('Missing required operation signer');
  if(bytes.length > (version==='1'?4096:1232)) throw new Error(`Operation requires more transaction space; select a V1-capable wallet or a smaller operation`);
  return {transaction:bytes.toString('base64'),transactionVersion:version,lastValidBlockHeight:lifetime.lastValidBlockHeight,expectedSigners,prioritizationFeeLamports:Number(priorityFeeLamports)};
}
