# apps-in-toss-harness 심층 분석

작성일: 2026-10-23 (Asia/Seoul)

## 1. 분석 대상과 결론

대상은 [toss/apps-in-toss-harness][repo]이며, 분석 기준은 커밋 [`255b636812d8b3a9b048d0a700644b9cbd8532c4`][commit]이다. 원본에 대한 설명과 새 제품을 위한 설계 제안을 분리한다.

이 저장소의 강점은 **도메인 작업 절차를 공통 스킬로 관리하고 여러 에이전트 도구에 배포하며, 디버깅 도구와 검증·릴리즈 절차를 연결하는 구조**다. 에이전트가 특정 제품 개발을 일관된 순서로 수행하도록 돕는다.

사용자가 구상한 제품은 카카오톡으로 작업을 접수하고 여러 기기·프로젝트·에이전트의 실행과 상태를 관리하는 하네스다. 원본의 배포·스킬·관측·검증 패턴을 참고하되, 명령 접수·영속 작업 장부·에이전트 세션 관리·권한·작업 대시보드는 새 제품의 공통 실행기로 설계해야 한다.

## 2. 조사 방법과 판정 범위

| 구분 | 이번에 확인한 내용 | 한계 |
| --- | --- | --- |
| 공개 문서 | 루트 README, 운영 문서, 선별 스킬·패키지 설명 | 작성자의 과거 실측을 재현한 것은 아님 |
| 매니페스트 | 패키지·플러그인·워크스페이스·CI·릴리즈 구성 | 선언이 런타임 성공을 보장하지 않음 |
| 구현 코드 | 상태 기록·진행 알림·연결·수명·프로토콜·검증기 등 표적 코드 | 전 파일·분기 보안 감사가 아님 |
| 테스트 코드 | 구조·릴리즈 게이트·도구 주입·소비자 호환 검사 설계 | 이번에 테스트를 실행하지 않음 |
| 원격 CI | 기준 커밋의 CI 완료·success 기록 조회 | Ubuntu CI이며 로컬 또는 세 OS 실동작 검증이 아님 |
| 실제 설치·계정 | 미실행 | 플러그인 설치, OAuth, 도구 실행, 카카오 계정 접근 없음 |

원격 CI 근거는 [해당 실행 기록][ci-run]이다. 공개 Releases API 조회와 웹 목록에서 일치하는 최신 배포 목록을 확정하지 못했으므로, 이 문서는 최신 tarball의 가용성·해시·설치 성공을 새로 확인했다고 주장하지 않는다. 소스의 버전 선언과 실제 배포물 확인은 별도 항목이다.

원본의 일부 로드맵·운영 문서·평가 인프라는 공개 트리에서 제외돼 있다. 특히 `.gitignore`와 `CLAUDE.md`에 maintainer-local 자료로 명시된 평가는 clone만으로 모두 재현할 수 없다. [제외 규칙][ignore] [공개 운영 설명][claude]

## 3. 저장소의 책임 분리

| 구성 | 기준 버전 | 주된 책임 | 새 제품에 가져올 관점 |
| --- | --- | --- | --- |
| `packages/agent-plugin` | 0.2.6 | 스킬·명령·MCP 연결을 에이전트 도구에 배포 | 공유 절차와 도구별 설정 분리 |
| `packages/debugger` | 0.2.7 | MCP 디버거, WebView/CDP 연결, 진행 상태, 테스트 실행 | 이벤트·자원·수명 관리 |
| `packages/debug-console` | 0.2.0 | 미니앱 안에서 디버거 연결 및 상태 표시 | 호스트와 실행 대상 경계 |
| `shared/internal-protocol` | 별도 배포 대상 아님 | 두 런타임 사이 통신 소스 공유 | 패키지 버전과 통신 계약 분리 |

