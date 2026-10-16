"""이 노트북의 QR 인증 실험 웹 시작/상태/종료. 토큰·QR·코드를 출력하지 않는다."""
import argparse
import http.cookiejar
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib import request
from urllib.error import HTTPError
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / "local-only/web-auth"
RUNTIME = ROOT / "local-only/runtime/node-v24.21.0-win-x64/node.exe"
APP = "web-kakao-auth-lab-v1"


def connect():
    saved = json.loads((FOLDER / "runtime.json").read_text(encoding="utf-8"))
    url = saved["url"]
    parsed = urlparse(url)
    if saved.get("app") != APP or parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("잘못된 로컬 서버 정보")
    client = request.build_opener(request.ProxyHandler({}), request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    with client.open(url + "/", timeout=3) as response:
        response.read(65536)
    with client.open(url + "/api/status", timeout=3) as response:
        state = json.load(response)
    if state.get("app") != APP:
        raise ValueError("다른 서비스가 실행 중")
    return url, client, state


def public_status(url, state):
    # Allowlist only: never serialize QR grid, passcode, cookies, CSRF or credentials.
    return {"url": url, **{key: state[key] for key in ["build", "gapProbe", "messaging", "mode", "phase", "stage", "httpStatus", "apiStatus", "qrIssued", "credentialInMemory", "actualChatConnected", "chatConnectionActive", "actualMessageSent", "requests", "roomProbe", "reader"] if key in state}}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "status", "stop", "attempt", "probe"])
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--gap-probe", action="store_true", help="누락 구간에 MCHATLOGS를 한 번 확인하는 읽기 실험")
    parser.add_argument("--messaging", action="store_true", help="텍스트 전송과 읽음 상태 기능 활성화")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    try:
        current = connect()
    except (OSError, ValueError, KeyError):
        current = None
    if args.action == "start":
        if current:
            if bool(current[2].get("messaging")) != args.messaging:
                print("기존 서버와 요청한 대화 기능 모드가 다릅니다. 현재 세션을 유지했습니다. 모드를 바꾸려면 세션 정리 후 서버를 다시 시작하세요.")
                return 2
            if bool(current[2].get("gapProbe")) != args.gap_probe:
                print("기존 서버와 요청한 조회 모드가 다릅니다. 현재 세션은 유지했습니다. 모드를 바꾸려면 웹에서 로컬 세션 삭제 후 stop, 원하는 모드로 start 하세요.")
                return 2
            if current[2].get("mode") != ("mock" if args.mock else "live"):
                print("다른 모드의 로컬 인증 웹이 실행 중입니다. 먼저 stop으로 종료하세요.")
                return 2
            print(json.dumps(public_status(current[0], current[2]), ensure_ascii=False, indent=2))
            return 0
        FOLDER.mkdir(parents=True, exist_ok=True)
        env = {key: value for key, value in os.environ.items() if not key.startswith("KAKAO_") and key not in {"NODE_OPTIONS", "NODE_DEBUG", "NODE_USE_ENV_PROXY"}}
        command = [str(RUNTIME), str(ROOT / "experiments/local-web/server.mjs"), "--port", str(args.port)]
        if not args.mock:
            command.append("--live")
        if args.gap_probe:
            command.append("--gap-probe")
        if args.messaging:
            command.append("--messaging")
        with (FOLDER / "server.stdout.log").open("ab") as stdout, (FOLDER / "server.stderr.log").open("ab") as stderr:
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=stdout, stderr=stderr,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        for _ in range(40):
            if process.poll() is not None:
                print("로컬 서버 시작 실패. local-only/web-auth/server.stderr.log를 확인하세요.")
                return 2
            try:
                url, _, state = connect()
                print(json.dumps(public_status(url, state), ensure_ascii=False, indent=2))
                return 0
            except (OSError, ValueError, KeyError):
                time.sleep(0.2)
        print("로컬 서버 준비 시간을 초과했습니다.")
        return 2
    if not current:
        print("실행 중인 로컬 인증 웹이 없습니다.")
        return 2
    url, client, state = current
    if args.action in {"stop", "attempt", "probe"}:
        path = {"stop":"/api/shutdown", "attempt":"/api/start", "probe":"/api/room-probe"}[args.action]
        req = request.Request(url + path, data=b"{}", method="POST", headers={"Origin": url, "Content-Type": "application/json", "X-CSRF-Token": state["csrf"]})
        try:
            with client.open(req, timeout=5) as response:
                state = json.load(response)
        except HTTPError as error:
            if error.code == 409:
                print("진행 중인 인증·연결이 있거나 요청할 수 없는 상태입니다. 종료하려면 웹에서 로컬 세션을 먼저 지워 주세요.")
                return 2
            raise
    print(json.dumps(public_status(url, state), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
