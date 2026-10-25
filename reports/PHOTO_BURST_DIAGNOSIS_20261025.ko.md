# 사진 다량 수신 시 연결 문제 원인 조사 — 2026-10-25

이 문서는 수정 전 조사 기록입니다. 이후 사용자용 안정화 수정·새 검증·적용 절차는 [안정화 보고서](READINESS_20261025.ko.md)를 따릅니다. 아래 소스 행번호와 재현 기대값은 조사 당시 기준이며, 과거15:56 사건의 원인 미확정 판정은 유지합니다.

**부분 성공: 사용자가 보고한 15:56 KST·사진 묶음 2건 수신 후 대화 연결 종료의 실제 원인은 미확정입니다.** 정상 두 묶음은 합성 프로세스 검사에서 연결이 유지됐고, 특정 비정상 치수 값은 전체 연결을 종료시켰습니다. 별도로 확인한 브라우저 HTTP 지연은 이 사건의 원인으로 판정하지 않습니다. 이번 조사는 제품 코드를 변경하지 않았습니다.

## 사용자 확인 이후의 재조사: 15:56 대화 연결 종료

사용자는 증상을 ‘대화 서버 연결이 끊겼다는 표시’, 발생 시각을 오늘15:56, 수신 형태를 사진 묶음2건으로 확인했습니다. 묶음 안의 사진 수는 확인되지 않았습니다. 이를 2026-10-25 15:56 KST 사건으로 대조했습니다.

현재 UI의 가까운 문구인 ‘대화 연결 종료’는 인증 정보가 남은 상태에서 `reader.phase=disconnected`일 때 나옵니다. ‘연결이 종료됐습니다’ 안내는 실패 단계와 상태를 함께 표시합니다. 반면 HTTP 기한 초과는 ‘로컬 서버에 연결할 수 없습니다’를 표시하며 reader를 종료하지 않습니다. 따라서 앞선 약6초 HTTP 지연만으로 이번 대화 연결 종료를 설명할 수 없습니다. 정확한 당시 화면의 단계·상태는 확보하지 못했습니다.

