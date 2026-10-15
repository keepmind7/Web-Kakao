"""새 후보가 사용하는 허용 모델 조회의 무인증 응답만 확인한다."""
import json
import ssl
from datetime import datetime, timezone
from pathlib import Path
from urllib import error, request

ROOT = Path(__file__).resolve().parent.parent
URL = "https://katalk.kakao.com/android/account/allowlist.json?model_name=SM-T733"
req = request.Request(URL, headers={"User-Agent":"Web-Kakao-Research/0.1", "Accept":"application/json"}, method="GET")
result = {"experiment":"candidate_allowlist_anonymous_get", "endpoint":URL,
          "device_identity_claimed":False, "account_used":False, "core_chat_verified":False,
          "observed_at_utc":datetime.now(timezone.utc).isoformat()}
opener = request.build_opener(request.HTTPSHandler(context=ssl.create_default_context()))
try:
    try:
        response = opener.open(req, timeout=15)
    except error.HTTPError as exc:
        response = exc
    with response:
        result["http_status"] = response.code
        body = response.read(16385)
        if len(body) <= 16384:
            try:
                data = json.loads(body)
                if isinstance(data,dict):
                    if type(data.get("allowlisted")) is bool:
                        result["allowlisted"] = data["allowlisted"]
                    if type(data.get("status")) is int:
                        result["api_status"] = data["status"]
                result["json_response"] = True
            except (ValueError, UnicodeError):
                result["json_response"] = False
except (error.URLError,OSError):
    result["outcome"] = "network_error"
target = ROOT / "evidence/alternatives/device-allowlist.json"
target.write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
print(json.dumps(result,indent=2))
raise SystemExit(0 if "http_status" in result else 2)
