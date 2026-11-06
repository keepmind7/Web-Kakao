# 오픈채팅 답장 -203 원인 조사

확인일: 2026-11-06. 판정: **부분 성공**. 실제 거절 단계와 요청 구성의 빈틈은 확인했으나, 서버가 거절한 정확한 필드는 미확정임. 제품 코드·실행 서버·로그인·연결 기기 변경과 실제 메시지 발송 없음. 기존 11/05 보강 변경은 보존함.

## 확인된 실패 단계

사용자는 1,000명 이상인 오픈단체방에서 답장 전송 시 `서버가 전송 요청을 거절했습니다. (코드 -203)`을 관측함. 해당 방에서 일반 텍스트가 성공하는지, 답장 원본의 종류는 이번 조사에서 아직 확인되지 않음.

로컬의 최신 정제된 송신 진단을 읽기 전용으로 대조한 결과:

```text
kind: reply
start → write_attempt(writeAttempted=true)
response(status=-203, elapsedMs=7)
result(phase=failed, reason=write_rejected)
```

같은 정제 진단의 WRITE 응답은 packet status 0 / body status -203임. 앞단 입장 문맥 확인이나 로컬 UI에서 막힌 요청이 아니라 **서버에 보낸 답장 WRITE의 거절**과 일치함. 진단은 마지막 송신을 덮어쓰는 구조이고 방·원본 식별자를 저장하지 않으므로, 사용자 사건과의 연결은 최근 시점·답장 종류·같은 오류 코드에 근거함. 개별 방을 식별자로 대조한 것은 아님.