근거: [연결 종료 UI](../experiments/local-web/app.js#L551), [HTTP 실패 UI](../experiments/local-web/app.js#L882), [manager 종료 처리](../experiments/local-web/reader-manager.mjs#L195).

### 실제 기록으로 확인할 수 있는 범위

- 현재 `reader-diagnostic.json`은18:02:45 KST에 시작한 새 worker의 기록입니다. 새 worker는 같은 파일을 덮어쓰고 최근40개 이벤트만 유지합니다. 실제 저장 폴더에서도 이전 진단의 회전 보관본을 찾지 못했습니다. 기존 정제 QA 기록의17:02:41 transport 실패도15:56과 다른 시점이므로 이 사건의 증거로 합치지 않습니다.
- 부모가 worker를 시작할 때 stdout/stderr를 버리고, exit callback은 종료 코드·signal을 저장하지 않습니다. 예외·강제 종료·프로토콜 오류의 원인을 사후 구분할 정보가 부족합니다. 현재 서버 stderr 파일도0바이트이며 이것만으로 worker 오류가 없었다고 판단할 수 없습니다.
- macOS15:46~16:06 KST 기록에서15:49:11 Wake를 확인했습니다. 선택한 Node crash 보고서는0건이고 제한한 시스템 로그에서 Node 종료·OOM의 양성 근거는 얻지 못했습니다. 주변 kernel `memorystatus` 항목 자체는 Node OOM 증거가 아닙니다. 이 조회의 부재로 네트워크 변화·절전·메모리 문제를 배제하지도 않습니다.
- 20:03:43 KST의 read-only status는 인증 유지·대화 연결 활성·attempts=3, 최신 진단은20:03:14 PING status0이었습니다. 이는 현재 세션의 정상 관측이며 과거15:56의 실패 원인을 복원하지 않습니다.

근거: [단일 진단 파일과 rolling event](../experiments/local-web/reader-diagnostics.mjs#L64), [worker stdio/exit](../experiments/local-web/reader-manager.mjs#L186). 진단·OS 원본은 공개 보고서에 옮기지 않았습니다.

### 두 묶음을 실제 child IPC로 통과시킨 합성 검사

기존 메모리 대조를 보완해 실제 manager→별도 child IPC→제품 worker 본문→실제 session/guard/고정 SDK parser를 실행했습니다. 인증·소켓·DNS·진단 디스크 쓰기는 합성 대역이며, 실제 계정이나 CDN 이미지 바이트를 사용하지 않았습니다.

| 조건 | 결과 |
| --- | --- |
| 정상 사진 묶음2건, 각30장 | 60장 메타데이터 처리·연결 유지·pending0 |
| 긴 URL의 사진 묶음2건, attachment 각각 약52KiB | 60장 처리·연결 유지·pending0 |
| 두 번째 attachment의 깨진 JSON / 65,536문자 상한 초과 | 해당 사진 메타데이터 제외·연결 유지 |
| 두 번째 묶음의 특정 비정상 치수 | `decode` 실패·대화 연결 종료 재현 |
| 두 묶음 뒤 주입한 소켓 오류 | `transport` 실패·연결 종료 |
| 진행 중인 이력 요청과 같은 request ID의 사진 push | 정상 처리·이력 응답 이후 pending0·연결 유지 |
| 사진은 정상 수신하되 이력 응답 누락 | 약10초 뒤 `history` 실패·연결 종료 |

비정상 치수의 구체 조건은 `wl[0]={valueOf:0,toString:0}`인 JSON입니다. [photoAttachments](../experiments/local-web/photos.mjs#L21)의 `Number(...)`가 TypeError를 일으키고, [수신 처리 catch](../experiments/local-web/reader-session.mjs#L327)가 `decode` 실패로 전체 세션을 종료합니다. **합성 적대 입력에서 확인한 견고성 문제이며, 실제 카카오 사진이 이런 형식이었다는 근거는 없습니다.** 정상 사진2건에 대한 개수 제한이나 일반 형식 호환 문제를 입증한 결과도 아닙니다.

정상 두 조건의 표본 worker heapUsed는 약12.0/13.4MB, RSS는 약70.9/73.1MB였고 IPC `send()`의 backpressure 반환은0회였습니다. 단기·빈 캐시 조건의 표본이므로 장시간 사용·기존 캐시·실제 순간 최대 메모리를 나타내지 않습니다. `--max-old-space-size=128`은 V8 old-space 설정이며 worker 전체 RSS128MiB 제한이 아닙니다. [고정 런타임 Node 문서](https://nodejs.org/download/release/v24.21.0/docs/api/cli.html#--max-old-space-sizesize-in-mib)

manager 자체의8개 상태 매핑 검사에서는 child exit code0·4·SIGKILL이 모두 `disconnected/disconnected/null`로 합쳐졌습니다. session이 실패 IPC를 먼저 보내면 `decode`·`transport` 등의 단계는 유지됩니다. 이 검사는 가짜 child 이벤트를 사용했으며 실제 프로세스 사망의 재현과 구분합니다.

### 이번 사건에 대한 판정과 수정 우선순위

실제 원인은 **미확정**, 정상 두 묶음의 단기 합성과 위 오류별 경로 검사는 **검증 성공**입니다. 사진을 두 묶음 받았다는 사실만으로 메모리 부족·서버 차단·프레임 크기 제한·앞선 HTTP 지연 중 하나를 원인으로 선택할 근거는 없습니다.

실제 연결 종료 조사의 다음 변경 대상은 부모의 worker 종료 코드/signal·실패 단계 보존, decode 경로의 정제 예외 종류, 개수·용량 제한이 있는 세션별 정제 진단입니다. raw stderr·대화·URL·heap dump를 수집할 필요는 없습니다. 별도로 재현한 치수 변환 예외는 잘못된 사진 메타데이터가 전체 세션을 종료하지 않도록 보완할 대상입니다. 아래 브라우저 사진 큐는 독립적인 표시 성능 수정 대상입니다. 세 항목 모두 이번 조사에서 구현하거나 실서버에 적용하지 않았습니다.

새 근거는 Git 제외 경로 `evidence/photo-disconnect-1556-20261025/`에 보관합니다. backend8조건과 manager8조건은 exit0이고 부모도 출력 파일명만 분리한 복사본으로 각각 재실행해 exit0·동일 상태 분류를 확인했습니다. backend의 소유 child8개는 모두 종료됐습니다. 대조한 제품 파일28개는 이전 QA 지문과 일치합니다. 최초 backend 실행의 VM Buffer 주입 누락과 manager 실행의 수동 종료 status 기대값 오류는 fixture 오류로 보존하고 각각1회 교정했습니다. 실제 계정 조작·재연결·서버 재시작은 수행하지 않았습니다.

## 별도로 재현한 브라우저 지연 원인

사진 표시와 상태 조회가 같은 로컬 HTTP/1.1 origin을 사용합니다. 앱은 각 사진에 `/api/photo`를 지정하며 브라우저 측 명시적 사진 요청 큐는 없습니다. 서버의 동시4개 제한은 CDN fetch의 제한이고, 사진 응답을 기다리는 브라우저 요청까지4개로 제한하는 기능은 아닙니다.

느린 사진 요청이 쌓이면 브라우저의 `/api/status`도 HTTP 전송 전에 기다리는 현상을 확인했습니다. 이때 서버 자체 처리와 독립 Node 클라이언트의 상태 조회는 빨랐고, 브라우저 heartbeat는 진행했습니다. 이번 조건에서는 서버 다운이나 화면 메인 스레드 정지보다 **브라우저 HTTP 요청 경합**을 지연 원인으로 판단할 근거가 있습니다.

근거 위치: [사진 DOM 생성](../experiments/local-web/app.js#L674), [사진 HTTP 처리](../experiments/local-web/server.mjs#L108), [서버 사진 큐](../experiments/local-web/photos.mjs#L98), [상태 조회 기한](../experiments/local-web/app.js#L42).

## Chrome 대조 실험

실제 app/server에 합성 auth·reader·1×1 PNG fetcher를 주입했습니다. 사진 수와 응답 지연만 바꾸고 매 조건마다 새 프로필·새 포트를 사용했습니다. CDP 요청/응답 시각, 서버 요청 도착/완료 시각, 별도 Node status와 UI 상태를 함께 기록했습니다.

| 화면 사진 수 | 사진 fetch 지연 | 실제 사진 요청 | status의 서버 도착 전 최대 대기 |
| ---: | ---: | ---: | ---: |
| 0 | 0초 | 0 | 0ms |
| 12 | 즉시 | 11 | 0ms |
| 3 | 8초 | 3 | 0ms |
| 12 | 8초 | 11 | 5,991ms |
| 40 | 8초 | 11 | 6,049ms |

느린 두 조건의 해당 status 서버 처리는0~1ms, 별도 Node status는최대1ms였습니다. Chrome 자체 timing의 `sendStart`도 약6,000ms여서 서버 수신 전 대기와 일치합니다. 12/40장 모두 lazy loading 때문에 실제 요청은11개였습니다. 40개가 한꺼번에 다운로드됐다고 해석하지 않습니다.

지연 순간에는 미완료 사진 HTTP6개와 presence SSE1개가 별도로 관측됐습니다. 따라서 ‘SSE1개+사진5개로 무조건6개 슬롯이 찬다’는 단순 가설은 입증하지 않았습니다. 이 실험이 입증한 것은 사진 수·지연에 따른 브라우저 API 큐잉입니다.

5조건 모두 UI는 `fresh`, 주입된 reader는 `connected`, 브라우저 heartbeat는 진행했습니다. **12초 timeout·UI unavailable·실제 reader 단절은 이 Chrome 실험에서 재현하지 못했습니다.** 사진 지연8초는 기본 fetchPhoto 총기한8초의 경계에 맞춘 주입 조건이며 실제 CDN/DNS/HTTPS를 호출한 검사는 아닙니다. reader 상태도 합성 주입값이므로 실제 프로토콜 연결의 무단절 증명으로 쓰지 않습니다.

5조건 전부 Chrome 종료·프로필 프로세스0·서버 종료·pending0·임시 프로필 삭제를 확인했습니다. 최초 최소 환경에서는 `/launch` 이동이 막혀 제품 시나리오에 진입하지 못했습니다. 해당 도구 오류와 정리를 보존하고, 기존 통과 하네스와 같은 상속 환경·전용 프로필로 재실행했습니다.

## 연결 오류처럼 보이는 UI 경로

일반 로컬 API의 전체 기한은12초입니다. `localRequest()`가 이를 넘기면 `freshness=unavailable`을 설정하고 `refresh()`는 ‘로컬 서버에 연결할 수 없습니다’ 문구를 표시합니다. [renderComposer](../experiments/local-web/app.js#L217)는 이 상태에서 입력을 막습니다. 이 경로는 `reader.disconnect()`를 호출하지 않습니다.

실제 localRequest/refresh 본문을 실행한 VM 검사에서도12초 타이머 콜백을 발화하면 unavailable·오류 문구가 되고 disconnect 요청은0임을 확인했습니다. 이는 보류한 fetch·가짜 타이머·DOM/렌더링 대역을 사용한 경로 검사이며, 사진 때문에 실제12초를 넘겼다는 증거나 전체 화면 검증은 아닙니다. Chrome의8초 사진 대조에서는 실제12초 초과가 발생하지 않았습니다.

## 실서버와 진단 관측

18:11:20 KST의 안전한 read-only status는 authenticated·credentialInMemory=true·chatConnectionActive=true·attempts=3이었습니다. 이전 QA의17:02 단절 기록과 다른 새 세션입니다. 새 reader는18:02:45에 시작했고, 정제 진단의 이후 약8분 동안 PING 응답 status0이 이어졌습니다. 기록된 SYNCMSG63건도 처리됐지만 진단은 사진 개수를 저장하지 않으므로 이를 사진63장으로 해석할 수 없습니다.

18:26:42 KST의 마지막 read-only 확인도 인증 유지·대화 연결 활성·attempts=3이었습니다. 최신 진단은18:26:15 PING 응답 status0이고 종료 사유 필드는 없었습니다. 해당 관측 시점에는 실제 대화 연결이 살아 있었습니다.

부모 서버 RSS는 그 시점 약97MiB·가동17시간45분인 단일 표본입니다. 이 수치는 과거 순간 최대값이나 Chrome의 디코딩 메모리를 나타내지 않습니다. 선택한 시각 주변의 OS power 기록에서는 매칭 Sleep/Wake 항목을 얻지 못했으며, 이것만으로 절전을 배제하지 않습니다. 실제 로그인·읽음·전송·재연결·사용 중 서버 조작은 하지 않았습니다.

## 실제 연결 종료의 다른 후보와 반증

실제 고정 SDK+guard+session/store를 사용하는 계정 없는 메모리 대조12개도 실행했습니다.

| 후보 | 확인한 결과 | 이번 사용자 증상과의 연결 |
| --- | --- | --- |
| 연결 초기 push 과다 | LOGINLIST 전 push200개는 성공, 201개는 loginlist 단계 거절. 텍스트와 사진 모두 동일. 같은201개를 연결 후 받으면 성공 | 초기 연결 실패에만 적용. 실제 초기 push>200·해당 실패 단계 근거가 있어야 원인으로 판정 가능 |
| 연결 후 정상 사진 burst | 일반/단일 사진/30장 묶음 각100개를 처리하고 PING 성공. pending·parser buffer0, 단절0 | 이 제한된 합성 부하에서는 사진 수만으로 단절되지 않음. 실제 IPC 적체·지속 부하까지 검증한 것은 아님 |
| 메타데이터 반복 전송 비용 | 사진30장 묶음100메시지의 약455KB wire가 전체 캐시 스냅샷 반복으로 약19.97MB emit JSON이 됨 | 비용 증폭은 확인. 실제 IPC 적체·OOM·연결 종료는 미재현 |
| SDK 큰 암호화 블록 | 같은 약224KB SYNCMSG는64KiB 블록 분할 시 정상, 하나의 큰 블록이면 parser 거절 | 큰 사진 묶음 자체의 고정 크기 제한으로 단정 불가. 실제 fatal frame·exit4·블록 길이 근거 필요 |

관찰된 수신 경로에서는 worker가 사진 URL/크기 메타데이터를 다루고 이미지 바이트는 부모의 CDN 프록시가 받습니다. 사진 fetch 실패가 직접 worker를 종료하는 경로는 확인하지 못했습니다.

## 이전 QA에서 빠졌던 조건

종합 브라우저 QA의 수신 사진은 즉시 반환하는 작은 GIF 한 종류였습니다. 이미지 재사용·확대·다운로드 검사는 있었지만, 느린 CDN 다중 사진과 상태 API의 경쟁은 포함하지 않았습니다. 이번 조사는 그 공백을5개 대조군으로 확인한 것이며, 이전 통과 수치를 사진 burst 안정성 증거로 확대하지 않습니다.

## 수정 대상과 남은 확인

확인된 병목의 우선 수정 대상은 **브라우저 사진 로딩 큐**입니다. 동시에 보내는 사진 요청을 제한해 제어 API가 기다리지 않도록 하고, 방 전환·계정 종료 때 이전 사진 요청을 취소하는 방향이 타당합니다. 서버 캐시 용량이나 heartbeat/API timeout 수치만 늘려서는 이번 브라우저 큐잉 원인을 제거하지 못합니다. 실제 구현·수정 후 성능 대조는 이번 원인 조사에 포함하지 않았습니다.

원본 이미지의 디코딩 메모리·실제 사진 HTTP 오류·로그인 시점 실패가 별도로 있었다면 추가 증거가 필요합니다. 현재 로컬 진단은 사진 다운로드별 대기/실패 원인을 보관하지 않습니다. 이후 사용자 확인으로15:56의 대화 연결 종료 표시라는 점은 알게 됐으며, 그 사건의 재조사와 판정은 문서 상단을 따릅니다.

## 로컬 재현 자료

모든 근거는 Git 제외 경로 `evidence/photo-burst-20261025/`에 정제해 보관합니다. 실제 대화·개인 원본 이미지·토큰·CDN URL은 보고서에 넣지 않았습니다.

```bash
qa_node=local-only/runtime/node-v24.21.0-darwin-x64/bin/node
$qa_node evidence/photo-burst-20261025/browser-burst.mjs
$qa_node evidence/photo-burst-20261025/browser-burst.mjs --few-slow
$qa_node --max-old-space-size=128 evidence/photo-burst-20261025/backend-repro.mjs
$qa_node evidence/photo-burst-20261025/frontend-deadline.mjs
```

브라우저2실행5조건·backend12대조·VM 경로 검사는 exit0입니다. 부모도 backend12대조와 VM을 출력 파일명만 분리해 재실행했고 exit0을 확인했습니다. 새 패키지 설치·공개 제품/테스트 수정·commit·push는 수행하지 않았습니다.
