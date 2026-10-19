# Web-Kakao

카카오톡 대화방을 이 PC의 브라우저에서 조회하고 메시지를 주고받는 **Windows용 로컬 웹 클라이언트**입니다. Node 서버가 카카오톡 서버와 통신하고, Chrome·Edge는 `http://127.0.0.1:8787`의 화면을 사용합니다.

QR 로그인, 일반 대화·답장·읽음, HTTPS 사진 발송의 사용자 확인 사례가 있습니다. 사진은 JPEG·PNG·WebP를 입력받아 JPEG로 변환합니다. 시험한 오픈채팅방의 텍스트 전송도 사용자 확인했습니다. 방 종류와 장시간 동작의 남은 확인 사항은 문서 하단의 **알려진 문제와 QA**에 정리했습니다.

## 실행 환경

| 구성 | 필요 조건 |
| --- | --- |
| OS | Windows x64 |
| Python | 3.11 이상. `py -3 --version`으로 확인 |
| Node.js | 준비 도구가 고정 버전 24.21.0을 프로젝트 안에 설치 |
| 브라우저 | Chrome 또는 Edge. 실행 도구는 외부 브라우저를 엽니다. |
| 휴대폰 | 카카오톡 QR 로그인과 연결 기기 승인에 사용 |
| 네트워크 | 최초 도구 준비와 실제 카카오톡 통신에 필요 |

Python 실행·준비 도구와 테스트는 표준 라이브러리를 사용합니다. [requirements.txt](requirements.txt)는 이 조건을 설명하며 추가 pip 패키지는 없습니다. Node 패키지는 저장소의 잠금 파일을 사용해 따로 준비합니다. Android APK·에뮬레이터·REA/JADX/Ghidra/ADB는 선택적 분석 도구이며 일반 웹 실행에는 필요하지 않습니다.

## 처음 설치하기

가능하면 `C:\src\web-kakao`처럼 짧은 경로를 사용하세요. Python Launcher가 없다면 같은 3.11 이상 실행기의 `python`으로 아래 `py -3`를 바꿉니다.

```powershell
git clone https://github.com/keepmind7/Web-Kakao.git web-kakao
cd web-kakao

py -3 -m pip install -r requirements.txt
py -3 tools/prepare_node_spike.py
py -3 tools/fetch_source_spike.py modern
py -3 tools/fetch_source_spike.py legacy
py -3 tools/prepare_spikes.py --install-dependencies

py -3 tools/local_web.py start --gap-probe --messaging
py -3 tools/local_web.py open --browser chrome
```

준비 도구는 고정 Node ZIP·공개 소스·npm 패키지의 버전/해시/무결성을 확인하고 `local-only/`에 보관합니다. `npm ci --ignore-scripts`를 사용하며 제3자 원본과 라이선스를 보존합니다. 회사 프록시 환경에서도 TLS 검증을 끄지 않습니다. `--help`는 다운로드나 로그인을 시작하지 않습니다.

## 평소 실행과 종료

프로젝트 루트에서 실행합니다. 사진 방식 옵션을 생략하면 **HTTPS**입니다.

```powershell
py -3 tools/local_web.py start --gap-probe --messaging
py -3 tools/local_web.py open --browser chrome
py -3 tools/local_web.py status
```

새로 열린 창에서 **QR 로그인 시작 → 휴대폰 승인 → 대화 서버 연결**을 진행하면 방 목록이 표시됩니다. Edge는 `open --browser edge`로 엽니다. 주소만 직접 입력한 기존 탭에는 접근 권한이 없을 수 있으므로 실행 도구로 연 탭을 사용하세요.

종료할 때는 작성 중인 내용을 보관하고 설정의 **로컬 세션 지우기**를 누른 뒤 실행합니다.

```powershell
py -3 tools/local_web.py stop
```

실행 도구는 서버 PID·실행 경로·로컬 인증을 확인하며, 인증이나 대화 연결이 활성 상태면 종료를 거절합니다. 로컬 세션 삭제·서버 종료는 카카오톡 계정의 원격 로그아웃과 다릅니다. 개인 Chrome이나 Node 전체를 강제 종료할 필요는 없습니다.

## 사용 방법과 연결 정책

