---
phase: 04-chat
plan: 08
subsystem: chat
status: complete
tags: [chat, sidebar, units, permissions, threads, views, realtime, web]
requirements: [CHAT-02]
dependency_graph:
  requires: [04-01 (contracts, unit_id, thread_reads, access.ts), 04-05 (Saved view, saved-link), 04-07 (Direct messages section), 02 org units and rules]
  provides:
    - "unit on POST /api/v1/channels, PATCH /api/v1/channels/:id (move/topic), codes unit_not_found / unit_not_allowed"
    - "ChannelSummary.unit {id, name, kind, path, pathNames}, ChannelList.memberUnitIds, lastMessagePreview on channel and DM DTOs"
    - "ChannelFacts.unitPath on channel resources (chat, readable set, agent channel); channel.update for the owner relation"
    - "chat/threads.ts: registerThreadRoutes, listThreadsFor; GET /api/v1/threads, POST /api/v1/threads/:rootId/read (thread.read on user:)"
    - "web: SidebarSections + groupChannelsByUnit, SidebarViews + CHAT_VIEWS, MoveChannelDialog, ChannelUnitSelect/usePlaceableUnits, views All / Threads / AI Chats"
  affects: [04-09 (inserts Mentions second in CHAT_VIEWS; thread.read already on user:), 04-10 (unread counts on the same DTOs and view badges), 04-13]
tech-stack:
  added: []
  patterns:
    - "placement rule shared by create and move: unit on the caller's membership paths unless unit.manage"
    - "views refresh from frames the sidebar watchers already receive; no new subscriptions (Pitfall 13)"
key-files:
  created:
    - apps/api/src/modules/chat/threads.ts
    - apps/api/src/modules/chat/sidebar.int.test.ts
    - apps/api/src/modules/chat/threads.int.test.ts
    - apps/web/components/chat/sidebar-sections.tsx
    - apps/web/components/chat/sidebar-sections.test.ts
    - apps/web/components/chat/sidebar-views.tsx
    - apps/web/components/chat/move-channel-dialog.tsx
    - apps/web/components/chat/channel-icon.tsx
    - apps/web/components/chat/views/{all-view,threads-view,ai-chats-view,conversation-row}.tsx
    - apps/web/app/(app)/chat/{all,threads,ai}/page.tsx
    - e2e/tests/chat-sidebar.spec.ts
  modified:
    - packages/contracts/src/chat.ts
    - apps/api/src/modules/chat/{index,service,dm,access,saves}.ts
    - apps/api/src/modules/agent-channel/index.ts
    - apps/api/src/modules/organization/permissions/{policy.ts,resolve.test.ts}
    - apps/web/components/chat/{chat-sidebar,create-channel-dialog,channel-view,dm-view,thread-panel}.tsx
    - apps/web/lib/chat-queries.ts
decisions:
  - "A unit section shows the member's joined channels plus the unjoined public channels of the member's own units (muted suggestions), so a new department channel reaches its members live; other unjoined channels stay under More channels"
  - "Section order: Organization, the member's own departments, then the rest alphabetically; collapsed sections keep their active and unread channels visible (like Slack)"
  - "Moves re-decide live conv: subscriptions (invalidator on conversation.updated carrying unitId); #general cannot leave the organization; archived channels answer 410"
  - "Sidebar title is now Chat (views, channels and DMs live under it)"
metrics:
  duration: "~95 min"
  completed: 2026-10-06
  tasks: 3
  files: 31
estimate:
  tokens: 200000
actuals:
  tokens: 32400
  tasks: 3
  commits: 3
---

# Phase 4 Plan 08: Sidebar grouped by department and team, and the All, Threads, AI Chats and Saved views Summary

Channels now belong to the organization or to a department, team or project, chosen on create ("Belongs to") or later with "Move to…". The sidebar groups them into collapsible sections: Organization first, then the member's departments, with team channels shown under their department with a team label. Department and team deny/allow rules now apply to those channels in lists, direct access, search and live streams. Above the sections are the views: All, Threads (with unread replies), AI Chats and Saved. At 390 they become a scrollable segmented row.

## What was built

