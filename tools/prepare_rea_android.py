"""프로젝트 내부에 고정 JDK와 REA용 JADX 엔진을 준비한다. APK·계정은 사용하지 않는다."""
import hashlib
import json
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'local-only/rea-android'
ASSETS = [
    ('jdk.zip', 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
     'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e'),
    ('jadx-headless-mcp-0.7.1-all.jar', 'https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar',
     '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75'),
]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    records = []
    for name, url, expected in ASSETS:
        target = DEST / name
        if not target.exists():
            temporary = target.with_suffix(target.suffix + '.partial')
            with urlopen(Request(url, headers={'User-Agent': 'Web-Kakao-REA-setup'}), timeout=60) as response, temporary.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if digest(temporary) != expected:
                raise ValueError('asset_sha256_mismatch')
            temporary.replace(target)
        if digest(target) != expected:
            raise ValueError('existing_asset_sha256_mismatch')
        records.append({'name': name, 'url': url, 'sha256': expected, 'bytes': target.stat().st_size})
        print(json.dumps({'verified': name, 'bytes': target.stat().st_size}), flush=True)
    with ZipFile(DEST / 'jdk.zip') as archive:
        members = archive.infolist()
        for member in members:
            relative = PurePosixPath(member.filename)
            target = (DEST / member.filename).resolve()
            if relative.is_absolute() or '..' in relative.parts or '\\' in member.filename or not target.is_relative_to(DEST.resolve()):
                raise ValueError('unsafe_archive_path')
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('archive_symlink_not_allowed')
        # All resolved destinations have been checked before extraction.
        archive.extractall(DEST)
    homes = [p for p in DEST.iterdir() if p.is_dir() and (p / 'bin/java.exe').is_file() and (p / 'bin/javac.exe').is_file()]
    if len(homes) != 1:
        raise ValueError('full_jdk_not_unique')
    result = {'assets': records, 'java_home': str(homes[0]), 'jadx_jar': str(DEST / ASSETS[1][0]), 'global_settings_changed': False}
    (DEST / 'runtime.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'prepared': True, 'global_settings_changed': False}), flush=True)


if __name__ == '__main__':
    main()
