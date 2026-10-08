FROM --platform=linux/amd64 node:22-bookworm-slim AS node
# OpenBook v0.2.7's account layout requires the pre-1.77 x86 u128 ABI.
FROM --platform=linux/amd64 rust:1.76.0-bookworm AS base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
RUN cargo install cargo-chef@0.1.62 --locked
RUN rustup component add rustfmt
RUN apt-get update && apt-get install -y --no-install-recommends clang cmake ssh protobuf-compiler libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS plan
COPY . .
WORKDIR /app
RUN cargo chef prepare --recipe-path recipe.json

FROM base as build
COPY --from=plan /app/recipe.json recipe.json
RUN cargo chef cook --release --locked --package autobahn-router --recipe-path recipe.json
COPY . .
RUN npm ci --prefix lib/dex-meteora-dbc/worker --ignore-scripts --omit=dev --no-audit --no-fund
RUN cargo build --locked --release --bin autobahn-router

FROM --platform=linux/amd64 debian:bookworm-slim AS run
ARG CONFIG_PATH=/app/bin/autobahn-router/template-config.toml
RUN apt-get update && apt-get -y install --no-install-recommends ca-certificates libc6 libstdc++6 libssl3 openssl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/target/release/autobahn-router /usr/local/bin/
COPY --from=build $CONFIG_PATH /usr/local/bin/template-config.toml
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/lib/dex-meteora-dbc/worker /app/lib/dex-meteora-dbc/worker
ENV DBC_WORKER_PATH=/app/lib/dex-meteora-dbc/worker/worker.mjs

RUN adduser --system --group --no-create-home mangouser
USER mangouser
