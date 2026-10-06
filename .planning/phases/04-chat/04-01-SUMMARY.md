---
phase: 04-chat
plan: 01
subsystem: chat
status: complete
tags: [chat, contracts, migration, rls, audit, realtime, edit, delete, tombstones, readable-set]
requirements: [CHAT-06]
dependency_graph:
  requires: [03.1 DM model (dm_key, bot DMs), 03 realtime (appendEvent, conv topic authorizer)]
  provides:
    - every Phase 4 contract (chat.ts additions, notifications.ts, search.ts, attachments.ts, 9 EventTypes, 4 permissions)
    - the only Phase 4 migration 20261006041904_chat_workspace
    - PATCH/DELETE /api/v1/messages/:id with append-only message_versions
    - createConversationAccess (readable, readableRow, readableIds, isReadable)
    - PermissionService.filterFor (request-less resolver filter)
    - web MessageActions / MessageActionSheet / DeleteMessageDialog, inline editor, (edited) marker, tombstones
    - e2e/support/chat.ts (ALEX, postAs, freshChannel, messageRow, openMessageActions)
  affects: [04-02 … 04-13 (all import these contracts, schema and the access helper)]
tech-stack:
  added: [postgres extensions unaccent + pg_trgm (schema app), text search configs app.ocw_simple/ocw_es/ocw_en]
  patterns:
    - "lock row → version insert → update → appendEvent → audit (ids + version only) in one transaction"
    - "readable set decided by the resolver (filterFor), SQL only narrows candidates"
key-files:
  created:
    - packages/contracts/src/attachments.ts
    - packages/contracts/src/notifications.ts
    - packages/contracts/src/search.ts
    - packages/contracts/src/chat-workspace.test.ts
    - packages/db/drizzle/20261006041904_chat_workspace/migration.sql
    - packages/db/drizzle/20261006041904_chat_workspace/snapshot.json
    - apps/api/src/modules/chat/message-actions.ts
    - apps/api/src/modules/chat/access.ts
    - apps/api/src/modules/chat/access.int.test.ts
    - apps/api/src/modules/chat/message-edit.int.test.ts
    - apps/web/components/chat/message-actions.tsx
    - e2e/support/chat.ts
    - e2e/tests/chat-edit.spec.ts
  modified:
    - packages/contracts/src/{chat,common,agent,realtime,permissions,index}.ts (+ contracts/permissions tests)
    - packages/db/src/schema/app.ts, packages/db/sql/post-migrate.sql, packages/db/src/rls-isolation.int.test.ts
    - apps/api/src/modules/chat/{index,service,dm}.ts, apps/api/src/modules/agent-channel/mentions.ts
    - apps/api/src/modules/organization/permissions/{policy,service,resolve.test}.ts
    - apps/web/components/chat/{message-list,channel-view,dm-view,thread-panel,chat-sidebar}.tsx, apps/web/lib/chat-queries.ts
decisions:
  - "RESERVED_HANDLES/isReservedHandle live in common.ts and are re-exported by chat.ts (agent.ts needs them; chat.ts imports agent.ts, so defining them in chat.ts would create an import cycle)"
  - "ConversationAccess boolean method is isReadable, not canRead: the static guard (guard.test.ts) bans the identifier of a deleted pre-resolver helper; 04-09 must call access.isReadable"
  - "A deleted reply leaves its thread: root reply_count decrements, thread.updated is emitted, replyParticipants skip deleted replies"
  - "Group DMs map to resource state dm in channelFacts already, so D-01 (no moderation) holds for Plan 07 groups"
  - "Attachment-only posts answer 400 attachments_unavailable until Plan 04-04 wires the upload pipeline (the contract already accepts them)"
metrics:
  duration: "~41 min"
  completed: 2026-10-06
  tasks: 3
  files: 53
estimate:
  tokens: 260000
actuals:
  tokens: 40600
  tasks: 3
  commits: 4
---

# Phase 4 Plan 01: Chat tracer (edit/delete with audited versions, all Phase 4 contracts, the one migration) Summary

