# 카카오톡 APK ZIP: 다른 개발 환경으로 옮기고 분석하기

작성·파일 확인: 2026-10-22. 프로젝트 루트는 `README.md`와 `AGENTS.md`가 있는 폴더입니다. 아래 경로와 명령은 모두 그 루트를 기준으로 합니다.

이 문서는 기존에 추출한 카카오톡 APK를 다른 PC에서 다시 분석하기 위한 안내입니다. 일반 웹 실행과 UI 수정에는 APK가 필요하지 않습니다. 읽음·사진·대화방 이름·오픈채팅의 Android 내부 동작을 확인할 때 사용합니다. 같은 파일을 정적으로 분석하려고 블루스택이나 카카오톡에 다시 로그인할 필요는 없습니다.

## 1. 어떤 ZIP인가

| 항목 | 확인 내용 |
| --- | --- |
| ZIP 이름 | `kakao-apks-20261017-015730-3d76f700.zip` |
| 크기 | 126,430,160 bytes, 약 120.6 MiB |
| 출처 | 기존 Windows PC의 BlueStacks에 설치된 카카오톡을 프로젝트 APK 추출 도구로 복사한 보관본 |
| Android 패키지 | `com.kakao.talk` |
| APK 버전 | `25.11.2` / versionCode `28251121` |
| 구성 | `base.apk` + 분할 APK 3개 + `apk-manifest.json` |
| 용도 | 로컬 REA/JADX 정적 분석의 입력 원본 |

현재 작업 폴더의 원본 ZIP 위치:

```text
local-only/bluestacks-apk-20261016-165646-3ea88484/apk-export-kit/output/kakao-apks-20261017-015730-3d76f700.zip
```

이 경로는 원본을 찾기 위한 위치입니다. 다른 PC에 같은 긴 폴더 구조를 만들 필요는 없습니다. ZIP 자체를 별도로 옮기면 됩니다.

ZIP 내부 파일:

| 파일 | 역할 | 크기(bytes) |
| --- | --- | ---: |
| `base.apk` | 앱의 기본 코드·리소스. 현재 Java/Kotlin 정적 분석의 주 입력 | 107466804 |
| `split_config.arm64_v8a.apk` | ARM64 기기용 구성·네이티브 리소스 | 61361046 |
| `split_config.hdpi.apk` | 화면 밀도별 리소스 | 3969619 |
| `split_config.ko.apk` | 한국어 리소스 | 1391148 |
| `apk-manifest.json` | 패키지·버전·각 APK의 크기/SHA-256·추출 작업 상태 | — |

네 APK를 같은 버전의 한 세트로 보존합니다. 현재 코드 조회는 `base.apk`에서 시작하지만, 리소스·네이티브 경로를 조사할 때는 분할 APK가 필요할 수 있습니다. `base.apk`만 옮겼다면 전체 설치 세트를 확보한 것으로 기록하지 않습니다.

2026-10-22에 ZIP을 읽어 네 APK의 실제 크기와 SHA-256이 내부 manifest와 모두 일치함을 확인했습니다. manifest는 설치 경로 전체 복사 완료와 해당 추출 작업의 로그인·앱 실행·앱 전용 데이터 읽기 미수행을 기록합니다. ZIP의 파일 목록도 위 5개뿐입니다. **서명 검증은 수행되지 않았습니다**(`signatureVerified: false`). 해시 일치는 보관본의 동일성을 확인하며 공식 배포 진위를 인증하지 않습니다.

## 2. 다른 환경으로 옮길 것

Git clone/pull은 `local-only/`를 가져오지 않습니다. 다음 자료는 USB 등 사용자가 관리하는 수단으로 별도 복사합니다.

| 구분 | 옮길 자료 |
| --- | --- |
| 필수 | 위 APK ZIP 1개. manifest와 분할 APK가 함께 들어 있음 |
| 기존 조사 이어보기 | `local-only/readbadge-apk-20261021/analysis/` |
| 코드 개발 | Git의 최신 제품 코드·테스트·README·프로젝트 스킬 |

기존 `analysis/`를 옮겼다면 `analysis-report.ko.md`, `input-verification.json`, `selected-source-index.json`, `selected-source/`, `result.json`을 먼저 확인합니다. 과거 경로·명령·해시·근거를 보존한 참고 자료이며, 새 PC에서 엔진이 준비됐다는 증거는 아닙니다. 옛 실행 장부·agent ID·실계정 승인을 재사용하지 않습니다.

새 PC의 권장 배치:

