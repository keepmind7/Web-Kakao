"""실제 네트워크/계정 없이 인증 전제의 오류·거부 처리를 확인한다."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from experiments.auth_preflight import SOURCE, allowlist_accepted, inspect_source

# WEB_KAKAO_STRICT=1 turns a missing prerequisite into a failure instead of a silent skip.
STRICT = os.environ.get("WEB_KAKAO_STRICT") == "1"


class AuthPreflightTests(unittest.TestCase):
    def test_explicit_model_denial_does_not_allow_progress(self):
        self.assertFalse(allowlist_accepted(200, {"allowlisted": False}))

    def test_non_boolean_or_missing_allowlist_does_not_allow_progress(self):
        for body in ({}, {"allowlisted": 1}, {"allowlisted": "true"}, "ok", None):
            with self.subTest(body=body):
                self.assertFalse(allowlist_accepted(200, body))

    def test_http_error_cannot_be_overridden_by_body(self):
        self.assertFalse(allowlist_accepted(415, {"allowlisted": True}))

    def test_api_error_cannot_be_overridden_by_allowlist(self):
        for status in (-132, "0", False):
            self.assertFalse(allowlist_accepted(200, {"allowlisted": True, "status": status}))

    def test_explicit_success_is_only_model_acceptance(self):
        self.assertTrue(allowlist_accepted(200, {"allowlisted": True, "status": 0}))

    def test_missing_or_changed_source_is_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(inspect_source(root)["outcome"], "source_missing")
            path = root / "src/kakao/auth.ts"
            path.parent.mkdir(parents=True)
            path.write_text("changed", encoding="utf-8")
            self.assertEqual(inspect_source(root)["outcome"], "source_changed")

    @unittest.skipUnless(SOURCE.exists() or STRICT, "고정 공개 소스 미다운로드")
    def test_current_windows_candidate_stops_before_auth_or_secret_read(self):
        self.assertTrue(SOURCE.exists(), "WEB_KAKAO_STRICT=1: 고정 공개 소스 미다운로드")
        # 네트워크 호출이나 외부 프로그램 실행이 추가되면 회귀를 검출한다.
        with patch("socket.socket", side_effect=AssertionError("network forbidden")), \
             patch("subprocess.Popen", side_effect=AssertionError("process forbidden")):
            result = inspect_source(host="Windows")
        self.assertTrue(result["host_profile_mismatch"])
        self.assertFalse(result["ready"])
        self.assertFalse(result["authentication_attempted"])
        self.assertEqual(result["network_requests"], 0)
        self.assertFalse(result["credentials_read_or_saved"])
        # 프로필이 같은 OS에서도 정상 등록 증거를 지어내지 않는다.
        self.assertFalse(inspect_source(host="Android")["ready"])
        self.assertNotIn("accessToken", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
