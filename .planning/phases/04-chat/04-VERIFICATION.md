---
phase: 04-chat
verified: 2026-10-06T12:18:22Z
status: human_needed
score: 12/13 must-haves verified
behavior_unverified: 0
overrides_applied: 0
deferred:
  - truth: "AI chat messages render through the one shared Markdown renderer (SC3 lists 'AI chats')"
    addressed_in: "Phase 5"
    evidence: "Phase 5 SC2: 'User creates a private AI chat ... watches the response stream in realtime'. No AI chat surface exists yet; the shared renderer (apps/web/components/markdown/markdown.tsx) already has the streaming 'document' variant that the Work Zone uses, and the AI Chats view lists bot DMs, which already render through it."
human_verification:
  - test: "On a signed macOS desktop build, get mentioned while the app is in the background and click the OS notification"
    expected: "The app comes to the front on the mentioned message"
    why_human: "macOS delivers notification click events only to code-signed apps (Pitfall 11); the Phase 1 desktop is ad-hoc signed and Playwright cannot drive OS chrome"
  - test: "Run the desktop app against a dev stack, receive two mentions, look at the dock icon"
    expected: "The dock badge shows 2 and clears when the mentions are read"
    why_human: "OS chrome is outside Playwright; only the IPC (trusted sender, integer 0-9999) is unit-tested (apps/desktop/src/shared/ipc.test.ts)"
  - test: "Owner visual review of 04-UI-REVIEW.md and .planning/phases/04-chat/screenshots (1440/390, light/dark)"
    expected: "Slack / T3 Code quality (D-08); accept or schedule the 7 cosmetic follow-ups (Threads view mentions as plain text, '(edited)' on its own line, emoji picker glyph bleed, sidebar scroll offset after New message, crowded phone channel header, upload progress not captured)"
    why_human: "Taste judgement; the executor's verdicts are not the owner's"
  - test: "Re-run CI on PR #16 once GitHub Actions billing is restored"
    expected: "verify, docker images, openclaw cell smoke and e2e desktop/mobile all green at 74b6f40 or later"
    why_human: "The CI run at HEAD (run 37461094735) never started any job ('recent account payments have failed or your spending limit needs to be increased'). The last run that executed (e1a2a82, ledger 04-11) failed e2e only on work-zone-title, which 04-13 fixed in a3ce3e3; that fix and the full 153-pass e2e are proven only by local isolated runs, not by CI. This is an account action, not a code gap"
  - test: "Unverified-prohibition review (process-only, judgment tier): no migration was run against the default .env database; the demo (ports 4000/3000, ocw-demo-*, ocw DB) was never started/stopped/touched; no compose lifecycle targeted the demo; no package was installed before the 04-02 legitimacy checkpoint"
    expected: "Owner confirms from session history; nothing in the code contradicts them (the harness uses ocw_e2e / ocw-e2e-storage; 04-VALIDATION records the 04-02 gate as owner-approved)"
    why_human: "Process prohibitions leave no artifact in the repo; non-authoritative verifier verdict: no contrary evidence found"
---

# Phase 4: Chat Verification Report

**Phase Goal:** A team can do its daily conversation in the workspace — completing the Phase 1 channels, threads and mentions with DMs, notifications, search and files — with every message attributed, editable under audit and delivered in realtime (mode: mvp)
**Verified:** 2026-10-06T12:18:22Z
**Status:** human_needed
**Re-verification:** No — initial verification

## User Flow Coverage (MVP mode)

User story (04-01-PLAN): *As a member of a team that works in the workspace, I want to hold my whole daily conversation there ..., so that I do not need a second chat tool and every message stays attributed, editable under audit and delivered in realtime.*

