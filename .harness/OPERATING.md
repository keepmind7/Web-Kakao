# Web-Kakao 하네스 운영

확인 기준: 2026-10-18. 프로젝트 루트는 현재 clone에서 `AGENTS.md`와 `README.md`가 있는 디렉터리다. 해당 루트를 실행 시 절대 경로로 확인하고 부모의 실제 cwd와 일치할 때 자식을 생성한다. `spawn_agent`에는 cwd 인자가 없으므로 개별 명령의 workdir 지정만으로 다른 부모 작업 디렉터리를 보완했다고 보지 않는다. 특정 사용자의 PC 경로를 새 실행에 복사하지 않는다.

## 다른 환경에서 복원

Git에 포함하는 정의는 `AGENTS.md`, `.agents/skills/` 전체, `.codex/config.toml`, `.codex/agents/*.toml`, 이 문서와 `FOLLOWUP.md`다. 스킬의 references/scripts/assets 및 LICENSE/NOTICE도 함께 보존한다.

실행 장부 `.harness/runs/`, 과거 보고서·진단·해시, `_workspace/` 통신 로그, `local-only/`의 인증·개인 설정·런타임·APK는 공유하지 않는다. 새 clone에는 이전 agent ID나 실행 중 세션이 없으며 과거 승인이 새 실험 권한이 되지 않는다. 현재 기능과 검증 이력은 공개 `README.md`를 기준으로 읽는다.

새 환경에서는 현재 Codex·Python과 네이티브 역할/도구의 가용성을 확인한다. Node·Chrome·REA/JDK/JADX·ADB는 실제 맡길 작업에 필요한 것만 README의 준비 절차로 설치한다. Git clone은 도구 설치나 MCP 연결을 수행하지 않는다. 기존 정의는 Web-Kakao용이며 다른 프로젝트에 복사하면 목적·도메인 스킬·소유 파일·권한 계약을 조정해야 한다.

과거 실행 디렉터리가 없는 clone은 새 plan과 새 run을 `init`한다. `resume`은 이전 실행·입력·산출물이 실제로 있고 지문이 유효한 작업 복사본에서만 사용한다. 다른 PC의 절대 루트와 agent ID를 가진 장부를 억지로 재사용하지 않는다.

## 역할과 스킬 진입점

| 역할 정의 (`.codex/agents/`) | 책임 | 쓰기 범위와 스킬 |
| --- | --- | --- |
| `harness_explorer.toml` | 공식 문서·공개 소스·현재 실행 경로 조사 | 읽기 전용. 날짜·출처·버전/커밋·파일·함수·행 반환 |
| `kakao_rea_analyst.toml` | REA/JADX Android 정적 분석 | 배정된 비공개 분석 산출물만. `.agents/skills/kakao-android-analysis/SKILL.md` |
| `harness_architect.toml` | 상태 전이·요청/응답·브라우저/서버 경계·통과 기준 설계 | 읽기 전용. `.agents/skills/kakao-protocol-change/SKILL.md` |
| `harness_worker.toml` | 배정된 제품 파일 최소 수정 | 배타적 소유 파일만. protocol-change 또는 `.agents/skills/kakao-web-interaction/SKILL.md` |
| `harness_reviewer.toml` | 구현과 근거 독립 대조 | 읽기 전용. `.agents/skills/kakao-verification/SKILL.md` 및 해당 변경 스킬 |
| `harness_qa.toml` | 합성·로컬 통합 검사, 배정 테스트/근거 작성 | 배정 테스트·검증 산출물·캐시만. verification 및 web-interaction |

기존 `builtin_qa`, `builtin_reviewer` 정의는 Phase 1 이력으로 보존한다. 일반 오케스트레이터는 부모 자신이다. 별도의 부모 자식을 만들지 않는다. 새 도메인 오케스트레이터 스킬을 중복 생성하지 않고 이 문서와 기존 harness 스킬을 사용한다.

## 실행과 권한

