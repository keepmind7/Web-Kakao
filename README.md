# Web-Kakao

카카오톡 대화방을 **내 컴퓨터의 브라우저**에서 보고 메시지를 주고받는 로컬 웹 클라이언트입니다. 내 PC에서 도는 작은 Node 서버가 카카오톡 서버와 통신하고, Chrome·Edge 같은 브라우저는 `http://127.0.0.1:8787`의 화면을 씁니다. 공식 카카오톡 앱을 띄워 두거나 외부 서버·터널을 거치지 않습니다.

> **주의:** 카카오의 공식 클라이언트나 공식 API 연동이 아닙니다. 카카오톡 휴대폰 앱의 QR 승인으로 **Android 태블릿 보조 기기**로 로그인합니다. 카카오 약관상 비공식 클라이언트 사용은 계정 이용 제한의 위험이 있습니다. 로그인을 반복해서 시도하거나 대량으로 발송하지 마세요.

## 주요 기능

- **로그인:** QR 로그인. 휴대폰 카카오톡에서 승인하며, 이미 쓰는 태블릿 보조 기기가 있으면 그 슬롯과 겹칠 수 있습니다.
- **조회:** 방 목록, 방 이름, 방별 최근 메시지(최대 50개), 대화 내 검색
- **발송:** 텍스트, 답장, 사진. 사진은 JPEG·PNG·WebP를 브라우저에서 JPEG로 바꿔 보냅니다.
- **읽음과 알림:** 안 읽음 배지, 다른 기기에서 읽은 상태 반영, 조회 시 읽음 알리기(기본 OFF)
- **개인 설정(선택):** 방 별칭, 고정, 방별 알림 끄기, 필터, 라이트·다크 테마. 이 컴퓨터에만 저장합니다.
- **오픈채팅:** 이미 참여한 방만 다룹니다. 새 방에 자동으로 들어가지 않습니다.
- **지원하지 않는 것:** 동영상·파일·사진 묶음 전송, 계정 전체 과거 이력 보관

## 지원 환경과 현재 상태

| OS | 상태 (2026-10-25) |
| --- | --- |
| Windows x64 | 주 개발 환경입니다. QR, 조회, 텍스트·답장·사진 발송, 읽음 동기화를 사용자가 확인했습니다. |
| macOS (Intel) | 준비·mock·격리 브라우저 검사를 통과했습니다. 실계정으로 QR 로그인, 방 목록·이름, 기존 대화 조회, 텍스트 발송(오픈채팅·나와의 채팅)을 사용자가 확인했습니다. |
| macOS (Apple Silicon) | 고정 런타임은 넣었지만 실기기에서는 실행해 보지 않았습니다. |
| Linux x64 (glibc), WSL2 | 계정 없는 회귀 테스트와 실계정 조회를 확인했습니다. 실제 메시지 송수신은 확인하지 않았습니다. |

필요한 것:
- **Python 3.11 이상:** 표준 라이브러리만 쓰므로 pip로 설치할 패키지가 없습니다.
- **Chrome·Chromium·Edge 중 하나**
- **카카오톡이 설치된 휴대폰**
- **네트워크:** 처음 준비할 때와 실제 통신에 필요합니다.

Node.js는 준비 도구가 고정 버전(24.21.0)을 프로젝트 안에 설치하므로 따로 깔지 않아도 됩니다.

## 구조

```text
브라우저 (Chrome / Edge)
    │  127.0.0.1 HTTP · 일회용 입장권 → 헤더 세션 · 탭 유지 연결(SSE)
    ▼
Node 서버  experiments/local-web/server.mjs  (127.0.0.1:8787)
    ├─ QR 인증 (kakao-auth.mjs) · 개인 설정 (preferences.mjs) · 사진 프록시 (photos.mjs)
    └─ 대화 worker (reader-manager → reader-worker → reader-session)
            └─ 카카오톡 서버: LOCO 대화 연결 + HTTPS 사진 업로드

Python 실행 도구  tools/local_web.py  → 서버 start / status / open / stop
    └─ OS 어댑터  tools/platforms/{windows,linux,macos}.py  (포트 소유자·실행 파일 확인)
```

