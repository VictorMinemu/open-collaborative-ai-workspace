---
phase: 04-chat
plan: 10
subsystem: chat
status: complete
tags: [chat, unread, mentions, badges, read-state, realtime, notifications, web]
requirements: [CHAT-09]
dependency_graph:
  requires: [04-01 (UnreadFields, MarkUnreadRequest, ConversationReadEvent, UNREAD_CAP, MENTION_KINDS, badgeStyle), 04-03 (detached permalink window), 04-08 (Threads view, thread_reads), 04-09 (chat-events seam, notification module, user: frame routing)]
  provides:
    - "chat/service.ts: unreadCountsFor(tx, userId, ids), withUnreadCounts, exported lockNextSeq"
    - "counts (unreadCount, mentionCount, notifyLevel, muted) on GET /api/v1/channels, GET /api/v1/channels/:id, GET /api/v1/dms"
    - "POST /api/v1/conversations/:id/unread (MarkUnreadRequest); error codes not_top_level, not_a_member"
    - "conversation.read on user:<me> from both read routes and the unread route (+ optional latestMessageSeq)"
    - "lib/chat-events.ts: conversationRead / onConversationRead (ConversationReadInput with optional threadRootId)"
    - "ThreadList.unreadThreads (first page): every thread with unread replies, not just the loaded page"
    - "web: ConversationBadge, ConversationNotifyMenu (conversation-notify-menu, mark-read, mark-unread-latest), Mark unread action (mark-unread), New messages divider, use-read-cursor.ts, chat-queries markConversationRead / markConversationUnread / applyConversationRead / bumpUnread / bumpMention / read holds"
  affects: [04-11 (adds levels and mute to ConversationNotifyMenu; badgeStyle already reads notifyLevel/muted), 04-13]
tech-stack:
  added: []
  patterns:
    - "One read-cursor helper (moveReadCursor) for read and mark-unread: lock cursor row, clear notifications through the seam, lock the user: stream, count, announce only on change"
    - "Live badge deltas are seq-idempotent against the snapshot; resync, deletes and a stale conversation.read refetch the snapshot"
    - "Per-tab read hold in sessionStorage; released by a gesture to the bottom, sending, Mark as read, or another device reading past it"
key-files:
  created:
    - apps/api/src/modules/chat/unread.int.test.ts
    - apps/web/components/chat/conversation-badge.tsx
    - apps/web/components/chat/conversation-notify-menu.tsx
    - apps/web/components/chat/use-read-cursor.ts
    - e2e/tests/unread.spec.ts
  modified:
    - packages/contracts/src/{notifications,chat}.ts
    - apps/api/src/lib/chat-events.ts
    - apps/api/src/modules/chat/{service,dm,index,threads,dm-privacy.int.test}.ts
    - apps/api/src/modules/notification/{index,service,routes}.ts
    - apps/web/lib/chat-queries.ts
    - apps/web/components/chat/{chat-sidebar,sidebar-sections,channel-icon,channel-view,dm-view,message-list,message-actions}.tsx
decisions:
  - "Mention badge = unread MENTION_KINDS notifications of live top-level messages; a mention inside a thread belongs to the thread (Threads and Mentions views), so a channel badge never sticks on a reply the channel view cannot clear"
  - "Reading old history (04-03 open item): a detached permalink window marks read only up to its newest shown message; the rest stays unread until the member reaches the live end"
  - "Reading a conversation reads its notifications up to the cursor (04-09 open item); reading a thread reads that thread's notifications; mark unread never un-reads a notification"
  - "A read or mark-unread that changes neither the cursor nor the counts announces nothing"
  - "Opening a conversation with unread messages shows a New messages divider for the visit (also where the member marked it unread)"
  - "Mark unread on a channel the member has not joined is 400 not_a_member (no cursor)"
metrics:
  duration: "~85 min"
  completed: 2026-10-06
  tasks: 2
  files: 24
estimate:
  tokens: 150000
actuals:
  tokens: 20500
  tasks: 2
  commits: 2
---

# Phase 4 Plan 10: Unread and mention badges counted over messages, mark read/unread synced across devices Summary

Every channel and DM row now shows a counted badge: a primary pill with the mention count when something addresses the member, otherwise a muted pill with the unread count ("99+" at the cap). The counts come from messages, never stream seq, so reactions, edits, thread replies and member joins don't change them. They update live from the frames the sidebar already receives. Reading a conversation clears the badge and the matching notifications on every tab and device. Members can mark a conversation unread from any message (or from the header menu), and the tab holds it unread until they read it.

## What was built

