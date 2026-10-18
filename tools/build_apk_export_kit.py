"""다른 Windows PC용 APK 추출 키트를 만든다. 사용자 데이터·APK는 포함하지 않는다."""
import hashlib
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED
if sys.version_info < (3, 11):
    raise SystemExit("Python 3.11 이상이 필요합니다 (hashlib.file_digest). py -3.11 로 실행하세요.")

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tools/apk_export'
ARCHIVE = ROOT / 'local-only/android-tools/platform-tools-37.0.1-windows.zip'
EXPECTED = '45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99'


def main():
    with ARCHIVE.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != EXPECTED:
            raise ValueError('official_adb_archive_mismatch')
    destination = ROOT / 'local-only/apk-export-kit.zip'
    # Explicit allowlist: never package project folders, .env or generated data.
    with ZipFile(destination, 'w', compression=ZIP_DEFLATED) as output:
        for name in ['Export-KakaoApk.ps1', 'run.cmd', 'README.ko.md']:
            output.write(SOURCE / name, 'apk-export-kit/' + name)
        output.write(ARCHIVE, 'apk-export-kit/' + ARCHIVE.name)
    print(destination.relative_to(ROOT).as_posix())


if __name__ == '__main__':
    main()
