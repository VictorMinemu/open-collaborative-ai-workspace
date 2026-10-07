---
phase: 06-multiplayer-ai-chat
plan: 08
subsystem: api, web
status: complete
tags: [multiplayer, ai-chat, notifications, unread, inbox, realtime]
requires: ["06-03", "06-04", "06-06"]
provides:
  - notifyUsers (notification module) and ai_chat in chat events, eligibility and the inbox
  - emitChatUpdated (per-recipient ai_chat.updated)
  - POST /api/v1/ai-chats/:id/read
  - unreadCount on joined shared chat summaries
  - ai_chat_shared notifications and mention notifications in shared chats
affects: ["06-09", "06-10", "06-11", "06-12"]
tech-stack:
  added: []
  patterns:
    - "Recipients decided server-side through the readable set (kinds incl. ai_chat), never from client lists"
    - "One ai_chat.updated per recipient with their own access and unread count; solo chats keep the Phase 5 event"
key-files:
  created:
    - apps/api/src/modules/ai-chat/shared.int.test.ts
    - e2e/tests/ai-chat-shared-inbox.spec.ts
  modified:
    - apps/api/src/lib/chat-events.ts
    - apps/api/src/modules/notification/{service.ts,routes.ts,index.ts}
    - apps/api/src/modules/ai-chat/{dto.ts,service.ts,routes.ts,grants.ts,run-loop.ts,titles.ts,generations.ts,queue.ts}
    - apps/api/src/modules/chat/{service.ts,saves.ts}
    - apps/web/lib/{ai-chat-queries.ts,notification-queries.ts,ai-chat-list-cache.test.ts}
    - apps/web/components/chat/{ai-chats-section.tsx,inbox.tsx,chat-sidebar.tsx}
decisions:
  - "A new participant's unread starts after the grant's notice; the owner's cursor follows every access change he makes"
  - "Server notice lines (author_kind system) never count as unread"
  - "ai_chat_shared is listed under the inbox's Mentions filter (addressed to the member by name)"
metrics:
  duration: "~2h"
  completed: 2026-10-07
estimate:
  tokens: 180000
actuals:
  tokens: 62000
  tasks: 2
  commits: 5
---

# Phase 6 Plan 08: Shared AI chats in the sidebar, unread, inbox and notifications Summary

A direct share now notifies the person once, the chat shows up live under "Shared with me" with an unread badge that clears when they open it, mentions inside shared chats notify readers only, and every participant's sidebar follows title, activity and answering state with their own access.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Share notification, Shared with me unread, read marker, mentions, inbox (tracer) | a4d4f95 |
| 2 | Per-recipient live summaries (`emitChatUpdated`) | 4deb707 |
| — | Deferred-item record, then the grants.int fix needed for `pnpm verify` | 418a8d2, 8423098 |
| — | Screenshots | 83f1ff4 |

## What changed

- **Notifications.**
  - `notifyUsers(tx, deps, n)` keeps only recipients who are active members and can read the conversation now. It uses the readable set with `ai_chat` (`NOTIFIABLE_KINDS`) and never notifies the actor. It writes one row per (user, message), ids and the actor only, and sends `notification.created` on `user:<id>`.
  - `ChatEvents.messagePosted` accepts `conv.kind "ai_chat"`. That branch notifies only the mentioned humans who can read the chat; no @channel, DM or thread rules apply.
  - The inbox list, its unread count and the read handler's count include AI chats, so a revoke removes the chat's items at read time.
  - `conversationRefs` labels an AI chat with its title.
- **Grants.** A new person grant writes the notice row, sets the person's cursor to it and sends one `ai_chat_shared` notification on that notice. Unit and organization grants notify nobody, and neither does a level change. The owner's cursor moves up to each change he makes.
- **Unread and the read marker.**
  - `GET /ai-chats` adds `unreadCount` only to shared chats the caller has joined.
  - `POST /ai-chats/:id/read` returns 204. It checks `channel.read` first (hidden 404), then joins a unit or org grantee (cursor at the newest message). The cursor only moves forward and is capped at the newest message. The call reads the notifications it covers and sends `conversation.read` on `user:<caller>`.
  - Writers who join by posting also start at the newest message.
  - Server notice lines never count as unread (`unreadCountsFor`).
- **Live summaries.** `emitChatUpdated` sends a solo chat's Phase 5 event to the owner only. For a shared chat it sends to the owner and to every participant and person grantee: their own access, `shared`, the owner and their own `unreadCount`, and never settings. Callers: send, rename/archive, finalize, auto title, regenerate, and queue-started turns.
- **Web.**
  - "Shared with me" rows and your own shared chats show unread badges (never on the open chat), plus the "Answering" dot again (fixes the 06-03 deferred item).
  - The open shared chat is marked read, debounced on its newest seq and only while the tab is visible.
  - Losing access removes the chat from the list. `conversation.read` from other devices updates the count.
  - In the inbox, a share reads "Víctor Ruiz shared “<title>” with you". AI chat items open `/chat/ai/<id>`.