| Step | Expected | Evidence in codebase | Status |
| --- | --- | --- | --- |
| Find my conversations | Sidebar grouped by department/team; All, Mentions, Threads, AI Chats, Saved views | `chat/sidebar-sections.tsx`, `app/(app)/chat/{all,mentions,threads,ai,saved}/page.tsx`, `chat/sidebar.int`, `chat/threads.int` | ✓ |
| Talk to people and bots | Human, group and mixed DMs, fixed membership, private | `chat/dm.ts` (`dmKeyOf`, `MAX_GROUP_PARTICIPANTS`), `POST/GET /dms`, `dm-privacy.int` 12/12 run here | ✓ |
| Edit, delete, react, pin, save, link | Author edit with append-only versions + audit; admin delete only where readable; reactions; pins; saves; permalinks | `chat/message-actions.ts`, `reactions.ts`, `pins.ts`, `saves.ts`; routes registered at `chat/index.ts:1292-1300`; `REVOKE UPDATE, DELETE ... message_versions` in `post-migrate.sql:18` | ✓ |
| Be notified the way I chose | Mentions/@channel/@here/DM/thread notifications; mute, DND, levels, desktop/web toggles | `notification/service.ts` (resolver-filtered recipients, `decideNotify` popup), `os-notifications.ts` toggle gate, `OsNotifier` mounted in `app-shell.tsx`, prefs.int 15/15 run here | ✓ (OS click/dock: human) |
| Know what is unread | Per-conversation unread + mention badges counted over messages; mark read/unread | `unreadCountsFor` (`m.seq > cm.last_read_seq`, capped), `/conversations/:id/unread`, `unread.int` | ✓ |
| Find anything | FTS over the resolver's readable set, people, channels, filters | `search/index.ts` (`readableFor` → `access.readableIds`), `search/service.ts`, search.int 23/23 run here | ✓ |
| Share files | Drag/drop/paste, presign to Garage, sniff, renditions, authorized download | `artifact/attachments.ts`, `storage.ts` (tenant keys `org/<org>/conv/<conv>/att/<att>/<part>`), Garage in `compose.yaml` | ✓ |