- 대화방을 선택해 최근 메시지를 조회하고 텍스트·답장·사진을 보냅니다. 표시 캐시는 방당 최근 50개이며 계정 전체 과거 이력을 보관하는 프로그램은 아닙니다.
- 사진은 **＋ → 파일 선택** 또는 붙여넣기로 준비하고 미리보기에서 보냅니다. 원본은 20MiB·4천만 픽셀 이하, 최대 변4096픽셀·변환 결과10MiB 제한을 적용합니다. JPEG 변환 시 투명한 부분은 흰색이 됩니다. 동영상·파일·사진 묶음 전송은 포함하지 않습니다.
- 준비 실패 문구의 `[format]`, `[decode]`, `[encode]`, `[output-size]`는 실패 단계를 나타냅니다. 미리보기 성공과 실제 모바일 도착은 구분합니다.
- **대화 조회 시 카카오톡에도 읽음 알리기**는 기본 OFF입니다. ON이면 선택 방·전경·포커스·최신 메시지·하단 위치 조건을 확인합니다. 직접 문자·답장·사진을 보내면 조회 옵션과 별개로 해당 방의 읽음도 동기화합니다.
- 전송 결과가 불명확하면 자동 재전송하지 않습니다. 모바일에서 도착 여부를 확인한 뒤 경고를 정리합니다. 확인 버튼은 재발송 버튼이 아닙니다.
- 인증된 탭의 유지 연결이 하나라도 있으면 로컬 보관의 1시간 강제 종료를 적용하지 않습니다. 마지막 유지 연결이 닫힌 뒤 2분이면 대화 연결·인증·사진 캐시를 정리하며 로컬 서버는 남습니다. 절전·탭 중단에도 같은 유예를 적용하고 카카오 토큰 갱신은 보장하지 않습니다.
- 오픈채팅은 기존 참여 방의 종류·링크·본인 참여정보·권한이 확인된 기능만 허용합니다. 새 방에 자동 가입하지 않습니다.

## 사진 전송 방식

기본 경로는 **HTTPS 파일 업로드 → 기존 LOCO 대화 연결로 사진 메시지 등록**입니다. 브라우저가 접속하는 로컬 주소는 계속 HTTP이므로 nginx나 별도 로컬 인증서는 필요하지 않습니다.

| 항목 | `https` — 기본 | `loco` — 명시 선택 |
| --- | --- | --- |
| 파일 업로드 | HTTPS 파일 업로드 요청 | 채팅 서버에서 받은 주소의 별도 미디어 연결 |
| 입력 준비 | JPEG·PNG·WebP → JPEG | JPEG 또는 PNG; WebP는 PNG로 준비 |
| 사진 등록 | 업로드 경로를 기존 대화 연결에 등록 | 미디어 연결의 완료 응답으로 확인 |
| 현재 사용자 확인 | 작은 JPEG·PNG 5종·WebP 3종의 모바일 도착 | 현재 노트북에서 완료 응답 전 연결 종료 문제 잔존 |

서버·worker·대화 세션·실행 도구의 기본값은 모두 `https`입니다. 명시하려면 시작 명령에 `--photo-transport https`를 붙이며, 구 `https-experimental`은 호환 별칭입니다. `status`의 `photoTransport`로 현재 값을 확인합니다. 다른 모드의 서버가 이미 실행 중이면 `start`는 서버와 세션을 유지하고 변경을 거절합니다. 옵션만 바꿔 기존 서버가 교체되지는 않습니다.

기존 LOCO 경로는 세션 정리·종료 후 `--photo-transport loco`로 시작할 수 있습니다. 실패 후 방식 전환이나 재전송을 자동 수행하지 않습니다. HTTPS 성공이 기존 LOCO 연결 종료의 근본 원인까지 설명하는 것은 아닙니다.

## 프로그램 구조와 파일 구분

```text
Chrome / Edge
    ↕ loopback HTTP · 로컬 입장권 · 탭 유지 연결
Node 서버 (127.0.0.1:8787)
    ├─ QR 인증 · 개인 설정 · 사진 프록시
    └─ 대화 worker ↔ 카카오톡 서버
           └─ HTTPS 사진 업로드 / LOCO 대화 연결

Python 도구 → 환경 준비 · 서버 시작/상태/종료 · Windows 권한 확인
```

| 경로 | 용도 | Git 공유 |
| --- | --- | --- |
| `experiments/local-web/` | 실제 웹 UI, 서버, 프로토콜·사진·설정 모듈 | 포함 |
| `tests/` | 계정 없는 단위·통합·격리 브라우저 검사 | 포함 |
| `tools/`, `tools/locks/` | 실행·준비·분석 도구, 고정 npm 잠금 파일 | 포함 |
| `experiments/photo-method-simulation/`, 기타 실험 | 사진 방식 비교와 수동 조사 진입점 | 포함 |
| `ui/` | 보존한 UI 비교 시안 | 포함 |
| `AGENTS.md`, `.agents/skills/` | 프로젝트 역할·스킬 진입점 | 포함 |
| `.codex/config.toml`, `.codex/agents/*.toml` | 공유 가능한 프로젝트 설정·역할 | 선택 포함 |
| `.harness/OPERATING.md`, `.harness/FOLLOWUP.md` | 협업 규칙·최신 후속 계획 | 선택 포함 |
| `local-only/` | 런타임·의존성·소스 원본·샘플·로컬 압축 보관본 | 제외 |
| `docs/`, `evidence/`, `_workspace/`, 기타 `.harness/` | 비공개 조사·검증 근거·실행 기록 | 제외 |

