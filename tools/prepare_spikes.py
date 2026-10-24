"""다운로드한 공개 소스에서 계정 없는 실험 복사본을 준비한다."""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

try:
    from tools.cli_support import parse_arguments, run_preparation
    from tools.safe_download import checked_path
    from tools.runtime_distribution import runtime_spec
except ModuleNotFoundError:
    from cli_support import parse_arguments, run_preparation
    from safe_download import checked_path
    from runtime_distribution import runtime_spec

ROOT = Path(__file__).absolute().parent.parent
CANDIDATES = [
    ("modern", {"tsx":"^4","bson":"7.3.1","qrcode-terminal":"0.12.0"},
     {"modern-api-spike.ts":"local-api-spike.ts"}),
    ("legacy", {"tsx":"^4","bson":"^4.4.1"},
     {"legacy-codec-spike.ts":"local-codec-spike.ts"}),
]


def preflight():
    """Validate every required lock before any copy, directory or npm side effect."""
    prepared = []
    for candidate, dependencies, experiments in CANDIDATES:
        lock_path = checked_path(ROOT / f"tools/locks/{candidate}-package-lock.json")
        if not lock_path.is_file():
            raise SystemExit(f"{candidate}: 추적되는 잠금 파일(tools/locks/{candidate}-package-lock.json)이 없어 준비를 거부합니다.")
        lock_bytes = lock_path.read_bytes()
        lock = json.loads(lock_bytes)
        name = f'{candidate}-kakao-research-spike'
        package = {'private': True, 'type': 'module', 'name': name, 'dependencies': dependencies}
        packages = lock.get('packages', {})
        if (lock.get('lockfileVersion', 0) < 3 or lock.get('name') != name
                or packages.get('', {}).get('name') != name
                or packages.get('', {}).get('dependencies') != dependencies):
            raise SystemExit(f'{candidate}: 잠금 파일과 필수 package manifest가 일치하지 않습니다.')
        for key, value in packages.items():
            if not key:
                continue
            url = urlsplit(value.get('resolved', ''))
            if (not key.startswith('node_modules/') or '..' in key.split('/') or '\\' in key
                    or url.scheme != 'https' or url.netloc != 'registry.npmjs.org'
                    or not value.get('integrity', '').startswith('sha512-') or value.get('link')):
                raise SystemExit(f'{candidate}: 잠금 파일은 공개 registry의 무결성 고정 항목만 허용합니다.')
        target = checked_path(ROOT / 'local-only/spikes' / candidate)
        existing = checked_path(target / 'package.json')
        if existing.exists() and json.loads(existing.read_text(encoding='utf-8')) != package:
            raise SystemExit(f'{candidate}: 기존 package manifest가 필수 입력과 일치하지 않습니다.')
        prepared.append((candidate, package, experiments, target, lock_bytes))

    # A missing second lock must fail even before reading source/runtime inputs.
    result = []
    for candidate, package, experiments, target, lock_bytes in prepared:
        manifest_path = checked_path(ROOT / f'evidence/alternatives/{candidate}-source.json')
        if not manifest_path.is_file():
            raise SystemExit(f'먼저 py -3.11 tools/fetch_source_spike.py {candidate} 를 실행해 공개 소스를 준비하세요.')
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        source = checked_path(ROOT / manifest['directory'])
        if not source.is_relative_to(ROOT / 'local-only'):
            raise ValueError('잘못된 source 경계')
        if not checked_path(source / 'src').is_dir():
            raise SystemExit(f'공개 소스가 없습니다. 먼저 py -3.11 tools/fetch_source_spike.py {candidate} 를 실행하세요.')
        for original in experiments:
            if not checked_path(ROOT / 'experiments' / original).is_file():
                raise ValueError('experiment_input_missing')
        result.append((candidate, package, experiments, source, target, lock_bytes))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-dependencies', action='store_true')
    args = parse_arguments(parser, argv, supported_platforms=('win32', 'linux', 'darwin'))
    run_preparation(parser, lambda: prepare_all(args.install_dependencies),
                    missing='필수 준비 파일이 없습니다. py -3.11 tools/fetch_source_spike.py 또는 py -3.11 tools/prepare_node_spike.py로 먼저 준비하세요.',
                    invalid_errors=(KeyError,))
    return 0


def prepare_all(install_dependencies=False):
    prepared = preflight()
    node_root = None
    if install_dependencies:
        runtime_path = checked_path(ROOT / 'evidence/alternatives/node-runtime.json')
        if not runtime_path.is_file():
            raise SystemExit('먼저 py -3.11 tools/prepare_node_spike.py 를 실행해 Node 런타임을 준비하세요.')
        runtime = json.loads(runtime_path.read_text(encoding='utf-8'))
        node_root = checked_path(ROOT / runtime['directory'])
        if not node_root.is_relative_to(ROOT / 'local-only'):
            raise ValueError('잘못된 런타임 경계')
    for candidate, package, experiments, source, target, lock_bytes in prepared:
        prepare(candidate, package, experiments, source, target, lock_bytes, node_root)


def prepare(candidate, manifest, experiments, source, target, lock_bytes, node_root):
    spec = runtime_spec() if node_root is not None else None
    target.mkdir(parents=True, exist_ok=True)
    if not (target / "src").exists():
        shutil.copytree(source / "src", target / "src")
    if not (target / "scripts").exists():
        if (source / "scripts").exists():
            shutil.copytree(source / "scripts", target / "scripts")
        else:
            (target / "scripts").mkdir()
    for filename in ["LICENSE", "THIRD_PARTY_NOTICES.md"]:
        if (source / filename).is_file() and not (target / filename).exists():
            shutil.copyfile(source / filename, target / filename)
    for original, name in experiments.items():
        shutil.copyfile(ROOT / "experiments" / original, target / "scripts" / name)
    package = target / "package.json"
    if not package.exists():
        package.write_text(json.dumps(manifest, indent=2)+"\n",encoding="utf-8")
    # Tracked lock: installs are reproducible from the repository, never re-resolved.
    for filename in ["npm-user-empty.ini", "npm-global-empty.ini"]:
        if not (target / filename).exists():
            (target / filename).write_text("",encoding="utf-8")
    if node_root is not None:
        (target / 'package-lock.json').write_bytes(lock_bytes)
        env = {key:value for key,value in os.environ.items()
               if not key.startswith("KAKAO_") and key not in {"NODE_OPTIONS","NPM_TOKEN","NODE_AUTH_TOKEN"}}
        subprocess.run([str(node_root/spec['executable']),str(node_root/spec['npm_cli']),
                        "ci","--ignore-scripts","--no-audit","--no-fund","--registry=https://registry.npmjs.org",
                        "--userconfig=./npm-user-empty.ini","--globalconfig=./npm-global-empty.ini","--cache=./npm-cache"],
                       cwd=target,env=env,check=True)
    print(f"준비: {candidate} (계정·코드 실행 없음; 설치 스크립트 비활성)")


if __name__ == '__main__':
    main()
