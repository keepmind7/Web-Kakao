import contextlib
import io
import sys
import unittest
from unittest.mock import patch

from tools import local_web


class ExistingServerModeTests(unittest.TestCase):
    def invoke(self, existing_gap, requested_gap):
        state = {"mode": "live", "gapProbe": existing_gap,
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


if __name__ == "__main__":
    unittest.main()