- **Counts (API):** `unreadCountsFor` is one SQL statement with two capped `LATERAL` counts per membership.
  - Unread: top-level, live messages from others after `last_read_seq`, on `messages_conv_seq_idx`.
  - Mentions: unread `MENTION_KINDS` notifications of live top-level messages, on `notifications_unread_idx`.

  The API applies it only to rows the resolver kept (`GET /channels`, `GET /channels/:id`, `GET /dms`). Conversations the member hasn't joined report 0/0. Each row also returns `notifyLevel` and `muted`.
- **Read state (API):** both read routes and the new unread route go through one `moveReadCursor`, in this order:
  1. Lock the member's cursor row.
  2. Move the cursor: forward with `greatest` for a read, to an exact value for mark-unread.
  3. For a read only, run `chatEvents.conversationRead`; the notification module marks those notifications read and appends `notification.read`.
  4. Lock the `user:` stream, so no notification can overtake the counts.
  5. Recount, then append `conversation.read {lastReadSeq, unreadCount, mentionCount, latestMessageSeq}`.

  Thread reads clear that thread's notifications. `GET /threads` reports `unreadThreads` across all pages on its first page (04-08 open item).
- **Mark unread:** `POST /conversations/:id/unread {messageId}`:
  - hidden or missing conversation → 404;
  - message from another conversation, or an unknown id → 404;
  - thread reply → 400 `not_top_level`;
  - channel the member hasn't joined → 400 `not_a_member`;
  - otherwise the cursor is set to exactly `seq - 1`.
- **Web:**
  - `ConversationBadge` renders `badgeStyle`: mention, count, dot or none. Muted rows are dimmed.
  - The watchers apply seq-idempotent `bumpUnread`. `notification.created` triggers `bumpMention`, counted once per id. `conversation.read` triggers `applyConversationRead`. If the event's counts are older than a message the tab already holds, the tab refetches the snapshot.
  - The snapshot is also refetched on resync and when a top-level message is deleted. There are no new subscriptions.
  - `use-read-cursor.ts`, shared by the channel and DM views, does three things:
    - marks read while the tab is visible (only up to the newest message of a detached window);
    - captures the New messages divider;
    - manages the per-tab hold. The hold persists in sessionStorage and ends when the member scrolls to the bottom, sends a message or picks Mark as read, or when another device reads past it.
  - `ConversationNotifyMenu` (bell button in the channel and DM headers) offers Mark as read and Mark as unread. Messages get "Mark unread" in the More menu and in the long-press sheet.

## Verification

| Check | Result |
|---|---|
| `vitest --project integration chat/unread.int.test.ts` | 22/22. Task 1: 12 RED first, then the Threads total case RED, then green. Task 2: 5 RED first (the hidden-404 case already passed) |
| Neighbours: `notifications.int`, `threads.int`, `chat.int`, `dm-privacy.int` | 25/25, 7/7, 28/28, 12/12 |
| `vitest --project web` | 111/111 |
| `pnpm typecheck --force` after each contract change | 8/8 |
| `pnpm verify` task 1 | exit 0: 135 files, 1856 tests. The first full run had 2 failures: `plugins-cell` (docker.sock ECONNREFUSED, load only; passed on retry) and the `dm-privacy` fixture (deviation 4) |
| `pnpm verify` task 2 (final tree) | exit 0: 135 files, 1862 tests |
| e2e `unread` (task 1, then both tasks) | 3/3, then 5/5 |
| e2e `unread notifications chat-sidebar chat.spec permalinks dms chat-edit reactions-pins` (desktop + mobile) | 37/37, none skipped or flaky |
| e2e `unread --repeat-each=3` | 13/13 |
| Acceptance greps | `unreadCountsFor` in service.ts and dm.ts; `unreadCount` ×34 in the int test; `conversationRead` in chat/index.ts; `"/conversations/:id/unread"` and `not_top_level` in chat/index.ts; `mark-unread` in message-actions.tsx |

Screenshots reviewed with the Read tool:
- `sidebar-badges-{1440,390}[-dark]`: the mention pill (primary) and the count pill (muted) are easy to tell apart in both themes.
- `mark-unread-{1440,390}[-dark]`: the NEW divider sits above message 2, and the active row keeps its "3" while held.
- Fix from the review: the capture now moves the pointer away and blurs focus first, because two hover toolbars cluttered the first 1440 shot.

I also checked the regression captures of the other specs (`dm-human-*` shows the new bell in the DM header, `sidebar-grouped-390` shows a count badge), then restored them; they are not committed.

## Deviations from Plan

1. **[Rule 1] The counts would have raced the notifications.** If the counts were taken before a concurrent notification committed, the `conversation.read` event (higher seq) could zero a mention the client had just counted. `moveReadCursor` now locks the `user:` stream before counting, using `lockNextSeq`, which is now exported. The lock order (cursor row → notifications → stream) matches the notification writer, so the two cannot deadlock.
2. **[Rule 1] Optional `ConversationReadEvent.latestMessageSeq`** (add-only, contracts). A `conv:` frame can overtake the `user:` event. A tab that already holds a newer message than the counts saw refetches the snapshot instead of trusting stale counts.
3. **[Folded open items]**
   - 04-03: a detached permalink window reads only what it shows.
   - 04-08: `ThreadList.unreadThreads` is counted over all pages. Changes `threads.ts` and contracts `chat.ts`, which are not in the plan's file list.
   - 04-09: opening a conversation reads its notifications, and a thread read clears that thread's notifications (`threads.ts`).
