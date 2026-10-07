---
phase: 06-multiplayer-ai-chat
plan: 01
subsystem: contracts, db
status: complete
tags: [contracts, migration, rls, multiplayer-ai, agent-cards, permissions]
requires: [Phase 5 AI chat schema (20261006152939_ai_chat, 20261006153117_provider_secret_refs)]
provides:
  - Every Phase 6 contract name (P-01) in packages/contracts
  - The single Phase 6 migration 20261007073058_multiplayer_ai (P-02)
affects: [06-02 … 06-16 (all build on these names and tables)]
tech-stack:
  added: []
  patterns:
    - "Partial unique index on an expression (coalesce(subject_id, zero uuid)) for one active grant per subject"
    - "Internal-route refine (prefix + boundary, no scheme, //, backslash, dot segments incl. %2e, control chars)"
key-files:
  created:
    - packages/contracts/src/agent-cards.ts
    - packages/db/drizzle/20261007073058_multiplayer_ai/migration.sql
    - packages/db/drizzle/20261007073058_multiplayer_ai/snapshot.json
  modified:
    - packages/contracts/src/{ai-generation,ai-chat,chat,realtime,permissions,notifications,index}.ts
    - packages/contracts/src/{ai-chat,contracts,permissions,chat-workspace}.test.ts
    - packages/db/src/schema/app.ts
    - packages/db/src/rls-isolation.int.test.ts
    - packages/db/src/secret-ref-migration.int.test.ts
    - apps/api/src/modules/organization/permissions/resolve.test.ts
    - apps/web/components/chat/inbox.tsx
decisions:
  - "AiSkipReason lives in ai-generation.ts (not ai-chat.ts) so chat.ts can carry Message.aiAddressing without a cycle; a test keeps it a superset of ModelUnavailableReason"
  - "AgentCardRoute also rejects percent-encoded dot segments (%2e), which the WHATWG URL parser normalises like '.' and '..'"
  - "The one-action-per-kind refine sits on the actions array, so AgentCard stays a plain object (pick/shape work for AgentCardInput/AgentCardPatch)"
metrics:
  duration: "~20 min"
  completed: 2026-10-07
actuals:
  tokens: 14900   # chars/4 over the hand-written diff; the generated snapshot.json adds ~82000 more
  tasks: 2
  commits: 2
---

# Phase 6 Plan 01: Contracts and the single multiplayer_ai migration Summary

Every Phase 6 contract (grants, access, participants, queue, addressing, Agent Cards, events, permissions, notification kinds) is defined once. One generated migration, `20261007073058_multiplayer_ai`, holds the whole Phase 6 schema and has no drift. Four new tables run under forced tenant RLS, proven on a fresh testcontainers PostgreSQL.

## Migration (cite this in later plans)

Directory: `packages/db/drizzle/20261007073058_multiplayer_ai/`. It creates:

- **Tables (all with `organization_id`, so post-migrate.sql applies ENABLE + FORCE RLS + `tenant_isolation`):**
  - `app.ai_chat_grants`: checks `subject_kind_check`, `subject_check` (`(subject_kind='org') = (subject_id is null)`) and `level_check`.
  - `app.ai_message_context`: PK `message_id`; checks `author_kind`, `access` and `level`; FKs to messages, conversations, `ai_chat_grants` (SET NULL) and `ai_generations` (SET NULL).
  - `app.message_cards`: PK `message_id`; checks `kind`, `status`, `title_len ≤ 200` and `decision`; FKs to messages, conversations and agents.
  - `app.message_card_follows`: PK `(message_id, user_id)`; FK to `message_cards.message_id` (CASCADE).
- **Indexes:**
  - `ai_chat_grants_active_uq`: unique on `(conversation_id, subject_kind, coalesce(subject_id, '0…0'::uuid)) WHERE revoked_at is null`.
  - `ai_chat_grants_subject_idx` and `ai_chat_grants_conv_idx`: both partial on active grants.
  - `ai_message_context_queue_idx`: partial on addressed rows with no answer and no skip.
  - `ai_message_context_answered_idx`, `message_cards_conv_idx`, `message_card_follows_user_idx`.
  - `agents_unit_idx`: on `(organization_id, unit_id) WHERE deleted_at is null`.
- **Altered:**
  - `agents.unit_id` references `org_units` with ON DELETE RESTRICT (`agents_unit_id_org_units_id_fkey`).
  - `agents_owner_scope_check` becomes `(scope <> 'personal' or owner_user_id is not null)`.
  - `notifications_kind_check` adds `ai_chat_shared` and `card_updated`.
- `post-migrate.sql` is unchanged; its generic loop covers the new tables.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Contracts, drizzle schema, generated migration, RLS/constraint proofs (tracer) | ce68b47 |
| 2 | Schema is final: no drift, older migrations untouched, Phase 5 suites green | fee98f5 |

## Verification (all run in the worktree; integration only on testcontainers)