Node 런타임과 `local-only/sources/`, `local-only/spikes/`는 현재 실행과 무결성 확인에 사용하므로 임의 삭제하지 마세요. `tools/vendor/codex_harness/`도 원본 manifest/라이선스 검증에 연결된 보존 자료입니다. 테스트 프로필·캐시는 사용 종료를 확인한 뒤 정리할 수 있으며, 압축 보관본은 `local-only/archives/`에 둡니다. 제품 파일과 실패 근거·샘플을 한꺼번에 지우는 `git clean -fdx`는 사용하지 마세요.

이 프로그램은 이 PC의 브라우저와 서버로 사용합니다. 공식 앱을 상시 실행하는 브리지·원격 공개 서비스·터널은 필요하지 않으며, 앱 실행에 Codex가 필요하지도 않습니다.

## 데이터와 개인 설정

인증·대화·사진은 서버 메모리 중심으로 처리합니다. 서버 재시작 후 새 QR 인증이 필요하며, 새로고침 전 작성 중인 글은 보관하세요.

실행 정보·로그·정제된 진단은 `%LOCALAPPDATA%\WebKakao\<설치별 해시>\web-auth`, 개인 설정은 같은 설치의 `preferences`에 보관합니다. 설치별 해시는 프로젝트 절대 경로로 계산하므로 프로젝트를 옮기면 저장 위치도 달라집니다.

**이 노트북에 개인 설정 저장**을 켜면 방 별칭·고정·알림·필터·읽음 옵션을 계정별로 저장합니다. 끄면 저장 파일을 지우고 현재 실행의 설정을 유지합니다. Windows 접근 권한을 검사하지만 파일 자체를 암호화하지는 않습니다. `identity.key`는 계정 식별용 HMAC 키입니다.

사진 프록시는 허용된 CDN, 사진당10MiB·동시4개·캐시 합계30MiB를 제한합니다. 파일 다운로드는 사용자 명시 동작으로 수행합니다. 입장권 URL·QR·확인번호·인증 토큰·실제 대화/사진·개인 설정·APK·분석 원본은 저장소에 추가하지 않습니다. `.gitignore`는 비공개 자료를 제외하고 공유할 하네스 정의만 허용합니다.

## 업데이트

```powershell
git status --short
git pull --ff-only
```

로컬 변경을 확인한 뒤 갱신하세요. 서버 모듈이 바뀌면 **초안 보관 → 로컬 세션 지우기 → stop → start → open → 새 QR 인증** 순서로 적용합니다. 소스 파일 갱신만으로 실행 중인 서버 모듈이 교체되지는 않습니다.

build7에서 처음 전환할 때만 `stop --legacy`를 사용합니다. 예전 `local-only/preferences/`를 가져오려면 모든 서버를 종료하고 새 저장소가 아직 없을 때 `py -3 tools/local_web.py migrate-preferences --source ".\local-only\preferences"`를 사용합니다. 원본은 보존되며 자동 이전하지 않습니다. 손상된 실행 정보나 점유 포트는 강제 삭제 대신 실제 프로세스를 확인하세요.

## 개발·검증

다음 검사는 실제 계정과 분리된 모의 서버·임시 Chrome 프로필·임시 포트를 사용합니다. Node·고정 소스·패키지는 설치 단계처럼 준비되어 있어야 합니다.

```powershell
py -3 -m unittest discover -s tests -v

$node = '.\local-only\runtime\node-v24.21.0-win-x64\node.exe'
$nodeTests = @(Get-ChildItem .\tests -Filter '*.test.mjs' | ForEach-Object { $_.FullName })
& $node --test @nodeTests
& $node tests/reader-browser-smoke.mjs
```

2026-10-19 기본 HTTPS 전환 소스의 합성 결과는 Node **748/748**, Python **130통과·1skip**(Python3.9 부재), Chrome **102조건 통과**입니다. QR·확인코드·세션 삭제·재인증/연결·텍스트/PNG 제출 두 순환과 별도 모의 실행 도구5조건을 확인했습니다. 후속 lifecycle8조건은102에 포함되는 부분집합이며 중복 합산하지 않습니다.

