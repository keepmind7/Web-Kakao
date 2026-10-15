"""기기/앱을 실행하거나 사용자 대화를 읽지 않는 대안 준비 상태 검사."""
import json
import platform
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
paths = [Path("C:/Program Files/Kakao/KakaoTalk/KakaoTalk.exe"),
         Path("C:/Program Files (x86)/Kakao/KakaoTalk/KakaoTalk.exe")]
result = {"experiment":"alternative_runtime_readiness", "host_os":platform.system(),
          "macos_accessibility_supported_on_this_host":platform.system()=="Darwin",
          "commands_on_path":{name:shutil.which(name) is not None for name in ["adb","java","docker","go","rustc","cargo"]},
          "official_windows_app_found_in_two_standard_paths":any(p.is_file() for p in paths),
          "official_app_not_executed":True, "personal_device_power_off_verified":False,
          "account_used":False, "limits":["Only PATH and two standard app paths inspected; other installations unknown",
            "User has no independent server; home laptop is a temporary test host only"]}
target = ROOT / "evidence/alternatives/environment.json"
target.write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
print(json.dumps(result,indent=2))