Node 24 이상과 pnpm 12.10.1을 선언한다. `internal-protocol`은 `packages/*` 워크스페이스 밖에 두고 소비 패키지의 빌드에서 참조한다. 독립적으로 발행되지 않는 내부 코드를 공개 패키지의 존재하지 않는 의존성으로 남기지 않으려는 설계다. [루트 패키지][root-package] [워크스페이스][workspace] [패키지 선언][packages] [의존성 검사][pack-check]

## 4. 공유 스킬과 도구별 설정

### 4.1 공통 내용의 단일 관리

공개 트리에는 공통 스킬 11개와 명령 래퍼 4개가 있다. Claude용 매니페스트는 `shared/skills`와 `shared/commands`를 참조하고, Cursor용은 공통 스킬만 참조한다. Codex가 Claude 형식의 매니페스트를 읽는다는 것은 원본 README의 설명이며 별도의 Codex 매니페스트는 공개 트리에 없다. [Claude 매니페스트][claude-manifest] [Cursor 매니페스트][cursor-manifest] [README][readme]

**재사용 패턴:** 공통 작업 절차는 한곳에 두고 각 도구의 설정만 얇게 나눈다. 에이전트마다 절차를 복사해 관리하면 수정 누락과 정책 차이가 생긴다.

**제거할 전제:** 제품 생성 명령, 해당 플랫폼 SDK·권한·콘솔·디자인 규칙을 범용 실행기의 필수 구성으로 두지 않는다. 도메인 스킬 팩으로 분리할 수 있다.

### 4.2 명령 표면과 실행 계약

`new.md`는 인자를 실제 생성 스킬로 넘기는 작은 래퍼다. 도구마다 명령 로딩과 인자 치환이 같지 않으므로, 같은 슬래시 명령이 모든 도구에서 동일하게 동작한다고 보지 않는다. [명령 래퍼][new-command]

새 제품의 카톡 명령도 공통 작업 API로 이어지는 진입점으로 만든다. 채널 문법, 자연어 해석, 특정 에이전트의 슬래시 명령은 바꿀 수 있어야 한다. 작업 ID·프로젝트·권한·중복 처리 계약은 그 아래에서 유지한다.

### 4.3 OAuth와 기능 호환성

두 매니페스트는 같은 MCP 연결도 OAuth 클라이언트 정보의 필드 표현이 다르다. 공유 설정 하나를 무조건 복사하기보다 공통 의미를 도구별 표현으로 변환해야 한다. 이는 **이 저장소의 설정 관찰**이며 모든 도구 버전의 인증 스키마에 대한 일반 보장이 아니다. [Claude 매니페스트][claude-manifest] [Cursor 매니페스트][cursor-manifest]

`setup-debugger`는 Codex 등 해당 경로의 지원 대상이 아닌 도구에서는 변경 없이 중단하도록 명시한다. Cursor는 설정 등록을 지원하지만 실기기 attach의 일부는 Claude 전용 메커니즘에 의존한다. **설치 호환, 스킬 호출 호환, 실제 기능 호환은 별개**다. [디버거 설정 스킬][setup-debugger]

## 5. 환경 진단·설치·업그레이드

`welcome`은 도구와 환경을 읽기 전용으로 점검하고 가능한 다음 행동을 안내한다. 알 수 없는 기능을 확인된 것으로 표시하지 않는다. 범용 제품의 설치 진단과 `/대시보드`에서 기기·실행 도구의 가용성을 표현하는 데 유용한 패턴이다. [진입 진단 스킬][welcome]

`setup-debugger`는 필요한 프로젝트에만 디버거 연결을 추가하고 기존 설정을 읽어 처리한다. 같은 설정 유지, 오래된 배포 경로 식별, 사용자 항목 보존, 변경 대상 확인을 일반 설치 계약으로 추출할 수 있다. [설정 절차][setup-debugger] [업그레이드 참고][upgrade]

다만 스킬 전체를 단순한 안내 화면으로 일반화하면 안 된다. `new-miniapp`은 생성 뒤 개발 서버를 백그라운드로 실행하도록 지시하는 절차를 포함한다. 따라서 각 스킬의 부작용을 `조회 / 설정 변경 / 프로세스 시작 / 외부 전송` 등으로 분류하고, 새 제품에서는 실행기 권한과 연결해야 한다. [생성 스킬][new-skill]

