# Actual liquidity lifecycle execution

`execute-liquidity.mjs` runs initialize → add → remove through each production adapter and the production V1 transaction compiler. It executes the signed transactions in an isolated Agave validator loaded with the actual mainnet programs and configuration accounts. It does not submit transactions to mainnet.

Run from `lib/liquidity-operations/worker` with Node 26 and `solana-test-validator` 4.3 available:

```sh
RPC_URL="$READ_ONLY_MAINNET_RPC" node test/svm/execute-liquidity.mjs
```

Set `VENUES=raydium-cpmm,orca` to restrict a debugging run. An unfiltered run exercises Raydium CPMM, CLMM, AMM v4, Orca Whirlpools, Meteora DAMM v1/v2 and DLMM, and PumpSwap.

The read-only capture phase fetches real program ELFs and the initialization configuration. The local ledger receives a synthetic test payer, two synthetic SPL mints, and funded test token accounts. No real wallet key or token balance is used. Local test state is funded only in the isolated ledger. The source-cluster genesis identity is provided only to the test transport, because these mainnet program/configuration fixtures are running under a distinct local genesis; production network checks are unchanged.

For each action, the harness:

1. Calls the production adapter's quote and instruction builder.
2. Compiles the actual V1 wire transaction and verifies ephemeral signatures while adding the synthetic payer signature.
3. Simulates with signature verification, then sends only to `http://127.0.0.1:18999` and confirms execution.
4. Checks token balance changes against every reviewed debit maximum and credit minimum, and checks the executed pool's program owner.
5. Checks Orca/CLMM position liquidity deltas against the reviewed raw liquidity amount.

Results are written to the ignored `target/liquidity-svm/evidence.json`, with mainnet capture slot, SHA-256 program hashes, local transaction signatures, compute units, wire sizes, and token balance changes. Cached program ELF files pin subsequent debugging runs to the same executable bytes. To capture new binaries, remove only `target/liquidity-svm/programs` before rerunning. The validator is stopped after the run. A failure is recorded in `failure.json`; passing earlier actions remain visible in `evidence.json`.

These are real SVM program executions on synthetic local balances. They demonstrate instruction and accounting behavior, not a funded mainnet deployment or an independent security audit. Read-only live-mainnet fixtures and unit regression checks are separate tests.

The checked-in `verified-lifecycle.json` records the completed 24-operation run across all eight venues. It is an execution receipt, not a mock fixture or a claim of mainnet execution. Re-run the harness to verify the current code.