The `[outcome]` clause holds: messages are attributed (author ids, ids-only notification rows), editable under audit (`message.edited`/`message.deleted` audits, append-only versions) and delivered in realtime (`message.updated`, `notification.created`, reactions/pins events on the existing streams).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1: Sidebar groups channels by department/team with All, Mentions, Threads and AI Chats views | ✓ VERIFIED | `sidebar-sections.tsx` groups by top-level unit with team sub-labels; view pages exist; `channel.update` + unit-scoped rules in resolver; `sidebar.int`, `threads.int` green in `pnpm verify` |
| 2 | SC2: DMs and group DMs between humans, humans and agents, or mixed | ✓ VERIFIED | `chat/dm.ts` insert-or-get on `(organization_id, dm_key)`, 3-9 participants, personal bots refused; `dm.int`, `group-dm.int`, `bot-capabilities/memory.int` green; `dm-privacy.int` 12/12 re-run by verifier |
| 3 | SC3: One shared renderer; edit/delete (edited marker, versions, admin delete); reactions; @channel/@here with notifications; pins, saves, permalinks | ✓ VERIFIED | Single `components/markdown/markdown.tsx` imported by chat (`message-list`, `message-card`, `threads-view`) and Work Zone (`event-stream`) through thin wrappers; no `react-markdown`/`rehype-raw`/`dangerouslySetInnerHTML` anywhere in `apps/web`; XSS fixtures + `safeUrl` (50 tests) re-run green. AI-chat part deferred to Phase 5 (no surface yet) |
| 4 | SC4: Realtime unread/mention badges with mark read/unread; mute, DND, mention-only, desktop/web toggles honoured by the inbox | ✓ VERIFIED | `unreadCountsFor` counts messages after `last_read_seq` (never `streams.last_seq`); `decideNotify` (DND/mute → no popup, levels); client toggle gate `shouldPopup`; prefs.int 15/15 re-run (mute, DND, levels, level-all ephemeral, bot DM quiet). Mentions stay in the inbox when muted (Slack semantics) — pop-ups and badges honour prefs |
| 5 | SC5: Full-text search with channel/author/date filters; attachments by drag/drop/paste on S3-compatible storage in compose; permalink jumps on cursor pagination | ✓ VERIFIED | search.int (es/en/accents, filters, paging, privacy, RLS, 429); Garage `dxflrs/garage:v2.4.1` in `compose.yaml` without `:?` guards, `docker compose config -q` passes with no S3 keys; presign/complete/download routes; `permalink.int` (around/after, hidden = 404) |
| 6 | D-01: admin delete only where readable; no DM moderation | ✓ VERIFIED | `DELETE /messages/:id` calls `access.readable` before `message.delete_any`; policy precondition denies `message.delete_any` on state `dm`; dm-privacy.int "bare 404 on every route" |
| 7 | D-02: notify only while the app runs; no Web Push | ✓ VERIFIED | 0 hits for `serviceWorker|PushManager|vapid|PushSubscription` in web/api; `requestPermission` only from the settings click handler |
| 8 | D-03: Garage, presigned PUT with signed type, sniffing, sharp renditions, 25 MiB, tenant keys, audit, `WHEN_REQUIRED` checksums | ✓ VERIFIED | `storage.ts:24-26,67-68`; `attachments.ts` (resolver read + `channel.post` + `attachment.upload`, size check, sniff, SHA-256, `attachment.uploaded`/`downloaded` audits, `res.headers.location` redacted in `app.ts`); ADR-0015 |
| 9 | D-04: PostgreSQL FTS + pg_trgm, results only from resolver readable set | ✓ VERIFIED | migration adds unaccent/pg_trgm, 3 configs, generated `search_tsv` + GIN; `searchMessages` filters `conversation_id = any(readable)` where readable comes only from `access.readableIds`; `in` outside readable → empty, not 404; ADR-0016 |
| 10 | D-05: streamdown, no raw HTML, shiki, mention chips | ✓ VERIFIED | `streamdown 2.6.0` + `@streamdown/code 1.1.1` pinned; explicit rehype list (images→links, harden, mentions); `urlTransform` = `safeUrl` |
| 11 | D-06: sorted-id `dm_key`, fixed membership, max 9, no personal bots in groups, memory off with ≥ 2 humans | ✓ VERIFIED | `dm.ts:18-25,156`; `DM_FIXED` precondition; group-dm.int + memory.int green |
| 12 | D-07: count messages for badges; mark as unread | ✓ VERIFIED | `service.ts:281-326`; `/conversations/:id/unread` (backwards only, own row, top-level message) ; unread.int green |
| 13 | D-08: Slack/T3 Code visual quality at 1440/390 light/dark | ? UNCERTAIN | 04-UI-REVIEW.md: 116 verdict rows, 3 fixed, 7 cosmetic follow-ups; screenshots spot-checked (thread with image, grouped sidebar dark) look coherent. Owner taste review required |

**Score:** 12/13 truths verified (0 present, behavior-unverified; 1 needs the owner)

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | AI chat messages through the shared renderer | Phase 5 | Phase 5 SC2 builds the private AI chat with streaming; renderer and its streaming variant already exist |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `packages/db/drizzle/20261006041904_chat_workspace/migration.sql` | 8 tables, FTS, trgm | ✓ VERIFIED | RLS applied generically by `packages/db/sql/post-migrate.sql` (ENABLE+FORCE for every `app` table with `organization_id`), versions append-only; `rls-isolation.int` covers all 8 tables |
| `apps/api/src/modules/chat/access.ts` | single readable-set authority | ✓ VERIFIED | used by search, artifact, notification, chat lists |
| `apps/api/src/modules/search/*` | FTS routes | ✓ VERIFIED | mounted in `app.ts`; 4 routes, per-user rate limit |
| `apps/api/src/modules/notification/*` | inbox, prefs | ✓ VERIFIED | mounted in `app.ts`; chat never imports it (0 imports; seam `chatEvents`) |
| `apps/api/src/modules/artifact/*` | attachments | ✓ VERIFIED | mounted with `createConversationAccess(core)` |
| `apps/web/components/markdown/markdown.tsx` | one renderer | ✓ VERIFIED | the only Markdown engine in `apps/web` |
| `apps/web/components/notifications/os-notifier.tsx` | pop-ups + title/dock badge | ✓ VERIFIED | mounted once in `app-shell.tsx`; calls `ocwDesktop.setBadgeCount`; desktop main validates sender and integer |
| `compose.yaml` garage service | S3 in compose | ✓ VERIFIED | API `depends_on: garage (service_started)`; empty keys disable attachments only |
| `docs/adr/0015-*`, `docs/adr/0016-*` | decisions | ✓ VERIFIED | added; ADR-0003 untouched since phase start |

