# SPL/Sanctum stake-pool routing edges

`dex_stake_pool::StakePoolDex` implements Autobahn's `DexInterface` with real,
reserve-backed exact-input edges in both directions: WSOL → pool token and pool
token → WSOL. Pool discovery reads the three supported programs directly. An
optional explicit pool list narrows discovery; there is no token listing API.

## Required configuration

| Option | Meaning |
| --- | --- |
| `bridge_program` | Address of a deployed program implementing the pinned wrapped-SOL bridge ABI in `PROVENANCE.md`. No default. |
| `bridge_program_sha256` | 64 hexadecimal characters: SHA-256 of the executable bytes. For the upgradeable loader, hash every ProgramData byte after its 45-byte metadata header, including allocation padding. For legacy loaders, hash the program account data. No default. |
| `pools` | Optional comma-separated stake-pool account addresses. Missing configured accounts fail initialization. Omit to discover pools by program owner. |

The operator must connect the configured executable hash to a reviewed bridge
build. A matching operator-supplied hash alone cannot establish source provenance
or prove the ABI. Program and ProgramData accounts are subscribed and the hash is
rechecked when loading/building an edge, so an unapproved upgrade fails closed.

The historical engine address is **not a usable default**. A read-only mainnet
check on 2026-10-07 found its ProgramData account missing; see `PROVENANCE.md`.
This adapter cannot be enabled until a compatible deployed executable and its
verified hash are supplied. No program was deployed and no transaction was sent
while implementing this crate.

## Execution and scope

Autobahn executes one CPI for each edge. Native stake-pool SOL instructions do
not consume WSOL, so they cannot honestly be inserted directly into that graph.
The configured bridge unwraps exactly the input WSOL on mint and wraps actual SOL
proceeds on redeem within the edge CPI. Tags 34/35 carry input at byte offset 1
and minimum output at byte offset 9. Intermediate amounts are therefore compatible
with Autobahn's actual-output amount patching. The wallet must have the normal
transaction/rent funding used by that bridge; this is separate from route input.

Quotes use integer backing ratios, current ceiling-rounded protocol fees, the
pool's current epoch, and actual reserve lamports above its rent reserve. They
reject stale accounting, restricted SOL deposit/withdraw authority, zero-rounded
output, malformed account state, and insufficient redemption reserve. Build
reloads state and checks the quoted minimum. Exact-output quotes are explicitly
unsupported. Pool-account topology changes require rediscovery under Autobahn's
current static subscription interface.

Legacy SPL Token and Token-2022 ATAs use their respective token program seeds.
Supported mint extensions are transfer fees and token metadata; hooks and other
extensions are rejected. Minting/burning pool tokens does not add an unnecessary
token transfer. A valid manager fee account is required; this conservatively
excludes pools whose underlying program would waive a fee for an invalid manager
account. The adapter does not implement validator stake-account withdrawals or
private authority-assisted deposits.

## Verification

Run `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p dex-stake-pool --lib`.
The tests exercise integer fees/reserves/slippage, bridge loader/hash checks,
Token-2022 account derivation, exact bridge account order, and intermediate input
patching. These are local tests, not evidence of a successful live bridge swap.
Live execution replay remains blocked by the absent compatible bridge deployment.
