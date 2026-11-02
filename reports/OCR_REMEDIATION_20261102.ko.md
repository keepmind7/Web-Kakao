# 전수조사 후속 수정 — 2026-11-02

판정은 **검증 성공: 신규 R2~R9의 합성·계정 없는 수정 범위**다. R1과 실제 계정 검증은 별도 미확인 상태로 남긴다.

[원래 전수조사 보고서](OPEN_CODE_REVIEW_FULL_20261102.ko.md)와 [220파일 검수 목록](OPEN_CODE_REVIEW_FULL_20261102_FILES.csv)을 기준으로 신규 지적 R2~R9를 수정했다. 기존 미커밋 변경과 원래 보고서·CSV·실패 기록을 보존했다. 현재 작업은 합성·계정 없는 로컬 검증이며, 기존 실행 서버·로그인·실제 계정은 조작하지 않았다. 커밋·push는 하지 않았다.

## 항목별 변경

| 항목 | 수정과 제한 | 검증 범위 |
| --- | --- | --- |
| R1 이력 응답 상관관계 | 이번에는 미수정. SDK와 실제 응답 계약 조사가 더 필요함 | 고정 SDK·실제 import 소스 대조, 실제 재전달·번호 재사용은 미실행 |
| R2 peer watermark 누적 | 검증된 roster 안의 peer만 저장. snapshot의 기존 100명 상한을 따르고, 미확인 peer는 정확한 미읽음 숫자를 표시하지 않음 | 20,000 peer 주입, 100명 경계·초과 roster, 단조 갱신·교체·본인 읽음 회귀 |
| R3 OCR·MinGit 설치 경로 | 기존 조상 경로 검사·독점 staging·원자적 no-replace 게시 재사용. ZIP은 검증한 일반 파일만 독점 생성 | 실제 합성 링크, 기존 파일·설치 폴더 보존, 늦은 게시 충돌, 비정상 ZIP |
| R4 구형 진단 도구 | build8 이상이면 일반 API·조회·발송 전에 미지원으로 명시 중단. 사진 probe의 계정 없는 PNG 생성 유지 | 가짜 client와 현재 정제 status로 차단 확인. 최신 build 실계정 probe를 복원한 것은 아님 |
| R5 하네스 junction 경계 | 경로 정규화 전에 lexical 조상의 symlink·reparse를 검사하고 접근 거부도 실패로 처리 | 실제 Windows 합성 junction과 `junction/../` 경로에서 외부 쓰기 차단 |
| R6 대소문자 소유권 충돌 | 실행 준비·plan 검증의 경로 겹침 비교를 공통 함수로 통합. Windows case 동등성과 POSIX case 구분 보존 | 미존재 파일·부모/자식 경로·실행 준비와 검증 일치, POSIX 규칙은 합성 주입 |
| R7 사용자 Chrome 탐색 | 원래 브라우저 환경으로 탐색하고, Windows 환경 사본의 키도 대소문자 무관하게 조회. 탐색 실패는 임시 프로필 생성 전 종료 | 사용자 설치 위치·대문자/혼합 키의 합성 탐색과 격리 브라우저 |
| R8 정리 후 성공 판정 | smoke는 cleanup 뒤 최종 결과 출력. 공통 판정으로 Chrome·서버·pending·정리 오류 반영 | 미종료·정리 오류 음성 조건과 각 fixture의 실제 종료 결과 |
| R9 접속 실패 시험 대기 | 오류 이벤트 대기에 1초 절대 기한, 해당 시험 전체에 5초 timeout 추가 | 기존 실제 SDK의 계정 없는 loopback 접속 오류 회귀 |

R3의 `--install`은 기존 버전 폴더를 덮어쓰지 않고 명시적으로 거절한다. 이미 설치된 CLI 실행은 유지된다. 실다운로드는 다시 하지 않았다. 경로 사전 검사가 동시 링크 교체까지 OS 수준에서 원자적으로 막는다고 주장하지 않는다.

R5/R6은 현재 `.agents/skills/harness/scripts/`와 보존된 `tools/vendor/codex_harness/skills/harness/scripts/`의 관련 세 파일에 적용했다. 기존 Windows 의존 경로 수정은 보존했다. 보존 vendor의 `source-manifest.json`과 `run_state.py.upstream`은 바꾸지 않았다. 현재 vendor 코드는 원래 manifest와 달라지는 로컬 패치이며 과거 해시 검사 성공으로 보고하지 않는다.

