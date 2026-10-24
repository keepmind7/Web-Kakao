"""이 노트북의 QR 인증 실험 웹 시작/상태/종료. 토큰·QR·코드를 출력하지 않는다."""
import argparse
import hashlib
import hmac
import http.cookiejar
import json
import os
import platform
import secrets
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
    from tools.platforms import common as launch_platform
    from tools.runtime_distribution import runtime_path
except ModuleNotFoundError:
    from private_storage import data_root, ensure_private_directory, migrate_preferences, verify_private_file, is_junction
    from platforms import common as launch_platform
    from runtime_distribution import runtime_path

ROOT = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)))
try:
    FOLDER = data_root(ROOT) / "web-auth"
except ValueError:
    FOLDER = None  # Import and --help must work without a private storage location.
try:
    RUNTIME = runtime_path(ROOT)
except ValueError:
    RUNTIME = None  # Unsupported OS/CPU is rejected before any runtime IO.
APP = "web-kakao-auth-lab-v1"
# Allowlist: NODE_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS, proxies and KAKAO_* never reach the server.
SERVER_ENV = launch_platform.SERVER_ENV


class UntrustedServer(ValueError):
    """The port or runtime record failed verification; never send secrets or open a browser."""


class StaleRuntime(UntrustedServer):
    pass


def listener_owners(port):
    return launch_platform.backend().listener_owners(port)


def process_image(pid):
    return launch_platform.backend().process_image(pid)


def assert_port_available(port):
    """Refuse occupied ports; a filtered SYN alone cannot prove occupancy."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            pass
    except ConnectionRefusedError:
        return
    except TimeoutError:
        # Some Windows firewall configurations drop a SYN to an unused port.
        # An exclusive bind independently checks availability without accepting
        # connections or granting trust to any service. The new server is still
        # authenticated by PID/path and challenge after it starts.
        if os.name != "nt" or not hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            raise UntrustedServer("로컬 포트 상태를 확인할 수 없습니다.")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(("127.0.0.1", port))
        return
    raise UntrustedServer("포트가 사용 중입니다. 기존 프로세스를 유지했습니다.")


def listener_matches(port, pid):
    """Verify listener PID evidence and this installation's fixed Node image.

    Linux proves target possession of all LISTEN inodes, not exclusive ownership
    against hostile processes sharing the same OS user or transferred FDs.
    """
    if RUNTIME is None:
        raise UntrustedServer("이 OS·CPU에서는 로컬 서버 프로세스 확인을 지원하지 않습니다.")
    target_check = platform.system() == "Linux"
    try:
        if target_check:
            present = launch_platform.backend().assert_pid_listener(port, pid)
        else:
            owners = listener_owners(port)
            present = bool(owners)
    except (OSError, ValueError):
        raise UntrustedServer("로컬 포트 소유자를 확인할 수 없습니다. 같은 OS 사용자와 권한으로 실행하세요.") from None
    if not present:
        raise StaleRuntime("실행 정보의 포트에 서버가 없습니다. 비정상 종료 후 남은 실행 정보로 보고 신뢰하지 않습니다.")
    if not target_check and owners != {pid}:
        raise UntrustedServer("경고: 포트를 점유한 프로세스가 기록된 프로젝트 Node 서버가 아닙니다. 권한 정보를 보내지 않았습니다.")
    try:
        path = process_image(pid)
    except (OSError, ValueError):
        raise UntrustedServer("서버 실행 경로를 확인할 수 없습니다. start와 open을 같은 OS 사용자·권한으로 실행하세요.") from None
    if not path or os.path.normcase(os.path.realpath(path)) != os.path.normcase(os.path.realpath(RUNTIME)):
        raise UntrustedServer("경고: 포트를 점유한 프로세스가 기록된 프로젝트 Node 서버가 아닙니다. 다른 프로그램이 서버를 사칭할 수 있어 권한 정보를 보내지 않았습니다.")


def broad_write_warnings():
    """Read-only OS audit; do not repair the user's workspace permissions."""
    return launch_platform.backend().broad_write_warnings(ROOT)


