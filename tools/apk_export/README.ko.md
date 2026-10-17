# 다른 Windows PC에서 카카오톡 APK 가져오기

이 도구는 Android 기기·에뮬레이터에 설치된 `com.kakao.talk`의 APK 전체를 복사합니다. 카카오톡 로그인은 필요하지 않습니다. Windows PC용 카카오톡 EXE는 이 도구의 대상이 아닙니다.

여기서 **연결**은 추출 키트의 `run.cmd`가 ADB로 Android에 접속한다는 뜻입니다. 같은 PC의 BlueStacks라면 `Windows 추출 도구 → 블루스택에 표시된 로컬 ADB 주소 → 가상 Android의 설치 APK` 순서입니다. BlueStacks의 ADB를 켜고 저장한 뒤 그 인스턴스를 켜둡니다. 카카오톡을 열거나 카카오 계정으로 로그인할 필요는 없습니다. 주소·포트는 해당 PC 설정에서 확인하며 고정 값으로 가정하지 않습니다.

1. 이 압축을 다른 PC의 일반 폴더에 전부 풉니다. 압축 안에서 바로 실행하지 않습니다.
2. 사용 권한 있는 Android 에뮬레이터를 켜고 Google Play에서 카카오톡을 설치합니다. 카카오톡 로그인은 하지 않아도 됩니다.
3. 해당 에뮬레이터의 공식 설정에서 ADB 연결을 사용할 수 있게 합니다. 제품별 설정 위치·포트가 다릅니다. 실제 Android 기기라면 USB 디버깅과 이 PC의 연결 허용을 확인합니다.
4. `run.cmd`를 실행합니다. 연결된 기기가 하나라면 자동으로 선택하고 여러 개라면 선택을 요구하며 중단합니다.
5. 완료되면 `output` 안의 `kakao-apks-....zip`만 분석 노트북으로 가져옵니다. 이 ZIP에는 APK와 버전·SHA-256 목록만 들어갑니다.

프로그램은 Google 공식 Platform-Tools37.0.1 ZIP과 실행 파일·DLL의 SHA-256을 확인한 뒤 사용합니다. Python·Node·Android Studio·관리자 권한 설치는 필요하지 않습니다. `run.cmd`는 현재 PowerShell 프로세스에서 이 스크립트를 실행하며 사용자·시스템의 실행 정책 설정을 저장해 바꾸지 않습니다.

## 기기가 안 잡힐 때

에뮬레이터가 안내한 ADB 주소가 `127.0.0.1:포트`라면, 이 폴더에서 다음 형식으로 실행합니다. 포트는 제품 설정에서 확인한 실제 값으로 바꾸며 임의 포트 검색은 하지 않습니다.

```powershell
.\run.cmd -AdbEndpoint 127.0.0.1:설정에_나오는_포트
```

기기가 여러 개면 준비된 `platform-tools\adb.exe devices`로 목록을 확인하고 본인 대상의 식별자를 지정합니다. 이 식별자를 채팅에 보낼 필요는 없습니다.

```powershell
.\run.cmd -DeviceSerial 대상_식별자
```

`unauthorized`면 Android 화면의 디버깅 허용을 확인합니다. 패키지 경로를 찾지 못하면 Android 안에 카카오톡이 설치됐는지 확인합니다. 접근이 거부되면 중단하며 루팅·권한 우회·앱 제거·재로그인을 수행하지 않습니다.

## 복사 범위와 한계

- 읽는 대상은 `pm path com.kakao.talk`가 반환한 설치 APK와 해당 패키지의 버전 메타데이터입니다. 대화 DB·로그인 토큰·클립보드·사진첩은 읽지 않습니다.
- `base.apk`와 분할 APK를 함께 복사합니다. APK 서명·공식 배포 진위는 이 도구가 검증하지 않으며 추출 후 분석 시 별도 확인 대상입니다.
- 카카오톡 실행·계정 로그인·메시지 발송·앱 설치/삭제·루팅 명령은 없습니다. 기기 연결에는 ADB 서버가 사용됩니다.
- 기기·에뮬레이터 정책에 따라 설치 파일 읽기가 거부될 수 있습니다. 이 경우 나온 오류 종류와 에뮬레이터 제품명만 알려주세요.

공식 근거: [ADB 연결·pm path·pull](https://developer.android.com/tools/adb), [Platform-Tools 배포](https://developer.android.com/tools/releases/platform-tools).
