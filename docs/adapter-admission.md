# Automatic adapter admission

An adapter PR needs no approval label, reviewer, token-holder vote or business relationship. It changes `lib/dex-<id>/`, its `adapters/<id>.json` manifest, the generated registry and lockfile. The manifest registers a real `DexInterface`; operations may include swap, add/remove liquidity, stake/unstake and wrap/unwrap.

Run `python3 tools/registry/generate.py` after adding the manifest. CI regenerates using default-branch policy and requires byte-identical output. Changes to the executor, admission rules, credentials or deployment workflows are not adapter PRs and cannot self-approve through this lane.

`Adapter proposal` executes default-branch policy only, validates scope through GitHub's API, and dispatches `Adapter admission`. This also avoids a first-time-contributor manual workflow approval gate. The admission worker has read-only repository access. Candidate compilation/tests run inside a disposable container with no repository token or deployment secrets. The privileged merge job runs separately, checks that both PR head and base are unchanged, publishes the admission result, merges that exact SHA and explicitly dispatches deployment. GitHub pushes made with GITHUB_TOKEN do not trigger push workflows, so deployment is explicitly dispatched.

The repository must have zero required human approvals for adapter admission; require the `Adapter admission` status instead. Protect changes to the admission machinery through a separate core-change process. This is separation of executable policy from its inputs, not a discretionary venue admission committee.

## Required execution evidence

`lib/dex-<id>/fixtures/admission.json` contains:

```json
{
  "options": {},
  "amounts": [1000000, 10000000]
}
```

CI captures a new mainnet snapshot through an isolated trusted RPC recorder at each amount; contributors provide options and test amounts, not trusted program bytes. The snapshot uses Autobahn's RPC capture format, contains real program/account state, and supports both directions of every exposed operation. The candidate produces untrusted instructions and quotes at each test amount; the independent LiteSVM runner executes them and checks input and output balance deltas. Empty captures, failed edges, zero-output edges, missing snapshots, and absent replay files fail admission. The complete router and executor tests also run.

The verifier is compiled from default-branch policy before candidate execution and runs in a separate read-only container without network access. Candidate capture can reach only a separate RPC recorder. A local TCP probe must succeed within 30 seconds before capture starts. That recorder holds the upstream credential, allows only bounded read methods, and persists canonical account state outside candidate mounts. Replay discards every candidate-supplied account byte and uses the recorder’s completed snapshot, including sysvars and executable ProgramData. Missing required accounts or failed/incomplete recording fail the run. No paid RPC credential is exposed to candidate code. Successful replay remains bounded evidence for the exercised market states and amounts, not a mathematical proof of arbitrary adapter behavior.

The mandatory executor job builds real `autobahn_executor.so` and `mock_swap.so` program files from trusted policy source, then runs all seven executor integration tests in a read-only container without network access. The tests cover one-, two-, and three-hop execution, slippage rejection, and platform/referral fees. The runner refuses an executable missing any required test, so accidentally omitting `test-bpf` cannot report success with zero tests. These local SBF tests validate the built source; they do not establish equivalence to any mainnet executor deployment.

Native Rust remains pinned to 1.76 on amd64 for OpenBook's stored account layout. SBF compilation uses hash-verified Agave 4.3.0 and platform-tools 1.57, with separate lockfiles under `ci/sbf-locks/`, Solana 1.17.34 and release overflow checks. `ci/prepare_sbf.py` copies unchanged program source into isolated crates and rejects an unfamiliar manifest. Updating this trusted build recipe is a core policy change, not something an adapter PR may rewrite.

Inferred IDLs enter through `tools/inference/` as untrusted proposals and must pass the same lane. Inference cannot waive replay, add credentials, or deploy directly.

## Repository setup and current status

These files define the pipeline; they do not indicate that repository rules, CI runs, or deployment have been activated. The target repository must explicitly allow the metadata-only `pull_request_target` event under its Actions policy, require the `Adapter admission` status with strict current-base checks, and require zero reviewer approvals. All required gates are dependencies of the merge job. Core policy changes cannot pass through the adapter lane.

Before activation, provision the deployment app and its runtime configuration, set scoped `FLY_API_TOKEN` and `ADMISSION_RPC_URL` repository secrets, and run the full workflow in the target repository. The inherited push-only `Cargo Build & Test` workflow still contains its original Solana 1.18.8 installation path; it is not a dependency of the automatic adapter merge. Reconcile that legacy workflow with the mandatory admission gates before describing every repository CI workflow as an admission requirement. A failed gate never receives the successful `Adapter admission` status and never reaches merge or deployment.

References: [GitHub trust boundaries](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [Actions event policies](https://docs.github.com/en/actions/concepts/about-actions-policies), [strict status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