```text
web-kakao/
├─ README.md
├─ reports/
│  └─ APK_HANDOFF.ko.md
└─ local-only/
   ├─ apk-input/
   │  ├─ kakao-apks-20261017-015730-3d76f700.zip
   │  └─ kakao-25.11.2/                 # 아래 검증 후 압축 해제
   │     ├─ base.apk
   │     ├─ split_config.arm64_v8a.apk
   │     ├─ split_config.hdpi.apk
   │     ├─ split_config.ko.apk
   │     └─ apk-manifest.json
   └─ readbadge-apk-20261021/
      └─ analysis/                     # 선택적으로 옮긴 기존 근거
```

APK·원본 manifest·디컴파일 원본·분석 실행 기록은 Git에서 제외합니다. 공개 저장소나 외부 분석 서비스에 업로드하지 않습니다. 새 PC의 로그인 토큰·세션·개인 설정을 분석 자료와 함께 복사하지 않습니다. 이 안내 MD는 원본을 포함하지 않으며 코드와 함께 공유할 수 있습니다.

## 3. 옮긴 ZIP 확인 및 압축 해제

먼저 파일 탐색기 등으로 ZIP을 위 `local-only/apk-input/`에 복사합니다. 다음은 **Windows PowerShell**에서 프로젝트 루트로 이동한 뒤 실행하는 예제입니다. 기존 압축 해제 폴더가 있으면 덮어쓰지 않고 중단합니다.

```powershell
$apkZip = Join-Path (Get-Location).Path 'local-only\apk-input\kakao-apks-20261017-015730-3d76f700.zip'
$apkDir = Join-Path (Get-Location).Path 'local-only\apk-input\kakao-25.11.2'
$expectedZipHash = 'b4f51be212bd6081b3bdab745ba5886b715e9cb43e009d2c13aaf1439f9e847b'

if (-not (Test-Path -LiteralPath $apkZip -PathType Leaf)) {
    throw 'APK ZIP을 local-only/apk-input/에 먼저 복사하세요.'
}
if ((Get-Item -LiteralPath $apkZip).Length -ne 126430160) {
    throw 'ZIP 크기가 원본과 다릅니다.'
}
if ((Get-FileHash -LiteralPath $apkZip -Algorithm SHA256).Hash -ne $expectedZipHash) {
    throw 'ZIP SHA-256이 원본과 다릅니다. 분석을 중단하고 복사본을 확인하세요.'
}
if (Test-Path -LiteralPath $apkDir) {
    throw '압축 해제 폴더가 이미 있습니다. 기존 자료를 확인하고 새 폴더를 사용하세요.'
}
Expand-Archive -LiteralPath $apkZip -DestinationPath $apkDir
```

같은 PowerShell에서 APK별 manifest도 대조합니다.

```powershell
$apkManifest = Get-Content -LiteralPath (Join-Path $apkDir 'apk-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($apkManifest.package -ne 'com.kakao.talk' -or
    $apkManifest.versionName -ne '25.11.2' -or
    $apkManifest.versionCode -ne '28251121' -or
    @($apkManifest.files).Count -ne 4) {
    throw '예상한 카카오톡 APK 세트가 아닙니다.'
}
foreach ($apkEntry in $apkManifest.files) {
    $apkPath = Join-Path $apkDir $apkEntry.name
    if ((Get-Item -LiteralPath $apkPath -ErrorAction Stop).Length -ne [long]$apkEntry.bytes -or
        (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256 -ErrorAction Stop).Hash -ne $apkEntry.sha256) {
        throw "APK 무결성 확인 실패: $($apkEntry.name)"
    }
}
Write-Output 'ZIP 및 APK 4개 무결성 확인 완료'
```

ZIP을 다시 압축하면 APK가 같아도 ZIP 해시는 바뀔 수 있습니다. 위 고정 ZIP 해시가 다르면 원본 ZIP으로 확인하고, 다른 버전이나 새로 만든 ZIP은 별도 manifest·버전·해시를 가진 새 입력으로 취급합니다.

## 4. 분석 도구 준비

현재 저장소의 준비 도구와 REA wrapper는 **Windows x64·Python 3.11 이상·고정 Node 24.21.0** 기준입니다. macOS/Linux에서는 이 Windows 전용 명령을 그대로 실행하지 않습니다. APK 자체는 보존해 두고 해당 OS의 REA/JDK/JADX 준비와 경로·옵션 호환성을 따로 확인해야 합니다.

웹 실행 환경 준비는 [README](../README.md)를 따릅니다. APK 정적 분석만 준비할 때는 아래 순서를 사용할 수 있습니다. 최초 준비는 고정 공개 도구와 npm 패키지를 다운로드하므로 네트워크가 필요합니다. APK를 외부로 업로드하는 단계는 없습니다.

