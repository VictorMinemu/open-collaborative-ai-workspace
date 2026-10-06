---
phase: 05-direct-ai-chat
plan: 01
subsystem: database
tags: [contracts, zod, drizzle, postgres, rls, migrations, secrets]

requires:
  - phase: 04-complete-chat
    provides: conversations/messages/message_versions schema, post-migrate RLS loop, RLS enumerator test
  - phase: 01
    provides: app.secrets (sealed, AAD = org id), model_providers.secret_id
provides:
  - Every Phase 5 contract (ai-generation.ts, ai-chat.ts, model-prices.ts, Message.generation, ai_chat.updated, ai.delta, four ai_chat.* permissions)
  - Migration *_ai_chat (8 tables, model_providers.secret_ref, message_versions kind regenerate, ai_generations_one_running_uq)
  - Migration *_provider_secret_refs (idempotent SecretReference backfill with documented rollback)
  - Append-only ai_usage_records for ocw_app
affects: [05-02, 05-03, 05-04, 05-05, 05-06, 05-08, 05-09, 05-10, 05-11, 05-12, 05-13]

actuals:
  tokens: 171677   # chars/4 over the realized diff incl. two generated drizzle snapshots (~21.8k hand-written)
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Unrefined `*Fields` base object + `.refine()` so a refined request can be extended (zod 4 refuses to extend a refine)"
    - "Data migration tests read the rollback statement from the migration header and execute it"

key-files:
  created:
    - packages/contracts/src/ai-generation.ts
    - packages/contracts/src/ai-chat.ts
    - packages/contracts/src/model-prices.ts
    - packages/contracts/src/ai-chat.test.ts
    - packages/contracts/src/model-prices.test.ts
    - packages/db/drizzle/20261006152939_ai_chat/migration.sql
    - packages/db/drizzle/20261006153117_provider_secret_refs/migration.sql
    - packages/db/src/secret-ref-migration.int.test.ts
  modified:
    - packages/contracts/src/chat.ts
    - packages/contracts/src/realtime.ts
    - packages/contracts/src/permissions.ts
    - packages/contracts/src/index.ts
    - packages/db/src/schema/app.ts
    - packages/db/sql/post-migrate.sql
    - packages/db/src/rls-isolation.int.test.ts
    - apps/api/src/modules/organization/permissions/resolve.test.ts

key-decisions:
  - "estimateCostMicros treats cachedInputTokens as a subset of inputTokens (AI SDK 7 reports total input with a cache-read detail): uncached at the input price, cached at the cache price (input price when the model has none)"
  - "Mock model is priced 0/0 so a mock generation stores cost 0 with a priceRef; ChatGPT plan stores null"
  - "Phase 5 RLS seeds put ai_chats/generations/shares on the existing seeded conversation (as the plan states) so Phase 4 conversation counts stay unchanged"
  - "The backfill only touches rows with secret_ref still NULL, so an operator env/file reference is never overwritten"

patterns-established:
  - "AI chat permission set: chat surface, STANDARD placement, delegable (deny rules can take them away)"

requirements-completed: [AICHAT-01, AICHAT-07]

coverage:
  - id: D1
    description: "Every Phase 5 contract exists once and compiles in api and web"
    requirement: AICHAT-01
    verification:
      - kind: unit
        ref: "packages/contracts/src/{ai-chat,model-prices,contracts,permissions}.test.ts"
        status: pass
      - kind: other
        ref: "pnpm typecheck --force"
        status: pass
    human_judgment: false
  - id: D2
    description: "Eight AI chat tables under forced tenant RLS, cross-tenant invisible/unwritable; one running generation per conversation; regenerate versions"
    verification:
      - kind: integration
        ref: "packages/db/src/rls-isolation.int.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "ai_usage_records append-only for ocw_app (update/delete/truncate denied, insert allowed, unique per generation+kind)"
    requirement: AICHAT-07
    verification:
      - kind: integration
        ref: "packages/db/src/rls-isolation.int.test.ts#Phase 5: usage records are append-only for the app role"
        status: pass
    human_judgment: false
  - id: D4
    description: "Provider-key SecretReference backfill: keyed rows only, idempotent, ciphertext byte-identical, documented rollback restores legacy state"
    requirement: AICHAT-01
    verification:
      - kind: integration
        ref: "packages/db/src/secret-ref-migration.int.test.ts"
        status: pass
    human_judgment: false

duration: 16min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 01: Contracts and migrations Summary

**All Phase 5 Zod contracts plus two migrations: `*_ai_chat` adds eight tables under forced tenant RLS, with append-only usage and at most one running generation per conversation. `*_provider_secret_refs` backfills `{provider:"db", secretId, organizationId}` without touching ciphertext. It can be rerun safely and has a rollback documented in the file header. Both are proven on fresh testcontainers PostgreSQL.**

## Performance