- **Placement (task 1):** `POST /channels` takes `unitId`. The unit must exist in the tenant; otherwise, including another org's unit, the API returns 404 `unit_not_found`. A member can only use a unit on their own membership path: someone in Product → Mobile can use Mobile or Product, but not Finance. Anything else returns 403 `unit_not_allowed`. Admins (`unit.manage`) can use any unit. The audit records the `unitId`. Deleting a unit moves its channels back to the organization.
- **DTOs:** `ChannelSummary.unit` includes `pathNames` for section titles and team labels. `ChannelList.memberUnitIds` lists the caller's own units. `lastMessagePreview` (one line, ≤ 140 chars, latest live top-level message) is on channel and DM DTOs and stays live from message frames.
- **Policy:** `ChannelFacts.unitPath` is passed to `channelResource`/`channelMemberResource`. It is set by `listChannels`, `channelFacts`, `access.readableIds` and the agent-channel resource, so unit-scoped rules reach channels for people and bots. The owner relation gains `channel.update`. `DM_FIXED` refuses `channel.update` on direct conversations.
- **Move (task 2):** `PATCH /channels/:id` checks, in order:
  1. The channel is readable; otherwise 404.
  2. `channel.update` (owner or admin); otherwise 403.
  3. Not archived (410) and not #general (400).
  4. The target unit passes the same placement rule as create.

  On success it writes the audit event `channel.updated {from, to}`, sends `conversation.updated` on `conv:` and on the list topics, and re-checks live subscriptions. A move with no change does nothing. `topic` uses the same route. The web adds "Move to…" (`move-channel`) to the channel menu, shown when `viewerCan` includes `channel.update`.
- **Threads (task 3):**
  - `GET /threads` lists threads the member started, replied to or was mentioned in (root or reply). It only looks at `access.readableIds`.
  - Order is newest reply first. `unreadReplies` counts other people's live replies after the member's `thread_reads` mark (max 100). Each thread also returns up to 5 participants and the last 3 replies. Pagination uses an opaque keyset cursor; a bad cursor returns 400 `invalid_cursor`.
  - `POST /threads/:rootId/read` keeps the highest mark and sends `thread.read` on `user:<me>`. Replies, unknown roots, hidden roots and another org's roots all return 404.
- **Web:**
  - `SidebarSections`: collapsible headers in the Work Zone style, collapse state in localStorage (`ocw.chat.sections.collapsed`), and a hover "+" to create a channel in that unit.
  - `SidebarViews`: desktop rows with badges for unread conversations and unread threads; at 390 a `views-segmented` row. It replaces the Saved link and keeps the `saved-link` id.
  - `/chat/all`: unread first, then by activity, with previews.
  - `/chat/threads`: cards rendered with the shared Markdown, showing the last replies and "N new replies".
  - `/chat/ai`: bot DMs, personal first.
  - The thread panel marks a thread read when it opens and when new replies arrive while it is visible.
  - The sidebar refreshes Threads on `thread.updated` for a listed thread or one the member joined, using frames its watchers already get. `thread.read` frames update the cache.

## Verification

| Check | Result |
|---|---|
| `vitest --project integration chat/sidebar.int.test.ts` | 13/13 (task 1: 8, RED first; task 2: 5, RED first) |
| `vitest --project integration chat/threads.int.test.ts` | 7/7 (RED first: 6 failing) |
| `vitest --project unit resolve.test.ts` | 56/56 (4 new; `channel.update` case RED first) |
| `vitest --project web sidebar-sections.test.ts` | 5/5 |
| `pnpm typecheck --force` after each contract change | 8/8 |
| `pnpm verify` (final tree) | 131 files, 1795 tests, exit 0. One earlier run hit a docker.sock ECONNREFUSED under load; the retry passed |
| e2e task 1: `chat-sidebar chat.spec dms` | 9/9 |
| e2e task 2: `chat-sidebar admin-org` | 7/7 |
| e2e task 3: `chat-sidebar reactions-pins chat.spec` | 13/13 |
| Final e2e: `chat-sidebar chat.spec dms reactions-pins admin-org bots.spec personal-bots team-bot-dm` (desktop + mobile) | 29/29, none skipped or flaky |
| Acceptance greps | `unit_not_allowed` in chat/index.ts; `unitPath` ×5 in policy.ts; `export function groupChannelsByUnit`; `"channel.update"` in policy.ts; `channel.updated` in index.ts; `scopeUnitId` in sidebar.int.test.ts; `"/threads"` in threads.ts; 3 view pages; `export const CHAT_VIEWS` |

I reviewed these screenshots with the Read tool: `sidebar-grouped-{1440,390}[-dark]`, `channel-create-unit-*`, `channel-move-*`, `views-{all,threads,ai}-{1440,390}[-dark]` and `views-segmented-390[-dark]`. Fixes from the review:
- Long channel names stretched the grid and pushed the team label past the edge. Sections are now `grid-cols-1` and names truncate.
- The segmented pills are tighter and fade on the right to show the row scrolls.
- The sidebar title "Channels" sat over the views; it is now "Chat".

The DM and bot regression captures were checked, then restored (not committed).

## Deviations from Plan

