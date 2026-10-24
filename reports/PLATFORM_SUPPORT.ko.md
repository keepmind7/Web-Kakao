# Windows 보존과 Linux/WSL2 지원

2026-10-23 작업입니다. 기존 Windows 명령·저장소 식별자·QR 및 통신 정책을 보존하고 OS별 실행 코드를 분리합니다. Ubuntu WSL2의 계정 없는 회귀·합성 화면 검사를 통과했고 사용자가 시험한 실제 방·이름·이력 조회도 성공했습니다. Linux 실전 송수신은 아직 미검증입니다. macOS의 경로 계산만 준비했으며 현재 실행은 지원하지 않습니다.

## 코드 구성

| 구분 | 위치 | 역할 |
| --- | --- | --- |
| 공통 제품 | `experiments/local-web/`의 UI·서버·reader 모듈 | 기존 대화·사진·읽음 정책. 경로 호환 유지 |
| Python common | `tools/platforms/common.py`, `paths.py` | OS 선택·허용 환경·순수 저장 경로 계산 |
| Windows | `tools/platforms/windows.py`, 기존 `tools/windows_security.py` | 기존 ACL·프로세스 검증·브라우저 검색 |
| Linux | `tools/platforms/linux.py` | /proc 대상 PID의 모든 listener 보유와 실행 이미지 확인·브라우저 검색·POSIX 실행 |
| Node 플랫폼 | `experiments/local-web/platform/common.mjs`, `windows.mjs`, `linux.mjs` | 순수 경로 계약·Windows helper·POSIX 파일 보호 |
| 실행 진입점 | `tools/local_web.py` | 공통 인증 순서·명령·종료 정책. 기존 경로 유지 |
| 고정 런타임 | `tools/runtime_distribution.py`, `prepare_node_spike.py` | OS/CPU별 공식 파일·SHA-256·설치 경로 |
| 소스 패키지 | `tools/package_local_web.py` | 공유 소스만 ZIP에 포함. 개인 원본·세션·의존성 제외 |
| WSL 검증 | `tools/verify_linux.py` | 격리 mock 서버와 플랫폼/회귀 검사 |

소스 패키지는 Python과 Node 의존성 준비가 필요한 형태입니다. Windows에서 준비한 Node 실행파일이나 node_modules를 Linux에 복사해서 실행하지 않습니다. 개인정보·인증·대화·APK·분석 원본·로컬 실행 기록은 패키지 및 Git에 넣지 않습니다.

## WSL 준비와 수정본 전달

Windows PowerShell에서 `wsl -l -v`로 배포판 VERSION이2인지 확인합니다. Ubuntu 안에서는 `wsl.exe -l -v`를 사용합니다. 현재 에이전트 실행 PC에는 wsl.exe가 없으며, 별도 PC에서 사용자가 실행한 결과를 구분해 기록합니다.

GitHub에 반영된 변경은 최신 main을 clone/pull해 받습니다. 아직 push하지 않은 로컬 변경을 다른 PC로 전달할 때는 Linux 소스 ZIP을 WSL의 **Linux 홈 디렉터리**에 풉니다. ZIP 파일을 /mnt/c에서 읽는 것은 가능하지만 코드·런타임·개인 설정 실행 위치는 Linux 쪽이어야 합니다. Windows의 사용 중인 작업 폴더·개인 데이터·로그인은 유지합니다. Mac 개발 재개는 README의 ‘Mac에서 재개하기’를 따르며 현재 macOS 실행은 지원하지 않습니다.

수정본 패키지를 준비하는 Windows 명령:

```powershell
py -3 tools/package_local_web.py --platform windows --output local-only/dist/web-kakao-windows-source.zip
py -3 tools/package_local_web.py --platform linux --output local-only/dist/web-kakao-linux-source.zip
```

WSL에서 Linux 소스 패키지를 푼 프로젝트 루트로 이동한 뒤 일반 사용자로 준비합니다. Python3.11 이상과 Git(소스 패키지의 임시 저장소 시험용)이 필요하며, 아래 준비 명령은 공개 런타임·소스·npm 의존성을 다운로드합니다.

