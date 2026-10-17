# 다른 PC의 카카오톡 설치본 분석 준비

확인일: 2026-10-17. 분석을 위해 접속한 Windows PC에서 KakaoTalk.exe 26.8.1.5315를 확인했다. 26,836,584바이트, native x86 PE32이며 Authenticode 관측은 Valid다. 원본과 분석 복사본의 SHA-256은 `5ca2a6607df8435afecc130f870308dad2f7eb70c57541aa4c7dcbf6b7e96a0b`로 일치한다. 설치본 실행·로그인·대화 DB 수집은 하지 않았다.

Windows EXE/DLL의 정적 분석은 Android APK 외의 조사 경로다. 앱 실행·로그인 없이 파일의 형식과 호출 경로를 조사할 수 있다. PC 프로토콜의 결과가 현재 웹의 Android 태블릿 접속 프로필에도 적용되는지는 따로 확인해야 한다.

## 현재 분석 범위와 재사용 도구

REA6.5.0·Ghidra12.1.4·Temurin JDK21.0.12.1을 프로젝트 안에 준비했다. Ghidra provider doctor와 별도 로컬 stdio MCP doctor가 종료 코드0으로 통과했고, MCP 도구207개를 확인했다. provider 범위의 `healthy: true`이며 다른 provider·전역 연동을 포함한 전체 환경 성공을 뜻하지 않는다. 현재 채팅의 직접 REA MCP 바인딩과도 별개다.

합성 PE의 `RET` 함수 분석을 확인한 뒤 실제 카카오톡 복사본의 리소스 파싱·Ghidra import·함수/문자열 목록·진입점 디컴파일을 실행했다. 실제 입력의 기본 분석은 함수33개(외부31개·내부2개), 정의된 문자열117개를 반환했다. 진입점 `0x3d2e058`의 어셈블리·의사 코드와 내부 함수 호출은 확인했지만, 읽음·사진·방 이름·오픈채팅의 기능 호출 경로는 확보하지 못했다. 원본 앱은 실행하지 않았다.

EXE에는 `.themida`, `.vm_sec`, `.boot`와 공백 이름 섹션이 있다. 지정한 프로토콜·오픈링크 리터럴21개의 ASCII/UTF16LE/UTF16BE 원시 검색은 모두0건이고, Ghidra가 정의한 문자열에서도 관련 패턴을 찾지 못했다. 진입점에는 바이트 복사·비트 처리 반복이 보인다. 보호·패킹을 시사하지만 정확한 방식·복원 가능성은 미확인이다. 기능이나 프로토콜이 없다는 뜻도 아니다. 다음 조사는 보호된 코드의 정적 복원 가능성·추가 설치 모듈·권한 있는 Android APK 등에서 실제 기능 경로를 확보하는 것이다.

| 검사 | 판정 | 확인 범위 |
| --- | --- | --- |
| 도구 준비·Ghidra/MCP doctor | 검증 성공 | 고정 ZIP 해시, 오프라인 재검사, 선택한 provider·별도 MCP |
| 합성 PE 함수 분석 | 검증 성공 | 엔진의 실제 디컴파일·정상 종료 |
| 카카오톡 EXE 정적 분석 | 부분 성공 | 리소스·import·목록·진입점 분석 성공, 기능 경로 미확보 |
| 준비·실행기 합성 검사 | 검증 성공 | Python3.13.7에서24개 통과, 독립 코드 검수 통과 |
| 웹 기능 수정·실계정 확인 | 미실행 | 이번 차수는 분석 환경과 도구 수정이며 제품 기능 해결을 뜻하지 않음 |

- `tools/prepare_rea_windows.py`: 공식 Ghidra12.1.4·Temurin JDK21 ZIP을 고정 SHA-256으로 검증하고 경로를 검사한 뒤 `local-only/rea-windows/runtime.json`을 만든다. `--offline`은 이미 받은 검증된 ZIP만 재사용한다. 전역 Java·PATH·Codex 등록은 바꾸지 않는다.
- `tools/rea_pc.py`: `doctor`, `mcp-doctor`, `capabilities`, `analyze`, `search`, `function`, `xrefs`만 제공한다. native 질의는 `local-only/pc-analysis/` 안의 EXE/DLL 복사본과 인접 manifest의 경로·SHA-256을 검증한다. 원본 설치 경로를 바로 전달하지 않는다.
- stdout·stderr·실제 종료/시간 초과 receipt는 `local-only/rea-evidence/pc/`에 보관한다. 매번 새 라벨을 사용하며 기존 결과를 덮어쓰지 않는다. 구조화된 실패는 종료 코드0이어도 성공으로 기록하지 않는다.

Python3.11 이상과 호환 Node가 필요하다. 이 PC에는 전역 변경 없이 Python3.13.7을 프로젝트 아래 준비했다. 다른 clone에는 런타임·도구·복사본·manifest가 이전되지 않는다. 아래 대상은 이 세션에서 사용권을 확인하고 이미 만든 복사본이다. 새 입력은 먼저 파일·버전·해시·사용권을 확인한다.

```powershell
$python = './local-only/runtime/python/cpython-3.13.7-windows-x86_64-none/python.exe'
npm.cmd install --prefix ./local-only/rea --cache ./local-only/npm-cache --ignore-scripts --no-audit --no-fund --save-exact rea-agents@6.5.0
& $python -B -X utf8 tools/prepare_rea_windows.py
& $python -B -X utf8 tools/rea_pc.py doctor --label UNIQUE_DOCTOR
& $python -B -X utf8 tools/rea_pc.py mcp-doctor --label UNIQUE_MCP
& $python -B -X utf8 tools/rea_pc.py analyze --target ./local-only/pc-analysis/kakaotalk-26.8.1.5315/KakaoTalk.exe --label UNIQUE_ANALYSIS
& $python -B -X utf8 tools/rea_pc.py search --target ./local-only/pc-analysis/kakaotalk-26.8.1.5315/KakaoTalk.exe --query NOTIREAD --label UNIQUE_SEARCH
```

