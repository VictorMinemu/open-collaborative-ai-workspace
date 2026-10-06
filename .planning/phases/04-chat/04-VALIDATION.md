---
phase: "04"
slug: "chat"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6; Plan 04-13 Task 3 signs off)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-06"
validated: "2026-10-06"
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Sources: `04-RESEARCH.md` §Validation Architecture and §Security Domain, `04-CONTEXT.md` (D-01 … D-08), planner decisions P-01 … P-12 in `04-01-PLAN.md`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5 — projects `unit`, `integration` (testcontainers PostgreSQL 18 + Redis 8, plus a Garage `dxflrs/garage:v2.4.1` GenericContainer from `apps/api/src/testing-storage.ts`) and the new `web` project (04-02); `node --test` for `infra/**` and `scripts/**`; `pnpm --filter @ocw/desktop test` (run with `env -u ELECTRON_RUN_AS_NODE`); Playwright 1.63 (`setup` → `desktop` 1440×900, `mobile` 390×844) |
| **Config file** | `vitest.config.ts`, `e2e/playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run --project unit <files>` · `pnpm exec vitest run --project integration <file>` (one file at a time: memory) · `pnpm exec vitest run --project web <files>` |
| **Full suite command** | `pnpm verify && env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test && pnpm --filter @ocw/local-runtime test && node --test 'infra/**/*.test.mjs' 'scripts/**/*.test.mjs'` |
| **E2E** | `bash scripts/e2e-isolated.sh <spec filters>` (isolated: DB `ocw_e2e`, Redis DB 9, API :4290, web :3290, fake :4291, Garage :4292 in compose project `ocw-e2e-storage`); screenshots with `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/04-chat/screenshots` |
| **Estimated runtime** | ~300 s (verify), ~900 s (full e2e, both projects) |

---

## Sampling Rate

- **After every task commit:** the task's quick unit/integration command for the touched module (listed per task below).
- **After every plan wave:** `pnpm verify` (+ `pnpm typecheck --force` after any contract change).
- **Before `/gsd-verify-work 4`:** full suite command + full isolated e2e (desktop + mobile) green + CI green.
- **Max feedback latency:** 300 seconds.

---

## Per-Task Verification Map

