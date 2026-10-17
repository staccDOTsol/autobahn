import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  FEE_OWNER, FR28, FR28_POOL, applySlippage, burnOnly, networkFeeLamports, parseTokenAccounts, plan, refuseCompromised,
  simulatedFunding, withoutWsolWrap,
} from '../lib.mjs'

const balance = (mint, amount) => ({ account: Keypair.generate().publicKey, mint, program: TOKEN_PROGRAM_ID, amount, decimals: 6 })

test('FR28 routes through its canonical PumpSwap pool and the owner matches the router', () => {
  assert.equal(FR28_POOL.toBase58(), 'UQ72Gxevtr85KPeQQw8isvMqxR2k627T5rZbRD57NnJ')
  assert.equal(FEE_OWNER.toBase58(), 'Gp6tbJ5pLZfez5xGG42tCqvzf37AdUELyo9amS8mTLdz')
})

test('plan burns FR28, buys with wSOL, sells everything else, and drops empty or unselected balances', () => {
  const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  const other = Keypair.generate().publicKey
  const balances = [balance(FR28, 5n), balance(NATIVE_MINT, 7n), balance(usdc, 9n), balance(other, 0n)]
  const all = plan(balances)
  assert.equal(all.fr28, 5n)
  assert.equal(all.wsol, 7n)
  assert.deepEqual(all.sells.map(b => b.mint.toBase58()), [usdc.toBase58()])
  const onlyUsdc = plan(balances, { mints: [usdc] })
  assert.equal(onlyUsdc.fr28, 0n)
  assert.equal(onlyUsdc.wsol, 0n)
  assert.equal(onlyUsdc.sells.length, 1)
})

test('the PumpSwap wrap, sync and close of the wSOL fee account are removed and nothing else', () => {
  const owner = Keypair.generate().publicKey
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true)
  const elsewhere = Keypair.generate().publicKey
  const keep = [
    createAssociatedTokenAccountIdempotentInstruction(owner, wsol, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: elsewhere, lamports: 1 }),
    createSyncNativeInstruction(elsewhere),
  ]
  const drop = [
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: 1 }),
    createSyncNativeInstruction(wsol),
    createCloseAccountInstruction(wsol, owner, owner),
  ]
  assert.deepEqual(withoutWsolWrap([...drop, ...keep], wsol), keep)
})

test('network fee and slippage arithmetic', () => {
  assert.equal(networkFeeLamports({ computeUnits: 200_000, microLamports: 10_000 }), 7_000n)
  assert.equal(networkFeeLamports({ computeUnits: 1, microLamports: 1 }), 5_001n)
  assert.equal(applySlippage(10_000n, 100), 9_900n)
  assert.equal(applySlippage(99n, 100), 98n)
})

test('the compromised key is refused', () => {
  assert.throws(() => refuseCompromised(new PublicKey('WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb')), /compromised/)
  refuseCompromised(FEE_OWNER, null)
})

test('burns are Token-2022 burnChecked from the owner FR28 account', () => {
  const owner = Keypair.generate().publicKey
  const { instructions: [burn], fr28Account } = burnOnly({ owner, amount: 123n })
  assert.ok(burn.programId.equals(TOKEN_2022_PROGRAM_ID))
  assert.ok(fr28Account.equals(getAssociatedTokenAddressSync(FR28, owner, false, TOKEN_2022_PROGRAM_ID)))
  assert.equal(burn.data[0], 15) // BurnChecked
  assert.equal(burn.data.readBigUInt64LE(1), 123n)
  assert.equal(burn.data[9], 6)
})

test('token accounts parse from both programs', () => {
  const pubkey = Keypair.generate().publicKey.toBase58()
  const parsed = parseTokenAccounts([[TOKEN_2022_PROGRAM_ID, [{ pubkey, account: { data: { parsed: { info: { mint: FR28.toBase58(), tokenAmount: { amount: '42', decimals: 6 } } } } } }]]])
  assert.equal(parsed[0].amount, 42n)
  assert.ok(parsed[0].program.equals(TOKEN_2022_PROGRAM_ID))
})

test('simulated funding wraps into the owner wSOL account and is paid by the funder', () => {
  const funder = Keypair.generate().publicKey
  const ixs = simulatedFunding({ funder, owner: FEE_OWNER, lamports: 5n })
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, FEE_OWNER, true)
  assert.ok(ixs[2].keys[1].pubkey.equals(wsol))
  assert.ok(ixs.every(ix => !ix.keys.some(k => k.isSigner && k.pubkey.equals(FEE_OWNER))))
})
