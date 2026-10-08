# Aggregator.ag — swaps and liquidity operations

Built on the Fill.city/Mango Autobahn router, with direct recursive DBC routing, a verified LST bridge, V1 transaction construction, and a unified initialize/add/remove engine for eight AMM adapters. Upstream attribution and original documentation follow below.

## Mainnet execution receipts

These are actual funded Solana mainnet transactions, not simulation signatures. Every one of the eight LP venues now has a confirmed add and remove on mainnet; PumpSwap, Meteora DAMM v1 and DAMM v2 also have a confirmed pool initialize. All receipts were quoted and built through the FTL HTTP API → Rust router HTTP API (deployed at `liquidityxyz-router.fly.dev`) → LiquidityEngine, signed by the sample wallet `331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth`, and broadcast through the FTL RPC proxy. The FTL HTTP service ran on the development host; the browser-wallet signing flow is still not covered by these receipts.

| Venue | Operation | Pool | Slot | Wallet debit (SOL) | Confirmed mainnet transaction |
| --- | --- | --- | --- | --- | --- |
| PumpSwap | initialize | `7GZHLdhv…` | 454423617 | 0.007693220 | https://solscan.io/tx/3P43McddpWKZCJXYddYonUoyDvXVAW8BBciCrj7ghhC6vCTi6XjkSjXVdHDMMzTrjhkuNvVLjxn8z7PEN4vTEP4w |
| PumpSwap | add | `7GZHLdhv…` | 454423729 | 0.000098620 | https://solscan.io/tx/4ekNaABGkatd7B63bobqnNvMwYPFWbSKrSWoVTzda7KmMNeuyBNnSbpdhQMdSqgTWrx2NevD3Jg8Q5ER5VRmWmM9 |
| PumpSwap | remove | `7GZHLdhv…` | 454424292 | 0.000002292 | https://solscan.io/tx/3CmW7kY9DyJ9kuNBLnaUxtaCTmRLSocCrh22bdMPb1gwJw99HBZ7xWk4G7ZTjeV5gHXEiYYW2VQN96y2gaVnLC2s |
| Meteora DAMM v1 | initialize | `2E15yqhc…` | 454425275 | 0.038710680 | https://solscan.io/tx/3vvzRPMNn2dfwdACMAX67A8gDF2MLxnnBq9fXWn8xsZHAHXpd4Jy8vmDMCHiajF8xHCjKTe6iD3aqKPxDqEkBdet |
| Meteora DAMM v1 | add | `2E15yqhc…` | 454425592 | 0.000000000 | https://solscan.io/tx/E7LZQwwU7bPW7H9csyobrMagGY82dDkRAsbcFj9Y4krrMZ7X3cLzybik4CGgAX8cW4YphY7sjzM6XYijUCUufhp |
| Meteora DAMM v1 | remove | `2E15yqhc…` | 454425658 | 0.000000000 | https://solscan.io/tx/2aAm8MsD9hSTqhBqFAaQnLxa619dBt7Je3oqo9wpRBnCoEmNLDBXy8icvJrtzNUeTRJvn7ZbVjfiJJf61GnwCmbn |
| Meteora DAMM v2 | initialize | `3Kphxamd…` | 454425777 | 0.018022280 | https://solscan.io/tx/3TPPR2opvQM5JPRCvrwF6NHYrHjK9TUokKwogQUnW61Hv5JxSuqK5VH1YUDQPaFcyBBmrMUkKuQkhxcJSi9K7opV |
| Meteora DAMM v2 | add | `3Kphxamd…` | 454426009 | 0.000000000 | https://solscan.io/tx/WawyHaxUa8Zf6k54EHNxdRe47oMvVsEg8Lke5cWnV4UNtYhfERKQPHRG9t9yanHZmyZ6mynGU9Qc5ttzJcFmH76 |
| Meteora DAMM v2 | remove | `3Kphxamd…` | 454426260 | 0.000000000 | https://solscan.io/tx/5JH6auTBVZHrWqXSYjUyHYp1FnhAZg8P94GWXVUCBejqeDBdf6o3ok9wxpFn93B7ai1JPK73Ag5YVRJJFxAp5eNh |
| Meteora DLMM | add | `GNY3YbGq…` | 454426515 | 0.041923840 | https://solscan.io/tx/2yFMC7giC2pzqRspLgRAjJCEtsHyMM25XpUdwCe1X6njL3DupiQx83ebX5Xkvzide5W5hRVJmfErNLPbuXHTK6iZ |
| Meteora DLMM | remove | `GNY3YbGq…` | 454427339 | 0.000019000 | https://solscan.io/tx/5gavtNchoPrrkGhXyGGZrd7M5F1kWVTYxxcN6NED4fobaSpHGJBzgCsEJFDRfPjPQchA1n3WjZYoPigh1VcFrmia |
| Raydium CPMM | add | `fAjTnZ9Q…` | 454427826 | 0.003004507 | https://solscan.io/tx/5HW9L8YdEKaoKPSGPfsW98nnDV3SBYXmzmKypGuFseXreh4Up6HTtueU2pbCE5ZfF9haCsCg6y1VtCxVQYGjT3sY |
| Raydium CPMM | remove | `fAjTnZ9Q…` | 454428165 | 0.000019000 | https://solscan.io/tx/2ZeWUc2NeL5sQu4fBNsNGdfzMVh4wFsYuuW2PzUvPsPkjnGxpHQ17GDHdZaS3JoiaZqkeEsYevUFTqb4QEus5LFn |
| Raydium AMM v4 | add | `S2MiN5qm…` | 454428841 | 0.001520970 | https://solscan.io/tx/CSeUaG2PAktvs9jstogBbYaDgUwPJNtm3jrjtR3MCXGVqNtoWUXZotvL7MVDEBMSSwdyq8iycL5HkEHLd2n2BM4 |
| Raydium AMM v4 | remove | `S2MiN5qm…` | 454430461 | 0.000019000 | https://solscan.io/tx/63U3CynyVKiNoTu7WHqj4h7S3cqVD5ERVhka84cUdjFXhJsmcyuK2d26nYWxF42uasdq2rEDb8frnArxC5BVd7cU |
| Raydium CLMM | add | `2JtkunkY…` | 454430485 | 0.004682180 | https://solscan.io/tx/6VGE5gUD8odZSdCzjp1aDzQhRBDibisBj1zrECmdi5DXHYgxtzCgMUdjs58jTTEj7HzzMB8tivkezxrTHZAFUGV |
| Raydium CLMM | remove | `2JtkunkY…` | 454430563 | 0.000019000 | https://solscan.io/tx/4gSDtvStxSaqVVnfbHMEMWXVZCBTs9nVNpfWXHnFqx9HfKWS13baRWR21J9RBn4ibRodqTvLAoqxwhLz89yCkDR8 |
| Orca Whirlpools | add | `21gTfxAn…` | 454430519 | 0.006546142 | https://solscan.io/tx/2r5ViD4DLBRD5LabddNCvubr587NmL4e1dgQfucdajXDcobspnkqFNt579e5wBt7QAjeZzsFKUv1GSuUo8QtBzEp |
| Orca Whirlpools | remove | `21gTfxAn…` | 454430606 | 0.000015379 | https://solscan.io/tx/NwTDGCp4BkDFxzp3YR46YF1ibbdSyEkuAG6wNLhhZiB87UPaUg6vMyXQhg7gGGB7jR4ACUoar1FKuFBY6RugkT5 |

