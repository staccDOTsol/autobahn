#!/usr/bin/env node
// Check that a router swap carries the 0.1% fee leg and that it executes on
// mainnet (simulation only, nothing is signed or sent).
//
//   node verify-router-fee.mjs --wallet <funded pubkey> [--router <url>] [--rpc <url>]
//       [--input <mint>] [--output <mint>] [--amount <base units>]
//
// Against a router running bin/autobahn-router with platform_fee.rs, the quote
// must carry platformFee and the built /swap transaction must pay exactly that
// into the fee account. --emulate is for a router deployed before the fee: it
// quotes the post-fee input and adds the fee instructions platform_fee.rs
// builds (SOL input only), to show the full transaction executes before deploy.
import { AddressLookupTableAccount, Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { parseArgs } from 'node:util'
import { FEE_OWNER, refuseCompromised, simulate, tokenAmount } from './lib.mjs'

const EXECUTOR = new PublicKey('AutobNFLMzX1rFCDgwWpwr3ztG5c1oDbSrGq7Jj2LgE')
const CHARGE_FEES = 4
const FEE_BPS = 10n
const { values: args } = parseArgs({ options: {
  wallet: { type: 'string' }, router: { type: 'string' }, rpc: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
  amount: { type: 'string' }, 'slippage-bps': { type: 'string' }, emulate: { type: 'boolean' },
} })
if (!args.wallet) throw new Error('--wallet <funded pubkey> is required (simulation fee payer and swapper)')
const wallet = new PublicKey(args.wallet)
refuseCompromised(wallet)
const connection = new Connection(args.rpc ?? process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
const router = (args.router ?? process.env.ROUTER_URL ?? 'https://liquidityxyz-router.fly.dev').replace(/\/$/, '')
const input = new PublicKey(args.input ?? NATIVE_MINT)
const output = new PublicKey(args.output ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const gross = BigInt(args.amount ?? 10_000_000)
const slippageBps = args['slippage-bps'] ?? '100'

async function json(url, init) {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${url.split('?')[0]}: ${res.status} ${body?.message ?? ''}`)
  return body
}
const quoteFor = amount => json(`${router}/quote?${new URLSearchParams({ inputMint: input.toBase58(), outputMint: output.toBase58(), amount: amount.toString(), slippageBps, transactionVersion: '0' })}`)
const ix = r => new TransactionInstruction({
  programId: new PublicKey(r.programId), data: Buffer.from(r.data ?? '', 'base64'),
  keys: (r.accounts ?? []).map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: !!a.isSigner, isWritable: !!a.isWritable })),
})
const decompile = async tx => {
  const lookups = await Promise.all(tx.message.addressTableLookups.map(l => connection.getAddressLookupTable(l.accountKey).then(r => r.value)))
  return TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: lookups }).instructions
}
// The fee leg: the executor's ChargeFees (classic SPL) or a Token-2022 TransferChecked into a FEE_OWNER account.
function feeLegs(instructions) {
  return instructions.flatMap(i => {
    if (i.programId.equals(EXECUTOR) && i.data[0] === CHARGE_FEES)
      return [{ kind: 'executor ChargeFees', amount: i.data.readBigUInt64LE(1), source: i.keys[1].pubkey, vault: i.keys[2].pubkey }]
    if (!i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 12 && i.keys.length === 4)
      return [{ kind: 'Token-2022 TransferChecked', amount: i.data.readBigUInt64LE(1), source: i.keys[0].pubkey, vault: i.keys[2].pubkey, mint: i.keys[1].pubkey }]
    return []
  })
}

let tx, expected
if (!args.emulate) {
  const quote = await quoteFor(gross)
  if (!quote.platformFee) throw new Error(`${router} quoted without platformFee: it is not running the fee build (use --emulate to test against it anyway)`)
  console.log(`quote ${quote.inAmount} ${quote.inputMint} → ${quote.outAmount} ${quote.outputMint}; platformFee ${JSON.stringify(quote.platformFee)}`)
  const swap = await json(`${router}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userPublicKey: wallet.toBase58(), quoteResponse: quote, transactionVersion: '0' }) })
  tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'))
  expected = { amount: BigInt(quote.platformFee.amount), mint: new PublicKey(quote.platformFee.feeMint) }
} else {
  if (!input.equals(NATIVE_MINT)) throw new Error('--emulate covers SOL input only')
  const fee = gross * FEE_BPS / 10_000n
  const quote = await quoteFor(gross - fee)
  console.log(`emulating against a pre-fee router: route ${quote.inAmount} of ${gross} lamports → ${quote.outAmount}, fee ${fee}`)
  const built = await json(`${router}/swap-instructions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userPublicKey: wallet.toBase58(), quoteResponse: quote, transactionVersion: '0' }) })
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true)
  const vault = getAssociatedTokenAddressSync(NATIVE_MINT, FEE_OWNER, true)
  // Same as ix_builder with a platform_fee::FeeLeg on input: wrap input plus fee, then create the fee account and charge.
  const setup = built.setupInstructions.map(ix).map(i => i.programId.equals(SystemProgram.programId) && i.keys[1]?.pubkey.equals(wsol)
    ? SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsol, lamports: gross }) : i)
  const data = Buffer.alloc(10); data[0] = CHARGE_FEES; data.writeBigUInt64LE(fee, 1); data[9] = 100
  const charge = new TransactionInstruction({ programId: EXECUTOR, data, keys: [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: wsol, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: true, isWritable: false }] })
  const instructions = [...built.computeBudgetInstructions.map(ix), ...setup,
    createAssociatedTokenAccountIdempotentInstruction(wallet, vault, FEE_OWNER, NATIVE_MINT, TOKEN_PROGRAM_ID), charge,
    ix(built.swapInstruction), ...built.cleanupInstructions.map(ix)]
  const lookups = await Promise.all((built.addressLookupTableAddresses ?? []).map(a => connection.getAddressLookupTable(new PublicKey(a)).then(r => r.value)))
  const { blockhash } = await connection.getLatestBlockhash()
  tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions }).compileToV0Message(lookups.filter(Boolean)))
  expected = { amount: fee, mint: NATIVE_MINT }
}

const legs = feeLegs(await decompile(tx))
console.log(`fee legs in the transaction: ${legs.map(l => `${l.kind} ${l.amount} → ${l.vault.toBase58()}`).join('; ') || 'NONE'}`)
if (legs.length !== 1 || legs[0].amount !== expected.amount) throw new Error(`expected one fee leg of ${expected.amount}`)
const sim = await simulate(connection, tx, [legs[0].vault])
const before = sim.before[0] ? tokenAmount(sim.before[0]) : 0n
const after = sim.after[0] ? tokenAmount(sim.after[0]) : 0n
console.log(`simulation ${sim.err ? `FAILED ${JSON.stringify(sim.err)}` : 'ok'}, ${sim.unitsConsumed} CU; fee account ${legs[0].vault.toBase58()} ${before} → ${after}`)
if (sim.err) { console.log('  ' + sim.logs.slice(-15).join('\n  ')); process.exit(1) }
const log = sim.logs.find(l => l.startsWith('Program data:'))
if (log) console.log(`executor log: ${log}`)
if (after - before !== expected.amount) { console.log(`fee account received ${after - before}, expected ${expected.amount}`); process.exit(1) }
