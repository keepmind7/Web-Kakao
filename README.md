# Web-Kakao

카카오톡 대화방 조회와 메시지 송수신을 위한 로컬 웹 클라이언트. PC의 Node 서버가 카카오톡 서버와 통신하고, Chrome·Edge 등의 브라우저에서 `http://127.0.0.1:8787`로 사용함. 공식 카카오톡 앱의 상시 실행이나 외부 서버·터널 없이 동작하는 구조.

> 카카오의 공식 클라이언트 또는 공식 API 연동 제품이 아님. 휴대폰 카카오톡의 QR 승인을 받아 Android 태블릿 보조 기기로 로그인하며, 비공식 클라이언트 사용에 따른 계정 이용 제한 위험이 있음. 반복 로그인과 대량 발송 주의.

## 주요 기능

| 구분 | 지원 범위 |
| --- | --- |
| 로그인 | 휴대폰 카카오톡에서 승인하는 QR 로그인. 기존 태블릿 보조 기기의 등록 슬롯과 충돌 가능 |
| 대화 조회 | 방 목록·이름, 방별 최근 메시지 최대 50개, 대화 내 검색 |
| 메시지 발송 | 텍스트·답장·사진. JPEG·PNG·WebP 사진은 브라우저에서 JPEG로 변환 후 전송 |
| 읽음·알림 | 안 읽음 배지, 다른 기기의 읽음 상태 반영, 조회 시 읽음 알리기(기본 OFF) |
| 개인 설정 | 방 별칭·고정·방별 알림 끄기·필터·라이트/다크 테마. 선택 시 해당 컴퓨터에만 저장 |
| 오픈채팅 | 이미 참여한 방 조회·사용. 새 방 자동 입장 없음 |

동영상·파일·사진 묶음 전송과 계정 전체 과거 이력 보관은 지원하지 않음.

## 지원 환경

플랫폼별 확인 범위는 2026-10-25 기준.

| OS | 검증 범위 |
| --- | --- |
| Windows x64 | 주 개발 환경. 사용자가 QR 로그인, 조회, 텍스트·답장·사진 발송, 읽음 동기화 확인 |
| macOS (Intel) | 준비·mock·격리 브라우저 검사 통과. 사용자가 실계정 QR 로그인, 방 목록·이름, 기존 대화 조회, 오픈채팅·나와의 채팅 텍스트 발송 확인 |
| macOS (Apple Silicon) | 고정 런타임 제공. 실기기 실행 미검증 |
| Linux x64 (glibc), WSL2 | 계정 없는 회귀 검사와 실계정 조회 확인. 실제 메시지 송수신 미검증 |

실행 요건:

- Python 3.11 이상. 표준 라이브러리만 사용하며 별도 pip 패키지 불필요
- Chrome·Chromium·Edge 중 하나
- 카카오톡이 설치된 휴대폰
- 최초 준비 및 카카오톡 통신에 사용할 네트워크

Node.js는 준비 도구가 고정 버전 24.21.0을 프로젝트 내부에 설치하므로 별도 설치 불필요.

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

