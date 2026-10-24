"""Linux/WSL2에서 계정 없이 플랫폼 시험과 격리 mock 서버 시작·종료를 확인한다."""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).absolute().parent.parent
_TRACEBACK_MARKER = 'Traceback (most recent call last):'
_DIAGNOSTIC_EXCEPTIONS = frozenset({
    'AssertionError', 'AttributeError', 'FileNotFoundError', 'ImportError',
    'IndexError', 'IsADirectoryError', 'KeyError', 'ModuleNotFoundError',
    'NotADirectoryError', 'NotImplementedError', 'OSError', 'OverflowError',
    'PermissionError', 'RuntimeError', 'TimeoutError', 'TypeError',
    'UnicodeDecodeError', 'UnicodeEncodeError', 'ValueError',
})
_DIAGNOSTIC_SOURCES = (
    'tools/local_web.py', 'tools/private_storage.py', 'tools/safe_download.py',
    'tools/runtime_distribution.py', 'tools/platforms/common.py',
    'tools/platforms/linux.py', 'tools/platforms/paths.py',
)
_LAUNCHER_FAILURE_CODES = {
    '로컬 포트 소유자를 확인할 수 없습니다. 같은 OS 사용자와 권한으로 실행하세요.': 'launcher_listener_unverified',
    '서버 실행 경로를 확인할 수 없습니다. start와 open을 같은 OS 사용자·권한으로 실행하세요.': 'launcher_image_unverified',
    '경고: 포트를 점유한 프로세스가 기록된 프로젝트 Node 서버가 아닙니다. 권한 정보를 보내지 않았습니다.': 'launcher_instance_mismatch',
    '경고: 포트를 점유한 프로세스가 기록된 프로젝트 Node 서버가 아닙니다. 다른 프로그램이 서버를 사칭할 수 있어 권한 정보를 보내지 않았습니다.': 'launcher_image_mismatch',
    '경고: 포트의 서버가 실행 권한을 증명하지 못했습니다. 사칭 가능성이 있어 권한 정보를 보내지 않았습니다.': 'launcher_hmac_unverified',
    '개인 저장소 권한을 확인할 수 없어 시작하지 않았습니다.': 'launcher_private_storage_unverified',
    '로컬 서버를 시작할 수 없습니다. 런타임 준비 상태와 저장 경로 권한을 확인하세요.': 'launcher_start_unavailable',
    '로컬 서버 시작 실패. 개인 저장소의 서버 로그를 확인하세요.': 'launcher_start_failed',
    '로컬 서버 준비 시간을 초과했습니다.': 'launcher_start_timeout',
    '새 서버 실행 정보를 확인할 수 없습니다. 추가 시작을 중단했습니다.': 'launcher_runtime_unverified',
    '로컬 실행 정보를 확인할 수 없습니다. 기존 서버와 파일을 유지했습니다.': 'launcher_runtime_unverified',
    '실행 중인 로컬 인증 웹이 없습니다.': 'launcher_not_running',
}
_LAUNCHER_FAILURE_SUFFIXES = ('', ' 추가 시작을 중단했습니다.', ' 브라우저를 열거나 종료를 보고하지 않았습니다.')


class _CheckFailure(RuntimeError):
    """Only verifier-created, sanitized messages may reach the terminal."""


def safe_python_diagnostic(stderr, root):
    """Return only allowlisted exception and known source location, never child text."""
    if not isinstance(stderr, str) or len(stderr) > 65536 or _TRACEBACK_MARKER not in stderr:
        return ''
    lines = stderr.rsplit(_TRACEBACK_MARKER, 1)[1].strip('\r\n').splitlines()
    if not lines:
        return ''
    exception = re.fullmatch(r'([A-Za-z][A-Za-z0-9]*)(?::.*)?', lines[-1])
    if not exception or exception[1] not in _DIAGNOSTIC_EXCEPTIONS:
        return ''
    sources = {str(root / name): name for name in _DIAGNOSTIC_SOURCES}
    location = None
    for line in lines[:-1]:
        frame = re.fullmatch(r'\s+File "([^"]+)", line ([1-9][0-9]{0,5})(?:, in .*)?', line)
        if frame and frame[1] in sources:
            location = sources[frame[1]] + ':' + frame[2]
    if location is None:
        return ''
    return ' 진단: ' + exception[1] + ' · ' + location


