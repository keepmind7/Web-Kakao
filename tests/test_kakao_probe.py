"""오프라인 안전·실패 처리 테스트. 실제 계정 기능을 검증하지 않는다."""
import contextlib
import io
import json
import unittest
from unittest import mock
from urllib import error, request
from experiments import kakao_probe as kp


class ProbeTests(unittest.TestCase):
    def test_anonymous_control_is_not_chat_auth(self):
        result = kp.probe("anonymous_control", sender=lambda token: (
            401, b'{"code":-401,"msg":"synthetic-secret"}'))
        self.assertEqual(result["outcome"], "expected_auth_rejection")
        self.assertFalse(result["core_chat_verified"])
        self.assertNotIn("synthetic-secret", json.dumps(result))

    def test_http_200_is_not_enough(self):
        result = kp.summarize(200, b'{"id":123,"app_id":456}', "token_info")
        self.assertFalse(result["oauth_token_active"])

    def test_token_summary_does_not_leak_account_or_body(self):
        result = kp.summarize(200, b'{"id":123,"app_id":456,"expires_in":100,"token":"synthetic-secret"}', "token_info")
        self.assertTrue(result["oauth_token_active"])
        self.assertFalse(result["core_chat_verified"])
        self.assertFalse(any(key in result for key in ("id", "app_id", "token")))
        self.assertNotIn("synthetic-secret", json.dumps(result))

    def test_malformed_and_oversized_body(self):
        for body, outcome in [(b"not-json", "invalid_json"), (b"[]", "invalid_schema"),
                              (b"x" * (kp.MAX_BYTES + 1), "response_too_large")]:
            self.assertEqual(kp.summarize(200, body, "token_info")["outcome"], outcome)

    def test_network_errors_are_redacted(self):
        def sender(token):
            raise error.URLError("synthetic-secret")
        result = kp.probe("anonymous_control", sender=sender)
        self.assertEqual(result["outcome"], "network_or_input_error")
        self.assertNotIn("synthetic-secret", json.dumps(result))

    def test_redirect_is_not_followed(self):
        req = request.Request(kp.ENDPOINT, headers={"Authorization": "Bearer synthetic"})
        self.assertIsNone(kp.NoRedirect().redirect_request(req, None, 302, "", {}, "https://example.com"))

    def test_token_mode_requires_approval_before_network_or_input(self):
        with mock.patch.object(kp, "transport") as network, mock.patch.object(kp.getpass, "getpass") as prompt:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                kp.main(["--token-info"])
            network.assert_not_called()
            prompt.assert_not_called()

    def test_token_mode_refuses_noninteractive_input(self):
        with mock.patch.object(kp.sys.stdin, "isatty", return_value=False), mock.patch.object(kp.getpass, "getpass") as prompt:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                kp.main(["--token-info", "--account-read-approved"])
            prompt.assert_not_called()

    def test_anonymous_request_has_no_authorization_and_uses_get(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 401
        response.read.return_value = b'{"code":-401}'
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(kp.request, "build_opener", return_value=opener):
            kp.transport()
        req = opener.open.call_args.args[0]
        self.assertEqual(req.get_method(), "GET")
        self.assertIsNone(req.get_header("Authorization"))


if __name__ == "__main__":
    unittest.main()
