"""다운로드한 공개 소스에서 계정 없는 실험 복사본을 준비한다."""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--install-dependencies", action="store_true")
args = parser.parse_args()
for candidate, dependencies, experiments in [
    ("modern", {"tsx":"^4","bson":"7.3.1","qrcode-terminal":"0.12.0"},
     {"modern-api-spike.ts":"local-api-spike.ts"}),
    ("legacy", {"tsx":"^4","bson":"^4.4.1"},
     {"legacy-codec-spike.ts":"local-codec-spike.ts"}),
]:
    manifest = json.loads((ROOT / f"evidence/alternatives/{candidate}-source.json").read_text(encoding="utf-8"))
    source = (ROOT / manifest["directory"]).resolve()
    if not source.is_relative_to(ROOT / "local-only"):
        raise ValueError("잘못된 source 경계")
    target = ROOT / "local-only/spikes" / candidate
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
        package.write_text(json.dumps({"private":True,"type":"module","name":f"{candidate}-kakao-research-spike",
                                       "dependencies":dependencies},indent=2)+"\n",encoding="utf-8")
    recorded_lock = ROOT / f"evidence/alternatives/{candidate}-package-lock.json"
    if recorded_lock.exists() and not (target / "package-lock.json").exists():
        shutil.copyfile(recorded_lock, target / "package-lock.json")
    for filename in ["npm-user-empty.ini", "npm-global-empty.ini"]:
        if not (target / filename).exists():
            (target / filename).write_text("",encoding="utf-8")
    if args.install_dependencies:
        runtime = json.loads((ROOT / "evidence/alternatives/node-runtime.json").read_text(encoding="utf-8"))
        node_root = (ROOT / runtime["directory"]).resolve()
        if not node_root.is_relative_to(ROOT / "local-only"):
            raise ValueError("잘못된 런타임 경계")
        env = {key:value for key,value in os.environ.items()
               if not key.startswith("KAKAO_") and key not in {"NODE_OPTIONS","NPM_TOKEN","NODE_AUTH_TOKEN"}}
        install_command = "ci" if (target/"package-lock.json").exists() else "install"
        subprocess.run([str(node_root/"node.exe"),str(node_root/"node_modules/npm/bin/npm-cli.js"),
                        install_command,"--ignore-scripts","--no-audit","--no-fund","--registry=https://registry.npmjs.org",
                        "--userconfig=./npm-user-empty.ini","--globalconfig=./npm-global-empty.ini","--cache=./npm-cache"],
                       cwd=target,env=env,check=True)
    print(f"준비: {candidate} (계정·코드 실행 없음; 설치 스크립트 비활성)")
