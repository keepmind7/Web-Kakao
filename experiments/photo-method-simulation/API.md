# Offline photo method simulation

Run from project root with the prepared Node binary:

```powershell
& .\local-only\runtime\node-v24.21.0-win-x64\node.exe .\experiments\photo-method-simulation\run.mjs
```

This runs deterministic injected fixtures, uses Node built-ins only, and prints
sanitized JSON. It does not call the real SDK, network, server, OS sharing UI or
any account. It does not rank methods by synthetic speed or declare delivery.

`model.mjs` exports:

- `makeSyntheticImage({format='jpeg',size=1024})`: JPEG fixture of exact requested
  size (minimum embedded JPEG size plus four, maximum 5 MiB); `format:'png'`
  returns the fixed 68-byte PNG and ignores size. Returns `{bytes,mime,name}`.
- `inspectImage(image,{jpegOnly=false})`: bounded signature/MIME/extension checks;
  returns `{valid,format,bytes,sha256}` or `{valid:false,reason}`. Not a decoder.
- `createPhotoSimulator({adapters={},isCurrent=()=>true,policy={},timeoutMs=100,maxEntries=256})`:
  returns `{send(request)}`. Request is `{method:'loco'|'http-write',clientId,
  context:{account,room,generation},image}`. All inputs must be synthetic.
  `isCurrent(context)` is checked at entry and after upload/registration.
  Adapters `ship/post/file/complete/upload/write` are injected async or sync
  functions receiving `{context,method,image:{valid,format,bytes,sha256}}`.
  `file` and `upload` additionally receive `payload:Buffer`, an independent copy
  of the synthetic bytes for an injected peer to verify exact content/hash.
  Input bytes are copied synchronously on entry; each adapter receives a fresh
  copy so later caller/adapter mutation cannot change other calls. Payloads are
  never included in results. Missing adapters are synthetic successful fixtures.
  `upload` also receives source-derived `multipart:{user_id:'0',
  attachment_type:'image/jpeg',filename:'synthetic.jpg'}` metadata; serialization,
  HTTP headers, TLS and current service acceptance are not modeled.
  LOCO status responses are `{status:0}` for success. `upload` expects the
  explicitly synthetic `{status:200,contentType:'text/plain',redirected:false,
  body:'fixture-asset:abc'}` grammar. This is not the service's asset path grammar.
  After upload, WRITE additionally receives request-local copies of `clientId`,
  `asset:{path,s,sha256}` and `registration:{chatId,msgId,type:2,noSeen:true,
  extra:JSON.stringify({path,s})}`. `s`/hash derive from copied request bytes;
  `chatId` is captured room and `msgId` is a positive safe-integer local sequence.
  This is a minimal legacy-derived proposal, not current PHOTO extra or BSON.
  Hash/clientId are local correlation metadata, not invented wire extra fields.
  Canonical snapshots precede WRITE and are isolated from adapter mutation.
  Optional ACK `clientId/chatId/msgId/asset.path/asset.s/asset.sha256` mismatches
  yield `unknown`; bare `{status:0}` remains a synthetic accepted control.
  Receiving a valid path cannot authenticate its server-side content association
  or detect dishonest valid-path swaps. Paths and full registration are never
  returned in result JSON.
  `policy.fileTransportBlocked` only blocks modeled LOCO file transport;
  `policy.allLocoBlocked` also prevents HTTP+WRITE registration after asset upload.
  Each adapter call has a bounded local timer, cleared in `finally`; late results
  never advance the operation. Injected adapter resources remain its owner's
  responsibility; the model opens none.
- `simulateOfficial({target:'self'|'friends'|'arbitrary-room'|'share',consent,
  configured,friendUuids,response})`: capability and template response model.
  Self response `{status:0}`; friend response `{httpStatus:200,
  successful_receiver_uuids:[],failure_info:[]}`. Friend list is 1–5. A 200 with
  recipient failures is not whole-operation success. Cards are not native photos.
- `simulateManualShare({supported,canShare,userActivation,outcome:'resolve'|'cancel'|'error'})`:
  explicit capability/handoff model, no actual navigator call. App/room unknown.
- `simulateCrypto({profile:'cfb'|'gcm',decryptProfile=profile,tamper=false})`:
  offline synthetic key/nonce/plaintext only. Wrong profiles refused, GCM tamper
  detected; CFB unauthenticated modification is visible. No bytes or keys output.
  Only one fixed 22-byte plaintext is exercised; photo-size framing is untested.
- `simulateTransportPolicy({fileTransportBlocked,allLocoBlocked})`: explicit
  hypothetical selective-block policy, not a diagnosis or bypass proposal.

Every result has `uploadPhase`, `messagePhase`, `delivery:'unverified'`,
`evidenceLevel`, adapter `calls` and bounded `reason`. No raw responses/errors or
request identifiers are returned. Exact same request returns the prior result
without new calls, including concurrent duplicates. Reusing clientId with other
context/content/method is refused. Pending/unknown possible message creation
also blocks new-clientId method switches for that account/room/content, across
generation changes. Locks and the bounded dedupe table are memory-only. Never
interpret a restart as permission to retry an uncertain real send.

Source basis (checked 2026-10-19): pinned node-kakao 4.5.0
`8512e4699e2cd4c26516b80d38b57b2f85a6cc8a`, attachment-api-client.ts and
talk-channel-session.ts (legacy HTTP upload and separate WRITE); current modern
LOCO upload flow reference (SHIP/POST/file/COMPLETE, no extra WRITE); Kakao
Developers image upload/message/share docs and W3C Web Share capability contract.
Research provenance and precise limitations are in the parent-owned
`.harness/photo-methods-20261019/` reports. No current service compatibility has
been established for the legacy HTTP PHOTO or CFB candidates.