E2E commands run as `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/04-chat/screenshots bash scripts/e2e-isolated.sh <filters>`; every task also ends with `pnpm verify` unless noted. "❌ task" = the task creates the test file first (TDD RED), "✅" = file exists before the task.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 (tracer) | 01 | 1 | CHAT-06, D-01 | T-04-01-01/03/05/07/08 | Edit by author only; prior version append-only; audit without body; no bot re-trigger; reserved handles | unit + integration + e2e | `vitest --project unit chat-workspace contracts permissions`; `pnpm typecheck --force`; `vitest --project integration chat/message-edit.int`; e2e `chat-edit chat.spec team-bot-dm` | ❌ task | ✅ green |
| 04-01-02 [BLOCKING] | 01 | 1 | P-02 | T-04-01-01/04 | Migration applies fresh; RLS forced on 8 new tables; `message_versions` UPDATE/DELETE denied to `ocw_app`; unaccent FTS works | integration | `vitest --project integration rls-isolation.int chat/message-edit.int`; no `*_chat_workspace_check` dir | ✅ | ✅ green |
| 04-01-03 | 01 | 1 | CHAT-06, D-01 | T-04-01-02/06 | Admin delete only where readable, never in DMs; tombstones; bots never see deleted text; one readable-set authority | unit + integration + e2e | `vitest --project unit resolve.test`; `vitest --project integration chat/access.int`, `chat/message-edit.int`; e2e `chat-edit chat.spec` | ❌ task | ✅ green |
| 04-02-01 (tracer) | 02 | 1 | CHAT-05, D-05 | T-04-02-01/02/04 | One renderer; no script/on*/javascript:/data:/iframe/style; images as links; mentions not chipped in code | unit (web) + e2e screenshots | `vitest --project web components/markdown/markdown.test.tsx`; e2e `renderer chat.spec work-zone.spec` | ❌ task | ✅ green |
| 04-02-02 (checkpoint) | 02 | 1 | CHAT-05 | T-04-02-03, T-04-02-SC | Human verifies streamdown, @streamdown/code, frimousse before install | manual gate (blocking-human) | — | — | ✅ green (owner-approved gate, 04-02) |
| 04-02-03 | 02 | 1 | CHAT-05, D-05 | T-04-02-01/03 | streamdown without raw HTML; shiki; streaming fences; old engines removed | unit (web) + e2e | `vitest --project web markdown.test`; `pnpm install --frozen-lockfile`; e2e `--rebuild-web renderer chat.spec work-zone.spec` | ✅ | ✅ green |
| 04-03-01 (tracer) | 03 | 2 | CHAT-14, CHAT-13 | T-04-03-01/02/03 | Hidden = missing (404); anchor must belong to the conversation | integration + e2e | `vitest --project integration chat/permalink.int`; e2e `permalinks chat-edit chat.spec` | ❌ task | ✅ green |
| 04-03-02 | 03 | 2 | CHAT-14, CHAT-13 | T-04-03-01 | Thread/DM anchors; deleted and unavailable targets leak nothing | integration + e2e | `vitest --project integration chat/permalink.int`; e2e `permalinks team-bot-dm` | ✅ | ✅ green |
| 04-04-01 (tracer) | 04 | 2 | CHAT-12, D-03 | T-04-04-01/07/08 | Presigned PUT with signed type; download 302 only after read decision; tenant-scoped keys; non-member 404 | unit + integration (Garage) | `vitest --project unit config/env.test`; `vitest --project integration artifact/attachments.int` | ❌ task | ✅ green |
| 04-04-02 | 04 | 2 | CHAT-12, D-03 | T-04-04-02/03/04/05/06 | Sniffing, EXIF-stripped renditions, inline only webp, RFC 6266, no URL in logs/audit, rate limit, sweeper per tenant | unit + integration (Garage) | `vitest --project unit artifact/disposition.test`; `vitest --project integration artifact/attachments.int` | ❌ task | ✅ green |
| 04-04-03 | 04 | 2 | CHAT-12, D-03, principle 10 | T-04-04-07/09 | Garage in compose without `:?` guards; setup-env keys; harness and CI storage; ADR-0015 | node + compose + e2e | `node --test infra/garage/compose-garage.test.mjs scripts/setup-env.test.mjs`; `docker compose -f compose.yaml config -q`; e2e `attachments-api chat.spec` | ❌ task | ✅ green |
| 04-05-01 (tracer) | 05 | 3 | CHAT-07 | T-04-05-02/03, T-04-05-SC | Reactions need read + post; Emoji contract; no viewer fields in events | integration + e2e | `vitest --project integration chat/reactions.int`; e2e `reactions-pins chat-edit permalinks` | ❌ task | ✅ green |
| 04-05-02 | 05 | 3 | CHAT-13 | T-04-05-02/04/06 | Pins: post to pin, pinner/moderator to unpin, audited, capped | integration + e2e | `vitest --project integration chat/pins.int`; e2e `reactions-pins` | ❌ task | ✅ green |
| 04-05-03 | 05 | 3 | CHAT-13 | T-04-05-01/05 | Saved filtered by readable set at read time; private events | integration + e2e | `vitest --project integration chat/pins.int`; e2e `reactions-pins chat.spec` | ✅ | ✅ green |
| 04-06-01 (tracer) | 06 | 3 | CHAT-11, D-04 | T-04-06-01/02/03/04 | Hits only from resolver readable ids; `websearch_to_tsquery`; snippets as text | integration + e2e | `vitest --project integration search/search.int`; e2e `search permalinks` | ❌ task | ✅ green |
| 04-06-02 | 06 | 3 | CHAT-11, D-04 | T-04-06-05/06 | Filters; people without deactivated/others' personal bots; channels readable only; 429 | integration + e2e | `vitest --project integration search/search.int`; e2e `search` | ✅ | ✅ green |
| 04-07-01 (tracer) | 07 | 4 | CHAT-04, D-06 | T-04-07-05/06 | Human DM insert-or-get race-safe; ids-only key; foreign ids 404 | integration + e2e | `vitest --project integration chat/dm.int`; e2e `dms team-bot-dm personal-bots search` | ✅ | ✅ green |
| 04-07-02 | 07 | 4 | CHAT-04, D-06 | T-04-07-02/03/04 | Fixed membership; personal bots refused; mention-only bots; memory off with ≥ 2 humans | unit + integration + e2e | `vitest --project unit resolve.test`; `vitest --project integration chat/group-dm.int`, `bot-capabilities/memory.int`; e2e `dms bot-memory bot-reply-mode` | ❌ task | ✅ green |
| 04-07-03 | 07 | 4 | CHAT-04, D-01 | T-04-07-01 | Non-participant admin 404 on every DM path incl. WS, search, attachments | integration (Garage) | `vitest --project integration chat/dm-privacy.int` | ❌ task | ✅ green |
| 04-08-01 (tracer) | 08 | 5 | CHAT-02, D-08 | T-04-08-01 | Unit placement limited to the caller's units | integration + e2e | `vitest --project integration chat/sidebar.int`; e2e `chat-sidebar chat.spec dms` | ❌ task | ✅ green |
| 04-08-02 | 08 | 5 | CHAT-02 | T-04-08-01/02 | `channel.update` owner/admin; unit-scoped deny rules apply to channels (list, 404, search) | unit + integration + e2e | `vitest --project unit resolve.test`; `vitest --project integration chat/sidebar.int`; e2e `chat-sidebar admin-org` | ✅ | ✅ green |
| 04-08-03 | 08 | 5 | CHAT-02, D-08 | T-04-08-03/05/06 | Threads view from readable ids; no new subscriptions | integration + e2e | `vitest --project integration chat/threads.int`; e2e `chat-sidebar reactions-pins chat.spec` | ❌ task | ✅ green |
| 04-09-01 (tracer) | 09 | 6 | CHAT-08 | T-04-09-01/05/07 | Rows ids-only; canRead at write; readable at list; chat never imports notification | unit + integration + e2e | `vitest --project unit notification/recipients.test`; `vitest --project integration notification/notifications.int`; e2e `notifications chat.spec bots` | ❌ task | ✅ green |
| 04-09-02 | 09 | 6 | CHAT-08 | T-04-09-02/03/04 | `channel.mention_all` deny-able; 1/min/channel; reserved handles never resolve; no bot wake-up | unit + integration + e2e | `vitest --project unit chat/mentions.test notification/recipients.test`; `vitest --project integration notification/notifications.int`, `realtime-presence.int`; e2e `notifications presence dms` | ✅ | ✅ green |
| 04-09-03 | 09 | 6 | CHAT-08 | T-04-09-01/06 | Edits notify only new mentions; inbox re-filtered on lost access; DM privacy for inbox | integration | `vitest --project integration notification/notifications.int`, `chat/dm-privacy.int` | ✅ | ✅ green |
| 04-10-01 (tracer) | 10 | 7 | CHAT-09, D-07 | T-04-10-01/04 | Counts from messages (capped), not stream seq; only on resolver-filtered rows | integration + e2e | `vitest --project integration chat/unread.int`; e2e `unread notifications chat-sidebar chat.spec` | ❌ task | ✅ green |
| 04-10-02 | 10 | 7 | CHAT-09, D-07 | T-04-10-02/03 | Mark unread backwards, own rows only, foreign ids 404 | integration + e2e | `vitest --project integration chat/unread.int`; e2e `unread permalinks` | ✅ | ✅ green |
| 04-11-01 (tracer) | 11 | 8 | CHAT-10, D-02 | T-04-11-03/04 | Server decides popup; no Push API; prefs scoped to self and members | integration + e2e | `vitest --project integration notification/prefs.int`; e2e `notification-prefs notifications unread` | ❌ task | ✅ green |
| 04-11-02 | 11 | 8 | CHAT-10, D-02 | T-04-11-02/05 | DND, levels, toggles; permission only on click; level-all is ephemeral | integration + e2e | `vitest --project integration notification/prefs.int`; `pnpm typecheck --force`; e2e `notification-prefs account` | ✅ | ✅ green |
| 04-11-03 | 11 | 8 | CHAT-10 | T-04-11-01 | Badge IPC: trusted sender, integer 0–9999, no passthrough | unit (desktop) + e2e | `env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test`; e2e `notification-prefs` | ✅ | ✅ green |
| 04-12-01 (tracer) | 12 | 8 | CHAT-12 | T-04-12-01/02/05 | Link only own, ready, same-conversation attachments; previews are renditions | integration (Garage) + e2e | `vitest --project integration chat/message-attachments.int`; e2e `attachments chat.spec chat-edit` | ❌ task | ✅ green |
| 04-12-02 | 12 | 8 | CHAT-12 | T-04-12-03/04 | Deleted message → downloads 404; limits; disabled mode | integration (Garage) + e2e | `vitest --project integration chat/message-attachments.int`; e2e `attachments dms` | ✅ | ✅ green |
| 04-13-01 (tracer) | 13 | 9 | CHAT-02 … CHAT-14 | T-04-13-01 | Cross-feature day on a fresh isolated stack | e2e | e2e `--rebuild-web chat-day` | ❌ task | ✅ green |
| 04-13-02 | 13 | 9 | CHAT-02 … CHAT-14 | T-04-13-03 | Full regression incl. privacy suites; screenshot review | full suite + e2e | full suite command; e2e `--rebuild-web` (all specs) | ✅ | ✅ green |
| 04-13-03 | 13 | 9 | all | T-04-13-02 | ADR-0016, AGENTS.md, DEMO.md, traceability, sign-off | docs checks | `test -f docs/adr/0016-…`; `grep -c "^- \[x\] \*\*CHAT-" .planning/REQUIREMENTS.md` | ❌ task | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Phase gate run (04-13, 2026-10-06, final branch state)