설치 반복 실행은 단순히 같은 JSON을 덮어쓰는 문제가 아니다. 개인 설정, 인증 상태, 실행 중 프로세스, 사용자 지정 서버의 소유권을 보존해야 한다. 새 하네스에서 설치·진단·업그레이드·시작은 서로 다른 명령과 검증 기준으로 둔다.

### 5.1 단계 전달과 외부 행동의 승인

`plan`은 기획 산출물과 미확인 사항을 정리하고 다음 단계로 전달하지만 프로젝트 생성·콘솔 변경을 수행하지 않는 범위를 갖는다. 반면 생성 스킬의 후속 서버 기동처럼 단계 전달에 실제 행동이 포함되는 경우도 있다. 따라서 단계 이름이 아니라 허용 도구·산출물·부작용을 검사해야 한다. [기획 경계][plan] [후속 프로세스 시작][new-skill]

`launch`에는 구체적인 요청 내용을 먼저 제시하고, 그 뒤 받은 승인으로 해당 1건을 한 번 호출하며 내용 변경 시 다시 확인하는 절차가 있다. 실패 뒤 자동 재호출도 허용하지 않는다. 이는 확인한 파일에서 **에이전트에게 주는 프롬프트 계약**이다. 이 문서만으로 우회할 수 없는 실행기 권한 검사가 구현됐다고 판정하지 않는다. [외부 요청 승인][launch]

범용 하네스는 이 절차를 task·attempt·approval ID와 실행 내용의 지문에 연결해야 한다. 질문을 카톡으로 보냈다는 사실과 실행 도구가 실제로 대기하고 있다는 사실, 승인 응답을 받았다는 사실과 올바른 요청을 해소했다는 사실을 각각 확인한다.

## 6. 상태 관찰과 대시보드

### 6.1 무엇을 관찰하는가

원본 대시보드는 터널, 연결된 WebView/CDP 페이지, QR 연결 단계, inspector, 데몬·테스트 러너의 상태를 관찰한다. 에이전트의 목표·담당 역할·대화 세션·작업 의존성을 표현하는 공통 작업판은 아니다. [대시보드 상태 모델][dashboard-state] [상태 생성][debug-server]

따라서 화면을 복사해 이름만 바꾸면 멀티에이전트 대시보드가 완성된다고 볼 수 없다. 관측 모델을 새 제품의 `Task / Attempt / AgentRun / Approval / Device`에 맞춰 먼저 설계해야 한다.

### 6.2 하나의 사건 기록을 여러 경로에서 사용

`AttachTimeline`은 순번·시도·시각·단계·결과를 기록한다. 진행 알림, 진단, 상태 조회와 대시보드가 이 기록을 공유한다. 알림에는 조건부 진행 토큰을 사용하고 장시간 대기에는 heartbeat를 보낸다. [단계 기록][timeline] [진행 알림][progress]

**추출할 계약:** 실행 사실의 생산자는 하나로 두고, 카톡·로컬 화면·진단은 같은 사실을 다른 형태로 표현한다. 알림 전송 실패가 실제 작업 성공을 실패로 바꾸지 않도록 관측 경로를 분리한다.

**추가할 계약:** 원본의 제한된 메모리 기록은 영속 작업 장부를 대체하지 않는다. 새 제품에는 재시작 복구, 시도별 이벤트 격리, 승인 대기, 여러 기기 시간 차이, 결과 회신 중복 방지가 필요하다.

구체적으로 순번은 프로세스 안에서 증가하고 현재 시도의 사건을 선택해 보여준다. 메모리 버퍼와 대시보드의 표시 항목에는 상한이 있다. 또한 임의 단계 기록을 받는 관측 객체가 합법적인 작업 상태 전이까지 강제하는 것은 아니다. 진행 알림의 증가값도 완료 퍼센트가 아니다. 새 제품은 상태기계와 관측 기록을 분리하고, 재시작·시계 역행·늦은 이벤트·버퍼 경계를 검사해야 한다. [타임라인 구현][timeline] [알림 구현][progress]