Author edits and deletes flow toolbar/long-press sheet → `PATCH`/`DELETE /api/v1/messages/:id` → append-only `app.message_versions` + body-free audit → `message.updated`/`message.deleted` on `conv:<id>` → the other member's browser live; the whole Phase 4 contract set and schema (one migration, proven on fresh PostgreSQL with RLS on all 8 new tables) and the resolver-backed readable-set helper are in place for plans 02–13.

## What was built

- **Contracts (P-01):** every name of the interfaces block. `DmCounterpart` is now a discriminated union (agent/user/group); api `dm.ts` and web `chat-sidebar`/`dm-view` narrow with `isBotDm` (no behaviour change). `userHandle` suffixes reserved handles (`here@x.com` → `here-1`), `AgentUsername` refuses `here/channel/everyone`, `mentionAllOf` ignores code, `Emoji` regex (pictographs, flags, keycaps, ZWJ, skin tones, tags; ≤ 32 UTF-16 units). Permissions `message.delete_any` (admin, non-delegable), `channel.mention_all`, `attachment.upload` (all roles), `channel.update` (admin list).
- **Migration `20261006041904_chat_workspace` (P-02):** `message_versions`, `message_reactions`, `message_pins`, `message_saves`, `notifications`, `notification_prefs`, `thread_reads`, `attachments`; `conversations.unit_id` + `conversations_org_group_key_uq`; `conversation_members.notify_level/muted`; `messages.deleted_at/deleted_by`; hand-written `unaccent`/`pg_trgm`, `app.ocw_simple/es/en`, STORED `messages.search_tsv` + `messages_search_gin`, trigram indexes on org_members/conversations/agents. `post-migrate.sql` revokes UPDATE/DELETE/TRUNCATE on `message_versions` from `ocw_app`. `generate --name chat_workspace_check` reports no changes.
- **API:** `message-actions.ts` (`editMessage`, `deleteMessage`, routes). Edit: author only (403 `not_author`), 404 hidden/missing, 410 archived, 409 deleted, unchanged body = no version, mentions re-resolved, never `emitAgentMention`. Delete: author, or `message.delete_any` after `channel.read` (admins only where readable; policy precondition `direct_conversation` in DMs); tombstone, reactions/pins removed (`pin.updated`), attachments `deleted`, audit `{messageId, conversationId, version, moderated}`. `access.ts` is the single readable-set authority; `readableChannel` and the `conv:` topic authorizer delegate to it. Bot context (`provideThreadContext`, agent-channel history) skips deleted rows.
- **Web (P-09):** `MessageActions` hover toolbar (Reply, Edit, More▸Edit/Delete), `MessageActionSheet` (450 ms long press; short tap still opens the thread), `DeleteMessageDialog` with preview, inline editor (Enter saves, Shift+Enter newline, Escape cancels), inline "(edited)" marker with tooltip, tombstones ("This message was deleted." when replies remain, hidden otherwise), live `message.updated`/`message.deleted` in channel, DM and thread caches (viewer fields preserved).

## Verification

| Check | Result |
| --- | --- |
| `vitest --project unit` contracts (chat-workspace, contracts, permissions) | 3 files, 76 tests passed |
| `pnpm typecheck --force` | 8/8 tasks green |
| `vitest --project integration` message-edit.int.test.ts | 16/16 (edit, delete, DM, thread, bot history, cross-tenant) |
| `vitest --project integration` access.int.test.ts | 5/5 |
| `vitest --project integration` rls-isolation.int.test.ts (fresh ephemeral PG, all migrations + post-migrate) | 12/12 |
| `vitest --project unit` resolve.test.ts | 51/51 |
| `pnpm verify` (lint + typecheck + all unit + integration) | 114 files, 1508 tests passed, exit 0 |
| `bash scripts/e2e-isolated.sh chat-edit chat.spec team-bot-dm` | 9/9 passed (desktop + mobile) |
| `bash scripts/e2e-isolated.sh chat-edit --repeat-each=3` | 13/13 passed, no flaky |
| Acceptance greps (one `*_chat_workspace` dir, REVOKE line, `"/messages/:id"`, 16 permission hits, `createConversationAccess` export, 2× `direct_conversation`, `deletedAt` in mentions.ts) | all satisfied |

