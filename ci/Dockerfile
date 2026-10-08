FROM --platform=linux/amd64 node:22-bookworm-slim AS node
# OpenBook v0.2.7's persisted u128 fields require the pre-1.77 x86 ABI.
# Keep amd64 explicit: an old aarch64 compiler has the wrong account layout too.
FROM --platform=linux/amd64 rust:1.76.0-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
RUN apt-get update && apt-get install -y --no-install-recommends python3 clang cmake protobuf-compiler libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
ENV CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
WORKDIR /work
