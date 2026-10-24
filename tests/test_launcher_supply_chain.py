"""Offline supply-chain and archive checks for the preparation tools. Network is always faked."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.request
from zipfile import ZipFile

from tools import prepare_android_adb, prepare_node_spike, prepare_rea_android
from tools.runtime_distribution import runtime_spec

ROOT = Path(__file__).resolve().parents[1]
UNSAFE = ["CON", "aux.txt", "COM1.log", "lpt9", "nul.tar.gz", "a:b", "trailing.", "trailing "]


def strict():
    return os.environ.get("WEB_KAKAO_STRICT") == "1"


class SupplyChainTests(unittest.TestCase):
    def setUp(self):
        output = ROOT / "local-only/qa-adversarial-20261017/fixtures"
        output.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="supply-", dir=output)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def make_zip(self, path, top, names):
        with ZipFile(path, "w") as archive:
            for name in names:
                archive.writestr(top + "/" + name, "synthetic")
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_node_zip_hash_is_pinned_and_download_is_partial_then_renamed(self):
        (self.root / prepare_node_spike.FILENAME).write_bytes(b"tampered")
        with self.assertRaises(SystemExit):
            prepare_node_spike.main(self.root, system='Windows', machine='AMD64')
        (self.root / prepare_node_spike.FILENAME).unlink()
        with patch.object(prepare_node_spike, "urlopen", return_value=io.BytesIO(b"wrong bytes")):
            with self.assertRaises(SystemExit):
                prepare_node_spike.main(self.root, system='Windows', machine='AMD64')
        self.assertEqual(list(self.root.iterdir()), [], "no archive or .partial remains after a mismatch")
        self.assertEqual(prepare_node_spike.EXPECTED, runtime_spec('Windows', 'AMD64')['sha256'])
        runtime_record = ROOT / 'evidence/alternatives/node-runtime.json'
        if runtime_record.exists():
            self.assertEqual(runtime_spec()['sha256'], json.loads(runtime_record.read_text())['sha256'])

    def test_node_zip_rejects_reserved_ads_trailing_and_case_duplicates(self):
        top = prepare_node_spike.FILENAME.removesuffix(".zip")
        for names in [[name] for name in UNSAFE] + [["Node.exe", "node.exe"]]:
            with self.subTest(names=names):
                archive = self.root / prepare_node_spike.FILENAME
                digest = self.make_zip(archive, top, ["ok.txt", *names])
                with patch.object(prepare_node_spike, "EXPECTED", digest), self.assertRaises(SystemExit):
                    prepare_node_spike.main(self.root, system='Windows', machine='AMD64')
                self.assertFalse((self.root / top).exists())
                archive.unlink()

    def test_adb_and_jdk_archives_reject_reserved_names(self):
        for name in UNSAFE:
            with self.subTest(name=name):
                folder = self.root / ("adb-" + hashlib.md5(name.encode()).hexdigest())
                folder.mkdir()
                archive = folder / ("platform-tools-" + prepare_android_adb.VERSION + "-windows.zip")
                self.make_zip(archive, "platform-tools", ["adb.exe", name])
                sha1 = hashlib.sha1(archive.read_bytes()).hexdigest()
                with patch.object(prepare_android_adb, "FOLDER", folder), patch.object(prepare_android_adb, "SHA1", sha1), \
                        patch.object(prepare_android_adb, "SIZE", archive.stat().st_size), self.assertRaises(ValueError):
                    prepare_android_adb.main()
                self.assertFalse((folder / "platform-tools").exists())
                dest = self.root / ("jdk-" + hashlib.md5(name.encode()).hexdigest())
                dest.mkdir()
                jdk = self.make_zip(dest / "jdk.zip", "jdk-21", ["bin/java.exe", name])
                (dest / "x.jar").write_bytes(b"jar")
                assets = [("jdk.zip", "offline", jdk), ("x.jar", "offline", hashlib.sha256(b"jar").hexdigest())]
                with patch.object(prepare_rea_android, "DEST", dest), patch.object(prepare_rea_android, "ASSETS", assets), \
                        patch("builtins.print"), self.assertRaises(ValueError):
                    prepare_rea_android.main()
                self.assertFalse((dest / "jdk-21").exists())

    def copy_tool(self, name):
        (self.root / "tools").mkdir(exist_ok=True)
        shutil.copyfile(ROOT / "tools" / name, self.root / "tools" / name)
        return str(self.root / "tools" / name)

    def test_existing_source_files_are_rehashed_before_reuse(self):
        script = self.copy_tool("fetch_source_spike.py")
        commit = "bb92a77741419a4ab5f06e711a283343f1ada0c3"
        directory = self.root / "local-only/sources/superpowers" / commit
        directory.mkdir(parents=True)
        (directory / "LICENSE").write_bytes(b"tampered")
        fake = lambda req, timeout=None: io.BytesIO(b'{"tree": []}' if "api.github.com" in req.full_url else b"public")
        for manifest in [False, True]:
            with self.subTest(manifest=manifest):
                if manifest:
                    (self.root / "evidence/alternatives").mkdir(parents=True, exist_ok=True)
                    (self.root / "evidence/alternatives/superpowers-source.json").write_text(json.dumps(
                        {"commit": commit, "files": [{"path": "LICENSE", "sha256": hashlib.sha256(b"public").hexdigest()}]}), encoding="utf-8")
                with patch.object(urllib.request, "urlopen", side_effect=fake), patch.object(sys, "argv", ["x", "superpowers"]), \
                        patch("builtins.print"), self.assertRaises(SystemExit) as raised:
                    runpy.run_path(script, run_name="__main__")
                self.assertIn("LICENSE", str(raised.exception.code))
        (directory / "LICENSE").write_bytes(b"public")
        with patch.object(urllib.request, "urlopen", side_effect=fake), patch.object(sys, "argv", ["x", "superpowers"]), patch("builtins.print"):
            runpy.run_path(script, run_name="__main__")

    def test_spike_install_requires_tracked_lock_and_uses_npm_ci(self):
        self.assertTrue((ROOT / "tools/locks/modern-package-lock.json").is_file(), "tracked modern lock")
        script = self.copy_tool("prepare_spikes.py")
        (self.root / "tools/locks").mkdir()
        shutil.copyfile(ROOT / "tools/locks/modern-package-lock.json", self.root / "tools/locks/modern-package-lock.json")
        (self.root / "experiments").mkdir()
        evidence = self.root / "evidence/alternatives"
        evidence.mkdir(parents=True)
        for candidate, experiment in [("modern", "modern-api-spike.ts"), ("legacy", "legacy-codec-spike.ts")]:
            (self.root / "local-only/src" / candidate / "src").mkdir(parents=True)
            (self.root / "experiments" / experiment).write_text("// synthetic", encoding="utf-8")
            (evidence / f"{candidate}-source.json").write_text(json.dumps({"directory": f"local-only/src/{candidate}"}), encoding="utf-8")
        (evidence / "node-runtime.json").write_text(json.dumps({"directory": "local-only/runtime/node"}), encoding="utf-8")
        with patch.object(subprocess, "run") as run, patch.object(sys, "argv", ["x", "--install-dependencies"]), \
                patch("builtins.print"), self.assertRaises(SystemExit) as raised:
            runpy.run_path(script, run_name="__main__")
        self.assertIn("legacy", str(raised.exception.code))
        self.assertEqual(run.call_count, 0, "all required locks are checked before any installation")
        self.assertFalse((self.root / "local-only/spikes").exists(), "missing lock causes no preparation side effects")
        shutil.copyfile(ROOT / "tools/locks/legacy-package-lock.json", self.root / "tools/locks/legacy-package-lock.json")
        with patch.object(subprocess, "run") as run, patch.object(sys, "argv", ["x", "--install-dependencies"]), patch("builtins.print"):
            runpy.run_path(script, run_name="__main__")
        self.assertEqual(run.call_count, 2, "both pinned candidates install when both locks are available")
        for call in run.call_args_list:
            command = call.args[0]
            self.assertIn("ci", command)
            self.assertNotIn("install", command)
            self.assertIn("--ignore-scripts", command)
        for candidate in ("modern", "legacy"):
            self.assertEqual((self.root / f"local-only/spikes/{candidate}/package-lock.json").read_bytes(), (ROOT / f"tools/locks/{candidate}-package-lock.json").read_bytes())

    def test_verify_artifacts_reports_missing_evidence_on_fresh_clone(self):
        script = self.copy_tool("verify_artifacts.py")
        (self.root / "README.md").write_text("# synthetic\n", encoding="utf-8")
        with patch("builtins.print"), self.assertRaises(SystemExit) as raised:
            runpy.run_path(script, run_name="__main__")
        self.assertIsInstance(raised.exception.code, str)
        self.assertIn("검증 기록", raised.exception.code)

    def test_strict_mode_turns_missing_prerequisite_skip_into_failure(self):
        code = ("import json,pathlib,sys,unittest;import experiments.auth_preflight as a;a.SOURCE=pathlib.Path('missing-synthetic-source');"
                "r=unittest.main(module='tests.test_auth_preflight',exit=False,argv=['x'],verbosity=0).result;print(json.dumps([len(r.skipped),len(r.failures)]))")
        for value, expected in [("", [1, 0]), ("1", [0, 1])]:
            with self.subTest(strict=value):
                result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, timeout=60,
                                        env={**os.environ, "WEB_KAKAO_STRICT": value})
                self.assertEqual(json.loads(result.stdout.decode().strip().splitlines()[-1]), expected)

    def test_python39_gets_a_clear_version_error(self):
        launcher = shutil.which("py")
        found = launcher and subprocess.run([launcher, "-3.9", "-c", "pass"], capture_output=True).returncode == 0
        if not found:
            if strict():
                self.fail("WEB_KAKAO_STRICT=1: Python 3.9 launcher unavailable")
            self.skipTest("Python 3.9 unavailable")
        for name in ["prepare_android_adb.py", "prepare_rea_android.py", "prepare_rea_windows.py", "build_apk_export_kit.py"]:
            with self.subTest(name=name):
                result = subprocess.run([launcher, "-3.9", str(ROOT / "tools" / name), "--help"], capture_output=True, timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"3.11", result.stderr)
                self.assertNotIn(b"AttributeError", result.stderr)


if __name__ == "__main__":
    unittest.main()
