"""Prepare pinned, project-local Windows REA engines without running them."""
import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path, PureWindowsPath
import platform
import shutil
import stat
from urllib.request import Request, urlopen
import uuid
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
VERSIONS = {'rea': '6.5.0', 'ghidra': '12.1.4', 'jdk': '21.0.12.1+1'}
ASSETS = [
    {'name': 'ghidra.zip',
     'url': 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip',
     'sha256': 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db'},
    {'name': 'jdk.zip',
     'url': 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
     'sha256': 'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e'},
]
GHIDRA_FILES = ['support/analyzeHeadless.bat',
                'Ghidra/Features/Decompiler/os/win_x86_64/decompile.exe']
JDK_FILES = ['bin/java.exe', 'bin/javac.exe']


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def reserved_windows_component(name):
    """Windows reserved-name policy without Python 3.13's ntpath.isreserved."""
    if name.endswith((' ', '.')) or any(ord(char) < 32 or char in '*?:"<>|/\\'
                                       for char in name):
        return True
    stem = name.partition('.')[0].rstrip(' ').upper()
    return (stem in {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'}
            or (len(stem) == 4 and stem[:3] in {'COM', 'LPT'}
                and stem[3] in '123456789\u00b9\u00b2\u00b3'))


def checked_path(path, boundary):
    """Check lexical components with lstat BEFORE following any filesystem link."""
    path, boundary = Path(path), Path(boundary)
    if '..' in path.parts or '..' in boundary.parts:
        raise ValueError('path_traversal_not_allowed')
    if not path.is_absolute():
        path = boundary / path
    if not path.is_relative_to(boundary):
        raise ValueError('path_outside_boundary')
    if any(reserved_windows_component(part) for part in path.relative_to(boundary).parts):
        raise ValueError('reserved_windows_path')
    # Include the boundary itself; an existing junction must never be followed.
    current = boundary
    for part in (None, *path.relative_to(boundary).parts):
        if part is not None:
            current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('reparse_or_symlink_not_allowed')
    if not path.resolve().is_relative_to(boundary.resolve()):
        raise ValueError('resolved_path_escape')
    return path


@contextmanager
def publication_stage(destination, prefix):
    """Stage public pinned assets with the destination's inherited Windows DACL."""
    destination = Path(destination)
    checked_path(destination, destination)
    for _ in range(10):
        stage = checked_path(destination / (prefix + uuid.uuid4().hex), destination)
        try:
            # Python 3.13 treats 0700 specially on Windows. Ordinary creation
            # preserves inheritance when verified public bytes are renamed out.
            stage.mkdir(mode=0o777)
        except FileExistsError:
            continue
        break
    else:
        raise FileExistsError('publication_stage_collision_limit')
    try:
        checked_path(stage, destination)
        yield stage
    finally:
        # Delete only the exclusively created stage, never a collision or an
        # escaped/replaced junction. Cleanup failures remain visible.
        checked_path(stage, destination)
        if stage == destination:
            raise ValueError('unsafe_publication_cleanup')
        shutil.rmtree(stage)


def _zip_entries(archive, destination):
    entries, seen = [], set()
    for member in archive.infolist():
        # Python normalizes Windows separators and truncates NUL in filename.
        # Validate the archive's original name before trusting that normalized form.
        name = member.orig_filename
        if name != member.filename:
            raise ValueError('normalized_archive_path_not_allowed')
        win = PureWindowsPath(name)
        parts = name.rstrip('/').split('/')
        if (not name or '\\' in name or name.startswith('/') or win.drive
                or any(not part or part in {'.', '..'} or ':' in part
                       or reserved_windows_component(part)
                       for part in parts)):
            raise ValueError('unsafe_archive_path')
        kind = stat.S_IFMT(member.external_attr >> 16)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError('archive_link_or_special_file_not_allowed')
        key = '/'.join(parts).casefold()
        if key in seen:
            raise ValueError('duplicate_archive_path')
        seen.add(key)
        target = checked_path(destination.joinpath(*parts), destination)
        entries.append((member, target))
    files = {member.filename.casefold() for member, _ in entries if not member.is_dir()}
    for member, _ in entries:
        parts = member.filename.rstrip('/').split('/')
        if any('/'.join(parts[:index]).casefold() in files for index in range(1, len(parts))):
            raise ValueError('archive_file_directory_collision')
    if not entries or len({entry[0].filename.split('/')[0] for entry in entries}) != 1:
        raise ValueError('archive_requires_one_install_directory')
    top = entries[0][0].filename.split('/')[0]
    if not any(member.filename.startswith(top + '/') and not member.is_dir()
               for member, _ in entries):
        raise ValueError('archive_requires_install_files')
    return top, entries


def install_archive(path, destination, required):
    """Validate the complete ZIP, stage new installs, or verify existing bytes."""
    destination = Path(destination)
    checked_path(destination, destination)
    with ZipFile(path) as archive:
        top, entries = _zip_entries(archive, destination)
        home = destination / top
        expected_files = {member.filename for member, _ in entries if not member.is_dir()}
        if any(top + '/' + item not in expected_files for item in required):
            raise ValueError('required_engine_file_missing')
        if home.exists():
            if not home.is_dir():
                raise ValueError('existing_install_is_not_directory')
            for member, target in entries:
                if member.is_dir():
                    if not target.is_dir():
                        raise ValueError('existing_install_mismatch')
                else:
                    if not target.is_file():
                        raise ValueError('existing_install_mismatch')
                    with archive.open(member) as source:
                        expected = hashlib.file_digest(source, 'sha256').hexdigest()
                    if digest(target) != expected:
                        raise ValueError('existing_install_mismatch')
            # Unexpected files could change engine behavior. Do not remove them.
            for candidate in home.rglob('*'):
                checked_path(candidate, destination)
                if candidate.is_file() and candidate.relative_to(destination).as_posix() not in expected_files:
                    raise ValueError('existing_install_has_extra_files')
            return home
        destination.mkdir(parents=True, exist_ok=True)
        with publication_stage(destination, 'rea-install-') as stage:
            # No writes occurred until every member and required file was checked.
            archive.extractall(stage)
            staged_home = stage / top
            if any(not (staged_home / item).is_file() for item in required):
                raise ValueError('required_engine_file_missing')
            if home.exists():
                raise ValueError('install_destination_collision')
            staged_home.rename(home)
        return home


def ensure_archive(destination, asset, offline=False):
    destination = Path(destination)
    archive = checked_path(destination / asset['name'], destination)
    if archive.exists():
        if not archive.is_file() or digest(archive) != asset['sha256']:
            raise ValueError('existing_asset_sha256_mismatch')
        return archive
    if offline:
        raise FileNotFoundError('offline_asset_missing')
    destination.mkdir(parents=True, exist_ok=True)
    with publication_stage(destination, 'rea-download-') as stage:
        partial = stage / 'asset.partial'
        request = Request(asset['url'], headers={'User-Agent': 'Web-Kakao-REA-setup'})
        with urlopen(request, timeout=60) as response, partial.open('xb') as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        if digest(partial) != asset['sha256']:
            raise ValueError('download_asset_sha256_mismatch')
        if archive.exists():
            raise ValueError('asset_destination_collision')
        partial.rename(archive)
    return archive


def prepare(root=ROOT, offline=False):
    if platform.system() != 'Windows' or platform.machine().lower() not in {'amd64', 'x86_64'}:
        raise ValueError('windows_x64_required')
    root = Path(root)
    destination = checked_path(root / 'local-only/rea-windows', root)
    package = checked_path(root / 'local-only/rea/node_modules/rea-agents', root)
    cli = checked_path(package / 'scripts/rea.mjs', root)
    metadata = checked_path(package / 'package.json', root)
    if not cli.is_file() or not metadata.is_file():
        raise ValueError('local_rea_installation_missing')
    if json.loads(metadata.read_text(encoding='utf-8'))['version'] != VERSIONS['rea']:
        raise ValueError('local_rea_version_mismatch')
    node = shutil.which('node')
    if not node or not Path(node).is_file():
        raise ValueError('node_not_found_on_path')
    homes, records = {}, []
    for asset in ASSETS:
        archive = ensure_archive(destination, asset, offline)
        required = GHIDRA_FILES if asset['name'] == 'ghidra.zip' else JDK_FILES
        homes[asset['name']] = install_archive(archive, destination, required)
        records.append({**asset, 'bytes': archive.stat().st_size})
    temp = checked_path(root / 'local-only/rea-temp', root)
    temp.mkdir(parents=True, exist_ok=True)
    result = {'node': str(Path(node).absolute()), 'rea_cli': str(cli),
              'ghidra_install_dir': str(homes['ghidra.zip']),
              'java_home': str(homes['jdk.zip']), 'temp_root': str(temp),
              'versions': VERSIONS.copy(), 'assets': records,
              'global_settings_changed': False}
    runtime = checked_path(destination / 'runtime.json', root)
    if runtime.exists():
        if json.loads(runtime.read_text(encoding='utf-8')) != result:
            raise ValueError('existing_runtime_config_mismatch')
    else:
        with runtime.open('x', encoding='utf-8') as output:
            output.write(json.dumps(result, indent=2) + '\n')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args(argv)
    try:
        prepare(offline=args.offline)
    except (OSError, ValueError, KeyError) as error:
        # Do not echo URLs, local environment or arbitrary exception text.
        parser.error(type(error).__name__ + ': preparation failed; existing state preserved')
    print(json.dumps({'prepared': True, 'global_settings_changed': False}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