Screenshots reviewed (Read tool): `chat-edit-toolbar-*`, `chat-edited-*`, `chat-delete-confirm-*`, `chat-tombstone-*` at 1440/390, light/dark — toolbar not clipped, sheet readable at 390, marker legible in dark, dialog full-width buttons at 390.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 3 - Blocking] `canRead` renamed `isReadable`.** `guard.test.ts` bans the identifier (deleted Phase 2 helper) anywhere in `apps/api/src`; the plan's interface name would fail `pnpm verify`. Same semantics. **04-09 must use `access.isReadable`** (its key-link pattern `canRead|readableIds` still matches via `readableIds`). Commit d567cbc.
2. **[Rule 3 - Blocking] `PermissionService.filterFor` added** (organization/permissions/service.ts, not in the plan's file list): `readableIds` needs a request-less resolver filter (facts + rules loaded once). Additive. Commit d567cbc.
3. **[Rule 3] `ConversationAccess.readableRow` added** so index.ts `readableChannel` delegates without re-reading the row. Additive.
4. **[Rule 3] RESERVED_HANDLES in common.ts**, re-exported from chat.ts (avoids an agent.ts ↔ chat.ts cycle; P-01 warns cycles crash at load).
5. **[Rule 1] Emoji length:** zod 4 `max` counts code points, the plan specifies code units; added a `length <= 32` refine.
6. **[Rule 2] Attachment-only posts guarded:** the new `PostMessageRequest` accepts `attachmentIds` with an empty body; until 04-04 the POST route answers 400 `attachments_unavailable` instead of creating an empty message. 04-04 replaces the guard.
7. **[Rule 3] rls-isolation generic cross-tenant insert** now lists writable columns (`attgenerated = ''`): the STORED `search_tsv` can never be inserted explicitly, so `select *` failed before reaching RLS. Same assertion (`row-level security`), no weakening.
8. **[Rule 1] Deleted replies leave their thread:** root `reply_count` decrements with `thread.updated`, `replyParticipantsFor` skips deleted replies (otherwise "2 replies" over 1 visible).
9. **[Rule 2] `channelFacts` maps `group` → state `dm`** and `getConversation` accepts `group`, so D-01 already covers Plan 07 group DMs.
10. **[Rule 1] e2e race:** the editor focuses itself on its first frame; the spec waits for focus before `fill` (one desktop run appended instead of replacing).
11. Thread context for bots is now root (if live) + last N live replies (same shape as before, tombstones removed).

### CLAUDE.md
Plan mode for schema/permission changes: owner-delegated approval per the plan; the schema and permission diff are exactly the plan's lists above.

## Known Stubs

None that block the plan goal. Intentional temporary guard: `apps/api/src/modules/chat/index.ts` POST `/conversations/:id/messages` → 400 `attachments_unavailable` for attachment-only posts (removed by 04-04).

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/index.ts \
  --description "POST /conversations/:id/messages answers 400 attachments_unavailable for attachment-only posts until 04-04 wires uploads"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/access.ts \
  --description "ConversationAccess boolean check is isReadable (plan said canRead; static guard bans that identifier); 04-09 must call isReadable"
```

## Threat model coverage

T-04-01-01 (REVOKE + int test UPDATE/DELETE/TRUNCATE denied), -02 (readable before delete_any; DM precondition; private non-member 404; bot-DM 403), -03 (metadata exact, no `body` key at any depth), -04 (8 tables seeded, forced RLS, cross-tenant PATCH 404), -05 (row lock + author check, 403 `not_author`), -06 (thread context + cell history skip tombstones; int test on the delivered `agent.mention.v1` payload), -07 (edit adds no captured mention, bot not auto-added), -08 (reserved handles unit tests). No new surface beyond the plan.

## Commits

- f7654ad feat(chat): live message edit with append-only versions, Phase 4 contracts and migration (task 1)
- e2e5a6d test(db): prove the chat_workspace migration on fresh PostgreSQL (task 2)
- d567cbc feat(chat): message delete with tombstones, admin moderation only where readable, readable-set helper (task 3)

## Self-Check: PASSED

All created files exist; commits f7654ad, e2e5a6d, d567cbc are on wt/04-01; exactly one `*_chat_workspace` migration directory and no `*_chat_workspace_check` left behind.
