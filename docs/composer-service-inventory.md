# Existing Composer service: recovery inventory

Verified on 2026-10-07. This corrects the earlier inventory's failure to identify the shipped program-discovery service. No payment, wallet signature, or transaction submission was made during this inventory.

## Identified service

**The Composer**, formerly at `https://the-composer.fly.dev`, is a distinct service referenced by the user's existing private `staccDOTsol/x402-tokens` repository. The gateway is not a substitute for this service.

Evidence remains in both the current private GitHub tree and these local files:

- `/Users/stacc/break-solana-chat/x402-tokens/scripts/bazaar-settle-v2.mjs`
- `/Users/stacc/break-solana-chat/x402-tokens/scripts/pay-composer-cdp.mjs`
- `/Users/stacc/break-solana-chat/x402-tokens/scripts/pay-gate-all.mjs`
- `/Users/stacc/break-solana-chat/x402-tokens/scripts/pay-gate-rest.mjs`
- `/Users/stacc/break-solana-chat/x402-tokens/src/x402.ts`
- `/Users/stacc/break-solana-chat/x402-tokens/.claude/wiki.md`

There is a second local gateway checkout at `/Users/stacc/oz/x402-tokens` containing the same references. Private source has not been copied into this public repository.

The registration script entered the private repository by commit `3a9522c7ac990d23f0c91d4d02871da986b8e45e` on 2026-09-01; it was later updated in `76141414685c96de3de1feb75e6225a9a6e9bdb0` on 2026-09-09. The gateway's discovery implementation records that Composer settled through CDP and became Bazaar-listed after adding the v2 `PAYMENT-REQUIRED` response header. Its wiki also records registration of Composer `/intent` alongside OpenZoo as OKX.AI ASP #11702 on 2026-09-02. These are historical repository records, not a current independent availability assertion.

## Existing interface evidence

The following contracts are descriptions and samples from the existing registration/caller scripts, not newly invented endpoints:

| Endpoint | Existing purpose | Request evidence | Response evidence |
| --- | --- | --- | --- |
| `POST /probe` | Sweep derivation inputs and check which accounts exist | `programId`, `account`, `accounts`, `sweep`, `values` | `found`, `checked` |
| `POST /find` | Query program accounts using IDL field layout and typed filters | `programId`, `account`, `where`, `limit` | `accounts`, `filters` |
| `POST /tx/build` | Build an unsigned instruction transaction from a published Anchor IDL; derive PDAs and ATAs using its seeds | `payer`, `programId`, `instruction`, `args`, `accounts` | Base64 transaction, required signers, resolved accounts; the saved sample explicitly says v0 |
| `POST /tx/batch` | Compose instructions into a single transaction or ordered bundle, optionally simulated | `payer`, `instructions`, `options.simulate` | `mode`, `transaction`, `bundle`, `simulation` |
| `POST /intent` | Turn a goal into candidate transactions, build and simulate them, and rank outcomes | `intent`, `payer`, `maxPlans` | Plans with summary, verdict (`simulated`, `simulation-failed`, `unbuildable`), confidence, transaction |
| `POST /learn/:programId` | Program-learning route | Existing caller sends a program ID in the path and an empty body | Full response schema has not been recovered |
| `POST /yolo` | Existing intent-based route | Existing caller sends `intent`, `payer` | Full response schema and execution behavior have not been recovered; do not call speculatively |

The scripts implement x402 v2 Solana payment challenges and CDP settlement. Their payment scripts must not be run merely to inventory the service: they load actual wallet credentials and authorize payment. None were executed here.

The `/learn` route supports the user's identification of an earlier program-learning product. The available caller/registration code does **not**, on its own, establish how it inferred unpublished IDLs, which model it used, or what evidence/validation it required. Those details require the actual service source or a recovered service response.

## How this intersects with the router and FTL

- **Discovery:** Composer's program learning and IDL-backed account discovery can produce candidate venue descriptions for the adapter pipeline. Their provenance should include the program, executable hash, account layout evidence, and the recovered service/version.
- **Instruction construction:** Reuse `/tx/build` and `/tx/batch` contracts where they provide the exact needed program instructions. The current router's immutable min/max approval bounds, signer validation, and transaction simulation remain required around those instructions.
- **Planning:** `/intent` can propose swap/add/remove sequences spanning existing FTL events and pools. It is not evidence that a route will execute until the exact built operations pass replay and simulation.
- **FTL context:** Keep the observed event, selected pool, token identities, and the connected wallet's positions attached to the resulting action. An event wallet never becomes the payer or position owner.
- **Wallet/version compatibility:** The saved Composer build sample is v0. The release's actual V1 raw-byte wallet path must not mislabel those transactions as V1; either extract/recompile verified instructions through the V1 builder or explicitly negotiate v0 where it fits.
- **Admission:** Recovered proposals enter the same deterministic adapter tests, actual-program replay, operation bounds, and CI admission process as handwritten adapters. A model's confidence value or successful JSON parsing is not an approval criterion.

## Current concrete recovery blocker

On 2026-10-07 the old public hostname failed with a connection reset. `fly status -a the-composer --json` returned **Could not find App "the-composer"** for the currently authenticated account, and its application list did not contain the name. A historical 2026-09-09 local Codex record contains a Fly listing with this app marked deployed, so a past deployment is evidenced.

Focused searches covered visible repositories under `staccDOTsol`, GitHub code references, local source/config files including ignored manifests, and relevant local task records. They recovered the caller/registration contract, but not the service implementation, current replacement hostname, or a recoverable deployment image. No Composer-named repository appeared in the accessible repository inventory.

The remaining required input is the service's source location, renamed deployment, or old deployment image/archive. Until recovered, this document identifies the correct existing system; it does not claim that the service has been restored or integrated, and does not replace it with the generic inference gateway.