고정 공개 SDK의 [KnownDataStatusCode](https://raw.githubusercontent.com/storycraft/node-kakao/8512e4699e2cd4c26516b80d38b57b2f85a6cc8a/src/request/index.ts)는 -203을 INVALID_PARAMETER / INVALID_BODY로 분류함. 현재 카카오 서버의 공식 코드표는 아니므로 정확한 누락 필드나 계정 차단을 이 값만으로 확정할 수 없음.

## 요청 경로와 원인 후보

| 구간 | 확인 내용 |
| --- | --- |
| 브라우저 → 로컬 서버 | `app.js:1013`, `server.mjs:324`: 사용자가 선택한 원본의 opaque `replyTo` 키만 전달. 원본 작성자·로그 ID는 브라우저가 지정하지 않음 |
| manager → worker | `reader-manager.mjs:175`, `reader-worker.mjs:65`: 현재 방 페이지의 원본·권한 확인, 중복 방지 해시에 replyTo 포함 |
| 원본 구성 | `reader-data.mjs:219–231,484`: 캐시에서 `{id,authorId,type,text}`만 구성하여 `replyExtra`에 전달 |
| 답장 추가 정보 | `message-content.mjs:10–14`: src_logId, src_userId, src_type, src_message, src_mentions:[], attach_only:false 생성. **src_linkId를 생성하는 경로 없음** |
| WRITE | `reader-session.mjs:534`: 일반 글은 type 1, 답장은 type 26 + extra. chatId·msgId·scope·silence 등 나머지 형식은 공통 |
| 결과 | `reader-response.mjs:3`, `reader-session.mjs:540`: body -203을 보존하고 실패 처리. 실패를 성공으로 표시하거나 자동 재발송하는 경로 없음 |

### 우선 후보: 오픈채팅 답장의 링크 문맥 누락

현재 답장 구조에는 방 링크를 넣을 자리가 없으며, 오픈방도 일반방과 같은 추가 정보를 보냄. 공개 node-kakao의 [ReplyAttachment](https://raw.githubusercontent.com/storycraft/node-kakao/8512e4699e2cd4c26516b80d38b57b2f85a6cc8a/src/chat/attachment/reply.ts)에는 optional `src_linkId` 선언이 존재함. 다만 그 고정 소스에는 생성·소비 구현이 없어, 선언만으로 값의 의미나 필수 여부를 결정할 수 없음.

공개 [이슈 #347](https://github.com/agent-messenger/agent-messenger/issues/347)은 공식 앱에서 수신한 오픈채팅 답장에 방 링크 ID가 들어 있었다는 작성자의 관측을 기록함. [PR #348](https://github.com/agent-messenger/agent-messenger/pull/348)은 방의 li를 src_linkId에 넣는 변경을 설명함. 해당 사례의 증상은 status 0 / logId 0이며 이번 -203과 동일하지 않음. PR도 수정 후 실제 발송은 미검증이라고 명시하므로, 관련성이 높은 후보 근거로만 사용함. 최종 head `9b45695ad84775b2bfee31b056e52f9402f3d557`의 raw 코드는 취득 실패하여 구현 전체를 독립 대조한 것으로 보고하지 않음.

따라서 **src_linkId 누락이 우선 조사 대상**임. 현재 Android 태블릿 프로필의 카카오 서버가 이 필드를 요구하는지, 요구하는 값이 검증된 방 li인지까지 이번 조사에서 입증한 것은 아님. NOTIREAD의 li를 근거로 WRITE 최상위에 li를 추가하는 것도 근거 부족임.

### 추가 후보: 원본 메시지 정보의 손실

- `replyTarget.text`는 표시용 `text(log)`를 사용함. 사진·사진 모음은 `[사진]`·`[사진 모음]`으로 치환되고 문자 정리·길이 제한이 적용됨.
- `src_mentions`는 원본과 관계없이 빈 배열임. 고정 SDK의 [ReplyContent.append](https://raw.githubusercontent.com/storycraft/node-kakao/8512e4699e2cd4c26516b80d38b57b2f85a6cc8a/src/chat/content/reply.ts)는 원본 멘션을 복사하므로 계약 차이 존재.
- 원본 type 누락 시 type 1로 취급함. 원본 종류에 따라 참조 유형이 달라질 가능성은 있으나 이번 원본의 실제 종류는 미확인임.

이 차이들이 이번 거절의 직접 원인인지는 미확인. type 26은 답장, 27은 사진 모음이며, 27을 오픈방 유형으로 해석하지 않음.

### 인원수와의 관계

로컬 roster 500명 제한은 이름 보강 범위이고 receipt 100명 제한은 읽음 집계 완전성 조건임. 답장 원본 작성자는 캐시 로그에서 직접 읽으며, 전송 권한은 검증된 본인 멤버·링크·역할·쓰기 제한에 따라 결정됨. **1,000명 이상이라는 이유로 답장을 거절하는 로컬 분기는 발견하지 못함.** 실제 서버의 규모별 정책은 이번 검사 범위 밖임.

## 계정 없는 검증

| 항목 | 결과 | 한계 |
| --- | --- | --- |
| 최신 정제 진단 대조 | 검증 성공 | 최근 답장 WRITE -203 확인. 원본 ID·방·본문은 읽거나 기록하지 않음 |
| 요청 캡처·BSON 확인 | 검증 성공: 12개 조합 | DirectChat/OM × 합성 인원 2/1,200명 × 일반 글/텍스트 원본 답장/사진 원본 답장. 외부 소켓 없음 |
| 기존 관련 회귀 | 검증 성공: 88개, 실패·건너뜀 0 | 실제 서버가 아닌 주입된 응답 사용 |
| 정확한 거절 필드 결정 | 부분 성공 | 누락·원본 손실과 외부 사례 확인. 현재 서버의 필수 필드 계약 미확정 |
| 수정 후 실제 오픈방 답장 도착 | 미실행 | 제품 수정·실제 발송 없음 |

12개 합성 조합에서 인원수에 따른 요청 구조 차이는 없고, 모든 답장의 src_linkId가 빠짐을 확인함. 사진 원본은 src_message가 표시용 문구로 치환됨. 성공 ACK는 fixture가 주입한 것이며 카카오 서버 수락 증거가 아님. 기존 `write-compatibility`의 OD/OM 성공 검사도 같은 제한이 있음. 대형방 이름 조회나 일반 글 전송 성공을 답장 성공으로 확대할 수 없음.

실행 명령:

```powershell
.\local-only\runtime\node-v24.21.0-win-x64\node.exe .harness/open-reply-20261106/payload-probe.mjs
.\local-only\runtime\node-v24.21.0-win-x64\node.exe --test --test-concurrency=1 tests/write-compatibility.test.mjs tests/phase3-reply-upload.test.mjs tests/send-read-policy.test.mjs
```

최초 일반 runner의 spawn EPERM은 실행 환경 오류로 별도 보존. 자식 프로세스 실행 권한을 부여한 재검사는 88/88·종료 0. 검사 범위가 좁고 제품을 수정하지 않았으므로 전체 Node/Python/Chrome 검사를 반복하지 않음. 비공개 재현 코드·출력·정제 진단은 `.harness/open-reply-20261106/`에 보존하며 민감 원본은 복사하지 않음.

## 수정 방향과 완료 기준

1. 이미 실패한 원본의 종류와 같은 방의 일반 글 성공 여부를 먼저 구분. 확인을 위해 새 메시지를 보낼 필요 없음.
2. 허가된 APK의 정적 코드나 별도 승인한 공식 앱 동작에서 오픈답장 필드 의미를 대조. 실제 값 대신 필드 존재·방 링크와의 일치 여부·숫자 타입만 기록.
3. 링크 문맥이 확인되면 서버의 검증된 방 문맥에서 답장 생성기로 전달. 64비트 숫자를 Number 변환 없이 직렬화하고 일반방의 extra는 보존. 근거 없는 WRITE 상위 필드·자동 재전송 추가 금지.
4. 원문·멘션을 UI 표시값과 구분해 제한된 내부 자료로 보관하는 방안 검토. 같은 방·같은 캐시 원본·유효한 타입 검증과 크기 제한 유지.
5. 일반방/OD/OM·텍스트/사진/답장 원본·멘션·int64·-203·원본 퇴거/다른 방 원본·중복 제출 회귀 검사 후, 별도 승인된 대상과 내용으로 한 번 전송하여 실제 수신 화면의 답장 말풍선·정확한 원본 참조 확인.

현재 원인은 “오픈채팅 답장의 요청 내용이 서버 검증을 통과하지 못함”까지 좁혀진 상태임. **빠진 메타데이터의 보완으로 해결됐다고 보고할 단계는 아님.** 실행 중 서버는 교체하지 않았고 로그인·발송·커밋·push는 수행하지 않음.

## 분석 버전

기준 HEAD `1d3bf8589167b07d95ad847a3e3ca0c9b66d03b8`와 기존 11/05 미커밋 보강이 있는 작업 복사본을 읽음. 현재 조사에서는 제품·테스트 파일 수정 없음.

| 파일 | 원시 SHA-256 |
| --- | --- |
| message-content.mjs | 04d9395f5163e97a4692e715489d67ab29f5db928334a3f422fe1eabda3f6c25 |
| reader-data.mjs | 30051e185ceca20667574dbf3deff26574a442a76eb90b045c65701cc57dc6f7 |
| reader-session.mjs | d818534885b7c0ef69a65fc06d035ff6d1f6f9aea0846f188b4d4dd14258f92d |
| modern forge-protocol.ts | 2f07f4c8fb8fa16d4e4fdd2307b2ab2d26fc4a3ced83ebf33ce1c808754c9489 |

고정 modern 커밋은 `8dbbd4f7ed6b42542982252250622fa351af00e9`, legacy는 `8512e4699e2cd4c26516b80d38b57b2f85a6cc8a`. legacy 관련 7개 파일은 기존 공개 소스 manifest와 일치하며 세부 지문은 비공개 인계에 기록함.
