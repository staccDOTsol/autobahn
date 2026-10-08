# Provenance: the router, liquidity operations, FTL and program discovery

Evidence cutoff: **2026-10-08 03:35 UTC / 2026-10-07 23:35 America/Toronto**, including newly published mainnet receipts. Repository and service inventory was performed on October 7, 2026. Later deployments or funded transactions should be appended with their own receipts rather than inferred from this document.

The current release joins several previously separate lines of work: Solana route execution, permissionless LST conversion, EVM quote/requote and operation planning, program/IDL discovery, recursive DBC markets, and FTL's real-time liquidity feed. The new integration makes an observed event actionable through a wallet-bound quote, transaction review, execution and position view. It does not make every historical component newly authored here, nor establish that every older service remains live.

## How to read the evidence

- **Commit date** means the timestamp recorded in Git. It establishes that the recorded implementation existed in that history by that point; it is not necessarily the first invention, deployment, or public announcement date.
- **Repository creation date** is GitHub metadata, not the age of the underlying code or idea.
- **Source/configuration evidence** establishes an implementation or intended deployment. **Historical operational records** establish a past observation. **Current read-only checks** establish only what was observed during this inventory.
- **Mainnet simulation** runs the actual transaction against mainnet state without broadcasting it. **Local SVM execution** runs actual programs and signed transactions in an isolated ledger. Neither is a funded mainnet transaction receipt.
- Public commits are linked. Local-only histories are identified by path and commit. Private repositories are identified only to establish provenance; no private implementation or credentials are reproduced here.
- Dates below use the recorded timezone where it matters. In October, Toronto is UTC−04:00, so the late October 7 integration/testing work is October 8 in UTC.

## Dated lineage

