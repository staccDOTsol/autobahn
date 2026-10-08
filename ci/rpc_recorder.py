#!/usr/bin/env python3
"""Trusted, bounded read-only Solana RPC recorder for isolated adapter admission.

Run outside the candidate container. Only this process can write --snapshot.
RPC_UPSTREAM is read here, never included in responses, logs or the snapshot.
Stop with SIGTERM after capture; the verifier must require complete and !failed.
"""
import argparse
import base64
import copy
import json
import os
from pathlib import Path
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection, HTTPSConnection
from urllib.parse import urlsplit

ALLOWED_METHODS = frozenset({
    "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getSlot",
    "getBlockTime", "getEpochInfo", "getLatestBlockhash", "getVersion",
})
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
MAX_U64 = 2**64 - 1


class Rejected(ValueError):
    pass


def integer(value, maximum=MAX_U64):
    if type(value) is not int or not 0 <= value <= maximum:
        raise Rejected("invalid unsigned integer")
    return value


def pubkey(value):
    if not isinstance(value, str) or not 32 <= len(value) <= 44:
        raise Rejected("invalid public key")
    number = 0
    for char in value:
        if char not in ALPHABET:
            raise Rejected("invalid public key")
        number = number * 58 + ALPHABET.index(char)
    leading = len(value) - len(value.lstrip("1"))
    if leading + (number.bit_length() + 7) // 8 != 32:
        raise Rejected("invalid public key")
    return value


def parse_json(raw):
    def invalid(_):
        raise Rejected("non-finite JSON number")
    return json.loads(raw, parse_constant=invalid)


def config(value, account=False, program=False):
    if not isinstance(value, dict):
        raise Rejected("RPC config must be an object")
    # Solana Rust 1.17 serializes unset optional fields as null. Null dataSlice
    # means full data; a non-null slice must still be rejected.
    nullable = {"commitment", "minContextSlot"}
    if account:
        nullable.update({"encoding", "dataSlice"})
    if program:
        nullable.update({"filters", "withContext"})
    value = {key: item for key, item in value.items() if item is not None or key not in nullable}
    allowed = {"commitment", "minContextSlot"}
    if account:
        allowed.add("encoding")
    if program:
        allowed.update({"withContext", "filters"})
    if set(value) - allowed:
        raise Rejected("unsupported RPC config; full account data is required")
    result = copy.deepcopy(value)
    if "commitment" in value and value["commitment"] not in {"processed", "confirmed", "finalized"}:
        raise Rejected("invalid commitment")
    if "minContextSlot" in value:
        integer(value["minContextSlot"])
    if account:
        if value.get("encoding", "base64") != "base64":
            raise Rejected("only complete base64 account encoding is accepted")
        result["encoding"] = "base64"
    if program:
        if "withContext" in value and type(value["withContext"]) is not bool:
            raise Rejected("invalid withContext")
        result["withContext"] = True
        filters = value.get("filters", [])
        if not isinstance(filters, list) or len(filters) > 8:
            raise Rejected("invalid account filters")
        for item in filters:
            if not isinstance(item, dict) or len(item) != 1:
                raise Rejected("invalid account filter")
            if "dataSize" in item:
                integer(item["dataSize"], 10 * 1024 * 1024)
            elif "memcmp" in item:
                mem = item["memcmp"]
                if not isinstance(mem, dict) or set(mem) - {"offset", "bytes", "encoding"} or not {"offset", "bytes"} <= set(mem):
                    raise Rejected("invalid memcmp filter")
                integer(mem["offset"], 10 * 1024 * 1024)
                if not isinstance(mem["bytes"], str) or len(mem["bytes"]) > 512 or mem.get("encoding", "base58") not in {"base58", "base64"}:
                    raise Rejected("invalid memcmp bytes")
            else:
                raise Rejected("unsupported account filter")
    return result


def validate_request(body):
    if not isinstance(body, dict) or set(body) - {"jsonrpc", "id", "method", "params"} or body.get("jsonrpc") != "2.0":
        raise Rejected("one JSON-RPC 2.0 request is required")
    ident = body.get("id")
    if not (ident is None or type(ident) is int and 0 <= ident <= MAX_U64 or isinstance(ident, str) and len(ident) <= 128):
        raise Rejected("invalid request id")
    method = body.get("method")
    if method not in ALLOWED_METHODS:
        raise Rejected("RPC method is not allowed")
    params = body.get("params", [])
    if params is None:
        params = []  # Rust Solana RPC represents no-argument calls as null.
    if not isinstance(params, list):
        raise Rejected("RPC params must be an array")
    params = copy.deepcopy(params)
    if method in {"getAccountInfo", "getMultipleAccounts", "getProgramAccounts"}:
        if not 1 <= len(params) <= 2:
            raise Rejected("invalid account RPC parameters")
        if method == "getMultipleAccounts":
            if not isinstance(params[0], list) or not 1 <= len(params[0]) <= 100:
                raise Rejected("getMultipleAccounts requires 1..100 public keys")
            for key in params[0]:
                pubkey(key)
        else:
            pubkey(params[0])
        original_config = params[1] if len(params) > 1 else {}
        canonical_config = config(original_config, account=True, program=method == "getProgramAccounts")
        params = [params[0], canonical_config]
        wants_context = original_config.get("withContext", False)
    elif method == "getVersion":
        if params:
            raise Rejected("getVersion takes no parameters")
        wants_context = False
    elif method == "getBlockTime":
        if len(params) != 1:
            raise Rejected("getBlockTime requires one slot")
        integer(params[0])
        wants_context = False
    else:
        if len(params) > 1:
            raise Rejected("invalid RPC parameters")
        params = [config(params[0])] if params else []
        wants_context = False
    return ident, method, params, wants_context


