# Evidence-bound inference proposals

This tool connects to the operator's **existing, explicitly configured** OpenAI-compatible service, including the existing x402 gateway. It produces an **untrusted adapter proposal**, not a router adapter admission. It never changes the router registry, generates executable adapter files, signs a transaction, settles x402 payments, merges a PR, or deploys a service.

The integration reuses the existing service's `POST /v1/chat/completions` protocol. No private x402 gateway source is copied here. The earlier `openai-idl-generat00r/generate_idl.py` workflow is credited as the starting workflow (program dump → configured model → candidate IDL); this is an independent implementation that transmits **all** supplied program bytes instead of the earlier 100-byte prompt sample. A private fine-tuned model must use an endpoint that actually serves that exact model. The tool never substitutes a general model or another provider.

## Local checks

Node 22 or newer:

```sh
npm ci --prefix tools/inference --ignore-scripts
npm test --prefix tools/inference
```

The tests use synthetic, clearly marked ELF structure fixtures and injected HTTP responses. They exercise validation and transport boundaries, **not** deployed inference, real program semantics, or payment settlement.

## Explicit service configuration

Create an ignored `service.local.json` containing these required fields:

| Field             | Meaning                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `version`         | `1`                                                                                                      |
| `transport`       | `openai-chat` or `x402-openai-chat`                                                                      |
| `endpoint`        | Complete existing HTTPS chat-completions URL; credentials/query strings are rejected                     |
| `model`           | Exact model identifier already served by that endpoint, including the existing fine-tuned ID if required |
| `maxRequestBytes` | Explicit budget for the complete serialized request; 1 KiB–32 MiB                                        |
| `maxOutputTokens` | Explicit configured output token budget; 256–131072                                                      |
| `timeoutMs`       | Explicit timeout; 1000–300000                                                                            |
| `authEnv`         | Optional name of an existing environment variable, used only as a bearer credential                      |

There is no default provider, endpoint, model, credential, or credential-file discovery. Endpoint/model compatibility and context capacity are the operator's configuration requirements. A response reporting another model is rejected. A request exceeding its budget is rejected **without truncation**. The service must return the standard non-streaming chat-completions envelope with one assistant choice and `finish_reason: "stop"`.

An x402 `402` response stops with `PAYMENT_REQUIRED`. This tool does not read wallet keys or construct payment headers. Service credit/authentication or a separately authorized existing payment flow must be arranged outside this tool. HTTP errors and redirects do not trigger another endpoint, model, payment, or retry.

## Captured program evidence

Put a manifest beside the evidence files. Required manifest shape:

```json
{
  "version": 1,
  "programId": "<target program public key>",
  "genesisHash": "<full getGenesisHash result, not a truncated CAIP chain ID>",
  "slot": 123,
  "files": [
    {
      "kind": "program-binary",
      "path": "program.so",
      "sha256": "<SHA-256 of the entire file>",
      "programId": "<target program public key>",
      "source": {
        "uri": "solana:program/<target program public key>",
        "capturedAt": "2026-10-07T00:00:00Z",
        "slot": 123
      }
    }
  ]
}
```

Exactly one target `program-binary` is required. Its 64-bit little-endian BPF ELF header, section-table bounds, section-file bounds, size, and complete SHA-256 are checked. This is a structural transport check; it does not establish that the binary executes correctly or came from chain.

Add `known-idl`, `account-snapshot`, and `transaction-replay` files using the same record fields. `known-idl` files are checked against the supported schema and their declared program address; reference-program IDLs may name a different program. Observation files must be JSON objects and retain their source/slot/hash. Their contents remain unverified until replay. File paths must stay inside the evidence directory, including symlink resolution. Each file is limited to 16 MiB and the bundle to 24 MiB. Source URIs may use HTTPS, Solana or IPFS and must not embed credentials or query data. No source URI is fetched by this tool.

The manifest and every full evidence file are bound into the request and proposal provenance. Capture metadata is explicitly marked **externally unverified**: hashing a declaration does not authenticate its author or on-chain origin. A later CI job must independently verify the chain, program binary, deployment slot and account capture before admission. Supply only evidence that may be sent to the configured service.

## Commands

```sh
# Offline: validate evidence and create the exact full-evidence request.
node tools/inference/cli.mjs prepare service.local.json evidence/evidence.json artifacts/request.json

# Offline: validate an existing complete service response and emit an untrusted proposal.
node tools/inference/cli.mjs import service.local.json evidence/evidence.json artifacts/proposal.json response.json

# Explicit live operation: invokes the configured service and may consume its existing credit.
node tools/inference/cli.mjs request service.local.json evidence/evidence.json artifacts/proposal.json
```

Output files are created with mode `0600` and never overwritten. `prepare` and `import` make no requests. Development/verification for this integration did not invoke `request`, inference, or payment settlement. A live service response must still be validated before that integration can be reported as operational.

## Supported IDL scope

`schema.mjs` uses Ajv JSON Schema validation for an explicitly restrictive subset of the [Anchor 0.30 IDL format](https://github.com/coral-xyz/anchor/blob/v0.30.1/ts/packages/anchor/src/idl.ts): spec `0.1.0`, non-generic Borsh structs/enums/aliases, primitive/defined/option/coption/vector/fixed-array types, instruction account groups and PDA seed descriptions. Unsupported legacy IDLs, generics, custom serialization, repr metadata, and unknown fields fail with an error; they are not silently converted.

Additional checks bind the program public key, require unique names and unambiguous instruction discriminators, resolve defined types, require account/event type definitions, and bind each proposed instruction's claim to supplied evidence hashes. Malformed JSON, fenced prose, refused/truncated completions, tool calls, model substitutions, invented evidence hashes, and model-supplied admission fields are rejected. Evidence docs and rationale strings are data only and are never evaluated or executed.

These checks establish a structurally valid **candidate**, not a correct IDL or safe swap. The output always contains `trust: "untrusted"`, `validation.executableValidated: false`, and `admission.eligible: false`. See [the automatic admission protocol](ADMISSION.md) for the independent required checks.