```powershell
py -3 --version
py -3 tools/prepare_node_spike.py
if ($LASTEXITCODE -ne 0) { throw 'Node 준비 실패' }

$analysisNode = Join-Path (Get-Location).Path 'local-only\runtime\node-v24.21.0-win-x64\node.exe'
$analysisNpm = Join-Path (Get-Location).Path 'local-only\runtime\node-v24.21.0-win-x64\node_modules\npm\bin\npm-cli.js'
& $analysisNode $analysisNpm install --prefix '.\local-only\rea' --ignore-scripts --save-exact rea-agents@6.5.0
if ($LASTEXITCODE -ne 0) { throw '프로젝트 내부 REA 설치 실패' }

py -3 tools/prepare_rea_android.py
if ($LASTEXITCODE -ne 0) { throw 'Android 분석 도구 준비 실패' }
py -3 tools/rea_local.py --help
```

`prepare_rea_android.py`는 프로젝트 내부에 JDK 21.0.12.1+1과 JADX MCP JAR 0.7.1을 준비하고 `local-only/rea-android/runtime.json`을 만듭니다. REA는 위 명령으로 프로젝트의 `local-only/rea/`에 설치합니다. 새 설치에서 만들어진 npm 잠금 파일도 해당 분석 환경의 준비 근거로 보존하세요.

`tools/prepare_rea_windows.py`는 Ghidra/JDK 준비용이며 위 APK/JADX 흐름의 필수 단계가 아닙니다. 현재 `--rea-only`나 `--jadx-only` 옵션은 없습니다. Android 준비 스크립트가 이 모듈의 압축 해제 함수를 가져와도 Ghidra 전체 준비를 실행하지는 않습니다.

다른 PC의 `runtime.json`에는 예전 절대 경로가 들어 있을 수 있으므로 새 환경에서 준비 도구로 다시 생성합니다. `local-only/` 전체나 기존 Windows 런타임을 통째로 옮겨 정상 동작한다고 가정하지 않습니다. 전역 REA/MCP 등록과 공식 앱 실행은 이 절차에 포함하지 않습니다.

## 5. 로컬 정적 분석 시작

프로젝트 규칙과 [Android 분석 스킬](../.agents/skills/kakao-android-analysis/SKILL.md)을 먼저 읽습니다. 에이전트가 작업한다면 부모가 분석 출력 경로와 REA/JADX 사용권을 배정하고 엔진 호출은 순차 진행합니다.

`--target`에는 **ZIP이 아닌 압축 해제한 `base.apk`**를 전달합니다. 아래 예제는 APK 설치·실행·로그인을 하지 않습니다. Windows PowerShell의 해당 프로세스에만 힙 설정을 적용하고 끝나면 복원합니다.

```powershell
$baseApk = Join-Path (Get-Location).Path 'local-only\apk-input\kakao-25.11.2\base.apk'
$analysisTag = Get-Date -Format 'yyyyMMdd-HHmmss'
$previousAnalysisHeap = [Environment]::GetEnvironmentVariable('REA_JADX_HEAP_MIB', 'Process')
try {
    $env:REA_JADX_HEAP_MIB = '4096'

    py -3 tools/rea_local.py doctor --label "apk-doctor-$analysisTag"
    if ($LASTEXITCODE -ne 0) { throw 'JADX 환경 점검 실패. 출력과 stderr를 확인하세요.' }
    py -3 tools/rea_local.py mcp-doctor --label "apk-mcp-$analysisTag"
    if ($LASTEXITCODE -ne 0) { throw '별도 MCP 점검 실패. 출력과 stderr를 확인하세요.' }
    py -3 tools/rea_local.py inspect-apk --target $baseApk --label "apk-inspect-$analysisTag"
    if ($LASTEXITCODE -ne 0) { throw 'APK 정적 조회 실패. 출력과 stderr를 확인하세요.' }
}
finally {
    [Environment]::SetEnvironmentVariable('REA_JADX_HEAP_MIB', $previousAnalysisHeap, 'Process')
}
```

이 APK는 기존 PC에서 기본 2GiB 힙으로 `Java heap space`가 났고, 해당 자식 JVM의 힙을 4096MiB로 설정해 조회했습니다. 현재 REA 6.5.0은 `REA_JADX_HEAP_MIB=4096`을 `-Xmx4096m`으로 전달합니다. 이는 힙 상한이며 JVM·네이티브 메모리가 추가로 필요합니다. 새 PC의 성공을 보장하는 수치는 아닙니다.

출력 위치:

```text
local-only/rea-evidence/<label>.json
local-only/rea-evidence/<label>.stderr.txt
local-only/rea-evidence/<label>-receipt.json
```

라벨은 ASCII 영문·숫자·`-`·`_`만 사용합니다. **같은 라벨은 기존 결과를 덮어쓰므로 매 실행 새 라벨을 사용하세요.** 기본값 `latest`는 재현 근거 보존에 사용하지 않는 편이 좋습니다. wrapper는 요청에 180초 제한을 두며, timeout 예외에서는 receipt가 생성되지 않고 부분 출력만 남을 수도 있습니다. JSON 본문·stderr·종료 코드·receipt 존재를 함께 확인합니다.

