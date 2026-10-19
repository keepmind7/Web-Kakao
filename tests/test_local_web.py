import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from tools import local_web


class ExistingServerModeTests(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).resolve().parents[1] / "local-only/qa-adversarial-20261017/fixtures"
        output.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="launcher-", dir=output)
        self.addCleanup(temporary.cleanup)
        isolation = patch.object(local_web, "FOLDER", Path(temporary.name))
        isolation.start()
        self.addCleanup(isolation.stop)

    def invoke(self, existing_gap, requested_gap):
        state = {"app": local_web.APP, "build": 8, "mode": "live", "photoTransport": "https", "gapProbe": existing_gap,
                 "phase": "authenticated", "credentialInMemory": True}
        args = ["local_web.py", "start"] + (["--gap-probe"] if requested_gap else [])
        with patch.object(sys, "argv", args), patch.object(local_web, "connect",
                return_value=("http://127.0.0.1:8787", object(), state)), patch.object(
                local_web.subprocess, "Popen", side_effect=AssertionError("must preserve existing server")):
            with contextlib.redirect_stdout(io.StringIO()):
                result = local_web.main()
        self.assertTrue(state["credentialInMemory"])
        self.assertEqual(state["phase"], "authenticated")
        return result

    def test_mode_mismatch_never_restarts_or_reuses_the_wrong_active_mode(self):
        for existing, requested in [(True, False), (False, True)]:
            with self.subTest(existing=existing, requested=requested):
                self.assertEqual(self.invoke(existing, requested), 2)

    def test_same_mode_reuses_the_active_server_without_new_authentication(self):
        for gap in [True, False]:
            with self.subTest(gap=gap):
                self.assertEqual(self.invoke(gap, gap), 0)

    def test_status_prints_control_allowlist_without_browser_or_auth_fields(self):
        state = {"build": 8, "mode": "live", "phase": "authenticated", "csrf": "SYNTHETIC",
                 "grid": [[True]], "passcode": "0000", "controlToken": "SYNTHETIC"}
        client = Mock()
        with patch.object(local_web, "connect", return_value=("http://127.0.0.1:1", client, state)), \
             patch.object(sys, "argv", ["local_web.py", "status"]), \
             patch.object(local_web.webbrowser, "open") as browser, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(local_web.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {"url": "http://127.0.0.1:1", "build": 8,
                                                       "mode": "live", "phase": "authenticated"})
        client.open.assert_not_called()
        browser.assert_not_called()

    def test_open_issues_ticket_and_opens_fragment_without_printing_it(self):
        url, ticket = "http://127.0.0.1:1", "7" * 64
        client = Mock()
        client.open.return_value = io.BytesIO(json.dumps({"ticket": ticket}).encode())
        with patch.object(local_web, "connect", return_value=(url, client, {"build": 8})), \
             patch.object(sys, "argv", ["local_web.py", "open"]), \
             patch.object(local_web.webbrowser, "open") as browser, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(local_web.main(), 0)
        req = client.open.call_args.args[0]
        self.assertEqual(req.full_url, url + "/api/local/launch")
        self.assertEqual(req.method, "POST")
        self.assertEqual(req.data, b"{}")
        self.assertEqual(req.get_header("Origin"), url)
        self.assertEqual(req.get_header("Content-type"), "application/json")
        browser.assert_called_once_with(url + "/launch#launch=" + ticket)
        self.assertNotIn(ticket, output.getvalue())

    def test_attempt_and_probe_use_control_routes_with_origin_and_json(self):
        url = "http://127.0.0.1:1"
        for action, path in [("attempt", "start"), ("probe", "room-probe")]:
            with self.subTest(action=action):
                client = Mock()
                client.open.return_value = io.BytesIO(b'{"build":8,"mode":"mock","phase":"idle"}')
                with patch.object(local_web, "connect", return_value=(url, client, {"build": 8})), \
                     patch.object(sys, "argv", ["local_web.py", action]), \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(local_web.main(), 0)
                req = client.open.call_args.args[0]
                self.assertEqual(req.full_url, url + "/api/local/control/" + path)
                self.assertEqual(req.method, "POST")
                self.assertEqual(req.data, b"{}")
                self.assertEqual(req.get_header("Origin"), url)
                self.assertEqual(req.get_header("Content-type"), "application/json")
                self.assertIsNone(req.get_header("X-csrf-token"))


