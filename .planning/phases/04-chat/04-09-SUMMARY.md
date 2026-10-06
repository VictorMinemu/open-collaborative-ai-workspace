---
phase: 04-chat
plan: 09
subsystem: chat
status: complete
tags: [chat, notifications, mentions, inbox, realtime, presence, privacy, web]
requirements: [CHAT-08]
dependency_graph:
  requires: [04-01 (contracts, notifications tables, channel.mention_all, access.ts), 04-03 (permalinkPath), 04-07 (DMs, groups, privacy suite), 04-08 (CHAT_VIEWS, Threads view)]
  provides:
    - "lib/chat-events.ts: createChatEvents / ChatEvents (messagePosted, messageEdited in the message transaction); Core.chatEvents"
    - "modules/notification: createNotificationModule, computeRecipients, snippetOf, unreadCountFor, MENTIONS_FILTER_KINDS"
    - "GET /api/v1/notifications (filter all|mentions, keyset cursor, unreadCount), POST /api/v1/notifications/read"
    - "modules/realtime/online.ts: createOnlineSet / OnlineSet (ocw:online:<orgId>), maintained by the gateway"
    - "error code mention_all_rate_limited (429); channel.mention_all in viewerCan"
    - "web: Inbox at /chat/mentions, Mentions second in CHAT_VIEWS with a live badge, lib/notification-queries.ts, composer specialMentions + memberCount confirmation, MentionChip export with broadcast chips"
  affects: [04-10 (mention counts per conversation from the same rows; notification.read already on user:), 04-11 (popup is decided server-side already; prefs UI plugs into decideNotify inputs), 04-13]
tech-stack:
  added: []
  patterns:
    - "observer seam (chat-events) like the agent bridge: chat emits inside the transaction, notification registers; no chat → notification import"
    - "upsert one row per (user, message) where the strongest kind wins (array_position over the rank order); an upgrade re-announces and makes it unread"
    - "inbox lists re-filter by access.readableIds and join live messages at read time; snippets are computed from the current body"
key-files:
  created:
    - apps/api/src/lib/chat-events.ts
    - apps/api/src/modules/notification/{index,service,recipients,routes,snippet}.ts
    - apps/api/src/modules/notification/{recipients,snippet}.test.ts
    - apps/api/src/modules/notification/notifications.int.test.ts
    - apps/api/src/modules/realtime/online.ts
    - apps/web/components/chat/inbox.tsx
    - apps/web/app/(app)/chat/mentions/page.tsx
    - apps/web/lib/notification-queries.ts
    - e2e/tests/notifications.spec.ts
  modified:
    - apps/api/src/{app,core}.ts
    - apps/api/src/modules/chat/{index,mentions,mentions.test,message-actions,dm-privacy.int.test}.ts
    - apps/api/src/modules/realtime/{gateway,index}.ts
    - apps/web/components/chat/{chat-sidebar,sidebar-views,composer,channel-view,markdown}.tsx
    - apps/web/components/markdown/{markdown,markdown.test}.tsx
    - e2e/tests/chat-sidebar.spec.ts
decisions:
  - "Bots are actors, never recipients: a bot reply notifies the people it mentions, the thread's participants and the human of a bot DM (kind dm)"
  - "The sidebar Mentions badge counts unread notifications of the Mentions filter (mention, channel, here); notification.read carries the all-activity count and the client refetches both shortly after"
  - "A stronger reason on the same message (e.g. a thread reply later edited to mention you) upgrades the row to the stronger kind, marks it unread and re-announces it; equal or weaker reasons change nothing"
  - "Inbox snippets are one line of plain text (Markdown markup dropped, @mentions kept), computed at read time"
  - "The @channel/@here limit is claimed in Redis before the insert; a client retry of an already-posted message (same clientMessageId) is exempt"
metrics:
  duration: "~45 min"
  completed: 2026-10-06
  tasks: 3
  files: 41
estimate:
  tokens: 210000
actuals:
  tokens: 34500
  tasks: 3
  commits: 3
---

# Phase 4 Plan 09: Notifications, @channel/@here and the Mentions inbox Summary

Mentions, DMs, group DMs and thread replies now create private, ids-only notifications in the message transaction. They reach the member's `user:` stream, show in a new Mentions view (`/chat/mentions`, filters Mentions / All activity) with a live badge, and jump to the message when opened. `@channel` and `@here` autocomplete in the channel composer, ask for confirmation above 20 members, are deny-able (`channel.mention_all`) and limited to one per channel per minute. `@here` reaches only members online right now. Edits notify only newly mentioned people. The inbox never shows a conversation the member can no longer read, or a deleted message.

## What was built

