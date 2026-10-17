// Shared pieces of the router fee buy-and-burn crank. Pure helpers are
// exported for tests; network helpers take an explicit Connection / URL.
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js'
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import BN from 'bn.js'
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, canonicalPumpPoolPda, supportsTradeV2 } from '@pump-fun/pump-swap-sdk'

/** Router fee wallet: FEE_OWNER in bin/autobahn-router/src/platform_fee.rs. */
export const FEE_OWNER = new PublicKey('Gp6tbJ5pLZfez5xGG42tCqvzf37AdUELyo9amS8mTLdz')
/** Token-2022 pump.fun mint; its bonding curve completed and it trades on its canonical PumpSwap pool. */
export const FR28 = new PublicKey('Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump')
export const FR28_POOL = canonicalPumpPoolPda(FR28)
/** Reported compromised: never a signer, payer or fee owner. */
export const COMPROMISED = new Set(['WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb'])
export const SIGNATURE_LAMPORTS = 5_000
export const DEFAULT_MICRO_LAMPORTS = 10_000
export const BUY_BURN_COMPUTE_UNITS = 200_000
const TOKEN_ACCOUNT_RENT_2022 = 2_074_080
const SYSTEM_TRANSFER = 2
const TOKEN_CLOSE_ACCOUNT = 9
const TOKEN_SYNC_NATIVE = 17

export function refuseCompromised(...keys) {
  for (const key of keys) if (key && COMPROMISED.has(key.toBase58())) throw new Error(`${key.toBase58()} is reported compromised; refusing to use it`)
}

/** Signature fee plus priority fee for one transaction. */
export function networkFeeLamports({ signatures = 1, computeUnits, microLamports }) {
  return BigInt(signatures * SIGNATURE_LAMPORTS) + (BigInt(computeUnits) * BigInt(microLamports) + 999_999n) / 1_000_000n
}

/** Token balances of the fee owner, from getTokenAccountsByOwner (jsonParsed) results per program. */
export function parseTokenAccounts(byProgram) {
  const out = []
  for (const [program, value] of byProgram) {
    for (const { pubkey, account } of value) {
      const info = account.data.parsed.info
      out.push({ account: new PublicKey(pubkey), mint: new PublicKey(info.mint), program, amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals })
    }
  }
  return out
}

/**
 * Split fee balances into the work the crank does: FR28 is burned as is,
 * wSOL buys FR28 on PumpSwap, everything else is sold into wSOL through the router first.
 */
export function plan(balances, { mints = null } = {}) {
  const wanted = balances.filter(b => b.amount > 0n && (!mints || mints.some(m => m.equals(b.mint))))
  return {
    fr28: wanted.filter(b => b.mint.equals(FR28)).reduce((sum, b) => sum + b.amount, 0n),
    wsol: wanted.filter(b => b.mint.equals(NATIVE_MINT)).reduce((sum, b) => sum + b.amount, 0n),
    sells: wanted.filter(b => !b.mint.equals(FR28) && !b.mint.equals(NATIVE_MINT)),
  }
}

/**
 * The PumpSwap SDK wraps a wSOL input from native SOL and closes the account
 * afterwards. The fee owner's wSOL account already holds the fees and is the
 * router's fee account for SOL, so keep it: drop the wrap, sync and close.
 */
export function withoutWsolWrap(instructions, wsolAccount) {
  return instructions.filter(ix => {
    const touches = i => ix.keys[i]?.pubkey.equals(wsolAccount)
    if (ix.programId.equals(SystemProgram.programId) && ix.data.length >= 4 && ix.data.readUInt32LE(0) === SYSTEM_TRANSFER && touches(1)) return false
    if (ix.programId.equals(TOKEN_PROGRAM_ID) && (ix.data[0] === TOKEN_SYNC_NATIVE || ix.data[0] === TOKEN_CLOSE_ACCOUNT) && touches(0)) return false
    return true
  })
}

export function applySlippage(amount, slippageBps) {
  return amount * BigInt(10_000 - slippageBps) / 10_000n
}

export async function feeBalances(connection, owner) {
  const byProgram = []
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await connection.getParsedTokenAccountsByOwner(owner, { programId: program })
    byProgram.push([program, value])
  }
  return parseTokenAccounts(byProgram)
}

/**
 * wSOL → FR28 on the canonical PumpSwap pool, spending exactly `spend`
 * lamports of the owner's wSOL fee account, then burn the FR28 the owner
 * holds plus the minimum bought. Anything bought above the minimum is burned
 * by the next run.
 */