## Verification

- `shared.int.test.ts` (PostgreSQL + Redis): 17/17. RED first: Task 1, 9/10 failed; Task 2, 5/5 failed.
- Integration regressions, one at a time:

  | Suite | Result |
  |-------|--------|
  | notifications | 25/25 |
  | prefs | 15/15 |
  | unread | 22/22 |
  | titles | 7/7 |
  | list | 7/7 |
  | ai-chat | 20/20 |
  | multiplayer | 17/17 |
  | queue | 13/13 |
  | regenerate | 6/6 |
  | stop | 8/8 |
  | security | 5/5 |
  | search | 30/30 |
  | grants | 15/15 (after deviation 5) |

- Web unit (`ai-chat-list-cache.test.ts`): 5/5.
- Isolated e2e: `--rebuild-web ai-chat-shared-inbox notifications unread ai-chat-list notification-prefs chat-sidebar ai-chat-multiplayer`, 31/31 on desktop and mobile, no flakes. This covers the verify lists of both tasks.
- `pnpm verify`: exit 0. Typecheck 8/8, 177 files and 2456 tests. Lint shows only the 4 local-runtime warnings that were already there.
- All acceptance greps match: `notifyUsers` exported, `ai_chat_shared` on 5 lines, the read route, `emitChatUpdated` on 10 lines.
- Screenshots: `shared-inbox-{1440,390}[-dark]` and `shared-sidebar-unread-{1440,390}[-dark]`, all reviewed. The other specs' captures were deleted, and the 06-03 shots they overwrote were restored.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3] Files outside the list**
- **`chat/saves.ts`:** gives AI chats their title as label (the behaviour asks for "the chat title as label").
- **`chat/service.ts`:** unread skips `system` notices. Without this, every grant change would raise everyone's badge.
- **`notification/index.ts`:** exports `notifyUsers`.
- **`chat-sidebar.tsx`:** the `user:` topic router, so `conversation.read`, `ai_chat.access_changed` and the share notification reach the AI chat lists.
- **`notification-queries.ts`:** the web Mentions filter.
- **`queue.ts`:** a turn started from finalize or the sweeper now announces `generating: true` to everyone, after finalize's `false`.
- Commits: a4d4f95 (all but `queue.ts`); 4deb707 (`queue.ts`).

**2. [Rule 1] Joining cursors**
- `last_read_seq` defaulted to 0, so someone joining would have seen the whole history as unread, and so would an owner sharing an old chat.
- Person grantees now start at the grant's notice, unit/org joiners at the newest message, and the owner at each change he makes.
- Commit: a4d4f95.

**3. [UX] `ai_chat_shared` in the Mentions filter**
- Added in both the API and the web, so the share appears in the inbox's default view. The empty-state text mentions shared chats.
- Commit: a4d4f95.

**4. [Order] Task 1's e2e needs Task 2**
- The live badge needs the per-recipient `ai_chat.updated` from Task 2. The Task 1 e2e run failed only there, plus a title clash between the two projects, now fixed with unique titles.
- The spec passed once Task 2 landed (the combined run).

**5. [Rule 3] Failing `grants.int` case, not caused by this plan**
- The case failed before this plan: 06-04 asserts that notices never reach the model, but 06-05 puts them in `<turn_context>` as `<notice>` lines, which is what P-09 specifies.
- The assertion now checks that notice text never appears outside `<notice>` lines. The deferred-items entry is marked resolved.
- **Merge note:** 06-07 and 06-09 may make the same change, so expect a possible conflict on this line.
- Commits: 418a8d2, 8423098.

**6. [Note] TDD order for the web unit tests**
- `applyAiChatRead` and `applyAiChatAccessChanged` got their unit cases right after the code, not before (as noted in 06-03).

## Known Stubs

None.

## Threat Flags

Nothing beyond the plan's threat register. All five threats are mitigated and tested:
- **T-06-08-01:** the inbox re-checks readability after a revoke, and the web drops the chat when access goes null.
- **T-06-08-02:** no settings in any summary.
- **T-06-08-03:** team and org grants write no rows.
- **T-06-08-04:** a mention of Jo creates nothing.
- **T-06-08-05:** Jo and Ada get 404 on `/read` and no row is created.

## Open items

- Unit or organization grantees who never opened the chat have no row, so they see no unread count (P-09: they join on their first read or post).
- Removing someone from a unit still leaves their participation row (see 06-04). `emitChatUpdated` skips people without access.

`gsd windows`: nothing to append (no stubs, skipped tests or unrun verifies).

## Self-Check: PASSED

- Files exist: `shared.int.test.ts`, `ai-chat-shared-inbox.spec.ts`, 8 `shared-*.png`, this SUMMARY.
- Commits a4d4f95, 4deb707, 418a8d2, 83f1ff4, 8423098 are on wt/06-08.