### 6.3 공통 응답 형태

`ToolEnvelope`는 결과·오류·메타정보와 다음 행동 안내를 공통 형태로 다룬다. 환경은 실제 활성 연결에서 파생하고, 실행 환경이 없을 때도 그 상태를 명시한다. [응답 계약][envelope] [환경 계산][environment]

범용 제품에서는 명령 접수, 어댑터 실행, 대시보드 응답에 공통 결과 계약을 적용하되 `성공`의 의미를 구분한다. 접수 성공, 실행 시작, 에이전트 종료, 요구사항 검증, 외부 결과 도착은 각각 다른 사건이다.

## 7. 수명·자원·프로토콜 경계

### 7.1 자원 점유와 작업 스케줄링

서버 lock과 점유 검사는 중복 데몬과 다른 클라이언트의 자원 충돌을 다룬다. 같은 WebView에 대한 중복 테스트 실행을 제한하는 코드도 있다. 이는 **공유 자원을 누가 사용하는지**에 대한 설계이며, 여러 AI 작업을 공정하게 분배하는 일반 스케줄러까지 제공하는 것은 아니다. [잠금 관리][server-lock] [디버거 실행 관리][debug-server]

새 제품에서는 자원 사용권에 task·attempt·실제 소유 실행·획득/해제 근거를 연결해야 한다. 로컬 장부를 지웠다는 사실과 실제 프로세스가 종료됐다는 사실을 구분한다. 소유권을 확인하지 않은 프로세스를 정리 대상으로 삼지 않는다.

**복사 전 점검할 경합:** 확인한 lock 구현은 기존 상태를 읽은 뒤 일반 파일 쓰기로 새 정보를 기록하고, release에서 잠금 파일을 제거한다. 동시 획득과 이전 소유자의 늦은 release를 원자적 소유권 토큰으로 차단하는 계약을 여기서 확인하지 못했다. 이는 정적 코드에 근거한 점검 후보이며 이번에 재현한 결함이 아니다. 새 구현에는 원자적 획득, 소유자 확인 해제, 회수 뒤 이전 소유자의 쓰기를 막는 세대 토큰을 설계하고 별도 경합 검사를 둔다. [획득·해제 코드][lock-acquire]

### 7.2 독립 패키지 사이의 버전

연결 프로토콜 버전은 패키지 버전과 별개로 취급한다. 독립적으로 버전을 올리는 실행 대상과 호스트가 패키지 버전 숫자가 다르다는 이유만으로 연결을 거절하지 않도록 하는 관점이다. [프로토콜 버전][protocol-version]

범용 하네스도 실행기·에이전트 어댑터·채널 어댑터의 배포 버전과 공통 메시지 스키마 버전을 분리해야 한다. 실제 호환 여부는 지원 범위·협상 결과·필수 기능으로 판정한다.

공유 handshake 구현은 패키지 버전 `v`를 표시용으로만 사용하고 프로토콜 `p`를 비교한다. `v`만 있는 구형 보고는 정해진 구형 프로토콜로 간주한다. 사용 가능한 프로토콜 보고가 없거나 형식이 잘못된 경우에도 `match`가 참이 될 수 있다. 따라서 이 값은 확인된 호환뿐 아니라 **불일치 증거가 없음**을 포함한다. 범용 제품에서는 `호환 / 비호환 / 미확인`을 분리하고, 인증 성공·대상 일치·권한·자원 가용성도 별도로 판정해야 한다. [실제 비교 코드][handshake]

### 7.3 종료 완료의 의미

종료 트리거는 signal, stdin 종료, MCP 연결 종료, 부모 프로세스 사망을 하나의 중복 방지된 종료 경로에 모은다. 이는 빠진 종료 경로 때문에 데몬이 남는 문제를 다루는 좋은 구조다. [종료 트리거][exit-triggers] [부모 감시][parent-watcher]

