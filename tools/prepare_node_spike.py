"""고정된 공식 Node 24 Windows/Linux 배포를 프로젝트 내부에 준비한다."""
import argparse
import ctypes
import errno
import json
import hashlib
import os
import posixpath
import shutil
import stat
import tarfile
import zipfile
from pathlib import Path
from urllib.request import urlopen
try:
    from tools.cli_support import parse_arguments, run_preparation
    from tools.prepare_rea_windows import install_archive
    from tools.safe_download import checked_path, ensure_download
    from tools.safe_download import download_stage
    from tools.runtime_distribution import BASE_URL, runtime_spec
except ModuleNotFoundError:
    from cli_support import parse_arguments, run_preparation
    from prepare_rea_windows import install_archive
    from safe_download import checked_path, ensure_download
    from safe_download import download_stage
    from runtime_distribution import BASE_URL, runtime_spec

ROOT = Path(__file__).absolute().parent.parent
BASE = "https://nodejs.org/dist/v24.21.0/"
FILENAME = "node-v24.21.0-win-x64.zip"
# Pinned from the official SHASUMS256.txt-verified download recorded in evidence/alternatives/node-runtime.json.
EXPECTED = "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"


def _tar_entries(archive, destination, top, required):
    """Resolve safe internal file links without creating filesystem links."""
    entries, seen = {}, set()
    for member in archive:
        if len(entries) >= 100000:
            raise ValueError('tar_entry_limit')
        name = member.name
        parts = name.rstrip('/').split('/')
        if (not name or name.startswith('/') or '\\' in name or ':' in name
                or any(not part or part in {'.', '..'} for part in parts)
                or parts[0] != top or member.size < 0 or member.size > 512 * 1024 * 1024):
            raise ValueError('unsafe_tar_path_or_size')
        key = '/'.join(parts)
        # Case-insensitive collisions are rejected even when preparing on Linux.
        if key.casefold() in seen:
            raise ValueError('duplicate_tar_path')
        seen.add(key.casefold())
        checked_path(destination.joinpath(*parts))
        if not (member.isdir() or member.isfile() or member.issym()):
            raise ValueError('tar_hardlink_or_special_file_not_allowed')
        if member.mode & 0o7000:
            raise ValueError('tar_privileged_mode_not_allowed')
        entries[key] = member
    if not entries or len(entries) > 100000:
        raise ValueError('tar_entry_limit_or_empty')
    for name in entries:
        parts = name.split('/')
        if any(prefix in entries and not entries[prefix].isdir()
               for prefix in ('/'.join(parts[:index]) for index in range(1, len(parts)))):
            raise ValueError('tar_file_directory_collision')

    def regular(name, chain=()):
        if name in chain or len(chain) > 64 or name not in entries:
            raise ValueError('tar_link_cycle_or_missing_target')
        member = entries[name]
        if member.isfile():
            return member
        if not member.issym():
            raise ValueError('tar_link_must_resolve_to_regular_file')
        link = member.linkname
        # Relative ../ links are normal in Node's bin/npm. They are accepted
        # only after lexical resolution stays under the single install root.
        if (not link or link.startswith('/') or '\\' in link or ':' in link
                or any(not part or part == '.' for part in link.split('/'))):
            raise ValueError('unsafe_tar_link')
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
        if not resolved.startswith(top + '/'):
            raise ValueError('tar_link_escape')
        return regular(resolved, (*chain, name))

    result = []
    for name, member in entries.items():
        if member.isdir():
            result.append((name, None, 0o755))
        else:
            source = regular(name)
            mode = 0o755 if source.mode & 0o111 else 0o644
            result.append((name, source, mode))
    expected = {name for name, source, _ in result if source is not None}
    if any(top + '/' + item not in expected for item in required):
        raise ValueError('required_runtime_file_missing')
    if required and next(mode for name, source, mode in result if name == top + '/' + required[0]) != 0o755:
        raise ValueError('runtime_executable_mode_missing')
    if sum(source.size for _, source, _ in result if source is not None) > 1024 * 1024 * 1024:
        raise ValueError('tar_total_size_limit')
    return result


def _posix_mode_matches(path, mode):
    return os.name == 'nt' or stat.S_IMODE(path.stat().st_mode) == mode


