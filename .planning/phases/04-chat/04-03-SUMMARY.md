---
phase: 04-chat
plan: 03
subsystem: chat
status: complete
tags: [chat, permalinks, pagination, detached-history, privacy, e2e]
requirements: [CHAT-14, CHAT-13]
dependency_graph:
  requires: [04-01 (PageQuery/MessagePage fields, createConversationAccess, MessageActions, tombstones P-05)]
  provides:
    - "GET /api/v1/conversations/:id/messages?around=<id>|after=<seq> (listMessagesAround, listMessagesAfter); 400 invalid_page_query"
    - "apps/web/lib/permalink.ts: permalinkPath, parsePermalink, isPermalinkId"
    - "chat-queries: chatKeys.around, useMessagesAround, loadNewer, loadOlder(anchorId), rejoinTail; edits/deletes/thread updates patch every window"
    - "components/chat/use-permalink-window.ts: usePermalinkWindow, useCentreOnce, useWindowPaging (shared by channel and DM views)"
    - "components/chat/jump-to-latest.tsx (JumpToLatest), components/chat/message-unavailable.tsx (MessageUnavailable)"
    - "MessageActionSet.onCopyLink (toolbar More menu + touch sheet, data-testid copy-link); MessageList anchorId/linkFor/onAnchorHidden; ThreadPanel highlightId"
  affects: [04-05 pins/saves (jump), 04-06 search (jump), 04-07 group DMs (reuse usePermalinkWindow), 04-09 notifications (jump), 04-10 unread]
tech-stack:
  added: []
  patterns:
    - "Detached window = separate query under the chatKeys.messages prefix; creation is tail-only, every other update hits both"
    - "A window that pages to the live end folds into the tail (rejoinTail) so rows and scroll position stay put"
    - "Hidden and missing answer with the same status, code and message"
key-files:
  created:
    - apps/api/src/modules/chat/permalink.int.test.ts
    - apps/web/lib/permalink.ts
    - apps/web/lib/permalink.test.ts
    - apps/web/components/chat/jump-to-latest.tsx
    - apps/web/components/chat/message-unavailable.tsx
    - apps/web/components/chat/use-permalink-window.ts
    - e2e/tests/permalinks.spec.ts
  modified:
    - packages/contracts/src/chat.ts
    - apps/api/src/modules/chat/{service,index,access}.ts
    - apps/web/lib/chat-queries.ts
    - apps/web/components/chat/{channel-view,dm-view,thread-panel,message-list,message-actions}.tsx
    - apps/web/components/chat/use-stick-to-bottom.ts
    - apps/web/app/(app)/chat/chat.css
decisions:
  - "Hidden conversations now answer 404 with the route's own not-found message (was a generic 'Not found' vs 'Conversation not found' for missing): access.readableRow rethrows the hidden AuthzDeniedError with notFoundMessage"
  - "The one-cursor rule runs in the handler after the readable check (PageQueryFields schema), so a hidden conversation with conflicting cursors still says only 404"
  - "around page = floor(limit/2) older + anchor + the rest newer; nextBefore/nextAfter null at either end; after pages answer nextBefore null"
  - "The detached window survives opening or closing a thread (which drops m from the URL) and ends on Jump to latest, on posting, or when paging reaches the live end (fold into the tail)"
  - "Permalink target style: .chat-anchor (2.5 s flash settling to a steady tint with an accent bar while m is in the URL); thread roots keep the existing 1.6 s chat-flash"
metrics:
  duration: "~28 min"
  completed: 2026-10-06
  tasks: 2
  files: 21
estimate:
  tokens: 140000
actuals:
  tokens: 24600
  tasks: 2
  commits: 3
---

# Phase 4 Plan 03: Permalinks (copy link, around/after pages, detached history, Jump to latest) Summary

Any message, thread reply or bot-DM message can be linked by id only; opening the link loads history around it on the seq cursor, centres and highlights it in a detached window that live messages never move, pages older and newer, and rejoins the live tail through "Jump to latest" or by scrolling to the end. Hidden, missing and malformed targets all show one "This message isn't available" view, and the API's hidden and missing 404s are now byte-identical.

## What was built

- **API:** `listMessagesAround` / `listMessagesAfter` (service.ts) reuse `topLevelDtos` (the `listMessages` DTO path: top-level only, tombstones included, reply participants on roots). The GET messages route checks readable first, then refuses more than one cursor (400 `invalid_page_query`), reads `lastSeq` first as before, and for `around` requires the message to belong to the conversation (else 404 "Message not found"), resolving a reply to its root with `threadRootId`.
- **Web data:** `chatKeys.around` shares the `messages` prefix; `applyMessageUpdate`, `applyMessageDeleted` and `applyThreadUpdate` use `setQueriesData` over the prefix, `applyMessage` stays tail-only. `loadNewer` pages forward; `rejoinTail` merges a finished window into the tail.
- **Views:** channel and DM views share `usePermalinkWindow` (window decision, "N new", rejoin, release), `useCentreOnce` (centre once per link, after the stick effect) and `useWindowPaging` (older at top, newer at bottom while detached). `useStickToBottom` gained `detached`. A reply linked without `thread` gets its thread opened. Posting while detached returns to the tail.
- **Actions:** "Copy link" (Link2 icon, `copy-link`) in the hover toolbar's More menu and the long-press sheet for every non-deleted message, including thread replies (thread form) and bot-DM messages; toast "Link copied".
- **Degradation:** a deleted target hidden by P-05 makes the list report its nearest visible neighbour; the view toasts "This message was deleted" and lands there with no highlight. A deleted reply in the thread panel toasts the same.

