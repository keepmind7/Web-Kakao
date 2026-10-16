---
name: kakao-web-interaction
description: "Implement and verify Web-Kakao room selection, realtime rendering, read conditions, replies, focus and photo selection/paste in an isolated synthetic browser. Keep actual account delivery and protocol analysis as separate verification stages."
---

# Synthetic Web-Kakao interaction

Owners: harness_worker and harness_qa. Read AGENTS.md, .harness/OPERATING.md and the latest packet before work.

## Inputs
UI reproduction/expected states, synthetic messages and injected transport/reader/photo fixtures, assigned files/tests, Node/Chrome readiness, dedicated temporary profile/output paths and browser lease. Never use the personal browser profile, real conversation/photo or live account server as fixture.

## Procedure
1. Read experiments/local-web/app.js, server.mjs and tests/reader-browser-smoke.mjs. Verify injected transport, readerFactory and photoFetcher, rather than inferring offline safety from mode names. Existing fixture uses a loopback ephemeral port and synthetic data.
2. Prefer existing tests/tools. During harness setup do not modify product files. In future tasks worker owns assigned product paths; QA owns assigned tests/artifacts and requests product fixes.
3. Check quick room A->B selection with delayed A responses, realtime messages, history busy/failure, list badges and heading. Wrong-room results must not render. Account end/reconnect must invalidate stale tokens, results, reply targets and previews.
4. Exercise foreground, focus, selected room, latest-message visibility, bottom position, search and read option. Local badge clearing and remote read request/ack are separate. Requests must not fire when required eligibility is absent; older history loading is not latest visibility.
5. Check reply select/cancel/room change, mouse/context menu, Shift+F10/menu key, arrows, Escape, input focus, Enter/Shift+Enter and Enter during Korean IME composition.
6. Check photo choose/paste/preview/cancel/type/size, repeated click, failure and unknown outcome. Selection/paste/cancel alone sends zero messages. Preview is not delivery. Unknown outcomes must not auto-resend.
7. Check safe text rendering, menu/window bounds and narrow-screen timestamp overlap using synthetic screenshots only. Use existing smoke coverage; add tests only when assigned and needed for a meaningful behavior.
8. Clean up only the test-owned Chrome/server/profile resources. Do not stop the user's running server/browser or erase their session. Serialize shared profiles/caches; report port/profile/ACL conflicts.

## Existing commands
From the project root, confirm runtime presence and select relevant checks:
- .\local-only\runtime\node-v24.21.0-win-x64\node.exe --test tests/reader.test.mjs tests/read-sync.test.mjs tests/phase3-settings.test.mjs tests/phase3-reply-upload.test.mjs
- .\local-only\runtime\node-v24.21.0-win-x64\node.exe tests/reader-browser-smoke.mjs

The browser fixture writes under local-only/phase2-browser/ with its own temporary profile. Obtain the parent browser lease. No account login or real message/photo sending is included.

## Outputs and pass criteria
Return assigned changes, command/exit code/counts, browser output/artifact paths, conditions with expected/actual requests and UI state, and unexecuted scope.
Success covers synthetic selection/rendering/focus/menu/read eligibility/photo UI only. It does not establish Kakao connectivity or peer unread/photo arrival.

## Unable to execute
Report missing Chrome/Node, child-process permission denial, ACL/profile/port collision or actual error. Distinguish successful Node checks from failed/not-run browser checks. Do not switch to the personal profile or reuse historical browser passes as current results.
