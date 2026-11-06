# 연결·사진·보안 보강 — 2026-11-05

판정: 확인된 결함 수정과 합성·계정 없는 로컬 회귀는 **검증 성공**. 전체 이력 응답 식별 문제(R1)는 **부분 성공**이며, 방 식별자가 전혀 없는 재전달과 정상 응답 번호 재사용의 구분은 미확인으로 유지함.

기준 커밋은 `1d3bf8589167b07d95ad847a3e3ca0c9b66d03b8`. Windows x64, 고정 Node 24.21.0, Python 및 별도 임시 프로필의 Chrome에서 검사함. 실제 카카오 계정·기존 실행 서버·개인 브라우저 프로필·공식 앱 사용 없음. 커밋·push 미실행.

## 수정 내용

| 구분 | 수정 전 문제 | 적용 내용 |
| --- | --- | --- |
| 이력 응답 식별 | SYNCMSG/MCHATLOGS의 exact ID 또는 첫 method fallback이 명시적으로 다른 방의 응답을 완료할 수 있음. 매칭되지 않은 이력 오류가 push로 처리되어 연결을 종료할 수도 있음 | pending 요청별 허용 방 집합을 보관하고 명시 방 필드의 충돌을 검사. fallback은 적합한 후보가 하나일 때만 허용하고, 미상관 이력은 push로 전달하지 않음 |
| 재접속과 지연 POST | 같은 reader의 attempts가 바뀌어도 늦게 도착한 본문이 새 연결에서 조회·발송·읽음·설정 작업을 실행할 수 있음 | 요청 도착 시 reader 참조·attempts·instanceId를 스칼라로 고정하고 본문 수신·비동기 처리 후 재검사. 헤더를 생략한 정상 운영자 요청도 같은 연결에서만 허용 |
| 공유 사진 소비자 | 동일 URL의 구독자는 URL별 pending 40개 제한과 별개로 무제한 증가 가능 | 캐시 전체 pending 소비자를 512개로 제한. 취소·완료·실패·clear 시 접수 용량 반환. 기존 upstream 4개·pending URL 40개 제한 유지 |
| 사진 큐 정지 | 이미지 load/error 콜백 예외가 후속 큐 처리를 건너뜀 | 기존 예외 전달과 자원 정리를 유지하면서 finally에서 다음 작업 접수 수행 |
| 이전 방의 오류 안내 | 방 전환 후 과거 사진 취소 실패가 현재 방의 오류 안내를 변경할 수 있음 | 현재 epoch에 속한 실패만 화면에 알림. 이전 작업의 잠금 해제와 제한 시간 내 정리는 계속 수행 |

제품 변경은 `reader-protocol.mjs`, `server.mjs`, `photos.mjs`, `photo-loader.js`의 네 파일에 한정. 새 의존성·외부 서비스·공개 포트·실제 발송 경로 추가 없음.

## 이력 식별 계약과 남은 R1