def install_tar_archive(path, destination, top, required):
    """Manually extract vetted regular files, preserving executable semantics."""
    destination = checked_path(destination)
    home = checked_path(destination / top)
    with tarfile.open(path, mode='r:xz') as archive:
        entries = _tar_entries(archive, destination, top, required)
        expected_files = {name for name, source, _ in entries if source is not None}
        expected_dirs = {top}
        for name, source, _ in entries:
            parts = name.split('/')
            expected_dirs.update('/'.join(parts[:index]) for index in range(1, len(parts)))
            if source is None:
                expected_dirs.add(name)
        if home.exists():
            if not home.is_dir():
                raise ValueError('existing_runtime_not_directory')
            for name in expected_dirs:
                directory = checked_path(destination / name)
                if not directory.is_dir() or not _posix_mode_matches(directory, 0o755):
                    raise ValueError('existing_runtime_directory_mismatch')
            for name, source, mode in entries:
                target = checked_path(destination / name)
                if source is None:
                    if not target.is_dir():
                        raise ValueError('existing_runtime_mismatch')
                    continue
                if not target.is_file() or target.stat().st_nlink != 1:
                    raise ValueError('existing_runtime_mismatch')
                with archive.extractfile(source) as trusted, target.open('rb') as current:
                    if hashlib.file_digest(trusted, 'sha256').digest() != hashlib.file_digest(current, 'sha256').digest():
                        raise ValueError('existing_runtime_mismatch')
                if not _posix_mode_matches(target, mode):
                    raise ValueError('existing_runtime_mode_mismatch')
            for candidate in home.rglob('*'):
                candidate = checked_path(candidate)
                info = candidate.lstat()
                relative = candidate.relative_to(destination).as_posix()
                if (stat.S_ISDIR(info.st_mode) and relative in expected_dirs
                        or stat.S_ISREG(info.st_mode) and relative in expected_files):
                    continue
                raise ValueError('existing_runtime_has_extra_entries')
            return home
        destination.mkdir(parents=True, exist_ok=True)
        with download_stage(destination) as stage:
            for name, source, mode in entries:
                target = checked_path(stage / name)
                if source is None:
                    target.mkdir(parents=True, exist_ok=True, mode=0o755)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with archive.extractfile(source) as trusted, target.open('xb') as output:
                    shutil.copyfileobj(trusted, output, 1024 * 1024)
                target.chmod(mode)
            for name in sorted(expected_dirs, key=lambda value: value.count('/'), reverse=True):
                checked_path(stage / name).chmod(0o755)
            checked_path(home)
            if home.exists():
                raise ValueError('runtime_destination_collision')
            _publish_directory(stage / top, home)
    return home


def _publish_directory(source, destination):
    """Atomic no-replace publication; plain POSIX rename could replace a dir."""
    if os.name == 'nt':
        source.rename(destination)  # Windows rename rejects an existing target.
        return
    try:
        rename = ctypes.CDLL(None, use_errno=True).renameat2
    except AttributeError:
        raise ValueError('atomic_noreplace_publication_unavailable') from None
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError('runtime_destination_collision')
        raise OSError(code, 'atomic_noreplace_publication_failed')


def main(target_root=ROOT / "local-only/runtime", *, system=None, machine=None):
    try:
        spec = runtime_spec(system, machine)
        # Keep the Windows constants patchable for the existing offline tests.
        if spec['archive'].endswith('.zip'):
            spec.update(archive=FILENAME, sha256=EXPECTED,
                        directory=FILENAME.removesuffix('.zip'))
        target_root = checked_path(target_root)
        folder = checked_path(target_root / spec['directory'])
        archive = ensure_download(target_root / spec['archive'], BASE_URL + spec['archive'], spec['sha256'], opener=urlopen)
        if spec['archive'].endswith('.zip'):
            with zipfile.ZipFile(archive) as source:
                if any(member.filename.split('/')[0] != folder.name for member in source.infolist()):
                    raise ValueError('unexpected_node_install_directory')
            install_archive(archive, target_root, [spec['executable'], spec['npm_cli']])
        else:
            install_tar_archive(archive, target_root, spec['directory'], [spec['executable'], spec['npm_cli']])
    except (ValueError, tarfile.TarError):
        raise SystemExit("고정 배포 또는 런타임 파일 검증에 실패하여 실행 준비를 중단합니다.") from None
    return {"source": BASE_URL + spec['archive'], "sha256": spec['sha256'],
            "directory": folder.relative_to(ROOT).as_posix() if folder.is_relative_to(ROOT) else str(folder),
            'executable': spec['executable'], 'npm_cli': spec['npm_cli'],
            "global_install": False, "account_used": False}


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parse_arguments(parser, argv, supported_platforms=('win32', 'linux'))
    return run_preparation(parser, prepare_cli)


def prepare_cli():
    record = main()
    evidence = ROOT / "evidence/alternatives"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "node-runtime.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    cli()