- 자식 최대 3개, 실제 한도 우선. 모델·추론 설정 생략으로 부모 설정을 상속한다. 자식은 추가 분할안을 부모에게 반환한다.
- 역할 TOML은 독립 정의이며 `name`, `description`, `developer_instructions`를 사용한다. 현재 공식 문서에서는 자식 파일의 `sandbox_mode`·MCP 설정이 부모 권한을 바꾸지 않는다고 설명한다. 새 역할에 효력이 확인되지 않은 sandbox override를 넣지 않는다. 읽기 전용·허용 쓰기 경로는 행위 제약이며 OS 수준 격리를 증명하지 않는다. 상속된 실제 권한을 매 실행 확인한다.
- 현재 노출된 agent_type 목록을 먼저 확인한다. 새 역할이 없으면 임의 이름을 호출하지 않는다. 정의와 필요한 스킬을 읽은 빌트인 역할의 대체 실행으로 명시하고 실제 agent_type·ID·도구 접근을 기록한다. 커스텀 역할 자체의 발견·실행은 미실행으로 남긴다.
- 첫 자식 하나는 파일 읽기·쓰기 없는 대기 지시로 생성한다. 실제 ID가 반환되면 그 자식을 첫 작업에 재사용한다. 부모 스레드 오류로 ID 없이 실패하면 추가 생성하지 않고 부모가 순차 진행한다. 네이티브 실패와 부모의 작업 결과를 구분한다.
- 자식마다 최신 input.md와 역할/스킬 경로를 전달한다. 부모 스킬의 자동 상속·선택을 가정하지 않는다. 후속 작업은 기존 자식을 재사용하되 입력·결정·지문을 갱신한다.
- 도구별 명령은 프로젝트 루트를 workdir로 삼는다. 공개 자료 조사와 서로 독립된 코드 경로 조사는 병렬화한다. 같은 파일·테스트 캐시·Chrome 프로필은 동시에 변경하지 않는다.

현재 설정 키의 근거: [OpenAI Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), 확인일 2026-10-16. 프로젝트 `.codex/config.toml`은 `[agents] enabled = true`, `max_concurrent_threads_per_session = 3`만 설정한다. 현재 세션 반영과 새 세션 로딩 성공은 별도 실행 근거가 필요하다.

## 자원 사용권

부모가 실행별 `resource-leases.json`을 관리한다. 각 lease에 자원 별칭(실계정 식별자 제외), 소유 task/실제 agent ID, 목적, 사용 허용 범위, 승인 참조, 상태, 해제 근거를 기록한다. 공통 파일·실행 장부·통신 로그의 작성자는 부모 한 명이다.

| 자원 | 배정 원칙 |
| --- | --- |
| 계정·연결 기기 | 같은 계정은 한 작업만. 로그인/기기 변경/실제 읽음·발송 전 사용자 확인. 정의 복원·합성 점검에는 사용하지 않음 |
| 에뮬레이터·디버거 | 같은 대상은 순차. 현재 PC의 가용성을 실제 확인하고 사용 권한 있는 Android 환경만 배정 |
| REA 분석 엔진·JADX | doctor 포함 한 작업만. 엔진 세션 정리 확인 후 해제. APK 원본 보존 |
| 브라우저 테스트·공유 캐시 | 합성 임시 프로필만. 같은 프로필·출력·캐시를 사용하는 검사는 순차 |

입력 APK가 없거나 사용권이 불명확하면 분석은 미실행이다. 샘플 APK의 엔진 검증을 카카오톡 분석 성공으로 바꾸지 않는다. REA CLI, 별도 MCP subprocess, 현재 세션의 직접 MCP 연결은 서로 다른 검사다. 현재 도구 목록에 REA가 없으면 직접 MCP는 사용 불가로 기록하며 전역 설정을 바꾸지 않는다.

## 작업 배정과 장부