Total wallet debit across all 19 LP receipts (including rent that the removes do not refund): 0.122296110 SOL. Pool creation on Raydium CPMM and AMM v4 costs 0.15 SOL each, so those venues and DLMM, CLMM and Orca used existing public SOL/USDC pools instead of new ones; the deposits were micro-sized and withdrawn in full.

Pools used:
- PumpSwap: `7GZHLdhvZN1NSutNt1BJs5S9ArBobAdCvyGzwPo22LHA`
- Meteora DAMM v1: `2E15yqhc8jBGpWfCXZjibB2qj7EDjp5A4x8NSk4363jd`
- Meteora DAMM v2: `3KphxamdB1apYohQStGATZrKGpk7Yf31G9H18Gpp8He7`
- Meteora DLMM: `GNY3YbGqdhZv8R3kD2NRJQ4NLD6tb3PPthJ2mpUR89Lc`
- Raydium CPMM: `fAjTnZ9QqJkUmrr8cXutkYhpVge2qqtSZNt9qKn7YC2`
- Raydium AMM v4: `S2MiN5qmiRS8HBQMXcdJUhLwrBgX9P3naDuo4GkQ63t`
- Raydium CLMM: `2JtkunkYCRbe5YZuGU6kLFmNwN22Ba1pCicHoqW5Eqja`
- Orca Whirlpools: `21gTfxAnhUDjJGZJDkTXctGFKT8TeiXx6pN1CEg9K1uW`

