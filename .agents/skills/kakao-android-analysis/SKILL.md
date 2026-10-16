---
name: kakao-android-analysis
description: "Investigate Web-Kakao read receipts, photo upload, room names and open chat using authorized Android APKs and local REA/JADX; includes missing-APK preparation and handoff to another PC. Official-app execution requires separate approval."
---

# Authorized Android analysis

Owner: kakao_rea_analyst. First read AGENTS.md, .harness/OPERATING.md and the newest task packet.

## Inputs and triggers
Use for APK preparation, static protocol tracing or an analysis handoff. Require the issue, relevant web paths, authorized source APKs (base and required splits), package/version metadata, assigned private output paths and the parent's exclusive REA lease.
Historical baseline (2026-10-16): the original laptop had no KakaoTalk APK or emulator and used an iPhone; Android preparation was planned on another PC. Verify the current machine and authorized inputs instead of assuming that baseline still applies. A PC EXE or sample APK cannot substitute for Kakao evidence.

## Procedure
1. Check APK availability and right to use it before acquisition/analysis. If absent, report analysis not_run and use existing tools/apk_export/README.ko.md, tools/build_apk_export_kit.py and tools/prepare_android_adb.py for preparation only. Inspect existing kits before downloading again. Static extraction/preparation and account login are separate stages.
2. Preserve originals under local-only/. Record each base/split filename, SHA-256, package, versionName/versionCode, source, collection date and authorization in a private manifest. Missing splits mean incomplete coverage. Web connection profile 26.1.2 is not the APK's observed version. Static package metadata does not authenticate signatures/distribution.
3. Read tools/rea_local.py and its current --help. Outputs overwrite by label: choose a new unique label. Acquire the engine lease; run sequentially from the project root:
   - python tools/rea_local.py doctor --label UNIQUE_DOCTOR_LABEL
   - python tools/rea_local.py mcp-doctor --label UNIQUE_MCP_LABEL
4. Report CLI access, JADX-scoped health, separate MCP subprocess, and parent/child direct MCP tool binding independently. Check the child's actual tool surface. Overall environment health may differ from JADX health. A role TOML does not grant MCP/process access; no global setup/configuration changes.
5. Only when authorized exact APK inputs exist, use existing inspect-apk, search-class, inspect-class, inspect-method and references actions. Discover class/method/overload names from this exact APK. Keep command, exit code, version/hash, evidence location and coverage together. Do not execute APK code.
6. Trace entry event through serialization, transport, response and stored state:
   - read: room entry/foreground/latest-message event, own read position, peer notification;
   - photo: upload connection, frame, file bytes, COMPLETE, message/delivery;
   - titles: metadata, participants, CHATINFO and open-link precedence;
   - open chat: type/link/permissions and text/reply/photo/read separately.
7. Compare with current experiments/local-web/app.js, reader-manager.mjs, reader-session.mjs, reader-data.mjs and media-upload.mjs. Cite exact file/function/line. Static module graphs are not observed execution stacks. Mark obfuscation, JNI/native paths, ambiguous callers, split/version mismatch and partial coverage.
8. Return a proposed official-app comparison to the parent. Execution/login/device changes need a separate device/debugger lease and explicit user approval of target, count and impact on existing devices. Never upload APK/private originals externally. Finish only owned engine sessions and request lease release; do not kill unrelated processes.

## Outputs and pass criteria
Write only assigned private analysis outputs, never product files or input originals. Return input manifest, versions/hashes, commands/exit codes, class/method/call evidence, web comparison, facts/inferences/hypotheses, coverage and remaining requirements.
Engine readiness passes only on actual successful checks within the stated scope. Kakao static analysis passes only on this exact APK's target evidence; missing/ambiguous paths are partial. Sample success is engine evidence only. Read/photo resolution additionally requires kakao-verification's actual peer/recipient observation.

## Unable to execute
Distinguish missing APK/authorization/tool, process denial, engine contention and incomplete coverage. Report failure or not_run for that stage, exact sanitized error, what remains usable and preparation needed on the other PC. Do not fill gaps with guessed class names, old results or sample-APK conclusions.
