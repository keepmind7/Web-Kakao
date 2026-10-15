# Web-Kakao

기존 카카오톡 계정의 대화방과 메시지를 브라우저에서 조회하고 실시간으로 수신·답장하는 독립 웹 클라이언트를 연구한다. 공식 앱의 상시 실행이나 원격 데스크톱 대신 `브라우저 ↔ 자체 서버 ↔ 카카오톡 서버` 구조를 검토한다.

## Phase 1 종료

**2026-10-15 (Asia/Seoul), 최종 판단: 조건부 진행.** 가능성 조사와 최초 실연결 검증을 마감했다. 핵심 기능 전체 통과나 실사용 서비스 완료를 뜻하지 않는다.

본인 휴대폰 QR 스캔·확인번호 입력·승인 후 자체 서버에서 실제 인증 토큰을 받았다. 같은 노트북의 웹에서 읽기 전용 검사를 실행해 카카오톡 대화 서버 `LOGINLIST` 성공 응답(status0)과 **방 목록 배열62개**를 수신했다. 검사 후 연결을 종료했다. 공식 카카오톡 PC 앱과 원격 접속은 사용하지 않았다.

| 검증 항목 | 결과 | 확인 범위와 남은 항목 |
| --- | --- | --- |
| 계정 인증 | 부분 성공 | 실제 QR 인증 토큰 수신; 갱신·원격 로그아웃·서버 재시작 후 복구·휴대폰 OFF 유지 미검증 |
| 대화 조회 | 부분 성공 | 대화 서버 로그인·목록 배열62개 수신; 전체 기존 목록 대조·선택 방 메시지 내역 미검증 |
| 실시간 수신 | 미실행 | 신규 수신·재접속 동기화·중복·순서 미검증 |
| 메시지 전송 | 미실행 | 실제 발송 없음; 대상·정확한 내용의 사전 확인 필요 |
| 웹 연결 | 부분 성공 | QR 인증과 연결 검사 결과 표시; 방 이름·메시지 화면과 상시 연결 미구현 |

배열 개수는 전체 대화방의 완전성이나 과거 메시지 접근을 입증하지 않는다. 최초 휴대폰 승인은 운영 중 휴대폰 없이 계속 연결할 수 있다는 증거와 다르다. 현재 노트북이 임시 서버이므로 노트북을 끄면 로컬 서비스도 종료된다. 개인 노트북 종료 후 사용하려면 별도 상시 서버와 세션 유지 검증이 필요하다.

공식 공개 API는 일반 개인 대화방의 조회·수신·임의 방 답장을 제공하지 않는다. 카카오 로그인, 나에게 보내기, 조건부 친구 템플릿 발송과 일반 카카오톡 클라이언트 기능을 구분한다. [공식 메시지 기능](https://developers.kakao.com/docs/ko/kakaotalk-message/common), [2026년 공식 외부 연동 답변](https://devtalk.kakao.com/t/topic/148362/4).

## 공개 파일 범위

| 경로 | 내용 |
| --- | --- |
| `experiments/local-web/` | 현재 사용한 최소 웹 화면, QR 인증, 일회성 대화 서버 연결 검사 |
| `experiments/`의 다른 파일 | 공식 API 대조·후보 구현의 모의 실험·과거 사전 진단 도구 |
| `tests/` | 인증·실패 처리·요청 제한·비밀정보 비노출·연결 검사 테스트 |
| `tools/` | 환경 점검, 고정 공개 소스·런타임 준비, 로컬 서버 실행 도구 |
| `tools/vendor/codex_harness/` | 조사·검수에 참고한 하네스 helper와 원본 라이선스 |

현재 `.gitignore`에 따라 `docs/`, `evidence/`, `.codex/`, `.harness/`, `_workspace/`, `local-only/`는 공개하지 않는다. 상세 보고서·실행 근거·작업 기록은 로컬에 보관한다. 토큰·비밀번호·세션 키·대화 원문·QR·확인번호는 Git에 넣지 않는다. 계정 세션은 저장소에 포함되지 않는다.

## 로컬 실행

현재 실행 도구는 Windows x64와 Python 3.11 이상을 기준으로 한다. 준비 과정에서 Node24.21.0, 고정 공개 소스와 npm 의존성을 다운로드한다. 전역 설치 대신 프로젝트의 `local-only/`를 사용하며 외부 소스의 라이선스·고지를 보존한다.

```powershell
python tools/prepare_node_spike.py
python tools/fetch_source_spike.py modern
python tools/fetch_source_spike.py legacy
python tools/prepare_spikes.py --install-dependencies
python tools/local_web.py start
```

브라우저에서 `http://127.0.0.1:8787`을 열고 QR 로그인 → 휴대폰 스캔·승인 → **읽기 전용 연결 확인** 순서로 진행한다. 연결 검사 버튼은 방 개수만 표시하고 종료한다. 현재 방 이름과 메시지를 보여주는 채팅 화면은 없다.

실험 프로필은 Android 태블릿 SM-T733/Android14/앱26.1.2다. 비공식 연결 실험이며 서버가 등록·인증을 거부하면 중단한다. 인증 정보는 서버 메모리에만 두고15분 뒤 정리한다. 이 한도는 카카오 서버의 토큰 만료 시간이 아니다. 로컬 세션 삭제·서버 종료는 원격 로그아웃을 뜻하지 않는다.

브라우저는 loopback HTTP를 사용하고, QR 인증의 카카오 서버 통신은 인증서 검증 HTTPS를 사용한다. 대화 서버 Booking은 TLS, 이후 Ticket/Carriage는 고정 소스의 V2SL 암호화 TCP를 사용한다. 외부 공개·터널·실제 메시지 발송 기능은 연결하지 않았다.

```powershell
python tools/local_web.py status
python tools/local_web.py stop
```

준비 도구는 제외된 `evidence/`에 다운로드 manifest를 새로 생성한다. 공개 저장소에는 당시 실행의 package-lock과 실측 보고서를 포함하지 않으므로, 새 설치는 당시의 전이 의존성을 완전히 고정한 재현과 다를 수 있다. `tools/verify_artifacts.py`는 비공개 로컬 보고서·manifest를 검증하는 도구이므로 해당 파일이 있는 작업 복사본에서 사용한다.

## 검증

Phase 1 종료 시 Python16개와 Node30개 검사가 통과했다. 모의 테스트 통과와 실제 계정 결과는 구분한다. 아래 Node 검사는 위 소스·의존성 준비가 필요하다.

```powershell
python -m unittest discover -s tests -v
& ./local-only/runtime/node-v24.21.0-win-x64/node.exe --test tests/local-web.test.mjs tests/room-probe.test.mjs
```

QR 인증·연결 검사의 기반 소스는 [tyeom/kakao-cli](https://github.com/tyeom/kakao-cli/tree/8dbbd4f7ed6b42542982252250622fa351af00e9)의 고정 commit이다. 원본의 일반 API 서버나 평문 계정 저장 기능을 실행하지 않고 제한한 실험 경로를 사용한다. `experiments/auth_preflight.py`는 초기 진단 기록용이며 현재 QR 실행기의 gate가 아니다.

## 다음 단계

최소 방 목록 표시·기존 목록 대조·선택 방 이력 조회와 휴대폰 OFF 상태의 연결 유지·갱신·재연결·재인증을 먼저 검증한다. 이후 실시간 수신·누락 복구·중복·순서, 승인받은 대상과 내용의 실제 전송을 확인한다. 전체 UI와 실사용 배포는 이 결과를 확보한 뒤 판단한다.
