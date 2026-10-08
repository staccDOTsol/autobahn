# Meteora DBC adapter

`MeteoraDbcDex` discovers both directions of each standard Meteora VirtualPool,
including pools quoted in another prebond token. Quotes consume atomic token
amounts; they never require a USD price or an allowlist of quote mints.

The persistent local Node worker uses **@meteora-ag/dynamic-bonding-curve-sdk
1.5.12**, pinned with npm integrity hashes in `worker/package-lock.json`. It
uses the official MIT SDK's account coder, exact-input/exact-output quote math,
and Anchor `swap2` instruction builder. It performs no RPC calls and holds no
keys. The noncommercial Rust program source is not copied or linked.

Source: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk

Upstream license: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/LICENSE

## Runtime and discovery

Install Node 22+ and run `npm ci --ignore-scripts --prefix
lib/dex-meteora-dbc/worker`. Deploy the complete worker directory including its
production dependencies. Set `DBC_WORKER_PATH` to the absolute `worker.mjs`
location when the repository is not present at its build-time path. Options
`worker_path` and `node_path` override these defaults.

`base_mints` accepts comma-separated input/output mint addresses. Discovery
queries the on-chain VirtualPool discriminator and base-mint field, then walks
each discovered quote mint's parent pools. Breadth-first traversal detects cycles,
deduplicates shared parents, and caps parent depth at 32 independently for the
watched roots. A separate 4,096 distinct-mint budget bounds total discovery RPC
work; 1,024 shallow watched roots therefore do not consume recursion depth.
Exceeding either bound returns an explicit error. `pools` accepts explicit pool addresses for captured replay tests.
Without either option, initialization discovers the complete VirtualPool
directory. Pool decoding and config RPC reads are batched. The router's dynamic
discovery mode must refresh the adapter when new mints/pools are requested;
the legacy feed graph only registers edges at initialization.

Each loaded edge checks real pool/config owners, current on-chain activation,
graduation, mint program ownership, and vault mint/authority/frozen state. A
quote that cannot fill the complete amount fails. SPL Token and supported
Token2022 metadata/zero-fee mints are accepted. Transfer-hook pools and other
unsupported Token2022 extensions fail explicitly. There is no fallback to spot
prices, partial fills, or a different venue. Quote worker failures time out in
five seconds and restart the process before any subsequent request.

The swap instruction is exact-input with its input amount at offset 8, allowing
the executor to feed the previous hop's actual output into the next prebond
curve. The router enforces the final minimum output, and refreshes route quotes
before building transactions. Exact-output route selection uses the official
inverse quote and is executed with the freshly required input amount.

## Verification

- `npm test --prefix lib/dex-meteora-dbc/worker`
- `cargo test --locked -p dex-meteora-dbc`
- `cargo test --locked -p autobahn-router fresh_quote_tests --lib`

`worker/test/bread-mainnet.json` contains only public confirmed account data
captured at slot 454312635. Golden quotes cover BREAD/CRUMBS in both directions,
fees, price impact, inverse quotes, and swap instruction serialization. The
recursive child test deliberately changes fixture identities and is labeled
synthetic; it does not claim a second on-chain pool exists. These offline tests
do not replace the separate admission gate's on-chain-program replay.
