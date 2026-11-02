# Python과 Rust 적용 검토 — 2026-11-02

현재는 **Node.js와 Python을 유지하는 것이 낫다.** Rust를 도입한다면 Windows 파일 권한 검사 보조 프로그램부터 작은 비교 실험을 하는 것을 권한다. 이번에는 소스와 공식 문서를 검토했으며 Rust 구현·빌드·성능 비교는 실행하지 않았다.

## 현재 언어 구성

| 부분 | 언어와 주요 파일 | 역할 |
| --- | --- | --- |
| 브라우저 | JavaScript, `experiments/local-web/app.js` | 화면, 입력, 사진 변환, 요청·렌더링 |
| 로컬 서버·대화 worker | JavaScript/Node.js, `server.mjs`, `reader-manager.mjs`, `reader-session.mjs` | 인증, 카카오 연결, 이력, 수신·발송, 설정·사진 |
| 실행·준비 도구 | Python, `tools/local_web.py`, `tools/prepare_*.py`, `tools/platforms/` | 설치·실행·종료·OS별 프로세스 확인 |
| Windows 보안 helper | Python, `tools/windows_security.py` | 파일·폴더 ACL, 프로세스·포트 소유권 확인 |

카카오톡 대화 처리가 Python으로 구현된 프로젝트는 아니다. 실행 명령이 `python`으로 시작해도 실제 대화 서버는 준비된 Node 런타임의 별도 프로세스로 돈다.

## Rust가 현재 문제를 해결하는가

이번 초기화 경합은 이전 요청이 아직 유효한지를 판단하는 세대 검사가 빠진 문제다. 이름 복구 누락은 예약을 실제 시도로 잘못 계산한 문제다. 이력 응답 혼동 역시 요청과 응답을 어느 방에 연결할지에 관한 계약 문제다. 같은 상태 전이를 Rust로 옮겨도 이 판단을 구현해야 한다.

Rust는 컴파일러가 소유권 규칙으로 메모리 관리를 검사한다. 그 이점과 이번 프로젝트의 사용자 의도·비동기 응답 순서를 지키는 설계는 구분해서 평가해야 한다. [Rust 공식 문서: Ownership](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)

## 부분 도입을 검토할 지점

`experiments/local-web/platform/windows.mjs`는 권한 검사마다 Python helper를 실행한다. 영구 설정 저장에서는 폴더·키·파일을 여러 번 검사하므로 프로세스 생성이 반복된다. Node의 `execFile()`은 비동기여도 별도 프로그램을 실행한다. 비동기 호출이라는 이유만으로 프로세스 시작 비용이 없어지지는 않는다. [Node24.21.0 공식 문서: Child process](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html)

앞선 같은 날 진단에서 실제 Windows 영구 저장64건 burst는 162.720초, 두 store 병합은 23.530초였다. 이는 합성 부하 전체의 시간이다. Python 시작·Windows API·디스크·보안 제품의 비용을 따로 측정하지 않았으므로 그중 얼마를 Rust가 줄일지는 알 수 없다.

현재 Python helper도 `ctypes`로 Windows DLL의 보안 API를 호출한다. 따라서 Python의 반복문을 단순히 Rust로 옮기는 이익보다, 인터프리터 시작·프로세스 생성 횟수와 검사 묶음을 비교하는 편이 타당하다. 이 부분의 속도 개선은 아직 추론이다. [Python3.13 공식 문서: ctypes](https://docs.python.org/3.13/library/ctypes.html)

| 선택 | 판단 |
| --- | --- |
| 현재 구성 유지, 요청 순서·불필요한 대기 수정 | 우선 진행. 재현된 문제를 작은 변경으로 고칠 수 있음 |
| Windows helper만 Rust 실행 파일로 교체 | 비교 실험 후보. 동일 ACL·파일 교체·취소 검사를 보존해야 함 |
| 검사들을 짧은 보조 프로세스의 한 트랜잭션으로 묶기 | 언어와 별도로 검토. 매 쓰기 권한 검사와 게시 직전 검증은 유지 |
| 실행 도구까지 Rust로 교체 | 배포 경험을 개선할 때 별도 검토. 설치·무결성·입장권·포트 확인 계약을 다시 검증해야 함 |
| 대화 서버·프로토콜 전체를 Rust로 다시 작성 | 현재 권하지 않음. QR·SDK·응답 상관관계·발송 불명 처리 등을 다시 검증해야 하며 실제 속도 이익도 미측정 |

상주 helper는 공격 표면·IPC·종료·권한 유지라는 새 설계가 필요하다. 속도만을 이유로 바로 도입하지 않는다. 성공한 권한 검사를 영구 캐시하거나 확인 횟수를 임의로 생략하는 방법도 권하지 않는다.

## 여러 OS와 배포

Rust도 OS·CPU마다 빌드 대상과 실행 파일이 다르다. Windows x64, Linux x64, macOS ARM64와 Intel macOS는 각각의 target을 사용하고 실행·서명·파일 권한 검사를 따로 확인해야 한다. 확인일 현재 공식 표에서 앞의 세 대상은 Tier1 with Host Tools, Intel macOS의 `x86_64-apple-darwin`은 Tier2 with Host Tools다. 지원 등급만으로 이 프로그램의 OS별 동작이 검증되는 것은 아니다. [Rust 공식 플랫폼 지원표](https://doc.rust-lang.org/rustc/platform-support.html)

## 다음 실험을 한다면

로그인 없이 임시 파일만 사용해 Python helper와 같은 동작의 작은 Rust helper를 비교하면 된다. 프로그램 시작 시간과 실제 ACL 검사 시간을 나누고, 같은 파일·같은 OS·동일 보안 조건에서 반복 지연의 p50/p95와 배포 크기를 기록한다. 넓은 ACL·심볼릭 링크/재분석 지점·파일 교체·소유자 불일치·중단·기한 초과도 기존과 같은 결과로 거절해야 한다.

그 비교에서 이익이 확인되면 Node 서버와 웹 화면은 유지하고 helper만 교체할 수 있다. 현재 결론은 **전면 재작성은 보류, Windows 보조 프로그램의 부분 실험만 후보**다. 언어 변경을 이번 D1/D2 수정에 섞지 않았다.