실제 사용자 확인에서는 기본 HTTPS 시작 뒤 QR/방 목록, 나와의 채팅 텍스트/작은PNG의 iPhone 도착, 두 번째 세션 삭제·새 QR/목록 복구를 확인했습니다. 별도로 PNG 5종과 WebP 3종의 모바일 수신 사례도 확인했습니다. 테스트 통과·서버 ACK와 실제 모바일 도착은 서로 다른 근거입니다.

[사진 방식 비교 모델](experiments/photo-method-simulation/README.md)은 계정 없는 비교 실험입니다. `tools/verify_artifacts.py`는 비공개 manifest가 있는 작업 복사본용이며 새 clone의 일반 실행 필수 단계는 아닙니다. 개발 하네스는 [AGENTS.md](AGENTS.md), [운영 규칙](.harness/OPERATING.md), [후속 계획](.harness/FOLLOWUP.md)을 따릅니다. 선택적 분석은 [PC 분석](tools/pc_analysis/README.ko.md)과 [Android 추출](tools/apk_export/README.ko.md)을 참고하세요.

## 알려진 문제와 QA

아래의 사용자 확인은 시험한 사례의 결과입니다. 모든 방·권한·네트워크·장시간 사용으로 확대하지 않습니다. 이 프로그램은 카카오톡 공식 클라이언트가 아니며 일반 대화 연결은 공식 공개 메시지 API를 사용한 정식 연동이 아닙니다.

| 항목 | 현재 확인 / 남은 QA |
| --- | --- |
| HTTPS 사진 | 작은 JPEG·PNG 5종·WebP 3종의 웹 전송·모바일 도착 확인. WebP는 작은·투명·8.122MiB **원본**까지 iPhone에서 열기 확인. 실제 업로드는 JPEG이며 방 종류별·연속/중복·재접속 후 전송은 추가 QA |
| 기본 실행·QR·세션 삭제 | 기본 명령 재시작, 세션 삭제/새QR/목록 복구 두 차례 확인. 환경별 설치·장시간 인증은 추가 QA |
| 선택적 LOCO 사진 | 현재 노트북에서 완료 응답 전 미디어 연결 종료가 남음. 근본 원인은 미확정 |
| 오픈채팅 | 시험한 방의 텍스트 전송 사용자 확인. 다른 종류·권한·수신 기기 표시, 사진·답장·읽음은 개별 QA |
| 방 제목·참여자 | 일부 실제 방 이름은 미확인. 로컬 별칭과 원격 제목을 구분해 비교 필요 |
| 안 읽음·새 방 목록 | 로그인 직후 누락/중복 집계, 새로 활성화된 방의 자동 표시 재확인 필요 |
| 읽음·발송 후 본인 배지 | 일반 읽음 성공 사례가 있으나 상대방1 해제·본인 모바일 배지를 조건별 재확인 필요 |
| 사진 다운로드 | 합성 통과. 실제 파일 형식·저장 결과는 별도 QA |
| 장시간·절전·네트워크 복구 | 실제1시간 초과·절전·탭 중단·재연결 QA가 남음. 마지막 탭 유지 연결 종료2분 뒤 인증 정리는 설계된 동작 |
| Chrome 실행 | 샌드박스 실행 중0x80000003 사례는 일반 Windows 사용자 권한으로 재실행해 정상 표시 확인. 저수준 원인은 미확정 |
| VS Code 내부 브라우저 | 외부 Chrome/Edge 사용. 통합 브라우저 입장권 전달은 미지원이며 Simple Browser iframe 차단도 있음 |
| 설치·보안 | 넓은 작업 폴더 쓰기 권한은 `tools/workspace_acl.ps1`로 감사. 실제 ACL 변경·개인자료 이전은 자동 수행하지 않음 |
| 다른 환경 | macOS/Linux·Windows32비트·EXE/MSI 배포·모든 회사망은 미검증. 선택적 Ghidra helper는 점이 없는 분석 작업 경로 필요 |

실제 QA는 동의한 상대나 본인 시험방에서 대상·내용·횟수·영향을 정한 뒤 진행합니다. 이전 승인을 재사용하지 않습니다. 읽음은 **상대방 화면의 같은 메시지1 해제**, 사진은 **실제 수신 기기의 도착·열기**로 판정합니다. HTTP202·status0·업로드 완료만으로 통과시키거나 결과 불명 전송을 반복하지 않습니다.