- **프로토콜:** 카카오톡 통신 코드는 공개 저장소 [tyeom/kakao-cli](https://github.com/tyeom/kakao-cli)를 특정 커밋에 고정해 내려받아 씁니다(비상업 라이선스). 저장소에는 포함하지 않고 `local-only/`에 준비합니다.
- **로그인 정보:** 서버 메모리에만 두고 디스크에 저장하지 않습니다. 서버를 재시작하면 QR 로그인을 다시 해야 합니다.
- **보안:** 서버는 127.0.0.1에서만 받고 Host·Origin·CSRF를 검사합니다. 실행 도구는 포트를 쥔 프로세스가 이 프로젝트의 Node인지 확인하고, HMAC 챌린지를 통과한 서버에만 제어 권한을 넘깁니다.

| 경로 | 내용 |
| --- | --- |
| `experiments/local-web/` | 제품 본체: 웹 UI(`index.html`, `app.js`), 서버, 프로토콜·사진·설정 모듈 |
| `tools/` | 실행·준비 도구, OS 어댑터(`platforms/`), 고정 npm 잠금 파일(`locks/`), 선택적 분석 도구 |
| `tests/` | 계정 없이 도는 단위·통합·격리 브라우저 테스트 |
| `experiments/` 그 밖 | 사진 전송 방식 비교 모델, 조사용 실험 |
| `ui/` | UI 디자인 시안 |
| `reports/` | 플랫폼 지원 안내, 검증 기록, APK 분석 인계 |
| `AGENTS.md`, `.agents/`, `.codex/`, `.harness/` | AI 에이전트 개발 하네스(역할·스킬·운영 규칙) |
| `local-only/` | 런타임·고정 소스·node_modules (Git 제외, 준비 도구가 생성) |

## 설치

처음 사용한다면 [설치·운영 안내](reports/USER_GUIDE.ko.md)를 함께 보세요. 소스 ZIP을 받은 경우 새 폴더에 압축을 풀고 아래 준비 명령부터 실행합니다. ZIP에는 런타임·npm 의존성·로그인 정보가 포함되지 않으며 각 OS에서 새로 준비해야 합니다.

```bash
git clone https://github.com/keepmind7/Web-Kakao.git web-kakao
cd web-kakao
```

준비는 네 단계이고, 카카오 로그인은 하지 않습니다. Windows는 `python3` 대신 `py -3`를 쓰고, 경로는 `C:\src\web-kakao`처럼 짧게 두는 것이 좋습니다.

```bash
python3 tools/prepare_node_spike.py                  # 고정 Node 런타임 (공식 배포 + SHA-256 확인)
python3 tools/fetch_source_spike.py modern           # 고정 커밋의 공개 프로토콜 소스
python3 tools/fetch_source_spike.py legacy
python3 tools/prepare_spikes.py --install-dependencies  # 잠금 파일로 npm ci --ignore-scripts
```

- 내려받는 모든 파일은 버전·해시·무결성을 확인한 뒤 `local-only/`에 둡니다. TLS 검증은 끄지 않습니다.
- 다른 OS에서 만든 `local-only/` 런타임이나 node_modules는 복사해 쓰지 말고 OS마다 새로 준비하세요.
- Linux는 한글 표시를 위해 CJK 글꼴이 필요합니다. 자세한 내용은 [플랫폼 지원 안내](reports/PLATFORM_SUPPORT.ko.md)를 보세요.

## 실행과 종료

```bash
python3 tools/local_web.py start --gap-probe --messaging   # 서버 시작
python3 tools/local_web.py open --browser chrome           # 새 브라우저 창 열기 (edge·chromium도 가능)
python3 tools/local_web.py status                          # 상태 확인 (토큰·QR은 출력하지 않음)
```

1. `open`으로 **새로 열린 창**에서 **QR 로그인 시작**을 누릅니다. 주소창에 직접 입력한 탭에는 접근 권한이 없습니다.
2. 휴대폰 카카오톡으로 QR을 승인합니다.
3. **대화방 불러오기**를 누르면 방 목록이 나타납니다.

**시작 옵션**

| 옵션 | 의미 |
| --- | --- |
| `--messaging` | 글·답장·사진 전송과 읽음 기능을 켭니다. 빼면 읽기 전용입니다. |
| `--gap-probe` | 메시지 사이에 빠진 구간이 있으면 한 번 더 조회합니다. |
| `--photo-transport https` | 사진 전송 방식입니다. 기본값이 `https`이고, `loco`는 실험용 대안입니다. |
| `--mock` | 카카오 계정 없이 화면과 흐름만 시험합니다. |

옵션을 바꾸려면 서버를 다시 시작해야 합니다. 실행 중인 서버에 다른 옵션으로 `start`를 해도 교체되지 않고 거절됩니다.

**종료:** 작성 중인 글을 보관하고, 웹 설정에서 **로컬 세션 지우기**를 누른 뒤 다음을 실행합니다.

```bash
python3 tools/local_web.py stop
```

- 로그인이나 대화 연결이 살아 있으면 `stop`이 종료를 거절합니다.
- 서버 종료는 카카오톡 계정의 원격 로그아웃과 다릅니다. 연결된 기기 목록에서 지우려면 휴대폰의 **기기 연결 관리**를 쓰세요.

## 사용할 때 알아둘 것

- **읽음:** **대화 조회 시 카카오톡에도 읽음 알리기**는 기본 OFF입니다. 켜면 방을 선택하고 창에 포커스를 둔 채 최신 메시지를 맨 아래까지 봤을 때만 읽음을 보냅니다. 직접 글을 보낸 방은 이 설정과 관계없이 읽음이 동기화됩니다.
- **발송 결과가 불명확할 때:** 자동으로 다시 보내지 않습니다. 휴대폰에서 도착했는지 확인하고 경고를 닫으세요. 확인 버튼은 재발송 버튼이 아닙니다.
- **사진 제한:** 원본 20MiB·4천만 픽셀 이하만 받고, 긴 변 4096px·변환 결과 10MiB 이하로 줄여 보냅니다. 투명한 부분은 흰색이 됩니다. 오류 문구 끝의 `[format]`·`[decode]`·`[encode]`·`[output-size]`는 어느 단계에서 실패했는지를 나타냅니다.
- **탭을 닫으면:** 로그인된 탭을 모두 닫고 2분이 지나면 대화 연결·로그인 정보·사진 캐시를 지웁니다. 서버 프로세스는 남습니다.
- **절전:** 컴퓨터가 절전에 들어가면 대화 연결이 끊길 수 있습니다. 자동으로 다시 연결하지 않으므로 화면의 **대화 서버 다시 연결**을 누르세요. macOS에서 오래 켜 두려면 다른 터미널에서 `caffeinate -i`를 실행해 두면 됩니다(덮개를 닫으면 효과 없음).
- **브라우저:** VS Code 내장 브라우저는 지원하지 않습니다. 외부 Chrome·Edge를 쓰세요.

## 데이터 저장 위치

로그인 정보·대화·사진은 서버 메모리에서만 다룹니다. 디스크에는 실행 정보, 로그, 정제된 진단 기록과 (켰을 때만) 개인 설정을 설치마다 별도 폴더에 저장합니다.

| OS | 위치 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\WebKakao\<설치별 해시>\` |
| macOS | `~/Library/Application Support/WebKakao/<설치별 해시>/` |
| Linux | `$XDG_DATA_HOME` 또는 `~/.local/share/WebKakao/<설치별 해시>/` |

- 하위 폴더 `web-auth/`는 실행 정보·로그·진단, `preferences/`는 개인 설정입니다.
- 폴더는 본인만 접근 가능하게 만듭니다(Windows ACL, POSIX 0700/0600). 파일을 암호화하지는 않습니다.
- 설치별 해시는 프로젝트 절대 경로로 계산하므로, 프로젝트를 옮기면 저장 위치도 바뀝니다.
- 진단 기록에는 메시지 본문·원본 ID·토큰을 넣지 않습니다.
- 연결 종료 기록(`web-auth/reader-lifecycle.json`)은 최근8회 연결·회당16개 이벤트와 정제된 마지막 진단을 보존합니다. 재연결해도 이전 실패 단계·종료 코드/signal을 대조할 수 있으며 1MiB를 넘는 파일은 읽거나 쓰지 않습니다. 손상된 기록은 덮어쓰지 않고 연결은 메모리 상태로 계속 동작합니다.

## 업데이트

```bash
git status --short
git pull --ff-only
```

실행 중인 서버는 파일을 바꿔도 자동으로 교체되지 않습니다. 서버 코드가 바뀌었으면 **초안 보관 → 로컬 세션 지우기 → stop → start → open → QR 로그인** 순서로 다시 시작하세요. 예전 build7 서버를 끌 때는 `stop --legacy`, 예전 개인 설정을 옮길 때는 `migrate-preferences --source <폴더>`를 씁니다(Windows).

## 테스트

모든 테스트는 실제 계정 없이 모의 서버, 임시 브라우저 프로필, 임시 포트로 돌아갑니다. 먼저 설치 단계를 마쳐야 합니다.

```bash
python3 -m unittest discover -s tests            # Python
NODE=local-only/runtime/node-v24.21.0-darwin-x64/bin/node   # OS에 맞는 런타임 경로
$NODE --test --test-concurrency=1 tests/*.test.mjs          # Node
$NODE tests/reader-browser-smoke.mjs                        # 격리 Chrome 화면 검사
```

- **Windows Node 경로:** `local-only\runtime\node-v24.21.0-win-x64\node.exe`
- **Linux 단계별 검증:** `python3 tools/verify_linux.py --suite mock|platform|full`
- **2026-10-25 다른 사용자용 안정화 최종 결과:** Python248통과·14skip, Node1,099통과·2skip, 격리 Chrome11프로그램과 추가2모드의 최종214조건을 통과했습니다. Mac mock 실행/종료와 소스 ZIP의 manifest·추출 후 검사도 확인했습니다. 첫 브라우저 실패2건과 후속 재검증, 실제 계정·다른 OS의 미실행 범위는 [안정화 보고서](reports/READINESS_20261025.ko.md)를 보세요. 현재 사용 중인 서버는 교체하지 않았습니다.
- **같은 날 앞선 심화 QA 결과(아래는 이력):**
  - 심화 QA: Python 총 257개 중 243개 통과, 14개 건너뜀, 오류 0
  - 심화 QA: Node 총 1,059개 중 1,057개 통과, 2개 건너뜀, 실패 0
  - 격리 Chrome 9프로그램·보고 조건194개 통과(`reader-browser-smoke.mjs` 131조건 포함)
  - 실제 임시 파일 저장·메모리 순환·Mac mock 시작/종료까지 확인했습니다. 범위와 현재 실서버 연결 상태는 [심화 QA 보고서](reports/QA_20261025.ko.md)를 보세요.
  - 사진 캐시·설정 대기열의 상한과 정리를 보완했습니다. 합성 메모리 측정·회귀 결과는 [최적화 보고서](reports/OPTIMIZATION_20261025.ko.md)를 보세요.
  - 최초 Mac 검증의 하네스 8종 성공과 두 탭 CDP timeout은 [검증 기록](reports/VALIDATION_HISTORY.ko.md)에 보존합니다.

## 알려진 문제

- **과거 사진 수신 뒤 대화 연결 종료:** 10/25 15:56·사진 묶음2건의 실제 원인은 당시 기록이 없어 미확정입니다. 이후 재현한 비정상 치수 예외는 방어했고, 이전 실패를 남기는 진단과 여러 탭의 사진 요청 제한을 추가했습니다. 실제 사건의 원인을 확정한 것은 아닙니다. [수정 전 조사](reports/PHOTO_BURST_DIAGNOSIS_20261025.ko.md)·[안정화 수정과 검증](reports/READINESS_20261025.ko.md)을 보세요.
- **macOS 브라우저 스모크 테스트 이력:** 최초 두 탭 동시 구간에서 CDP timeout이 발생했습니다. 이후 진단과 이번 수정 후 전체 131조건은 통과했지만, 과거 timeout의 원인은 아직 확정하지 못했습니다.
- **절전·네트워크 단절 뒤 복구:** 연결이 끊긴다는 것은 확인했습니다. 다시 연결한 뒤 계속 쓸 수 있는지와 인증 갱신은 아직 확인하지 않았습니다.
- **안 읽음 배지:** 일반 1:1 방 한 곳에서 모바일 읽음이 웹에 반영되는 것은 확인했습니다. 처음 관찰된 실패의 원인과 그 밖의 조건은 아직 모릅니다.
- **선택 옵션인 LOCO 사진 업로드:** 완료 응답 전에 연결이 끊깁니다. 기본값인 HTTPS 방식은 정상입니다.
- **프로토콜 고정 버전:** 접속 프로필이 앱 26.1.2에 고정돼 있습니다. 카카오가 프로토콜을 바꾸면 언제든 동작이 멈출 수 있습니다.
- **추가 확인이 필요한 항목:** 오픈채팅의 사진·답장·읽음, 일부 방 제목, 장시간 사용, 사진 다운로드. 이 항목들과 그동안의 상세 검증 결과는 [검증 기록](reports/VALIDATION_HISTORY.ko.md)에 정리돼 있습니다.

## 관련 문서

- [처음 사용하는 사람을 위한 설치·운영 안내](reports/USER_GUIDE.ko.md)
- [다른 사용자용 안정화](reports/READINESS_20261025.ko.md): 수신 오류·사진 로딩·장애 기록·소스 패키지 보완과 검증
- [검증·개발 기록](reports/VALIDATION_HISTORY.ko.md): 날짜별 테스트 수치, 실계정 확인 결과, 미해결 항목
- [플랫폼 지원 안내](reports/PLATFORM_SUPPORT.ko.md): Windows/macOS/Linux/WSL 지원과 이식 기록
- [메모리·운영 최적화](reports/OPTIMIZATION_20261025.ko.md): 캐시·설정 대기열 상한, 측정과 적용 절차
- [최적화 후 심화 QA](reports/QA_20261025.ko.md): 전체 회귀·브라우저9종·반복 메모리 검사와 현재 연결 상태
- [APK 분석 인계](reports/APK_HANDOFF.ko.md), [PC 분석](tools/pc_analysis/README.ko.md), [Android 추출](tools/apk_export/README.ko.md): 선택적 정적 분석
- [사진 전송 방식 비교 모델](experiments/photo-method-simulation/README.md)
- 개발 규칙: [AGENTS.md](AGENTS.md), [운영 규칙](.harness/OPERATING.md), [후속 계획](.harness/FOLLOWUP.md)
