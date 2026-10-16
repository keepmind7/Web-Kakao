"""Google 공식 ADB를 프로젝트 내부에 준비한다. 기기에 연결하거나 앱을 실행하지 않는다."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
from urllib.request import Request, urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'local-only/android-tools'
VERSION = '37.0.1'
URL = 'https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip'
# Google repository2-3.xml: platform-tools / windows / complete.
SHA1 = 'e03e78b1d80b396f1c3358e31251cb31740e1110'
SIZE = 8044989


def hash_file(path, algorithm):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def main():
    FOLDER.mkdir(parents=True, exist_ok=True)
    archive_path = FOLDER / ('platform-tools-' + VERSION + '-windows.zip')
    if not archive_path.exists():
        temporary = archive_path.with_suffix('.partial')
        with urlopen(Request(URL, headers={'User-Agent': 'Web-Kakao-APK-analysis'}), timeout=30) as response, temporary.open('wb') as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > SIZE:
                    raise ValueError('archive_size_limit')
                output.write(chunk)
        if total != SIZE or hash_file(temporary, 'sha1') != SHA1:
            raise ValueError('official_archive_checksum_mismatch')
        temporary.replace(archive_path)
    if archive_path.stat().st_size != SIZE or hash_file(archive_path, 'sha1') != SHA1:
        raise ValueError('existing_archive_checksum_mismatch')
    with ZipFile(archive_path) as archive:
        for member in archive.infolist():
            relative = PurePosixPath(member.filename)
            target = (FOLDER / member.filename).resolve()
            if relative.is_absolute() or '..' in relative.parts or '\\' in member.filename or not target.is_relative_to(FOLDER.resolve()):
                raise ValueError('unsafe_archive_path')
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('archive_symlink_not_allowed')
        archive.extractall(FOLDER)
    adb = FOLDER / 'platform-tools/adb.exe'
    # `version` does not start an ADB server, connect, enumerate or modify devices.
    result = subprocess.run([str(adb), 'version'], capture_output=True, text=True, check=True, timeout=10,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if VERSION not in result.stdout:
        raise ValueError('adb_version_mismatch')
    record = {'version': VERSION, 'source': URL, 'official_metadata': 'https://dl.google.com/android/repository/repository2-3.xml',
              'official_sha1': SHA1, 'archive_sha256': hash_file(archive_path, 'sha256'), 'adb_sha256': hash_file(adb, 'sha256'),
              'adb_path': str(adb), 'device_connected_by_this_tool': False, 'global_settings_changed': False}
    (FOLDER / 'runtime.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: record[k] for k in ['version', 'archive_sha256', 'adb_sha256', 'device_connected_by_this_tool', 'global_settings_changed']}))


if __name__ == '__main__':
    main()
