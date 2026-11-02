# Open Code Review 설치·검수 — 2026-11-02

설치와 이번 범위의 검수는 **검증 성공**이다. 현재 미커밋 코드 변경 6개를 모두 읽었으며 신규 확정 결함은 발견하지 못했다. 관련 Node 202조건과 격리 Chrome 3조건은 통과했다. 기존 이력 응답 재수용 문제는 합성으로 다시 재현됐다. 전체 저장소의 무결함이나 실제 카카오 동작을 판정한 결과는 아니다.

## 설치와 실행

[Alibaba 공식 저장소](https://github.com/alibaba/open-code-review)의 v1.13.3을 프로젝트 안에 설치했다. 공식 릴리스 CLI의 표시 버전은 `v1.13.3 (375f64c) windows/amd64`다.

| 구성 | 설치 위치·확인 |
| --- | --- |
| OCR CLI | `local-only/tools/open-code-review/v1.13.3/ocr.exe` |
| 일반 스킬 | `.agents/skills/open-code-review/` |
| 위임 스킬 | `.agents/skills/open-code-review-delegate/` |
| 실행 도구 | `tools/open_code_review.py` |
| OCR용 Git | `local-only/tools/mingit/2.56.0.4/`, 실제 표시 `2.56.0.windows.4` |

OCR Windows 실행 파일 SHA-256은 `09bf6d1b8a24859fcc88f7bab1576a290a074f147655b860be4e766b568c3809`로 공식 `sha256sum.txt`와 일치했다. MinGit ZIP은 Git for Windows 공식 릴리스의 asset digest `e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877`와 일치했다. 두 스킬에는 Apache-2.0 LICENSE와 원본 ref·경로·해시를 기록한 UPSTREAM.json을 보존했다. 스킬 본문에는 로컬 실행 경로 안내만 추가했다.

전역 Git·PATH·Codex 설정·플러그인 캐시·OCR 공급자 설정은 바꾸지 않았다. 기존 시스템 Git 2.31에서는 최초 preview/rule이 경고와 함께 성공했다. 이후 실행 도구가 자식 프로세스의 PATH 앞에 전용 MinGit을 넣도록 연결하고, 최소 요구 Git 2.41을 충족한 상태에서 preview/rule을 다시 실행해 종료 0과 경고 없음을 확인했다.

새 clone에서 Windows x64용 CLI와 MinGit을 복원할 때:

```powershell
py -X utf8 tools/open_code_review.py --install
```

스킬은 다음 대화부터 프로젝트 스킬로 사용할 수 있다. 이번 대화에서는 설치한 SKILL.md를 직접 읽고 명령을 실행했다. 다음처럼 요청하면 된다.

```text
$open-code-review-delegate 현재 변경분을 리뷰해줘. 수정하지 말고 근거와 재현 조건을 정리해줘.
```

파일 선정과 규칙을 직접 확인할 수도 있다.

```powershell
py -X utf8 tools/open_code_review.py delegate preview --format json
py -X utf8 tools/open_code_review.py delegate rule --format json experiments/local-web/server.mjs
```

이번에는 **위임 모드**를 사용했다. OCR은 파일 선정·제외·규칙 해석을 수행했고, 호스트와 두 읽기 전용 검수자가 실제 코드를 검토했다. 별도 OCR 모델 API 호출이나 공급자 키 설정은 없었다. OCR 자체 모델 엔진의 `review`/`scan` 실행과는 구분한다. 별도 LLM을 연결한 전체 파일 scan은 미실행이다.

## 검토 범위와 결론

기준은 로컬 `HEAD`와 작업 복사본이다. 작업 전부터 있던 제품·테스트 변경을 보존했다. OCR의 workspace 기본 범위는 staged·unstaged·untracked 변경이며 전체 저장소 감사가 아니다.

| 최초 선정 코드 | 검토 결과 |
| --- | --- |
| `experiments/local-web/preferences.mjs` | 초기화 세대, 저장 대기열, 파일 게시·메모리 반영 전 유효성 검토 |
| `experiments/local-web/reader-manager.mjs` | profile·attempt·세대·외부 current 전달과 소비자 검토 |
| `experiments/local-web/server.mjs` | 본문 수신 전 scope, 유효한 초기화 수락, 재연결·계정 교체 경계 검토 |
| `experiments/local-web/reader-session.mjs` | 제목 예약·실제 요청 구분, 선택 취소·거절·timeout·늦은 응답 검토 |
| `tests/fixes-20261102.test.mjs` | 신규 229행 전체, D1/D2 조건과 합성 전송·자원 정리 검토 |
| `tests/photo-loading-multitab-browser.mjs` | 종료 이벤트·HTTP 상태·서버 관측과 실제 취소 API 경로 검토 |

최초 `total_files=6`, `reviewed_files=6`, `skipped_files=0`, `coverage_rate=100%`다. OCR이 제외한 README와 기존 진단·수정·Rust 검토 문서는 코드 결론 및 검증 범위와 수동 대조했다. 이 문서들에 담긴 외부 문서 주장을 모두 새로 검증한 것은 아니다.

설치 후 지원 Git으로 갱신한 preview는 코드 6개 외에 새 실행 도구 1개, LICENSE 2개, 출처 JSON 2개까지 11개를 선정했다. 추가 5개도 규칙을 조회하고 부모가 검토했다. LICENSE는 원본과 동일함을 확인했고 출처 JSON·실행 도구는 내용과 구문·실제 실행을 확인했다. 최종 선정 범위는 `total_files=11`, `reviewed_files=11`, `skipped_files=0`, `coverage_rate=100%`다. Markdown 제외는 별도이며 이 보고서 자체는 검토 대상 제품 코드에 포함하지 않는다.

새 변경에서 critical/high/medium 확정 지적은 0건이다. 이것이 남은 문제의 해소를 뜻하지는 않는다.

### 기존 조건부 P2: 완료된 이력 응답이 다른 방 요청을 해소함

`reader-protocol.mjs:161`의 SYNCMSG method fallback과 `reader-session.mjs:420`의 이력 반영, `reader-data.mjs:208`의 roomId 없는 로그 수용을 대조했다. 완료된 A 응답을 B 요청 중 다시 주입하면 B promise가 해소되고 A의 합성 로그 1개가 B store에 들어가는 기존 D3를 현재 소스로 재현했다. roomId를 요구한 대조에서는 수용 0개였다.

**판정: 합성 경계는 실패가 재현됨. 실제 서버 재전달·실제 방 혼합 발생은 미확인.** 실행 코드 0은 결함 재현 단언이 충족됐다는 뜻이며 정상 동작 통과가 아니다. 정상 roomless 이력을 전부 차단하는 수정은 응답 계약을 확인한 뒤 설계해야 한다. [기존 진단 D3](DIAGNOSIS_20261102.ko.md)를 유지한다.

### 남은 관측·성능 범위

- 사진 테스트의 기존 `canceled:true` 단언은 HTTP 정상 종료·409·Chrome 네트워크 취소를 같은 정상 취소로 취급하지 않는다. 새 관측 필드는 원인 분류를 돕지만 단언 자체는 그대로다. 이번 3/3 통과로 과거 간헐 실패의 원인을 해결했다고 판정하지 않는다.
- D2 신규 검사는 session 직접 호출이다. manager가 같은 pinned 방의 중복 view를 생략하므로, 방을 실제로 바꾸었다 돌아오는 경로와 같은 방 반복 호출을 구분해야 한다. 실제 UI·실계정 재선택 전체를 신규 16조건만으로 입증하지 않는다.
- 이전 방 이력의 후속 페이지가 방 전환 뒤에도 실행되는 구조와 Windows 설정 저장의 권한 검사 비용은 기존 남은 사항이다. 이번에는 속도 개선이나 새 성능 측정을 하지 않았다.

## 이번 실행 검증

| 검사 | 실제 결과 |
| --- | --- |
| OCR delegate preview/rule | 최초·지원 Git 재실행 모두 종료 0; 최종 Git 경고 없음 |
| Node 관련 10파일 | 202/202 통과, 실패·skip·취소 0, 종료 0, 124.032초 |
| 격리 Chrome 네 탭 사진 | 3/3 통과, 종료 0; 사진 HTTP·서버·상류 동시 최대 2 |
| 기존 D3 재전달 주입 | 알려진 결함 재현, 다른 방 로그 1개 수용·roomId 대조 0개 |
| 실행 도구 | Python 구문, launcher help, OCR help/version 및 실제 preview/rule 성공 |
| 하네스 구조 | 8역할·7스킬·오류 0; 정적 구조 검사 |
| 실제 카카오 계정·전체 회귀·다른 OS | 미실행 |

Node 파일은 `fixes-20261102`, `preferences-boundaries`, `preferences-durability`, `phase3-settings`, `room-title-ordering`, `room-metadata-recovery`, `metadata-repair-20261021`, `photo-consumer-cancel`, `photo-loading`, `reader-message-correlation`의 `.test.mjs`다. 표준 프로세스 격리와 `--test-concurrency=1`을 사용했다. 최초 sandbox 실행은 `spawn EPERM`으로 시험 본문 전에 실패했으며, 실행 권한을 받아 위 검사를 수행했다. 환경 실패를 제품 assertion 실패나 성공으로 계산하지 않았다.

Chrome은 주입 reader·합성 사진·임시 loopback 포트·새 임시 프로필을 사용했다. 종료 시 전용 Chrome 종료, 서버 종료, 프로필 삭제, 미완료 CDP 0을 확인했다. 과거 사진 검사와 이번 결과를 합산하지 않는다.

제품 파일 수정, 사용자 서버 재시작·로그인·읽음·발송, commit·push는 하지 않았다. 상세 preview/rule·실행 출력·합성 probe·검토 coverage·해시는 Git 제외 경로 `local-only/reviews/ocr-20261102/`에, 검수 인계는 `.harness/runs/ocr-review-20261102-final/`에 보존한다. 설치 연결 문구가 추가된 스킬의 입력 지문은 새 run에서 재확인했으며 제품·시험 입력은 동일했다.
