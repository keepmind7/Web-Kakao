"""이 노트북의 QR 인증 실험 웹 시작/상태/종료. 토큰·QR·코드를 출력하지 않는다."""
import argparse
import http.cookiejar
import json
import os
import subprocess
import sys
import time
import socket
import webbrowser
from pathlib import Path
from urllib import request
from urllib.error import HTTPError
from urllib.parse import urlparse
try:
    from tools.private_storage import data_root, ensure_private_directory, migrate_preferences, verify_private_file, is_junction
except ModuleNotFoundError:
    from private_storage import data_root, ensure_private_directory, migrate_preferences, verify_private_file, is_junction

ROOT = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)))
FOLDER = data_root(ROOT) / "web-auth"
RUNTIME = ROOT / "local-only/runtime/node-v24.21.0-win-x64/node.exe"
APP = "web-kakao-auth-lab-v1"


def connect(*, legacy=False):
    folder = ROOT / "local-only/web-auth" if legacy else FOLDER
    if not legacy:
        verify_private_file(folder / "runtime.json", max_bytes=4096)
    else:
        runtime = folder / "runtime.json"
        for item in (runtime, folder):
            if item.is_symlink() or is_junction(item):
                raise ValueError("잘못된 이전 서버 정보")
        if not runtime.is_file() or runtime.stat().st_size > 4096:
            raise ValueError("잘못된 이전 서버 정보")
    saved = json.loads((folder / "runtime.json").read_text(encoding="utf-8"))
    url = saved["url"]
    parsed = urlparse(url)
    if saved.get("app") != APP or parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.path or parsed.query or parsed.fragment or parsed.username is not None or parsed.password is not None:
        raise ValueError("잘못된 로컬 서버 정보")
    if type(saved.get("pid")) is not int or saved["pid"] <= 0 or saved.get("mode") not in {"live", "mock"}:
        raise ValueError("잘못된 로컬 서버 정보")
    client = request.build_opener(request.ProxyHandler({}), request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    if legacy:
        with client.open(url + "/", timeout=3) as response:
            response.read(65536)
        status_request = url + "/api/status"
    else:
        token = saved["controlToken"]
        if not isinstance(token, str) or len(token) != 64 or any(char not in "0123456789abcdef" for char in token):
            raise ValueError("잘못된 로컬 실행 권한")
        client.addheaders = [("X-Local-Control", token)]
        status_request = request.Request(url + "/api/local/status", headers={"X-Local-Control": token})
    with client.open(status_request, timeout=3) as response:
        state = json.load(response)
    if state.get("app") != APP or state.get("mode") != saved["mode"] or legacy and state.get("build") != 7 or not legacy and state.get("build", 0) < 8:
        raise ValueError("다른 서비스가 실행 중")
    # Retain only for compare-and-remove after this exact instance acknowledges
    # an explicit shutdown. Never print this private identity record.
    client.local_runtime_record = saved
    return url, client, state


def public_status(url, state):
    # Allowlist only: never serialize QR grid, passcode, cookies, CSRF or credentials.
    return {"url": url, **{key: state[key] for key in ["build", "gapProbe", "messaging", "preferences", "outboxRecovery", "viewPin", "mode", "phase", "stage", "httpStatus", "apiStatus", "qrIssued", "credentialInMemory", "actualChatConnected", "chatConnectionActive", "actualMessageSent", "canStart", "canProbe", "attempts", "sessionBlocked"] if key in state}}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "status", "stop", "attempt", "probe", "open", "migrate-preferences"])
    parser.add_argument("--legacy", action="store_true", help="이전 build7 서버를 명시적으로 정상 종료할 때만 사용")
    parser.add_argument("--source", type=Path, help="사용자가 확인한 이전 개인 설정 폴더")
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--gap-probe", action="store_true", help="누락 구간에 MCHATLOGS를 한 번 확인하는 읽기 실험")
    parser.add_argument("--messaging", action="store_true", help="텍스트 전송과 읽음 상태 기능 활성화")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    if args.legacy and args.action != "stop":
        print("--legacy는 이전 서버 종료만 지원합니다.")
        return 2
    if not 1 <= args.port <= 65535:
        print("잘못된 로컬 포트입니다.")
        return 2
    try:
        current = connect(legacy=True) if args.legacy else connect()
    except FileNotFoundError:
        current = None
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print("로컬 실행 정보를 확인할 수 없습니다. 기존 서버와 파일을 유지했습니다.")
        return 2
    if args.action == "migrate-preferences":
        if current or args.source is None:
            print("이전할 원본 폴더를 지정하고 모든 서버를 종료해 주세요.")
            return 2
        # Refuse if any retained legacy runtime cannot positively be shown absent.
        if (ROOT / "local-only/web-auth/runtime.json").exists():
            print("이전 서버 실행 정보를 먼저 확인하고 정리해 주세요.")
            return 2
        try:
            with socket.create_connection(("127.0.0.1", args.port), timeout=0.3):
                print("실행 중인 로컬 서비스가 있어 이전하지 않았습니다.")
                return 2
        except ConnectionRefusedError:
            pass
        except OSError:
            print("실행 상태를 확인할 수 없어 이전하지 않았습니다.")
            return 2
        try:
            result = migrate_preferences(args.source, data_root(ROOT) / "preferences", server_active=False)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            print("개인 설정 이전을 중단했습니다. 원본과 실행 상태를 확인해 주세요.")
            return 2
        print(json.dumps(result))
        return 0
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
        # A missing runtime file is insufficient if another process owns the port.
        try:
            with socket.create_connection(("127.0.0.1", args.port), timeout=0.3):
                print("포트가 사용 중입니다. 기존 프로세스를 유지했습니다.")
                return 2
        except ConnectionRefusedError:
            pass
        except OSError:
            print("로컬 포트 상태를 확인할 수 없습니다.")
            return 2
        try:
            ensure_private_directory(FOLDER)
            for name in ("server.stdout.log", "server.stderr.log"):
                verify_private_file(FOLDER / name, max_bytes=64 * 1024 * 1024)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            print("개인 저장소 권한을 확인할 수 없어 시작하지 않았습니다.")
            return 2
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
                print("로컬 서버 시작 실패. 개인 저장소의 서버 로그를 확인하세요.")
                return 2
            try:
                url, _, state = connect()
                print(json.dumps(public_status(url, state), ensure_ascii=False, indent=2))
                return 0
            except FileNotFoundError:
                time.sleep(0.2)
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                print("새 서버 실행 정보를 확인할 수 없습니다. 추가 시작을 중단했습니다.")
                return 2
        print("로컬 서버 준비 시간을 초과했습니다.")
        return 2
    if not current:
        print("실행 중인 로컬 인증 웹이 없습니다.")
        return 2
    url, client, state = current
    if args.action == "open":
        req = request.Request(url + "/api/local/launch", data=b"{}", method="POST", headers={"Origin": url, "Content-Type": "application/json"})
        with client.open(req, timeout=5) as response:
            ticket = json.load(response).get("ticket")
        if not isinstance(ticket, str) or len(ticket) != 64 or any(char not in "0123456789abcdef" for char in ticket):
            print("로컬 실행 권한을 발급하지 못했습니다.")
            return 2
        webbrowser.open(url + "/launch#launch=" + ticket)
        print("로컬 웹 열기를 요청했습니다.")
        return 0
    if args.action in {"stop", "attempt", "probe"}:
        path = {"stop":"shutdown", "attempt":"start", "probe":"room-probe"}[args.action]
        path = "/api/" + path if args.legacy else "/api/local/control/" + path
        headers = {"Origin": url, "Content-Type": "application/json"}
        if args.legacy:
            headers["X-CSRF-Token"] = state["csrf"]
        req = request.Request(url + path, data=b"{}", method="POST", headers=headers)
        try:
            with client.open(req, timeout=5) as response:
                state = json.load(response)
        except HTTPError as error:
            if error.code == 409:
                print("진행 중인 인증·연결이 있거나 요청할 수 없는 상태입니다. 종료하려면 웹에서 로컬 세션을 먼저 지워 주세요.")
                return 2
            raise
        if args.action == "stop":
            runtime = (ROOT / "local-only/web-auth" if args.legacy else FOLDER) / "runtime.json"
            try:
                if not args.legacy:
                    verify_private_file(runtime, max_bytes=4096)
                saved = json.loads(runtime.read_text(encoding="utf-8"))
                if saved == client.local_runtime_record:
                    runtime.unlink()
            except FileNotFoundError:
                pass  # The server may have removed its own verified record.
            except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
                print("서버 종료 응답을 받았지만 실행 정보 정리가 필요합니다.")
                return 2
    print(json.dumps(public_status(url, state), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
