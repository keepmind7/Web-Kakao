"""네트워크·계정 접근 없이 문서와 최신 단계의 소스 해시를 확인한다."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
issues = []
link_count = 0
documents = [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]
for document in documents:
    content = document.read_text(encoding="utf-8")
    if "\ufffd" in content:
        issues.append(f"UTF-8 대체 문자: {document.relative_to(ROOT)}")
    for match in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", content):
        link = match.group(1)
        if link.startswith(("https://", "http://", "#")):
            continue
        link_count += 1
        target = (document.parent / link.split("#", 1)[0]).resolve()
        if not target.is_relative_to(ROOT) or not target.exists():
            issues.append(f"없는 로컬 링크: {document.relative_to(ROOT)} → {link}")

hash_count = 0
latest_source_manifest = next((path for path in [ROOT / "evidence/phase3/source-manifest.json", ROOT / "evidence/phase2/source-manifest.json", ROOT / "evidence/local-web/source-manifest.json"] if path.exists()), None)
if latest_source_manifest is None or not (ROOT / "evidence/experiment-source-manifest.json").is_file():
    # evidence/ is not tracked; a fresh clone has no local verification records.
    raise SystemExit("검증 기록(evidence/*source-manifest.json)이 없습니다. 새로 받은 저장소에서는 해시 검증을 할 수 없습니다.")
for base, manifest in [
    (ROOT, ROOT / "evidence/experiment-source-manifest.json"),
    (ROOT / "tools/vendor/codex_harness", ROOT / "tools/vendor/codex_harness/source-manifest.json"),
    (ROOT, latest_source_manifest),
]:
    data = json.loads(manifest.read_text(encoding="utf-8"))
    for entry in data["files"]:
        target = (base / entry["path"]).resolve()
        if not target.is_relative_to(base.resolve()) or not target.is_file():
            issues.append(f"없는 manifest 대상: {entry['path']}")
            continue
        hash_count += 1
        if hashlib.sha256(target.read_bytes()).hexdigest() != entry["sha256"]:
            issues.append(f"SHA-256 불일치: {entry['path']}")

result = {"documents_read_as_utf8": len(documents), "local_links_checked": link_count,
          "sha256_checked": hash_count, "issues": issues, "passed": not issues,
          "artifact_check_verifies_real_account": False}
print(json.dumps(result, ensure_ascii=True, indent=2))
raise SystemExit(0 if not issues else 1)