### Key Link Verification

| From | To | Via | Status |
| --- | --- | --- | --- |
| `app.ts` module registry | chat / notification / artifact / search | `createXModule(core)` lines | WIRED |
| `chat/index.ts` | reactions, pins, saves, message actions, threads | `register*Routes(app, routeCtx)` (1292-1300) | WIRED |
| search / artifact / notification | permission resolver | `access.readableIds` / `access.readable` / `isReadable` → `perms.filterFor/decide("channel.read")` | WIRED |
| chat message writes | notifications | `core.chatEvents.messageCreated/messageEdited` seam | WIRED |
| notification service | client pop-up | `notification.created {popup}` on `user:<id>` → `OsNotifier` → `shouldPopup` (desktop/web toggle) | WIRED |
| web | desktop dock badge | `window.ocwDesktop.setBadgeCount` → preload → `Channels.setBadgeCount` → `app.setBadgeCount` | WIRED (OS effect: human) |
| attachments | Garage | presigned PUT/GET signed for `OCW_S3_PUBLIC_URL`; server ops via `OCW_S3_ENDPOINT` | WIRED |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
| --- | --- | --- | --- | --- |
| Sidebar badges | `unreadCount`/`mentionCount` | `unreadCountsFor` SQL over `app.messages` + `app.notifications` | yes | ✓ FLOWING |
| Search results | hits/people/channels | `search_tsv @@ websearch_to_tsquery` over readable ids; trgm on names | yes | ✓ FLOWING |
| Inbox | notifications | `app.notifications` filtered by `visible(me, readableIds)` | yes | ✓ FLOWING |
| Attachment previews | webp renditions | sharp output stored in Garage, served via authorized 302 | yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Full gate | `pnpm verify` | lint 760 files clean; typecheck 8/8; 139 files / 1917 tests passed (unit, integration on testcontainers PG+Redis+Garage, web) | ✓ PASS |
| Typecheck uncached | `pnpm typecheck --force` | 8/8, 0 cached | ✓ PASS |
| DM privacy | `vitest --project integration chat/dm-privacy.int` | 12/12 | ✓ PASS |
| Search + prefs | `vitest --project integration search/search.int notification/prefs.int` | 38/38 | ✓ PASS |
| Renderer XSS | `vitest --project web components/markdown` | all pass (script, onerror, javascript:/data:/vbscript:, iframe, style, controls in scheme) | ✓ PASS |
| Infra / scripts | `node --test 'infra/**/*.test.mjs'`; `'scripts/**/*.test.mjs'` | 88/88; 4/4 | ✓ PASS |
| Desktop IPC | `env -u ELECTRON_RUN_AS_NODE OCW_HOME=<tmp> pnpm --filter @ocw/desktop test` | 10 files / 67 tests | ✓ PASS |
| Compose with Garage, no S3 keys | `docker compose -p ocw-verif-config --env-file <placeholders> config -q` | exit 0 | ✓ PASS |
| E2E (153 passed claim) | not run by verifier (isolated harness) | executor-reported; CI at HEAD blocked by billing | ? SKIP → human |

### Probe Execution