그러나 상위 종료 함수가 반환됐다는 사실과 모든 연결의 close 완료는 구분해야 한다. 확인한 디버거 종료 경로에는 연결 close를 시작하되 완료를 기다리지 않는 호출이 포함된다. 최종 SSE를 전송 시도한 사실도 클라이언트가 읽었다는 확인과 같지 않다. 새 제품은 새 작업 차단 → 최종 상태 저장 → 실행 종료 확인 → 연결 정리 확인 → 자원 반환 순서를 명시하고 기한·강제 종료·재시작 회수를 검사해야 한다. [디버거 종료 경로][shutdown] [최종 화면 연결 정리][dashboard-close]

## 8. 검증 설계에서 가져올 교훈

### 8.1 구조와 의미를 함께 검증

플러그인 검증기는 frontmatter, 명령과 스킬 연결, 버전·매니페스트 정합성, MCP 인자와 경로 등을 검사한다. 두 도구용 설정이 의도한 공통 정보를 같은 의미로 가리키는지도 검사한다. 새 제품도 스키마만 맞는지와 올바른 대상에 연결되는지를 나눠 검사해야 한다. [플러그인 검증기][validator] [호스트 설정 정합성][manifest-check]

### 8.2 실제로 에이전트에 전달된 내용을 확인

원본 주석에는 같은 이름의 명령이 스킬을 가려 본문이 전달되지 않았지만 다른 검사들은 통과했던 사례가 기록돼 있다. 이후 검사는 스킬 호출 표식만 보지 않고 실제 세션에 전달된 본문을 디스크 내용과 대조한다. 이 사례의 과거 수치·기간은 작성자의 기록이며 이번에 재현하지 않았다. [본문 주입 검사][skill-probe]

범용화할 교훈은 `등록 → 선택 → 전달 → 실행 → 결과`의 각 경계를 실제 관측하라는 것이다. 카톡에서 작업 번호가 보이는 것만으로 에이전트가 올바른 프로젝트·지시·권한을 받았다고 판정하면 안 된다.

이 검사는 인증된 도구 세션과 비용이 필요해 선택적으로 실행된다. 기본 CI 통과를 실제 스킬 로딩이나 전 에이전트 도구의 런타임 호환 성공으로 확대하지 않는다. 공개되지 않은 평가 자료도 모두 실행 가능한 상태로 간주하지 않는다. [검증 실행 경계][runtime-check] [비공개 자료 제외][ignore]

### 8.3 환경 실패를 기능 실패로 증폭하지 않기

본문 주입 검사에는 먼저 같은 실행 조건으로 사전 점검을 하는 설계가 있다. 로그인·플러그인 로딩 문제 하나가 스킬 수만큼 중복 실패로 나타나는 것을 줄인다. 일시적 실행 문제와 본문 불일치 같은 결정적인 관측을 분류하고 재시도 범위를 다르게 둔다. [사전 점검과 진단][skill-probe]

새 하네스에서도 인증 실패·도구 부재·작업 거절·실행 중 단절·외부 행동 결과 불명을 구분해야 한다. 모든 실패를 자동 재시도하는 정책은 채택하지 않는다.

## 9. 배포·소비자 검증·릴리즈

### 9.1 소스 저장소 밖에서 확인

CI는 빌드 뒤 테스트를 실행하고, 배포물에 필요한 파일과 불필요한 디버깅 표면을 검사한다. 소비자 호환 검사는 실제 pack한 패키지를 별도 프로젝트의 도구 버전 조합에서 사용하는 방식이다. 소스 트리의 의존성이 우연히 채워주는 누락을 찾는 데 유용하다. [CI][ci] [디버거 검사 명령][debugger-package]

새 제품도 새 디렉터리·깨끗한 설정에서 배포물을 설치해 시작·상태·종료·업그레이드를 검사해야 한다. 개발자의 전역 도구와 설정을 전제로 통과시키지 않는다.