- **Seam (`lib/chat-events.ts`):** `messagePosted` / `messageEdited` run inside the message transaction. Chat calls them for created human messages (POST messages), created bot messages (`providePostAgentMessage`) and edits (PATCH). The notification module registers its handlers. Chat never imports it (acceptance grep is empty).
- **Recipients (`recipients.ts`, pure):**
  - an explicit mention → `mention`
  - a DM → `dm`; a group → `group_dm`
  - a thread reply → `thread_reply` for the root author and earlier repliers
  - `@channel` → every human member; `@here` → online human members only

  One kind per user (strongest wins); the author is excluded.
- **Service:** keeps only active members that `access.isReadable` allows (P-03), then upserts `(user_id, message_id)` rows. For each new or upgraded row it appends `notification.created` on `user:<id>` with `popup` from `decideNotify` (prefs row or defaults, membership level and mute). Rows store ids and the actor only.
- **Routes:**
  - `GET /notifications`: own rows only, from `access.readableIds`, joined to live messages; snippet computed now; opaque keyset cursor (`invalid_cursor` → 400); `unreadCount` per filter.
  - `POST /notifications/read` (`ids` or `all`): own rows only. Appends `notification.read` with the new count, only when something changed.
- **Online set (`realtime/online.ts`):** sorted set `ocw:online:<orgId>`, member `conn|userId|state`, score = expiry (presence TTL). The gateway adds on open, swaps on `presence` frames, refreshes on the heartbeat and removes on close. One instance is shared by the realtime and notification modules.
- **@channel/@here (POST messages, channels only):** `mentionAllOf(body)` → `channel.mention_all` decided on the channel (403 with the denial, audited) → Redis `SET NX PX 60000` gate (429 `mention_all_rate_limited`) → `mentionAll` through the seam. Reserved handles never resolve as people or bots, so a broadcast never wakes a bot.
- **Web:**
  - `Inbox`: filter tabs, rows (avatar, actor, kind label, conversation, time, two-line snippet with mention chips, unread dot), "Mark all read", infinite scroll, empty state. Clicking a row marks it read and opens the permalink.
  - Sidebar: Mentions sits second in `CHAT_VIEWS` with a badge. `notification.*` frames are routed from the existing `user:` subscription. A notification in a thread also refreshes the Threads view, which closes the 04-08 open item.
  - Composer: `@channel` / `@here` options with descriptions, and a confirm dialog (`mention-all-confirm`).
  - Markdown: a broadcast chip (`mention-all`).

## Verification

| Check | Result |
|---|---|
| `vitest --project unit notification/recipients.test.ts` | 12/12 (RED first: module missing) |
| `vitest --project unit notification/snippet.test.ts` | 3/3 (RED first) |
| `vitest --project unit chat/mentions.test.ts` | 5/5 (reserved-handle case RED first) |
| `vitest --project integration notification/notifications.int.test.ts` | 25/25. RED per task: task 1 9 failing; task 2 7 failing; task 3 1 failing (the edit case) |
| `vitest --project integration realtime-presence.int.test.ts` | 9/9 (presence unchanged) |
| `vitest --project integration chat/dm-privacy.int.test.ts` | 12/12 (2 new cases, inbox added to the list checks) |
| `vitest --project web markdown.test.tsx` | 73/73 (1 new) |
| `pnpm verify`, after each task | task 1: 134 files / 1820 tests; task 2: 1833; task 3 (final tree): 134 files / 1840 tests, all exit 0 |
| e2e task 1: `notifications chat.spec bots chat-sidebar` | 15/15 |
| e2e task 2: `notifications presence dms` | 13/13 |
| Final e2e: `notifications chat.spec dms chat-sidebar chat-edit permalinks bots presence` (desktop + mobile) | 37/37, none skipped or flaky |
| Acceptance greps | `messagePosted` ×2 in chat/index.ts; no `modules/notification` import in chat; `createNotificationModule` in app.ts; mentions page exists; `mention_all_rate_limited` in chat/index.ts; `export function createOnlineSet`; `mention-all` in markdown.tsx; `messageEdited` in message-actions.ts; `notifications` ×12 in dm-privacy |

I reviewed these screenshots with the Read tool: `inbox-{1440,390}[-dark]`, `composer-special-mentions-{1440,390}` and `mention-all-confirm-{1440,390}[-dark]`.
- Fix from the review: snippets showed raw Markdown (`**Friday**`). They are now plain text (`snippet.ts`, TDD).
- At 390 the confirm dialog is a bottom sheet and the inbox rows wrap cleanly.
- I restored the regression captures from the other specs; they are not committed.

## Deviations from Plan

