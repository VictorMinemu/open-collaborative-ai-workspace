---
phase: 04-chat
plan: 05
subsystem: chat
status: complete
tags: [chat, reactions, emoji, frimousse, pins, saves, realtime, audit, readable-set, e2e]
requirements: [CHAT-07, CHAT-13]
dependency_graph:
  requires: [04-01 (contracts, tables, createConversationAccess, MessageActions), 04-02 (Markdown, frimousse approval), 04-03 (permalinkPath, setQueriesData windows)]
  provides:
    - "chat/reactions.ts: registerReactionRoutes, reactionsFor; PUT|DELETE /api/v1/messages/:id/reactions/:emoji"
    - "chat/pins.ts: registerPinRoutes, pinnedFor; PUT|DELETE /api/v1/conversations/:id/pins/:messageId, GET /api/v1/conversations/:id/pins"
    - "chat/saves.ts: registerSaveRoutes, savedFor; PUT|DELETE /api/v1/messages/:id/save, GET /api/v1/saved"
    - "service.ts hydrateViewer(tx, messages, viewerId): reactions + pinned + saved on every REST snapshot (pages, around/after, thread, pins, saved)"
    - "ChatRouteCtx (index.ts)"
    - "web: components/ui/popover.tsx, chat/{emoji-picker,reactions,pinned-sheet,saved-view,message-card}.tsx, route /chat/saved, sidebar saved-link"
    - "chat-queries: toggleReaction, applyReactionUpdate, usePins, pinMessage, unpinMessage, applyPinUpdate, useSaved, saveMessage, unsaveMessage, applySaveUpdate"
    - "public/emojibase/17.0.0/en (self-hosted emoji data for the picker)"
  affects: [04-06 search (hydrateViewer for result DTOs), 04-08 sidebar views group (moves the Saved link), 04-07 group DMs (pins: any participant unpins; Saved labels groups), 04-12 composer]
tech-stack:
  added: ["frimousse@0.4.0 (pre-approved in 04-02)", "emojibase-data@17.0.0 en JSON (vendored data, MIT, no npm dependency)"]
  patterns:
    - "Viewer fields only through hydrateViewer on REST; events carry absolute shared state (count, members) and clients derive mine"
    - "Saved list: resolver-derived readableIds narrow the SQL (P-03), keyset on (saved_at µs, message_id)"
key-files:
  created:
    - apps/api/src/modules/chat/reactions.ts
    - apps/api/src/modules/chat/pins.ts
    - apps/api/src/modules/chat/saves.ts
    - apps/api/src/modules/chat/reactions.int.test.ts
    - apps/api/src/modules/chat/pins.int.test.ts
    - apps/web/components/ui/popover.tsx
    - apps/web/components/chat/emoji-picker.tsx
    - apps/web/components/chat/reactions.tsx
    - apps/web/components/chat/pinned-sheet.tsx
    - apps/web/components/chat/saved-view.tsx
    - apps/web/components/chat/message-card.tsx
    - apps/web/app/(app)/chat/saved/page.tsx
    - apps/web/public/emojibase/README.md
    - e2e/tests/reactions-pins.spec.ts
  modified:
    - apps/api/src/modules/chat/{index,service}.ts
    - apps/web/components/chat/{message-actions,message-list,channel-view,dm-view,thread-panel,chat-sidebar}.tsx
    - apps/web/lib/chat-queries.ts, apps/web/package.json, pnpm-lock.yaml, biome.json
decisions:
  - "Emoji data is served by the web app (public/emojibase), never frimousse's default jsDelivr CDN (principle 10, privacy, air-gapped installs)"
  - "Archived conversations answer 410 for reactions and pins (like edit); saves work wherever the message is readable, archived included"
  - "Idempotent no-ops (re-pin, unpin of an unpinned message, re-save, re-react) answer 200 with no event and no audit"
  - "Pinned messages break author grouping, get a 'Pinned' label and an amber tint; saved ones a 'Saved for later' label in the same line"
  - "The hover toolbar is pointer-only ([@media(hover:none)]:hidden); touch keeps the long-press sheet"
metrics:
  duration: "~45 min"
  completed: 2026-10-06
  tasks: 3
  files: 32
estimate:
  tokens: 190000
actuals:
  tokens: 39000
  tasks: 3
  commits: 4
---

# Phase 4 Plan 05: Reactions, pins and personal saves Summary