## Ponytail 적용

공식 [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)의 **5.3.3**을 사용자 Codex 플러그인으로 설치했고 `plugin list`에서 `installed=true`, `enabled=true`를 확인했다. 등록 소스의 확인 커밋은 `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`이다. 프로젝트의 AGENTS나 기존 하네스를 다른 내용으로 덮어쓰지 않았다.

설치된 `skills/ponytail/SKILL.md`를 직접 읽어 이번 수정에 적용했다. 기존 안전 다운로드·파일 게시를 재사용하고, 중복된 Chrome 시작 포트 읽기 12곳과 cleanup 판정을 공통 코드로 모았다. 하네스의 경로 겹침 비교도 준비·검증 양쪽에서 공유하며 사용하지 않는 import를 정리했다. 검증·보안·오류 처리·접근성을 삭제하는 압축이나 무관한 전체 재작성은 하지 않았다. 신규 비정상 경계에는 작은 회귀를 추가했다.

플러그인 설치와 현재 대화의 자동 lifecycle hook 활성화는 구분한다. 현재 세션은 지침을 직접 적용했으며 자동 훅 실행은 검증하지 않았다. 이 PowerShell 환경에서는 PATH의 `node`를 찾지 못했다. 향후 자동 훅을 쓰려면 Node가 있는 환경에서 Codex를 열고 훅을 확인·신뢰한 뒤 새 대화를 시작해야 한다. [원본 설치 안내](https://github.com/DietrichGebert/ponytail/blob/main/INSTALL.md)

이번 설치 명령은 `codex plugin marketplace add DietrichGebert/ponytail --json`, `codex plugin add ponytail@ponytail --json`이었다. 목록 조회는 원격 카탈로그 접근 경고가 있었지만 로컬 설치 항목과 활성 상태를 반환했다. 외부 OCR 모델 공급자·계정은 연결하지 않았다.

## 사진 검사 측정 보완

원래 사진 검사 실패와 수치는 그대로 보존한다. 제품 사진 코드는 이번에 바꾸지 않았다. 사진 작업의 동시 실행과 거절된 HTTP 재요청을 분리해 시험하며 전체 HTTP peak도 결과에 남긴다.

- 서버 응답을 요청 처리 전에 관측하고, 정확한 `photo_request_retired` 오류로 완료된 HTTP 409만 거절된 재요청으로 분류한다. 인증 종료 등 다른 409는 사진 작업 집계에 남긴다.
- CDP의 `ERR_EMPTY_RESPONSE`는 같은 합성 요청 ID의 취소 200 응답과 원본 GET 최소 하나의 존재·원본 모두의 종료를 확인해야 취소 증거로 인정한다. 닫힌 재요청만으로 원본 종료를 대신할 수 없다.
- 방 전환 뒤 새 사진 ID가 시작되지 않는 조건, 브라우저 monotonic·상류 동시 실행 상한 2, locks·상류 잔여 0은 유지한다. 재요청의 전체 HTTP 수가 늘었다는 이유만으로 새 사진 작업이 시작됐다고 판단하지 않는다.

독립 검수자는 최초 구현이 모든 409를 제외하는 오류를 지적했다. 전체 실행 전에 위 조건으로 교정하고 인증 종료 409·미종료 원본에 대한 음성 회귀를 추가했다. 첫 표적 10조건 결과를 교정본 결과로 확대하지 않았으며, 교정본의 표적은 11조건을 통과했다.

## 검증 결과

| 검사 | 실제 결과 | 범위 |
| --- | --- | --- |
| 전체 Node, revision2 | 총 1,211 중 1,210통과·1skip, 실패 0, 종료 0, 362.109초 | 마지막 Windows 브라우저 탐색 키 교정 전 |
| 전체 Python, revision2 | 총 285 중 282통과·3skip, 실패 0, 종료 0, 60.124초 | 이후 Python 소스 변경 없음 |
| 마지막 교정본 Node 표적, revision3 | 11/11, 종료 0 | 브라우저 helper·사진 측정·실제 SDK 접속 실패 회귀 |
| 마지막 교정본 구문 | MJS 18·Python 11 성공 | bytecode를 기록하지 않는 읽기 검증 |
| 최종 Chrome 14모드, revision3 | 220/220조건, 모든 종료 0 | 공통 브라우저 helper의 전체 소비자 |
| 실제 계정·다른 OS | 미실행 | 기존 서버·로그인·개인 프로필 조작 없음 |

전체 Node 이후 바뀐 것은 `tests/browser-platform.mjs`와 해당 unit 두 파일뿐이다. 전체 Node·Python은 다시 실행하지 않았고, 바뀐 경계의 표적과 Chrome 소비자로 재검증했다. 표적 11조건을 전체 통과 수에 더하지 않는다. Node의 1skip은 실제 POSIX 권한·hardlink, Python의 3skip은 Python3.9 미설치·macOS native rename·실제 POSIX 권한 조건이다.

첫 Chrome 14모드에서는 12모드·207조건이 통과하고 metadata-repair·own-read-sync 두 모드는 탐색 단계에서 실패했다. 두 실패는 조건 0·종료 1로 보존한다. Python 환경 사본의 `PROGRAMFILES`와 JavaScript 일반 객체의 `ProgramFiles` 조회가 맞지 않는 원인을 브라우저 실행 없이 재현했다. Windows에서만 키를 접어 새 객체로 조회하도록 공통 함수를 수정했고, 원래 환경을 그대로 사용해 최종 Chrome 검사를 진행한다. 환경값을 우회 변경해 통과시키지 않았다.

최종 Chrome 14모드는 reader 131, metadata 5, open-own 7, own-read 8, single-photo 13, multitab 3, QA feedback 15, review 6, storage 1, tab 10, UI 경계 6, write-rejection 11, 모듈 누락 1, four-tabs 3조건이다. 모두 실제 cleanup 판정이 성공했고 해당 자식의 원시 종료코드는 0이다. 브라우저 조건을 Node·Python 수에 더하지 않는다.

첫 실행과 최종 실행 모두 소스 29개·실행 관련 195개가 전후 일치했고 전용 Chrome 잔존은 0이었다. 원시 결과·193파일 해시 인계본은 제외 경로 `.harness/ocr-remediation-20261102/qa/revision2/`에 보존했다. revision3은 별도 폴더에 기록하며 원래 failed 장부를 성공으로 바꾸지 않는다. 최종 확인에서도 원래 193파일 해시가 같았다.

검수는 별도 읽기 전용 agent가 수행했다. 최종 소스 29개 지문 일치, 마지막 두 파일의 소비자 연결, 사진 분류 지적 해소를 확인했고 검토한 변경에서 추가 P1/P2를 발견하지 못했다. 나머지 27파일은 동일한 지문으로 앞선 검토를 재사용했다. 이 검수자는 테스트나 실제 계정 실험을 실행하지 않았다.

각 worker의 첫 표적 실행에는 sandbox `spawn EPERM` 또는 새 임시 폴더의 Windows 접근 거부가 있었다. 원래 오류를 보존하고 보호 검사를 약화하지 않은 채 승인된 계정 없는 실행으로 재검증했다. `.agents` 쓰기도 sandbox에서 거절돼, 부모가 일반 workspace 경로임을 확인한 뒤 해당 파일만 승격 적용했다. 전역 ACL·권한 모드는 바꾸지 않았다.

## 남은 조건과 적용

R1에서는 실제 import SDK와 고정 원본 `forge-protocol.ts`의 SHA-256 `2f07f4c8fb8fa16d4e4fdd2307b2ab2d26fc4a3ced83ebf33ce1c808754c9489`가 일치함을 확인했다. SDK는 exact ID 이후 method fallback을 사용하고, SYNCMSG 같은 필수 요청의 timeout은 socket을 닫는다. 정상 roomless 응답의 번호 재사용과 완료 응답 재전달을 구별할 관측 없이 완료 번호만 차단하면 정상 이력을 거절하고 연결을 끊을 수 있다. 제한된 완료 기록·방 scope 검사를 후보로 남겼으며 현재 wire 경로는 변경하지 않았다.

실제 계정·다른 OS·장시간 사용·전체 방 전환 지연 개선·Windows 권한 검사 비용 개선은 이번에 검증하지 않았다. 실제 상대방 읽음·사진 도착의 과거 검증 범위를 넓히지도 않는다.

실행 중인 서버에는 새 코드가 적용되지 않았다. 이번 제품 변경은 worker의 읽음 상태 관리이므로 적용하려면 작성 중인 글 보관 → 로컬 세션 정리 → 서버 종료·새 시작 → 새 입장·QR 승인이 필요하다. 기존 서버·로그인은 이 작업에서 유지했다. 명령은 [README](../README.md)의 실행·종료 안내를 따른다.
