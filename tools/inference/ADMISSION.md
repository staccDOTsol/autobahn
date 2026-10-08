# adapter-conformance-v1

This is the handoff contract from inference to the root adapter pipeline. The proposal tool does not implement the root registry or CI workflows. It cannot mark an adapter admitted, and a model response cannot add or overwrite an admission field.

## Immutable handoff

The output includes `artifactSha256`: SHA-256 of canonical JSON with keys sorted recursively, excluding the `artifactSha256` field itself. CI must recompute it rather than trust the supplied hash. Every report must bind:

- proposal artifact SHA-256 and proposed IDL SHA-256;
- exact adapter commit SHA and build artifact SHA-256;
- full chain genesis hash, target program ID, deployed binary SHA-256 and observed deployment slot;
- full replay fixture manifest SHA-256, including account states and expected outcomes;
- check name, check implementation/version, outcome, logs/artifact digest, and CI run identity.

An artifact's `schemaValid: true` is not a CI result. Neither generated rationale nor a self-authored JSON report is admissible attestation. The root pipeline must obtain check results from its trusted CI identity for the exact immutable inputs.

## Required automatic checks

All entries in `REQUIRED_CHECKS` must pass before a registry PR becomes eligible for automatic merge/deployment:

| Check                         | Required evidence                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `binary-provenance`           | Independently fetch the target program's deployed code/account linkage on the configured chain; match the proposal's full binary hash and upgrade/deployment identity. Reject a changed binary or mismatched capture.          |
| `idl-schema`                  | Re-run schema, program-address, discriminator, type-reference and evidence-reference checks on the exact committed IDL.                                                                                                        |
| `adapter-build`               | Build the actual Rust adapter implementing `DexInterface`, `DexEdgeIdentifier`, and `DexEdge`; no stub success paths. Bind the adapter source and produced binary.                                                             |
| `account-layout-replay`       | Decode captured real accounts, verify owner/PDA/layout/discriminator relationships, and replay both swap directions for every supported edge. Unsupported layouts must be rejected.                                            |
| `quote-swap-parity`           | Use the existing `router-test-lib` capture and `programs/simulator` execution harness to compare quoted amounts/fees with actual replayed swap results, including rounding and boundary amounts. A mocked CPI is insufficient. |
| `slippage-and-account-metas`  | Validate input amount offset, account ordering, writable/signer flags, output account/mint, minimum output, exact-out limits when supported, failure behavior and compute bounds.                                              |
| `token-extension-conformance` | Replay supported token variants, transfer fees/hooks/frozen accounts and required extra accounts; reject unsupported combinations explicitly. A quote from OKX or another upstream is not execution proof.                     |
| `determinism`                 | Repeat quote/build/replay against identical captured input and compare deterministic outputs; prove stale/updated account handling with changed snapshots.                                                                     |

The repository already documents the real capture → swap generation → simulator path in `CreatingAnAdapter.MD` and `Testing.MD`. Extend that path per adapter; do not treat the inference tool's synthetic ELF tests as swap conformance.

## Automatic promotion

No human review is required by this protocol. The root CI coordinator may automatically merge and deploy an adapter PR once **all** required checks from trusted CI pass for the current PR head and immutable program/fixture identities. Any failed, missing, stale, skipped or untrusted result keeps the adapter unadmitted. The merge/deploy job rechecks the admitted commit and program identity; an upgrade or changed fixture invalidates the old result. Registry admission and deployment remain root-pipeline responsibilities, not inference responsibilities.

An inferred IDL that passes structural checks but lacks executable replay evidence stays an untrusted proposal indefinitely. Report that state explicitly; never replace it with a fabricated IDL, mocked success, or a manual-review requirement.
