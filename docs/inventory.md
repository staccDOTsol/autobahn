# Router inventory — 2026-10-07

This checkout is `/Users/stacc/aggregator-ag`, isolated from the user's existing apps. Base: `staccDOTsol/autobahn` commit `b8e81adde677745630c30cb08e297ba40260036f` (AGPL-3.0). The user authorized publication; the router repository is now public on `main`.

## Existing implementations

| Source | Reusable implementation | Evidence and limitations |
| --- | --- | --- |
| `staccDOTsol/autobahn` | Rust route graph, account refresh, route cache, quote/swap/swap-instructions API, atomic CPI executor, ALT optimizer; Orca, Raydium CPMM/AMM v4, Saber, OpenBook, Invariant, Infinity adapters | Actual code in this checkout. Startup-only discovery and observational swap repricing need correction. Pinned 2024 dependencies need current-toolchain repairs. No claim of a live new deployment. |
| `staccDOTsol/Web3-DEX-Router-Solana-V1` | MIT on-chain executor with roughly 50 venue CPI adapters, including Meteora DBC | Actual instruction builders, not an off-chain quotation/discovery engine. Preserve ABI/provenance when using. No existing CI runs found. |
| `/Users/stacc/solana-liquidity-engine` at `50c64119edebbb8c72d0ddceb4ee1f25e2d673ca` | Permissionless SPL/Sanctum LST quotes, deposit/redemption, WSOL bridge, S controller, liquidity mint/burn | Historical tracked files are staged deletions in original checkout; do not restore over eat.ag work. Original engine declares Apache-2.0. S/Sanctum vendored licensing must be resolved separately. S pool documented uninitialized on mainnet. |
| `staccDOTsol/permissionless-lst` | S pool fork, exact swaps, LP entry/exit, Token-2022 fee handling, Jupiter interface ~0.4 | Native adapter source exists, but no root license found; controller/pool deployment not established. No assumption of Jupiter acceptance. |
| Current `/Users/stacc/solana-liquidity-engine` | eat.ag cook/uncook and Orca liquidity discovery, add/remove, quote and simulation | Real builders. Transfer-hook mints explicitly unsupported. Fly app `eat-ag`; current tests not yet rerun here. |
| `/Users/stacc/cpmm-index-composer` | Recursive LP quote, prepareDeposit and prepareWithdraw | Real separate-transaction planners, not an integrated route graph. Untracked source; GPL SDK dependency; own licensing unspecified. |
| `/Users/stacc/tape/anyquote/scaffolds/anyquote` | QuoteFun direct DBC quote/build; recursive DBC display prices | Real chain reads and official SDK 1.5.12. Display-price multiplication is **not executable multihop quoting**. |
| Existing Composer service, historical `the-composer.fly.dev` | Program learning (`/learn`), IDL-backed account discovery, instruction/batch construction and intent-to-simulated-plan service | Recovered September 2026 x402/Bazaar registration and caller evidence in the private gateway repository. Historically shipped; current hostname/source recovery remains unresolved. This is the distinct service initially missed by the inventory. See [Composer recovery evidence](composer-service-inventory.md). |
| `/Users/stacc/break-solana-chat/x402-tokens` | Real paid inference gateway (OpenAI/Anthropic-compatible), payment validation and settlement; preserves Composer registration/callers | Private MIT repo. Gateway implementation is not the Composer implementation. Live availability not established by the initial inventory. Reuse as a configured transport, not copied private code. |
| `/Users/stacc/break-solana-chat/infinitesimal` | `src/liquidity-monster/pump-swap.mjs`: direct prebond Pump SOL exact-input quote/build using the official SDK; `orca.mjs`: actual Whirlpool full-range LP planning; `tx.mjs`: simulation and signed-transaction checks | MIT parent repository. Imported into the main server, with focused tests. Uses Jupiter for other swaps; not a general recursive venue graph. Fly configuration is `infinitesimal-router` / `deadcat.fun`, a single-ledger AI/x402 service that must not be overwritten. Its `compare-minirouter.mjs` compares AI model prices, and parent `inference/` implements neural inference rather than IDL inference. Current tests and live transaction behavior were not rerun during inventory. |
| `staccDOTsol/openai-idl-generat00r` | Solana program dump and model-driven IDL proposal CLI | Sends only 100 binary bytes, validates only JSON. Cannot admit trading adapters without semantic/execution checks. No license identified. |
| `staccDOTsol/solana-idl-ai-agent-openai-interface` | IDL cache and instruction API | Contains fake Token/ATA IDLs and incomplete transaction fields. Not eligible as an execution adapter. |
| `/Users/stacc/aggregator` | EVM operation dispatcher, cached quote/requote, bridge/fee/vault/NFT operation planners | Existing separate EVM app, not overwritten. No Git remote or Solana route graph found. |
| `/Users/stacc/routing-api`, `routing-api-venues` | Uniswap SOR fork, hot-route requoting, EVM operation modules | GPL-3.0. New venue modules untracked/unwired; CDK still points at upstream Uniswap. Not Solana adapters. |
| `/Users/stacc/plague/ops/okx-router-probe.mjs` | OKX unsigned transaction and simulation probe | Documents missing transfer-hook accounts on an Orca route. Not an executable quoting adapter. |
| `staccDOTsol/another_mango_blender`, `notmango` | Mango/perps frontends and upstream Jupiter consumers | Not router implementations. |
| `/Users/stacc/stakeplusplus`, `ogwp`, `wp2`, `tape` | Stake program / Orca / storage infrastructure | No additional complete router found. Local Orca license changes mean copying arbitrary current source as Apache would be incorrect. |

## Admission requirements

All venue operations are directed token edges, including LP mint/redeem and native staking through a verified token-account bridge. A quote must use the actual input amount and current account state. An execution route propagates actual proceeds between CPIs and enforces the user's final minimum output.

An inferred IDL is an untrusted proposal. It does not establish the program's economic behavior, account requirements, or ABI correctness. Compilation, independent SVM replay against pinned program bytes, balance-delta assertions, malformed-state tests, and full router/executor tests must pass before automatic admission.

The target is CI-only adapter admission, exact-SHA merge, and deployment without human review. Inventory findings are not statements that this target is already live.

## Subsequent evidence

The initial inventory has since been extended by the [dated provenance timeline](PROVENANCE.md), [Composer recovery inventory](composer-service-inventory.md), [new LST deployment receipt](lst-deployment-mainnet.json), and [funded mainnet operation receipts](mainnet-receipts.json). In particular, the old LST bridge's missing ProgramData observation does not describe the newly deployed bridge: the new executable exists, while activation/conversion proof remains separate.