`doctor`의 JADX 준비, 별도 subprocess의 `mcp-doctor`, 현재 대화 세션의 직접 MCP 도구 노출은 별개입니다. 한 단계 성공으로 나머지 단계나 기능 전체를 성공 처리하지 않습니다.

패키지 조회 후에는 `search-class --target <base.apk> --query <검색어>`로 이 APK의 실제 클래스 이름을 찾습니다. `inspect-class`에는 `--class-name`, `inspect-method`에는 `--class-name`과 `--method-name`이 필요합니다. `references`는 클래스 필수·메서드 선택이며, 메서드 조회와 참조 조회는 확인한 `--overload-index`를 지정할 수 있습니다. 난독화된 클래스 이름을 다른 APK 버전에 그대로 재사용하지 않습니다. 새 조회도 메모리 설정을 적용한 별도 실행 범위와 새 라벨로 진행합니다.

## 6. 무엇을 비교하면 좋은가

| 조사 대상 | APK에서 추적할 흐름 | 대조할 웹 코드 |
| --- | --- | --- |
| 본인 안 읽음 배지 | 본인/타인 읽음 구분 → 읽은 위치 → 방 미읽음 집계 → 목록 갱신 | `reader-data.mjs`, `reader-session.mjs`, `reader-manager.mjs`, `reader-room-state.mjs` |
| 상대방 읽음 숫자 | 방 진입·전경·최신 위치 → 읽음 통보 → 타인의 읽음 위치 | 위 모듈과 `app.js` |
| 사진 | 파일 준비 → 업로드 → 완료 → 메시지 등록 | `media-upload-https.mjs`, `media-upload.mjs`, `reader-session.mjs` |
| 이름·오픈채팅 | 제목/참가자/링크 → 본인 역할·권한 → 기능별 요청 | `reader-data.mjs`, `reader-session.mjs` |

웹 모듈의 기본 경로는 `experiments/local-web/`입니다. 조사 시 현재 Git 커밋과 미커밋 변경, APK 버전·해시, 파일/클래스/메서드·근거 위치를 함께 기록합니다. 결과는 확인된 사실·추론·미확인 가설로 구분합니다.

10/21 분석에서는 Android가 본인 `DECUNREAD`로 방 미읽음 집계를 갱신하는 경로와 웹의 본인 배지 연결 누락을 확인했습니다. 이후 웹의 배지·재연결 처리를 보완했으며 최신 수정·합성 검사와 실제 사용자 확인 상태는 [README](../README.md)를 우선합니다. **APK 25.11.2와 웹 접속 프로필 26.1.2는 다른 버전**입니다. 이 ZIP만으로 현재 서버 동작이나 모든 플랫폼의 일치를 확정하지 않습니다.

정적 분석은 실제 앱 실행 경로 전체·모바일 수신·상대방의 읽음 `1` 해제·사진 도착의 증거가 아닙니다. 디컴파일 경고, 네이티브 경로, 분할 APK 누락, 버전 차이와 미관측 범위는 보고서에 남깁니다. 실제 로그인·공식 앱 실행·연결 기기 변경·읽음·발송은 대상·내용·횟수·영향을 설명한 별도 사용자 확인 후 진행합니다.

## 7. 재추출할 때와 새 작업 인계

이 ZIP과 같은 버전의 분석을 이어간다면 재추출하지 않아도 됩니다. 새 카카오톡 버전과 비교하거나 필요한 분할 APK가 빠졌거나 파일 무결성이 맞지 않으면 [APK 추출 안내](../tools/apk_export/README.ko.md)를 따라 새 세트를 확보합니다. 새 버전은 별도 폴더·manifest·해시로 관리하고 기존 보관본을 대체하지 않습니다. PC 카카오톡 EXE는 Android APK의 대체 입력이 아닙니다.

다른 환경의 작업자에게는 아래처럼 인계할 수 있습니다.

```text
reports/APK_HANDOFF.ko.md와 AGENTS.md를 먼저 읽어 주세요.
사용 권한 있는 기존 APK ZIP을 local-only/apk-input/에 별도로 복사했습니다.
문서의 ZIP/manifest 무결성을 확인하고, APK25.11.2를 현재 웹 소스와 비교해
[조사할 기능/증상]을 로컬 정적 분석해 주세요.
기존 analysis/는 참고 근거이며 새 환경의 도구·경로·엔진 사용권을 다시 확인하세요.
새 라벨과 비공개 출력 경로를 사용하고 원본·이전 결과를 덮어쓰지 마세요.
실제 로그인·앱 실행·읽음·메시지/사진 발송이나 APK 외부 업로드는 진행하지 마세요.
```