`test-runner/task-graph.ts`의 그래프는 완료된 검사 보고서를 파일·스위트·테스트 트리와 reporter 이벤트로 변환하는 코드다. AI 에이전트의 실시간 작업 의존 그래프와는 책임이 다르다. 합성 reporter 이벤트를 실제 병렬 실행 시각으로 읽거나, 위치 기반 테스트 ID를 장기 작업 ID로 가져오지 않는다. [테스트 그래프][task-graph]

보고서는 상세 산출물과 요약을 나누고, 일반·수동·대역 실행의 출처를 구분한다. 이는 카톡 요약과 로컬 근거 파일을 분리할 때 참고할 수 있다. 다만 모드별로 파일 목록을 나눈 결과가 원래 전체 총계를 유지하는 경우가 있어, 소비자는 부분집합과 전체 집계의 의미를 구분해야 한다. 자유 문자열·캡처 내용의 민감성도 별도 검사가 필요하다. [보고서 직렬화][report]

### 9.2 CI와 릴리즈의 검사 동등성

원본은 CI와 릴리즈에 같은 검사 순서를 두고, 그 동등성을 테스트한다. 양쪽에서 중요한 검사가 동시에 빠지는 경우를 막기 위해 특정 검사의 존재도 확인한다. 비교가 맞는다는 사실만으로 필요한 검사가 충분하다고 보지 않는 설계다. [게이트 동등성 검사][gate-parity]

### 9.3 배포 메타데이터도 실행 경로의 일부

패키지 검사기는 발행되지 않는 내부 패키지를 의존성으로 남기는 문제를 검사한다. URL 검사기는 설치 문서·스킬·소스의 배포 URL과 패키지 버전·파일명·소유 저장소가 일치하는지 확인한다. [패키지 의존성 검사][pack-check] [배포 URL 검사][url-check]

이 규칙에는 원본 소유자·저장소·패키지 명칭이 들어 있다. 새 레포에서 검사기를 복사한다면 이 상수와 검사 표면을 함께 바꿔야 한다. 텍스트만 브랜드 이름을 치환하면 잘못된 설치 경로가 남을 수 있다.

### 9.4 발행 정책과 실제 강제 계층

릴리즈는 수동 실행, 기본 dry-run, 대상 패키지 제한, 실제 발행 시 main 제한, 기존 버전 덮어쓰기 거절, 자산 해시 기록, 초안 생성 후 자산 업로드와 공개 순서를 갖는다. 승인 환경의 필수 검토자는 워크플로 파일만으로 설정되지 않으므로, 환경 이름이 있다는 사실을 승인 강제의 증거로 삼지 않는다. [릴리즈 워크플로][release]

이를 새 프로젝트의 초기 필수 구성으로 모두 복제할 필요는 없다. 먼저 사용자가 설치할 최소 배포물의 계약을 정하고, 되돌리기 어려운 발행에 맞는 검사·승인·복구 정책을 선택한다.

## 10. OS 지원을 평가하는 방법

원본에는 OS별 Chrome 탐색 분기가 있다. 반면 임시 프로필의 `/tmp` 고정 경로, Unix `ps` 기반 프로세스 조회처럼 플랫폼별 점검이 필요한 지점도 확인됐다. 이들은 **정적 이식성 확인 항목**이며 이번에 재현한 Windows 결함이라는 뜻은 아니다. [브라우저 실행기][launcher] [프로세스 소유권 조회][server-lock]

| 축 | 코드에서 확인한 근거 | 아직 필요한 증거 |
| --- | --- | --- |
| 실행 환경 | Node 24 이상 선언 | 각 OS·CPU에서 신규 설치 및 실행 |
| 브라우저 탐색 | OS별 후보 경로 | 실제 설치 경로·실행 권한 조합 |
| 임시 파일 | 일부 고정 경로 | OS 임시 디렉터리·권한·정리 검사 |
| 프로세스 관리 | PID·소유권·부모 조회 | Windows와 Unix의 종료·복구 차이 |
| CI | Ubuntu job | macOS·Windows 검사와 한계 표시 |
| 에이전트 도구 | 호스트별 매니페스트와 제한 설명 | 버전별 실제 도구 호출·승인·중단 |

