"""Mocked Linux launcher/procfs contracts; no server, browser or account access."""
import contextlib
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import stat
import shutil
import sys
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import MagicMock, Mock, patch

from tools import local_web
from tools.platforms import common, linux, windows


HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode"


def row(port=8787, inode=123, uid=1000, state="0A", ipv6=False):
    address = "0" * 32 if ipv6 else "0100007F"
    return f"  0: {address}:{port:04X} 00000000:0000 {state} 00000000:00000000 00:00000000 00000000 {uid} 0 {inode} 1"


class PlatformContracts(unittest.TestCase):
    def test_backend_is_explicit_and_macos_is_not_silently_linux(self):
        self.assertIs(common.backend("Windows"), windows)
        self.assertIs(common.backend("Linux"), linux)
        for name in ("Darwin", "FreeBSD", "", "linux"):
            with self.subTest(system=name), self.assertRaises(ValueError):
                common.backend(name)

    def test_environment_includes_linux_paths_but_excludes_loader_tls_proxy_secrets(self):
        environment = {name: "synthetic" for name in (
            "HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "PATH", "LANG",
            "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY",
            "LD_PRELOAD", "LD_LIBRARY_PATH", "BROWSER", "KAKAO_TOKEN", "WEB_KAKAO_PYTHON", "path")}
        actual = common.server_environment(environment, "/usr/bin/python3", system="Linux")
        self.assertEqual(set(actual), {"HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
                                       "TMPDIR", "PATH", "LANG", "WEB_KAKAO_PYTHON"})
        self.assertEqual(actual["WEB_KAKAO_PYTHON"], "/usr/bin/python3")

    def test_windows_case_insensitive_environment_and_creationflags_are_preserved(self):
        actual = common.server_environment({"Path": "synthetic", "node_options": "blocked"}, "python.exe", system="Windows")
        self.assertEqual(actual, {"Path": "synthetic", "WEB_KAKAO_PYTHON": "python.exe"})
        # Exercise the Windows adapter even on Linux without reading a
        # Windows-only stdlib constant from the host interpreter.
        with patch.object(windows.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True):
            self.assertEqual(windows.spawn_options(), {"creationflags": 0x08000000})

    def test_linux_spawn_separates_session_and_sets_child_umask_without_preexec(self):
        self.assertEqual(linux.spawn_options(), {"start_new_session": True, "umask": 0o077})

    def test_uid_must_match_effective_uid(self):
        with patch.object(linux.os, "getuid", return_value=1000, create=True), \
             patch.object(linux.os, "geteuid", return_value=1001, create=True), self.assertRaises(OSError):
            linux._uid()