모든 task에 목표, 절대 프로젝트 루트, 변경하지 않는 입력과 지문, 선행 task, 필요한 스킬, 배타적 소유 파일, 산출물, 통과 기준, 자원 lease, 재시도 한도를 적는다. 읽기 전용 역할의 출력 파일은 부모가 대리 기록한다. backend/frontend는 필요하면 별도 작업으로 나누되 동일 파일을 동시에 소유하지 않는다. 공통 파일 변경은 부모가 통합한다.

설치된 번들의 `.agents/skills/harness/references/runtime-guide.md`를 읽고 다음 CLI를 사용한다. CLI는 로컬 상태 기록이며 실제 자식 생성·메시지 전송이 아니다.

```powershell
python .agents/skills/harness/scripts/run.py --project . init --plan-file .harness/next-plan.json --run-id next-run
python .agents/skills/harness/scripts/run.py --project . ready --run next-run
python .agents/skills/harness/scripts/run.py --project . start --run next-run --task TASK --agent-id ACTUAL_ID
python .agents/skills/harness/scripts/run.py --project . result --run next-run --task TASK --result-file PATH
python .agents/skills/harness/scripts/validate.py --project . --run next-run --complete
```

예시의 TASK/ACTUAL_ID/PATH는 실제 값으로 치환한다. plan을 준비하지 않은 예시 명령을 실행하지 않는다. `inputs`는 변경하지 않는 참조, `ownership`은 수정 대상이며 서로 겹치지 않는다. 선행 산출물은 dependencies로 전달한다. 실제 spawn ID만 등록한다. 결과 등록과 자식 idle/중단/종료는 별도 관찰한다. 유휴·중단 응답 확인 전에 소유권을 넘기지 않는다. 일반 작업 오류는 원인 확인 후 1회 재시도, QA 수정·재검증은 기본 2회까지이며 실패를 강제 통과시키지 않는다.

후속 실행은 `run.py resume --run PREVIOUS --new-run NEW`로 과거를 보존한다. 목표·의존성·소유권·결정·통과 기준이 바뀌면 새 plan을 `--plan-file`로 전달한다. 변경된 입력과 그 소비자는 다시 검증한다.

## 인수인계와 결과

각 인수인계는 다음을 분리한다: 확인된 사실(출처/날짜/버전/파일/함수), 추론(근거와 한계), 미확인 가설, 재현 방법, 실제 명령과 종료 코드/결과, 남은 문제와 준비 조건. 민감한 ID·본문·원본 응답은 쓰지 않는다. 보고서는 원본 대신 필요한 필드만 추려 작성한다.

사람에게 보이는 판정은 **검증 성공 / 부분 성공 / 실패 / 미실행**이다. 합성 성공을 제품의 실제 성공으로 승격하지 않는다. 번들 기계 상태는 task `completed/blocked/failed`, check `passed/failed/not_run`이므로 부분 성공은 summary/제한사항에 명시하고 필수 미실행이 있으면 해당 검증 task를 completed로 등록하지 않는다.

중요한 배정·발견·질문·답변·차단·인수인계는 부모가 `communication.py log`로 `_workspace/communications/<run-id>.jsonl`에 기록한다. 실제 메시지 전송에는 collaboration 도구를 별도 사용한다. recorded, sent, received를 구분하고 event ID로 연결한다. 원본 전체 대화 자동 수집으로 오해하지 않는다.

## 현재 경계와 후속 순서

최신 전체 합성 검증은2026-10-18 Node369·Python67·FULL 격리 Chrome67 통과다. 추가 서버 요청 경계11·브라우저 경계39와 instance4·Python API 부재 모의10은 별도 범위이며 합산하지 않는다. 실제 Python은3.13.7, 네이티브3.11은 미실행이다. 현재 UI 요청의 세션 표식을 본문 수신 전후에 검사하지만, 표식을 생략하는 인증된 로컬 운영자 직접 호출은 호환으로 남긴다. 이전 전체 브라우저 실패와 원래 RED는 보존하고, 누적 확인 이력 assertion·폴링 수명2개 시험 결함만 명시적으로 교정했다.

