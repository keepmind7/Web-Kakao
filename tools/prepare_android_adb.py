"""Google 공식 ADB를 프로젝트 내부에 준비한다. 기기에 연결하거나 앱을 실행하지 않는다."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.request import Request, urlopen
try:
    from tools.cli_support import parse_arguments, run_preparation
    from tools.prepare_rea_windows import install_archive
    from tools.safe_download import checked_path, ensure_download
except ModuleNotFoundError:
    from cli_support import parse_arguments, run_preparation
    from prepare_rea_windows import install_archive
    from safe_download import checked_path, ensure_download

ROOT = Path(__file__).absolute().parent.parent
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
    folder = checked_path(FOLDER)
    runtime = checked_path(folder / 'runtime.json')
    adb = checked_path(folder / 'platform-tools/adb.exe')
    archive_path = ensure_download(folder / ('platform-tools-' + VERSION + '-windows.zip'),
                                   Request(URL, headers={'User-Agent': 'Web-Kakao-APK-analysis'}),
                                   SHA1, opener=urlopen, algorithm='sha1', expected_size=SIZE, timeout=30)
    home = install_archive(archive_path, folder, ['adb.exe'])
    if home != adb.parent:
        raise ValueError('unexpected_adb_install_directory')
    checked_path(adb)
    # `version` does not start an ADB server, connect, enumerate or modify devices.
    result = subprocess.run([str(adb), 'version'], capture_output=True, text=True, check=True, timeout=10,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if VERSION not in result.stdout:
        raise ValueError('adb_version_mismatch')
    record = {'version': VERSION, 'source': URL, 'official_metadata': 'https://dl.google.com/android/repository/repository2-3.xml',
              'official_sha1': SHA1, 'archive_sha256': hash_file(archive_path, 'sha256'), 'adb_sha256': hash_file(adb, 'sha256'),
              'adb_path': str(adb), 'device_connected_by_this_tool': False, 'global_settings_changed': False}
    checked_path(runtime).write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: record[k] for k in ['version', 'archive_sha256', 'adb_sha256', 'device_connected_by_this_tool', 'global_settings_changed']}))


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parse_arguments(parser, argv)
    run_preparation(parser, main)
    return 0


if __name__ == '__main__':
    cli()
