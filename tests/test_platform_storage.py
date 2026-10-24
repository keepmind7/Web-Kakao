"""Platform paths and POSIX security contracts with synthetic stat/process input."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools import private_storage as storage
from tools.platforms.paths import private_data_path
from tools.runtime_distribution import runtime_path

ROOT = Path(__file__).absolute().parents[1]
NODE = runtime_path(ROOT)


def info(mode=stat.S_IFDIR | 0o700, uid=1000, ino=5, nlink=1, size=12):
    return SimpleNamespace(st_mode=mode, st_uid=uid, st_dev=1, st_ino=ino,
                           st_nlink=nlink, st_size=size, st_mtime_ns=1, st_ctime_ns=1)


class PlatformPathTests(unittest.TestCase):
    def test_windows_identity_and_explicit_override_are_unchanged(self):
        project = r"C:\Source\SYNTH~1\설치"
        digest = hashlib.sha256("c:/source/synth~1/설치".encode()).hexdigest()[:16]
        self.assertEqual(private_data_path(project, r"C:\Users\Fixture\AppData\Local", system="Windows"),
                         rf"C:\Users\Fixture\AppData\Local\WebKakao\{digest}")
        base = ROOT / "nonexistent-synthetic"
        digest = hashlib.sha256(os.path.abspath(ROOT).replace("\\", "/").lower().encode()).hexdigest()[:16]
        self.assertEqual(storage.data_root(ROOT, base), base / "WebKakao" / digest)

    def test_linux_uses_absolute_xdg_or_home_and_preserves_install_case(self):
        options = {"system": "Linux", "home": "/home/fixture", "environ": {}}
        lower = private_data_path("/src/web", **options)
        upper = private_data_path("/src/Web", **options)
        self.assertNotEqual(lower, upper)
        self.assertTrue(lower.startswith("/home/fixture/.local/share/WebKakao/"))
        self.assertTrue(private_data_path("/src/web", xdg_data_home="/var/private", **options).startswith("/var/private/WebKakao/"))
        self.assertTrue(private_data_path("/src/web", system="Linux", home="", xdg_data_home="/var/private", environ={}).startswith("/var/private/WebKakao/"))
        self.assertEqual(private_data_path("/src/web", xdg_data_home="relative", **options), lower)
        self.assertEqual(private_data_path("/src/web", xdg_data_home="", **options), lower)

    def test_macos_path_only_and_missing_home_or_unknown_platform_fail_closed(self):
        self.assertTrue(private_data_path("/src/web", system="Darwin", home="/Users/fixture", environ={}).startswith("/Users/fixture/Library/Application Support/WebKakao/"))
        for options in [{"system": "Linux", "home": "relative"}, {"system": "Linux", "home": ""}, {"system": "unknown"}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                private_data_path("/src/web", environ={}, **options)

    def test_calculation_does_not_touch_files_or_launch_processes(self):
        with patch.object(Path, "mkdir", side_effect=AssertionError("write")), \
             patch.object(Path, "open", side_effect=AssertionError("read")), \
             patch("subprocess.run", side_effect=AssertionError("process")):
            private_data_path("/synthetic/missing", system="Linux", home="/home/fixture", environ={})
            storage.data_root(ROOT, ROOT / "nonexistent-synthetic")

    def test_python_and_node_agree_for_same_cross_platform_fixtures(self):
        self.assertTrue(NODE.is_file(), 'prepare the pinned runtime for this OS before running cross-language tests')
        node = NODE
        fixtures = [
            {"projectRoot": r"C:\Source\SYNTH~1\설치", "platform": "win32", "localAppData": r"C:\Users\Fixture\AppData\Local"},
            {"projectRoot": "/src/Web", "platform": "linux", "home": "/home/fixture", "xdgDataHome": "/var/data"},
            {"projectRoot": "/src/web", "platform": "linux", "home": "/home/fixture", "xdgDataHome": "relative"},
            {"projectRoot": "/src/한글", "platform": "darwin", "home": "/Users/fixture"},
        ]
        script = "import {privateDataRoot} from './experiments/local-web/private-storage.mjs';console.log(JSON.stringify(" + json.dumps(fixtures) + ".map(privateDataRoot)));"
        result = subprocess.run([str(node), "--input-type=module", "-e", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = [private_data_path(f["projectRoot"], f.get("localAppData"), system=f["platform"],
                    home=f.get("home"), xdg_data_home=f.get("xdgDataHome"), environ={}) for f in fixtures]
        self.assertEqual(json.loads(result.stdout), expected)


class PosixPolicyTests(unittest.TestCase):
    def test_directory_owner_permissions_and_root_sticky_ancestor(self):
        storage._posix_directory_info(info(), 1000, private=True)
        storage._posix_directory_info(info(mode=stat.S_IFDIR | 0o755, uid=0), 1000)
        storage._posix_directory_info(info(mode=stat.S_IFDIR | 0o1777, uid=0), 1000)
        invalid = [info(mode=stat.S_IFLNK | 0o700), info(uid=2000), info(mode=stat.S_IFDIR | 0o775), info(mode=stat.S_IFDIR | 0o1777)]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                storage._posix_directory_info(value, 1000)
        for value in [info(uid=0), info(mode=stat.S_IFDIR | 0o755), info(mode=stat.S_IFDIR | 0o1700)]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                storage._posix_directory_info(value, 1000, private=True)

    def test_file_rejects_foreign_uid_broad_mode_and_hardlink_before_open(self):
        for value in [info(stat.S_IFREG | 0o600, uid=2000), info(stat.S_IFREG | 0o644), info(stat.S_IFREG | 0o600, nlink=2)]:
            with self.subTest(value=value), patch.object(os, "getuid", return_value=1000, create=True), \
                 patch.object(os, "open", side_effect=AssertionError("must refuse before open")), self.assertRaises(ValueError):
                storage._verify_posix_file(ROOT / "synthetic", value, 100)

    def test_opened_file_and_final_path_must_remain_identical(self):
        original = info(stat.S_IFREG | 0o600)
        for opened, after in [(info(stat.S_IFREG | 0o600, ino=6), original),
                              (original, info(stat.S_IFREG | 0o600, ino=6)), (original, info(stat.S_IFREG | 0o600, size=13))]:
            with self.subTest(opened=opened, after=after), patch.object(os, "getuid", return_value=1000, create=True), \
                 patch.multiple(os, O_NOFOLLOW=0x20000, O_NONBLOCK=0x800, create=True), \
                 patch.object(storage, "_posix_ancestors", return_value=[]), patch.object(os, "open", return_value=20), \
                 patch.object(os, "fstat", return_value=opened), patch.object(os, "close") as closed, \
                 patch.object(Path, "lstat", return_value=after), self.assertRaises(ValueError):
                storage._verify_posix_file(ROOT / "synthetic", original, 100)
            closed.assert_called_once_with(20)

    def test_success_checks_no_follow_descriptor_and_ancestors_without_chmod(self):
        original = info(stat.S_IFREG | 0o600)
        with patch.object(os, "getuid", return_value=1000, create=True), \
             patch.multiple(os, O_NOFOLLOW=0x20000, O_NONBLOCK=0x800, create=True), \
             patch.object(storage, "_posix_ancestors", return_value=[]), patch.object(os, "open", return_value=20) as opened, \
             patch.object(os, "fstat", return_value=original), patch.object(os, "close"), \
             patch.object(Path, "lstat", return_value=original), patch.object(Path, "chmod", side_effect=AssertionError("chmod")):
            self.assertTrue(storage._verify_posix_file(ROOT / "synthetic", original, 100))
        self.assertTrue(opened.call_args.args[1] & 0x20000)

    def test_ancestor_replacement_is_rejected(self):
        original = info()
        with patch.object(Path, "lstat", return_value=info(ino=6)), self.assertRaises(ValueError):
            storage._posix_unchanged([(ROOT / "synthetic", original)])
        # Creating a child legitimately changes a directory's link count.
        with patch.object(Path, "lstat", return_value=info(nlink=2)):
            storage._posix_unchanged([(ROOT / "synthetic", original)])

    def test_synthetic_directory_creation_never_chmods_existing_paths(self):
        target = ROOT.anchor and Path(ROOT.anchor) / "synthetic-owner" / "private"
        root = Path(target.anchor)
        entries = {root: info(uid=0, ino=1, mode=stat.S_IFDIR | 0o755)}
        handles = {}
        created = []
        def opened(path, flags, dir_fd=None):
            path = Path(path) if dir_fd is None else handles[dir_fd] / path
            if path not in entries:
                raise FileNotFoundError()
            handle = 100 + len(handles)
            handles[handle] = path
            return handle
        def stated(path, *, dir_fd=None, follow_symlinks=True):
            path = Path(path) if dir_fd is None else handles[dir_fd] / path
            if path not in entries:
                raise FileNotFoundError()
            return entries[path]
        def made(path, mode, dir_fd):
            path = handles[dir_fd] / path
            self.assertEqual(mode, 0o700)
            entries[path] = info(ino=len(entries) + 1)
            created.append(path)
        with patch.object(os, "getuid", return_value=1000, create=True), \
             patch.multiple(os, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000, create=True), \
             patch.object(os, "open", side_effect=opened), patch.object(os, "stat", side_effect=stated), \
             patch.object(os, "mkdir", side_effect=made), patch.object(os, "fstat", side_effect=lambda fd: entries[handles[fd]]), \
             patch.object(os, "close"), patch.object(Path, "lstat", autospec=True, side_effect=lambda path: stated(path)), \
             patch.object(Path, "chmod", side_effect=AssertionError("chmod")):
            self.assertEqual(storage._ensure_posix_directory(target), target)
            self.assertEqual(created, [root / "synthetic-owner", target])
            entries[target] = info(mode=stat.S_IFDIR | 0o755)
            with self.assertRaises(ValueError):
                storage._ensure_posix_directory(target)
            self.assertEqual(len(created), 2)

    @unittest.skipUnless(os.name == "posix", "실제 POSIX 파일 권한 시험은 Linux/WSL에서 실행")
    def test_native_posix_temp_directory_and_file_permissions(self):
        # Real path: macOS temp dirs sit under the /var -> /private/var symlink, refused by design.
        with tempfile.TemporaryDirectory(prefix="webkakao-platform-", dir=os.path.realpath(tempfile.gettempdir())) as temporary:
            target = Path(temporary) / "private"
            storage.ensure_private_directory(target)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
            path = target / "probe"
            self.assertFalse(storage.verify_private_file(path))
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
            self.assertTrue(storage.verify_private_file(path))
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                storage.verify_private_file(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)


if __name__ == "__main__":
    unittest.main()
