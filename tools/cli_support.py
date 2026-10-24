"""Parse-only CLI guards and concise messages for expected preparation failures."""
import errno
import subprocess
import sys
from urllib.error import URLError
from zipfile import BadZipFile


def parse_arguments(parser, argv=None, *, supported_platforms=('win32',)):
    # Python 3.9/3.10 can parse this module and receive useful upgrade guidance.
    if sys.version_info < (3, 11):
        parser.error('Python 3.11 이상이 필요합니다. py -3.11 로 다시 실행하세요.')
    args = parser.parse_args(argv)
    # Help and invalid arguments have already exited without inspecting runtime state.
    if sys.platform not in supported_platforms:
        names = {'win32': 'Windows', 'linux': 'Linux', 'darwin': 'macOS'}
        supported = '·'.join(names.get(name, name) for name in supported_platforms)
        parser.error(f'이 준비 도구는 {supported}에서 실행하세요. 도움말은 --help로 확인할 수 있습니다.')
    return args


def run_preparation(parser, action, *, missing='필수 준비 파일이 없습니다. README의 준비 순서를 확인하세요.',
                    invalid_errors=()):
    """Keep callable APIs unchanged; sanitize only expected failures at the CLI."""
    try:
        return action()
    except URLError:
        message = '다운로드에 연결할 수 없습니다. 네트워크와 프록시 설정을 확인한 뒤 다시 실행하세요.'
    except FileNotFoundError:
        message = missing
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        message = '준비 명령이 실패했거나 제한 시간을 넘었습니다. 설치 상태와 실행 권한을 확인하세요.'
    except OSError as error:
        if getattr(error, 'winerror', None) == 206 or error.errno == errno.ENAMETOOLONG:
            message = 'Windows 경로가 너무 깁니다. 새 작업 복사본을 C:\\wk 같은 짧은 경로에 준비하세요.'
        else:
            message = '파일 또는 다운로드 준비에 실패했습니다. 네트워크, 경로와 파일 접근 권한을 확인하세요.'
    except (ValueError, BadZipFile) + invalid_errors:
        message = '준비 파일의 형식·버전·무결성 또는 안전한 경로 검증에 실패했습니다. 기존 파일을 보존하고 입력을 확인하세요.'
    # Never include arbitrary exception text, URLs, local paths or subprocess output.
    parser.exit(1, '오류: ' + message + '\n')