| Command | Result |
|---------|--------|
| `pnpm verify` | lint clean · typecheck 8/8 · 139 files / 1917 tests passed (unit, integration on ephemeral PostgreSQL + Garage, web) |
| `pnpm typecheck --force` | 8/8 |
| `env -u ELECTRON_RUN_AS_NODE OCW_HOME=<tmp> pnpm --filter @ocw/desktop test` | 10 files / 67 tests passed |
| `pnpm --filter @ocw/local-runtime test` | 17 files / 286 tests passed |
| `pnpm --filter @ocw/openclaw-channel test` | 15 files / 203 tests passed |
| `node --test 'infra/**/*.test.mjs' 'scripts/**/*.test.mjs'` | 80 passed (infra alone: 76) |
| `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh --rebuild-web` (all specs, fresh stack) | 153 passed, 2 skipped by design (`attachments-api` and `realtime-latency` are desktop-only), 0 failed, 0 flaky |
| `bash scripts/e2e-isolated.sh --rebuild-web chat-day` (fresh stack) | 3 passed (setup + desktop + mobile) |

### Requirement → test files

| Req | Behaviour | Where |
|-----|-----------|-------|
| CHAT-02 | unit placement/move, unit-scoped rules, grouped sidebar, views | `chat/sidebar.int.test.ts`, `chat/threads.int.test.ts`, `resolve.test.ts`, `e2e/tests/chat-sidebar.spec.ts` |
| CHAT-04 | human/group/mixed DMs, fixed membership, bots on mention, memory off, privacy | `chat/dm.int.test.ts`, `chat/group-dm.int.test.ts`, `chat/dm-privacy.int.test.ts`, `bot-capabilities/memory.int.test.ts`, `e2e/tests/dms.spec.ts` |
| CHAT-05 | one renderer, XSS fixtures, streaming | `apps/web/components/markdown/markdown.test.tsx`, `e2e/tests/renderer.spec.ts` |
| CHAT-06 | edit/delete, versions append-only, admin only where readable | `chat/message-edit.int.test.ts`, `rls-isolation.int.test.ts`, `e2e/tests/chat-edit.spec.ts` |
| CHAT-07 | reactions everywhere, live, per viewer | `chat/reactions.int.test.ts`, `e2e/tests/reactions-pins.spec.ts` |
| CHAT-08 | mentions, DMs, threads, @channel/@here, inbox, edits | `notification/recipients.test.ts`, `notification/notifications.int.test.ts`, `chat/mentions.test.ts`, `e2e/tests/notifications.spec.ts` |
| CHAT-09 | message-count badges, mark read/unread, cross-device | `chat/unread.int.test.ts`, `e2e/tests/unread.spec.ts` |
| CHAT-10 | mute, DND, levels, toggles, OS notifications, badge | `notification/prefs.int.test.ts`, `apps/desktop/src/shared/ipc.test.ts`, `e2e/tests/notification-prefs.spec.ts` |
| CHAT-11 | FTS es/en/accents, filters, privacy, people, channels | `search/search.int.test.ts`, `e2e/tests/search.spec.ts` |
| CHAT-12 | storage pipeline, linking, UI | `artifact/attachments.int.test.ts`, `artifact/disposition.test.ts`, `chat/message-attachments.int.test.ts`, `infra/garage/compose-garage.test.mjs`, `scripts/setup-env.test.mjs`, `e2e/tests/attachments-api.spec.ts`, `e2e/tests/attachments.spec.ts` |
| CHAT-13 | pins, saves, permalink copy | `chat/pins.int.test.ts`, `chat/permalink.int.test.ts`, `e2e/tests/reactions-pins.spec.ts`, `e2e/tests/permalinks.spec.ts` |
| CHAT-14 | around/after paging, detached mode, jump | `chat/permalink.int.test.ts`, `e2e/tests/permalinks.spec.ts` |
| all | cross-tenant on every new table | `packages/db/src/rls-isolation.int.test.ts` |

