ARG VALIDATION_IMAGE=adapter-validation
FROM ${VALIDATION_IMAGE}
# The build context is the trusted policy checkout, never the pull request.
COPY . /policy
WORKDIR /policy
RUN cargo test --locked -p simulator --features test-bpf --test test_all --no-run --message-format=json > /tmp/build.jsonl \
    && python3 ci/install_verifier.py /tmp/build.jsonl /verifier/replay
WORKDIR /verifier
ENTRYPOINT ["/verifier/replay", "cases::test_swap_from_dump::test_admission_replay", "--exact", "--nocapture"]
