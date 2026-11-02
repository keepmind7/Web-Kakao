# 전체 코드 검수 — Open Code Review · 2026-11-02

**검수·보고서 작성은 완료했으며, 코드 품질과 실행 검증의 종합 판정은 부분 성공이다.** 저장소의 소스 **198파일·30,063행**을 전부 검토했고, 설정·잠금 파일·라이선스 등 22파일도 확인했다. 생략한 소스는 없다. 신규 P2 지적 8건과 기존 조건부 P2 1건을 정리했다. 검토 범위에서 확정한 critical/high 지적은 없다.

전체 Node는 **1,198통과·1skip**, Python은 **259통과·3skip**이었다. 격리 브라우저 14회 중 11회는 종료 0, 3회는 종료 1이었다. 사진 단언 3개가 실패했고 별도 저장 성능 fixture는 시작 중 `EBUSY`로 검사에 진입하지 못했다. 과거 해시 검증 기록도 불일치 40건으로 실패했다. 이 결과들을 통과로 바꾸거나 과거 기록을 갱신하지 않았다.

## 범위와 검수 방법

대상은 검수 시작 시점의 Git 추적 파일과 `.gitignore`에 제외되지 않은 신규 파일이다. 기존 미커밋 변경을 포함한다. 제품, 준비·실행·분석 도구, 실험, UI 시안, 모든 테스트, 현재 하네스와 보존된 과거 하네스 코드까지 포함했다. `.py.upstream`도 별도 소스로 읽었다. Git에서 제외하는 런타임·node_modules·내려받은 외부 SDK·APK·인증·실제 대화·개인 설정·과거 실행 산출물은 소스 감사 대상에서 제외했다. 의존성의 취약점 DB 조사나 외부 SDK 전체 소스 감사는 수행하지 않았다.