---

## Wave 0 Requirements

Created inside the first task that needs them (TDD: the test infrastructure lands before the behaviour it checks):

- [x] `vitest.config.ts` project `web` and `apps/web/components/markdown/markdown.test.tsx` — 04-02 Task 1
- [x] `apps/api/src/testing-storage.ts` (Garage GenericContainer) — 04-04 Task 1
- [x] `e2e/support/chat.ts` (Phase 4 e2e helpers: `ALEX`, `postAs`, `freshChannel`, `openMessageActions`) — 04-01 Task 1
- [x] Isolated harness Garage (`ocw-e2e-storage`, :4292) — 04-04 Task 3 (specs that upload run after it)
- [x] streamdown 2.6.0 + @streamdown/code 1.1.1 compatibility spike (fallback 2.7.0 + 2.0.0) — 04-02 Task 3
- [x] `window.Notification` recorder init script + `grantPermissions(["notifications"])` — 04-11 Task 1

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Package legitimacy of streamdown, @streamdown/code, frimousse | CHAT-05, CHAT-07 | Trust decision (blocking-human gate) | 04-02 Task 2 checklist on npmjs.com |
| Clicking a desktop (Electron) notification focuses the app and opens the message on macOS | CHAT-10 | macOS delivers notification click events only to code-signed apps; the Phase 1 desktop is ad-hoc signed (Pitfall 11) | On a signed build: get mentioned while the app is in the background, click the notification, expect the app in front on the message |
| Dock/taskbar badge visibly shows the unread count | CHAT-10 | OS chrome is outside Playwright | Run the desktop app against a dev stack, receive two mentions, look at the dock icon |
| Owner visual review of every Phase 4 screen at 1440/390, light/dark | D-08 | Taste judgement (Slack / T3 Code quality) | Read `04-UI-REVIEW.md` and the screenshots; harvested from 04-13 Task 3 `<human-check>` |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 300 s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-10-06 (04-13 Task 3). Manual-only rows above stay with the owner: the visual review in `04-UI-REVIEW.md` and the signed-build notification click / dock badge checks.