[공개 SDK의 고정 커밋](https://github.com/tyeom/kakao-cli/tree/8dbbd4f7ed6b42542982252250622fa351af00e9) `8dbbd4f7ed6b42542982252250622fa351af00e9`의 `src/kakao/forge-protocol.ts`와 실제 import 사본을 대조함. 원시 SHA-256은 `2f07f4c8fb8fa16d4e4fdd2307b2ab2d26fc4a3ced83ebf33ce1c808754c9489`로 기존 기록과 일치함. SDK는 exact packet ID 다음에 동일 method fallback을 사용하며, 필수 요청의 timeout은 소켓을 닫는 구조.

새 검사는 body·chatInfo·실제 소비하는 log의 `chatId`, `roomId`, `chatRoomId`, `chatInfo.id`를 요청 범위와 비교함. `reader-data.mjs`가 log의 `c`도 방 ID로 소비하므로 log에 한해서 `c`를 검사함. top-level `body.c`는 건수일 수 있어 방 ID로 취급하지 않음. signed int64 ID를 Number로 변환하지 않고 비교함.

단일 후보의 roomless fallback과 정상 응답 번호 재사용은 유지함. 완료 번호나 내용 지문만 일괄 차단하면 정상 이력도 거부할 수 있으므로 해당 차단은 추가하지 않음. 모든 방 식별자가 빠진 응답의 재전달은 새 요청과 구별할 근거가 부족함. 같은 방의 동일한 응답도 정상 재조회와 이전 응답 재전달을 구별한 것은 아님. 이번 수정은 명시적 방 충돌과 후보 모호성의 보강이며, R1 전체 해결이나 실제 카카오 서버 계약 검증을 뜻하지 않음. 기존 [전수조사 후속 보고서](OCR_REMEDIATION_20261102.ko.md)의 미확인 범위와 구분 필요.

## 검증 결과

| 검사 | 결과 | 범위 |
| --- | --- | --- |
| 전체 Node | 총 1,252개: 1,251개 통과·1개 건너뜀·실패/취소 0, 종료 0 | 기존 검사와 신규 이력·보안·사진·반복 복구 검사 포함 |
| 전체 Python | 총 285개: 282개 통과·3개 건너뜀, 종료 0 | 실행 도구·파일 보호·플랫폼·소스 패키지 기존 회귀 |
| 격리 Chrome | 14모드·220조건 통과, 모든 종료 0 | reader 131, metadata 5, open-own 7, own-read 8, photo 13, 3탭 3, 4탭 3, feedback 15, review 6, storage 1, tab-session 10, UI 경계 6, write-rejection 11, 모듈 누락 1 |
| 소스 불변 | 검사 전후 167파일의 SHA-256 동일 | 제품·시험·실행 관련 소스. 보고서와 비공개 실행 기록은 제외 |
| 시험 정리 | 모드별 Chrome 종료 관측, 시험 서버 종료, pending 0 확인 | 결과에 포함된 서버 배열·잔존 프로필 프로세스·정리 오류도 대조 |
| 의존성 DB 대조 | modern·legacy 잠금 파일 모두 npm audit 등록 취약점 0 | 2026-11-05 공식 npm registry 응답. 설치·업데이트·스크립트 실행 없음 |
| 독립 검수 | 검토한 변경에서 추가 P1/P2 미발견 | 부모와 별도 protocol/security/QA 역할이 교차 검토. 외부 침투검사는 아님 |

Node의 건너뜀 1개는 실제 POSIX 권한·hardlink 검사. Python의 건너뜀 3개는 Python 3.9 부재, macOS native rename, 실제 POSIX 파일 권한 조건임. 건너뜀은 통과 수에 포함하지 않음. 표적 검사와 반복 검사 수는 전체 Node에 포함되므로 합산하지 않음.

보안 표적 22개는 12종 account POST의 지연 본문, 헤더 생략·reader 교체·재사용 snapshot 객체, 소비자 512개 상한, 취소·실패·clear 후 용량 회수, 실제 로컬 HTTP 소비자 512개와 초과 거절을 확인함. Host·Origin·Sec-Fetch-Site·세션·CSRF·본문 크기·사진 capability·비공개 DNS 주소·외부 리다이렉트 차단도 대조함. 정상 후속 요청이 계속 동작하는 조건을 함께 검사함.

## 반복 복구 검사

- 고정 SDK와 임시 loopback: optional metadata 만료·늦은 응답 16회, required timeout 뒤 재접속 4회. 최종 소켓·pending 0개 및 listener 종료 확인
- manager: 500방 스냅샷 교체·조회 중 단절·구 worker의 늦은 응답과 exit를 24회 반복. 새 연결의 방·이력·읽음 토큰 격리와 종료 기록 8시도 상한 확인
- 사진 캐시: epoch 24회·upstream 120개, abort를 무시하는 전송과 늦은 같은 URL 성공을 포함. 실제 동시 upstream 최대 4개·최종 0개, 새 캐시 불오염 확인
- 사진 화면 큐: 두 탭의 취소 확인·늦은 load 콜백·잠금 해제를 24회 반복. 각 회 종료 시 held/pending 잠금과 시험 타이머 0개 확인

위 검사는 수초~수십 초의 제한된 반복 회귀임. 수시간 연속 사용, 절전·실제 네트워크 전환, 실제 heap 누수 부재의 증거로 확대하지 않음.

## 재현 및 실패 기록

수정 전 이력 응답의 다른 방 완료·모호한 후보 선택, 지연 POST의 새 연결 실행, 공유 사진 상한 부재, 사진 콜백 예외 후 큐 정지를 합성으로 재현함. 원래 실패와 수정 후 결과는 `.harness/hardening-20261105/`의 역할별 폴더에 분리 보존하며 Git에서 제외함.

초기 Node 실행의 spawn EPERM, 보안 fixture의 import/Host 구성 오류와 동시 연결 체크포인트 timeout은 제품 결함과 구분함. fixture는 실제 Host 헤더와 OS 연결 backlog를 고려하도록 교정했으며, 최종 512개 동시 pending 및 513번째 거절 조건은 유지함. 최종 전체 Node는 일반 격리 runner로 실행함. 브라우저 결과 수집기의 하위 폴더 경로와 npm notice가 섞인 출력 파싱도 교정했으며 제품 코드나 원래 결과를 바꾸지 않음.

전체 Node에서 64건의 영구 설정 저장 검사가 약 109초 후 통과함. Windows 파일 보호 검사 비용에 해당하며, 성능 개선이나 해당 검사의 생략을 이번 결과에 포함하지 않음.

실행 명령:

```powershell
$tests = @(Get-ChildItem tests -Filter '*.test.mjs' | Sort-Object Name | ForEach-Object { $_.FullName })
.\local-only\runtime\node-v24.21.0-win-x64\node.exe --test --test-concurrency=1 --test-timeout=120000 --test-reporter=tap @tests
py -3 -B -X utf8 -m unittest discover -s tests -v
```

브라우저 검사는 `tests/*browser*.mjs`의 개별 fixture와 `photo-loading-multitab-browser.mjs --four-tabs`, `photo-loading-browser.mjs --missing-module`을 순차 실행함. 모드별 출력은 시험 프로세스의 `WEB_KAKAO_QA_OUTPUT_ROOT`로 분리. 정확한 실행 인자·원시 출력·소스 지문·집계는 비공개 `validation/`에 보존함.

## 적용과 제한

실행 중인 서버와 로그인은 유지함. 수정 적용에는 초안 보관 → 로컬 세션 지우기 → 서버 종료·새 시작 → 새 입장·QR 승인이 필요하며 이번 작업에서 수행하지 않음.

사진 512개 상한은 pending 구독자에만 적용함. 캐시 적중·모든 HTTP 연결의 총상한을 보장하지 않으며 초과 응답은 기존 photo_busy 처리에 따른 HTTP 502임. 일반 실행의 기본 사진 전송 방식은 HTTPS로 유지.

실제 카카오 서버 인증·사진 도착·상대방 읽음 `1`, 오픈채팅의 여러 권한 조건, 실제 네트워크 복구·장시간 사용·다른 OS의 이번 수정본 검증은 미실행. npm audit 결과는 조회 당시 등록된 의존성 취약점만 대조한 결과이며 런타임·코드·운영 환경 전체의 취약점 부재를 보증하지 않음.