```bash
python3 --version
python3 tools/prepare_node_spike.py
python3 tools/fetch_source_spike.py modern
python3 tools/fetch_source_spike.py legacy
python3 tools/prepare_spikes.py --install-dependencies
```

## 계정 없는 검증 순서

다음 명령은 실제 카카오톡 로그인을 시작하지 않습니다. 별도 XDG/HOME·임시 포트·mock 모드만 사용하며 사용자 세션을 종료하지 않습니다.

Node만 준비한 상태에서는 mock 검사까지 실행할 수 있습니다. `platform`은 reader-manager의 고정 소스 확인도 수행하므로 modern 원본과 작업 복사본이 필요합니다. 준비 도구는 modern·legacy를 함께 요구합니다. 아직 소스를 준비하지 않았다면 다음을 먼저 실행합니다. 공개 소스를 내려받고 실험 복사본만 만들며, 이 단계에 npm 설치나 카카오톡 계정 연결은 포함되지 않습니다.

```bash
python3 tools/fetch_source_spike.py modern &&
python3 tools/fetch_source_spike.py legacy &&
python3 tools/prepare_spikes.py
```

`full`이나 브라우저 검사 전에는 위 준비 절차의 `python3 tools/prepare_spikes.py --install-dependencies`도 완료합니다.

```bash
# 먼저 Linux 실행·파일 권한·/proc 신원·HMAC 검증과 종료
python3 tools/verify_linux.py --suite mock

# 신규 플랫폼 시험 + 공통 읽음 진단 시험 + mock 시작/종료
python3 tools/verify_linux.py --suite platform

# 기존 전체 Python/Node 회귀도 추가
python3 tools/verify_linux.py --suite full

# Linux Chrome/Chromium이 준비된 경우 격리 headless 화면 검사도 추가
python3 tools/verify_linux.py --suite platform --browser
```

검증 결과는 실행할 때의 stdout·종료 코드로 판정합니다. 첫 실패를 자동으로 통과시키지 않으며 Windows 모의 시험 성공을 WSL 성공으로 대체하지 않습니다. `--suite full`에서 남은 OS 의존성이 발견되면 그 결과를 실패로 보존하고 원인을 좁힙니다. 검증용 `local-only/qa-linux/isolated-*` 폴더는 종료 실패 시에도 runtime 신원을 보존하도록 자동 삭제하지 않습니다. 다른 Node 전체 종료로 정리하지 않습니다.

### Linux 브라우저 준비

