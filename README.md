# Aggregator.ag — swaps and liquidity operations

Built on the Fill.city/Mango Autobahn router, with direct recursive DBC routing, a verified LST bridge, V1 transaction construction, and a unified initialize/add/remove engine for eight AMM adapters. Upstream attribution and original documentation follow below.

## Mainnet execution receipts

These are actual funded Solana mainnet transactions, not simulation signatures. The first PumpSwap initialize and add were quoted/requoted/built through the production LiquidityEngine and broadcast by a test wallet runner. Remove additionally passed through the FTL HTTP API, Rust router HTTP API, and FTL signed-transaction broadcast proxy. The HTTP services for this verification ran on the development host; this is not yet proof of the deployed browser flow.

| Action | Confirmed mainnet transaction |
| --- | --- |
| PumpSwap initialize | [3P43Mcdd…](https://solscan.io/tx/3P43McddpWKZCJXYddYonUoyDvXVAW8BBciCrj7ghhC6vCTi6XjkSjXVdHDMMzTrjhkuNvVLjxn8z7PEN4vTEP4w) |
| PumpSwap add liquidity | [4ekNaABG…](https://solscan.io/tx/4ekNaABGkatd7B63bobqnNvMwYPFWbSKrSWoVTzda7KmMNeuyBNnSbpdhQMdSqgTWrx2NevD3Jg8Q5ER5VRmWmM9) |
| PumpSwap remove liquidity | [3CmW7kY9…](https://solscan.io/tx/3CmW7kY9DyJ9kuNBLnaUxtaCTmRLSocCrh22bdMPb1gwJw99HBZ7xWk4G7ZTjeV5gHXEiYYW2VQN96y2gaVnLC2s) |
| LST bridge deployment (separate from LP lifecycle) | [4hgSvfSy…](https://solscan.io/tx/4hgSvfSyjJi6xEyJpKeKb3HuC2s6XQ5LQV642XwaxQzxWrJ1idyuXtXC8scMmF8atG1UYYjM5N7dgbWC2gMvQ225) |

PumpSwap lifecycle pool: `7GZHLdhvZN1NSutNt1BJs5S9ArBobAdCvyGzwPo22LHA`. The three LP transactions consumed 0.007794132 SOL net across their wallet debits, including account rent. A small amount of initial liquidity remains permanently locked by the native protocol. [Machine-readable receipts, reviewed bounds and token balances](docs/mainnet-receipts.json).

LST program: `5f7YRhNMtZxAANQQV4B78keMFGiz8gTvAHA4p3Dj3kLp`. [Finalized deployment and binary hash](docs/lst-deployment-mainnet.json). Deployment alone does not prove mainnet LST deposit/redemption.

## Verification status

- Eight LP implementations: Raydium CPMM, CLMM, AMM v4; Orca Whirlpools; Meteora DAMM v1, DAMM v2, DLMM; PumpSwap.
- All 24 initialize/add/remove operations executed successfully under an isolated Agave validator using pinned mainnet program binaries and synthetic balances. [Execution evidence](lib/liquidity-operations/worker/test/svm/verified-lifecycle.json), [reproduction instructions](lib/liquidity-operations/worker/test/svm/README.md). These are separate from the mainnet receipts above.
- Worker regression suite: 34 passed. Mainnet coverage for the other seven venue lifecycles is still being gathered; eight implementations does not mean eight mainnet-verified lifecycles.
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
