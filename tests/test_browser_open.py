"""Browser-open CLI contracts. All browser/process/client operations are mocked."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

from tools import local_web


class BrowserOpenTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="browser-open-")
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.url, self.ticket = "http://127.0.0.1:46321", "b" * 64
        self.environment = {"ProgramFiles": str(self.folder / "Program Files"),
                            "ProgramFiles(x86)": str(self.folder / "Program Files x86"),
                            "ProgramW6432": str(self.folder / "Program Files native64"),
                            "LOCALAPPDATA": str(self.folder / "Local App Data"),
                            "BROWSER": "cmd /c SYNTHETIC_MUST_NOT_EXECUTE",
                            "PATH": str(self.folder / "hostile-path")}
        for patcher in [patch.dict(os.environ, self.environment),
                        patch.object(local_web, "FOLDER", self.folder / "launcher"),
                        patch.object(local_web.subprocess, "run", side_effect=AssertionError("no external commands")),
                        patch.object(local_web.socket, "create_connection", side_effect=AssertionError("no sockets")),
                        patch.object(local_web.request, "build_opener", side_effect=AssertionError("no real client"))]:
            patcher.start()
            self.addCleanup(patcher.stop)

    def installed(self, name, location="ProgramFiles"):
        tail = "Google/Chrome/Application/chrome.exe" if name == "chrome" else "Microsoft/Edge/Application/msedge.exe"
        executable = Path(self.environment[location]) / tail
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b"SYNTHETIC_NOT_EXECUTABLE")
        return executable

    def invoke(self, *args, browser_value=True, browser_error=None, process_error=None,
               trust_error=None, ticket_error=None, ticket_payload=None):
        client = Mock()
        client.open.return_value = io.BytesIO(json.dumps({"ticket": self.ticket}).encode() if ticket_payload is None else ticket_payload)
        client.open.side_effect = ticket_error
        process = Mock()
        process.poll.return_value = None
        output, errors = io.StringIO(), io.StringIO()
        exception = None
        with patch.object(sys, "argv", ["local_web.py", *args]), \
             patch.object(local_web, "connect", return_value=(self.url, client, {"build": 8}), side_effect=trust_error) as connect, \
             patch.object(local_web.webbrowser, "open", return_value=browser_value, side_effect=browser_error) as browser, \
             patch.object(local_web.subprocess, "Popen", return_value=process, side_effect=process_error) as popen, \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            try:
                code = local_web.main()
            except SystemExit as error:
                code = error.code
            except Exception as error:
                code, exception = None, type(error).__name__
        return {"code": code, "exception": exception, "output": output.getvalue() + errors.getvalue(),
                "connect": connect, "client": client, "browser": browser, "popen": popen}

    def safe(self, result, code):
        self.assertIsNone(result["exception"], "uncaught product exception: " + str(result["exception"]))
        self.assertEqual(result["code"], code)
        self.assertNotIn(self.ticket, result["output"])
        self.assertNotIn(self.url + "/launch", result["output"])
        self.assertNotIn("Traceback", result["output"])
        self.assertLess(len(result["output"]), 1800)

    def test_default_false_is_a_safe_failure_instead_of_requested_success(self):
        result = self.invoke("open", browser_value=False)
        self.safe(result, 2)
        self.assertIn("브라우저", result["output"])
        self.assertIn("--browser", result["output"])
        self.assertNotIn("열기를 요청했습니다", result["output"])

    def test_default_oserror_is_a_safe_fixed_failure(self):
        result = self.invoke("open", browser_error=OSError(self.url + "/launch#launch=" + self.ticket))
        self.safe(result, 2)
        self.assertIn("브라우저", result["output"])

    def test_default_webbrowser_error_is_a_safe_fixed_failure(self):
        result = self.invoke("open", browser_error=local_web.webbrowser.Error(self.ticket))
        self.safe(result, 2)

    def test_default_success_remains_one_system_open_request_and_guides_new_tab(self):
        result = self.invoke("open")
        self.safe(result, 0)
        result["browser"].assert_called_once_with(self.url + "/launch#launch=" + self.ticket)
        result["popen"].assert_not_called()
        self.assertIn("새", result["output"])
        self.assertIn("탭", result["output"])

    def explicit(self, name, location="ProgramFiles"):
        executable = self.installed(name, location)
        result = self.invoke("open", "--browser", name)
        self.safe(result, 0)
        result["browser"].assert_not_called()
        result["popen"].assert_called_once()
        call = result["popen"].call_args
        self.assertEqual(call.args[0], [str(executable), "--new-window", self.url + "/launch#launch=" + self.ticket])
        self.assertFalse(call.kwargs.get("shell", False))
        self.assertEqual(call.kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(call.kwargs["stderr"], subprocess.DEVNULL)
        request = result["client"].open.call_args.args[0]
        self.assertEqual(request.full_url, self.url + "/api/local/launch")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.data, b"{}")
        self.assertEqual(request.get_header("Origin"), self.url)
        self.assertIn(name, result["output"].lower())
        self.assertIn("탭", result["output"])

    def test_chrome_absolute_programfiles_argv_preserves_whole_fragment(self):
        self.explicit("chrome")

    def test_edge_absolute_x86_programfiles_argv_preserves_whole_fragment(self):
        self.explicit("edge", "ProgramFiles(x86)")

    def test_chrome_localappdata_install_is_allowed_without_path_search(self):
        self.explicit("chrome", "LOCALAPPDATA")

    def test_32bit_python_finds_64bit_chrome_in_programw6432(self):
        # On Windows x64, a 32-bit Python sees both ProgramFiles aliases as x86.
        # Every path is synthetic; no installed browser or process is used.
        aliases = {"ProgramFiles": self.environment["ProgramFiles(x86)"],
                   "ProgramFiles(x86)": self.environment["ProgramFiles(x86)"]}
        with patch.dict(os.environ, aliases):
            self.explicit("chrome", "ProgramW6432")

    def test_32bit_python_finds_64bit_edge_in_programw6432(self):
        aliases = {"ProgramFiles": self.environment["ProgramFiles(x86)"],
                   "ProgramFiles(x86)": self.environment["ProgramFiles(x86)"]}
        with patch.dict(os.environ, aliases):
            self.explicit("edge", "ProgramW6432")

    def test_explicit_oserror_after_ticket_does_not_expose_fragment(self):
        self.installed("chrome")
        result = self.invoke("open", "--browser", "chrome", process_error=OSError(self.ticket))
        self.safe(result, 2)
        result["client"].open.assert_called_once()
        result["popen"].assert_called_once()
        self.assertIn("브라우저", result["output"])

    def test_explicit_subprocess_error_is_safe_and_never_uses_default_fallback(self):
        self.installed("edge")
        result = self.invoke("open", "--browser", "edge", process_error=subprocess.SubprocessError(self.ticket))
        self.safe(result, 2)
        result["popen"].assert_called_once()
        result["browser"].assert_not_called()

    def test_missing_browser_ignores_path_and_browser_env_and_issues_no_ticket(self):
        hostile = Path(self.environment["PATH"]) / "chrome.exe"
        hostile.parent.mkdir()
        hostile.write_bytes(b"SYNTHETIC_NOT_EXECUTABLE")
        result = self.invoke("open", "--browser", "chrome")
        self.safe(result, 2)
        result["client"].open.assert_not_called()
        result["popen"].assert_not_called()
        result["browser"].assert_not_called()
        self.assertIn("chrome", result["output"].lower())
        self.assertNotIn("unrecognized arguments", result["output"])

    def test_non_open_selector_is_rejected_before_connect(self):
        for action in ["start", "status", "stop", "attempt", "probe", "migrate-preferences"]:
            with self.subTest(action=action):
                result = self.invoke(action, "--browser", "edge")
                self.safe(result, 2)
                result["connect"].assert_not_called()
                result["popen"].assert_not_called()
                result["browser"].assert_not_called()

    def test_help_and_invalid_selector_are_inert_before_any_client_or_process(self):
        for args, code in [(('--help',), 0), (('open', '--browser', 'hostile'), 2)]:
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.safe(result, code)
                result["connect"].assert_not_called()
                result["client"].open.assert_not_called()
                result["popen"].assert_not_called()
                result["browser"].assert_not_called()

    def test_untrusted_server_gates_default_and_explicit_launch_and_ticket(self):
        self.installed("chrome")
        for args in [("open",), ("open", "--browser", "chrome")]:
            with self.subTest(args=args):
                result = self.invoke(*args, trust_error=local_web.UntrustedServer("경고: 합성 신뢰 거절"))
                self.safe(result, 2)
                result["connect"].assert_called_once()
                result["client"].open.assert_not_called()
                result["popen"].assert_not_called()
                result["browser"].assert_not_called()

    def test_ticket_network_error_is_safe_and_never_launches(self):
        result = self.invoke("open", ticket_error=URLError(self.ticket))
        self.safe(result, 2)
        result["popen"].assert_not_called()
        result["browser"].assert_not_called()

    def test_malformed_ticket_json_is_safe_and_never_launches(self):
        result = self.invoke("open", ticket_payload=b"not-json")
        self.safe(result, 2)
        result["popen"].assert_not_called()
        result["browser"].assert_not_called()


if __name__ == "__main__":
    unittest.main()
