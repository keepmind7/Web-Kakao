"""공식 OAuth API 무인증 GET 및 브라우저 CORS preflight 대조 실험."""
import json
import ssl
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib import error, request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from experiments.kakao_probe import ENDPOINT, NoRedirect, probe

results = {"observed_at_utc": datetime.now(timezone.utc).isoformat(),
           "anonymous_get": probe("anonymous_control"), "real_account_verified": False}
req = request.Request(ENDPOINT, method="OPTIONS", headers={
    "Origin": "https://example.invalid", "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Headers": "authorization"})
opener = request.build_opener(request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
try:
    try:
        response = opener.open(req, timeout=15)
    except error.HTTPError as exc:
        response = exc
    with response:
        allow_origin = response.headers.get("Access-Control-Allow-Origin")
        allow_headers = response.headers.get("Access-Control-Allow-Headers", "")
        results["cors_preflight"] = {
            "http_status": response.code, "allow_origin": allow_origin,
            "authorization_header_allowed": "authorization" in allow_headers.lower(),
            "core_chat_verified": False,
            "scope": "CORS of token introspection endpoint only; not general chat support"}
except (error.URLError, OSError):
    results["cors_preflight"] = {"outcome": "network_error", "core_chat_verified": False}
target = ROOT / "evidence/alternatives/official-api-controls.json"
target.write_text(json.dumps(results, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
print(json.dumps(results, ensure_ascii=True, indent=2))
raise SystemExit(0 if results["anonymous_get"].get("outcome") == "expected_auth_rejection"
                 and "http_status" in results["cors_preflight"] else 2)