Emoji reactions (quick 👍 ✅ 👀 + a frimousse picker with search, skin tones and keyboard navigation, self-hosted data) update counts live for everyone with the viewer's own chips highlighted; pins are shared per conversation, audited, capped and listed in a sheet that jumps to each message; saves are private, live across the member's devices, and `/chat/saved` only lists messages the resolver still lets the member read.

## What was built

- **Reactions (CHAT-07):** `PUT|DELETE /messages/:id/reactions/:emoji` (Fastify-decoded path segment validated by the `Emoji` contract). Order: message lock → readable (404) → archived (410) → `channel.post` (403 for public non-members) → tombstone (409 `message_deleted`) → 50 distinct emoji cap (409 `too_many_reactions`). `reaction.updated` carries the absolute count, first 20 reactors, actor and `added`, never `mine`. Works on channel messages, thread replies, bot messages and bot DMs.
- **Pins (CHAT-13):** `PUT|DELETE|GET /conversations/:id/pins[/:messageId]`; message must belong to the conversation (404 otherwise); cap 100 (409 `too_many_pins`); unpin by the pinner, `channel.archive` holders in channels (owner relation or admin), any participant in DMs; audits `message.pinned` / `message.unpinned` `{messageId, conversationId}`; `pin.updated` live. Deleting a pinned message already unpins it (04-01).
- **Saves (CHAT-13):** `PUT|DELETE /messages/:id/save` → `save.updated` on `user:<me>` only, no audit; `GET /saved` narrows the member's saves to `access.readableIds(…, { includeArchived: true })`, skips tombstones, keyset cursor (base64url JSON of µs timestamp + id, 400 `invalid_cursor`), `ConversationRef` labels (`#name`, bot/user names for DMs, "A, B and C" for groups).
- **Hydration:** `hydrateViewer` adds `reactions`, `pinned`, `saved` to message pages (tail, around, after), threads, pins and Saved.
- **Web:** `ReactionBar` (chips with `data-mine`, tabular counts, "You, Sam Lee and N others reacted with 👍" tooltips, trailing add chip), quick reactions + picker in the toolbar, quick-reaction row + "Add reaction" in the long-press sheet, `EmojiPicker` as a popover (desktop) or bottom sheet (390, 9 columns, no auto-focused keyboard); Pin/Unpin in More menu and sheet, "Pinned N" header button (count only at 390) and `PinnedSheet` (right sheet desktop, bottom sheet mobile) with Jump (`permalinkPath`) and Unpin when allowed; Save toggle (bookmark) in toolbar and sheet, `SavedView` with Jump/Remove, infinite scroll and empty state; sidebar "Saved" link; `save.updated` routed from the sidebar's `user:` subscription.

## Verification

| Check | Result |
| --- | --- |
| `vitest --project integration reactions.int.test.ts` | 9/9 (RED first: 8 failing) |
| `vitest --project integration pins.int.test.ts` | 15/15 (9 pins + 6 saves; each block RED first) |
| `pnpm verify` after each task | 124/1695, 125/1704, 125/1710 files/tests, exit 0 (4 pre-existing local-runtime lint warnings) |
| `e2e-isolated.sh reactions-pins chat-edit permalinks` (task 1) | 15/15 |
| `e2e-isolated.sh reactions-pins chat.spec` (task 3) | 9/9 |
| `e2e-isolated.sh reactions-pins chat-edit permalinks chat.spec` (final tree) | 21/21, none skipped |
| `e2e-isolated.sh reactions-pins team-bot-dm --repeat-each=2` | 17/17, no flaky |
| Acceptance greps (route strings, `too_many_reactions`, `"frimousse": "0.4.0"`, `reactionUpdated` in channel/dm views, `"/conversations/:id/pins"`, `message.pinned\|message.unpinned`, `export function PinnedSheet`, `readableIds` in saves.ts, saved page, `saved-link`) | all satisfied |

