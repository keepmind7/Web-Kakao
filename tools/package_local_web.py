"""공유 가능한 현재 소스만 ZIP으로 묶는다. 독립 실행파일 패키지가 아니다."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import zipfile

try:
    from tools.cli_support import parse_arguments, run_preparation
    from tools.safe_download import checked_path, download_stage
except ModuleNotFoundError:
    from cli_support import parse_arguments, run_preparation
    from safe_download import checked_path, download_stage

ROOT = Path(__file__).absolute().parent.parent
ROOT_FILES = {'.gitattributes', '.gitignore', 'AGENTS.md', 'README.md', 'requirements.txt',
              'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md'}
SOURCE_TREES = {'experiments', 'tests', 'tools', 'ui', 'reports'}
SOURCE_SUFFIXES = {'.py', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.html', '.css', '.json',
                   '.md', '.txt', '.toml', '.yaml', '.yml', '.ps1', '.sh', '.ini', '.xml',
                   '.bat', '.cmd', '.properties', '.gradle', '.kt', '.java', '.gitattributes',
                   '.gitignore'}
PRIVATE_PARTS = {'node_modules', '__pycache__', '.git', '.venv', 'venv', 'local-only',
                 'docs', 'evidence', '_workspace', 'captures', 'dumps', 'raw-data',
                 'preferences', 'web-auth', 'secrets', 'dist', 'build', 'output',
                 'platform-tools', 'test-results', 'playwright-report'}
PRIVATE_NAMES = {'runtime.json', 'identity.key', 'auth.json', 'cookies.txt', '.device-uuid',
                 'apk-manifest.json', 'settings.local.json', 'reader-lifecycle.json'}
# These exact shipped sources are code, unlike private diagnostic artifacts.
PUBLIC_READER_DIAGNOSTICS = frozenset({
    'experiments/local-web/reader-diagnostics.mjs',
    'tests/reader-diagnostics.test.mjs',
})
PACKAGE_NOTE = '''# Web-Kakao 소스 패키지

이 ZIP은 Windows/Linux/macOS 공통 소스 묶음입니다. 설치된 실행 환경이나
독립 실행파일이 아닙니다. Node 런타임, npm 의존성, 인증정보, 개인 설정,
대화·사진·APK·분석 원본·실행 기록을 포함하지 않습니다.

압축을 새 디렉터리에 풀고 README.md의 OS별 준비·실행 절차를 따르세요.
OS·CPU별 준비 조건과 실제 검증 범위는 함께 포함한 README.md를 확인하세요.
source-package-manifest.json은 포함한
공개 소스의 SHA-256 목록이며, 서명이나 출처 인증을 대신하지 않습니다.
'''


def allowed_source_path(name):
    """A narrow source allowlist supplements, never relaxes, Git exclusions."""
    if not isinstance(name, str) or not name or '\\' in name or ':' in name or '\x00' in name:
        return False
    path = PurePosixPath(name)
    parts = path.parts
    if path.is_absolute() or not parts or any(part in {'.', '..', ''} for part in name.split('/')):
        return False
    lower = [part.lower() for part in parts]
    basename = lower[-1]
    if (any(part in PRIVATE_PARTS for part in lower) or basename in PRIVATE_NAMES
            or any(part.startswith('chrome-profile') for part in lower)
            or basename.startswith(('.env', 'credentials'))
            or (basename.startswith('reader-diagnostic') and name not in PUBLIC_READER_DIAGNOSTICS)
            or basename.endswith(('-token.json', '-session.json'))
            or ('token' in basename or 'session' in basename) and basename.endswith('.json')):
        return False
    if len(parts) == 1:
        return name in ROOT_FILES
    if parts[0] == '.harness':
        return name in {'.harness/OPERATING.md', '.harness/FOLLOWUP.md'}
    if parts[0] == '.codex':
        return name == '.codex/config.toml' or (len(parts) == 3 and parts[1] == 'agents' and path.suffix == '.toml')
    if parts[0] == '.agents':
        eligible_tree = len(parts) >= 3 and parts[1] == 'skills'
    else:
        eligible_tree = parts[0] in SOURCE_TREES
    return eligible_tree and (path.suffix in SOURCE_SUFFIXES or path.name in {'LICENSE', 'NOTICE', 'Dockerfile', '.gitignore', '.gitattributes'})


def _git_paths(root):
    result = subprocess.run(['git', '-C', str(root), 'ls-files', '--cached', '--others',
                             '--exclude-standard', '-z'], check=True, capture_output=True)
    names = sorted(set(item.decode('utf-8') for item in result.stdout.split(b'\0') if item))
    if not names:
        raise ValueError('source_worktree_empty')
    # --no-index makes an ignored file in the index remain excluded as well.
    checked = subprocess.run(['git', '-C', str(root), 'check-ignore', '--no-index',
                              '-z', '--stdin'], input=b'\0'.join(name.encode('utf-8') for name in names) + b'\0',
                             capture_output=True)
    if checked.returncode not in (0, 1):
        raise ValueError('git_ignore_check_failed')
    ignored = {item.decode('utf-8') for item in checked.stdout.split(b'\0') if item}
    return [name for name in names if name not in ignored]


def _source_file(root, name):
    """Skip links/reparse points/hardlink aliases without reading their content."""
    candidate = root.joinpath(*PurePosixPath(name).parts)
    try:
        candidate = checked_path(candidate)
        info = candidate.lstat()
    except (FileNotFoundError, ValueError):
        return None
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_size > 16 * 1024 * 1024):
        return None
    return candidate


def package_sources(root=ROOT, output=None, *, target_platform=None):
    target_platform = {'win32': 'windows', 'darwin': 'macos'}.get(sys.platform, 'linux') if target_platform is None else target_platform
    if target_platform not in {'windows', 'linux', 'macos'}:
        raise ValueError('unsupported_source_package_platform')
    root = checked_path(root)
    output = checked_path(root / ('local-only/dist/web-kakao-' + target_platform + '-source.zip') if output is None else output)
    boundary = root / 'local-only/dist'
    if not output.is_relative_to(boundary) or output.parent != boundary or output.suffix.lower() != '.zip':
        raise ValueError('source_package_output_outside_dist')
    if output.exists():
        raise FileExistsError('source_package_already_exists')
    names = [name for name in _git_paths(root) if allowed_source_path(name)]
    inputs = [(name, path) for name in names if (path := _source_file(root, name)) is not None]
    if not all(name in {item[0] for item in inputs} for name in ('README.md', '.gitignore', 'tools/local_web.py')):
        raise ValueError('required_source_package_inputs_missing')
    manifest = {'format': 1, 'kind': 'source-only', 'target_platform': target_platform, 'includes_runtime': False,
                'includes_dependencies': False, 'includes_credentials': False, 'files': []}
    with download_stage(boundary) as stage:
        partial = stage / 'source.zip'
        with zipfile.ZipFile(partial, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, path in inputs:
                # Revalidate immediately before reading; no link target is followed.
                if _source_file(root, name) != path:
                    raise ValueError('source_changed_during_packaging')
                flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
                with os.fdopen(os.open(path, flags), 'rb') as source:
                    info = os.fstat(source.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 16 * 1024 * 1024:
                        raise ValueError('source_changed_during_packaging')
                    content = source.read(16 * 1024 * 1024 + 1)
                if len(content) > 16 * 1024 * 1024:
                    raise ValueError('source_size_limit')
                archive.writestr(name, content)
                manifest['files'].append({'path': name, 'sha256': hashlib.sha256(content).hexdigest()})
            archive.writestr('SOURCE-PACKAGE.ko.md', PACKAGE_NOTE)
            archive.writestr('source-package-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        checked_path(output)
        if output.exists():
            raise FileExistsError('source_package_already_exists')
        # An exclusive hard-link publication cannot overwrite a concurrently
        # created ZIP on POSIX (rename would); unlinking affects our stage only.
        os.link(partial, output, follow_symlinks=False)
    return {'kind': 'source-only', 'target_platform': target_platform, 'file_count': len(manifest['files']),
            'path': output.relative_to(root).as_posix(),
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'includes_runtime': False, 'includes_credentials': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=('windows', 'linux', 'macos'), default=None,
                        help='대상 OS 표시만 기록합니다. 공통 소스이며 런타임은 포함하지 않습니다.')
    parser.add_argument('--output', type=Path, default=None)
    args = parse_arguments(parser, argv, supported_platforms=('win32', 'linux', 'darwin'))
    record = run_preparation(parser, lambda: package_sources(ROOT, args.output, target_platform=args.platform))
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    main()
