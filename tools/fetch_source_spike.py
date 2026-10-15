"""허용된 공개 후보의 고정 소스를 local-only에 보관; 코드 실행 없음."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
CANDIDATES = {
    "modern": ("tyeom/kakao-cli", "8dbbd4f7ed6b42542982252250622fa351af00e9"),
    "legacy": ("storycraft/node-kakao", "8512e4699e2cd4c26516b80d38b57b2f85a6cc8a"),
    "python": ("hallazzang/pykakao", "69b0cbd15cc8019b5c23fdd14470aea1181a5773"),
    "superpowers": ("obra/superpowers", "bb92a77741419a4ab5f06e711a283343f1ada0c3"),
}


def fetch(url):
    req = Request(url, headers={"User-Agent": "Web-Kakao-Research-Spike/0.1"})
    with urlopen(req, timeout=30) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("조사 파일 크기 제한 초과")
    return data


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("candidate", choices=CANDIDATES)
args = parser.parse_args()
repo, commit = CANDIDATES[args.candidate]
tree = json.loads(fetch(f"https://api.github.com/repos/{repo}/git/trees/{commit}?recursive=1"))
if tree.get("truncated"):
    raise SystemExit("파일 목록이 잘려 조사 완료로 처리할 수 없습니다.")
paths = [entry["path"] for entry in tree["tree"] if entry["type"] == "blob"]
if args.candidate == "superpowers":
    selected = ["LICENSE", "skills/brainstorming/SKILL.md", "skills/brainstorming/builder-check-prompt.md",
                "skills/using-superpowers/SKILL.md", "skills/using-superpowers/references/codex-tools.md"]
else:
    selected = [p for p in paths if p.lower().endswith((".ts", ".tsx", ".py", ".json", ".yaml", ".md"))
                or PurePosixPath(p).name.upper().startswith("LICENSE")]
directory = ROOT / "local-only/sources" / args.candidate / commit
directory.mkdir(parents=True, exist_ok=True)
rows = []
for relative in selected:
    parts = PurePosixPath(relative)
    if parts.is_absolute() or ".." in parts.parts:
        raise ValueError("잘못된 원본 경로")
    target = (directory / relative).resolve()
    if not target.is_relative_to(directory.resolve()):
        raise ValueError("원본 저장 경로가 작업 경계를 벗어남")
    url = f"https://raw.githubusercontent.com/{repo}/{commit}/{relative}"
    data = target.read_bytes() if target.exists() else fetch(url)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    rows.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest()})
manifest = {"candidate": args.candidate, "repository": f"https://github.com/{repo}", "commit": commit,
            "directory": directory.relative_to(ROOT).as_posix(), "files": rows,
            "public_tree_paths": paths, "code_executed": False, "account_used": False}
output = ROOT / "evidence/alternatives" / f"{args.candidate}-source.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(manifest, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"candidate": args.candidate, "commit": commit, "files": len(rows),
                  "manifest": output.relative_to(ROOT).as_posix()}))
