# Separate native and SBF toolchains: OpenBook's native layout needs Rust 1.76,
# while this pinned SBF compiler handles program ELF generation only.
FROM --platform=linux/amd64 rust:1.85.1-bookworm AS host-rust
FROM --platform=linux/amd64 ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 python3 build-essential clang cmake pkg-config libssl-dev libudev-dev git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=host-rust /usr/local/cargo /usr/local/cargo
COPY --from=host-rust /usr/local/rustup /usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup
ENV PATH=/usr/local/cargo/bin:/opt/solana-release/bin:${PATH}
# Verify the exact official release archives, not a mutable installer script.
RUN curl -fsSL https://github.com/anza-xyz/agave/releases/download/v4.3.0/solana-release-x86_64-unknown-linux-gnu.tar.bz2 -o /tmp/agave.tar.bz2 \
    && echo 'c97289a8abb1d0efb497d8b5cb285baabd9b7f8ea6647f5d145c5dc8ff3611e8  /tmp/agave.tar.bz2' | sha256sum -c - \
    && tar -xjf /tmp/agave.tar.bz2 -C /opt solana-release/bin/cargo-build-sbf \
    && rm /tmp/agave.tar.bz2
RUN mkdir -p /root/.cache/solana/v1.57/platform-tools \
    && curl -fsSL https://github.com/anza-xyz/platform-tools/releases/download/v1.57/platform-tools-linux-x86_64.tar.bz2 -o /tmp/platform-tools.tar.bz2 \
    && echo 'b0f7af104adf726fff2a6a09ea2eb2f2d2965c92295f4d7388c08d140e0c2b00  /tmp/platform-tools.tar.bz2' | sha256sum -c - \
    && tar -xjf /tmp/platform-tools.tar.bz2 -C /root/.cache/solana/v1.57/platform-tools \
    && rm /tmp/platform-tools.tar.bz2
COPY ci/prepare_sbf.py /policy/ci/prepare_sbf.py
COPY ci/sbf-locks /policy/ci/sbf-locks
COPY programs/autobahn-executor /policy/programs/autobahn-executor
COPY programs/mock_swap /policy/programs/mock_swap
RUN python3 /policy/ci/prepare_sbf.py /policy /sbf
ENV CARGO_TARGET_DIR=/sbf-target
# ahash 0.8.5 probes the removed stdsimd feature on new nightly compilers.
# Restrict target features without altering the actual program or dependency.
ENV CARGO_TARGET_SBPF_SOLANA_SOLANA_RUSTFLAGS=-Zallow-features=specialization,min_specialization,core_intrinsics,auto_traits,negative_impls,proc_macro_hygiene
RUN cargo-build-sbf --tools-version v1.57 --skip-tools-install --arch v0 \
      --manifest-path /sbf/mock_swap/Cargo.toml --sbf-out-dir /sbf-output -- --locked \
    && cargo-build-sbf --tools-version v1.57 --skip-tools-install --arch v0 \
      --manifest-path /sbf/autobahn-executor/Cargo.toml --sbf-out-dir /sbf-output -- --locked