def safe_launcher_diagnostic(stdout):
    """Map exact, fixed launcher denials to fixed codes; never echo child output."""
    if not isinstance(stdout, str) or len(stdout) > 65536:
        return ''
    known = {message + suffix: code for message, code in _LAUNCHER_FAILURE_CODES.items()
             for suffix in _LAUNCHER_FAILURE_SUFFIXES}
    for line in stdout.splitlines():
        code = known.get(line)
        if code is not None:
            return ' 진단 코드: ' + code
    return ''


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=('mock', 'platform', 'full'), default='platform',
                        help='mock=시작/상태/종료, platform=신규 플랫폼 시험 포함, full=기존 전체 Python/Node 시험도 포함')
    parser.add_argument('--browser', action='store_true', help='격리 headless Chrome/Chromium 화면 검사도 실행')
    args = parser.parse_args(argv)
    if sys.version_info < (3, 11):
        parser.error('Python 3.11 이상이 필요합니다.')
    if sys.platform != 'linux':
        parser.error('이 검사는 Linux 또는 WSL2 안에서 실행하세요.')
    return args


def linux_checkout(root):
    """Windows 마운트의 권한 의미를 Linux 검증 성공으로 오인하지 않는다."""
    resolved = root.resolve()
    parts = resolved.parts
    return not (len(parts) > 2 and parts[1] == 'mnt' and len(parts[2]) == 1 and parts[2].isalpha())


