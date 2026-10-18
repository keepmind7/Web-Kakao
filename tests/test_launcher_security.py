"""Launcher trust boundary: impostor ports, stale runtime records, env allowlist and ACL warning. No 8787, no network."""
import contextlib
import hashlib
import hmac
import http.server
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from tools import local_web

TOKEN = "5" * 64


class Fake(http.server.BaseHTTPRequestHandler):
    honest = True
    seen = []

    def do_GET(self):
        type(self).seen.append((self.path, self.headers.get("X-Local-Control")))
        if self.path.startswith("/api/local/challenge?nonce="):
            nonce = self.path.rsplit("=", 1)[1]
            key = TOKEN if self.honest else "6" * 64
            body = {"app": local_web.APP, "proof": hmac.new(key.encode(), b"web-kakao-launcher-challenge\0" + nonce.encode(), hashlib.sha256).hexdigest()}
        else:
            body = {"app": local_web.APP, "build": 8, "mode": "mock", "phase": "idle"}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class LauncherSecurityTests(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).resolve().parents[1] / "local-only/qa-adversarial-20261017/fixtures"
        output.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="launcher-sec-", dir=output)
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        for patcher in [patch.object(local_web, "FOLDER", self.folder), patch.object(local_web, "verify_private_file", lambda *a, **k: True)]:
            patcher.start()
            self.addCleanup(patcher.stop)
        Fake.seen = []

    def serve(self, honest):
        handler = type("Handler", (Fake,), {"honest": honest})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = "http://127.0.0.1:%d" % server.server_address[1]
        (self.folder / "runtime.json").write_text(json.dumps({"app": local_web.APP, "url": url, "mode": "mock", "pid": 4242, "controlToken": TOKEN}), encoding="utf-8")
        return url

    def run_main(self, *args):
        with patch.object(sys, "argv", ["local_web.py", *args]), contextlib.redirect_stdout(io.StringIO()) as output:
            return local_web.main(), output.getvalue()

    def test_impostor_without_proof_never_receives_the_raw_token(self):
        self.serve(honest=False)
        with patch.object(local_web, "listener_matches"):
            with self.assertRaises(local_web.UntrustedServer):
                local_web.connect()
        self.assertEqual(len(Fake.seen), 1)
        self.assertTrue(all(header is None for _, header in Fake.seen))

    def test_honest_server_receives_token_only_after_proof(self):
        url = self.serve(honest=True)
        with patch.object(local_web, "listener_matches") as listener:
            self.assertEqual(local_web.connect()[0], url)
        listener.assert_called_once()
        self.assertIsNone(Fake.seen[0][1])
        self.assertEqual(Fake.seen[1], ("/api/local/status", TOKEN))

    def test_open_and_stop_refuse_when_port_owner_differs(self):
        self.serve(honest=True)
        for action in ["open", "stop"]:
            with self.subTest(action=action), patch.object(local_web, "listener_matches", side_effect=local_web.UntrustedServer("경고: 사칭")), \
                    patch.object(local_web.webbrowser, "open") as browser:
                code, output = self.run_main(action)
                self.assertEqual(code, 2)
                self.assertIn("경고", output)
                browser.assert_not_called()
        self.assertEqual(Fake.seen, [])

    def test_stale_runtime_is_not_trusted_for_stop(self):
        self.serve(honest=True)
        with patch.object(local_web, "listener_matches", side_effect=local_web.StaleRuntime("비정상 종료")):
            code, output = self.run_main("stop")
        self.assertEqual(code, 2)
        self.assertIn("비정상 종료", output)
        self.assertTrue((self.folder / "runtime.json").exists())

    def test_listener_pid_and_executable_must_match(self):
        node = os.path.realpath(local_web.RUNTIME)
        cases = [({4242}, node, None), ({999}, node, local_web.UntrustedServer), ({4242}, "C:\\evil\\node.exe", local_web.UntrustedServer),
                 (set(), "", local_web.StaleRuntime), ({4242, 999}, node, local_web.UntrustedServer)]
        for owners, path, error in cases:
            with self.subTest(owners=owners, path=path), patch.object(local_web.os, "name", "nt"), \
                    patch.object(local_web, "listener_owners", return_value=owners), patch.object(local_web, "process_image", return_value=path):
                if error:
                    with self.assertRaises(error):
                        local_web.listener_matches(1234, 4242)
                else:
                    local_web.listener_matches(1234, 4242)
        with patch.object(local_web, "listener_owners", return_value={4242}), \
                patch.object(local_web, "process_image", side_effect=PermissionError("synthetic access denied")):
            with self.assertRaisesRegex(local_web.UntrustedServer, "권한"):
                local_web.listener_matches(1234, 4242)

    def test_start_passes_allowlisted_env_and_warns_on_broad_acl(self):
        process = Mock()
        process.poll.return_value = 1
        hostile = {"NODE_OPTIONS": "--require x", "NODE_TLS_REJECT_UNAUTHORIZED": "0", "NODE_EXTRA_CA_CERTS": "x.pem", "HTTPS_PROXY": "http://x", "KAKAO_X": "1"}
        with patch.dict(os.environ, hostile), patch.object(local_web, "ensure_private_directory"), \
                patch.object(local_web.socket, "create_connection", side_effect=ConnectionRefusedError), \
                patch.object(local_web, "broad_write_warnings", return_value=[local_web.ROOT]), \
                patch.object(local_web.subprocess, "Popen", return_value=process) as popen:
            code, output = self.run_main("start", "--mock", "--port", "1")
        self.assertEqual(code, 2)
        env = popen.call_args.kwargs["env"]
        for key in hostile:
            self.assertNotIn(key, env)
        self.assertIn("PATH", {key.upper() for key in env})
        self.assertIn("넓은 쓰기 권한", output)
        self.assertIn("workspace_acl.ps1", output)

    def test_broad_write_parser_ignores_read_only_and_deny(self):
        sample = ("X BUILTIN\\Users:(I)(OI)(CI)(RX)\n  Everyone:(DENY)(W)\n  NT AUTHORITY\\Authenticated Users:(I)(M)\n").encode()
        with patch.object(local_web.subprocess, "run", return_value=Mock(stdout=sample)):
            self.assertEqual(len(local_web.broad_write_warnings()), 4)
        with patch.object(local_web.subprocess, "run", return_value=Mock(stdout=b"X BUILTIN\\Users:(I)(OI)(CI)(RX)\n  Everyone:(DENY)(W)\n")):
            self.assertEqual(local_web.broad_write_warnings(), [])


if __name__ == "__main__":
    unittest.main()
