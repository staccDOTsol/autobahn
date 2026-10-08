FROM adapter-sbf AS programs
FROM adapter-validation
# Both source and generated ELFs are trusted policy artifacts, never PR outputs.
COPY . /policy
COPY --from=programs /sbf-output/autobahn_executor.so /verifier/programs/autobahn_executor.so
COPY --from=programs /sbf-output/mock_swap.so /verifier/programs/mock_swap.so
WORKDIR /policy
RUN cargo test --locked -p autobahn-executor --features test-bpf --test test_all --no-run --message-format=json > /tmp/executor.jsonl \
    && python3 ci/install_verifier.py /tmp/executor.jsonl /verifier/executor executor
WORKDIR /verifier
ENV BPF_OUT_DIR=/verifier/programs
ENTRYPOINT ["/verifier/executor", "--nocapture"]