## Verification

| Check | Result |
|---|---|
| `vitest --project integration chat/permalink.int.test.ts` | 13/13 (9 task 1, 4 task 2) |
| `vitest --project web lib/permalink.test.ts` | 7/7 |
| `pnpm typecheck --force` (after the contract change) | 8/8 |
| `pnpm verify` (final tree) | lint clean, typecheck 8/8, 121 files / 1652 tests, exit 0 |
| `e2e-isolated.sh permalinks` | 9/9 (4 tests x desktop + mobile, + setup) |
| `e2e-isolated.sh chat-edit chat.spec team-bot-dm` | 9/9 |
| `e2e-isolated.sh permalinks team-bot-dm realtime-access --repeat-each=2` | 25/25, none flaky or skipped |
| Acceptance greps (listMessagesAround, invalid_page_query, permalinkPath, copy-link x3, highlightId, spec count 4) | all satisfied |

Screenshots reviewed with the Read tool: `permalink-highlight-*` (target tinted with accent bar, pill above the composer, intro shown since the window reaches #1), `permalink-jump-latest-*` (live message at the bottom, no pill), `permalink-thread-*` (panel open, reply highlighted; root in the detached list on desktop), `permalink-dm-*` (DM window, highlighted, pill), `permalink-unavailable-*` (no channel name, single CTA), all at 1440/390, light and dark where captured. Readable in dark; pill does not clip at 390.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 2 - Security] Hidden vs missing were distinguishable.** A hidden conversation answered 404 "Not found", a missing one 404 "Conversation not found". `access.readableRow` (file not in the plan list) now rethrows the hidden `AuthzDeniedError` with the caller's not-found message; still an `AuthzDeniedError`, so denial audit is unchanged. Applies to every route using `readableChannel`. Int test compares the two bodies. Commit 2eb0a57.
2. **[Rule 3 - Blocking] Zod refine would pre-empt `invalid_page_query`.** `PageQuery`'s refine rejects conflicting cursors as `validation_error` before the handler (and before the readable check). Added add-only `PageQueryFields` + `pageCursorCount` in contracts (`PageQuery` keeps its behaviour); the route validates with the fields and enforces the rule after `readable`. Commit 2eb0a57.
3. **[Structure] Shared hooks instead of duplicating the window in two views.** New `use-permalink-window.ts` and `message-unavailable.tsx` (not in the plan list). Commit 2eb0a57.
4. **[Spec] Highlight style.** The plan said "existing chat-flash, 2.5 s"; review captures run with animations disabled, so the target uses a new `.chat-anchor` (2.5 s flash that settles into a steady tint + accent bar while `m` is in the URL). `chat-flash` (1.6 s) is unchanged for thread roots. chat.css is outside the plan list.
5. **[Addition] `rejoinTail` and `isPermalinkId`** beyond the interface block; `loadOlder` gained an optional `anchorId`.
6. **[Process] TDD order.** The int suite was RED first for task 1 (7/9 failing). The task 2 int cases passed on first run, because the task 1 API already handles them generically. The e2e specs and `permalink.test.ts` were written alongside the UI, not run RED first.
7. **[Process] Split commits.** Task 2 edits overlapped task 1 files, so the task 1 commit was staged from a snapshot without the task 2 hunks. That snapshot was typechecked and linted on its own before the commit.

### CLAUDE.md
- The access.ts change affects tenant and permission isolation, so it went through the threat model. It is a strict tightening: there is no new allow path and the deny result is identical apart from the message text.
- The branch `wt/04-03` is outside the executor's agent-branch allow-list. I committed there because the orchestrator said to.

## Known limitations / open issues

- Opening a permalink still marks the whole channel read, as opening any channel does today. Plan 04-10 (unread) should decide what a detached read means.
- After a reconnect gap, `invalidateQueries(chatKeys.messages)` also refetches an open window. It goes back to its first around page, so any pages loaded beyond that are dropped (the view stays where it is).
- `DmView` renders bot DMs only. `permalinkPath` already covers `dm`/`group`, and the group DM view from 04-07 should reuse `usePermalinkWindow`.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/access.ts --description "Hidden conversations now 404 with the route's not-found message (identical to missing); was generic 'Not found'"
gsd windows append --kind deviation --phase 04 --file packages/contracts/src/chat.ts --description "Added PageQueryFields + pageCursorCount; messages route enforces one cursor after readable (400 invalid_page_query)"
gsd windows append --kind deviation --phase 04 --file apps/web/components/chat/use-permalink-window.ts --description "Detached window logic extracted into shared hooks (not in plan file list); 04-07 group DMs must reuse it"
```

## Threat model coverage

T-04-03-01: `readable` runs before any lookup. Hidden and missing now answer with identical bodies and no details (int test, plus an e2e test that checks for the private channel's name). The web has a single `MessageUnavailable` view and shows it for a missing channel, a hidden channel, a 404/400 window and a missing DM. T-04-03-02: `conversationId` must match, otherwise 404 "Message not found" (int test with another channel's message and a random id). T-04-03-03: 400 `invalid_page_query` for every pair of cursors, after the readable check (a hidden conversation stays 404). T-04-03-04: the existing `limit` cap of 200 covers the new modes too. No new surface beyond the plan.

## Commits

- 2eb0a57 feat(chat): permalinks open history around a message in a detached window with Jump to latest (04-03 task 1)
- 8494a43 feat(chat): thread-reply and DM permalinks, deleted and hidden targets degrade safely (04-03 task 2)

## Self-Check: PASSED

All created files exist; commits 2eb0a57 and 8494a43 are on wt/04-03; working tree clean apart from this summary.