1. **[Rule 1/UX] `notification/snippet.ts` + `snippet.test.ts` (not in the file list).** Snippets drop Markdown markup (found in the screenshot review). They are still one line, ≤ 140 characters, computed at read time.
2. **[Order] DM, group and thread-reply recipients went in with task 1.** `computeRecipients` covered every kind from the start, so the task 2 int cases for them passed on their first run; only the `@channel`/`@here`, online-set, permission and limit cases were RED.
3. **[Order] `realtime/online.ts` was committed in task 1** (complete; no stub), because the notification module takes an `OnlineSet`. Gateway wiring and its tests came in task 2.
4. **[Spec] `e2e/tests/chat-sidebar.spec.ts` updated.** It asserted the view list without Mentions.
5. **[Rule 2] Two additions to the @channel/@here gate:**
   - a client retry of an already-posted message (same `clientMessageId`) is exempt from the limit, so it gets the message back rather than a 429;
   - `channel.mention_all` is added to the channel `viewerCan`, so the composer only offers what the server allows.
6. **[Rule 2] Deactivated members are never recipients** (an explicit filter in addition to the resolver).
7. **[Decision] `notification.read` goes out only when rows changed.** Marking someone else's id is a 200 with no event (asserted in the DM privacy suite).
8. **[Spec] The inbox in the DM privacy suite** sits in `expectAbsentFromLists` and in a new describe block, not in `routesFor`. `GET /notifications` is a list (200, empty), not a per-conversation 404 route.
9. **[Process] e2e uses one recipient per project** (Nadia on desktop, Milo on mobile) and 20 "crowd" members, created once, for the warning threshold.

### CLAUDE.md
- No migration: `notifications`, `notification_prefs`, `conversation_members.notify_level/muted` and `channel.mention_all` exist since 04-01.
- No permission or policy change beyond reading `channel.mention_all` (already in the standard role list).
- `.env` was symlinked only for the isolated e2e and has been removed; I never read it.
- `wt/04-09` is outside the executor's agent-branch allow-list; I committed there as instructed.

## Known Stubs

None.

## Open issues

- A bot reply in a member's own bot DM creates a `dm` notification. It is consistent (DMs notify), but it may be noisy for heavy AI-chat users; 04-11 preferences (mute or level per conversation) can quiet it.
- Notifications are not marked read when the member opens the conversation directly, only from the inbox or with "Mark all read". 04-10 owns read state and badges.
- The thread panel composer does not offer `@channel`/`@here` in autocomplete. Typing them still works and is enforced server-side.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/notification/snippet.ts --description "Inbox snippets drop Markdown markup (plain one-line text, computed at read time); file not in plan list"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/index.ts --description "@channel/@here limit exempts client retries of an already-posted message; channel.mention_all added to viewerCan"
gsd windows append --kind deviation --phase 04 --file e2e/tests/chat-sidebar.spec.ts --description "View list assertion updated for Mentions (inserted second by plan)"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/dm-privacy.int.test.ts --description "Inbox privacy covered via list checks and a dedicated describe, not routesFor (GET /notifications is a 200 list)"
```

## Threat model coverage

- **T-04-09-01:** `isReadable` per recipient at write time and `readableIds` at list time. Rows hold ids only (column check in a test). Tests cover: private channel (no row), lost access (hidden, count drops, back on re-add), deleted messages, DMs and groups for same-org and other-org admins.
- **T-04-09-02:** `channel.mention_all` deny → 403 with no message. A second broadcast within a minute → 429 with no message. Composer confirmation above 20 members. A code span or fence notifies nobody.
- **T-04-09-03:** reserved handles never resolve (unit test with a tampered directory); `here@…` resolves as `here-1`.
- **T-04-09-04 (accepted):** only the server reads `ocw:online:*`.
- **T-04-09-05:** mark-read is scoped to `user_id = me` (and RLS). Cross-user and cross-org attempts change nothing and emit nothing.
- **T-04-09-06:** edits notify only new mentions and never `@channel`/`@here` (int tests).
- **T-04-09-07:** the seam keeps chat free of notification imports (grep). Every access decision goes through `createConversationAccess`.

No new surface beyond the plan.

## Commits

- 11975fd feat(chat): mentions notify through a chat-events seam into the new Notification module and a live Mentions inbox (04-09 task 1)
- bcd641f feat(chat): @channel and @here notify members (online only for @here) behind a deny-able permission and a 1/min/channel limit; DMs, groups and thread replies notify their people (04-09 task 2)
- cadc3a1 feat(chat): edits notify only newly mentioned members; the inbox never outlives access, deletion or DM privacy (04-09 task 3)

## Self-Check: PASSED

All created files exist. Commits 11975fd, bcd641f and cadc3a1 are on `wt/04-09`. The working tree was clean before this summary. The `.env` symlink has been removed.
