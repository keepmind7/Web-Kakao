"""프로젝트 내부에 고정 JDK와 REA용 JADX 엔진을 준비한다. APK·계정은 사용하지 않는다."""
import argparse
import hashlib
import json
from pathlib import Path
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
    destination = checked_path(DEST)
    runtime = checked_path(destination / 'runtime.json')
    # Validate all asset paths before starting the first network operation.
    for name, _, _ in ASSETS:
        checked_path(destination / name)
    records = []
    for name, url, expected in ASSETS:
        target = ensure_download(destination / name, Request(url, headers={'User-Agent': 'Web-Kakao-REA-setup'}),
                                 expected, opener=urlopen)
        records.append({'name': name, 'url': url, 'sha256': expected, 'bytes': target.stat().st_size})
        print(json.dumps({'verified': name, 'bytes': target.stat().st_size}), flush=True)
    home = install_archive(destination / 'jdk.zip', destination, ['bin/java.exe', 'bin/javac.exe'])
    homes = []
    for candidate in destination.iterdir():
        checked_path(candidate)
        if candidate.is_dir() and checked_path(candidate / 'bin/java.exe').is_file() and checked_path(candidate / 'bin/javac.exe').is_file():
            homes.append(candidate)
    if homes != [home]:
        raise ValueError('full_jdk_not_unique')
    result = {'assets': records, 'java_home': str(home), 'jadx_jar': str(destination / ASSETS[1][0]), 'global_settings_changed': False}
    checked_path(runtime).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'prepared': True, 'global_settings_changed': False}), flush=True)


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parse_arguments(parser, argv)
    run_preparation(parser, main)
    return 0


if __name__ == '__main__':
    cli()