class ProcfsContracts(unittest.TestCase):
    def setUp(self):
        fixtures = Path(__file__).resolve().parents[1] / "local-only/qa-platform-launcher/fixtures"
        fixtures.mkdir(parents=True, exist_ok=True)
        # Synthetic, non-secret fixture. Python 3.13's Windows mkdtemp(0700)
        # creates a DACL inaccessible to this restricted test token.
        self.root = fixtures / ("synthetic-proc-" + uuid.uuid4().hex)
        self.root.mkdir(mode=0o755)
        def cleanup():
            # Windows can report DIR_NOT_EMPTY during fixture teardown even
            # after its children were removed. Retry only that error, bounded,
            # and recheck the owned fixture boundary before every deletion.
            for attempt in range(4):
                if self.root.resolve().parent != fixtures.resolve():
                    raise ValueError("synthetic_fixture_scope")
                try:
                    shutil.rmtree(self.root)
                    return
                except OSError as error:
                    if getattr(error, 'winerror', None) != 145 or attempt == 3:
                        raise
                    time.sleep(0.05 * (attempt + 1))
        self.addCleanup(cleanup)
        (self.root / "net").mkdir()
        self.links, self.uids = {}, {}
        for patcher in (patch.object(linux, "PROC_ROOT", self.root),
                        patch.object(linux, "_uid", return_value=1000),
                        patch.object(linux, "_process_uid", side_effect=lambda folder: self.uids[int(folder.name)]),
                        patch.object(linux.os, "readlink", side_effect=lambda path: self.links[str(path)])):
            patcher.start()
            self.addCleanup(patcher.stop)

    def table(self, *rows, ipv6=()):
        (self.root / "net/tcp").write_text("\n".join((HEADER, *rows)) + "\n", encoding="ascii")
        (self.root / "net/tcp6").write_text("\n".join((HEADER, *ipv6)) + "\n", encoding="ascii")

    def process(self, pid, inodes=(), uid=1000):
        folder = self.root / str(pid)
        (folder / "fd").mkdir(parents=True)
        self.uids[pid] = uid
        for index, inode in enumerate(inodes):
            descriptor = folder / "fd" / str(index)
            descriptor.touch()
            self.links[str(descriptor)] = f"socket:[{inode}]"
        return folder

    def test_ipv4_and_ipv6_every_listener_resolves_to_pids(self):
        self.table(row(inode=123), row(port=9999, inode=999), row(inode=999, state="01"),
                   ipv6=(row(inode=456, ipv6=True),))
        self.process(41, (123, 456))
        self.assertEqual(linux.listener_owners(8787), {41})

    def test_same_inode_shared_by_two_processes_returns_both_not_first_match(self):
        self.table(row())
        self.process(41, (123,))
        self.process(42, (123,))
        self.assertEqual(linux.listener_owners(8787), {41, 42})

    def test_empty_listener_table_is_stale_but_unresolved_inode_is_not(self):
        self.table(row(port=9999))
        self.assertEqual(linux.listener_owners(8787), set())
        self.table(row())
        with self.assertRaisesRegex(OSError, "unresolved"):
            linux.listener_owners(8787)

    def test_foreign_socket_uid_is_rejected_before_fd_scan(self):
        self.table(row(uid=1001))
        with self.assertRaisesRegex(OSError, "uid"):
            linux.listener_owners(8787)

    def test_unreadable_same_uid_fds_fail_closed_even_if_another_process_matches(self):
        self.table(row())
        self.process(41, (123,))
        self.process(42)
        original = Path.iterdir
        def enumerate_path(path):
            if path == self.root / "42/fd":
                raise PermissionError("synthetic")
            return original(path)
        with patch.object(Path, "iterdir", enumerate_path), self.assertRaises(OSError):
            linux.listener_owners(8787)

    def test_foreign_uid_proc_can_be_inaccessible_without_authorizing_its_socket(self):
        self.table(row())
        self.process(41, (123,))
        foreign = self.process(42, uid=1001)
        (foreign / "fd").rmdir()
        self.assertEqual(linux.listener_owners(8787), {41})

    def test_denied_descriptor_is_not_skipped(self):
        self.table(row())
        self.process(41, (123,))
        with patch.object(linux.os, "readlink", side_effect=PermissionError("synthetic")), self.assertRaises(OSError):
            linux.listener_owners(8787)

    def test_listener_table_change_during_scan_is_rejected(self):
        self.table(row())
        self.process(41, (123,))
        with patch.object(linux, "_listener_inodes", side_effect=[{123}, {456}]), self.assertRaisesRegex(OSError, "unresolved"):
            linux.listener_owners(8787)

    def test_missing_ipv6_is_allowed_but_missing_ipv4_is_not(self):
        self.table(row())
        self.process(41, (123,))
        (self.root / "net/tcp6").unlink()
        self.assertEqual(linux.listener_owners(8787), {41})
        (self.root / "net/tcp").unlink()
        with self.assertRaises(OSError):
            linux.listener_owners(8787)

    def test_malformed_table_or_unowned_inode_never_becomes_empty(self):
        for text in ("bad header", HEADER + "\ntruncated", HEADER + "\n" + row(inode=0),
                     HEADER + "\n" + row().replace("0100007F", "invalid!")):
            with self.subTest(text=text):
                (self.root / "net/tcp").write_text(text, encoding="ascii")
                with self.assertRaises(OSError):
                    linux.listener_owners(8787)

    def test_invalid_port_is_rejected_before_table_io(self):
        for port in (0, 65536, "8787", True):
            with self.subTest(port=port), self.assertRaises(OSError):
                linux.listener_owners(port)

    def test_target_pid_holds_all_ipv4_ipv6_inodes_without_scanning_other_processes(self):
        self.table(row(inode=123), ipv6=(row(inode=456, ipv6=True),))
        self.process(41, (123, 456))
        self.process(42)
        original = Path.iterdir
        scanned = []
        def enumerate_target(path):
            scanned.append(path)
            if path != self.root / "41/fd":
                raise PermissionError("synthetic unrelated same-UID process")
            return original(path)
        with patch.object(Path, "iterdir", enumerate_target):
            self.assertIs(linux.assert_pid_listener(8787, 41), True)
        self.assertEqual(scanned, [self.root / "41/fd"])

    def test_target_pid_possession_does_not_claim_exclusive_ownership(self):
        self.table(row())
        self.process(41, (123,))
        self.process(42, (123,))
        self.assertIs(linux.assert_pid_listener(8787, 41), True)
        self.assertEqual(linux.listener_owners(8787), {41, 42})

    def test_target_own_fd_directory_access_denial_fails(self):
        self.table(row())
        self.process(41, (123,))
        with patch.object(Path, "iterdir", side_effect=PermissionError("synthetic")), \
             self.assertRaisesRegex(OSError, "process_fds_unavailable"):
            linux.assert_pid_listener(8787, 41)

    def test_target_own_descriptor_access_denial_fails(self):
        self.table(row())
        self.process(41, (123,))
        with patch.object(linux.os, "readlink", side_effect=PermissionError("synthetic")), \
             self.assertRaisesRegex(OSError, "process_fd_unavailable"):
            linux.assert_pid_listener(8787, 41)

    def test_target_must_hold_additional_ipv4_and_ipv6_listeners(self):
        self.process(41, (123,))
        for ipv6 in (False, True):
            with self.subTest(ipv6=ipv6):
                if ipv6:
                    self.table(row(), ipv6=(row(inode=456, ipv6=True),))
                else:
                    self.table(row(), row(inode=456))
                with self.assertRaisesRegex(OSError, "target_listener_unresolved"):
                    linux.assert_pid_listener(8787, 41)

    def test_target_foreign_socket_uid_fails_before_target_access(self):
        self.table(row(uid=1001))
        with patch.object(linux, "_process_uid") as owner, self.assertRaisesRegex(OSError, "listener_owner_uid"):
            linux.assert_pid_listener(8787, 41)
        owner.assert_not_called()

    def test_target_process_uid_must_match_before_and_after_descriptor_scan(self):
        self.table(row())
        self.process(41, (123,))
        for uids in ([1001], [1000, 1001]):
            with self.subTest(uids=uids), patch.object(linux, "_process_uid", side_effect=uids), \
                 self.assertRaisesRegex(OSError, "process_uid"):
                linux.assert_pid_listener(8787, 41)

    def test_target_caller_uid_effective_uid_mismatch_and_changes_fail(self):
        self.table(row())
        self.process(41, (123,))
        with patch.object(linux, "_uid", side_effect=OSError("launcher_effective_uid_mismatch")), \
             self.assertRaisesRegex(OSError, "effective_uid"):
            linux.assert_pid_listener(8787, 41)
        with patch.object(linux, "_uid", side_effect=[1000, 1001]), self.assertRaisesRegex(OSError, "process_uid"):
            linux.assert_pid_listener(8787, 41)

    def test_target_listener_table_changes_fail_including_disappeared_listener(self):
        self.process(41, (123,))
        for after in (set(), {456}, {123, 456}):
            with self.subTest(after=after), patch.object(linux, "_listener_inodes", side_effect=[{123}, after]), \
                 self.assertRaisesRegex(OSError, "target_listener_unresolved"):
                linux.assert_pid_listener(8787, 41)

    def test_target_empty_listener_table_is_only_false_without_fd_access(self):
        self.table(row(port=9999))
        with patch.object(linux, "_process_uid") as owner, patch.object(Path, "iterdir") as scan:
            self.assertIs(linux.assert_pid_listener(8787, 41), False)
        owner.assert_not_called()
        scan.assert_not_called()

    def test_target_invalid_pid_rejected_before_proc_table_io(self):
        for pid in (0, -1, True, "41", None):
            with self.subTest(pid=pid), patch.object(linux, "_listener_inodes") as table, \
                 self.assertRaisesRegex(OSError, "process_pid"):
                linux.assert_pid_listener(8787, pid)
            table.assert_not_called()

    def test_target_missing_process_is_error_for_nonempty_listener(self):
        self.table(row())
        with patch.object(linux, "_process_uid", side_effect=FileNotFoundError("synthetic")), \
             self.assertRaises(OSError):
            linux.assert_pid_listener(8787, 41)

    def test_target_closed_fd_cannot_prove_missing_listener(self):
        self.table(row())
        self.process(41, (123,))
        with patch.object(linux.os, "readlink", side_effect=FileNotFoundError("synthetic")), \
             self.assertRaisesRegex(OSError, "target_listener_unresolved"):
            linux.assert_pid_listener(8787, 41)

    def test_process_image_requires_current_uid_absolute_live_executable(self):
        folder = self.process(41)
        self.links[str(folder / "exe")] = "/fixed/node"
        self.assertEqual(linux.process_image(41), "/fixed/node")
        for image in ("relative/node", "/fixed/node (deleted)"):
            self.links[str(folder / "exe")] = image
            with self.subTest(image=image), self.assertRaises(OSError):
                linux.process_image(41)
        self.uids[41] = 1001
        with self.assertRaisesRegex(OSError, "uid"):
            linux.process_image(41)