예시 라벨은 고유 값으로 바꾼다. manifest의 `analysis_copy`는 프로젝트 상대 POSIX 경로, `sha256`은 복사본의 원시 SHA-256이다. 함수·참조 주소는 해당 바이너리에서 실제 반환된 값만 사용한다. 단순 바이트 주소를 함수로 추정하지 않는다.

이 PC의 Codex 기본 샌드박스에서는 REA의 상위 경로 메타데이터 검사에 Windows325 오류가 났다. 제한된 샌드박스 밖 실행에서 doctor와 실제 분석을 확인했다. 일반 Windows 터미널의 프로젝트 루트에서 위 명령을 사용할 수 있으며, 관리자 실행이나 전역 ACL 변경을 요구하는 뜻은 아니다. 준비 과정에서 발견한 공개 도구 설치 폴더의 권한 상속 문제는 수정했고, 새 합성 설치물의 다른 실행 계정 접근도 확인했다. REA의 비공개 세션 폴더 권한은 완화하지 않았다.

시간 초과는 실패로 남긴다. 소유한 살아 있는 Node 트리만 종료를 시도하며, Node가 먼저 끝났다면 하위 도구 정리는 미확인이다. 이 상태를 엔진 사용권 해제 증거로 쓰지 않는다. 엔진 준비·합성 PE 검사·실제 PC 코드 분석·실계정 동작 판정을 분리한다.

## 1. 파일·버전·해시 확인

본인 소유 또는 분석 권한이 있는 설치본을 사용한다. PowerShell에서 아래 경로를 실제 설치 위치로 바꾼다. 앱을 실행하는 명령은 없다.

```powershell
$kakaoExePath = (Resolve-Path -LiteralPath '설치폴더\KakaoTalk.exe').Path
$kakaoExeFile = Get-Item -LiteralPath $kakaoExePath
$kakaoExeFile | Select-Object Name, Length,
    @{Name='ProductVersion'; Expression={$_.VersionInfo.ProductVersion}},
    @{Name='FileVersion'; Expression={$_.VersionInfo.FileVersion}}
Get-FileHash -LiteralPath $kakaoExePath -Algorithm SHA256 |
    Select-Object Algorithm, Hash
```

먼저 파일명·버전·크기·SHA-256만 전달하면 분석 범위를 정할 수 있다. 설치 경로에 사용자 이름이 들어가면 경로는 생략한다. 이 정보만으로 분석 완료나 배포 진위를 판단하지 않는다.

## 2. 분석 입력과 도구

- EXE와 필요한 설치 DLL만 별도 로컬 분석 폴더에 보존한다. 사용자 프로필의 카카오톡 데이터 폴더, 로그인 저장 파일, 대화 DB, 메모리 덤프는 수집 대상이 아니다.
- 원본 해시를 유지하고 복사본에서 분석한다. 파일은 저장소·외부 분석 서비스에 올리지 않는다. 다른 PC에서 분석한다면 결과는 함수·모듈·호출 경로와 민감정보 없는 구조 설명만 인계한다.
- REA의 Windows 네이티브 분석 엔진 지원, Ghidra 등 필요한 엔진 설치, CLI·MCP 호출과 해당 역할의 접근 가능 여부를 실제 확인한다. 이 프로젝트의 과거 REA/JADX 시험 성공은 Windows 카카오톡 EXE 분석 성공을 뜻하지 않는다.
- 이 노트북에서 현재 세션에 직접 노출된 REA/JADX 전용 MCP 도구는 확인되지 않았다. 설치본 입력·엔진 점검·샘플 분석·실제 카카오톡 분석은 별도 단계로 기록한다.

## 3. 조사할 항목

| 항목 | 확보하려는 근거 | 완료 판정의 한계 |
| --- | --- | --- |
| 읽음 | 방 진입·본인 읽음 위치·상대방 통보의 함수와 순서 | ACK만으로 상대방 화면의 `1` 해제를 판단하지 않음 |
| 사진 | 업로드 연결·프레임·파일 바이트·완료·메시지 생성 경로 | 업로드 수락과 수신 기기의 사진 도착을 구분 |
| 방 이름 | 서버 제목·개인 제목·참가자·오픈링크 우선순위 | 웹 별칭과 원래 제목을 구분하고 같은 방인지 확인 |
| 오픈채팅 | 방 종류·링크 관계·권한·기능별 요청 경로 | 텍스트·답장·사진·읽음을 각각 확인 |

실행 관찰이 필요해지면 대상 PC·계정·방, 작업 내용·횟수, 연결 기기에 미칠 영향을 먼저 정하고 사용자 확인을 받는다. 정적 파일 제공은 공식 앱 실행·로그인·읽음 통보·발송을 승인한 것으로 취급하지 않는다.

## 인계에 필요한 내용

분석 일자, 앱 버전·SHA-256, 엔진 버전, 관련 모듈·함수·호출 경로, 재현 절차, 실제 실행한 검사와 종료 코드, 확인된 사실·추론·미확인 가설을 기록한다. 계정 ID·토큰·키·대화 원문은 포함하지 않는다.

현재 제품 상태와 로컬 실행은 [프로젝트 README](../../README.md)를 기준으로 한다. Android 분석 경로는 [APK 추출 안내](../apk_export/README.ko.md)를 따른다.
