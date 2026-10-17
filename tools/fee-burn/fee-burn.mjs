#!/usr/bin/env node
// Sweep the router's fee balances into FR28 and burn it.
//
//   node fee-burn.mjs                       simulate every leg for the fee owner (default)
//   node fee-burn.mjs --keypair <path> --send
//                                           sign as the fee owner and send each leg
//
// Options:
//   --rpc <url>                    RPC endpoint (RPC_URL, else public mainnet)
//   --router <url>                 router for non-SOL balances (ROUTER_URL, else liquidityxyz-router.fly.dev)
//   --owner <pubkey>               fee owner to simulate for (default: the router's FEE_OWNER)
//   --keypair <path>               fee owner keypair; required with --send
//   --mint <pubkey>                only process these mints (repeatable)
//   --slippage-bps <n>             default 100
//   --priority-micro-lamports <n>  default 10000
//   --min-lamports <n>             skip legs worth at most this; default: the leg's network fee
//   --simulate-fund <lamports> --simulate-funder <pubkey>
//                                  simulation only: wrap this much SOL into the owner's wSOL fee
//                                  account inside the simulated buy-and-burn, paid by the funder
//   --allow-other-owner            run for an owner other than FEE_OWNER (it must hold only fees)
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  BUY_BURN_COMPUTE_UNITS, DEFAULT_MICRO_LAMPORTS, FEE_OWNER, FR28, buyAndBurn, burnOnly, compile, computeBudget,
  feeBalances, fr28ValueLamports, mintSupply, networkFeeLamports, plan, refuseCompromised, routerSell, simulate, simulatedFunding,
  tokenAmount,
} from './lib.mjs'

const BURN_COMPUTE_UNITS = 20_000

const { values: args } = parseArgs({
  options: {
    rpc: { type: 'string' }, router: { type: 'string' }, owner: { type: 'string' }, keypair: { type: 'string' },
    mint: { type: 'string', multiple: true }, 'slippage-bps': { type: 'string' }, 'priority-micro-lamports': { type: 'string' },
    'min-lamports': { type: 'string' }, 'simulate-fund': { type: 'string' }, 'simulate-funder': { type: 'string' },
    send: { type: 'boolean' }, 'allow-other-owner': { type: 'boolean' },
  },
})

const connection = new Connection(args.rpc ?? process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
const routerUrl = args.router ?? process.env.ROUTER_URL ?? 'https://liquidityxyz-router.fly.dev'
const keypair = args.keypair ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, 'utf8')))) : null
const owner = keypair?.publicKey ?? new PublicKey(args.owner ?? FEE_OWNER)
const slippageBps = Number(args['slippage-bps'] ?? 100)
const microLamports = Number(args['priority-micro-lamports'] ?? DEFAULT_MICRO_LAMPORTS)
const minLamports = args['min-lamports'] === undefined ? null : BigInt(args['min-lamports'])
const simulateFund = args['simulate-fund'] === undefined ? 0n : BigInt(args['simulate-fund'])
const funder = args['simulate-funder'] ? new PublicKey(args['simulate-funder']) : null

refuseCompromised(owner, funder)
if (args.send && !keypair) throw new Error('--send needs the fee owner --keypair')
if (args.send && simulateFund) throw new Error('--simulate-fund is simulation only')
if (simulateFund && !funder) throw new Error('--simulate-fund needs --simulate-funder')
if (args.owner && keypair && !keypair.publicKey.equals(new PublicKey(args.owner))) throw new Error('--owner does not match --keypair')
if (!owner.equals(FEE_OWNER) && !args['allow-other-owner'])
  throw new Error(`${owner.toBase58()} is not the router fee owner ${FEE_OWNER.toBase58()}; every balance it holds would be burned. Pass --allow-other-owner to proceed.`)
if (!(slippageBps >= 0 && slippageBps < 10_000)) throw new Error('--slippage-bps must be 0..9999')