- **Duration:** ~16 min (2026-10-06T15:22Z to 15:38Z)
- **Tasks:** 2/2
- **Files:** 20 changed (8 created, 8 modified, plus 2 migration folders, each with a snapshot)

## Accomplishments

- Contracts: `ai-generation.ts` (ModelRef with backend/provider pairing, AiGeneration, AiUsage, AiErrorCode), `ai-chat.ts` (every name in the interfaces block, plus the pure `applyAiDelta` / `stitchAiSnapshot`), `model-prices.ts` (versioned table, `estimateCostMicros`, `estimateTokens`). Also added `Message.generation`, `EventTypes.aiChatUpdated`, `EphemeralTypes.aiDelta`, and `ai_chat.use|web|share|share.read` (chat surface, every role).
- Schema: added `ai_chats`, `ai_user_preferences`, `ai_generations` (`ai_generations_one_running_uq`, heartbeat partial index), `ai_usage_records`, `ai_usage_daily`, `ai_chat_policies` (defaults equal `DEFAULT_AI_CHAT_POLICY`, which a test asserts), `user_model_credentials` and `ai_chat_shares`. Also added `model_providers.secret_ref`, the `regenerate` kind on `message_versions` (check constraint updated) and the `user_model_credential` kind on `secrets`.
- `post-migrate.sql`: `REVOKE UPDATE, DELETE, TRUNCATE ON app.ai_usage_records FROM ocw_app`. Removing that line makes the append-only test fail.
- `drizzle-kit generate --name ai_chat_check` reports "No schema changes", and no `_check` directory was left behind.

## Task Commits

1. **Task 1 (tracer):** `7d231a5` test (RED), `336fc8a` feat (GREEN)
2. **Task 2:** `22778d6` test, `f24caa4` feat

## Verification

- Unit (4 contract files): 81/81 pass. `pnpm typecheck --force`: 8/8 tasks pass.
- Integration on fresh ephemeral PostgreSQL, run together: rls-isolation (16), role-migration (3) and secret-ref-migration (3) give 22/22 pass.
- `pnpm verify`: lint (4 warnings, all in `apps/local-runtime`, not touched here), typecheck, and 142 test files / 1950 tests, all pass.
- No command used the default `.env` (there is none in this worktree), and no demo resource was touched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Resolver policy table gained the four `ai_chat.*` entries**
- **Found during:** Task 1 (`pnpm typecheck --force`)
- **Issue:** `apps/api/src/modules/organization/permissions/resolve.test.ts` has a hand-written `Record<Permission, boolean>` per role, so the new permissions broke typecheck.
- **Fix:** added `"ai_chat.*": true` for all four roles (the intended policy). The resolver test passes with 56/56.
- **Files modified:** apps/api/src/modules/organization/permissions/resolve.test.ts (not listed in `files_modified`)
- **Commit:** 336fc8a

**2. [Rule 2 - Rigor] Extra assertions beyond the behavior list**
- RLS: a cross-tenant INSERT copying org B's row from org A's context is refused for every one of the eight tables. A duplicate `(generation_id, kind)` usage record is rejected. Non-running statuses and a running generation in another conversation are accepted. An invalid status is rejected. Policy column defaults equal `DEFAULT_AI_CHAT_POLICY`.
- Backfill: the second organization keeps its own `organizationId`, and no provider column other than `secret_ref` changes. The rollback is read from the header and executed. Keys still resolve through the `secret_id` join after rollback. The backfill can be reapplied after a rollback. A preset env reference is never overwritten.
- Commits: 7d231a5, 22778d6

**Plan mode note:** CLAUDE.md asks for plan mode on schema and tenant-isolation changes. The plan delegates approval ("present the schema diff as a plan, then proceed"), so the schema went straight from the plan's specification to code. The generated SQL was read in full and matches every listed table, check, key and index.

## Known Stubs

None. The contract constants and schema are final. API, web and run-loop behavior is out of scope (05-02 onward).

## Windows Ledger

No entries (no stubs, skipped tests, unrun verifies or open deviations); no `gsd windows append` command needed.

## Threat Flags

None beyond the plan's threat model. T-05-01-01 to T-05-01-05 are each mitigated and covered by a test.

## Issues Encountered

None.

## Next Phase Readiness

- 05-02 can import every Phase 5 contract and write to the eight tables. `model_providers.secret_ref` is populated for keyed rows after migration.
- `apps/api` still reads `secret_id` (`agent/service.ts` `cellProviders`) until 05-04 switches it to `core.secrets.resolve(tx, secret_ref)`. A provider upserted between this migration and 05-04 will have `secret_ref = NULL`. 05-04 must keep `secret_ref` in sync on upsert (its plan already requires this).

## Self-Check: PASSED

- Files: ai-generation.ts, ai-chat.ts, model-prices.ts, both migration folders and secret-ref-migration.int.test.ts all exist.
- Commits found: 7d231a5, 336fc8a, 22778d6, f24caa4.
