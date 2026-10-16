---
name: kakao-verification
description: "Verify Web-Kakao through synthetic checks, account-free local integration and separately approved real-account observation, then review evidence, update README and inspect commit candidates for sensitive data. Distinguish harness readiness from feature resolution."
---

# Verification and evidence

Owners: harness_qa, harness_reviewer and parent. Read AGENTS.md, .harness/OPERATING.md and the newest packet. Parent owns final judgment, common docs and ledgers.

## Inputs
Requirements, reproduction, diff/owned files, sanitized evidence, version/commit/fingerprints, relevant existing tests, local integration scope and any separate approval reference with target/content/count/impact.
Historical baseline (2026-10-16): the original environment had no Kakao APK and used an iPhone, with Android preparation planned on another PC. Verify current inputs and tool availability on every machine. Six previous photo-send approvals are exhausted; restoring definitions grants no live-account or product-change authorization.

## Procedure
1. Define pass criteria and evidence level before execution. Classify synthetic / account-free local integration / approved real-account. Local enqueue, server ACK, HTTP 202 and NOTIREAD status 0 do not demonstrate peer unread 1 clearance.
2. Inspect existing tests/tools for account/network side effects. QA edits only assigned tests/artifacts, asks worker for product fixes, and serializes shared caches.
3. Run relevant normal/failure/timeout/IPC/socket exit/deduplication/reconnect/room-account identity checks. Existing project-root commands:
   - python -m unittest discover -s tests -v
   - PowerShell: collect Get-ChildItem .\tests -Filter '*.test.mjs' full paths and pass to the local Node runtime's --test.
   - python tools/verify_artifacts.py
4. Use injected synthetic transports/readers on loopback and an isolated temporary Chrome profile for local integration. Read kakao-web-interaction for actual commands. Do not start/stop the user's live server or clear their session.
5. Reviewer independently compares requirements, producers/consumers, changes, actual checks, data exposure, false success, duplicate sending, reconnect and account/room identity. Parent records read-only outputs.
6. Immediately before real-account work, parent explains target/content/count/impact, including login and existing-device effects, and obtains explicit user confirmation. Do not reuse exhausted approvals. Real read notifications also require approval. Absent approval means not_run.
7. Observe the actual receiving device/peer screen for the same room/message, linked only by temporary aliases and sanitized timing. Never retain tokens/passwords/session keys/real content or raw identifiers in reports/repository; do not upload APK/private originals externally.
8. Parent updates README with current solved/unsolved state, actual checks and limitations. Distinguish historical results from this execution, and harness file/config checks from custom-role discovery/runtime success.

## Actual feature pass criteria
- Direct-chat read: peer screen unread 1 disappears for the designated same message after the web client's eligible read action. Local badge/ACK/CHATINFO comparison alone is insufficient.
- Photo: distinguish upload/COMPLETE/message status, then confirm actual photo arrival/display on the designated receiving device. Preview or POST acceptance is insufficient.
- Names: correct title maps to the correct room/type; local alias is distinguished. Use sanitized observations instead of actual private room names.
- Open chat: type/link/permissions match; separately approved text/reply/photo/read features are observed on actual sender/receiver. Removing local blocking alone is insufficient.

## Before any separately requested commit
Commit or push only when explicitly requested by the user; a definition restore or bootstrap alone does not authorize publishing.
- Inspect git status --short, git diff --check, git diff --stat and staged candidate paths. Locally review only necessary scoped diffs; do not echo sensitive values to chat/logs.
- Use git check-ignore plus git ls-files to verify private originals, local-only/, docs/, evidence/, _workspace/, private .codex/ files and .harness/ runtime records remain excluded. Only .codex/config.toml, .codex/agents/*.toml, .harness/OPERATING.md and .harness/FOLLOWUP.md are approved shareable exceptions. Preserve the allowlist, inspect already-tracked exceptions, and never force-add private data. A verbose negation match means inclusion; use quiet exit status to test actual exclusion.
- AGENTS.md and .agents skills are normally eligible for tracking. Check all added/changed candidates, including untracked files that git diff omits, for credentials, cookies, real conversations/identities, raw responses and private binaries.
- Return suspicious file/category/count without printing values. State scanner limitations; do not promise exhaustive detection. Keep required user-specified root context local and otherwise prefer relative paths.

## Outputs, judgment and inability
Return actual commands/exit codes/counts/evidence paths/dates, required flags, check category, review, README changes, unexecuted reasons and remaining inputs.
Human statuses: verification success / partial success / failure / not executed. Bundle task statuses: completed/blocked/failed; check statuses: passed/failed/not_run. Explain partial success in summary/limitations. Required failures or not_run prevent that verification task being completed.
If a custom role is absent from the current spawn schema, disclose actual built-in agent_type and real ID. File creation or built-in fallback is not custom-role execution success. Leave restart/resume instructions.
Missing APK/device/approval/tool/permission blocks only the relevant stage. Keep already-executed synthetic results separate, and distinguish CLI doctor, separate MCP, direct MCP binding, sample analysis and actual Kakao analysis.