[Alibaba Open Code Review](https://github.com/alibaba/open-code-review) v1.13.3과 프로젝트 전용 Git 2.56.0.windows.4를 사용했다. **전체 파일 preview + 공식 위임 모드**로 수행했다. OCR이 파일과 규칙을 제공하고, 부모와 읽기 전용 검수자 3명이 실제 본문·호출자·소비자를 검토했다. 별도 LLM 공급자를 연결한 `ocr scan` 모델 실행은 하지 않았다.

```powershell
py -X utf8 tools/open_code_review.py scan --preview --format json --audience agent --output local-only/reviews/ocr-full-20261102/scan-preview.json
py -X utf8 tools/open_code_review.py delegate rule --format json <배정 파일 목록>
```

기본 preview는 총 271파일 중 188파일을 선정했다. 그중 소스는 168개였고, Python 테스트·과거 vendor 코드·CMD 등 소스 30개는 기본 필터로 제외됐다. 이 30개도 명시적으로 규칙을 조회하고 본문을 검토해 최종 소스 범위를 198개로 맞췄다. 설정 등은 기본 선정 20개에 requirements와 과거 source manifest를 더한 22개다. 기본 제외를 검토 완료로 취급하지 않았다.

| 담당 범위 | 소스 | 추가 설정 등 | 확인 방식 |
| --- | ---: | ---: | --- |
| 백엔드·프로토콜·상태 | 26 | 0 | 전체 본문, 인증·신원·취소·실패·응답 상관관계 |
| 도구·실험·Python 테스트·하네스 | 81 | 13 | 전체 본문, 현재/과거 복사본 별도 대조 |
| Node 테스트·브라우저 fixture | 80 | 0 | 전체 본문, 단언·환경·자원 정리·실제 성공과 합성 성공 구분 |
| UI·시안·공통 데이터 | 11 | 9 | 전체 소스 본문, DOM 연결, 잠금 JSON 구조·패키지 출처, 라이선스 동등성 |
| 합계 | **198** | **22** | 소스 `reviewed=198, skipped=0, coverage_rate=100%` |

파일별 경로·행 수·검수 담당·원시 SHA-256·OCR 기본 선정 여부는 [전체 검수 목록 CSV](OPEN_CODE_REVIEW_FULL_20261102_FILES.csv)에 있다. 검수와 회귀 후 220파일의 해시가 시작 시점과 동일함을 확인했다. 검수율은 본문 검토의 범위이며 모든 실행 경로나 분기를 검증했다는 뜻은 아니다. 생성된 잠금 데이터는 구조와 각 패키지의 version/resolved/integrity 존재를 검사했으며 의존 패키지의 소스를 검토했다고 계산하지 않았다.

## 지적 사항

모두 medium/P2다. 조건이 필요한 항목에는 그 조건과 실제 확인한 증거 수준을 함께 적었다. 이번 요청에서는 제품·테스트·도구 코드를 수정하지 않았다.

### R1 · 기존 조건부 문제 · 다른 방 이력 응답의 재수용

위치: [reader-protocol.mjs:161](../experiments/local-web/reader-protocol.mjs#L161), `reader-session.mjs:421–425`, `reader-data.mjs:563–574`.

A방 SYNCMSG를 완료한 후 B방 이력이 대기할 때 A의 완료 응답을 다시 주입하면, packetId가 달라도 method fallback으로 B 요청이 해소된다. 개별 로그에 room ID가 없으면 A의 합성 로그가 B store에 들어간다. 현재 소스로 다시 실행해 **다른 방 로그 1개 수용**, `requireRoomId:true` 대조에서는 **0개 수용**을 확인했다.

실제 서버의 재전달·packetId 재사용과 실제 방 혼합은 미확인이다. 기존 [D3 진단](DIAGNOSIS_20261102.ko.md)의 잔존 문제이며 신규 회귀로 집계하지 않는다. 정상 roomless 이력을 일괄 거부하기 전에 응답 계약을 확인하고, 완료 응답 재수용 방지와 요청별 상관관계를 함께 설계해야 한다.

### R2 · 신규 · peer 읽음 watermark가 상한 없이 남음

위치: `experiments/local-web/reader-data.mjs:524–525`.

`readUpdate()`는 roster에 없거나 roster가 확인되지 않은 사용자도 `room.watermarks`에 추가한다. 추가 상한·퇴거가 없다. roster를 열지 않은 방에서는 정리할 snapshot 교체도 일어나지 않는다. 100명 초과 roster를 거절하는 별도 경로도 정적으로 확인했다.

실제 store에 서로 다른 합성 peer **20,000개를 주입했고 20,000개가 유지**됐다. 기존 peer를 갱신해도 이전 항목은 남았다. Map 계측과 GC를 포함한 이 실행의 heap 증가 관측은 **1,468,144바이트**였다. 실제 트래픽 빈도, 일반 운영의 메모리 증가량, worker 128MiB 제한 도달 시점이나 실제 장애는 측정하지 않았다. 실행 probe는 roster 미설정 조건이며, 100명 초과 snapshot 거절 자체를 실행한 검사는 아니다.

검증된 roster에 필요한 정보만 유지하거나, 상한·퇴거·불완전 상태를 명시하는 방식이 필요하다. 기존 room·message 캐시의 상한만으로 이 Map은 제한되지 않는다.

### R3 · 신규 · OCR 설치기가 기존 임시 경로 링크를 따라 씀

위치: `tools/open_code_review.py:58–63`.

직전 설치 차수에 추가한 도구도 검수 대상에 포함했다. `--install`은 고정 이름 `ocr.download`를 `write_bytes()`로 열며 부모 경로의 링크도 검사하지 않는다. 해당 임시 파일이 다른 파일의 symlink이거나 설치 경로가 다른 폴더로 연결돼 있으면 관계없는 파일에 쓸 수 있다. 공개 릴리스 체크섬 검증은 이 경로 문제를 막지 않는다.

실제 `install()`과 실제 symlink를 사용하고 다운로드만 합성 데이터로 주입했다. **다른 전용 합성 폴더의 sentinel 덮어쓰기를 재현**했다. 네트워크·사용자 파일은 사용하지 않았다. 기존 링크가 있어야 하는 조건부 로컬 파일 문제이며, 원격 공격이나 이번 실제 설치에서 사용자 파일이 손상됐다는 증거는 아니다.

기존 `safe_download.py`의 조상 경로 검사와 독점 staging을 재사용하고 충돌 파일을 보존하는 방향이 맞다. MinGit 경로에도 같은 설치 경계 원칙을 적용해야 한다.

### R4 · 신규 · 이전 진단 도구가 build8 인증 계약과 맞지 않음

위치: `experiments/photo_upload_probe.py:60`, `experiments/phone_off_observe.py:46`, `tools/local_web.py:152–155`, `local-access.mjs:2–3`.

현재 `connect()`는 `X-Local-Control` client와 정제된 `/api/local/status`를 반환한다. 이 상태에는 reader·csrf·requests가 없다. 사진 probe는 reader guard에서 중단되고, 휴대폰 OFF 도구는 같은 client로 일반 `/api/status`를 호출해 403을 받는다. 기존 사진 테스트는 구형 reader/csrf가 있는 상태와 client를 통째로 모의해 이 불일치를 놓친다.

계정 없는 임시 서버에서 **control 헤더만 있는 `/api/status` 요청이 403 `local_session_required`**인 것을 확인했다. 인증됐다는 합성 snapshot을 정제해도 reader·csrf가 빠지는 것도 확인했다. 실제 진단 명령의 실계정 관측·사진 발송은 하지 않았다.

현재 제품의 일반 사용과 별개인 실험 도구 문제다. 명시적 진단 세션 획득을 설계하거나 과거 도구임을 분명히 처리해야 한다. 일반 API에 control 권한을 넓혀 해결하면 안 된다.

### R5 · 신규 · 하네스 쓰기 경계가 Windows junction을 통과함

위치: `.agents/skills/harness/scripts/common.py:14`, `:46–69`; 과거 vendor 사본도 같은 검사다.

`safe_path()`가 `is_symlink()`만 검사한다. Windows junction은 `is_symlink=False`여서 통과한다. 전용 합성 프로젝트의 `.codex/agents`를 다른 합성 폴더로 향하는 junction으로 만든 뒤 실제 `safe_path()`와 `apply_files()`를 호출했다. **합성 프로젝트 밖에 역할 파일이 생성됨을 재현**했다.

실제 프로젝트 설정은 바꾸지 않았고 실제 agent를 생성하지 않았다. 제품의 네트워크 인증 문제와는 별개다. lexical 조상 경로의 junction/reparse 검사로 경계를 보완해야 하며 현재본과 보존 vendor의 적용 범위를 구분해야 한다.

### R6 · 신규 · Windows에서 새 파일의 대소문자 소유권 충돌 누락

위치: `.agents/skills/harness/scripts/run_state.py:46–54`, `validate.py:161`; 과거 vendor에도 같은 비교가 있다.

미존재 `src/New.py`와 `src/new.py`를 정규화한 뒤 대소문자를 구분하는 문자열로 비교한다. 실제 Windows 합성 폴더에서 생성 전 `_project_overlap()`은 **False**, 파일 생성 후 두 경로의 `samefile()`은 **True**였다. 같은 물리 파일에 대한 배타 소유권 충돌 판정이 빠지는 조건이다.

실제 두 agent를 동시에 실행하거나 충돌 쓰기를 일으킨 검사는 아니다. 확인한 결함은 충돌 판정의 실패다. 실제 플랫폼의 경로 동등성을 반영해야 한다.

### R7 · 신규 · 사용자별 Chrome 설치 위치 누락

위치: `tests/metadata-repair-browser.mjs:17`, `tests/own-read-sync-browser.mjs:21`.

두 fixture는 `LOCALAPPDATA`를 임시 폴더로 바꾼 뒤 기본 `process.env`를 읽는 `testBrowser()`를 호출한다. 원래 환경을 담은 `browserEnvironment`는 spawn에만 넘긴다. 따라서 시스템 설치 없이 사용자별 Chrome만 있는 Windows에서는 설치된 브라우저를 찾지 못한다.

가짜 실행 파일 경로만 만든 합성 검사에서 원래 환경에서는 발견되고 교체 후에는 누락됨을 확인했다. 실제 브라우저 실행은 하지 않은 탐색 검사다. `testBrowser({env:browserEnvironment})`로 연결하고 시작 전 실패도 임시 자원 정리에 포함해야 한다.

### R8 · 신규 · 일부 브라우저 fixture의 성공 판정이 종료 확인보다 앞섬

위치: `tests/reader-browser-smoke.mjs:1293,1298–1300`; 같은 패턴이 metadata-repair·open-own-member·qa-feedback·review-fixes·storage-performance·tab-session·ui-state-boundaries·write-rejection fixture에도 있다.

smoke는 cleanup 전에 `passed:true`를 출력한다. 여러 fixture는 `chromeExitObserved=false`를 실패 조건에 넣지 않는다. 기능 단언 통과와 브라우저 종료 미확인이 함께 기록될 수 있다. 살아 있는 child handle 때문에 실행 자체가 계속 걸릴 수도 있으므로, 브라우저가 살아 있는데 즉시 exit 0이 된다고 단정하지 않는다.

이번 14회 실행에서는 모든 정리 기록의 Chrome 종료가 관측됐다. 따라서 이번에 잔존 브라우저를 재현했다는 지적이 아니라 **종료 실패가 생겼을 때 판정에 반영하지 못하는 정적 결함**이다. 최종 성공은 cleanup 뒤 계산하고 생성한 자원의 종료 미확인도 실패로 처리해야 한다.

### R9 · 신규 · 접속 오류 테스트의 대기가 무기한

위치: `tests/connect-failure.test.mjs:19`.

`while(!errors) await sleep(2)`에 자체 기한이 없다. 접속 promise는 거절되지만 error 이벤트가 오지 않는 회귀라면, 검증하려는 실패가 assertion 대신 무기한 대기로 바뀐다. 해당 테스트에 별도 timeout도 없다.

이번 정상 회귀 실행에서는 통과했으며 오류 이벤트 억제의 별도 실행 재현은 하지 않았다. 대기 자체의 절대 기한과 테스트 timeout이 필요하다. 이번 전체 실행기는 별도 1,500초 상한을 뒀지만 저장소의 테스트 자체를 고친 것은 아니다.

## 실행 결과와 실패 해석

| 검사 | 실제 결과 | 판정 |
| --- | --- | --- |
| 전체 Node 65파일 | 총 1,199: 1,198통과·1skip, 실패·취소 0, 종료 0, 477.234초 | 검증 성공(해당 범위) |
| 전체 Python | 총 262: 259통과·3skip, 실패·오류 0, 종료 0, 94.778초 | 검증 성공(해당 범위) |
| Chrome 12프로그램 + 사진 추가 2모드 | 14회: 11회 종료 0·3회 종료 1. 219조건 중 216통과·3실패, 별도 fixture 시작 오류 1회 | 부분 성공 |
| 별도 경계 probe | D3·watermark·OCR 링크·하네스 junction/경로 비교·control API·브라우저 탐색 확인 | 결함 재현 또는 계약 확인 |
| DOM·잠금 데이터·라이선스 | literal DOM ID 누락/중복 0, 두 lock의 패키지 출처·integrity 존재, LICENSE 원본 일치 | 검사 범위 통과 |
| 과거 artifact 검증 | 문서 33·링크 147·해시 76검사, SHA 불일치 40, 종료 1 | 실패·기록 보존 |
| 현재 소스·설정 지문 | 220파일 시작/종료 일치 | 검수 중 변경 없음 |
| 실계정·상대방 읽음·실제 사진 도착·다른 OS | 미실행 | 미실행 |

Node의 skip 1개는 native POSIX 권한 검사다. Python skip 3개는 Python 3.9 미설치, macOS native rename, native POSIX 권한 검사다. 표의 시간은 시험 출력의 시간이며 부모 실행기의 시작·종료 오버헤드와 구분한다. 검사 수는 이번 실행만 집계했으며 이전 보고서의 통과 수를 더하지 않았다.

### 브라우저 실행별 결과

| 프로그램·모드 | 조건 결과 | 종료 |
| --- | --- | ---: |
| metadata-repair | 5/5 | 0 |
| open-own-member | 7/7 | 0 |
| own-read-sync | 8/8 | 0 |
| photo-loading 기본 | **11/13** | **1** |
| photo-loading-multitab 기본 3탭 | 3/3 | 0 |
| qa-feedback | 15/15 | 0 |
| reader-browser-smoke | 131/131 | 0 |
| review-fixes | 6/6 | 0 |
| storage-performance | **0조건, DevToolsActivePort 읽기 EBUSY** | **1** |
| tab-session | 10/10 | 0 |
| ui-state-boundaries | 6/6 | 0 |
| write-rejection | 11/11 | 0 |
| photo-loading 모듈 누락 | 1/1 | 0 |
| photo-loading-multitab 4탭 | **2/3** | **1** |

**단일 탭 사진:** 방 전환 후 GET가 2→3으로 늘어난 것은 새 queued 사진이 아니라 기존 사진의 추가 요청이었다. 최초 두 CDP Image는 취소됐다. pagehide에서는 두 서버 응답이 취소 요청 직후 닫혔지만 한 CDP 항목이 `ERR_EMPTY_RESPONSE/canceled=false`로 끝났다. 자료에 request ID·응답 status가 없어 그 추가 GET를 409라고 확정할 수 없다. 두 실패를 제품의 취소 누락으로 확정할 근거는 부족하며, 실패한 블록 뒤의 미실행 단언도 통과로 계산하지 않는다.

**네 탭 사진:** 전체 서버 응답 최대 3이라는 단언이 실패했다. 고유 사진 ID는 8개였고 추가 GET 3건은 동일 ID의 **즉시 409 재요청**이었다. 409를 제외한 서버 구간 최대는 2, 브라우저 monotonic 최대와 상류 작업 최대도 각각 2였다. 최초 8건은 모두 취소·close됐고 상류 잔여는 0이었다. 전체 HTTP 응답 수와 실제 사진 작업 수를 구분하는 단언 보완이 필요하지만, 원래 peak 3과 실패는 유지한다. 밀리초 단위 기록이라 최대 3을 만든 정확한 순간 순서까지는 복원하지 못했다.

**저장 성능:** Chrome의 DevTools 파일을 읽던 중 `EBUSY`가 나 기능 조건에 진입하지 못했다. 이번 결과로 저장 성능이나 제품 오류를 판정할 수 없다. 통과를 얻기 위한 반복 실행은 하지 않았다.

모든 실행은 주입 전송 계층·합성 데이터·임시 loopback 포트·새 Chrome 프로필을 사용했다. 14회 정리 기록에서 Chrome 부모 종료와 fixture 서버 종료가 관측됐으며, 기록된 pending 정리 조건도 실패가 없었다. 일부 시험은 종료된 합성 프로필을 증거 폴더에 남기는 설계다. 사용자 브라우저·기존 서버·계정은 조작하지 않았다. 후손 프로세스 전부의 OS 수준 잔여 개수를 별도로 측정했다고 주장하지 않는다.

### 과거 manifest 실패

`tools/verify_artifacts.py`가 고르는 기존 `evidence/` 단계 manifest 및 vendor manifest를 현재 파일에 대조해 해시 불일치 40건을 반환했다. 이를 현재 파일의 변조 증거나 이번 검수의 코드 변경으로 해석할 수는 없다. 시작 시점의 별도 소스 지문 220개는 끝까지 동일했다. 과거 manifest는 갱신·덮어쓰지 않았으며 기존 검증 기록의 기준과 최신 소스의 차이를 보존했다.

## 우선순위와 후속 검증

1. **설치·하네스 경로 보호(R3/R5/R6):** 실제 파일 손상과 배타 소유권에 관련되므로 작은 합성 회귀와 함께 먼저 보완할 수 있다.
2. **이력 신원(R1):** 정상 응답 계약을 확인한 뒤 완료 응답 재수용 방지와 correlation 회귀를 설계한다. 실제 계정 검증은 대상·횟수·영향을 설명한 별도 승인이 필요하다.
3. **읽음 상태 상한(R2):** roster 미확인·큰 방·장시간 peer 교체 조건에서도 제한된 상태와 정확한 partial 표시가 유지되도록 검증한다.
4. **시험 신뢰성(R7–R9)과 이번 브라우저 실패:** 환경 복원, 종료 판정, 대기 기한, 요청별 status·취소 ACK·close 계측을 보완한다. 원래 실패 산출물은 유지한다.
5. **실험 도구(R4):** 현재 지원 범위를 정하고 실제 계정 없이 인증 계약 통합 검사를 추가한다.

기존 방 전환의 후속 이력 대기와 Windows 권한 검사 비용은 이번에도 남은 성능 검토 사항이다. 이번 감사가 메시지·사진 표시 속도를 개선했다는 측정은 없다. REA Python timeout만 보고 Java 잔존을 단정했던 후보는 owner-close Job Object 경로를 확인한 뒤 철회했다.

실제 명령·종료코드·OCR 규칙·파일 지문·원래 실패·합성 probe는 Git 제외 경로 `local-only/reviews/ocr-full-20261102/`에 보존한다. 읽기 작업의 인계는 `.harness/runs/ocr-full-20261102/`에 있다. 읽기 검토 장부의 완료는 QA 전체 통과와 구분한다. 실제 로그인·기기 변경·읽음·발송·공식 앱 실행·commit·push는 하지 않았다.
