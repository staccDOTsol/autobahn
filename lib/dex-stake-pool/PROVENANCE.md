# Stake-pool adapter provenance

This crate is new adapter code under the aggregator's AGPL-3.0 license. It does
not copy or embed the S/Infinity controller or `permissionless-lst` program.
Those repositories' licensing and deployment status must not be inferred from
the license of the historical engine workspace.

## Bridge ABI

Source repository: local `/Users/stacc/solana-liquidity-engine`, commit
`50c64119edebbb8c72d0ddceb4ee1f25e2d673ca`. That workspace declares Apache-2.0.
The new client instruction builder follows the documented `mint_wrapped` and
`redeem_wrapped` account contracts from these exact historical files:

| File at that commit | SHA-256 |
| --- | --- |
| `program/src/router.rs` | `6dc7a5423e03648142fd3111dfcb4a94473dd0074b993be6e6cfbfa931886617` |
| `client/src/router.ts` | `9574298fdad09cd7fe205c570c8397c2483982ac726ba50b80fee9d0a01af623` |
| `client/src/lst-swap.ts` | `c2b6e2254fe1fb145a42999b00dbacafc17a650e8ca3142390ddd1b7424626bc` |

These are **source file hashes**, not executable hashes. They must never be put
into `bridge_program_sha256`. A deployable reviewed build and its actual
executable hash remain required.

The known historical program address is
`9XPcSKi9zHn2eqZGUFEDpPC5PBF1oAu3NhyzTrkoe3h3`. Read-only public mainnet RPC checks
on 2026-10-07 returned an executable upgradeable-loader Program account pointing
to `97rzqrmMdcbceCnPBcGEqE4pCTeroQQYvxjseyzohPch`, but that ProgramData account
returned `null`. This cannot prove an executable ABI and cannot pass this
adapter's initialization. The adapter does not guess a replacement deployment.

## Pool state, accounting and fees

The published [`spl-stake-pool` 1.0.0 crate](https://crates.io/crates/spl-stake-pool/1.0.0)
provides the Apache-2.0 Borsh stake-pool state decoder and integer backing-ratio
methods compatible with this workspace's Solana 1.17 dependencies. Its older
floor-rounded fee method is **not used**.

Current ceiling fee application and reserve floor were checked against the
canonical Sanctum SPL fork at commit
`81f7e922a4cad340da8347a2ef244445d0cc3e26`:

- [state.rs](https://github.com/igneous-labs/sanctum-spl-stake-pool/blob/81f7e922a4cad340da8347a2ef244445d0cc3e26/stake-pool/program/src/state.rs): backing ratios and `Fee::apply` ceiling division.
- [processor.rs](https://github.com/igneous-labs/sanctum-spl-stake-pool/blob/81f7e922a4cad340da8347a2ef244445d0cc3e26/stake-pool/program/src/processor.rs): deposit/withdraw fees, current epoch, reserve availability and slippage checks.
- [lib.rs](https://github.com/igneous-labs/sanctum-spl-stake-pool/blob/81f7e922a4cad340da8347a2ef244445d0cc3e26/stake-pool/program/src/lib.rs): `minimum_reserve_lamports` and zero additional reserve requirement above rent.

The bridge's pinned supported program addresses are SPL Stake Pool
`SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`, Sanctum SPL
`SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY`, and Sanctum SPL Multi
`SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn`.

Configured bridge hash validation proves the observed bytes match the operator's
pin. It does not independently attest a source-to-binary build, the supported
pool programs' current deployments, or a successful transaction simulation.