4. **[Spec] One `dm-privacy.int.test.ts` fixture changed.** The "outsider can't mark Alex's notification read" case expected Alex's notification to still be unread. Under CHAT-09 it is no longer unread, because Alex read that DM earlier in the suite. The test now makes the row unread again with the superuser before the outsiders try. The privacy assertions are unchanged.
5. **[Structure] Not in the plan's file list:**
   - `use-read-cursor.ts`, the shared hook for the channel and DM views.
   - `unreadCountFor` and `visible` moved from `notification/routes.ts` to `service.ts`, to avoid an import cycle.
   - `ConversationNotifyMenu` takes an extra `latestMessageId` prop, because mark unread needs a message id.
6. **[Addition] Extra web behaviour:**
   - The read hold persists in sessionStorage (per tab, survives a reload) and is released when another device reads past it. Without the release, a forgotten hold would block reading in that tab for good.
   - The New messages divider also shows on opening a conversation that has unread messages.
7. **[Addition] `not_a_member` (400) error code** for mark-unread on a channel the member hasn't joined. The plan didn't define this case.
8. **[Process] Commit split.** The task 1 commit already contains the task 2 UI (menu, action, divider, hold), because the view files are shared; it typechecks and lints on its own. The task 2 commit adds the route it calls, the task 2 tests, the e2e flow and the captures. Task 1's verification ran with the task 2 int cases set aside.
9. **[Process] e2e users.** Each Playwright project uses its own member (Una on desktop, Ugo on mobile), the same pattern as 04-09.

### CLAUDE.md
- No migration and no permission or policy change. The routes reuse `readableRow`, and every write is scoped to the caller's own membership and notification rows.
- `.env` was symlinked only for the isolated e2e and has been removed; I never read it. `wt/04-10` is outside the executor's agent-branch allow-list; I committed there as instructed.

## Known Stubs

None.

## Open issues

- On a phone, a long channel name truncates sooner in the header because of the new bell button. Plan 11 puts levels and mute in the same menu, so the button stays.
- The badge is not re-derived when membership changes, e.g. after leaving a channel. The list refetch (`conversation.*` on `user:`) covers it.
- The Mentions inbox badge still refreshes through `notification.read` plus a refetch; it does not reuse the per-conversation counts.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/index.ts --description "moveReadCursor locks the user: stream before counting so conversation.read never overtakes a notification; not_a_member on mark-unread for unjoined channels"
gsd windows append --kind deviation --phase 04 --file packages/contracts/src/notifications.ts --description "Add-only ConversationReadEvent.latestMessageSeq: clients refetch the snapshot when a conv: frame overtook the counts"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/threads.ts --description "Folded 04-08/04-09 items: ThreadList.unreadThreads over all pages; thread reads clear that thread's notifications"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/dm-privacy.int.test.ts --description "Fixture re-marks Alex's DM notification unread (reading the DM now reads it); privacy assertions unchanged"
gsd windows append --kind deviation --phase 04 --file apps/web/components/chat/use-read-cursor.ts --description "Shared read-cursor hook (not in plan list): detached windows read only what they show, per-tab hold in sessionStorage, New messages divider on open"
```

## Threat model coverage

- **T-04-10-01:** counts only on rows the resolver kept. Joined-only through the membership join: a public channel the member hasn't joined reports 0/0, even with a mention of them in it. Private channels are neither listed nor readable (404), and org B gets 404 and sees no rows (int tests).
- **T-04-10-02:** every update goes through the caller's own membership row (`member_id = me`), and events go only to `user:<me>`. A 404 attempt leaves other members' cursors unchanged and emits no event (int test).
- **T-04-10-03:** readable first, then the message must belong to that conversation (404). Hidden and missing conversations return the same 404.
- **T-04-10-04:** both counts are `LATERAL … LIMIT 100` on `messages_conv_seq_idx` and `notifications_unread_idx`; the Threads total is capped the same way.

No new surface beyond the plan.

## Commits

- 3e94390 feat(chat): unread and mention badges counted over messages, live, and reading clears them on every device (04-10 task 1)
- f3f0c34 feat(chat): mark a conversation unread from any message, held in that tab until read, synced to the member's other devices (04-10 task 2)

## Self-Check: PASSED

All created files exist. Commits 3e94390 and f3f0c34 are on `wt/04-10`. The working tree was clean before this summary, and the `.env` symlink has been removed.
