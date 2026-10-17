# Router fee: 0.1% of every swap, bought into FR28 and burned

Every swap the Rust router builds (`/quote`, `/swap`, `/swap-instructions`) now carries a 10 bps platform fee ([`platform_fee.rs`](../../bin/autobahn-router/src/platform_fee.rs)). This crank converts the collected fees into [`Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump`](https://solscan.io/token/Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump) (FR28) and burns it.

## Where fees go

Fee owner: `Gp6tbJ5pLZfez5xGG42tCqvzf37AdUELyo9amS8mTLdz`. It is a dedicated keypair generated for this, kept at `~/.config/aggregator-ag/fee-burner.json` on the development host. It is not in the repository. **It must hold nothing but fees:** the crank turns every token balance it owns into FR28 and burns it. Do not reuse a wallet with other holdings. The key `WzMaL78…` is refused everywhere.

Each fee mint gets its own fee account: the fee owner's associated token account for that mint, under the mint's own token program. The swap creates the account idempotently, so the first swapper of a new fee mint pays its rent once.

| Fee mint | Fee account |
| --- | --- |
| wSOL | `EnFtWthp647ScjVTuTSvfjRRxTfpxbnHKp9E6Sd3qVtc` |
| USDC | `1aJbv1kq8UyZ8ibU4HRtGtdX1ESni8Ki8qqtxxtpKkn` |
| USDT | `Fim9XWKvhMcnChnm9ibj5xjchL8CjuU8kiSm8iRDCDCu` |
| FR28 (Token-2022, the crank's buy output) | `EWJjhGKQsuVKQvTNpmWDHigoZqd5KmDhF6c25ec7mKLV` |

## How the fee is charged

- **Side.** Exact-in swaps pay on the output when only the output is SOL, USDC or USDT. Every other swap pays on the input: SOL or a stablecoin in, token to token, and all exact-out swaps. So fees collect mostly in deep markets. The side depends only on the two mints, never on client input.
- **Amounts.** An input fee is 10 bps of the user's gross input, rounded down. The hops route the remaining 99.9%. An exact-out fee is added on top so it is 10 bps of the total. An output fee is 10 bps of the freshly re-quoted output. The executor's minimum becomes the user's minimum plus the fee.
- **Quotes show what users actually spend and receive.** `inAmount` is the gross input. `outAmount` and `otherAmountThreshold` are net of the fee. `platformFee` is `{amount, feeBps: 10, feeMint}`.
- **Instructions.** Classic SPL fees use the Autobahn executor's `ChargeFees` (program `AutobNFLMz…`, unchanged), which emits a `PlatformFeeLog`. The deployed executor's `ChargeFeesV2` is broken on mainnet: its CPI omits the authority and mint, and simulation fails with `MissingAccount` for both token programs. So Token-2022 fees are a direct `TransferChecked` into the Token-2022 fee account. The executor was not redeployed or forked.
- **Placement.** An input fee goes after any SOL wrap and before the swap. An output fee goes after the swap and before a wSOL unwrap closes the account.
- **Tamper resistance.** `/swap` and `/swap-instructions` re-derive the fee and the hop amounts from the quote's gross amounts and the fresh route. They ignore the client's `platformFee` and edited hop amounts (see `a_client_cannot_edit_the_fee_out_of_its_quote`).
- **Dust.** Swaps below 1,000 base units round to a zero fee and get no fee instructions.

## The crank

```sh
npm ci --ignore-scripts
node fee-burn.mjs                                   # simulate every leg for the fee owner
node fee-burn.mjs --keypair ~/.config/aggregator-ag/fee-burner.json --send
```

1. **Sell legs.** Each balance that is not wSOL or FR28 is quoted and built into wSOL through the router (`/quote` → `/swap`, `wrapAndUnwrapSol: false`), one transaction per mint.
2. **Buy and burn.** The wSOL balance buys FR28 on its canonical PumpSwap pool [`UQ72Gxev…`](https://solscan.io/account/UQ72Gxevtr85KPeQQw8isvMqxR2k627T5rZbRD57NnJ). FR28's pump.fun bonding curve `Fq52Enfn…` is complete, so it no longer trades there. The buy uses `buy_exact_quote_in_v2`, which spends exactly the fee balance. The same transaction Token-2022 `burnChecked`s the FR28 already held plus the buy's slippage minimum. FR28 bought above the minimum is burned by the next run, and FR28 left with no wSOL to spend gets a burn-only transaction.
3. **Skipping.** A leg is skipped when its value is at most its own network fee (signature plus priority fee, plus the FR28 account's rent on the first buy). `--min-lamports` raises the floor.

The Rust router has no PumpSwap swap edge, and the deployed router returns "No executable route" for SOL→FR28. That is why the FR28 leg is built with the pinned official `@pump-fun/pump-swap-sdk` (the version the router's liquidity worker uses), not through `/swap`. The SDK wraps native SOL into the wSOL account and closes it afterwards. The crank removes those instructions because that account is the wSOL fee account.

### Not permissionless yet

The fee accounts belong to a keypair, so only its holder can run the crank. A crank that anyone could run needs the fee accounts owned by an on-chain program's PDA that only allows swap-to-FR28-and-burn. That means deploying a new program, which this change does not do.

## Evidence (mainnet state, simulation only, slot ≈458,105,000, 2026-10-17)

Nothing was signed or sent. Each run below is reproducible with the command shown.

- Executor fee instructions: `ChargeFees` with a fresh fee account works (3,704 CU, `PlatformFeeLog` emitted). `ChargeFeesV2` fails with `MissingAccount` for USDC and FR28.
- `node verify-router-fee.mjs --wallet 331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth --emulate`: a real SOL→USDC route from the deployed (pre-fee) router plus the fee leg as `platform_fee.rs` builds it. The simulation passes (85,921 CU) and the wSOL fee account goes from 0 to 10,000 lamports, 0.1% of 0.01 SOL. After deploying, run it without `--emulate` to check the live router.
- `node fee-burn.mjs --simulate-fund 10000000 --simulate-funder 331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth`: the fee owner holds no fees yet, so the simulated transaction wraps 0.01 SOL into its wSOL fee account first. The buy-and-burn passes (91,270 CU). It buys 57,006,192,789 FR28 base units, burns 56,436,130,861, and the FR28 supply falls 949,842,458,823,598 → 949,786,022,692,737.
- The sell leg (USDC→wSOL through the deployed router) and the burn-only leg also pass simulation against the sample wallet's own balances (`--owner 331n… --allow-other-owner --mint …`).
