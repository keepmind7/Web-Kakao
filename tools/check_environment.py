"""민감한 설정을 읽지 않는 실행 도구 점검."""
import json
import platform
import shutil
import subprocess
from datetime import datetime, timezone

commands = ["python", "git", "uv", "node", "npm", "codex", "claude", "rea",
            "java", "jadx", "frida", "ghidra", "adb", "docker", "go"]
result = {
    "observed_at_utc": datetime.now(timezone.utc).isoformat(),
    "platform": platform.system(),
    "architecture": platform.machine(),
    "python": platform.python_version(),
    "commands_on_path": {name: shutil.which(name) is not None for name in commands},
    "limits": ["PATH 탐색만 수행; 비표준 경로의 설치 유무는 미확인", "MCP 호출 가능 여부는 부모·서브에이전트의 도구 카탈로그에서 별도 확인"],
}
result["git_head"] = None
if result["commands_on_path"]["git"]:
    try:
        git = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True)
        result["git_head"] = git.stdout.strip() if git.returncode == 0 else None
    except OSError:
        # PATH에 있어도 실행 파일이 없거나 실행 권한이 거부될 수 있다.
        pass
print(json.dumps(result, ensure_ascii=True, indent=2))