카카오톡 통신에는 공개 저장소 [tyeom/kakao-cli](https://github.com/tyeom/kakao-cli)의 특정 커밋을 사용함. 해당 소스는 비상업 라이선스이며, Git 저장소에 포함하지 않고 준비 도구로 `local-only/`에 내려받음.

로그인 정보는 서버 메모리에만 보관하며 디스크에 저장하지 않음. 서버 재시작 후 QR 재인증 필요. 로컬 서버는 127.0.0.1 요청만 수신하며 Host·Origin·CSRF 검사 수행. 실행 도구는 포트 소유 프로세스가 이 프로젝트의 Node인지 확인하고, HMAC 챌린지를 통과한 서버에만 제어 권한을 부여함.

| 경로 | 용도 |
| --- | --- |
| `experiments/local-web/` | 웹 UI(`index.html`, `app.js`), 서버, 프로토콜·사진·설정 모듈 |
| `tools/` | 실행·준비 도구, OS 어댑터(`platforms/`), 고정 npm 잠금 파일(`locks/`), 선택적 분석 도구 |
| `tests/` | 계정 없는 단위·통합·격리 브라우저 검사 |
| `experiments/` 그 밖 | 사진 전송 방식 비교 모델과 조사용 실험 |
| `ui/` | UI 디자인 시안 |
| `reports/` | 플랫폼 지원 안내, 검증 기록, APK 분석 인계 |
| `AGENTS.md`, `.agents/`, `.codex/`, `.harness/` | AI 에이전트 개발 하네스의 역할·스킬·운영 규칙 |
| `local-only/` | 준비 도구가 생성하는 런타임·고정 소스·node_modules. Git 제외 |

## 설치

상세 절차는 [설치·운영 안내](reports/USER_GUIDE.ko.md) 참고. 소스 ZIP 사용 시 새 폴더에 압축을 해제한 뒤 준비 명령 실행. ZIP에는 런타임·npm 의존성·로그인 정보가 포함되지 않으므로 OS별 준비 필요.

```bash
git clone https://github.com/keepmind7/Web-Kakao.git web-kakao
cd web-kakao
```

준비 단계에서는 카카오 계정에 로그인하지 않음. Windows에서는 `python3` 대신 `py -3`를 사용하며, 프로젝트 경로는 `C:\src\web-kakao`와 같이 짧은 경로 권장.

```bash
python3 tools/prepare_node_spike.py                  # 고정 Node 런타임 (공식 배포 + SHA-256 확인)
python3 tools/fetch_source_spike.py modern           # 고정 커밋의 공개 프로토콜 소스
python3 tools/fetch_source_spike.py legacy
python3 tools/prepare_spikes.py --install-dependencies  # 잠금 파일로 npm ci --ignore-scripts
```

- 다운로드 파일은 버전·해시·무결성 확인 후 `local-only/`에 저장. TLS 검증 유지
- 다른 OS에서 준비한 `local-only/` 런타임과 node_modules는 재사용하지 않고 OS별로 새로 준비
- Linux의 한글 표시에는 CJK 글꼴 필요. [플랫폼 지원 안내](reports/PLATFORM_SUPPORT.ko.md) 참고

## 실행과 종료

```bash
python3 tools/local_web.py start --gap-probe --messaging   # 서버 시작
python3 tools/local_web.py open --browser chrome           # 새 브라우저 창 열기 (edge·chromium도 가능)
python3 tools/local_web.py status                          # 상태 확인 (토큰·QR은 출력하지 않음)
```

1. `open`으로 열린 새 창에서 **QR 로그인 시작** 선택. 주소창에 직접 접속한 탭에는 접근 권한이 없음
2. 휴대폰 카카오톡에서 QR 스캔·승인
3. **대화방 불러오기** 선택 후 방 목록 확인

### 시작 옵션

| 옵션 | 동작 |
| --- | --- |
| `--messaging` | 텍스트·답장·사진 전송과 읽음 기능 활성화. 생략 시 읽기 전용 |
| `--gap-probe` | 메시지 사이의 누락 구간을 한 번 추가 조회 |
| `--photo-transport https` | 사진 전송 방식 지정. 기본값은 `https`, `loco`는 실험용 대안 |
| `--mock` | 카카오 계정 없이 화면과 흐름 시험 |

옵션 변경 시 서버 재시작 필요. 실행 중인 서버에 다른 옵션으로 `start`를 요청하면 기존 서버를 교체하지 않고 거절함.

### 종료 절차

작성 중인 초안을 보관하고 웹 설정의 **로컬 세션 지우기**를 선택한 뒤 아래 명령 실행.

```bash
python3 tools/local_web.py stop
```

로그인 또는 대화 연결이 활성 상태이면 `stop` 요청을 거절함. 로컬 서버 종료는 카카오톡 계정의 원격 로그아웃과 별개이며, 연결 기기 등록 해제는 휴대폰의 **기기 연결 관리**에서 수행.

## 운영 시 유의사항

| 항목 | 동작 및 조치 |
| --- | --- |
| 읽음 알리기 | **대화 조회 시 카카오톡에도 읽음 알리기**는 기본 OFF. 활성화 시 선택한 방에서 창 포커스를 유지하고 최신 메시지의 맨 아래까지 확인한 경우에만 읽음 통보. 직접 메시지를 보낸 방은 이 설정과 관계없이 읽음 동기화 |
| 발송 결과 불명 | 자동 재발송 없음. 휴대폰에서 도착 여부를 확인한 뒤 경고 닫기. 결과 확인 버튼에는 재발송 기능이 없음 |
| 사진 제한 | 원본 20MiB·4천만 픽셀 이하. 긴 변 4096px·변환 결과 10MiB 이하로 축소하며 투명 영역은 흰색으로 변환. 오류 끝의 `[format]`·`[decode]`·`[encode]`·`[output-size]`로 실패 단계 구분 |
| 탭 종료 | 로그인된 모든 탭을 닫은 뒤 2분 경과 시 대화 연결·로그인 정보·사진 캐시 정리. 서버 프로세스는 유지 |
| 절전 | 절전 진입 시 대화 연결 단절 가능. 자동 재연결은 지원하지 않으며 **대화 서버 다시 연결**로 복구 시도. macOS에서 절전 방지가 필요하면 별도 터미널에서 `caffeinate -i` 실행. 덮개를 닫은 상태에는 효과 없음 |
| 브라우저 | VS Code 내장 브라우저 미지원. 외부 Chrome·Edge 사용 |

## 데이터 저장 위치

로그인 정보·대화·사진은 서버 메모리에서만 처리. 실행 정보·로그·정제된 진단 기록은 디스크에 저장하며, 개인 설정은 저장 옵션을 켠 경우에만 보관. 설치별로 별도 데이터 폴더 사용.

| OS | 위치 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\WebKakao\<설치별 해시>\` |
| macOS | `~/Library/Application Support/WebKakao/<설치별 해시>/` |
| Linux | `$XDG_DATA_HOME` 또는 `~/.local/share/WebKakao/<설치별 해시>/` |

- `web-auth/`: 실행 정보·로그·진단 기록
- `preferences/`: 개인 설정
- 접근 권한: Windows ACL, POSIX 0700/0600으로 해당 사용자만 접근하도록 제한. 파일 암호화는 적용하지 않음
- 설치별 해시: 프로젝트 절대 경로로 계산. 프로젝트 이동 시 저장 위치도 변경
- 진단 기록: 메시지 본문·원본 ID·토큰 제외

연결 종료 기록(`web-auth/reader-lifecycle.json`)은 최근 8회 연결의 회당 16개 이벤트와 정제된 마지막 진단을 보존함. 재연결 후에도 이전 실패 단계·종료 코드/signal 대조 가능. 1MiB를 초과하는 파일은 읽거나 쓰지 않으며, 기록이 손상된 경우 원본을 덮어쓰지 않고 메모리 상태로 연결 동작 유지.

## 업데이트

```bash
git status --short
git pull --ff-only
```

파일 업데이트만으로 실행 중인 서버가 교체되지는 않음. 서버 코드 변경 후 적용 순서는 다음과 같음.

초안 보관 → 로컬 세션 지우기 → stop → start → open → QR 로그인

Windows의 이전 build7 서버 종료에는 `stop --legacy`, 이전 버전의 개인 설정을 옮길 때는 `migrate-preferences --source <폴더>` 사용.

## 테스트

설치 완료 후 실행. 테스트는 실제 계정 없이 모의 서버·임시 브라우저 프로필·임시 포트를 사용함.

```bash
python3 -m unittest discover -s tests            # Python
NODE=local-only/runtime/node-v24.21.0-darwin-x64/bin/node   # OS에 맞는 런타임 경로
$NODE --test --test-concurrency=1 tests/*.test.mjs          # Node
$NODE tests/reader-browser-smoke.mjs                        # 격리 Chrome 화면 검사
```

- Windows Node 경로: `local-only\runtime\node-v24.21.0-win-x64\node.exe`
- Linux 단계별 검증: `python3 tools/verify_linux.py --suite mock|platform|full`

### 최근 검증 결과

#### 2026-11-05 연결·사진·보안 보강

명시적으로 다른 방을 가리키는 이력 응답, 재접속 뒤 실행되는 지연 POST, 공유 사진 대기 구독자의 무제한 증가를 차단함. 사진 콜백 오류 후 큐 정지와 이전 방의 늦은 오류 안내도 수정. SDK·연결·500방 스냅샷·사진 취소 반복 검사 추가.

전체 Node 1,251개 통과·1개 건너뜀, Python 282개 통과·3개 건너뜀, 격리 Chrome 14모드·220조건 통과. 검사 전후 소스 167파일 동일 확인. 고정 의존성 두 묶음의 npm audit 등록 취약점은 0개이며, 전체 보안 결함 부재를 뜻하지 않음. 실제 계정·실행 서버 변경 없음. [보강 내용·검증·적용 범위](reports/HARDENING_20261105.ko.md) 참고.

#### 2026-11-02 전수조사 후속 수정

R2~R9 보완 완료. 상대방 읽음 상태의 처리 범위를 확인된 참여자 목록(roster)으로 제한하고, OCR·MinGit와 하네스 경로 보호, 구형 probe의 build8 명시 중단, 브라우저 환경·종료 판정·시험 기한 수정. Ponytail 5.3.3을 설치해 기존 코드 재사용과 공통화 적용.

전체 검사는 Node 1,210개 통과·1개 건너뜀, Python 282개 통과·3개 건너뜀. 이후 브라우저 탐색을 추가 교정한 최종본은 표적 검사 11개와 Chrome 14모드·220조건 통과. 전체 검사와 표적 검사의 실행 소스 구분은 [후속 수정 보고서](reports/OCR_REMEDIATION_20261102.ko.md) 및 [변경 파일 목록](reports/OCR_REMEDIATION_20261102_FILES.csv) 참고. 실제 서버·로그인 조작 없음.

#### 2026-11-02 설정 초기화·방 이름 조회 수정

설정 초기화 시 이전 요청을 파일 저장·메모리 반영 단계까지 무효화하도록 수정. 서버로 요청을 보내기 전에 취소된 방 이름 조회는 명시적 재선택 시 실행하도록 보완. 관련 Node 285개와 격리 Chrome 140조건 통과.

사진 취소 검사의 관측 정보도 보강했으나 과거 간헐 실패 원인은 미확인. 실제 계정 회귀와 서버 적용은 미실행. [수정 보고서](reports/FIXES_20261102.ko.md) 및 [Python/Rust 검토](reports/RUST_ASSESSMENT_20261102.ko.md) 참고.

<details>
<summary>이전 진단·검증 기록: 2026-11-02 ~ 2026-10-25</summary>

#### 2026-11-02 수정 전 진단

제품 수정 없이 설정 초기화 이후 지연된 읽음 설정 복원, 서버로 요청을 보내기 전에 취소된 방 이름 조회의 재선택 차단을 재현함. 완료 이력 응답 재주입 시 다른 방 이력으로 수용되는 조건부 문제도 확인했으나 실제 서버 발생 여부는 미확인.

Node 1,182개 통과·1개 건너뜀, Python 259개 통과·3개 건너뜀. 격리 Chrome은 UI 6/6·reader 131/131·네 탭 2/3으로 총 140조건 중 1개 실패. 취소 표식 실패 원인은 미확정이며 전체 통과로 판정하지 않음. 실제 계정·기존 서버·로그인 조작 없음. 원래 재현 조건·성능·죽은 코드 후보와 네 탭 사진 검사 2/3 실패 기록은 [수정 전 코드 진단](reports/DIAGNOSIS_20261102.ko.md) 참고.

#### 2026-10-26 같은 방 별칭 저장 순서 수정

취소 후 저장한 B를 늦은 A 요청이 덮는 P2 문제를 로컬 HTTP로 재현 후 수정. 방별 저장 순서를 파일 게시·메모리 적용까지 검사하고, 전체 개인 설정 초기화 후 이전 별칭이 복원되는 문제도 보완.

최종 Node 1,182개 통과·1개 건너뜀(64파일), 격리 Chrome 2프로그램·137조건 통과. Python은 재실행하지 않았으며, 앞선 진단의 임시 파일 정리 오류 3건은 해결 여부 미확인으로 유지. 서버·로그인 조작 없음. 서버 코드 적용에는 재시작·QR 승인 필요. 검사와 적용 범위는 [별칭 저장 순서 수정](reports/ALIAS_ORDER_FIX_20261026.ko.md) 참고.

#### 2026-10-26 Windows 개선

읽음 설정의 마지막 선택 보존, 누적 방 상태 교체, 이름 편집 응답 격리, 설정 완전 쓰기·Windows 파일 보호, 사진 취소·슬롯 회수, 방 선택 후 이력 우선 실행 구현.

최종 Node 1,152개 통과·1개 건너뜀(63파일), Python 259개 통과·3개 건너뜀, 격리 Chrome 8프로그램·163조건 통과. 앞선 Node 실패 8건·후속 fixture 실패 3건과 사진 계측 오류는 원본과 원인을 구분해 보존. 과거 manifest 대조의 SHA 불일치 40건도 별도 실패 기록으로 유지.

실제 서버·로그인 교체 없음. 실제 카카오 화면의 속도 개선 폭과 macOS/Linux 실행은 추가 확인 필요. [일곱 항목 개선 보고서](reports/IMPROVEMENTS_20261026.ko.md) 참고.

#### 2026-10-26 수정 전 진단: 부분 성공

Node 1,100개 통과·1개 건너뜀, Python 258개 통과·3개 건너뜀·오류 1건. Python 오류는 Windows의 `os.getuid()` 시험 모의 누락. 사진 Chrome 검사는 단일 탭 13/13·3탭 2/3이며, 전환 중 열린 로컬 사진 응답 4개가 겹친 검사 실패.

읽음 설정 OFF 유실·누적 500방 상태·이름 편집 경합·저장 경계도 합성 재현. 해당 진단 시점의 제품 수정과 실제 계정 속도 측정은 미실행. 재현 조건·개선 순서·측정 한계는 [로직·최적화·연결 지연 진단](reports/DIAGNOSIS_20261026.ko.md) 참고.

사용자가 확인한 지연 구간은 방 선택 후 메시지·사진 표시이며, 이를 후속 개선에 반영함. 초기 로그인·Windows 설정 준비 비용과는 구분.

#### 2026-10-25 다른 사용자용 안정화

Python 248개 통과·14개 건너뜀, Node 1,099개 통과·2개 건너뜀. 격리 Chrome 11프로그램과 추가 2모드의 최종 214조건 통과. Mac mock 실행·종료와 소스 ZIP의 manifest·추출 후 검사도 확인.

첫 브라우저 실패 2건과 후속 재검증, 실제 계정·다른 OS의 미실행 범위는 [안정화 보고서](reports/READINESS_20261025.ko.md) 참고. 당시 사용 중인 서버 교체 없음.

#### 2026-10-25 안정화 이전 심화 QA

| 검사 | 결과 |
| --- | --- |
| Python | 총 257개 중 243개 통과·14개 건너뜀·오류 0 |
| Node | 총 1,059개 중 1,057개 통과·2개 건너뜀·실패 0 |
| 격리 Chrome | 9프로그램·194조건 통과. `reader-browser-smoke.mjs` 131조건 포함 |

실제 임시 파일 저장·메모리 순환·Mac mock 시작·종료까지 확인. 검사 범위와 당시 실서버 연결 상태는 [심화 QA 보고서](reports/QA_20261025.ko.md) 참고.

사진 캐시·설정 대기열의 상한과 정리 보완. 합성 메모리 측정·회귀 결과는 [최적화 보고서](reports/OPTIMIZATION_20261025.ko.md) 참고. 최초 Mac 검증의 하네스 8종 성공과 두 탭 CDP timeout은 [검증 기록](reports/VALIDATION_HISTORY.ko.md)에 보존.

</details>

## 알려진 문제와 미검증 범위

### 2026-11-06 오픈채팅 답장 거절

1,000명 이상 오픈단체방의 답장 전송에서 -203 거절 사용자 관측. 최근 정제 진단은 답장 WRITE의 실제 거절과 일치하며, 코드의 src_linkId 누락과 원본 멘션·표시용 본문 사용을 확인함. 인원수 자체를 원인으로 확정할 근거는 없음. 정확한 거절 필드와 수정 후 도착은 미확인. 관련 합성 회귀 88개·요청 구조 12조합 통과는 실제 서버의 답장 수락 증거가 아님. [원인 조사·수정 방향](reports/OPENCHAT_REPLY_203_20261106.ko.md) 참고.

### 2026-11-05 보강 후 남은 범위

이력의 명시 방 충돌과 모호한 fallback 후보 선택은 차단했으나, 방 식별자가 전혀 없는 완료 응답의 재전달과 정상 번호 재사용은 구별 근거가 부족함. R1 전체 해결은 미확인. 여러 차례 반복한 합성 복구 검사는 실제 장시간 사용·인증 갱신·타 OS 검증을 대신하지 않음.

지연 POST의 연결 범위와 사진 대기 소비자 512개 제한은 보강 완료. 이 제한은 모든 HTTP 연결의 총상한이 아니며 캐시 적중에는 적용하지 않음. 과거 네 탭 사진 검사의 간헐 실패 원인은 이번 회귀 통과만으로 확정하지 않음. [남은 조건과 보안 점검 범위](reports/HARDENING_20261105.ko.md) 참고.

### 후속 수정의 범위

2026-11-02 전수조사에서 확인한 R2~R9는 수정 완료. 구형 사진·휴대폰 OFF probe는 build8 미지원 도구로 명시 중단하며, 일반 API 권한은 확대하지 않음. 당시 R1의 이력 재전달·번호 재사용 계약은 추가 확인이 필요해 wire 경로를 변경하지 않았음. 세부 검증 범위는 [후속 보고서](reports/OCR_REMEDIATION_20261102.ko.md) 참고.

같은 날 수정 전 전체 검수에서는 소스 198파일을 검토해 신규 P2 8건과 기존 조건부 이력 응답 문제 1건을 기록함. 당시 Node 1,198개 통과·1개 건너뜀, Python 259개 통과·3개 건너뜀이었으며, 브라우저 14회 중 3회와 과거 manifest 검증 실패. 해당 검수 단계의 제품 수정·실계정 검증은 미실행. 원래 재현·실패 기록은 [전체 검수 보고서](reports/OPEN_CODE_REVIEW_FULL_20261102.ko.md)에 보존.

11/02 수정 후에도 합성 재전달 이력 응답의 방 구분은 실제 서버 응답 계약 확인이 필요하며, 네 탭 사진 취소 표식의 과거 간헐 실패 원인도 미확인. 초기화·이름 조회 경합은 수정했으나 이전 방의 후속 이력 요청 중단과 Windows 설정 저장 비용 개선은 미구현. [수정·검증 범위](reports/FIXES_20261102.ko.md) 참고.

10/26 개선은 경합·저장·사진 취소 문제 수정 후 계정 없는 회귀 검사로 확인함. 사용 중인 서버에는 전체 재시작·새 입장·QR 승인 후 적용. 방 상태 500개·개인 설정 500개 방 제한과 초기 오픈방 메타데이터 조회 예산 6.5초 유지. Windows 보호 검사 증가에 따라 영구 저장 비용이 커질 수 있음. 실제 속도·장시간 사용·다른 OS 실행은 [개선 보고서](reports/IMPROVEMENTS_20261026.ko.md)의 미확인 범위.

### 운영 중 추가 확인 사항

| 항목 | 확인 결과 및 남은 문제 |
| --- | --- |
| 사진 수신 후 연결 종료 | 10/25 15:56 사진 묶음 2건 수신 후 발생한 실제 연결 종료는 당시 기록 부족으로 원인 미확정. 이후 재현한 비정상 치수 예외 방어, 이전 실패 진단 보존, 여러 탭의 사진 요청 제한 추가. 실제 사건의 원인 해결 여부는 미확인. [수정 전 조사](reports/PHOTO_BURST_DIAGNOSIS_20261025.ko.md)·[안정화 수정과 검증](reports/READINESS_20261025.ko.md) 참고 |
| macOS 브라우저 검사 | 최초 두 탭 동시 구간에서 CDP timeout 발생. 이후 진단·수정 후 전체 131조건은 통과했으나 과거 timeout 원인은 미확정 |
| 절전·네트워크 단절 | 연결 단절 확인. 재연결 후 지속 사용과 인증 갱신은 미검증 |
| 안 읽음 배지 | 일반 1:1 방 한 곳에서 모바일 읽음의 웹 반영 확인. 최초 실패 원인과 다른 조건은 미확인 |
| LOCO 사진 업로드 | 선택 옵션의 업로드 완료 응답 전 연결 단절. 기본 HTTPS 방식 정상 확인 |
| 프로토콜 버전 | 접속 프로필은 앱 26.1.2에 고정. 카카오 프로토콜 변경 시 동작 중단 가능 |
| 기능별 추가 검증 | 오픈채팅 사진·답장·읽음, 일부 방 제목, 장시간 사용, 사진 다운로드. 상세 결과는 [검증 기록](reports/VALIDATION_HISTORY.ko.md) 참고 |

## 관련 문서

- [연결·사진·보안 보강](reports/HARDENING_20261105.ko.md): 이력 식별·지연 요청·사진 자원 제한, 반복 복구 검사와 남은 R1
- [전수조사 후속 수정](reports/OCR_REMEDIATION_20261102.ko.md)·[변경 파일 목록](reports/OCR_REMEDIATION_20261102_FILES.csv): R2~R9 보완, Ponytail 적용, R1 잔여 계약 확인
- [Open Code Review 전체 코드 검수](reports/OPEN_CODE_REVIEW_FULL_20261102.ko.md): 소스 198파일·설정 등 22파일, 신규·기존 지적, 전체 회귀 결과
- [Open Code Review 설치·검수](reports/OPEN_CODE_REVIEW_20261102.ko.md): 프로젝트 로컬 CLI·스킬, 위임 모드 실행 방법, 검토 범위
- [설치·운영 안내](reports/USER_GUIDE.ko.md)
- [초기화·방 이름 조회 수정: 2026-11-02](reports/FIXES_20261102.ko.md): 설정 초기화 보호, 이름 조회 예약·시도 구분, 회귀와 적용 범위
- [Python과 Rust 적용 검토](reports/RUST_ASSESSMENT_20261102.ko.md): 현재 언어 구성, Windows 보조 프로그램 비교 후보
- [수정 전 코드 진단: 2026-11-02](reports/DIAGNOSIS_20261102.ko.md): 재현 조건·성능, 미확정 브라우저 실패
- [별칭 저장 순서 수정](reports/ALIAS_ORDER_FIX_20261026.ko.md): 같은 방 연속 편집·늦은 HTTP/파일 저장·전체 초기화 처리
- [일곱 항목 개선](reports/IMPROVEMENTS_20261026.ko.md): 읽음 설정·방 상태·이름 응답·저장·Windows 보호·사진 취소·방 전환 지연
- [로직·최적화·연결 지연 진단](reports/DIAGNOSIS_20261026.ko.md): Windows 추가 검사, 재현 조건, 연결 대기·설정·사진 개선 순서
- [다른 사용자용 안정화](reports/READINESS_20261025.ko.md): 수신 오류·사진 로딩·장애 기록·소스 패키지 보완과 검증
- [검증·개발 기록](reports/VALIDATION_HISTORY.ko.md): 날짜별 테스트 수치, 실계정 확인 결과, 미해결 항목
- [플랫폼 지원 안내](reports/PLATFORM_SUPPORT.ko.md): Windows/macOS/Linux/WSL 지원과 이식 기록
- [메모리·운영 최적화](reports/OPTIMIZATION_20261025.ko.md): 캐시·설정 대기열 상한, 측정과 적용 절차
- [최적화 후 심화 QA](reports/QA_20261025.ko.md): 전체 회귀·브라우저 9종·반복 메모리 검사와 당시 연결 상태
- [APK 분석 인계](reports/APK_HANDOFF.ko.md), [PC 분석](tools/pc_analysis/README.ko.md), [Android 추출](tools/apk_export/README.ko.md): 선택적 정적 분석
- [사진 전송 방식 비교 모델](experiments/photo-method-simulation/README.md)
- 개발 규칙: [AGENTS.md](AGENTS.md), [운영 규칙](.harness/OPERATING.md), [후속 계획](.harness/FOLLOWUP.md)