No `scripts/*/tests/probe-*.sh` declared or present for this phase. SKIPPED.

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
| --- | --- | --- | --- |
| CHAT-02 | 04-08 | ✓ SATISFIED | Truth 1 |
| CHAT-04 | 04-07 | ✓ SATISFIED | Truth 2, 11 |
| CHAT-05 | 04-02 | ✓ SATISFIED | Truth 3, 10 (AI-chat surface deferred to Phase 5) |
| CHAT-06 | 04-01 | ✓ SATISFIED | Truth 3, 6 |
| CHAT-07 | 04-05 | ✓ SATISFIED | `reactions.ts`, `reactions.int` (agents cannot react yet, noted in traceability) |
| CHAT-08 | 04-09 | ✓ SATISFIED | recipients/service, `channel.mention_all` + 1/min limit, notifications.int |
| CHAT-09 | 04-10 | ✓ SATISFIED | Truth 4, 12 (wording: counts over messages per D-07, documented) |
| CHAT-10 | 04-11 | ✓ SATISFIED (OS click/dock: human) | Truth 4, 7 |
| CHAT-11 | 04-06 | ✓ SATISFIED | Truth 5, 9 |
| CHAT-12 | 04-04, 04-12 | ✓ SATISFIED | Truth 5, 8 |
| CHAT-13 | 04-03, 04-05 | ✓ SATISFIED | pins/saves/permalinks |
| CHAT-14 | 04-03 | ✓ SATISFIED | permalink.int, detached window + Jump to latest |

No orphaned requirements: every Phase 4 ID in REQUIREMENTS.md is claimed by a plan.

### Prohibitions (plan must_haves, untiered → judgment)

Spot-checked with code evidence (non-authoritative verdict: respected): no chat→notification import; no rehype-raw / raw HTML; no Push/SW/VAPID; notifications table has no body/snippet column; edit path never calls `emitAgentMention`; unread never from `streams.last_seq`; object keys ids-only; no `:?` on Garage vars; permission request only on click; DM admin paths 404 (test-backed); search visibility only from resolver ids (test-backed); ADR-0003 not edited (`git diff` since 04-01: only 0015/0016 added). Process-only prohibitions are flagged for owner confirmation (see human_verification).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| 225 files changed since 04-01 | — | `TBD`/`FIXME`/`XXX`/`TODO`/`HACK` | none | 0 debt markers (one `xxx` is test data in `threads.int.test.ts:277`) |
| `e2e/tests/{dms,bots,personal-bots}.spec.ts` | — | conditional `test.skip(!token)` | ℹ️ Info | skip only without `OCW_CELL_TOKEN`; harness sets it |
| `apps/web/components/chat/views/threads-view.tsx` | — | mentions as plain text in Threads cards | ⚠️ Warning (cosmetic) | UI-REVIEW follow-up |

### Human Verification Required

1. **Signed-build notification click** — mention while backgrounded, click; app focuses on the message (macOS needs code signing).
2. **Dock badge** — two mentions show "2" on the dock icon and clear on read.
3. **Owner visual review** — 04-UI-REVIEW.md + screenshots; decide on the 7 cosmetic follow-ups.
4. **CI on PR #16** — restore Actions billing and re-run; expect all five jobs green at HEAD.
5. **Process prohibitions** — confirm the demo/.env DB were never touched and the 04-02 package gate preceded installs.

### Gaps Summary

No code gaps. Every roadmap success criterion, CHAT requirement and D-01…D-07 decision is implemented, wired into `app.ts`, tenant-scoped by generic FORCE RLS, routed through the single resolver-backed readable set, and covered by tests the verifier re-ran (pnpm verify 1917/1917 plus targeted privacy, search, prefs and XSS suites). What remains is owner-side: two OS-level notification checks that need a signed build, the D-08 visual sign-off, and a CI re-run that is currently blocked by GitHub billing (the last executed CI failure was a test assertion fixed in 04-13). AI-chat rendering is deferred to Phase 5 by design.

---

_Verified: 2026-10-06T12:18:22Z_
_Verifier: Claude (gsd-verifier)_