Plain-text links:

```text
PumpSwap initialize: https://solscan.io/tx/3P43McddpWKZCJXYddYonUoyDvXVAW8BBciCrj7ghhC6vCTi6XjkSjXVdHDMMzTrjhkuNvVLjxn8z7PEN4vTEP4w
PumpSwap add: https://solscan.io/tx/4ekNaABGkatd7B63bobqnNvMwYPFWbSKrSWoVTzda7KmMNeuyBNnSbpdhQMdSqgTWrx2NevD3Jg8Q5ER5VRmWmM9
PumpSwap remove: https://solscan.io/tx/3CmW7kY9DyJ9kuNBLnaUxtaCTmRLSocCrh22bdMPb1gwJw99HBZ7xWk4G7ZTjeV5gHXEiYYW2VQN96y2gaVnLC2s
Meteora DAMM v1 initialize: https://solscan.io/tx/3vvzRPMNn2dfwdACMAX67A8gDF2MLxnnBq9fXWn8xsZHAHXpd4Jy8vmDMCHiajF8xHCjKTe6iD3aqKPxDqEkBdet
Meteora DAMM v1 add: https://solscan.io/tx/E7LZQwwU7bPW7H9csyobrMagGY82dDkRAsbcFj9Y4krrMZ7X3cLzybik4CGgAX8cW4YphY7sjzM6XYijUCUufhp
Meteora DAMM v1 remove: https://solscan.io/tx/2aAm8MsD9hSTqhBqFAaQnLxa619dBt7Je3oqo9wpRBnCoEmNLDBXy8icvJrtzNUeTRJvn7ZbVjfiJJf61GnwCmbn
Meteora DAMM v2 initialize: https://solscan.io/tx/3TPPR2opvQM5JPRCvrwF6NHYrHjK9TUokKwogQUnW61Hv5JxSuqK5VH1YUDQPaFcyBBmrMUkKuQkhxcJSi9K7opV
Meteora DAMM v2 add: https://solscan.io/tx/WawyHaxUa8Zf6k54EHNxdRe47oMvVsEg8Lke5cWnV4UNtYhfERKQPHRG9t9yanHZmyZ6mynGU9Qc5ttzJcFmH76
Meteora DAMM v2 remove: https://solscan.io/tx/5JH6auTBVZHrWqXSYjUyHYp1FnhAZg8P94GWXVUCBejqeDBdf6o3ok9wxpFn93B7ai1JPK73Ag5YVRJJFxAp5eNh
Meteora DLMM add: https://solscan.io/tx/2yFMC7giC2pzqRspLgRAjJCEtsHyMM25XpUdwCe1X6njL3DupiQx83ebX5Xkvzide5W5hRVJmfErNLPbuXHTK6iZ
Meteora DLMM remove: https://solscan.io/tx/5gavtNchoPrrkGhXyGGZrd7M5F1kWVTYxxcN6NED4fobaSpHGJBzgCsEJFDRfPjPQchA1n3WjZYoPigh1VcFrmia
Raydium CPMM add: https://solscan.io/tx/5HW9L8YdEKaoKPSGPfsW98nnDV3SBYXmzmKypGuFseXreh4Up6HTtueU2pbCE5ZfF9haCsCg6y1VtCxVQYGjT3sY
Raydium CPMM remove: https://solscan.io/tx/2ZeWUc2NeL5sQu4fBNsNGdfzMVh4wFsYuuW2PzUvPsPkjnGxpHQ17GDHdZaS3JoiaZqkeEsYevUFTqb4QEus5LFn
Raydium AMM v4 add: https://solscan.io/tx/CSeUaG2PAktvs9jstogBbYaDgUwPJNtm3jrjtR3MCXGVqNtoWUXZotvL7MVDEBMSSwdyq8iycL5HkEHLd2n2BM4
Raydium AMM v4 remove: https://solscan.io/tx/63U3CynyVKiNoTu7WHqj4h7S3cqVD5ERVhka84cUdjFXhJsmcyuK2d26nYWxF42uasdq2rEDb8frnArxC5BVd7cU
Raydium CLMM add: https://solscan.io/tx/6VGE5gUD8odZSdCzjp1aDzQhRBDibisBj1zrECmdi5DXHYgxtzCgMUdjs58jTTEj7HzzMB8tivkezxrTHZAFUGV
Raydium CLMM remove: https://solscan.io/tx/4gSDtvStxSaqVVnfbHMEMWXVZCBTs9nVNpfWXHnFqx9HfKWS13baRWR21J9RBn4ibRodqTvLAoqxwhLz89yCkDR8
Orca Whirlpools add: https://solscan.io/tx/2r5ViD4DLBRD5LabddNCvubr587NmL4e1dgQfucdajXDcobspnkqFNt579e5wBt7QAjeZzsFKUv1GSuUo8QtBzEp
Orca Whirlpools remove: https://solscan.io/tx/NwTDGCp4BkDFxzp3YR46YF1ibbdSyEkuAG6wNLhhZiB87UPaUg6vMyXQhg7gGGB7jR4ACUoar1FKuFBY6RugkT5
```

