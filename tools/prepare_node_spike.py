"""공식 Node 24 Windows ZIP을 작업 폴더에만 보관하는 조사용 준비 도구."""
import hashlib
import json
import re
import zipfile
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://nodejs.org/dist/v24.21.0/"
target_root = ROOT / "local-only/runtime"
listing = urlopen(BASE + "SHASUMS256.txt", timeout=30).read().decode("ascii")
matches = re.findall(r"^([0-9a-f]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-x64\.zip)$", listing, re.M)
if len(matches) != 1:
    raise SystemExit("정확히 하나의 공식 Windows ZIP을 찾지 못했습니다.")
expected, filename = matches[0]
target_root.mkdir(parents=True, exist_ok=True)
archive = target_root / filename
if not archive.exists():
    with urlopen(BASE + filename, timeout=60) as response, archive.open("xb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
actual = hashlib.sha256(archive.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit("공식 SHA-256과 다운로드가 일치하지 않아 실행 준비를 중단합니다.")
folder = target_root / filename.removesuffix(".zip")
if not folder.exists():
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            destination = (target_root / member.filename).resolve()
            if not destination.is_relative_to(target_root.resolve()):
                raise SystemExit("ZIP 경로가 작업 폴더 밖으로 나가므로 중단합니다.")
        source.extractall(target_root)
record = {"source": BASE + filename, "sha256": actual,
          "directory": folder.relative_to(ROOT).as_posix(),
          "global_install": False, "account_used": False}
evidence = ROOT / "evidence/alternatives"
evidence.mkdir(parents=True, exist_ok=True)
(evidence / "node-runtime.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(json.dumps(record, indent=2))