현재 소스는 build8 적대적 진단 보완이다. 기존 사용자 확인과 이번 합성 검증을 구분한다. 새 입장은 `python tools/local_web.py open`의 일회용 fragment 교환을 쓰며 일반 GET/status로 브라우저 권한을 만들지 않는다. build7에서 적용할 때 사용자 직접 로컬 세션 삭제→`stop --legacy`→필요한 경우 기존 설정 이전→새 `start`→`open`→QR 재인증이 필요하다. 실행·개인 설정·로그·진단은 설치별 LOCALAPPDATA 경로이며 기존 OneDrive 원본은 자동 이동/삭제하지 않는다. 실제 프로젝트 ACL 교정·개인자료 이전·사용자 서버 재시작·실계정 검증은 수행하지 않았다. 최신 검사 수와 적용 절차는 README를 따른다.

현재 사용자 확인 사례에서는 일반 방 읽음과 사진 수신 기기 표시가 성공했고, 이후 A형 화면의 QR·로그인·두 테마·답장 수신 기기 표시도 확인했다. 오픈채팅은 앞선 읽기 전용 차단 실패 이후 사용자가 확인한 방의 텍스트 작성·모바일 도착을 확인했다. 오픈채팅 사진·답장·읽음과 다른 종류·권한·재연결 조건은 미확인이다. 아래는 기능별 실패가 남았을 때의 조사 순서이며 전체가 현재 미해결이라는 뜻은 아니다. 현재 판정은 README와 최신 FOLLOWUP을 우선한다.

웹 발송 뒤 본인 모바일 채팅 목록의 미읽음 배지에 대해 사용자는 직접 보낼 때 해당 방의 읽음도 동기화하도록 선택했다. 문자·답장·사진 송신의 검증된 읽음 권한만 반영하며 일반 조회 OFF와 불명 결과 무재전송을 유지한다. 실제 모바일 배지 해제는 후속 사용자 확인 전까지 미실행이다. 이전 session/upload와 화면 설명만 바꾼 차수는 Ctrl+F5 뒤 사용자 직접 대화 연결 끊기→다시 연결로 충분했다. 현재 build8은 전체 서버 재시작·새 입장·QR 재인증 절차를 따른다. 에이전트는 현재 연결을 조작하지 않는다.

1. 상대방 읽음 `1`: APK 확보/해시·버전 → REA/JADX 정적 경로 → 별도 승인된 공식 앱 동작 비교 → 상태/프로토콜 계약 → 최소 수정 → 합성·로컬 통합 → 별도 승인된 상대방 화면 확인.
2. 사진 발송: APK의 업로드/프레임/완료 처리와 웹 구현 대조 → 최소 수정 → 실패·종료·불명 결과 검사 → 새 승인에 따른 실제 사진 도착 확인.
3. 대화방 이름: CHATINFO·제목 메타·참가자·오픈링크 근거 대조 → 이름 우선순위/식별 계약 → 합성 검사 → 필요시 승인된 실제 목록 비교.
4. 오픈채팅: 미확인 종류·링크·본인 권한은 차단 유지 → 기존 OD/OM의 조건부 기능·링크 보완 계약 대조 → 합성 검사 → 별도 승인된 실제 전송/수신 확인.

연결 안정화 검증에는 실제 SDK와 계정 없는 loopback 상대를 사용해 부가 조회 기한 후 같은 소켓의 후속 요청을 확인한다. 즉시 Error를 던지는 가짜 응답만으로 소켓 보존을 판정하지 않는다. 인증 단계의 거절·개별 작업 실패·단절·전송 결과 불명을 구분하고, 메타데이터 대기와 다중 이력을 포함한 전체 기한을 검사한다. 부모 서버 모듈 변경은 서버 재시작과 QR 재인증이 필요하며 기존 사용자 연결을 자동 종료하지 않는다.

상세 후속 계획은 `.harness/FOLLOWUP.md`를 읽는다. 실제 작업 범위는 최신 사용자 요청과 작업 패킷으로 정한다. 정의 복원만 요청한 차수에서 제품 수정이나 실계정 실험을 자동으로 시작하지 않는다.