const mode = args.send ? 'SEND' : 'SIMULATE'
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(9)} SOL`
console.log(`${mode} fee burn for ${owner.toBase58()} via ${routerUrl}`)

async function run(label, tx, watch = []) {
  const result = await simulate(connection, tx, watch)
  console.log(`  ${label}: simulation ${result.err ? `FAILED ${JSON.stringify(result.err)}` : 'ok'}, ${result.unitsConsumed} CU`)
  if (result.err) console.log('    ' + result.logs.slice(-12).join('\n    '))
  if (result.err || !args.send) return result
  tx.sign([keypair])
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 })
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  console.log(`  ${label}: sent ${signature} ${confirmation.value.err ? `FAILED ${JSON.stringify(confirmation.value.err)}` : 'confirmed'}`)
  return { ...result, signature, err: confirmation.value.err }
}

const mints = args.mint?.map(m => new PublicKey(m)) ?? null
let work = plan(await feeBalances(connection, owner), { mints })
console.log(`balances: ${sol(work.wsol)} wSOL, ${work.fr28} FR28 base units, ${work.sells.length} other token(s)`)

// 1. Everything that is not SOL or FR28 goes to wSOL through the router, one transaction each.
for (const balance of work.sells) {
  const label = `sell ${balance.amount} of ${balance.mint.toBase58()}`
  const sale = await routerSell(routerUrl, { owner, mint: balance.mint, amount: balance.amount, slippageBps, microLamports })
  if (sale.skipped) { console.log(`  ${label}: skipped, ${sale.skipped}`); continue }
  const floor = minLamports ?? sale.fee
  if (sale.out <= floor) { console.log(`  ${label}: skipped, worth ${sol(sale.out)} ≤ network fee ${sol(floor)}`); continue }
  console.log(`  ${label}: router quotes ${sol(sale.out)} (min ${sol(BigInt(sale.quote.otherAmountThreshold))})`)
  if (funder) console.log('    (the owner must hold this balance for the simulation to pass)')
  await run(label, sale.tx)
}
if (args.send && work.sells.length) work = plan(await feeBalances(connection, owner), { mints })

// 2. wSOL buys FR28 on PumpSwap and the FR28 is burned in the same transaction.
const spend = work.wsol + simulateFund
const buyFee = networkFeeLamports({ computeUnits: BUY_BURN_COMPUTE_UNITS, microLamports })
const watch = (fr28Account, extra = []) => [FR28, fr28Account, ...extra]
const report = (result, fr28Account) => {
  if (result.err || !result.after.length) return
  const supply = [mintSupply(result.before[0]), mintSupply(result.after[0])]
  console.log(`    FR28 supply ${supply[0]} → ${supply[1]} (burned ${supply[0] - supply[1]} base units)`)
  const held = [result.before[1] ? tokenAmount(result.before[1]) : 0n, result.after[1] ? tokenAmount(result.after[1]) : 0n]
  console.log(`    fee owner FR28 ${fr28Account.toBase58()}: ${held[0]} → ${held[1]}`)
}
if (spend > 0n) {
  const leg = await buyAndBurn(connection, { owner, spend, existingFr28: work.fr28, slippageBps })
  const floor = minLamports ?? buyFee + leg.fr28AccountRent
  if (spend <= floor) {
    console.log(`  buy+burn: skipped, ${sol(spend)} ≤ network fee ${sol(floor)}`)
  } else {
    console.log(`  buy+burn: ${leg.variant} ${sol(spend)} → ≥${leg.minBase} FR28 (expected ${leg.expectedBase}), burn ${leg.burn}`)
    const prelude = simulateFund ? simulatedFunding({ funder, owner, lamports: simulateFund }) : []
    if (simulateFund) console.log(`    simulation funds ${sol(simulateFund)} into ${leg.wsolAccount.toBase58()} from ${funder.toBase58()}`)
    const { blockhash } = await connection.getLatestBlockhash()
    const tx = compile(funder ?? owner, [...computeBudget(BUY_BURN_COMPUTE_UNITS, microLamports), ...prelude, ...leg.instructions], blockhash)
    report(await run('buy+burn', tx, watch(leg.fr28Account, [leg.wsolAccount])), leg.fr28Account)
  }
} else if (work.fr28 > 0n) {
  // FR28 paid as a fee, or left over above a buy's minimum, needs no swap.
  const value = await fr28ValueLamports(connection, work.fr28)
  const floor = minLamports ?? networkFeeLamports({ computeUnits: BURN_COMPUTE_UNITS, microLamports })
  if (value <= floor) {
    console.log(`  burn ${work.fr28} FR28: skipped, worth ${sol(value)} ≤ network fee ${sol(floor)}`)
  } else {
    const leg = burnOnly({ owner, amount: work.fr28 })
    const { blockhash } = await connection.getLatestBlockhash()
    const tx = compile(owner, [...computeBudget(BURN_COMPUTE_UNITS, microLamports), ...leg.instructions], blockhash)
    report(await run(`burn ${work.fr28} FR28 (worth ${sol(value)})`, tx, watch(leg.fr28Account)), leg.fr28Account)
  }
} else {
  console.log('  nothing to buy or burn')
}