def isolated_environment(folder, source=None):
    source = os.environ if source is None else source
    allowed = {'PATH', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
               'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP'}
    env = {key: value for key, value in source.items() if key in allowed}
    env.update({'HOME': str(folder / 'home'), 'XDG_DATA_HOME': str(folder / 'data'),
                'XDG_CONFIG_HOME': str(folder / 'config'), 'XDG_STATE_HOME': str(folder / 'state'),
                'XDG_CACHE_HOME': str(folder / 'cache'), 'TMPDIR': str(folder / 'tmp'),
                'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1',
                'WEB_KAKAO_QA_OUTPUT_ROOT': str(folder / 'browser')})
    for name in ('home', 'data', 'config', 'state', 'cache', 'tmp', 'browser'):
        (folder / name).mkdir(mode=0o700)
    return env


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def run_checks(args, *, root=ROOT):
    # Import after parse/OS gates so help never reads runtime/private state.
    try:
        from tools.runtime_distribution import runtime_path
        from tools.safe_download import checked_path
    except ModuleNotFoundError:
        from runtime_distribution import runtime_path
        from safe_download import checked_path
    if not linux_checkout(root):
        raise _CheckFailure('Linux 홈 디렉터리에 별도 clone을 준비하세요. /mnt/c 등의 Windows 마운트는 검증 대상이 아닙니다.')
    runtime = runtime_path(root)
    if not runtime.is_file():
        raise _CheckFailure('Linux용 고정 Node가 없습니다. 먼저 python3 tools/prepare_node_spike.py로 준비하세요.')
    output = checked_path(root / 'local-only' / 'qa-linux')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    port = free_port()
    # Keep the owned run directory as evidence, including if shutdown fails.
    # Deleting runtime.json while its process is alive would prevent safe recovery.
    temp = tempfile.mkdtemp(prefix='isolated-', dir=output)
    if temp:
        folder = Path(temp)
        env = isolated_environment(folder)
        results = []

        def execute(label, command, timeout=300, capture=False, environment=None):
            try:
                result = subprocess.run(command, cwd=root, env=env if environment is None else environment,
                                        text=True, encoding='utf-8',
                                        capture_output=capture, timeout=timeout, check=False)
            except subprocess.TimeoutExpired:
                results.append({'check': label, 'exitCode': None, 'failure': 'timeout'})
                raise _CheckFailure(label + ' 검사 제한 시간을 초과했습니다.') from None
            except OSError:
                results.append({'check': label, 'exitCode': None, 'failure': 'launch'})
                raise _CheckFailure(label + ' 검사 명령을 실행하지 못했습니다.') from None
            results.append({'check': label, 'exitCode': result.returncode})
            if result.returncode:
                diagnostic = (safe_python_diagnostic(result.stderr, root) +
                              safe_launcher_diagnostic(result.stdout)) if capture else ''
                raise _CheckFailure(label + ' 검사 실패. 종료 코드 ' + str(result.returncode) + diagnostic)
            return result

        launcher = [sys.executable, '-B', '-X', 'utf8', str(root / 'tools/local_web.py')]
        needs_stop = False
        try:
            # The temporary data root and random loopback port cannot reuse the live session.
            needs_stop = True
            execute('mock-start', [*launcher, 'start', '--mock', '--port', str(port)], timeout=40, capture=True)
            status = execute('mock-status', [*launcher, 'status'], timeout=20, capture=True)
            state = json.loads(status.stdout)
            if state.get('mode') != 'mock' or state.get('credentialInMemory') is not False or state.get('chatConnectionActive') is not False:
                raise _CheckFailure('격리 mock 상태를 확인하지 못했습니다.')
            if args.suite != 'mock':
                patterns = ['test_platform_*.py', 'test_source_package.py', 'test_linux_verifier.py']
                if args.suite == 'full':
                    patterns = ['test_*.py']
                for pattern in patterns:
                    execute('python:' + pattern, [sys.executable, '-B', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tests', '-p', pattern, '-v'])
                tests = sorted((root / 'tests').glob('*.test.mjs')) if args.suite == 'full' else [root / 'tests/platform-storage.test.mjs', root / 'tests/platform-worker-env.test.mjs', root / 'tests/own-read-diagnostics-worker.test.mjs', root / 'tests/own-read-diagnostics-manager.test.mjs', root / 'tests/own-read-diagnostics-boundaries.test.mjs']
                execute('node:' + args.suite, [str(runtime), '--test', '--test-concurrency=1', *map(str, tests)])
            if args.browser:
                browser_env = env.copy()
                try:
                    # Chrome places SingletonSocket below TMPDIR; a long project
                    # root exceeds Linux AF_UNIX path limits even for a fresh profile.
                    # stdlib mkdtemp creates a private 0700 directory. Preserve it
                    # like the other QA evidence; never remove a possibly-live socket.
                    browser_env['TMPDIR'] = tempfile.mkdtemp(prefix='wk-', dir='/tmp')
                except OSError:
                    raise _CheckFailure('격리 브라우저 임시 디렉터리를 준비하지 못했습니다.') from None
                execute('isolated-browser', [str(runtime), str(root / 'tests/reader-browser-smoke.mjs')],
                        environment=browser_env)
            execute('mock-stop', [*launcher, 'stop'], timeout=20, capture=True)
            needs_stop = False
            print(json.dumps({'actualAccountUsed': False, 'platform': 'linux', 'suite': args.suite,
                              'checks': results, 'browserExecuted': args.browser, 'mockStopped': True}, indent=2))
            return 0
        finally:
            if needs_stop:
                # Only the isolated root's authenticated launcher may stop this mock instance.
                # Failure is explicit; never kill every node or touch a different installation.
                warning = '격리 mock 종료를 확인하지 못했습니다. 다른 서버를 종료하지 말고 qa-linux 실행 상태를 확인하세요.'
                try:
                    stopped = subprocess.run([*launcher, 'stop'], cwd=root, env=env,
                                             text=True, encoding='utf-8', capture_output=True,
                                             timeout=20, check=False)
                except subprocess.TimeoutExpired:
                    print(warning + ' 종료 확인 제한 시간을 초과했습니다.', file=sys.stderr)
                except OSError:
                    print(warning + ' 종료 확인 명령을 실행하지 못했습니다.', file=sys.stderr)
                else:
                    if stopped.returncode:
                        print(warning + safe_python_diagnostic(stopped.stderr, root) +
                              safe_launcher_diagnostic(stopped.stdout), file=sys.stderr)


def main(argv=None):
    args = parse_args(argv)
    old_mask = os.umask(0o077)
    try:
        return run_checks(args)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Fixed local errors only. Never print child stdout, tokens or launch URLs.
        message = str(error) if isinstance(error, _CheckFailure) else '격리 Linux 검사를 완료하지 못했습니다.'
        print(message, file=sys.stderr)
        return 1
    finally:
        os.umask(old_mask)


if __name__ == '__main__':
    raise SystemExit(main())
