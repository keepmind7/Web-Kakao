"""Synthetic storage/launcher contracts; never apply ACLs or read user data."""
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from tools import local_web

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "tools/private_storage.py"
NODE_PRIVATE = ROOT / "experiments/local-web/private-storage.mjs"
NODE = ROOT / "local-only/runtime/node-v24.21.0-win-x64/node.exe"
# WEB_KAKAO_STRICT=1 turns a missing prerequisite into a failure instead of a silent skip.
STRICT = os.environ.get("WEB_KAKAO_STRICT") == "1"


def load_private():
    spec = importlib.util.spec_from_file_location("synthetic_private_storage", PRIVATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_preferences(root):
    root.mkdir()
    (root / "identity.key").write_bytes(b"S" * 32)
    value = {"version": 1, "settings": {"persist": True, "notifications": False,
             "readSync": False, "roomFilter": "all"}, "rooms": {
             "b" * 64: {"title": "Synthetic alias", "pinOrder": 0, "muted": False}}}
    (root / ("a" * 64 + ".json")).write_text(json.dumps(value), encoding="utf-8")
    return value


class LauncherSecurityRegressionTests(unittest.TestCase):
    def test_connect_uses_control_status_without_public_cookie_bootstrap(self):
        # Neither urllib path can reach a socket; all input is in-memory fake.
        saved = {"app": local_web.APP, "url": "http://127.0.0.1:1", "pid": 1234,
                 "mode": "live", "controlToken": "7" * 64}
        state = {"app": local_web.APP, "build": 8, "mode": "live", "phase": "idle"}
        calls = []
        def opened(req, *args, **kwargs):
            address = req.full_url if hasattr(req, "full_url") else str(req)
            calls.append(address)
            if "/api/local/challenge?nonce=" in address:
                nonce = address.rsplit("=", 1)[1].encode()
                return io.BytesIO(json.dumps({"app": local_web.APP, "proof": hmac.new(b"7" * 64, b"web-kakao-launcher-challenge\0" + nonce, hashlib.sha256).hexdigest()}).encode())
            return io.BytesIO(json.dumps(state).encode())
        opener = Mock()
        opener.open.side_effect = opened
        with patch.object(Path, "read_text", return_value=json.dumps(saved)), \
             patch.object(local_web.request, "build_opener", return_value=opener), \
             patch.object(local_web.request, "urlopen", side_effect=opened), \
             patch.object(local_web, "listener_matches"),              patch("socket.socket", side_effect=AssertionError("real network forbidden")):
            local_web.connect()
        self.assertTrue(calls[0].startswith("http://127.0.0.1:1/api/local/challenge?nonce="))
        self.assertEqual(calls[1:], ["http://127.0.0.1:1/api/local/status"],
                         "launcher status must not obtain a browser cookie or CSRF")

    def test_runtime_permission_corruption_and_other_instance_errors_never_spawn(self):
        for failure in [PermissionError("synthetic denied"), ValueError("synthetic corrupt"),
                        KeyError("synthetic missing field")]:
            with self.subTest(kind=type(failure).__name__), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp)
                process = Mock()
                process.poll.return_value = 1
                with patch.object(local_web, "FOLDER", folder), \
                     patch.object(local_web, "connect", side_effect=failure), \
                     patch.object(local_web.subprocess, "Popen", return_value=process) as spawned, \
                     patch.object(local_web, "ensure_private_directory", side_effect=lambda path: Path(path), create=True), \
                     patch.object(sys, "argv", ["local_web.py", "start", "--port", "1"]), \
                     contextlib.redirect_stdout(io.StringIO()):
                    result = local_web.main()
                self.assertEqual(result, 2)
                self.assertEqual(spawned.call_count, 0,
                                 "unreadable or mismatched runtime is not evidence of no server")

    def test_launcher_default_data_folder_is_outside_project_in_install_specific_local_app_data(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"LOCALAPPDATA": tmp}):
            spec = importlib.util.spec_from_file_location("synthetic_local_web_location", ROOT / "tools/local_web.py")
            module = importlib.util.module_from_spec(spec)
            with patch.object(Path, "mkdir", side_effect=AssertionError("import created storage")), \
                 patch("subprocess.run", side_effect=AssertionError("import executed ACL")), \
                 patch("subprocess.Popen", side_effect=AssertionError("import started server")):
                spec.loader.exec_module(module)
            install = hashlib.sha256(str(ROOT.resolve()).replace("\\", "/").lower().encode()).hexdigest()[:16]
            expected = Path(tmp) / "WebKakao" / install
            self.assertTrue(Path(module.FOLDER).is_relative_to(expected),
                            "runtime/control/log paths must use private installation storage")

    def test_public_status_does_not_print_secret_fields(self):
        state = {"build": 8, "phase": "idle", "csrf": "SYNTHETIC", "controlToken": "SYNTHETIC",
                 "grid": [[True]], "passcode": "0000", "accessToken": "SYNTHETIC"}
        result = local_web.public_status("http://127.0.0.1:1", state)
        for key in ["csrf", "controlToken", "grid", "passcode", "accessToken"]:
            self.assertNotIn(key, result)