사용자는 Windows Chrome과 별도로 WSL에 Linux Chrome 156.0.8078.47을 설치하고 버전을 확인했습니다. 후속 화면 검사는 긴 임시 경로 때문에 시작 단계에서 실패했으나, fix6의 짧은 전용 TMPDIR 적용 후 사용자 WSL에서 격리 브라우저 검사 exit0을 확인했습니다. 설치·버전 확인과 화면 실행 결과를 따로 기록합니다. 신규 x86_64 Ubuntu 설치는 [Microsoft WSL 공식 안내](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps#install-google-chrome-for-linux)를 참고합니다. 설치에는 sudo가 필요하며 Google 패키지 저장소가 추가됩니다([Google 설치 안내](https://support.google.com/chrome/answer/95346?hl=en)). 확인일: 2026-10-23.

```bash
cd /tmp &&
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb &&
sudo apt update &&
sudo apt install ./google-chrome-stable_current_amd64.deb &&
google-chrome --version
```

최소 Ubuntu/WSL에는 한글 글꼴이 없을 수 있습니다. 한글이 네모로 보이면 WSL에 CJK 글꼴과 이모지 글꼴을 준비하고 캐시를 갱신합니다([Ubuntu 글꼴 패키지 목록](https://packages.ubuntu.com/ko/noble/fonts/), [fc-cache 공식 매뉴얼](https://manpages.ubuntu.com/manpages/jammy/man1/fc-cache.1.html)). 확인일: 2026-10-23.

```bash
sudo apt update &&
sudo apt install -y fontconfig fonts-noto-cjk fonts-noto-color-emoji &&
fc-cache -f
```

설치 후 서버를 켜 둔 채 현재 웹카카오 탭에서 Ctrl+Shift+R을 눌러 표시를 확인합니다. 계정·글꼴 확인을 위해 서버를 재시작하거나 QR을 새로 발급하지 않습니다. 계속 네모라면 글꼴 등록과 Chrome 캐시를 추가 확인합니다. 문자 인코딩을 일괄 변환하거나 locale을 먼저 바꾸지 않습니다. 후속 사용자 이미지에서 앱 본문과 탭 제목의 한글 표시가 정상으로 바뀐 것을 확인했습니다. 창 장식 제목에는 일부 네모가 남았으며, 전체 글리프·패키지 설치 상태를 확인한 것은 아닙니다.

소스 수정본의 전체 회귀 검사와 설치가 끝나면 아래 화면 검사만 추가합니다. 일반 사용자로 실행하며 `sudo`나 `--no-sandbox`를 붙이지 않습니다. 격리 프로필·합성 대화·loopback 서버를 사용하므로 QR 로그인이나 실제 발송은 필요하지 않습니다.

```bash
cd ~/web-kakao-linux-test &&
python3 tools/verify_linux.py --suite mock --browser
```

### VS Code 터미널에서 보이는 창 확인

위 `--browser` 검사는 **headless 자동 검사**이므로 Chrome 창을 화면에 표시하지 않습니다. 사용자는 WSL을 설치한 Windows PC에서 VS Code를 직접 사용 중이라고 확인했습니다. WSLg가 준비된 PC라면 VS Code의 WSL 터미널에서 실행한 Linux Chrome이 Windows 바탕화면에 표시될 수 있습니다([Microsoft WSL GUI 안내](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)). 실제 일반 창의 가용성은 아래 계정 없는 빈 페이지로 먼저 확인합니다.

```bash
gui_dir="$(mktemp -d /tmp/wkg-XXXXXX)" &&
TMPDIR="$gui_dir" google-chrome --no-first-run --no-default-browser-check --disable-background-networking --user-data-dir="$gui_dir/profile" about:blank
```

이 명령은 짧은 고유 임시 디렉터리와 별도 프로필을 사용하며 실제 카카오톡 로그인을 시작하지 않습니다. 창이 열리면 닫아도 됩니다. 열리지 않으면 오류 상태부터 확인하며 --no-sandbox·권한 변경·기존 개인 프로필 전환으로 통과시키지 않습니다. Remote/SSH에서 실행한 경우의 창 위치는 별도로 확인해야 합니다.

현재 `local_web.py open`은 검증한 서버에서 일회용 입장권을 받은 뒤 Linux 브라우저로 전달합니다. Windows 브라우저를 자동 실행하는 WSL 전용 연동은 아직 없습니다. Windows에서 WSL 서버에 localhost로 접근할 수 있다는 일반 기능([Microsoft 네트워크 안내](https://learn.microsoft.com/en-us/windows/wsl/networking#accessing-linux-networking-apps-from-windows-localhost))과 앱의 입장권 계약을 구분합니다. `http://127.0.0.1:8787` 주소만 열면 인증된 앱 화면에 입장할 수 있다고 안내하지 않습니다. 확인일: 2026-10-23.

### 첫 WSL 실행 결과와 수정본

2026-10-23 사용자 실행 결과입니다. Ubuntu WSL2·x86_64·Python3.14.4·Git2.53.0에서 Linux 홈에 소스를 풀어 준비했습니다.

| 항목 | 결과 | 근거와 제한 |
| --- | --- | --- |
| Linux 고정 Node24.21.0 tar 준비 | 검증 성공 | 공식 Linux x64 파일 다운로드·해시 일치·설치 완료를 사용자 출력으로 확인 |
| 최초 격리 mock 시작·종료 | 실패 | mock-start exit1, cleanup 종료 미확인. 이를 잔존 프로세스가 있다는 증거로 해석하지 않음 |
| 실패 원인 확인 | 검증 성공 | 사용자 읽기 전용 진단에서 Windows 전용 stat.IO_REPARSE_TAG_MOUNT_POINT 미존재와 is_junction AttributeError 확인 |
| fix1 후 WSL junction 회귀 | 검증 성공 | 사용자 실행5/5 통과, POSIX 속성 분리와 Windows tag 모의 검사를 포함 |
| fix1 후 WSL mock 시작·종료 | 실패 | mock-start 종료 코드2·cleanup 종료 미확인. 다른 같은 UID 프로세스의 FD readlink EACCES·fdinfo unavailable 확인. 대상 Node FD와 이미지는 접근 가능 |
| 대상 PID 검증 보완 후 WSL mock | 검증 성공 | 사용자 fix2 실행 JSON에서 mock-start/status/stop 각각 exit0, mockStopped=true, actualAccountUsed=false, browserExecuted=false 확인 |
| fix2 WSL platform의 Python 검사 | 검증 성공 | 공개 modern25·legacy213파일/작업 복사본 준비 후82+9+20=111개 전부OK |
| fix2 WSL platform의 Node 검사 | 실패 | 43총39pass/3fail/1skip/exit1. 공개 진단 모듈 누락에 의한2실패와 XDG 환경을 상속한 HOME 거절 fixture1실패. native 권한 시험도 잘못skip됨 |
| fix3 WSL platform 재검사 | 검증 성공 | 사용자 실행에서 Python82+12+20=114전부OK, Node45pass/실패0/skip0. native Linux 권한·하드링크 시험도 실행 성공. 최종7개check 모두exit0, mockStopped=true |
| fix3 WSL full의 Python 검사 | 실패 | 245총228pass/1fail/1error/15skip. Windows REA 합성시험의OS모의부재와역슬래시경로전제에서실패 |
| fix4 WSL full 전달본 범위 | 검증 성공 | Python전체exit0(건수 미제공), Node1033총1031pass/실패0/취소0/2skip. 최종5개check 모두exit0, mockStopped=true |
| fix4 시험 파일의 전달 완전성 | 부분 성공 | 저장소 Node 49파일 중 ZIP에는 48파일. 공개 reader-diagnostics.test.mjs의 8개 검사 누락을 fix5에서 보완 |
| fix5 WSL full 재검사 | 검증 성공 | Python 전체 exit0(정확한 건수 미제공), Node 1041총1039pass/2skip·실패/취소0. 최종5check 전부exit0·mockStopped=true·actualAccountUsed=false |
| Linux Chrome 설치·버전 확인 | 검증 성공 | 사용자 출력 Google Chrome 156.0.8078.47. 브라우저 시작 성공과 구분 |
| Linux 합성 화면 검사 | 실패 | mock --browser의 reader-browser-smoke.mjs:69에서 browser startup timeout·exit1. 실제 화면 단언에 진입하기 전 실패, Chrome stderr 미수집으로 원인 미확정 |
| 후속 격리 빈 페이지 진단 | 검증 성공 | 실패 원인 관측: Chrome exit-6·DevTools 파일 false·Socket path too long. 기존 긴 TMPDIR의 SingletonSocket 경로 초과 확인. 빈 페이지 실행 자체는 실패 |
| fix6 WSL 화면 재검사 | 검증 성공 | 사용자 JSON에서 mock-start/status/isolated-browser/stop 모두exit0, browserExecuted=true·mockStopped=true·actualAccountUsed=false. 화면 조건 건수는 미제공 |
| 일반 Linux Chrome 창·앱 열기 | 검증 성공 | 사용자 빈 Chrome 창과 후속 Web-Kakao 화면 이미지에서 일반 GUI 열림 확인. 실제 카카오 인증 성공과 구분 |
| WSL 한글 글꼴 표시 | 부분 성공 | 최초 앱 본문이 네모였으나 후속 사용자 이미지에서 본문·탭 제목 한글이 정상으로 표시됨. 창 장식 일부 글리프와 전체 설치 상태는 미확인 |
| Linux 실계정 조회 | 검증 성공 | 사용자가 시험한 방·사람 이름·대화 이력 조회 정상 보고. 모든 방·전체 과거 이력·사진·자연 수신·설정 복원으로 확대하지 않음 |
| Linux 실계정 입력·발송 | 실패 | 사용자가 일반/오픈 방 모두 글 입력 불가 보고. 10/24 사용자 status의 messaging=false로 읽기 전용 실행 원인 확인. 잘못된 사진 가능 문구는 UI 결함으로 별도 수정. 전송 모드 재개·실전 발송은 미실행 |

첫 AttributeError는 서버 로그 생성 후 검사에서도 Node 프로세스 생성 전에 발생할 수 있습니다. Windows reparse tag 비교와 POSIX 링크·권한 검사는 유지하며, 권한 완화·runtime 삭제·다른 Node 강제 종료로 해결하지 않습니다. 사용자 fix2 mock 성공은 다른 PC의 출력에 근거하며 이 에이전트 PC에서 Linux를 직접 실행한 결과는 아닙니다. 이번 mockStopped는 해당 시험 인스턴스의 정상 종료이고 과거 실패한 모든 인스턴스의 정리를 뜻하지 않습니다. 준비한 Linux 런타임은 유지합니다.

해당 상수의 Windows 적용 범위는 [Python3.14 stat 공식 문서](https://docs.python.org/3.14/library/stat.html#stat.IO_REPARSE_TAG_MOUNT_POINT)와 대조했습니다. 실제 오류 확인은 문서 추론이 아닌 위 사용자 진단 결과에 근거합니다.

fix1의 Windows 표적 검사는 junction5/5, 저장소15/15, verifier17/17, launcher29/29를 통과했고 독립 정적 검수5/5지문이 일치했습니다. 전체 Python2차는224건 중221통과·임시 Git fixture 정리 WinError145 1ERROR·2skip으로 **부분 성공**입니다. 첫 전체 검사에서도 같은 건수의 proc fixture 정리 오류가 있었고, 그 정리에만 제한 재시도를 보완했습니다. 두 실패를 보존하며 전체 검사 통과로 보고하지 않습니다. Windows 정리 오류의 근본 원인은 미확인입니다.

fix2의 Windows 계정 없는 표적 회귀는8개 파일·128건 중127통과·1skip(Python3.9 부재)·실패/오류0·exit0이며, 변경6파일의 시험 전후 SHA-256이 일치했습니다. 독립 정적 검수는 추가 지적0·현재6/6지문 일치입니다. 여기에는 Linux target 검증 모의44건과 verifier20건이 포함되며 별도 실행 건수를 합산하지 않습니다. 이 결과는 실제 WSL 실행 성공이나 fix1 전체 검사 실패의 해소를 의미하지 않습니다. Node·UI·브라우저 제품 파일은 이번 fix2에서 변경하지 않았으며 전체 Node/Chrome 검사를 재실행하지 않았습니다.

fix3는 공개 `experiments/local-web/reader-diagnostics.mjs`의 정확한 경로만 패키징 차단의 예외로 두고, 개인 진단 JSON/log와 Git 제외를 유지합니다. 패키지 표적 회귀12/12를 통과했습니다. HOME 거절 fixture는 XDG 입력을 명시하고 Linux 권한 시험의 skip을 Linux에서false로 고쳤습니다. 제품 경로 계산과 권한 단언은 유지했습니다. Windows에서 절대XDG 환경의 실패를 재현한 뒤 Node5파일45건 중44통과·실제Linux전용1skip·실패0·exit0을 확인했습니다. 이후 사용자 실제WSL에서 Python114·Node45가 모두 통과했고 새로 활성화한 권한·하드링크 시험도 skip 없이 성공했습니다. 사용자 제공 출력에 근거한 결과이며 이 에이전트 PC에서 Linux를 직접 실행한 것은 아닙니다.

fix4는 `tests/test_rea_pc.py`만 보완합니다. Windows 준비 성공 시험에 Windows/AMD64를 명시적으로 모의하고, 지원하지 않는 OS/CPU는 파일·다운로드·실행파일 탐색 전에 거절하는 회귀를 추가했습니다. 종료 명령은 모의 SystemRoot 아래의 전체 절대 경로와 PID/트리/강제종료 인자를 비교합니다. 제품의 Windows guard·실패 receipt·PID 재사용 방어는 유지합니다. Windows의 REA/CLI 합성 36개와 Linux 플랫폼 값 모의 2개가 통과했으며 2개는 36개의 부분집합입니다. 후속 사용자 WSL full은 전달된 시험 범위에서 Python exit0·Node 1,031개 통과/2개 건너뜀·mock 정상 종료를 확인했습니다. Python의 정확한 건수와 Node skip 2건의 개별 이름·사유는 미제공이라 추정하지 않습니다. Linux용 REA 분석 지원으로 확대하지 않습니다.

fix5는 공개 `tests/reader-diagnostics.test.mjs`도 정확한 경로로 패키지에 포함합니다. 개인 진단 파일과 Git 제외는 유지하며, 실제 Node 진입점 집합·바이트·manifest SHA를 검사하는 회귀를 추가했습니다. Windows 표적 전체 실행은 14건 중 13통과·임시 Git 폴더 정리 WinError145 1오류이며, 동일 소스의 해당 신규 회귀 1건 재확인은 통과했습니다. 부모의 별도 실제 ZIP 추출본에서는 Python 패키지 14개와 Node 진단 8개가 모두 통과했습니다. 이 후속 결과로 앞선 Windows 정리 오류를 해결했다고 판단하지 않습니다. 이후 사용자 실제 WSL full은 Node1041총1039pass/2skip·Python exit0·최종5단계exit0·mockStopped=true로 성공했습니다. Python 정확한 건수와 Node skip 개별 사유는 여전히 미제공입니다. 사용자가 전달 명령을 따라 실행한 결과이며 사용자 PC의 ZIP 해시를 별도로 측정한 것은 아닙니다.

Linux 화면 검사는 15초 동안 DevToolsActivePort를 찾지 못했습니다. 시험이 Chrome stderr를 버리고 조기 종료를 감시하지 않아 초기에는 원인을 알 수 없었습니다. 후속 사용자 격리 빈 페이지 진단에서 Chrome exit-6·DevTools 파일 false와 `Socket path too long`을 확인했습니다. 같은 격리 env의 긴 TMPDIR 아래에 생성되는 SingletonSocket이 문제였습니다. 함께 출력된 CPU cpufreq 파일 부재는 별도 원인으로 단정하지 않습니다. 브라우저 실패 실행의 mock 종료는 코드에 finally가 있으나 사용자 출력에 별도 성공 JSON이 없어 정상 종료를 확인했다고 보고하지 않습니다.

이 경로 오류는 Chromium 공개 소스 `process_singleton_posix.cc`의 `SetupSocket`이 긴 주소를 fatal 오류로 처리하는 경로와 일치합니다([공개 소스](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/process_singleton_posix.cc)). Linux pathname socket 주소는 끝의 NUL을 포함해 sun_path 108바이트 안에 들어가야 합니다([Linux unix(7)](https://www.man7.org/linux/man-pages/man7/unix.7.html)). 확인일: 2026-10-23. 공개 main 소스의 관측이며 설치된 Chrome156 바이너리와 동일한 소스 버전을 직접 대조한 것은 아닙니다.

fix6는 브라우저 검사 직전에만 env를 복사하고 TMPDIR을 `/tmp/wk-<random>` 형태의 새 전용 디렉터리로 바꿉니다. 표준 mkdtemp의 private0700과 기존 umask077을 사용합니다. HOME/XDG/프로필/화면 결과와 mock·Python·Node 검사의 env는 유지합니다. 기존 QA 자료와 같이 짧은 상위 임시 폴더도 보존하며 이번 수정에서 자동 재귀 삭제를 추가하지 않습니다. 할당 실패나 브라우저 실패는 실패로 남고 기존 인증된 mock 종료 finally를 거칩니다. 권한·sandbox·대기 시간을 바꾸지 않습니다.

fix6의 Windows 합성 표적 verifier 검사 25개는 모두 통과했습니다. 긴 경로의 소켓 후보 길이·env 복사와 다른 단계 보존·브라우저 미요청·임시 경로 할당 실패·브라우저 오류와 timeout 후 mock 종료를 확인했으며, 모든 프로세스는 모의했습니다. 이 검사는 실제 Linux Chrome 실행이나 화면 단언 통과를 뜻하지 않습니다.

이후 **사용자 실제 WSL의 fix6 화면 재검사도 성공**했습니다. 최종 JSON은 mock-start·mock-status·isolated-browser·mock-stop 각각exit0, browserExecuted=true, mockStopped=true, actualAccountUsed=false입니다. 원래 시작 오류는 시험한 WSL에서 해결됐습니다. 전체 화면 조건 수·동반 Python 표적 검사 건수·Chrome 자식 종료 기록·사용자 PC의 ZIP 해시는 제공되지 않아 별도로 성공을 추정하지 않습니다. 이번 mockStopped는 해당 인스턴스의 종료이며 과거 실패 인스턴스 전체의 정리 증거는 아닙니다. 이미 완료한 fix5 전체 회귀와 이번 브라우저 성공은 서로 다른 실행입니다.

WSLg·Linux headless Chrome 시험은 일반 Linux 데스크톱의 알림·클립보드·절전 동작 전체를 입증하지 않습니다. Windows Chrome과 WSL 서버의 연결 또한 Linux 브라우저 시험과 구분합니다.

## 실제 사용 전 조건

계정 없는 WSL 시험을 통과한 뒤에만 새 승인 범위로 QR·기기 등록·읽음·송수신·사진·설정 복원을 확인합니다. 기존 Windows 기기·세션을 자동 로그아웃하거나 이전 발송 승인을 재사용하지 않습니다. 기본 Linux 실행 명령 형식은 다음과 같으며 실제 로그인을 진행할 때 적용합니다.

```bash
python3 tools/local_web.py start --gap-probe --messaging
python3 tools/local_web.py open --browser chrome
python3 tools/local_web.py status
```

`--messaging`을 빼면 텍스트·답장·사진·읽음 통보가 비활성화됩니다. 최초 조회 시험의 `start --gap-probe`는 이 읽기 전용 모드입니다. 방별 사진 가능 안내만 보고 실제 발송 권한이 있다고 판단하지 않습니다. 오픈방은 전송 모드가 켜져 있어도 링크·참여정보·권한과 방별 capability를 충족해야 합니다.

fix7은 하단 안내에도 전역 전송 모드를 확인해 읽기 전용 상태에서 잘못된 사진 가능 문구를 표시하지 않습니다. 실제 권한·방별 제한·실행 모드는 바꾸지 않았습니다. Windows 합성 Chrome 표적 19조건에서 전역 OFF/누락·사진만 가능한 방·초안·전송 경고·요청 없음 등을 확인했습니다. 전역 상태는 UI 내부에 합성 주입했으므로 실제 서버를 messaging=false로 실행한 새 연결 실험은 아닙니다. 최초 sandbox Chrome 시작 timeout은 별도 보존했고 정상 실행 권한의 새 전용 프로필에서 exit0으로 통과했습니다. 사용자 WSL에 fix7 적용과 실전 전송은 미실행입니다.

다른 모드의 서버가 이미 실행 중이면 `start`는 기존 로그인과 서버를 유지하고 모드 변경을 거절합니다. 실제 모드값을 `status`의 `messaging`으로 확인합니다. 모드 변경은 사용자가 초안 보관·로컬 세션 정리 후 정상 stop/start/open을 하고 QR 승인을 새로 받는 절차입니다. 실계정 적용 전 변경 범위를 확인받고, 메시지·사진 발송과 읽음 통보는 별도 승인 범위로 유지합니다.

2026-10-24 사용자 status에서 messaging=false·phase=cancelled·credentialInMemory=false·chatConnectionActive=false를 확인했습니다. actualChatConnected=true는 과거 연결 성공 기록입니다. 현재는 인증과 대화 연결이 종료됐으므로 로컬 세션 삭제를 반복할 필요 없이 정상 stop으로 진행할 수 있습니다. 이 상태는 한 시점의 관측이므로 stop이 활성 인증/연결로 거절되면 강제 종료 없이 현재 상태를 다시 확인합니다. 전송 모드 재시작·본인 계정 QR1회·목록 확인 계획은 별도 사용자 확인 대기이며, 방 선택·읽음·발송을 포함하지 않습니다. 기존 전달본의 --messaging 옵션을 사용하며 새 ZIP 설치가 선행 조건은 아닙니다.

종료는 웹에서 초안을 보관하고 로컬 세션을 정리한 뒤 `python3 tools/local_web.py stop`으로 진행합니다. Linux에서도 PID·고정 Node 경로·같은 사용자·서버 HMAC 확인을 거친 뒤에만 로컬 제어 권한을 전달합니다. 파일 권한 검사를 제거하거나 TLS 검증을 끄지 않습니다.

## 범위

- Windows x64: 기존 경로·명령과 동작을 회귀 검사합니다.
- Ubuntu WSL2 x64: 계정 없는 전체 회귀·합성 headless 화면, 일반 GUI 열기와 사용자가 시험한 실제 방/이름/이력 조회 성공. 실전 송수신·읽음·데스크톱 통합 기능은 후속 확인합니다. 다른 Linux x64 glibc 환경은 별도 미검증입니다.
- macOS: 순수 경로 계산 준비 범위. 현재 실행은 명시적으로 차단하며, 브라우저·권한·계정 QA는 미실행입니다.
- Linux ARM64·Alpine/musl·배포판별 데스크톱 통합·EXE/MSI/DMG 배포는 이번 범위에 포함하지 않습니다.

fix1의 Linux 검사는 같은 UID 프로세스의 FD를 전수 열람했기 때문에 다른 프로세스의 접근 제한만으로도 실행이 막혔습니다. fix2는 Linux에 별도 대상 검증을 사용합니다. 기대 PID가 해당 포트의 IPv4/IPv6 모든 LISTEN inode를 보유해야 하며, 호출자 UID/eUID 일치·대상 proc 소유 UID·socket UID·전후 listener 집합·고정 Node 이미지·HMAC을 확인합니다. 대상 자신의 필수 FD 정보가 읽히지 않으면 계속 거절합니다. 기존 전수 소유자 조사 API와 Windows 경로는 유지합니다.

이 검사는 대상 PID의 보유 증명이며 독점 소유 증명은 아닙니다. 0700/0600은 OS 사용자 간 보호 경계이며, 같은 UID의 악성 프로세스나 별도 sandbox/LSM 간 격리를 보장하지 않습니다. 현재 Node가 HTTP listener/accepted FD를 다른 신뢰 주체에 전달하지 않는 실행 구조를 전제로 하며, PID/FD 재사용과 HTTP 요청 사이의 경쟁까지 원자적으로 막지는 않습니다. WSL의 실제 보안 설정에서 start/status/open/stop을 별도로 확인해야 합니다.

tar 설치의 원자적 비덮어쓰기 기능은 Linux glibc의 renameat2를 사용하며 사용자 첫 Node 설치는 성공했습니다. 경합·재설치·다른 배포판은 별도 검증 대상입니다.

Windows 보존 기준본은 커밋58a73a7의 소스 ZIP이며 `local-only/dist/web-kakao-windows-baseline-58a73a7-source.zip`에 보관합니다. 고정 런타임·공개 소스·npm 패키지 준비가 필요하고, 인증이나 실제 대화는 포함하지 않습니다.

## 이번 검증 결과

Windows 계정 없는 기존 회귀는 Node 1,040통과·1skip(총1,041), Python 전체 204통과·2skip(총206), 격리 Chrome 115조건 통과입니다. 이후 시험 2파일의 Windows 모의 범위·실제 브라우저 실행 차단만 보완하고 19/19 표적 재검사했습니다. 제품·Node·브라우저 불변을 대조해 이전 전체 결과를 재사용했으며 표적 19개를 전체 206개에 더하지 않습니다. 최초 ZIP 게시 후 임시 stage 정리 오류 1건은 이후 동일 9개와 전체에서 재현되지 않았지만 원인은 미확정으로 보존합니다. 사용자 WSL은 고정 Node 설치·fix2 mock·fix3 platform Python114/Node45·fix4 전달본 full에 이어 fix5 full과 fix6 격리 브라우저·mock4단계도 통과했습니다. 과거 화면 시작 실패와 TMPDIR 원인·수정 경과를 보존합니다. 후속 일반 GUI와 실계정 방/이름/이력 조회는 사용자 관찰 성공이며, Linux 실전 송수신·읽음과 macOS 실행 QA는 **미실행**입니다. Windows 임시 Git 정리 오류의 과거 실패와 fix5 표적 실행 오류도 따로 보존합니다.