class LinuxLogAndBrowserContracts(unittest.TestCase):
    def info(self, **changes):
        values = dict(st_mode=stat.S_IFREG | 0o600, st_uid=1000, st_nlink=1,
                      st_size=0, st_dev=1, st_ino=12)
        values.update(changes)
        return SimpleNamespace(**values)

    def log_context(self, info, *, current=None):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        for name, value in (("O_NOFOLLOW", 0x20000), ("O_CLOEXEC", 0x80000)):
            stack.enter_context(patch.object(linux.os, name, value, create=True))
        opened = stack.enter_context(patch.object(linux.os, "open", return_value=51))
        closed = stack.enter_context(patch.object(linux.os, "close"))
        stack.enter_context(patch.object(linux.os, "fstat", return_value=info))
        stack.enter_context(patch.object(linux, "_uid", return_value=1000))
        stack.enter_context(patch.object(Path, "lstat", return_value=current or info))
        fdopen = stack.enter_context(patch.object(linux.os, "fdopen", return_value=Mock()))
        return opened, closed, fdopen

    def test_log_first_open_is_0600_nofollow_and_descriptor_verified_before_use(self):
        opened, closed, fdopen = self.log_context(self.info())
        verify = Mock()
        stream = linux.open_log(Path("synthetic.log"), verify)
        self.assertIs(stream, fdopen.return_value)
        self.assertEqual(opened.call_args.args[2], 0o600)
        self.assertTrue(opened.call_args.args[1] & linux.os.O_NOFOLLOW)
        self.assertTrue(opened.call_args.args[1] & linux.os.O_APPEND)
        self.assertEqual(verify.call_count, 2)
        closed.assert_not_called()

    def test_unsafe_log_modes_owner_links_size_and_inode_are_rejected_without_writes(self):
        cases = [dict(st_mode=stat.S_IFREG | 0o644), dict(st_uid=1001), dict(st_nlink=2),
                 dict(st_size=64 * 1024 * 1024 + 1), dict(st_mode=stat.S_IFIFO | 0o600)]
        for changes in cases:
            with self.subTest(changes=changes):
                with contextlib.ExitStack() as cleanup:
                    opened, closed, fdopen = self.log_context(self.info(**changes))
                    with self.assertRaises(ValueError):
                        linux.open_log(Path("synthetic.log"), Mock())
                    closed.assert_called_once_with(51)
                    fdopen.assert_not_called()
                    # Close the per-case patch stack before the next iteration.
                    self.doCleanups()
        opened, closed, fdopen = self.log_context(self.info(), current=self.info(st_ino=13))
        with self.assertRaises(ValueError):
            linux.open_log(Path("synthetic.log"), Mock())
        closed.assert_called_once_with(51)
        fdopen.assert_not_called()

    def test_browser_only_considers_fixed_absolute_candidates_and_ignores_path_browser(self):
        with patch.dict(os.environ, {"BROWSER": "unsafe --url", "PATH": "/untrusted"}), \
             patch.object(linux, "_browser_executable", return_value=None) as inspect:
            self.assertIsNone(linux.find_browser("chrome"))
        self.assertEqual([call.args[0] for call in inspect.call_args_list], list(linux.BROWSER_CANDIDATES["chrome"]))
        self.assertTrue(all(Path(call.args[0]).is_absolute() if os.name != "nt" else call.args[0].startswith("/")
                            for call in inspect.call_args_list))

    def test_default_browser_uses_ordered_chrome_chromium_edge_candidates(self):
        expected = Path("/synthetic/chromium")
        def choose(candidate):
            return expected if candidate == "/usr/bin/chromium" else None
        with patch.object(linux, "_browser_executable", side_effect=choose):
            self.assertEqual(linux.find_browser("default"), expected)
            self.assertIsNone(linux.find_browser("firefox"))

    def test_browser_environment_excludes_loader_and_browser_injection(self):
        result = linux.browser_environment({"HOME": "/synthetic", "DISPLAY": ":0", "PATH": "/unsafe",
                                            "LD_PRELOAD": "unsafe", "BROWSER": "unsafe", "NODE_OPTIONS": "unsafe"})
        self.assertEqual(result, {"HOME": "/synthetic", "DISPLAY": ":0", "PATH": "/usr/bin:/bin"})

    def test_browser_executable_requires_root_owned_nonwritable_executable_and_ancestors(self):
        executable = Path("/synthetic/chrome")
        good = SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_uid=0)
        with patch.object(Path, "resolve", return_value=executable), \
             patch.object(Path, "stat", return_value=good), patch.object(linux.os, "access", return_value=True):
            self.assertEqual(linux._browser_executable("/usr/bin/google-chrome"), executable)
        for mode, uid in ((0o775, 0), (0o755, 1000), (0o644, 0)):
            unsafe = SimpleNamespace(st_mode=stat.S_IFREG | mode, st_uid=uid)
            with self.subTest(mode=mode, uid=uid), patch.object(Path, "resolve", return_value=executable), \
                 patch.object(Path, "stat", return_value=unsafe), patch.object(linux.os, "access", return_value=True):
                self.assertIsNone(linux._browser_executable("/usr/bin/google-chrome"))