따라서 `Node 기반`, `여러 에이전트에 설치 가능`, `세 OS에서 전체 기능 검증`을 같은 표현으로 사용하지 않는다. [패키지 선언][root-package] [CI 실행 환경][ci]

## 11. 사용자 구상과의 차이

| 사용자 요구 | 원본에서 참고할 부분 | 새로 필요한 핵심 |
| --- | --- | --- |
| 공통 GitHub 설치·업데이트 | 마켓플레이스·공유 스킬·버전 관리 | 새 제품의 설치기·배포물 계약 |
| 여러 에이전트 실행 | 도구별 설정 경계 | 시작·후속 지시·중단·승인·재개 어댑터 |
| 카톡 명령 | 얇은 명령과 실제 절차 분리 | 신뢰된 발신자·방·명령 접수·회신 |
| 재접속 중복 방지 | 요청·상태 정합성 검사 관점 | 영속 접수 장부·시도 격리·불명 결과 대조 |
| 멀티에이전트 | 자원 점유·테스트 실행 관리 | 작업 의존성·역할·소유권·한도·통합 |
| `/대시보드` | 상태 기록을 여러 표면이 공유 | 작업·하위 에이전트·질문·기기 상태 모델 |
| 브라우저 없는 지속 실행 | 데몬 수명·종료 관리 | 카톡 연결과 작업 수명의 분리 |
| 세 OS 독립 사용 | 플랫폼 분기와 CI의 출발점 | 카카오 통신·저장·권한·실행기별 검증 |

권장 접근은 새 범용 실행기를 중심에 두고 원본에서 검토한 패턴을 선별해 적용하는 것이다. 원본의 디버거와 제품 개발 스킬 전체를 공통 실행기의 필수 의존성으로 넣으면 범위가 불필요하게 커진다.

## 12. Toss 전용 요소와 범용 요소의 분리

| 원본 요소 | 분리 방법 |
| --- | --- |
| 앱인토스 미니앱 생성·SDK·런타임 권한 | 선택적인 도메인 스킬 팩으로 분리 |
| 토스 문서·콘솔 MCP·OAuth | 새 제품 기본 연결에서 제외하고 필요한 별도 통합으로 취급 |
| 디자인 토큰·브랜드 자산·서체 | 범용 하네스의 제품 자산으로 복사하지 않음 |
| QR·WebView·CDP relay·실기기 attach | 상태·자원·수명 관리 아이디어를 추출하고 도메인 통신 자체와 구분 |
| 공통 스킬·호스트 매니페스트 | 유지할 설계 패턴, 새 이름·실행 인터페이스로 재설계 |
| 진행 사건·응답 계약·호환 검사 | 범용 작업·시도·어댑터 계약으로 재정의 |
| 발행 URL·브랜드명·고정 패키지명 검사 | 새 레포의 실제 배포 정책과 함께 변경 |
| maintainer-local 평가·운영 문서 | 존재를 가정하지 않고 공개 가능한 재현 검사를 새로 제공 |

## 13. 라이선스와 출처 보존

루트와 확인한 세 패키지의 LICENSE는 동일한 BSD-3-Clause 본문이다. 수정·재배포 조건에는 원 저작권 고지·조건·면책문 보존과, 권리자·기여자 명칭을 허가 없이 파생 제품의 보증·홍보에 사용하지 않는 조건이 있다. [라이선스][license]

이 문서는 원본 코드의 장문 복제가 아닌 독자 분석과 새 설계 제안이다. 이후 구현 코드를 옮길 때는 파일별 출처·고정 커밋·변경 내용을 기록하고 필요한 원래 고지를 보존한다. 원본의 브랜드 자산이나 외부 의존성까지 같은 라이선스라고 가정하지 않는다. 새 저장소 전체의 라이선스 선택은 별도의 결정이다.

