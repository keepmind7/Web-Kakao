"""카카오 OAuth API 대조 실험. 카카오톡 클라이언트 연결 구현이 아니다."""
import argparse
import getpass
import json
import ssl
import sys
import warnings
from datetime import datetime, timezone
from urllib import error, request

ENDPOINT = "https://kapi.kakao.com/v1/user/access_token_info"
MAX_BYTES = 16384


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Authorization 헤더를 다른 호스트로 전달하지 않는다.
        return None


def transport(token=None):
    headers = {"Accept": "application/json", "User-Agent": "Web-Kakao-Phase1/0.1"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = request.Request(ENDPOINT, headers=headers, method="GET")
    opener = request.build_opener(
        request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect()
    )
    try:
        with opener.open(req, timeout=15) as response:
            return response.status, response.read(MAX_BYTES + 1)
    except error.HTTPError as exc:
        with exc:
            return exc.code, exc.read(MAX_BYTES + 1)


def summarize(status, body, mode):
    result = {
        "experiment": mode,
        "endpoint": ENDPOINT,
        "http_status": status,
        "core_chat_verified": False,
        "scope": "OAuth token introspection only",
    }
    if len(body) > MAX_BYTES:
        result["outcome"] = "response_too_large"
        return result
    try:
        data = json.loads(body)
    except (ValueError, UnicodeError):
        result["outcome"] = "invalid_json"
        return result
    if not isinstance(data, dict):
        result["outcome"] = "invalid_schema"
        return result
    code = data.get("code")
    # 응답 본문/메시지/계정 ID/앱 ID/키를 반환하지 않는다.
    if type(code) is int:
        result["api_error_code"] = code
    if mode == "anonymous_control":
        result["outcome"] = (
            "expected_auth_rejection" if status == 401 and code == -401
            else "unexpected_response"
        )
    else:
        expires = data.get("expires_in")
        valid_schema = type(expires) is int and expires > 0
        result["oauth_token_active"] = status == 200 and valid_schema
        result["outcome"] = (
            "oauth_token_info_received" if result["oauth_token_active"]
            else "oauth_token_not_confirmed"
        )
    return result


def probe(mode, token=None, sender=transport):
    try:
        status, body = sender(token)
        result = summarize(status, body, mode)
    except (error.URLError, OSError, ValueError):
        # 예외 원문에는 URL/프록시/헤더 등의 비밀이 섞일 수 있다.
        result = {"experiment": mode, "endpoint": ENDPOINT,
                  "outcome": "network_or_input_error", "core_chat_verified": False}
    result["observed_at_utc"] = datetime.now(timezone.utc).isoformat()
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--anonymous-control", action="store_true",
                       help="자격증명 없이 인증 거부를 확인")
    modes.add_argument("--token-info", action="store_true",
                       help="이미 발급된 본인 OAuth 토큰을 읽기 전용으로 검사")
    parser.add_argument("--account-read-approved", action="store_true",
                        help="사용자에게 계정·API·읽기 범위 승인을 받은 뒤에만 사용")
    args = parser.parse_args(argv)
    token = None
    if args.token_info:
        if not args.account_read_approved:
            parser.error("토큰 검사에는 먼저 사용자 승인이 필요합니다.")
        if not sys.stdin.isatty():
            parser.error("토큰은 로컬 대화형 터미널에서만 입력할 수 있습니다.")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                token = getpass.getpass("본인 OAuth 액세스 토큰 (화면·파일에 기록하지 않음): ")
        except (getpass.GetPassWarning, EOFError, KeyboardInterrupt):
            parser.error("화면에 표시되지 않는 입력을 사용할 수 없어 중단했습니다.")
        if not token or any(char.isspace() for char in token):
            parser.error("토큰이 비어 있거나 공백을 포함합니다.")
    mode = "token_info" if args.token_info else "anonymous_control"
    result = probe(mode, token)
    token = None
    print(json.dumps(result, ensure_ascii=True, indent=2))
    expected = {"expected_auth_rejection", "oauth_token_info_received"}
    return 0 if result["outcome"] in expected else 2


if __name__ == "__main__":
    raise SystemExit(main())