class LauncherLinuxFlowContracts(unittest.TestCase):
    def test_linux_mock_start_uses_private_logs_detachment_and_umask_without_windows_flags(self):
        process = Mock(pid=42)
        process.poll.return_value = None
        state = {"build": 8, "mode": "mock", "photoTransport": "https"}
        with patch.object(local_web.platform, "system", return_value="Linux"), \
             patch.object(local_web, "RUNTIME", Path("/synthetic/node")), \
             patch.object(local_web, "FOLDER", Path("synthetic-private")), \
             patch.object(Path, "is_file", return_value=True), \
             patch.object(local_web, "connect", side_effect=[FileNotFoundError(), ("http://127.0.0.1:1", Mock(), state)]), \
             patch.object(local_web, "assert_port_available"), patch.object(local_web, "ensure_private_directory"), \
             patch.object(local_web, "verify_private_file") as verify, \
             patch.object(local_web, "broad_write_warnings", return_value=[]), \
             patch.object(linux, "open_log", return_value=MagicMock()) as logs, \
             patch.object(local_web.subprocess, "Popen", return_value=process) as spawn, \
             patch.dict(os.environ, {"LD_PRELOAD": "blocked", "NODE_OPTIONS": "blocked"}), \
             patch.object(sys, "argv", ["local_web.py", "start", "--mock", "--port", "1"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(local_web.main(), 0)
        options = spawn.call_args.kwargs
        self.assertEqual(options["umask"], 0o077)
        self.assertTrue(options["start_new_session"])
        self.assertNotIn("creationflags", options)
        self.assertNotIn("LD_PRELOAD", options["env"])
        self.assertNotIn("NODE_OPTIONS", options["env"])
        self.assertEqual(logs.call_count, 2)
        self.assertEqual(verify.call_count, 2)

    def test_linux_legacy_cannot_skip_new_server_authentication(self):
        with patch.object(local_web.platform, "system", return_value="Linux"), \
             patch.object(local_web, "RUNTIME", Path("/synthetic/node")), \
             patch.object(local_web, "FOLDER", Path("synthetic-private")), \
             patch.object(local_web, "connect") as connect, \
             patch.object(sys, "argv", ["local_web.py", "stop", "--legacy"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(local_web.main(), 2)
        connect.assert_not_called()

    def test_linux_launch_does_not_use_webbrowser_or_shell_and_redacts_ticket_from_output(self):
        executable = Path("/synthetic/chrome")
        with patch.object(local_web.platform, "system", return_value="Linux"), \
             patch.object(local_web.webbrowser, "open") as browser, \
             patch.object(local_web.subprocess, "Popen") as spawn, \
             patch.object(local_web, "find_browser", return_value=executable):
            self.assertTrue(local_web.launch_browser("http://127.0.0.1:1/launch#launch=" + "7" * 64))
        browser.assert_not_called()
        self.assertFalse(spawn.call_args.kwargs["shell"])
        self.assertNotIn("LD_PRELOAD", spawn.call_args.kwargs["env"])

    def test_linux_default_missing_browser_does_not_issue_launch_capability(self):
        client = Mock()
        with patch.object(local_web.platform, "system", return_value="Linux"), \
             patch.object(local_web, "RUNTIME", Path("/synthetic/node")), \
             patch.object(local_web, "FOLDER", Path("synthetic-private")), \
             patch.object(local_web, "connect", return_value=("http://127.0.0.1:1", client, {})), \
             patch.object(local_web, "find_browser", return_value=None), \
             patch.object(sys, "argv", ["local_web.py", "open"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(local_web.main(), 2)
        client.open.assert_not_called()

    def test_unsupported_platform_is_rejected_before_runtime_read(self):
        with patch.object(local_web, "RUNTIME", None), patch.object(local_web, "connect") as connect, \
             patch.object(sys, "argv", ["local_web.py", "status"]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(local_web.main(), 2)
        connect.assert_not_called()
        self.assertIn("macOS", output.getvalue())

    def test_linux_pid_image_and_hmac_precede_token_delivery(self):
        token, events = "7" * 64, []
        runtime = Path("/synthetic/node")
        saved = {"app": local_web.APP, "url": "http://127.0.0.1:1", "pid": 41,
                 "mode": "mock", "controlToken": token}
        client = Mock()
        def opened(req, **_kwargs):
            address = req.full_url if hasattr(req, "full_url") else str(req)
            if "/challenge?" in address:
                events.append("challenge")
                self.assertNotEqual(client.addheaders, [("X-Local-Control", token)])
                nonce = address.split("nonce=", 1)[1]
                proof = hmac.new(token.encode(), b"web-kakao-launcher-challenge\0" + nonce.encode(), hashlib.sha256).hexdigest()
                return io.BytesIO(json.dumps({"app": local_web.APP, "proof": proof}).encode())
            events.append("control")
            self.assertEqual(req.get_header("X-local-control"), token)
            return io.BytesIO(json.dumps({"app": local_web.APP, "build": 8, "mode": "mock"}).encode())
        client.open.side_effect = opened
        with patch.object(local_web.platform, "system", return_value="Linux"), \
             patch.object(local_web, "FOLDER", Path("synthetic-private")), \
             patch.object(local_web, "RUNTIME", runtime), patch.object(local_web, "verify_private_file"), \
             patch.object(Path, "read_text", return_value=json.dumps(saved)), \
             patch.object(local_web.request, "build_opener", return_value=client), \
             patch.object(local_web, "listener_owners", side_effect=AssertionError("Linux must use target verification")), \
             patch.object(linux, "assert_pid_listener", side_effect=lambda port, pid: events.append("pid") or True) as target, \
             patch.object(local_web, "process_image", side_effect=lambda pid: events.append("image") or str(runtime)):
            local_web.connect()
        target.assert_called_once_with(1, 41)
        self.assertEqual(events, ["pid", "image", "challenge", "control"])

    def test_linux_only_empty_target_table_is_stale_and_no_image_is_read(self):
        with patch.object(local_web.platform, "system", return_value="Linux"), \
             patch.object(local_web, "RUNTIME", Path("/synthetic/node")), \
             patch.object(local_web, "process_image") as image:
            with patch.object(linux, "assert_pid_listener", return_value=False), self.assertRaises(local_web.StaleRuntime):
                local_web.listener_matches(8787, 41)
            with patch.object(linux, "assert_pid_listener", side_effect=OSError("synthetic denied")), \
                 self.assertRaises(local_web.UntrustedServer) as rejected:
                local_web.listener_matches(8787, 41)
            self.assertNotIsInstance(rejected.exception, local_web.StaleRuntime)
        image.assert_not_called()

    def test_linux_target_image_and_hmac_failures_never_deliver_control_token(self):
        token = "7" * 64
        runtime = Path("/synthetic/node")
        saved = {"app": local_web.APP, "url": "http://127.0.0.1:1", "pid": 41,
                 "mode": "mock", "controlToken": token}
        for failure in ("target", "image", "hmac", "pid"):
            with self.subTest(failure=failure), contextlib.ExitStack() as stack:
                client = Mock()
                client.open.return_value = io.BytesIO(json.dumps({"app": local_web.APP, "proof": "wrong"}).encode())
                stack.enter_context(patch.object(local_web.platform, "system", return_value="Linux"))
                stack.enter_context(patch.object(local_web, "FOLDER", Path("synthetic-private")))
                stack.enter_context(patch.object(local_web, "RUNTIME", runtime))
                stack.enter_context(patch.object(local_web, "verify_private_file"))
                stack.enter_context(patch.object(Path, "read_text", return_value=json.dumps(saved)))
                stack.enter_context(patch.object(local_web.request, "build_opener", return_value=client))
                target = stack.enter_context(patch.object(linux, "assert_pid_listener", return_value=True))
                image = stack.enter_context(patch.object(local_web, "process_image", return_value=str(runtime)))
                if failure == "target":
                    target.side_effect = OSError("synthetic denied")
                elif failure == "image":
                    image.return_value = "/synthetic/different-node"
                expected = FileNotFoundError if failure == "pid" else local_web.UntrustedServer
                with self.assertRaises(expected):
                    local_web.connect(expected_pid=42 if failure == "pid" else None)
                self.assertNotEqual(client.addheaders, [("X-Local-Control", token)])
                if failure == "hmac":
                    self.assertEqual(client.open.call_count, 1)
                    challenge = client.open.call_args.args[0]
                    self.assertIsInstance(challenge, str)
                    self.assertIn("/api/local/challenge?nonce=", challenge)
                    self.assertNotIn(token, challenge)
                else:
                    client.open.assert_not_called()
                if failure == "pid":
                    target.assert_not_called()


if __name__ == "__main__":
    unittest.main()