- `vitest --project unit` ai-chat + contracts + permissions: 3 files, 93 tests passed. RED ran first: 17 tests failed before the implementation.
- Whole contracts package: 13 files, 232 tests passed.
- `pnpm typecheck --force`: 8 of 8 workspaces passed.
- `rls-isolation.int` on fresh PostgreSQL: 20 of 20 passed, 4 of them new Phase 6 tests:
  - cross-tenant read, write and insert for all four new tables;
  - grant uniqueness, the org-subject check and revoke freeing the slot;
  - a team bot with an owner inserts, a personal bot without one fails, and deleting a unit a bot references fails on the foreign key (`confdeltype = 'r'`);
  - the two new notification kinds insert; card kind, status, decision and title checks reject bad values; deleting a card cascades to its follows; deleting a generation sets `answered_by_generation_id` to null.
- `secret-ref-migration.int`: 3 of 3 passed after the deviation below. `role-migration.int`: 3 of 3 passed.
- `apps/api/.../ai-chat.int` (the Phase 5 tracer): 20 of 20 passed on the new schema.
- Drift check (`generate --name multiplayer_ai_check`): "No schema changes". No `_check` directory is left (0), and `ls -d *_multiplayer_ai*` finds exactly 1 directory.
- Git diff of `packages/db/drizzle` against `merge-base HEAD origin/main` shows only `_multiplayer_ai/` (0 older files changed). See the deviation below about local `main`.
- `pnpm verify`: lint clean (4 warnings already in local-runtime), typecheck 8 of 8, 171 files and 2330 tests passed.
- Acceptance greps passed: the migration contains every required name, the RLS test mentions the new tables 29 times, `export const AgentCardRoute` exists, and `agent-cards.ts` has 0 imports from `./chat`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exhaustive records outside the file list needed the new values**
- **Found during:** Task 1 (`pnpm typecheck --force`, contracts unit suite)
- **Issue:** Three places list every value exhaustively, so they no longer compiled or passed:
  - `apps/web/components/chat/inbox.tsx` has `KIND_LABEL: Record<NotificationKind,…>`.
  - `apps/api/.../permissions/resolve.test.ts` has the hand-written role × permission golden matrix.
  - `packages/contracts/src/chat-workspace.test.ts` pinned the exact 6 notification kinds.
- **Fix:** Added only the new values, behaviour unchanged:
  - Inbox labels: "shared an AI chat with you" and "updated a card you follow".
  - Golden matrix, organization scope: `ai_chat.manage` and `agent_card.approve` are true for every role; `bot.manage_unit` is true for admin only.
  - The Phase 4 test now checks that the first 6 kinds and their ranks are unchanged.
- **Commit:** ce68b47

**2. [Rule 3 - Blocking] The Phase 3.1 RLS assertion "a team bot with an owner is rejected" contradicted AGENT-01**
- **Fix:** Removed it, with a comment. The Phase 6 test now asserts the relaxed rule: team bots may have an owner, personal bots must.
- Because the new `ai_chat` seed conversation exists, three `withTenant` conversation counts go from 3 to 4.
- **Commit:** ce68b47

**3. [Rule 3 - Blocking] `secret-ref-migration.int` asserted that the backfill is the newest migration**
- **Issue:** `expect(backfill).toBe(dirs.length - 1)` fails on any new migration, including the one P-02 requires. The schema itself is not at fault.
- **Fix:** No older migration was edited. The assertion now checks that the backfill directly follows the `ai_chat` schema migration, and that no later migration mentions `model_providers` or `secret_ref`. This keeps the original intent and is stricter.
- **Commit:** fee98f5

**4. [Note] Task 2's git-diff check uses `main`**
- The local `main` ref in this repo is stale and unrelated (`c2cad95`, from Phase 2), so `merge-base HEAD main` lists every migration.
- Run against `origin/main`, which equals the Phase 6 base, the command prints 0. The local `main` ref was not touched.

**5. [Note] CLAUDE.md asks for plan mode on schema migrations**
- The schema diff is the plan's interfaces block, and the owner had delegated approval. It was implemented exactly as specified, without an interactive plan-mode step.

## Known Stubs

None. This is a contract and schema plan; the API, policy and UI consumers start in 06-02. `ai_chat.manage` is not yet decided on a concrete conversation by `policy.ts`; 06-02 and 06-04 own that (P-03, P-04).

## Threat Flags

None new. One note for 06-07: like `conversations.unit_id`, `agents.unit_id` has a foreign key with no organization component. Foreign key checks bypass RLS, so the API must verify that the unit belongs to the caller's organization before setting it.

## Broken-windows ledger

`gsd windows`: nothing to append (no stubs, skipped tests or unrun verifies).

## Self-Check: PASSED

- Files exist: agent-cards.ts, the `20261007073058_multiplayer_ai/{migration.sql,snapshot.json}` files, and this SUMMARY.
- Commits ce68b47 and fee98f5 are on wt/06-01.
