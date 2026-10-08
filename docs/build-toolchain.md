# Router build compatibility

The router and admission build use **Linux amd64, Rust 1.76.0 and Node 22**. The
existing OpenBook v0.2.7 dependency stores native `u128` values in zero-copy
on-chain account structs. Its expected 8-byte alignment is provided by the old
x86 Rust ABI. Modern x86 compilers and all aarch64 compilers align `u128` to 16
bytes, causing the dependency's padding and size assertions to fail.

Do not remove those assertions, enlarge the structs, or disable OpenBook to make
a build pass: those changes would change the supported router or account layout.
The explicit amd64 platform in both Dockerfiles preserves the deployed account
layout without modifying the upstream program. See the upstream
[layout diagnosis](https://github.com/openbook-dex/openbook-v2/issues/291) and
[Rust ABI change](https://blog.rust-lang.org/2024/03/30/i128-layout-update/).

`Cargo.lock` uses format 3, which Cargo 1.76 can read. Keep `--locked` on builds;
after an intentional dependency update made with a newer Cargo, verify both the
lock format and a real build using the supported compiler. The native Apple
Silicon toolchain cannot validate this full dependency graph.

Build the validation image from the repository root:

```sh
docker build --platform linux/amd64 -f ci/Dockerfile -t aggregator-ag-validation .
docker run --rm --platform linux/amd64 \
  -v "$PWD:/work" -w /work \
  -e CARGO_TARGET_DIR=/work/target/linux176 \
  aggregator-ag-validation cargo check --locked -p autobahn-router
```

Apple Silicon Docker needs working amd64 emulation. Keep the Linux target
directory separate from native build artifacts. The admission workflow runs the
full workspace build and replay checks inside the same image; a successful
`cargo check` alone is not adapter admission or a deployed-router verification.

The DBC adapter runs the pinned official SDK in
`lib/dex-meteora-dbc/worker/worker.mjs`. Install its locked dependencies with
`npm ci --ignore-scripts --omit=dev` in that directory. The production Dockerfile
does this during its build, copies the installed worker and Node runtime, and sets
`DBC_WORKER_PATH=/app/lib/dex-meteora-dbc/worker/worker.mjs`. It does not depend on
the build machine's source path or host `node_modules`.
