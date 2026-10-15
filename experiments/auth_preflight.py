"""고정 QR 후보의 인증 전제 검사. 원본을 import/실행하거나 QR을 발급하지 않는다."""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMMIT = "8dbbd4f7ed6b42542982252250622fa351af00e9"
SOURCE = ROOT / "local-only" / "sources" / "modern" / COMMIT
EXPECTED = {
    "src/kakao/auth.ts": "e4869df418ff9accdde1b44476532e4bcaf6096025acdf073362ecf6afc8cfff",
    "src/kakao/forge-protocol.ts": "2f07f4c8fb8fa16d4e4fdd2307b2ab2d26fc4a3ced83ebf33ce1c808754c9489",
}


def read_profile(text: str) -> dict[str, str]:
    fields = {
        "os": "KAKAO_OS", "model": "KAKAO_MODEL_NAME",
        "os_version": "KAKAO_OS_VERSION", "app_version": "KAKAO_APP_VERSION",
    }
    result = {}
    for name, constant in fields.items():
        match = re.search(r"export const " + constant + r" = '([^']+)';", text)
        if not match:
            raise ValueError("고정 소스 프로필을 확인할 수 없음")
        result[name] = match.group(1)
    return result


def allowlist_accepted(http_status: int, body: object) -> bool:
    """HTTP 성공 또는 truthy 값만으로 기기 허용을 추정하지 않는다."""
    return (
        http_status == 200
        and isinstance(body, dict)
        and body.get("allowlisted") is True
        and ("status" not in body or (type(body["status"]) is int and body["status"] == 0))
    )


def inspect_source(source: Path = SOURCE, host: str | None = None) -> dict:
    """고정된 공개 파일만 읽는다. 계정 파일, .env, credential은 읽지 않는다."""
    host = host or platform.system()
    hashes = {}
    texts = {}
    for name, expected in EXPECTED.items():
        try:
            raw = (source / name).read_bytes()
        except OSError:
            return {"ready": False, "outcome": "source_missing", "network_requests": 0}
        hashes[name] = hashlib.sha256(raw).hexdigest()
        if hashes[name] != expected:
            return {"ready": False, "outcome": "source_changed", "network_requests": 0}
        texts[name] = raw.decode("utf-8")
    profile = read_profile(texts["src/kakao/forge-protocol.ts"])
    # Android 호스트에서 실행하더라도 이 모델의 실제 등록 조건이 입증된 것은 아니다.
    # 이 버전은 정상 독립 등록 경로가 미확인이라 live 백엔드를 제공하지 않는다.
    return {
        "experiment": "qr_authentication_preflight",
        "observed_at_utc": datetime.now(timezone.utc).isoformat(),
        "candidate_commit": COMMIT,
        "source_sha256": hashes,
        "execution_host": host,
        "declared_registration_profile": profile,
        "host_profile_mismatch": host == "Windows" and profile["os"] == "android",
        "normal_independent_registration_verified": False,
        "original_allowlist_error_continues": True,
        "original_credential_persistence": "plaintext auth.json on Windows",
        "original_logout_scope": "local credential deletion only",
        "ready": False,
        "outcome": "blocked_before_qr_generation",
        "reason": "정상 Windows/서버 등록 경로 미확인; 고정 Android 태블릿 프로필을 그대로 사용하지 않음",
        "network_requests": 0,
        "qr_generated": False,
        "authentication_attempted": False,
        "credentials_read_or_saved": False,
        "actual_message_sent": False,
    }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", action="store_true", help="비밀 없는 사전 검사 결과만 evidence에 저장")
    args = parser.parse_args()
    result = inspect_source()
    if args.record:
        target = ROOT / "evidence" / "auth-attempt" / "preflight.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    # 검사 실행 성공과 live 준비 완료를 구분한다. 차단/미확인은 종료2다.
    return 0 if result["ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
