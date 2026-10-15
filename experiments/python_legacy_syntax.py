"""구 Python LOCO 후보의 구문만 확인한다. 원본을 실행하지 않는다."""
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
path = ROOT / "local-only/sources/python/69b0cbd15cc8019b5c23fdd14470aea1181a5773/pykakao.py"
data = path.read_bytes()
result = {"experiment": "legacy_python3_syntax",
          "candidate_commit": "69b0cbd15cc8019b5c23fdd14470aea1181a5773",
          "file": "pykakao.py", "sha256": hashlib.sha256(data).hexdigest(),
          "python3_syntax_valid": False, "code_executed": False, "real_account_verified": False}
try:
    ast.parse(data)
    result["python3_syntax_valid"] = True
except SyntaxError as exc:
    result["syntax_error_line"] = exc.lineno
    result["syntax_error_kind"] = "SyntaxError"
output = ROOT / "evidence/alternatives/python-syntax.json"
output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, indent=2))