def connect(*, legacy=False, expected_pid=None):
    if FOLDER is None and not legacy:
        raise ValueError("개인 저장소 경로가 필요합니다.")
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
    if expected_pid is not None and saved["pid"] != expected_pid:
        raise FileNotFoundError("runtime_not_yet_written")
    client = request.build_opener(request.ProxyHandler({}), request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    if legacy:
        with client.open(url + "/", timeout=3) as response:
            response.read(65536)
        status_request = url + "/api/status"
    else:
        token = saved["controlToken"]
        if not isinstance(token, str) or len(token) != 64 or any(char not in "0123456789abcdef" for char in token):
            raise ValueError("잘못된 로컬 실행 권한")
        listener_matches(parsed.port, saved["pid"])
        # The server proves knowledge of the token before the token is ever sent.
        nonce = secrets.token_hex(32)
        with client.open(url + "/api/local/challenge?nonce=" + nonce, timeout=3) as response:
            challenge = json.load(response)
        expected = hmac.new(token.encode("ascii"), b"web-kakao-launcher-challenge\0" + nonce.encode("ascii"), hashlib.sha256).hexdigest()
        if not isinstance(challenge, dict) or challenge.get("app") != APP or not isinstance(challenge.get("proof"), str) or not hmac.compare_digest(challenge["proof"], expected):
            raise UntrustedServer("경고: 포트의 서버가 실행 권한을 증명하지 못했습니다. 사칭 가능성이 있어 권한 정보를 보내지 않았습니다.")
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
    return {"url": url, **{key: state[key] for key in ["build", "gapProbe", "messaging", "photoTransport", "preferences", "outboxRecovery", "viewPin", "mode", "phase", "stage", "httpStatus", "apiStatus", "qrIssued", "credentialInMemory", "actualChatConnected", "chatConnectionActive", "actualMessageSent", "canStart", "canProbe", "attempts", "sessionBlocked"] if key in state}}


def find_browser(name):
    return launch_platform.backend().find_browser(name)


def launch_browser(url, browser="default", executable=None):
    # macOS webbrowser passes the URL to osascript on stdin, not argv.
    if browser == "default" and platform.system() in {"Windows", "Darwin"}:
        return bool(webbrowser.open(url))
    executable = executable or find_browser(browser)
    if executable is None:
        return False
    options = {}
    if platform.system() in {"Linux", "Darwin"}:
        options["env"] = launch_platform.backend().browser_environment(os.environ)
    subprocess.Popen([str(executable), "--new-window", url], shell=False,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
    return True


def main():
    if sys.version_info < (3, 11):
        print("Python 3.11 이상이 필요합니다. py -3.11 tools/local_web.py 로 실행하세요.")
        return 2
    if sys.stdout.isatty() and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "status", "stop", "attempt", "probe", "open", "migrate-preferences"])
    parser.add_argument("--legacy", action="store_true", help="이전 build7 서버를 명시적으로 정상 종료할 때만 사용")
    parser.add_argument("--source", type=Path, help="사용자가 확인한 이전 개인 설정 폴더")
    parser.add_argument("--browser", choices=["default", "chrome", "chromium", "edge"], default="default",
                        help="open으로 열 브라우저 선택. Linux/macOS는 고정 설치 위치의 Chrome/Chromium/Edge만 사용")
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--gap-probe", action="store_true", help="누락 구간에 MCHATLOGS를 한 번 확인하는 읽기 실험")
    parser.add_argument("--messaging", action="store_true", help="텍스트 전송과 읽음 상태 기능 활성화")
    parser.add_argument("--photo-transport", choices=["https", "loco", "https-experimental"], default="https",
                        help="사진 전송: 기본 https (JPEG·PNG·WebP를 JPEG로 변환), 선택적 기존 loco; https-experimental은 호환 별칭")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    if args.photo_transport == "https-experimental":
        args.photo_transport = "https"
    if args.action != "open" and args.browser != "default":
        print("--browser는 open 명령에서만 사용할 수 있습니다.")
        return 2
    if RUNTIME is None:
        print("이 OS·CPU는 지원하지 않습니다. Windows x64, Linux x64(glibc) 또는 macOS(Intel·Apple Silicon)가 필요합니다.")
        return 2
    if FOLDER is None:
        print("개인 저장소 경로를 확인할 수 없습니다. Windows LOCALAPPDATA 또는 Linux/macOS HOME·XDG_DATA_HOME을 확인하세요.")
        return 2
    if args.legacy and args.action != "stop":
        print("--legacy는 이전 서버 종료만 지원합니다.")
        return 2
    if args.legacy and platform.system() != "Windows":
        print("--legacy는 이전 Windows build7 서버의 종료에만 사용할 수 있습니다.")
        return 2
    if not 1 <= args.port <= 65535:
        print("잘못된 로컬 포트입니다.")
        return 2
    try:
        current = connect(legacy=True) if args.legacy else connect()
    except FileNotFoundError:
        current = None
    except UntrustedServer as error:
        if not (isinstance(error, StaleRuntime) and args.action == "start"):
            print(str(error) + " 브라우저를 열거나 종료를 보고하지 않았습니다.")
            return 2
        current = None  # The stale record is ignored; the new server overwrites it.
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
            existing_photo_transport = current[2].get("photoTransport", "loco")
            if existing_photo_transport == "https-experimental":
                existing_photo_transport = "https"
            if existing_photo_transport != args.photo_transport:
                print("기존 서버와 사진 전송 모드가 다릅니다. 현재 서버와 세션을 유지했습니다. 모드 변경은 세션 정리·서버 재시작 후 적용하세요.")
                return 2
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
        if not RUNTIME.is_file():
            print("고정 Node 런타임이 없습니다. 먼저 Python 3.11 이상으로 tools/prepare_node_spike.py 를 실행하세요 (네트워크 필요).")
            return 2
        # A missing runtime file is insufficient if another process owns the port.
        try:
            assert_port_available(args.port)
        except UntrustedServer as error:
            print(str(error))
            return 2
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
        broad = broad_write_warnings()
        if broad:
            if platform.system() == "Windows":
                fix = "powershell -NoProfile -File tools\\workspace_acl.ps1 로 점검 후 소유자가 직접 -Apply" if (ROOT / "tools/workspace_acl.ps1").is_file() else "icacls로 Users/Everyone/Authenticated Users/CodexSandboxUsers 쓰기 권한 제거"
            else:
                fix = "소유자가 프로젝트 경로의 그룹·전체 쓰기 권한과 링크를 직접 점검"
            print("경고: 넓은 쓰기 권한이 있는 폴더: " + ", ".join(str(path) for path in broad) + ". 다른 사용자·샌드박스가 서버 코드나 런타임을 바꿀 수 있습니다. " + fix + "를 권장합니다. 시작은 계속합니다.")
        env = launch_platform.server_environment(os.environ, sys.executable)
        command = [str(RUNTIME), str(ROOT / "experiments/local-web/server.mjs"), "--port", str(args.port)]
        if not args.mock:
            command.append("--live")
        if args.gap_probe:
            command.append("--gap-probe")
        if args.messaging:
            command.append("--messaging")
        command.extend(["--photo-transport", args.photo_transport])
        try:
            adapter = launch_platform.backend()
            with adapter.open_log(FOLDER / "server.stdout.log", verify_private_file) as stdout, adapter.open_log(FOLDER / "server.stderr.log", verify_private_file) as stderr:
                process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=stdout, stderr=stderr,
                    **adapter.spawn_options())
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            print("로컬 서버를 시작할 수 없습니다. 런타임 준비 상태와 저장 경로 권한을 확인하세요.")
            return 2
        for _ in range(40):
            if process.poll() is not None:
                print("로컬 서버 시작 실패. 개인 저장소의 서버 로그를 확인하세요.")
                return 2
            try:
                url, _, state = connect(expected_pid=process.pid)
                print(json.dumps(public_status(url, state), ensure_ascii=False, indent=2))
                return 0
            except FileNotFoundError:
                time.sleep(0.2)
            except UntrustedServer as error:
                print(str(error) + " 추가 시작을 중단했습니다.")
                return 2
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
        executable = None
        if args.browser != "default" or platform.system() == "Linux":
            executable = find_browser(args.browser)
            if executable is None:
                print(f"{args.browser} 브라우저를 기본 설치 위치에서 찾지 못했습니다. 다른 --browser 값을 선택하세요.")
                return 2
        req = request.Request(url + "/api/local/launch", data=b"{}", method="POST", headers={"Origin": url, "Content-Type": "application/json"})
        try:
            with client.open(req, timeout=5) as response:
                payload = json.load(response)
            ticket = payload.get("ticket") if isinstance(payload, dict) else None
        except (OSError, ValueError):
            print("로컬 브라우저 입장권을 받지 못했습니다. 서버 실행 상태를 확인한 뒤 다시 열어 주세요.")
            return 2
        if not isinstance(ticket, str) or len(ticket) != 64 or any(char not in "0123456789abcdef" for char in ticket):
            print("로컬 실행 권한을 발급하지 못했습니다.")
            return 2
        try:
            opened = launch_browser(url + "/launch#launch=" + ticket, args.browser, executable)
        except (OSError, webbrowser.Error, subprocess.SubprocessError):
            opened = False
        if not opened:
            print("브라우저 열기에 실패했습니다. open --browser chrome 또는 open --browser edge로 다시 실행하세요.")
            return 2
        selected = "기본 브라우저" if args.browser == "default" else args.browser
        print(f"{selected} 열기를 요청했습니다. 명령으로 새로 열린 외부 브라우저 창·탭을 사용하세요.")
        print("기존 미리보기나 다른 탭의 접근 권한은 자동으로 바뀌지 않습니다.")
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
