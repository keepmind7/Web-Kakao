# 사진 발송 방식의 계정 없는 모델

```powershell
& .\local-only\runtime\node-v24.21.0-win-x64\node.exe .\experiments\photo-method-simulation\run.mjs
```

프로젝트 루트에서 실행하면 결정적인 합성 사례와 결과를 JSON으로 출력한다.
Node 기본 모듈만 사용하며 네트워크·계정·사용자 사진·OS 공유창에 접근하지 않는다.
`model.mjs`의 공개 API와 주입 함수 계약은 [API.md](API.md)에 설명되어 있다.

| 후보 | 이 실험에서 확인하는 범위 |
| --- | --- |
| 현재 LOCO | SHIP/POST/file/COMPLETE의 의미 상태 모델. 실제 SDK wire 검사는 별도 QA 소유 |
| HTTP 업로드 후 WRITE | 구형 공개 소스에서 유도한 가설 모델. 업로드 자산과 메시지 등록 분리 |
| 구형 CFB / GCM | Node 암호 모듈의 합성 왕복·프로필 불일치·인증 경계만 검사 |
| 공식 API | 나에게/친구 이미지 템플릿의 대상·동의·부분 실패 모델. 네이티브 사진 아님 |
| Web Share | 지원 여부·사용자 활성화·취소·handoff 모델. 실제 앱/방/도착은 미확인 |

HTTP 응답의 `fixture-asset:*` 경로는 합성 문법이다. 현재 서비스 경로와 PHOTO
metadata 조합은 검증하지 않았다. 요청별 `{path,s,sha256}`를 고정한 뒤 최소
`type:2` 등록의 `extra:{path,s}`와 연결하고, ACK가 명시한 상관 필드 불일치는
불명확 상태로 처리한다. 이는 구형 소스에서 유도한 의미 모델이며 현재 PHOTO
extra/BSON 계약이 아니다. 유효한 경로 수신만으로 서버의 경로와 실제 바이트
연결을 인증하거나 악의적인 경로 바꿔치기를 검출할 수 없다.
JPEG fixture는 삽입된 COM 구간을 포함한 고정
합성 이미지이며 크기·SHA-256을 기록한다. 입력 검사에서는 헤더/끝 표식·MIME·확장자를
대조할 뿐 전체 이미지 디코더로 검증하지 않는다. TLS, 실제 SDK의 HTTP 요청, 실제
서비스 호환성, CFB 하향 전환, 실제 사진 발송·도착은 모두 미실행이다.
암호 실험은 고정된 22바이트 합성 평문에 한정되며 사진 크기 프레이밍은 검사하지 않는다.
러너의 COMPLETE 거절은 스트림 후 응답 모델이며 쓰기 중 조기 응답 재현이 아니다.

확인일 2026-10-19. 공개 근거:

- 구형 node-kakao 4.5.0 고정 커밋
  [`8512e4699e2cd4c26516b80d38b57b2f85a6cc8a`](https://github.com/storycraft/node-kakao/tree/8512e4699e2cd4c26516b80d38b57b2f85a6cc8a):
  `src/api/attachment-api-client.ts`, `src/talk/channel/talk-channel-session.ts`,
  `src/crypto/node-crypto-store.ts`. HTTP PHOTO 현행 성공 근거는 없음.
- [Kakao Share JavaScript](https://developers.kakao.com/docs/latest/ko/kakaotalk-share/js)
- [카카오톡 메시지 REST API](https://developers.kakao.com/docs/latest/ko/kakaotalk-message/rest-api)
- [Web Share 명세](https://www.w3.org/TR/web-share/)

부모가 고정한 조사 보고서는 `.harness/photo-methods-20261019/`에 있으며, 이 폴더의
모델 성공을 현재 실패 중인 실제 웹 사진 전송의 해결로 해석하지 않는다.