Browser-wallet signing pass (the one step the script receipts could not cover): the owner opened www.liquidityxyz.fun in a browser, connected the sample wallet, quoted a Raydium CLMM add on pool `2JtkunkYCRbe5YZuGU6kLFmNwN22Ba1pCicHoqW5Eqja`, and approved it in the wallet. Confirmed on mainnet:

```text
Raydium CLMM add, signed in the browser: https://solscan.io/tx/VXwJcsc7GMQFrceVckMXWHRx4ZQosUijkUx1pe2H2vQKjMdJQTUpkgeb2DUGwwp1YdUttuxkr7PQfwk45GyqGAA
```

Composed multi-hop swap through the on-chain zap composer ([staccDOTsol/lp-zap](https://github.com/staccDOTsol/lp-zap), program `BHYw1FAWPriW9Gh7BG49X4UVe96CDjaxFrFFUtGSQmRx`): USDC → SOL → BORDR in one transaction, hop 2 sized on chain from hop 1's real output, 10 bps per hop in kind:

```text
Composed 2-hop swap: https://solscan.io/tx/4yosNpvSLK2Sn6SmJbh6M7BxnxYKiBCg7XZMoM2RfHBr2Sn7yxDpvtSHaEiXArC2UtzfZTCCLqX4hLa9fMyME8k2
Composer program deploy: https://solscan.io/tx/2F3dGfz6G9znv4oVdk33T2qHvoXof6WeL8qArBDiufFoAu3MwzVP7CRa2iLCdTXMwJtLJ1uzHSAn463JzLpQk16b
```

[Machine-readable receipts with request, quote, simulation, fees and token balance changes](docs/mainnet-receipts.json).

LST program: `5f7YRhNMtZxAANQQV4B78keMFGiz8gTvAHA4p3Dj3kLp`, deployment https://solscan.io/tx/4hgSvfSyjJi6xEyJpKeKb3HuC2s6XQ5LQV642XwaxQzxWrJ1idyuXtXC8scMmF8atG1UYYjM5N7dgbWC2gMvQ225. [Finalized deployment and binary hash](docs/lst-deployment-mainnet.json), [on-chain bytecode verification](docs/lst-bridge-verification-mainnet.json). Deployment alone does not prove mainnet LST deposit/redemption.

## Verification status

- Eight LP implementations: Raydium CPMM, CLMM, AMM v4; Orca Whirlpools; Meteora DAMM v1, DAMM v2, DLMM; PumpSwap. **All eight have funded mainnet add/remove receipts above.**
- All 24 initialize/add/remove operations also executed successfully under an isolated Agave validator using pinned mainnet program binaries and synthetic balances. [Execution evidence](lib/liquidity-operations/worker/test/svm/verified-lifecycle.json), [reproduction instructions](lib/liquidity-operations/worker/test/svm/README.md).
- Worker regression suite: 36 passed.
- Mainnet initialize receipts exist for PumpSwap, DAMM v1 and DAMM v2 only. Raydium, Orca and DLMM initialize are proven in the local SVM run, not with funded mainnet receipts.
- Automatic adapter admission and full deployed FTL browser verification are not yet established by these receipts.

---

# Fill.city Autobahn

![logo](./brand/autobahn-logo-mark.svg)

Autobahn is the open source aggregator for swaps on Solana.
This public good protocol enables developers to contribute their own DEX adapters.
Take back control: access to orderflow from routers on Solana should not be centralized.

The graph search is optimized for reliability of trade execution.
Reliability is preferred over marginal price to improve user experience.
Full test coverage through daily verification of all routed pools ensures correctness.

A hosted version is available.
Reach out to partnerships@mango.markets to get an access token.
Self-hosting requires custom validator patches to enable low-latency account subscriptions.

## Using the router (as a client)

Basically it is the same API as Jupiter:
`https://autobahn.mngo.cloud/<TOKEN>/`

### quote (GET)

Supported parameters:
- inputMint
- outputMint
- amount
- slippageBps
- maxAccounts
- onlyDirectRoutes

### swap & swap-instructions (POST)

Supported parameters:

- userPublicKey
- wrapAndUnwrapSol
- autoCreateOutAta
- quoteResponse

## Running the router

See example configuration file [example-config.toml](bin/autobahn-router/example-config.toml) to create your own setup

Run like this:

```
RUST_LOG=info router my_config.toml
```

## Creating a new DEX Adapter

Adding new DEX adapter is welcome, you can do a pull-request, it will be appreciated !

See [CreatingAnAdapter.MD](CreatingAnAdapter.MD) file for details.

## Integration testing

It's possible to dump data from mainnet, and then use that in tests:
- To assert quoting is correct (same result as simulated swap)
- To check router path finding perfomance
 
See [Testing.MD](Testing.MD) file for details.

There's a script for daily smoke tests:

```
RPC_HTTP_URL=... ./scripts/smoke-test.sh
```

## Tokio-Console

Build router with feature `tokio-console` and `RUSTFLAGS="--cfg tokio_unstable"` like this:

```RUSTFLAGS="--cfg tokio_unstable" cargo build --bin router --release --features tokio-console```

And use the `tokio-console` crate to display running tasks

## License

Autobahn is published under GNU Affero General Public License v3.0.
In case you are interested in an alternative license please reach out to partnerships@mango.markets