1. **[Spec/UX] Unjoined channels of the member's own units show in their section, muted (`data-joined="false"`).** Without this, Sam could not see the admin's new #design live (only creators join new channels). Other unjoined channels stay under "More channels", which now also shows each channel's unit.
2. **[Rule 2] `ChannelUnit.pathNames`, `ChannelList.memberUnitIds` and `ThreadSummary.lastReplies` (contracts, add-only).** Section titles need the department name, the dialog and section order need the caller's units, and cards show their last replies.
3. **[Rule 2] Unit path on the agent-channel resource** (`agent-channel/index.ts`, not in the file list). Otherwise a unit-scoped rule would not reach bots in that unit's channels.
4. **[Rule 2] Subscription invalidator on `conversation.updated` with `unitId`.** A move under a deny rule re-checks open `conv:` streams instead of leaving them live.
5. **[Rule 2] `channel.update` added to `DM_FIXED`; #general cannot move; archived channels return 410 on PATCH.**
6. **[Structure] Small helper files not in the plan:** `channel-icon.tsx` (re-exported from chat-sidebar to avoid a sidebar ↔ sections cycle) and `views/conversation-row.tsx`. `ChannelUnitSelect`/`usePlaceableUnits` live in create-channel-dialog.tsx and are shared with the move dialog. `conversationRefs` is exported from saves.ts for threads.
7. **[Rule 1] `useCreateChannel`/`patchChannel` dropped `orgSeq`/`userSeq`/`memberUnitIds` from the cached list.** They now spread the previous value.
8. **[UI] Sidebar title "Channels" → "Chat".** No spec depended on it.
9. **[Process] e2e unit membership tolerates 409.** Both projects share one stack.

### CLAUDE.md
- Permission changes (owner `channel.update`, `DM_FIXED`, unit path on channel resources) are add-only. Plan-mode approval was delegated by the orchestrator. They are covered by `resolve.test.ts` and the Finance-scoped deny integration case (list, 404, messages, search; restored on move-back).
- No migration (`conversations.unit_id` and `thread_reads` exist since 04-01).
- `.env` was symlinked only for the isolated e2e and has been removed; I never read it. `wt/04-08` is outside the executor's agent-branch allow-list; I committed there as instructed.

## Known Stubs

None. Mentions is not in `CHAT_VIEWS` yet; Plan 09 adds it, as planned.

## Open issues

- Views badges count from the current lists. The Threads badge only covers the first page (30 threads). Plan 10's counted unread replaces the conversation heuristic.
- The Threads list does not refresh live when someone mentions the member in a reply to a thread that isn't listed yet. It catches up on window focus or the next refetch, and Plan 09's notifications on `user:` will cover it.
- Unit renames reach section titles through `units.updated` → channel list refetch. Collapse keys are unit ids, so a deleted-and-recreated unit starts expanded.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/web/components/chat/chat-sidebar.tsx --description "Unit sections also list unjoined public channels of the member's own units (muted) so new department channels reach members live"
gsd windows append --kind deviation --phase 04 --file packages/contracts/src/chat.ts --description "Add-only ChannelUnit.pathNames, ChannelList.memberUnitIds, ThreadSummary.lastReplies"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/agent-channel/index.ts --description "Agent channel resource carries the channel's unit path so unit-scoped rules reach bots"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/index.ts --description "conversation.updated with unitId re-decides live conv: subscriptions; #general cannot move; archived PATCH 410"
```

## Threat model coverage

- **T-04-08-01:** placement limited to the caller's membership paths unless `unit.manage` (int: Mobile/Product OK, Finance 403, Product member → Mobile 403). Moves need `channel.update` (owner or admin; plain member 403) and are audited `channel.updated {from, to}`.
- **T-04-08-02:** `unitPath` on every channel resource. Resolver tests cover this, and the Finance-scoped `channel.read` deny hides the moved channel from list, `GET` and messages (404) and search, while a non-matching Finance member still reads it. Live streams are re-checked on move.
- **T-04-08-03:** threads come only from `access.readableIds` (int: leaving a private channel removes its thread; marking it read returns 404).
- **T-04-08-04:** previews only on lists already filtered by the resolver.
- **T-04-08-05:** the opaque cursor is checked with Zod; a bad one returns 400 `invalid_cursor`.
- **T-04-08-06:** no new subscriptions. Threads uses frames the sidebar already receives, plus `user:`.

## Commits

- 343fdf9 feat(chat): channels belong to a department or team and the sidebar groups them into collapsible sections (04-08 task 1)
- 06c81ec feat(chat): owners and admins move channels between units under audit; unit-scoped rules govern unit channels (04-08 task 2)
- a378b76 feat(chat): the sidebar views All, Threads with unread replies, AI Chats and Saved, a segmented row at 390 (04-08 task 3)

## Self-Check: PASSED

All created files exist. Commits 343fdf9, 06c81ec and a378b76 are on `wt/04-08`. The working tree was clean before this summary. The `.env` symlink has been removed.