class PhotoTransportLauncherTests(unittest.TestCase):
    setUp = ExistingServerModeTests.setUp

    def test_running_photo_mode_mismatch_is_preserved_without_restart(self):
        for existing, requested in [("loco", "https-experimental"), ("https-experimental", "loco")]:
            state = {"build": 8, "mode": "live", "photoTransport": existing,
                     "phase": "authenticated", "credentialInMemory": True}
            with self.subTest(existing=existing), patch.object(local_web, "connect", return_value=("http://127.0.0.1:1", Mock(), state)), \
                 patch.object(sys, "argv", ["local_web.py", "start", "--photo-transport", requested]), \
                 patch.object(local_web.subprocess, "Popen") as spawn, \
                 patch.object(local_web.webbrowser, "open") as browser, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(local_web.main(), 2)
                spawn.assert_not_called()
                browser.assert_not_called()
                self.assertTrue(state["credentialInMemory"])
                self.assertEqual(state["phase"], "authenticated")

    def test_same_photo_mode_and_legacy_default_reuse_without_starting(self):
        for mode, requested in [(None, "loco"), ("loco", "loco"), ("https", None), ("https-experimental", None), ("https", "https-experimental"), ("https-experimental", "https")]:
            state = {"build": 8, "mode": "live", "phase": "authenticated"}
            if mode is not None:
                state["photoTransport"] = mode
            args = ["local_web.py", "start"] + (["--photo-transport", requested] if requested else [])
            with self.subTest(mode=mode), patch.object(local_web, "connect", return_value=("http://127.0.0.1:1", Mock(), state)), \
                 patch.object(sys, "argv", args), patch.object(local_web.subprocess, "Popen") as spawn, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(local_web.main(), 0)
                spawn.assert_not_called()

    def test_start_forwards_explicit_photo_mode_and_does_not_inherit_unsafe_environment(self):
        runtime = local_web.FOLDER / "synthetic-node.exe"
        runtime.write_bytes(b"synthetic-not-executable")
        for mode in [None, "https", "loco", "https-experimental"]:
            expected = "https" if mode in (None, "https-experimental") else mode
            state = {"build": 8, "mode": "live", "photoTransport": expected}
            process = Mock(pid=12345)
            process.poll.return_value = None
            with self.subTest(mode=mode), patch.object(local_web, "RUNTIME", runtime), \
                 patch.object(local_web, "connect", side_effect=[FileNotFoundError(), ("http://127.0.0.1:1", Mock(), state)]), \
                 patch.object(local_web, "assert_port_available"), patch.object(local_web, "ensure_private_directory"), \
                 patch.object(local_web, "verify_private_file"), patch.object(local_web, "broad_write_warnings", return_value=[]), \
                 patch.object(local_web.subprocess, "Popen", return_value=process) as spawn, \
                 patch.dict(local_web.os.environ, {"KAKAO_PHOTO_TRANSPORT": "untrusted", "NODE_OPTIONS": "untrusted", "HTTPS_PROXY": "untrusted"}), \
                 patch.object(sys, "argv", ["local_web.py", "start"] + (["--photo-transport", mode] if mode else [])), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(local_web.main(), 0)
                command = spawn.call_args.args[0]
                self.assertEqual(command[command.index("--photo-transport") + 1], expected)
                environment = spawn.call_args.kwargs["env"]
                for key in ["KAKAO_PHOTO_TRANSPORT", "NODE_OPTIONS", "HTTPS_PROXY"]:
                    self.assertNotIn(key, environment)
                self.assertEqual(spawn.call_args.kwargs["creationflags"], local_web.subprocess.CREATE_NO_WINDOW)

    def test_status_includes_mode_without_authentication_values(self):
        state = {"build": 8, "mode": "live", "photoTransport": "https-experimental",
                 "csrf": "PRIVATE_SYNTHETIC", "accessToken": "PRIVATE_SYNTHETIC", "grid": [[True]]}
        with patch.object(local_web, "connect", return_value=("http://127.0.0.1:1", Mock(), state)), \
             patch.object(sys, "argv", ["local_web.py", "status"]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(local_web.main(), 0)
            self.assertEqual(json.loads(output.getvalue()), {"url": "http://127.0.0.1:1", "build": 8, "mode": "live", "photoTransport": "https-experimental"})
            self.assertNotIn("PRIVATE_SYNTHETIC", output.getvalue())

    def test_invalid_photo_mode_is_rejected_before_connect_or_spawn(self):
        with patch.object(sys, "argv", ["local_web.py", "start", "--photo-transport", "untrusted"]), \
             patch.object(local_web, "connect") as connect, patch.object(local_web.subprocess, "Popen") as spawn, \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                local_web.main()
            self.assertEqual(error.exception.code, 2)
            connect.assert_not_called()
            spawn.assert_not_called()

    def test_default_start_preserves_an_existing_legacy_or_unknown_mode_server(self):
        for mode in [None, "loco", "unknown"]:
            state = {"build": 8, "mode": "live", "phase": "authenticated", "credentialInMemory": True}
            if mode is not None:
                state["photoTransport"] = mode
            with self.subTest(mode=mode), patch.object(sys, "argv", ["local_web.py", "start"]), \
                 patch.object(local_web, "connect", return_value=("http://127.0.0.1:1", Mock(), state)), \
                 patch.object(local_web.subprocess, "Popen") as spawn, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(local_web.main(), 2)
                spawn.assert_not_called()
                self.assertTrue(state["credentialInMemory"])

    def test_photo_mode_missing_value_is_rejected_before_accessing_server(self):
        with patch.object(sys, "argv", ["local_web.py", "start", "--photo-transport"]), \
             patch.object(local_web, "connect") as connect, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                local_web.main()
            self.assertEqual(error.exception.code, 2)
            connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
