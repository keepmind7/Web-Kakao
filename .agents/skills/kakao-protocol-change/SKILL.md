---
name: kakao-protocol-change
description: "Design, implement and verify evidence-backed Web-Kakao protocol/state changes for read receipts, uploads, room metadata and open chat. Use for request/response, disconnect, duplicate and reconnect contracts; pure UI behavior uses kakao-web-interaction."
---

# Evidence-backed protocol change

Owners: harness_architect and harness_worker; independent comparison: harness_reviewer. Read AGENTS.md, .harness/OPERATING.md and the newest packet. During harness bootstrap only investigation/design/synthetic checks are authorized, not product edits.

## Inputs
Observed reproduction and environment, current file/function/version/commit, sanitized historical evidence, public source at pinned commits, exact APK findings when available, assigned files, dependencies, resource leases and acceptance. Missing APK/actual observation remains a stated limitation.

## Procedure
1. Separate actual symptoms from synthetic reproductions. Current unresolved issues: peer unread 1 in normal direct chat, actual photo sending, some room names, and locally blocked open chat. Historical ACKs are not resolution evidence.
2. Trace both producer and consumer through app -> server -> manager -> worker/session/store, including errors and identity. Compare current implementation, pinned public sources and exact APK evidence. Cite source URL, check date, commit/version, class/method or file/function/line. Another client's implementation is not proof for this profile.
3. Architect proposes field types, account/room/message scope, request/response correlation, event order, states, browser/server responsibility, uncertainty and test criteria; parent confirms common contracts. Browser uses opaque keys and user intent; server owns actual IDs, credentials, upload addresses and wire serialization. Preserve 64-bit identifiers without precision loss.
4. Keep local enqueue, sending, server acknowledgment, actual remote observation, explicit failure and uncertain outcome separate. Explain existing accepted enum semantics rather than renaming product code during setup. Do not invent wire commands to fill missing evidence.
5. After the parent releases implementation, worker changes only exclusively owned product files. Backend/frontend tasks may split only when ownership is disjoint; parent integrates common files. QA owns assigned tests and sends product defects to the worker through the parent.
6. Verify normal/rejected, mismatched/late/missing response, timeout, IPC/socket exit, duplicate click/response, reconnect and room/account changes. Unknown delivery is not automatically resent. An old session/room result must not complete a new operation. In-memory dedupe is not a durable exactly-once guarantee.
7. Reviewer independently compares requirements, contract, diff, consumers and actual checks. Parent updates README and final status through kakao-verification.

## Domain-specific contracts and existing tests
- Read: app.maybeSeen -> manager.seen -> session.action -> NOTIREAD. Separate local unread reset, HTTP 202, NOTIREAD status 0, CHATINFO seen and peer-visible unread watermark. Test foreground/focus, selected room, latest visible message, bottom position, search and explicit read option. Use tests/read-sync.test.mjs, tests/reader.test.mjs and tests/phase3.test.mjs.
- Photo: selection/paste/preview/explicit submit, SHIP/POST, file bytes, COMPLETE, message creation and recipient delivery are distinct. Preserve clientId + content dedupe; wrong room/content reuse must fail. Distinguish failure before POST and uncertain delivery after it. Do not append speculative WRITE or auto-retry. Use tests/media-wire.test.mjs and tests/phase3-reply-upload.test.mjs.
- Names: distinguish local aliases and server titles; define source precedence for fields/meta/participants/CHATINFO/open-link, including empty/invalid metadata and missing names. Use tests/room-metadata.test.mjs.
- Open chat: preserve type/link/permissions and separate text/reply/photo/read support. Local support blocking is different from server rejection. A recovered title must not enable sending; do not blanket-enable unknown types.

## Outputs and pass criteria
Return contract/state table, facts/inferences/hypotheses, minimal change boundaries, actual commands/results, failure/disconnect/dedupe/reconnect evidence, independent review and remaining real-device criteria.
Synthetic success requires producer/consumer agreement for normal and adverse cases. Read resolution requires peer unread 1 to disappear; photo resolution requires actual recipient display. Without that evidence report partial success or that stage not_run.

## Unable to execute
Report missing inputs, APK, authorization or environment with the blocked stage and still-possible checks. Do not guess a fix, execute live-account tools, edit outside ownership or declare product success from a plan.