| Date | Recorded iteration | Evidence and attribution |
| --- | --- | --- |
| 2024-09-25 | Fill.city Autobahn public foundation | [Initial public commit `ad94eca`](https://github.com/staccDOTsol/autobahn/commit/ad94eca4bb39c8dd9660c3c607744ced59935dc4), authored by Serge Farny. The inherited README identifies Fill.city Autobahn, `autobahn.mngo.cloud` and Mango contact information. This is upstream work. |
| 2024-12-17 | User's IDL-backed instruction API | Public `solana-idl-ai-agent-openai-interface`, created 13:53:59 UTC; [first commit `a9277ff`](https://github.com/staccDOTsol/solana-idl-ai-agent-openai-interface/commit/a9277ff79422fa20f983685fbb090c2037f2012c) at 13:54:45 UTC and [implementation `1bab276`](https://github.com/staccDOTsol/solana-idl-ai-agent-openai-interface/commit/1bab276f84e40e06a7207430c39c08dde448256c) at 14:27:25 UTC, author `stacc`. |
| 2025-03-12 | Binary-to-IDL generation CLI | Public `openai-idl-generat00r`, created 10:25:54 UTC; [initial `f127139`](https://github.com/staccDOTsol/openai-idl-generat00r/commit/f1271397dd0a2c79177483c60ce30c619461c5ff), then [generation implementation `0768eb5`](https://github.com/staccDOTsol/openai-idl-generat00r/commit/0768eb5b14570f673bfc44839ddd895a1bd95966) at 11:20:37 UTC, author `jarettdunn`. |
| 2025-03-15 | Private `idrsa` reverse-engineering iteration | Repository created 08:32:56 UTC; first commit `90c6c83c21473042802053115425bcbee1f33833` at 08:41:23 UTC, author `jarettdunn`. Inspected source combines known binary/IDL evidence, model-generated IDLs and Binary Ninja/Rust recovery. Private source is not vendored. |
| 2025-04-17 | Autobahn fork with Raydium Launchpad work | User repository created 19:48:36 UTC. [Commit `b8e81ad`](https://github.com/staccDOTsol/autobahn/commit/b8e81adde677745630c30cb08e297ba40260036f), 20:47:31 +01:00, includes a Raydium Launchpad adapter, state processing and instruction building. Its message is only “reorder accounts”; its diff is materially larger. Git author is the placeholder `Your New Name`, so the repository association is verified but personal authorship is not independently established by that field. |
| 2026-09-01 | Composer x402/Bazaar registration and payment callers | Private `x402-tokens` commit `3a9522c7ac990d23f0c91d4d02871da986b8e45e`, 07:33:13 UTC, contains registration/caller evidence for the distinct `the-composer.fly.dev` service. This is the first located repository record, not a claim that the service was invented that day. |
| 2026-09-02 | Composer intent service recorded in OKX.AI registration | Existing private wiki records OpenZoo ASP #11702 and Composer `/intent` as an A2MCP service. Gateway source records the x402 v2 `PAYMENT-REQUIRED` header correction that made Composer Bazaar-listed. These are historical internal records. |
| 2026-09-09 | Composer settlement update; Infity engine baseline | Private Composer registration update `76141414685c96de3de1feb75e6225a9a6e9bdb0` at 09:17:41 UTC. Separately, local `solana-liquidity-engine` commit `7eb1d02f1a2fde63f676e24f5371048e0cb8211e` at 23:55:28 Toronto builds Infity, Token-2022 LST treasury and operator app. Its README explicitly scopes that baseline to local tests/simulation, with no public deployment, LP manager or router yet. |
| 2026-09-10 | Infity → Pyrodrome → WEALLEAT iterations | Local commits `d3adcb9` at 01:01 Toronto (mainnet/mobile design and exact LST fees), `e42853d` at 10:27 (Get LST / Earn / Claim), and `43a4b71` at 12:13 (WEALLEAT and optional liquidity). Details below distinguish the user integration from Sanctum and Orca upstream code. |
| 2026-09-11 | Permissionless LST/controller/Jupiter-interface work | [User commit `f9dc0a0`](https://github.com/staccDOTsol/permissionless-lst/commit/f9dc0a07a3de9b71c4b7322be85d9e9f6833e82a), 21:40:14 UTC, in the fork of `igneous-labs/S`: permissionless backed-LST routing and Token-2022 fee initialization. Local `c6a1284` at 23:27 Toronto introduces the historical engine's tracked router/client files. |
| 2026-09-11 | OKX executor fork acquired | `Web3-DEX-Router-Solana-V1` fork created 23:15:23 UTC. The inspected history points to upstream [commit `677d3ec`](https://github.com/staccDOTsol/Web3-DEX-Router-Solana-V1/commit/677d3eced859d12629e354eb320ab301710002e5), February 1, 2026, author Pentaclezion. This establishes available executor technology, not authorship of its approximately 50 venue adapters by the user. |
| 2026-09-12 | Historical LST router snapshot later reused as ABI evidence | Local `50c64119edebbb8c72d0ddceb4ee1f25e2d673ca`, 02:16 Toronto. The new stake-pool adapter references exact source hashes from this snapshot; it is not the first router commit. |
| 2026-09-26 | `the-book` repository exists | Public repository creation 20:31:39 UTC. Its signal/plan handling later supplies part of FTL's event interpretation lineage. Creation metadata does not date the original signal ideas. |
| 2026-10-03–04 | Uniswap routing fork becomes a broader EVM route/operation system | Dated user commits add cross-chain quotes, Robinhood chain 4663, Omnipeg buy/claim/teleport/sell planning, Universal Router v2.1/v4 handling and executable quote fixes. A separate local EVM aggregator adds bounded cached quote/requote and solver/funding behavior. Exact iterations below. |
| 2026-10-04 | FTL / Follow The Liquidity → liquidityxyz.fun | Nine local commits between 19:36 and 20:23 Toronto build and harden the Solana/Robinhood firehose, metadata, signal feed, preconfirmation lanes, worker isolation and API domain. This is the event/context foundation, before this release's integrated Solana trade/LP screen. |
| 2026-10-06–07 | Hook-aware launch/liquidity work in `plague` | [User `f97d601`](https://github.com/staccDOTsol/plague/commit/f97d6014c0213553096bd0ee875324a9eb61480c), [wallet fix `0dbaa94`](https://github.com/staccDOTsol/plague/commit/0dbaa944600deb3bc507ba244e8c952ff5fdcd34), [countermint fix `0c25855`](https://github.com/staccDOTsol/plague/commit/0c25855d25c78b35c8948bf8870f89e81bb37c77). Existing proof records include a direct Orca swap and funded LP transaction, as well as an OKX route failure caused by missing hook accounts. |
| 2026-10-07 | Recursive QuoteFun markets and recursive CPMM planning inventoried | QuoteFun direct DBC builders and a separate nested CPMM planner exist locally. Neither local tree gives a trustworthy independent first-authored commit date. The October 7 user request supplies the explicit requirement to route prebond recursion before an external aggregator lists it. |
| 2026-10-07 22:41 Toronto | Permissionless router integration committed | [User `217825a`](https://github.com/staccDOTsol/autobahn/commit/217825addedecbab29d033b51e1b4c9adde2022e): direct DBC adapter/worker, stake-pool bridge client, adapter admission/replay and inference proposal tooling. |
| 2026-10-07 22:58 Toronto | True V1 transactions and discovery/execution repair | [User `b263356`](https://github.com/staccDOTsol/autobahn/commit/b263356e87c0c92adfb6fb7a99021c87b4291895): V1 wire handling, venue discovery fixes and execution CI, alongside initial liquidity worker work. |
| 2026-10-07 23:13 Toronto | Eight liquidity adapter implementations joined to the API | [User `3f43981`](https://github.com/staccDOTsol/autobahn/commit/3f43981f9bff4d88bec0deaedad53747db30edba): capabilities, owner positions, quote-bound initialize/add/remove and V1 build path. |
| 2026-10-07 23:18 Toronto | Deployment memory/discovery bound revision | [User `dcff814`](https://github.com/staccDOTsol/autobahn/commit/dcff814a745ab2402d2cecdb879733d8b73addac). This records configuration and resource sizing work; it is not proof that a deployment subsequently became healthy. |
| 2026-10-07 23:27 Toronto / October 8 03:27 UTC | All eight venue lifecycles executed | [Recorded lifecycle evidence](../lib/liquidity-operations/worker/test/svm/verified-lifecycle.json): 24 initialize/add/remove operations, zero failures, actual mainnet program binaries/configurations in isolated Agave 4.3, actual V1 transactions and balance assertions. Synthetic local balances; not mainnet-funded receipts. |
| By 2026-10-07 23:35 Toronto | Funded PumpSwap lifecycle and new LST program deployment receipts published | [Commit `b8b3a98`](https://github.com/staccDOTsol/autobahn/commit/b8b3a98e22599da0bbd9dc9bf401df9a693449d3) publishes confirmed PumpSwap initialize/add/remove receipts and a finalized new LST program deployment. This is a separate, stronger evidence class than the local 24-action run; exact receipts below. |

## 1. The inherited route engine and the April 2025 iteration

The code now published through `staccDOTsol/autobahn` began as Fill.city Autobahn. Its inherited pieces include the Rust route graph, account ingestion/cache, quote and swap endpoints, route caching, address lookup-table optimization and atomic CPI executor, plus existing venue adapters. Upstream authorship, including Serge Farny and other contributors, remains in Git history. The AGPL-3.0 license and notices remain applicable.

The April 17, 2025 baseline used for this release is not just an empty fork. Despite its short commit message, `b8e81ad` adds approximately 1,212 lines across ten files, including `lib/dex-raydium-launchpad` state, discovery and instruction building. That is a concrete earlier router iteration in the user's repository. The placeholder author field prevents stronger personal-attribution claims from Git alone.

The October 2026 work builds on that engine rather than claiming a new ground-up replacement: dynamic discovery, correct fresh quotes, recursive DBC access, new operation adapters, current transaction encoding and reproducible admission/execution gates. See [inventory](inventory.md), [build toolchain](build-toolchain.md) and [admission protocol](adapter-admission.md).

## 2. The “zero politicking” LST line

Two related histories matter: the local engine/application and the public S-controller fork.

### Local engine → Infity → WEALLEAT/eat.ag

The local repository `~/solana-liquidity-engine` has no configured remote in the inspected checkout. Its dated milestones are:

| Toronto date/time | Commit | Recorded change |
| --- | --- | --- |
| September 9, 23:55 | `7eb1d02f1a2fde63f676e24f5371048e0cb8211e` | Infity engine, Token-2022 LST treasury, Pinocchio allocation, Orca protocol-fee collection, native LP rewards, SDK/keeper/operator UI. The baseline explicitly says local tests/simulation, not a deployed LP router. |
| September 10, 01:01 | `d3adcb9aece1d1643d843b45bf14a0cd68279f9f` | Mainnet/mobile redesign and exact LST fee derivation. |
| September 10, 10:27 | `e42853d411d71f1db463c9d887cc0212e26d55d3` | Pyrodrome flows reduced to Get LST, Earn and Claim. |
| September 10, 12:13 | `43a4b71a06c67d69e5bc5cd39147f42ea61ee760` | WEALLEAT branding, cooking and optional liquidity. |
| September 11, 23:27 | `c6a128459551163505cc5b3effeef647cf9f3e4d` | Permissionless KISS flywheel, live chart, deep-link repairs; first located tracked router/client files. |
| September 12, 02:16 | `50c64119edebbb8c72d0ddceb4ee1f25e2d673ca` | Later saved snapshot used to pin the bridge ABI and source-file hashes. |

The preserved historical interfaces cover `mint_wrapped` / `redeem_wrapped`, backing-ratio quotes, fees, reserve limits and the WSOL/native-staking bridge for SPL Stake Pool, Sanctum SPL and Sanctum SPL Multi. The current eat.ag tree also contains cook/uncook and actual Orca add/remove planning. These are useful existing components; they are not evidence that every historical market is currently routable.

The old workspace declares Apache-2.0. That does not relicense vendored S/Sanctum components. The new AGPL adapter is new client code following the historical ABI, not a copy of the S controller. Its [provenance file](../lib/dex-stake-pool/PROVENANCE.md) pins the exact source hashes and canonical Sanctum accounting references, including ceiling-rounded fees and reserve floor handling.

Historical deployment limitation: the documented bridge `9XPcSKi9zHn2eqZGUFEDpPC5PBF1oAu3NhyzTrkoe3h3` had an executable upgradeable Program account during the October 7 read-only check, but its referenced ProgramData account returned `null`. That cannot attest the old executable ABI. Later this release published a **new** mainnet deployment receipt for `5f7YRhNMtZxAANQQV4B78keMFGiz8gTvAHA4p3Dj3kLp`; this does not retroactively establish the old deployment. The new program's deployment receipt and its narrower proof scope are recorded below.

### Public permissionless S fork

The public [`permissionless-lst`](https://github.com/staccDOTsol/permissionless-lst) repository is a fork of **igneous-labs/S**. Its September 11 user commit `f9dc0a0` changes permissionless controller admission, `add_lst`, fee accounts, exact-input/output swaps, LP entry/exit, Token-2022 handling and the Jupiter-facing interface, with regression coverage around permissionless admission and transfer fees.

Credit for the underlying S/Sanctum controller belongs upstream. The user's contribution is the located permissionless-routing/fee initialization change. An interface compatible with Jupiter is not proof of Jupiter acceptance, and this inventory did not establish a live controller/pool deployment. No root license was located in that checkout, so it is referenced rather than indiscriminately vendored.

## 3. OKX execution, hook-aware routes and earlier liquidity builders

The OKX fork is useful because it exposes real CPI instruction construction for roughly fifty venues, including DBC. It is an **on-chain execution implementation**, not a complete off-chain discovery and quotation service. The inspected commit belongs to upstream author Pentaclezion; no user-authored modification was established in that fork. It is MIT-licensed.

A different, user-authored iteration is visible in `plague`. October 6–7 commits add Captain Hook auctions, hook-aware routing, a SplashPool wizard, wallet compatibility repairs and flexible countermints. The existing mainnet proof document records:

- A [direct Orca swap](https://solscan.io/tx/4zuRnGDWJg7ccG7FHufRiKAXFZDWzc9G3pd5MNB6CnxTjcxfZp72X8GUBbMYWMUQJ69uvpxEks8yNGz23CSE3ifm), slot 453987003, with 0.005 WSOL input and 1,990.797730128 XEEU output.
- A [liquidity funding transaction](https://solscan.io/tx/2KaUYghTzjKyHueMLN3jRnhEXgeCUNjFk4jnpe4HVyKMZUN9q7proL8QEzCRL2aVYrRykbYWMcapnoJhud1EPN97), slot 453986925.
- An [OKX route failure](https://solscan.io/tx/4nQJS9uqAiecKtq1vXsJSiyLRFR93pxz852DoDEtbewSZ3h5XnvGtfxL2iHyVvgHNA19pNBmNhaHA5yZzhghkawK), error 6050, attributed by the existing probe/proof record to missing Orca transfer-hook accounts.

These links are existing source-recorded mainnet receipts; their full transactions were not independently revalidated while writing this timeline. Their design implication is narrower and concrete: a quote response does not prove the returned transaction supports the mint's transfer behavior. The current general DBC path still rejects unsupported hooks; it must not inherit a “supports all hooks” claim from this separate work.

The `infinitesimal` / `deadcat.fun` tree supplies another real builder lineage: direct Pump prebond quote/build, Orca full-range LP planning, simulation and signed-transaction checks. Other swaps still use Jupiter there. The inspected local files have no recovered date-bearing commit for this subtree, so this document records their existence on October 7 without inventing an earlier timestamp. Its AI model-price “minirouter” is unrelated to Solana route finding.

## 4. Quote/requote and operation routing beyond Solana

The EVM work is relevant design ancestry, not already-integrated Solana execution.

### Uniswap routing-api fork

`~/routing-api` is a fork of **Uniswap/routing-api**, under GPL-3.0. The dated user sequence is unusually useful because it shows the operation model expanding beyond a simple swap:

| Toronto date/time | Public commit | Iteration |
| --- | --- | --- |
| October 3, 19:40 | [`43466e0`](https://github.com/staccDOTsol/routing-api/commit/43466e054221edaa0a909107cb1f64535a6d85a7) | Personal AWS deployment wiring. |
| 20:11 | [`4a1dcf9`](https://github.com/staccDOTsol/routing-api/commit/4a1dcf9676e4b99124a85decc77e09afcbc8cde8) | Cross-chain xgas/XSwap quotes. |
| 20:56 | [`888944d`](https://github.com/staccDOTsol/routing-api/commit/888944dac23131431ad36ea7aa50855ec17783a7) | Robinhood chain 4663 pool lists. |
| 21:10 | [`390f5c0`](https://github.com/staccDOTsol/routing-api/commit/390f5c0fc0eb7065bb75dea5f7c131347be72b49) | Pool-cache peg/spread handling. |
| 22:30 | [`fe7f3e9`](https://github.com/staccDOTsol/routing-api/commit/fe7f3e919e939486014020b5cb39661bf0ef9680) | Omnipeg buy/claim → teleport → sell planning. |
| 22:36 | [`4c8ad79`](https://github.com/staccDOTsol/routing-api/commit/4c8ad79c1f48f130ec0eb888ed0d3fa743ac64a4) | Universal Router 2/v4 default. |
| 22:39 | [`78bc108`](https://github.com/staccDOTsol/routing-api/commit/78bc10853283de6c8eaa1a08227054b8cb5b8d0a) | v2/v3/v4 selection. |
| 22:46 | [`4bfdcd4`](https://github.com/staccDOTsol/routing-api/commit/4bfdcd47ae4ab21ac7fd7581bd8af70a45f70d64) | staccpad v4 pool feed. |
| 23:44 | [`36027ea`](https://github.com/staccDOTsol/routing-api/commit/36027eacb2f2a6d951a7d7e5d881a90b7387d4ec) | Executable Robinhood Universal Router 2.1 layout. |
| 23:44 | [`ce03bd4`](https://github.com/staccDOTsol/routing-api/commit/ce03bd411b876a5182157aef544ab1968738f2a1) | Claim path retained through quote/feed failure. |
| 23:59 | [`7b2372a`](https://github.com/staccDOTsol/routing-api/commit/7b2372ad2935e71703bdbc9200991f0c218906b3) | RPC-secret handling. |
| October 4, 00:18 | [`55b8076`](https://github.com/staccDOTsol/routing-api/commit/55b807673ac19ba6f32cc1a4274a4ff3b0a520af), [`7bd96ec`](https://github.com/staccDOTsol/routing-api/commit/7bd96ecbbbe895d994ed55647c7d303d226a8ec1) | Lazy chain providers and fit within 512 MB Lambda. |

The current `routing-api-venues` additions were untracked/unwired at inventory, and its CDK still pointed at upstream infrastructure. They must not be described as deployed Solana adapters.

### Separate EVM aggregator

The local `~/aggregator` has no configured remote. Its real implementation includes quote deduplication, a three-second cache, two-request concurrency, explicit requoting and operation dispatch for fee/bridge/vault/NFT paths. October 4 local commits record COOK settlement (`6e7c298`, 04:24), verified XSwap V2 (`b4a3c23`, 04:50), bounded solver funding and separate service status (`ce06be8`, 05:04), and a healthy read-only solver with a remaining funding gate (`ff3ef66`, 05:11), all Toronto time.

The reusable idea is that swaps, claims, redemption, deposit and funding can be different directed actions with their own quotes and bounds. It does not imply that an EVM planner can be copied unchanged into Solana, or that separate transactions become atomic by calling them one route.

## 5. IDL intelligence and the actual shipped Composer service

There are at least four distinct stages; conflating them obscures what was built.

1. **December 2024: IDL-backed API.** The Rust/Axum `idlbazaar` prototype handles IDL upload/cache, instruction requirements and transaction preparation. It consumes supplied IDLs rather than learning an unknown program. The inspected version contains fake Token/ATA IDLs, unsupported-type panics and incomplete transaction fields; it is an early iteration, not eligible current execution infrastructure.
2. **March 2025: generated IDL CLI.** `openai-idl-generat00r` dumps a Solana program and calls a model. The old prompt uses only the first 200 hex characters—100 bytes—of the binary, and accepts parsed JSON. Training/generation data exists, but this inventory did not establish a particular accessible fine-tuned model or hosted service. This is concrete earlier inference work, with concrete validation limits.
3. **March 2025: private reverse-engineering work.** `idrsa` adds known binary/IDL retrieval and model-assisted recovery, alongside Binary Ninja/Rust reconstruction. Its source was inspected privately; it is not reproduced or represented as an open-source dependency here.
4. **September 2026: Composer, an existing paid program/transaction service.** This is the user's previously shipped x402/Bazaar system. It is distinct from the generic paid inference gateway whose repository preserves the callers and registration evidence.

Recovered Composer endpoint contracts, from the existing registration/caller scripts:

| Existing endpoint | Evidenced role |
| --- | --- |
| `POST /probe` | Sweep derivation candidates and report accounts found/checked. |
| `POST /find` | Query program accounts through IDL layout and typed field filters. |
| `POST /tx/build` | Build an unsigned transaction from a published Anchor IDL, resolving accounts/PDAs/ATAs. Saved examples use v0. |
| `POST /tx/batch` | Compose instructions into one transaction or an ordered bundle, optionally simulated. |
| `POST /intent` | Turn a described goal into candidate transaction plans, build/simulate and rank their outcomes. |
| `POST /learn/:programId` | Existing caller invokes a program-learning route; complete response and internal learning algorithm have not been recovered. |
| `POST /yolo` | Existing caller passes intent/payer; full execution semantics remain unverified and it was not invoked during inventory. |

Historical records show Composer CDP settlement and Bazaar listing after the v2 payment-header fix, its September 2 OKX.AI registration, and a September 9 Fly application listing marked deployed. That is stronger evidence than a newly invented API proposal, while remaining distinct from an independent present-day service check.

Current recovery blocker: on October 7 the old hostname failed with a connection reset, and the authenticated Fly account returned `Could not find App "the-composer"`. Accessible repository/local/task-record searches recovered callers but not the service implementation, replacement hostname or deployment image. The exact source or recoverable image is still needed to restore it. No wallet-paying caller scripts were executed to discover this.

The new `tools/inference` work accepts full-binary, hash-bound evidence and validates a structured proposal before replay. It has not silently replaced Composer or a required fine-tuned model with a generic service. Model confidence and valid JSON are not permission to install an executable trading adapter. See [Composer recovery inventory](composer-service-inventory.md), [inference/EVM inventory](inventory-inference-evm.md) and [inference admission](../tools/inference/ADMISSION.md).

## 6. Recursive assets: DBC markets and LP-of-LP planning

QuoteFun's local scaffold sits inside the Meteora Invent checkout. The parent repository's August 5, 2026 commit is an upstream Meteora merge; it does **not** date the user's QuoteFun implementation. The scaffold uses the official DBC SDK 1.5.12, reads real pools, constructs direct trades and resolves parent prices for display.

The October 7 requirement is specific: a new meme can be quoted in another still-prebond meme, and that meme in another. Waiting for an external aggregator to list or support the upstream markets defeats the recursive product. Multiplying displayed spot prices is insufficient; each leg must quote the actual amount against current state and pass its actual proceeds into the next instruction.

The new DBC adapter uses the official MIT SDK through a worker. It walks base-to-parent relationships, tracks visited mints, bounds discovery and detects cycles; it does not copy a differently licensed Rust DBC program. Actual-input route quote/requote and the executor's final minimum output are the execution controls. Unsupported hooks/extensions are rejected rather than silently approximated.

The checked-in BREAD/CRUMBS mainnet fixture records slot 454312635 and exercises both directions, fees, price impact and serialization. A synthetic recursive child fixture tests the graph extension; it is explicitly not evidence that a second child market existed on mainnet. Read [DBC adapter details](../lib/dex-meteora-dbc/README.md).

Separately, `~/cpmm-index-composer` has real nested CPMM deposit/withdraw planners: parent LPs hold child LP tokens, without requiring an AMM fork or wrapper vault. It has no commits or configured remote in the inspected checkout. Its README records an October 7 06:34 UTC snapshot where 34 planned pools were all absent and the configuration fee alone was 0.15 SOL per pool. That is a planner/design implementation, not 34 launched pools.

Nested deposit/withdraw sequences may require multiple independently confirmed transactions and can leave intermediate assets in the wallet. The current UI labels this explicitly. An initializer's seed ratio is part of the reviewed economics, not a hidden default or a claim that arbitrary liquidity can be manufactured.

## 7. FTL is the observation-to-action surface

The local FTL repository has no configured remote in the inspected checkout. Its October 4 Toronto history is:

| Time | Commit | Recorded change |
| --- | --- | --- |
| 19:36:50 | `a3dcb8a15d900a735c51960c64502dbde7b9f0fa` | Follow The Liquidity: Solana/Robinhood firehose, signals and social UI. |
| 19:37 | `ee4259e5ed4d08138dbada7dbb8e621cf397fb67` | Robinhood backfill/health behavior. |
| 19:44 | `276be1781550faad005930cac841a9acfd7f6914` | Solana Geyser `failed: true` filter fix and dedicated CPU. |
| 19:56 | `5613020e241d9aa156449c94f10b2c13defa4cef` | DAS, Pons and launch metadata, USD values and live UI. |
| 19:57 | `ec8b282bf3dbb2ec71a612ecedc41b50fe967ace` | CA certificate fix for Triton transport. |
| 20:06 | `db2f4b532ae882e22963cd1ab998bd8035f9145a` | liquidityxyz branding, preconfirmation regions, retry/socket handling. |
| 20:11 | `41f4954c8c7e378f802e6e6b6e6e72e0f37e359dfe` | Worker lanes and event-loop lag isolation. |
| 20:14 | `a9f1b5d149d739e8fc6b5343fae835e34c950a81` | `api.liquidityxyz.fun` configuration. |
| 20:23 | `22074e80748dea155e57f6985e56d413344480f3` | Disable React compiler behavior that froze the mutable live store. |

The feed observes pool births, additions and withdrawals across eleven Solana venue/program families and Robinhood Uniswap v4/Pons. Its ingestion design distinguishes preconfirmation/deshred/Geyser sources, deduplicates them, and reconciles early observations with confirmed vault deltas. These transports and venues belong to their providers; FTL's contribution is the collection, interpretation and product integration.

The signal lineage includes [`the-book`](https://github.com/staccDOTsol/the-book), including October 3 [fresh-price ready-queue handling](https://github.com/staccDOTsol/the-book/commit/a549521c361671c38e4053a959eaeb1d94c77e8e) and [unsent-plan/gas-cost recovery](https://github.com/staccDOTsol/the-book/commit/eb03199e7759dc5c93ca7350e8a17088f9f1d343). Signals such as empty initialization, quick add/remove and early pool activity provide context; they do not authorize a wallet action.

The current release's integration, developed October 7 and still requiring its own final deployment record, connects:

**Feed event → token/pool context → selected wallet's quote or exit → transaction review → simulation → wallet signature → send/confirmation → refreshed positions.**

The originating event remains on screen when changing between trade and liquidity operations. “Check my exit” binds to the connected wallet's own balances and positions; the wallet observed in an alert never becomes the payer. The UI reads real balances, exposes 10/25/50/100% controls where appropriate, retains fee reserve, shows exact input/output identities and expires stale quotes.

The browser wallet path supports actual raw-byte V1 signing when the wallet advertises version 1, with explicitly negotiated v0 only when it fits. It validates transaction bytes and required signatures, simulates before signing, handles pending confirmation, and preserves partial progress in ordered multi-transaction operations. The embedded Helius SDK path is web-only; this work does not claim unsupported native SDK end-to-end execution.

Browser evidence in this work includes a real observed DLMM withdrawal event opening the correct pool, Remove selection, retained event when switching trade/exit, honest disconnected position state and a 390×844 mobile viewport with no horizontal overflow or console errors. Nineteen targeted amount/wire/liquidity/event-context tests passed; TypeScript passed. No funded wallet transaction was signed or sent during that browser pass.

## 8. Eight venue lifecycle integration: implementation and proof

The release now has operation adapters for Raydium CPMM, Raydium CLMM, Raydium AMM v4, Orca Whirlpools, Meteora DAMM v1, Meteora DAMM v2, Meteora DLMM and PumpSwap. Official protocol SDKs and on-chain programs retain their upstream authorship. New work supplies the common operation interface, immutable quote-bound approval, fresh build checks, V1 compilation, wallet orchestration, integration tests and FTL context.

The common API exposes capabilities and operation-specific parameters, wallet-owned positions, an expiring quote with token-specific debit/credit bounds, and an ordered build. Canonical mint order is explicit; reversed input pairs are normalized without moving an amount to a different token. Unrelated token pairs reject. A successful build cannot silently widen the user's reviewed maximum input or minimum output.

| Venue | Initialize/add/remove | Important actual boundary |
| --- | --- | --- |
| Raydium CPMM | All three executed in the lifecycle harness | Pool configuration/open-time and seed inputs remain explicit. |
| Raydium CLMM | All three executed | Canonical ticks and selected position liquidity matter; testing fixed the first deposit into an empty pool where tick arrays did not yet exist. |
| Raydium AMM v4 | All three executed | Legacy pool/market account requirements remain protocol-specific. |
| Orca Whirlpools | All three executed | Initial price and tick spacing are reviewed; position liquidity deltas are asserted. |
| Meteora DAMM v1 | All three executed | Legacy SPL mint support; reviewed exact LP output was corrected during verification. |
| Meteora DAMM v2 | All three executed | Position and activation/lock semantics remain in the venue adapter. |
| Meteora DLMM | All three executed | Removal is a percentage of bin-position liquidity, not an invented fungible LP burn. Protocol lacks native minimum-output enforcement for this withdrawal path; surfaced explicitly. Locks/activation are checked; adds are bounded to the supported bin range. |
| PumpSwap | All three executed | Boost-native LP mode and unsupported transfer-fee LP pricing reject explicitly. |

The other three watched launch families—Meteora DBC, Raydium LaunchLab and Pump prebond—have launch/curve/migration behavior rather than a generic prebond LP add/remove interface. Observing eleven families is not the same as promising eight-style LP operations on all eleven.

### Evidence levels achieved

| Evidence | What was actually checked | What it does not establish |
| --- | --- | --- |
| Worker regression suite | Latest reported run: 34/34 tests; the Meteora/Pump subset 16/16 and Raydium/Orca-focused subset 11/11. Real SDK instruction construction and economic-bound decoding are covered. | All possible states, extensions or adversarial cases. |
| Captured mainnet fixtures | Actual RPC/account fixtures for initialize/add and selected removes, plus explicit unsupported-mode rejection. | Funded execution or permanent future state validity. |
| Read-only mainnet V1 simulation | Successful sampled DAMM v1 add/remove, DLMM remove, Pump add/remove; Orca and Pump initialization samples also simulated. | Broadcasting, landing, a user receiving funds, or current liquidity at a later time. |
| Complete local lifecycle run | **24/24 operations, eight venues, zero failures** under Agave 4.3; real captured mainnet program binaries/configuration, actual signed V1 simulation/send/confirm, balance and position assertions. | Mainnet funding, an independent audit, or every possible venue mode. |
| Funded PumpSwap lifecycle | Confirmed mainnet initialize, add and remove; the remove receipt records the FTL HTTP API → Rust router → worker → signature → FTL RPC proxy → mainnet path. | Funded mainnet execution of all eight venues, or a browser-wallet signing pass. |
| FTL browser pass | Real feed-event-to-pool UI, retained event, wallet-owned exit semantics, mobile layout and disconnected-state behavior. | A funded wallet signing flow; native Helius SDK support. |

The full lifecycle receipt is [verified-lifecycle.json](../lib/liquidity-operations/worker/test/svm/verified-lifecycle.json), captured **2026-10-08T03:27:36.792Z**, mainnet source slot **454423460**. It contains executable SHA-256 hashes, local transaction signatures, wire sizes, compute use and balance changes. The contemporaneous ignored `target/liquidity-svm/evidence.json` had SHA-256 `8b961d576fcdc738ea3c2912766c09c7eda7907f5ea1a00fc77d2c6a515af2da`.

Reproduce from `lib/liquidity-operations/worker`, with Node 26 and Agave 4.3 available:

```sh
RPC_URL="$READ_ONLY_MAINNET_RPC" node test/svm/execute-liquidity.mjs
```

The capture reads mainnet; signing and sending use the isolated local validator at `127.0.0.1:18999` and synthetic test balances. See the [harness README](../lib/liquidity-operations/worker/test/svm/README.md) for exact scope and cache behavior. The run's production fixes include CLMM first-deposit tick-array handling, DAMM v1 exact LP output bounds and DLMM activation-time withdrawal checks.

### Funded mainnet receipts published after the local proof

[Commit `b8b3a98`](https://github.com/staccDOTsol/autobahn/commit/b8b3a98e22599da0bbd9dc9bf401df9a693449d3), recorded October 7 at 23:35:09 Toronto, publishes [mainnet-receipts.json](mainnet-receipts.json). It records the following real funded operations on PumpSwap pool `7GZHLdhvZN1NSutNt1BJs5S9ArBobAdCvyGzwPo22LHA`:

| Operation | Confirmed slot | Mainnet transaction |
| --- | --- | --- |
| Initialize | 454423617 | [3P43Mc…TEP4w](https://solscan.io/tx/3P43McddpWKZCJXYddYonUoyDvXVAW8BBciCrj7ghhC6vCTi6XjkSjXVdHDMMzTrjhkuNvVLjxn8z7PEN4vTEP4w) |
| Add | 454423729 | [4ekNaA…WmM9](https://solscan.io/tx/4ekNaABGkatd7B63bobqnNvMwYPFWbSKrSWoVTzda7KmMNeuyBNnSbpdhQMdSqgTWrx2NevD3Jg8Q5ER5VRmWmM9) |
| Remove | 454424292 | [3CmW7k…LC2s](https://solscan.io/tx/3CmW7kY9DyJ9kuNBLnaUxtaCTmRLSocCrh22bdMPb1gwJw99HBZ7xWk4G7ZTjeV5gHXEiYYW2VQN96y2gaVnLC2s) |

The receipt preserves the reviewed request/quote, V1 version, simulation, owner, before/after balances, fees and token changes. The remove explicitly records the full FTL server/router/RPC path. It establishes real mainnet execution for this venue and sample, without turning the separately tested other seven venues into funded-mainnet claims. SOL/USDC customizable initialization on some other venues was already occupied or rejected by protocol-specific mint rules; successful synthetic lifecycle execution is not a promise that every arbitrary mainnet pair can initialize.

The same commit publishes a [new LST program deployment receipt](lst-deployment-mainnet.json): program `5f7YRhNMtZxAANQQV4B78keMFGiz8gTvAHA4p3Dj3kLp`, [deployment transaction](https://solscan.io/tx/4hgSvfSyjJi6xEyJpKeKb3HuC2s6XQ5LQV642XwaxQzxWrJ1idyuXtXC8scMmF8atG1UYYjM5N7dgbWC2gMvQ225), finalized at slot 454422155, observed executable under the upgradeable loader, binary SHA-256 `4cdac0b2f8c0079006121d13071315600b2c52ad51c515ff6f0de819598cd3c5`. A deployed executable is a concrete milestone; initialization, route availability and a successful staking/conversion lifecycle require separate receipts.

## 9. Automatic admission is the governance mechanism

The user's requirement is explicit: an adapter passing the required machine checks should be admitted, merged and deployed without an individual venue needing political sponsorship or a manual approval queue. The relevant new work is the admission contract and trusted execution evidence, not a claim to have invented the underlying AMMs.

The implemented design separates candidate code from trusted RPC recording, pins actual executable/account evidence, replays against real program bytes, checks balance deltas and required failures, and binds merge/deploy to the tested commit. The executor's real SBF build and route tests are part of the gate. Tests that never execute a case, generated IDLs that merely parse, self-reported model confidence and candidate-supplied fake fixtures are not adequate admission evidence.

The root registry/CI policy remains separate from candidate adapter changes. This prevents a candidate from changing its own passing criteria while preserving the user's no-human-review target for eligible adapter changes. [Adapter admission](adapter-admission.md) describes the exact implementation and workflow. An existing workflow file or successful local test is not by itself evidence that GitHub branch protection, automatic merge and production deployment are all currently operational; those require their own live checks.

## What can be claimed, and what still needs a separate receipt

**Supported by this record:** years of distinct program/IDL experiments; an April 2025 Autobahn/Launchpad iteration; September 2026 permissionless LST and shipped Composer records; October EVM route/operation and FTL feed iterations; hook-aware launch/liquidity work; recursive DBC execution integration; eight common LP-operation adapters; actual V1 handling; the complete 24-action local execution proof; a funded mainnet PumpSwap lifecycle; and a new finalized LST program deployment.

**Not established here:** authorship of upstream Mango/Fill.city, OKX, Uniswap, S/Sanctum or venue SDK code; a presently reachable Composer service or recovered learning implementation; a verified active historical LST bridge deployment; funded creation of the nested CPMM planner's proposed pools; support for every token extension/venue mode; native embedded-wallet end-to-end support; or a healthy production rollout merely because deployment files and tests exist.

The release's specific convergence is the valuable part: FTL supplies a live event and exact market context; the router supplies executable quote/requote and venue operations; the wallet supplies the user's actual authority and holdings; positions and confirmations stay attached to the original decision. Composer, once its existing implementation is recovered, can feed program understanding into the same objectively verified adapter pipeline rather than creating a second, untested execution path.