## 14. 적용 판단

- **우선 참고:** 공유 스킬과 도구별 설정, 실제 기능 진단, 공통 사건 기록, 구조/런타임 검증 분리, 배포물 소비자 검사.
- **새로 설계:** 카톡 채널, 장기 작업 장부, 에이전트 실행 계약, 권한·승인, 멀티에이전트 소유권, 재시작 복구, 작업 대시보드.
- **그대로 채택하지 않음:** 플랫폼 전용 SDK·콘솔·브랜드 자산, 특정 도구의 백그라운드 실행 가정, 절대경로·Unix 전용 조회, 과거 실측 환경을 현재 지원 보장으로 사용하는 표현.

실제 새 제품의 검증 순서는 [구현·검증 인수인계](IMPLEMENTATION_HANDOFF.md), 도메인과 분리한 계약은 [범용 참고서](PORTABLE_AGENT_HARNESS_REFERENCE.md)에 정리한다.

[repo]: https://github.com/toss/apps-in-toss-harness
[commit]: https://github.com/toss/apps-in-toss-harness/commit/255b636812d8b3a9b048d0a700644b9cbd8532c4
[readme]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/README.md
[ignore]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/.gitignore#L12
[claude]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/CLAUDE.md#L51
[root-package]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/package.json
[workspace]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/pnpm-workspace.yaml
[packages]: https://github.com/toss/apps-in-toss-harness/tree/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages
[debugger-package]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/package.json
[claude-manifest]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/.claude-plugin/plugin.json#L36
[cursor-manifest]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/.cursor-plugin/plugin.json#L36
[new-command]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/shared/commands/new.md
[welcome]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/shared/skills/welcome/SKILL.md#L66
[setup-debugger]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/shared/skills/setup-debugger/SKILL.md#L63
[upgrade]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/shared/skills/setup-debugger/references/upgrade-check.md#L9
[new-skill]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/shared/skills/new-miniapp/SKILL.md#L996
[plan]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/shared/skills/plan/SKILL.md#L19
[launch]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/shared/skills/launch/SKILL.md#L151
[dashboard-state]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/qr-http-server.ts#L48
[debug-server]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/debug-server.ts
[timeline]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/attach-timeline.ts#L99
[progress]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/attach-progress.ts#L53
[envelope]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/envelope.ts
[environment]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/environment.ts
[server-lock]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/server-lock.ts
[lock-acquire]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/server-lock.ts#L411
[protocol-version]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/protocol-version.ts
[handshake]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/shared/internal-protocol/src/attach-handshake.ts#L104
[exit-triggers]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/exit-triggers.ts#L45
[parent-watcher]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/parent-watcher.ts#L79
[shutdown]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/debug-server.ts#L2535
[dashboard-close]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/qr-http-server.ts#L1526
[task-graph]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/test-runner/task-graph.ts#L63
[report]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/test-runner/report.ts#L136
[validator]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/scripts/validate-plugin.mjs
[manifest-check]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/scripts/validate-plugin.mjs#L2826
[runtime-check]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/scripts/validate-plugin.mjs#L3252
[skill-probe]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/agent-plugin/scripts/skill-load-probe.mjs
[ci]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/.github/workflows/ci.yml
[ci-run]: https://github.com/toss/apps-in-toss-harness/actions/runs/38983233717
[release]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/.github/workflows/release.yml
[gate-parity]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/scripts/__tests__/release-gate-parity.test.mjs
[pack-check]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/scripts/check-pack-manifests.mjs
[url-check]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/scripts/check-dist-urls.mjs
[launcher]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/packages/debugger/src/mcp/local-launcher.ts
[license]: https://github.com/toss/apps-in-toss-harness/blob/255b636812d8b3a9b048d0a700644b9cbd8532c4/LICENSE