Screenshots reviewed with the Read tool: `reactions-bar-*`, `reactions-picker-*`, `pins-sheet-*`, `pins-jump-*`, `saved-view-*` at 1440/390, light and dark. Picker not clipped at 390 (bottom sheet, grid fills the width, sheet-coloured sticky headers in dark), chips legible in dark, pinned row tint and anchor bar coexist, Saved cards readable at 390.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 2 - Principle 10 / privacy] Emoji data self-hosted.** frimousse fetches Emojibase from cdn.jsdelivr.net by default: every browser would call a third party and the picker would break on air-gapped installs. `apps/web/public/emojibase/17.0.0/en/{data,messages}.json` + LICENSE are copied verbatim from the `emojibase-data@17.0.0` npm tarball (MIT, integrity in the README), served by the app; `biome.json` excludes that directory. Data only, no new npm dependency. Commit 568d1b5.
2. **[Rule 1 - UX] Hover toolbar hidden on touch devices.** Tapping a chip focused the row and popped the hover toolbar over the author line at 390; P-09 makes the toolbar pointer-only, so it now has `[@media(hover:none)]:hidden` (no e2e relied on it on mobile). Commit 568d1b5.
3. **[Rule 2 - authz] `GET /saved` calls `markDecided(req)`** after `access.readableIds` (a request-less `filterFor`): the strict authz hook needs a resolver decision on every `user` 2xx. Commit 9c93ea9.
4. **[Rule 1] Saved cursor keeps microseconds** (`to_char(... 'US')` + row comparison); a JS `Date` would drop them and skip saves made within the same millisecond. Commit 9c93ea9.
5. **[Interface] `ReactionBar` has no `onAdd`:** its trailing chip is the picker's own trigger (a popover must anchor to it). `EmojiPicker` gained optional `open`/`onOpenChange`/`title`; without a trigger it is always a bottom sheet (long-press flow on any width). `PinnedSheet` gained `canModerate`; `PinnedButton` is exported from pinned-sheet.tsx.
6. **[Structure] `message-card.tsx`** (shared by PinnedSheet and SavedView) and new `MessageList`/`ThreadPanel` props `canReact`, `canUnpinAny`, `pinnedBy` (not in the plan's file list).
7. **[UI] "Saved for later" label** sits in a label line above the message (with "Pinned"), not next to the time: continuation rows have no time line. Pinned messages break author grouping and get an amber tint.
8. **[Structure] `hydrateViewer` in service.ts imports reactions/pins/saves**, which import service.ts: a function-only ESM cycle (nothing evaluated at load), covered by every integration suite.

### Process notes
- Saves tests live in `pins.int.test.ts` as the plan specifies.
- E2E runs regenerated other plans' screenshots (chat-edit, permalinks, chat.spec, setup); they were restored or deleted, never committed.
- `.env` was symlinked only for the isolated e2e and removed afterwards (never read).

## Known Stubs

None.

## Threat model coverage

T-04-05-01 (Saved filtered by `readableIds` at read time; int test removes and re-adds Sam to a private channel), -02 (readable 404 → archived 410 → `channel.post` 403; private, public-non-member, archived, org B tested for reactions, pins and saves), -03 (`Emoji` contract on the path, rendered as text; 50 distinct cap; `abc`, `<b>`, `👍abc`, `1` → 400), -04 (pin/unpin audited with actor), -05 (`save.updated` only on `user:<me>`, asserted absent from `conv:` and other users; viewer fields only via `hydrateViewer`), -06 (100 pins cap, 409), -SC (exact pin `frimousse@0.4.0`, lockfile passed the `minimumReleaseAge` policy; emoji data vendored from the registry tarball, not a CDN). No new surface beyond the plan.

## Open issues

- Agents cannot react yet (the table supports `member_kind = 'agent'`; no Agent Channel API path).
- The sidebar's `user:` subscription has no resync handler: after a gap a `saved` flag can stay stale until the next refetch.
- Plan 04-08 should move the Saved link into the sidebar views group (comment in chat-sidebar.tsx).

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/web/public/emojibase/README.md --description "Emoji picker data self-hosted (emojibase-data 17.0.0 en, vendored JSON) instead of frimousse's jsDelivr default"
gsd windows append --kind deviation --phase 04 --file apps/web/components/chat/message-actions.tsx --description "Hover toolbar hidden on hover:none devices; touch uses the long-press sheet only"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/saves.ts --description "GET /saved marks the request decided after access.readableIds (request-less filterFor) for the strict authz hook"
```

## Commits

- 568d1b5 feat(chat): emoji reactions with live counts, quick reactions and a self-hosted frimousse picker (04-05 task 1)
- 0f0e0b3 feat(chat): pins per conversation with a live Pinned count, pinned sheet and jump (04-05 task 2)
- 9c93ea9 feat(chat): personal saves with a private Saved view filtered by the readable set (04-05 task 3)

## Self-Check: PASSED

All created files exist; commits 568d1b5, 0f0e0b3, 9c93ea9 are on wt/04-05; acceptance greps re-run on the final tree; `.env` symlink removed.