@unittest.skipUnless(PRIVATE.is_file() or STRICT, "private_storage module not yet implemented; not a RED import failure")
class PrivateStorageContracts(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PRIVATE.is_file(), "WEB_KAKAO_STRICT=1: private_storage module missing")

    def test_import_and_data_root_calculation_have_no_io_side_effects(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with patch.object(Path, "mkdir", side_effect=AssertionError("import/root computation wrote data")), \
                 patch("subprocess.run", side_effect=AssertionError("import/root computation executed process")), \
                 patch("subprocess.Popen", side_effect=AssertionError("import/root computation started process")):
                module = load_private()
                result = module.data_root(ROOT, base / "appdata")
            self.assertFalse((base / "appdata").exists())
            self.assertIsInstance(result, Path)

    def test_windows_install_hash_matches_normalized_absolute_root(self):
        module = load_private()
        with tempfile.TemporaryDirectory() as tmp:
            project, appdata = Path(tmp) / "한글 설치", Path(tmp) / "AppData"
            expected = hashlib.sha256(str(project.resolve()).replace("\\", "/").lower().encode()).hexdigest()[:16]
            self.assertEqual(module.data_root(project, appdata), appdata / "WebKakao" / expected)

    @unittest.skipUnless(NODE_PRIVATE.is_file() and NODE.is_file() or STRICT, "Node private-storage calculation not implemented")
    def test_python_and_node_install_roots_agree_without_creating_a_directory(self):
        self.assertTrue(NODE_PRIVATE.is_file() and NODE.is_file(), "WEB_KAKAO_STRICT=1: project Node runtime missing")
        module = load_private()
        with tempfile.TemporaryDirectory() as tmp:
            project, appdata = Path(tmp) / "한글 설치", Path(tmp) / "AppData"
            script = "import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url);const fs=require('node:fs'),cp=require('node:child_process');for(const name of ['mkdirSync','writeFileSync','chmodSync','renameSync'])fs[name]=()=>{throw new Error('synthetic write forbidden');};for(const name of ['spawn','spawnSync','execFile','execFileSync','exec','execSync'])cp[name]=()=>{throw new Error('synthetic process forbidden');};syncBuiltinESMExports();const {privateDataRoot}=await import('./experiments/local-web/private-storage.mjs');console.log(JSON.stringify(privateDataRoot(" + json.dumps({"projectRoot": str(project), "localAppData": str(appdata)}) + ")));"
            result = subprocess.run([str(NODE), "--input-type=module", "-e", script], cwd=ROOT,
                                    check=False, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, "path-only Node helper must execute without ACL or file operations")
            self.assertEqual(Path(json.loads(result.stdout)), module.data_root(project, appdata))
            self.assertFalse(appdata.exists())

    def test_private_acl_command_failure_is_fail_closed(self):
        module = load_private()
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(module, "secure_directory", side_effect=OSError("synthetic ACL denied")):
            target = Path(tmp) / "private"
            with self.assertRaises((OSError, RuntimeError, ValueError, subprocess.SubprocessError)):
                module.ensure_private_directory(target)
            self.assertFalse((target / "runtime.json").exists())
            self.assertFalse((target / "identity.key").exists())

    def test_migration_transfers_key_and_settings_together_with_sanitized_summary(self):
        module = load_private()
        with tempfile.TemporaryDirectory() as tmp:
            source, destination = Path(tmp) / "source", Path(tmp) / "destination"
            expected = fake_preferences(source)
            def fake_acl(path):
                Path(path).mkdir(parents=True, exist_ok=True)
                return Path(path)
            with patch.object(module, "ensure_private_directory", side_effect=fake_acl):
                result = module.migrate_preferences(source, destination)
            self.assertEqual((destination / "identity.key").read_bytes(), b"S" * 32)
            self.assertEqual(json.loads((destination / ("a" * 64 + ".json")).read_text(encoding="utf-8")), expected)
            serialized = json.dumps(result)
            self.assertNotIn("Synthetic alias", serialized)
            self.assertNotIn(str(source), serialized)
            self.assertNotIn("S" * 32, serialized)

    def assert_migration_refused(self, module, source, destination, **kwargs):
        before = {path.name: path.read_bytes() for path in source.iterdir() if path.is_file()}
        with patch.object(module, "ensure_private_directory", side_effect=AssertionError("ACL before validation forbidden")):
            try:
                module.migrate_preferences(source, destination, **kwargs)
            except (OSError, RuntimeError, ValueError):
                pass
        self.assertFalse(destination.exists(), "refusal must not leave partially migrated private files")
        self.assertEqual(before, {path.name: path.read_bytes() for path in source.iterdir() if path.is_file()})

    def test_active_server_refuses_migration_without_touching_files(self):
        module = load_private()
        with tempfile.TemporaryDirectory() as tmp:
            source, destination = Path(tmp) / "source", Path(tmp) / "destination"
            fake_preferences(source)
            self.assert_migration_refused(module, source, destination, server_active=True)

    def test_existing_destination_is_never_overwritten(self):
        module = load_private()
        with tempfile.TemporaryDirectory() as tmp:
            source, destination = Path(tmp) / "source", Path(tmp) / "destination"
            fake_preferences(source)
            destination.mkdir()
            sentinel = destination / "sentinel"
            sentinel.write_bytes(b"preserve")
            with patch.object(module, "ensure_private_directory", side_effect=AssertionError("existing destination ACL forbidden")):
                try:
                    module.migrate_preferences(source, destination)
                except (OSError, RuntimeError, ValueError):
                    pass
            self.assertEqual(sentinel.read_bytes(), b"preserve")
            self.assertEqual(sorted(path.name for path in destination.iterdir()), ["sentinel"])

    def test_invalid_key_or_settings_and_extra_scope_are_rejected_before_destination_write(self):
        module = load_private()
        for invalid in ["key", "json", "scope"]:
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as tmp:
                source, destination = Path(tmp) / "source", Path(tmp) / "destination"
                fake_preferences(source)
                if invalid == "key":
                    (source / "identity.key").write_bytes(b"short")
                elif invalid == "json":
                    (source / ("a" * 64 + ".json")).write_text("not JSON", encoding="utf-8")
                else:
                    (source / "unrelated.txt").write_bytes(b"out of scope")
                self.assert_migration_refused(module, source, destination)

    def test_symlink_source_is_refused_without_reading_target_or_applying_acl(self):
        module = load_private()
        with tempfile.TemporaryDirectory() as tmp:
            source, destination = Path(tmp) / "source", Path(tmp) / "destination"
            source.mkdir()
            with patch.object(Path, "is_symlink", return_value=True), \
                 patch.object(module, "ensure_private_directory", side_effect=AssertionError("ACL must not run")), \
                 patch.object(Path, "read_bytes", side_effect=AssertionError("symlink target must not be read")):
                try:
                    module.migrate_preferences(source, destination)
                except (OSError, RuntimeError, ValueError):
                    pass
            self.assertFalse(destination.exists())


@unittest.skipUnless(os.name == "nt", "Windows ACL")
class PrivateDirectoryReapplyTests(unittest.TestCase):
    # Applies the owner-only ACL only to a fresh directory under the system temp folder.
    def test_owner_only_acl_can_be_applied_twice(self):
        private = load_private()
        with tempfile.TemporaryDirectory(prefix="webkakao-acl-") as temporary:
            target = Path(temporary) / "private"
            private.ensure_private_directory(target)
            private.ensure_private_directory(target)  # Set-Acl failed here with SeSecurityPrivilege.
            (target / "probe.json").write_text("{}", encoding="utf-8")
            self.assertTrue(private.verify_private_file(target / "probe.json"))


if __name__ == "__main__":
    unittest.main()