def canonical_account(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise Rejected("upstream returned malformed account")
    data = value.get("data")
    if not isinstance(data, list) or len(data) != 2 or data[1] != "base64" or not isinstance(data[0], str):
        raise Rejected("upstream did not return full base64 account data")
    try:
        decoded = base64.b64decode(data[0], validate=True)
    except (ValueError, TypeError):
        raise Rejected("upstream returned invalid base64") from None
    if len(decoded) > 10 * 1024 * 1024:
        raise Rejected("upstream account exceeds Solana account size")
    if type(value.get("executable")) is not bool:
        raise Rejected("invalid account executable flag")
    return {"lamports": integer(value.get("lamports")), "owner": pubkey(value.get("owner")),
            "executable": value["executable"], "rentEpoch": integer(value.get("rentEpoch")),
            "data": [base64.b64encode(decoded).decode("ascii"), "base64"]}


class Upstream:
    def __init__(self, url, timeout, max_response):
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise Rejected("invalid configured RPC upstream")
        self.parsed, self.timeout, self.max_response = parsed, timeout, max_response

    def __call__(self, method, params):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        connection_type = HTTPSConnection if self.parsed.scheme == "https" else HTTPConnection
        connection = connection_type(self.parsed.hostname, self.parsed.port, timeout=self.timeout)
        deadline = time.monotonic() + self.timeout
        def remaining():
            budget = deadline - time.monotonic()
            if budget <= 0:
                raise Rejected("upstream request deadline exceeded")
            return budget
        try:
            connection.connect()
            transport = connection.sock
            transport.settimeout(remaining())
            path = self.parsed.path or "/"
            if self.parsed.query:
                path += "?" + self.parsed.query
            connection.request("POST", path, body=body, headers={"Content-Type": "application/json"})
            transport.settimeout(remaining())
            response = connection.getresponse()
            if response.status != 200:
                raise Rejected("upstream returned unsuccessful status")
            raw = bytearray()
            while True:
                transport.settimeout(remaining())
                chunk = response.read1(min(65536, self.max_response + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > self.max_response:
                    raise Rejected("upstream response exceeds limit")
                if response.isclosed():
                    break
            result = parse_json(raw)
            if not isinstance(result, dict) or result.get("jsonrpc") != "2.0" or "error" in result or "result" not in result:
                raise Rejected("upstream RPC failed")
            return result["result"]
        except Exception:
            # No upstream URL, query token, response text or exception repr escapes.
            raise Rejected("upstream RPC unavailable or invalid") from None
        finally:
            connection.close()


class Recorder:
    def __init__(self, upstream, snapshot, max_requests=4096, max_snapshot=256 * 1024 * 1024, max_accounts=100_000, max_seconds=3600):
        self.upstream, self.snapshot = upstream, Path(snapshot)
        self.max_requests, self.max_snapshot, self.max_accounts = max_requests, max_snapshot, max_accounts
        self.deadline = time.monotonic() + max_seconds
        self.lock = threading.Lock()
        self.state = {"version": 1, "accounts": {}, "failed": False, "complete": False, "requestCount": 0}
        self._persist()

    def _persist(self):
        encoded = json.dumps(self.state, separators=(",", ":"), sort_keys=True).encode()
        self.snapshot.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.snapshot.with_name(self.snapshot.name + ".tmp")
        with open(temporary, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.snapshot)

    def fail(self):
        with self.lock:
            self.state["failed"] = True
            self._persist()

    def finish(self):
        with self.lock:
            self.state["complete"] = True
            self._persist()

    def request(self, body):
        try:
            ident, method, params, wants_context = validate_request(body)
            with self.lock:
                if self.state["failed"] or self.state["complete"]:
                    raise Rejected("recorder is no longer accepting requests")
                if time.monotonic() >= self.deadline or self.state["requestCount"] >= self.max_requests:
                    raise Rejected("RPC capture budget exhausted")
                self.state["requestCount"] += 1
            result = self.upstream(method, params)
            updates = {}
            if method in {"getAccountInfo", "getMultipleAccounts", "getProgramAccounts"}:
                if not isinstance(result, dict) or not isinstance(result.get("context"), dict) or "value" not in result:
                    raise Rejected("upstream account response has no context")
                slot = integer(result["context"].get("slot"))
                values = result["value"]
                if method == "getAccountInfo":
                    updates[params[0]] = {"slot": slot, "account": canonical_account(values)}
                elif method == "getMultipleAccounts":
                    if not isinstance(values, list) or len(values) != len(params[0]):
                        raise Rejected("upstream account response length mismatch")
                    updates = {key: {"slot": slot, "account": canonical_account(value)} for key, value in zip(params[0], values)}
                else:
                    if not isinstance(values, list) or len(values) > self.max_accounts:
                        raise Rejected("upstream program account response exceeds limit")
                    for item in values:
                        if not isinstance(item, dict):
                            raise Rejected("invalid upstream program account")
                        key = pubkey(item.get("pubkey"))
                        account = canonical_account(item.get("account"))
                        if key in updates or account is None or account["owner"] != params[0]:
                            raise Rejected("upstream program account owner/key mismatch")
                        updates[key] = {"slot": slot, "account": account}
            with self.lock:
                if self.state["failed"] or self.state["complete"]:
                    raise Rejected("capture ended during request")
                previous = self.state["accounts"]
                merged = {**previous}
                for key, value in updates.items():
                    if key not in merged:
                        merged[key] = value
                if len(merged) > self.max_accounts or len(json.dumps(merged, separators=(",", ":"))) > self.max_snapshot:
                    raise Rejected("recorded account snapshot exceeds limit")
                self.state["accounts"] = merged
                # The candidate sees exactly the first full state recorded for
                # each key, including a first read of an absent account. Repeated
                # RPC calls cannot produce an unrecorded newer fixture state.
                if updates:
                    slot = max(merged[key]["slot"] for key in updates)
                    if method == "getAccountInfo":
                        result = {"context": {"slot": slot}, "value": merged[params[0]]["account"]}
                    elif method == "getMultipleAccounts":
                        result = {"context": {"slot": slot}, "value": [merged[key]["account"] for key in params[0]]}
                    else:
                        values = [{"pubkey": key, "account": merged[key]["account"]} for key in updates
                                  if merged[key]["account"] is not None and merged[key]["account"]["owner"] == params[0]]
                        result = {"context": {"slot": slot}, "value": values} if wants_context else values
                elif method == "getProgramAccounts" and not wants_context:
                    result = result["value"]
                self._persist()
            return {"jsonrpc": "2.0", "id": ident, "result": result}
        except Exception:
            self.fail()
            raise


def make_server(address, recorder, max_request=64 * 1024, connections=8):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(25)

        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                length = self.headers.get("Content-Length", "")
                if self.path != "/" or not length.isdecimal() or not 0 < int(length) <= max_request or self.headers.get("Transfer-Encoding"):
                    raise Rejected("invalid RPC HTTP request")
                raw = self.rfile.read(int(length))
                if len(raw) != int(length):
                    raise Rejected("truncated RPC HTTP request")
                result = recorder.request(parse_json(raw))
                status = 200
            except Exception:
                recorder.fail()
                result = {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Read-only RPC capture rejected or upstream unavailable"}}
                status = 400
            encoded = json.dumps(result, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(encoded)

    class BoundedServer(ThreadingHTTPServer):
        daemon_threads = False
        def __init__(self):
            self.slots = threading.BoundedSemaphore(connections)
            super().__init__(address, Handler)
        def process_request(self, request, client_address):
            if not self.slots.acquire(blocking=False):
                recorder.fail()
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, client_address)
            except Exception:
                self.slots.release()
                raise
        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.slots.release()
    return BoundedServer()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8898)
    parser.add_argument("--max-seconds", type=int, default=3600)
    parser.add_argument("--max-requests", type=int, default=4096)
    parser.add_argument("--max-snapshot-bytes", type=int, default=256 * 1024 * 1024)
    args = parser.parse_args()
    if not 1 <= args.max_seconds <= 7200 or not 1 <= args.max_requests <= 100_000 or not 1024 <= args.max_snapshot_bytes <= 1024**3:
        parser.error("capture limits are outside supported bounds")
    upstream = Upstream(os.environ.get("RPC_UPSTREAM", "https://api.mainnet-beta.solana.com"), 20, 64 * 1024 * 1024)
    recorder = Recorder(upstream, args.snapshot, max_requests=args.max_requests, max_snapshot=args.max_snapshot_bytes, max_seconds=args.max_seconds)
    server = make_server((args.host, args.port), recorder)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    server.timeout = 0.5
    try:
        while not stopped.is_set() and time.monotonic() < recorder.deadline:
            server.handle_request()
        if not stopped.is_set():
            recorder.fail()
    finally:
        server.server_close()
        recorder.finish()


if __name__ == "__main__":
    main()