export async function buyAndBurn(connection, { owner, spend, existingFr28 = 0n, slippageBps }) {
  const state = await new OnlinePumpAmmSdk(connection).swapSolanaState(FR28_POOL, owner)
  const { pool } = state
  if (!pool.baseMint.equals(FR28) || !pool.quoteMint.equals(NATIVE_MINT)) throw new Error(`${FR28_POOL.toBase58()} is not the FR28/wSOL pool`)
  const quoteIn = new BN(spend.toString())
  const expected = (quote) => BigInt(buyQuoteInput({
    quote, slippage: 0, baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: pool.virtualQuoteReserves, globalConfig: state.globalConfig, baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint, coinCreator: pool.coinCreator, creator: pool.creator, feeConfig: state.feeConfig,
    quoteMint: pool.quoteMint, isMayhemMode: pool.isMayhemMode, creatorFeeBps: pool.creatorFeeBps,
  }).base.toString())
  let instructions, expectedBase, minBase, variant
  if (supportsTradeV2(pool)) {
    variant = 'buy_exact_quote_in_v2'
    expectedBase = expected(quoteIn)
    minBase = applySlippage(expectedBase, slippageBps)
    if (minBase <= 0n) throw new Error('Spend buys no FR28')
    instructions = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(state, quoteIn, new BN(minBase.toString()))
  } else {
    // v1 buy is exact base out with a quote cap: size the base so the cap is the spend.
    variant = 'buy'
    expectedBase = expected(new BN((spend * 10_000n / BigInt(10_000 + slippageBps)).toString()))
    minBase = expectedBase
    if (minBase <= 0n) throw new Error('Spend buys no FR28')
    instructions = await PUMP_AMM_SDK.buyInstructions(state, new BN(minBase.toString()), quoteIn)
  }
  instructions = withoutWsolWrap(instructions, state.userQuoteTokenAccount)
  const burn = existingFr28 + minBase
  instructions.push(createBurnCheckedInstruction(state.userBaseTokenAccount, FR28, owner, burn, state.baseMintAccount.decimals, [], state.baseTokenProgram))
  const fr28AccountRent = state.userBaseAccountInfo ? 0n : BigInt(TOKEN_ACCOUNT_RENT_2022)
  return { instructions, variant, expectedBase, minBase, burn, wsolAccount: state.userQuoteTokenAccount, fr28Account: state.userBaseTokenAccount, fr28AccountRent }
}

/** What `amount` FR28 is worth in lamports at the pool's spot price. */
export async function fr28ValueLamports(connection, amount) {
  const pool = await new OnlinePumpAmmSdk(connection).fetchPool(FR28_POOL)
  const [base, quote] = await connection.getMultipleAccountsInfo([pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount])
  return amount * tokenAmount(quote.data) / tokenAmount(base.data)
}

export function burnOnly({ owner, amount, decimals = 6 }) {
  const account = getAssociatedTokenAddressSync(FR28, owner, false, TOKEN_2022_PROGRAM_ID)
  return { instructions: [createBurnCheckedInstruction(account, FR28, owner, amount, decimals, [], TOKEN_2022_PROGRAM_ID)], fr28Account: account }
}

/** Sell one fee balance into the owner's wSOL fee account through the router. */
export async function routerSell(routerUrl, { owner, mint, amount, slippageBps, microLamports, fetcher = fetch }) {
  const base = routerUrl.replace(/\/$/, '')
  const params = new URLSearchParams({ inputMint: mint.toBase58(), outputMint: NATIVE_MINT.toBase58(), amount: amount.toString(), slippageBps: String(slippageBps), transactionVersion: '0' })
  const quoteRes = await fetcher(`${base}/quote?${params}`)
  const quote = await quoteRes.json().catch(() => null)
  if (!quoteRes.ok || !quote?.outAmount) return { skipped: `no route (${quote?.message ?? quoteRes.status})` }
  const swapRes = await fetcher(`${base}/swap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // Keep the proceeds wrapped: the wSOL account is the buy leg's input.
    body: JSON.stringify({ userPublicKey: owner.toBase58(), quoteResponse: quote, wrapAndUnwrapSol: false, autoCreateOutAta: true, transactionVersion: '0', computeUnitPriceMicroLamports: microLamports }),
  })
  const swap = await swapRes.json().catch(() => null)
  if (!swapRes.ok || typeof swap?.swapTransaction !== 'string') return { skipped: `router could not build (${swap?.message ?? swapRes.status})`, quote }
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'))
  const fee = BigInt(SIGNATURE_LAMPORTS) + BigInt(swap.prioritizationFeeLamports ?? 0)
  return { quote, tx, fee, out: BigInt(quote.outAmount) }
}

export function computeBudget(units, microLamports) {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports })]
}

export function compile(payer, instructions, blockhash) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message())
}

/**
 * Simulation-only stand-in for fees the owner has not collected yet: `funder`
 * pays the transaction, tops the owner up for rent and wraps `lamports` into
 * the owner's wSOL fee account inside the simulated transaction.
 */
export function simulatedFunding({ funder, owner, lamports, ownerTopUp = 10_000_000n }) {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID)
  return [
    SystemProgram.transfer({ fromPubkey: funder, toPubkey: owner, lamports: ownerTopUp }),
    createAssociatedTokenAccountIdempotentInstruction(funder, wsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: funder, toPubkey: wsol, lamports }),
    createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
  ]
}

const u64At = (data, offset) => data.length >= offset + 8 ? Buffer.from(data).readBigUInt64LE(offset) : null
/** Mint supply (offset 36) or token account amount (offset 64). */
export const mintSupply = data => u64At(data, 36)
export const tokenAmount = data => u64At(data, 64)

/** Simulate without signatures and return the watched accounts before and after. */
export async function simulate(connection, tx, watch = []) {
  const before = watch.length ? await connection.getMultipleAccountsInfo(watch) : []
  const { value } = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    ...(watch.length ? { accounts: { encoding: 'base64', addresses: watch.map(w => w.toBase58()) } } : {}),
  })
  const after = (value.accounts ?? []).map(a => a ? Buffer.from(a.data[0], 'base64') : null)
  return { err: value.err, logs: value.logs ?? [], unitsConsumed: value.unitsConsumed, before: before.map(a => a?.data ?? null), after }
}
