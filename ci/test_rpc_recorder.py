import base64
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from rpc_recorder import Recorder, Rejected, Upstream, make_server

SYSTEM = "11111111111111111111111111111111"
MINT = "So11111111111111111111111111111111111111112"
TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"


def account(value=3, owner=TOKEN):
    return {"lamports": value, "owner": owner, "executable": False, "rentEpoch": 2**64 - 1,
            "data": [base64.b64encode(bytes([value])).decode(), "base64"]}


def request(method, params=None):
    return {"jsonrpc": "2.0", "id": 17, "method": method, "params": params or []}


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "capture.json"

    def recorder(self, handler, **options):
        return Recorder(handler, self.path, **options)

    def test_rust_rpc_version_handshake_is_read_only_and_has_no_parameters(self):
        recorder = self.recorder(lambda method, params: {"solana-core": "3.0.0", "feature-set": 1})
        self.assertEqual(recorder.request({"jsonrpc": "2.0", "id": 1, "method": "getVersion", "params": None})["result"]["solana-core"], "3.0.0")
        with self.assertRaises(Rejected):
            recorder.request(request("getVersion", [{"url": "http://invalid"}]))

    def test_first_complete_account_read_is_immutable_and_persisted(self):
        calls = []
        def rpc(method, params):
            calls.append((method, params))
            return {"context": {"slot": len(calls)}, "value": account(len(calls))}
        recorder = self.recorder(rpc)
        first = recorder.request(request("getAccountInfo", [MINT]))
        second = recorder.request(request("getAccountInfo", [MINT, {"encoding": "base64"}]))
        self.assertEqual(first, second)
        self.assertEqual(calls[0][1][1]["encoding"], "base64")
        recorder.finish()
        snapshot = json.loads(self.path.read_text())
        self.assertEqual(snapshot["accounts"][MINT], {"slot": 1, "account": account(1)})
        self.assertTrue(snapshot["complete"])
        self.assertFalse(snapshot["failed"])
        self.assertEqual(snapshot["requestCount"], 2)

    def test_multiple_accounts_preserves_order_null_and_first_values(self):
        values = [None, account()]
        recorder = self.recorder(lambda *_: {"context": {"slot": 4}, "value": copy.deepcopy(values)})
        result = recorder.request(request("getMultipleAccounts", [[SYSTEM, MINT]]))
        self.assertEqual(result["result"]["value"], values)
        values[:] = [account(), account(4)]
        repeated = recorder.request(request("getMultipleAccounts", [[SYSTEM, MINT]]))
        self.assertEqual(repeated["result"]["value"], [None, account()])
        snapshot = json.loads(self.path.read_text())
        self.assertIn(SYSTEM, snapshot["accounts"])
        self.assertIsNone(snapshot["accounts"][SYSTEM]["account"])

    def test_program_accounts_record_keys_slots_and_restore_requested_shape(self):
        calls = []
        def rpc(method, params):
            calls.append(params)
            return {"context": {"slot": 99}, "value": [{"pubkey": MINT, "account": account(owner=TOKEN)}]}
        recorder = self.recorder(rpc)
        result = recorder.request(request("getProgramAccounts", [TOKEN, {"filters": [{"dataSize": 82}]}]))
        self.assertTrue(calls[0][1]["withContext"])
        self.assertIsInstance(result["result"], list)
        contextual = recorder.request(request("getProgramAccounts", [TOKEN, {"withContext": True}]))
        self.assertEqual(contextual["result"]["context"]["slot"], 99)
        self.assertEqual(json.loads(self.path.read_text())["accounts"][MINT]["slot"], 99)

    def test_rust_rpc_optional_null_fields_still_request_full_accounts(self):
        calls = []
        def rpc(_, params):
            calls.append(params)
            return {"context": {"slot": 1}, "value": []}
        recorder = self.recorder(rpc)
        recorder.request(request("getProgramAccounts", [TOKEN, {"encoding": None, "dataSlice": None,
                         "minContextSlot": None, "filters": None, "withContext": None}]))
        self.assertEqual(calls, [[TOKEN, {"encoding": "base64", "withContext": True}]])

    def test_unknown_methods_send_and_sliced_or_parsed_accounts_never_reach_upstream(self):
        bad = [request("sendTransaction", ["bytes"]), request("requestAirdrop", [MINT, 1]),
               request("simulateTransaction", ["bytes"]), request("getBalance", [MINT]),
               request("getAccountInfo", [MINT, {"dataSlice": {"offset": 0, "length": 1}}]),
               request("getAccountInfo", [MINT, {"encoding": "jsonParsed"}]),
               request("getAccountInfo", ["http://candidate.invalid"]),
               request("getMultipleAccounts", [[MINT] * 101]),
               [request("getSlot")], request("getSlot", [{"upstream": "http://candidate.invalid"}])]
        for body in bad:
            with self.subTest(body=body):
                def forbidden(*_):
                    self.fail("rejected candidate request reached the upstream")
                recorder = self.recorder(forbidden)
                with self.assertRaises((Rejected, TypeError)):
                    recorder.request(body)
                self.assertTrue(json.loads(self.path.read_text())["failed"])

    def test_malformed_or_partial_upstream_data_is_a_failed_capture(self):
        malformed = [None, {"value": account()}, {"context": {"slot": 1}, "value": {**account(), "data": ["???", "base64"]}},
                     {"context": {"slot": 1}, "value": {**account(), "lamports": -1}},
                     {"context": {"slot": True}, "value": account()}]
        for result in malformed:
            with self.subTest(result=result):
                recorder = self.recorder(lambda *_: result)
                with self.assertRaises(Rejected):
                    recorder.request(request("getAccountInfo", [MINT]))
                self.assertEqual(json.loads(self.path.read_text())["accounts"], {})
                self.assertTrue(json.loads(self.path.read_text())["failed"])
        recorder = self.recorder(lambda *_: {"context": {"slot": 1}, "value": []})
        with self.assertRaises(Rejected):
            recorder.request(request("getMultipleAccounts", [[MINT]]))

    def test_program_accounts_cannot_substitute_owner_or_duplicate_key(self):
        for values in [[{"pubkey": MINT, "account": account(owner=SYSTEM)}],
                       [{"pubkey": MINT, "account": account()}] * 2]:
            recorder = self.recorder(lambda *_: {"context": {"slot": 1}, "value": values})
            with self.assertRaises(Rejected):
                recorder.request(request("getProgramAccounts", [TOKEN]))

    def test_request_runtime_and_snapshot_budgets_fail_closed(self):
        recorder = self.recorder(lambda *_: 1, max_requests=1)
        recorder.request(request("getSlot"))
        with self.assertRaises(Rejected):
            recorder.request(request("getSlot"))
        recorder = self.recorder(lambda *_: 1, max_seconds=-1)
        with self.assertRaises(Rejected):
            recorder.request(request("getSlot"))
        recorder = self.recorder(lambda *_: {"context": {"slot": 1}, "value": account()}, max_snapshot=1)
        with self.assertRaises(Rejected):
            recorder.request(request("getAccountInfo", [MINT]))
        self.assertEqual(json.loads(self.path.read_text())["accounts"], {})

    def test_http_boundary_does_not_disclose_upstream_failures(self):
        def failing(*_):
            raise RuntimeError("https://secret.example?api-key=DO_NOT_DISCLOSE")
        recorder = self.recorder(failing)
        server = make_server(("127.0.0.1", 0), recorder)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            body = json.dumps(request("getSlot")).encode()
            req = Request(f"http://127.0.0.1:{server.server_port}/", data=body, headers={"Content-Type": "application/json"})
            with self.assertRaises(HTTPError) as rejected:
                urlopen(req, timeout=2)
            response = rejected.exception.read().decode()
            rejected.exception.close()
            self.assertNotIn("secret", response)
            self.assertNotIn("DO_NOT_DISCLOSE", response)
            self.assertIn("rejected", response)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()
        recorder.finish()
        self.assertTrue(json.loads(self.path.read_text())["failed"])

    def test_http_body_limit_stops_candidate_before_rpc(self):
        def forbidden(*_):
            self.fail("oversized request reached upstream")
        recorder = self.recorder(forbidden)
        server = make_server(("127.0.0.1", 0), recorder, max_request=32)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            req = Request(f"http://127.0.0.1:{server.server_port}/", data=b"x" * 33)
            with self.assertRaises(HTTPError) as rejected:
                urlopen(req, timeout=2)
            rejected.exception.close()
            self.assertTrue(json.loads(self.path.read_text())["failed"])
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_real_upstream_transport_rejects_redirect_size_and_time_overruns(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                if self.path == "/slow":
                    time.sleep(0.2)
                body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": 44}).encode()
                self.send_response(302 if self.path == "/redirect" else 200)
                self.send_header("Location", "http://untrusted.invalid")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            self.assertEqual(Upstream(origin, 1, 1024)("getSlot", []), 44)
            for path, timeout, size in [("/redirect", 1, 1024), ("/", 1, 8), ("/slow", 0.03, 1024)]:
                with self.subTest(path=path), self.assertRaises(Rejected):
                    Upstream(origin + path, timeout, size)("getSlot", [])
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
