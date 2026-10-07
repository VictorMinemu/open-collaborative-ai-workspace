---
phase: 06-multiplayer-ai-chat
plan: 02
subsystem: api (ai-chat, chat, organization/permissions)
status: complete
tags: [multiplayer-ai, grants, resolver, prompt, rls, tracer]
requires: [06-01 contracts + 20261007073058_multiplayer_ai, Phase 5 AI chat (run loop, buildModelMessages, gateway, usage)]
provides:
  - "POST/GET /api/v1/ai-chats/:id/grants (person subjects; unit/org → 400 grant_subject_unsupported until 06-04)"
  - "aiAccessSql / aiAccessOf (chat/service.ts): THE access expression of AI chats, used by channelFacts, the readable set, list and the prompt roster"
  - "ChannelFacts.aiAccess + AI chat preconditions (ai_chat_view_only, owner-only ai_chat.manage / ai_chat.share)"
  - "createChatGuards (readableChat / writableChat / managedChat / assertOn) in ai-chat/service.ts"
  - "ai_message_context row per human send (solo and multiplayer)"
  - "Multiplayer prompt mode: PromptParticipant, IDENTITY_RULE, neutralise, promptName"
  - "GET /ai-chats?scope=mine|shared|all; summaries carry access/owner/shared; generations carry requesterUserId"
affects: [06-03 (web share dialog + shared chat UI), 06-04 (unit/org grants, revoke, invalidator), 06-05 (persona rows, file labels, notices), 06-06 (queue)]
tech-stack:
  added: []
  patterns:
    - "One SQL CASE (aiAccessSql) decides AI chat access everywhere; conversation_members never decide a human's access"
    - "Route guards that keep Phase 5's hidden-404 for every denial except the one a reader must see (ai_chat_view_only)"
    - "Prompt mode switch by presence of `participants`: absent = Phase 5 bytes, present = attributed format"
key-files:
  created:
    - apps/api/src/modules/ai-chat/grants.ts
    - apps/api/src/modules/ai-chat/multiplayer.int.test.ts
  modified:
    - apps/api/src/modules/organization/permissions/policy.ts
    - apps/api/src/modules/organization/permissions/resolve.test.ts
    - apps/api/src/modules/chat/{service.ts,access.ts,index.ts}
    - apps/api/src/modules/ai-chat/{index.ts,service.ts,dto.ts,turn.ts,generations.ts,shares.ts}
    - apps/api/src/modules/ai-chat/build-model-messages{.ts,.test.ts}
decisions:
  - "Snapshot-link revoke keeps the 05-13 rule (creator only, no ai_chat.share decision) so an owner whose sharing was denied can still withdraw a link; create and list decide ai_chat.share"
  - "promptName keeps sanitizeName's newline → space rule: `Víctor (admin)\"\\n<x>` renders `Víctor (admin) x` (the plan's literal string dropped that space)"
  - "A multiplayer chat that is no longer shared may use the requester's personal instructions again (P-05: only `shared` excludes them); a shared one never does"
  - "The detail's tool states are computed for the viewer (their permission and model), not the owner"
metrics:
  duration: "~75 min"
  completed: 2026-10-07
actuals:
  tokens: 23400   # chars/4 over the added lines of the diff (93 657 chars)
  tasks: 2
  commits: 3
---

# Phase 6 Plan 02: Share an AI chat in place (API tracer) Summary

The owner shares an AI chat with one person through a grant on the same record; the grantee reads it, subscribes to `conv:<id>`, writes, and the model answers on the grantee's own ChatGPT plan with a roster, server-generated `<message>` blocks and a `<turn_context>`; rename, archive, settings, grants and links stay owner-only; solo chats keep the Phase 5 prompt byte for byte.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Grant → resolver → send → prompt → stream (tracer) | 0845b44 |
| 2 | Owner-only management, stop/regenerate requester rules, view grants, solo unchanged | 504fd89 |

## What changed

- **Resolver (P-03, P-04).** `ChannelFacts.aiAccess` (owner/chat/view/null) alone decides a human's relations on an AI chat: owner → owner + member, chat → member, view → grantee, null → none; agents keep `viewerRole`. `channel.read` passes for a `grantee` on an AI chat. `ai_chat.use`/`ai_chat.web` need `member` (view grantee → `ai_chat_view_only`), `ai_chat.manage`/`ai_chat.share` need `owner` (`not_ai_chat_owner`). `AI_CHAT_FIXED` unchanged.
- **Facts (P-03).** `aiAccessSql(userId, convCol)` = CASE over `ai_chats.owner_user_id` and active user grants (chat beats view). `channelFacts` fills `aiAccess` for AI chats + user principals; `readableIds` narrows AI chat candidates to rows where that expression is not null (DMs and groups still need a member row). 06-04 adds unit/org subjects in that one function.
- **Grants (D-03).** `grants.ts`: owner-only create/list; subject must be an active org member (404 `Member not found`), never the owner (400 `grant_to_owner`); idempotent (200 same id; a level change updates in place, audited `ai_chat.grant_updated`); insert under `pg_advisory_xact_lock(hashtext('ai-grants:'||id))` with the `AI_GRANTS_MAX` cap (409 `too_many_grants`); `addMember(role member)`; audit `ai_chat.grant_created` (ids only); durable `ai_chat.access_changed` on `conv:<id>` and `user:<subject>`; `ai_chat.updated` on `user:<subject>` with the grantee's view.
- **Sends (P-07, P-09).** Every human send writes its `ai_message_context` row in the send transaction (owner/grant, grant id, level, addressed, answered_by = the generation, the sender's model ref, effective `{web}`, `shared`). A sender without a participation row gets one. `body.tools` changes the sticky Web state only for `ai_chat.manage`. Generations carry `requesterUserId`; the model is always resolved for the requester.
- **Prompt (D-04, D-06, P-06).** `buildModelMessages` with `participants`: instructions = preamble (no requester name) + `<participants>` + `IDENTITY_RULE` + web note + chat instructions (personal instructions never when `shared`); each human row a `<message from user_id at>` block with a neutralised body; consecutive rows merge; files follow their author's block; the last user message ends with `<turn_context>` and one `<responding_to>` per answered author. `turn.ts` passes `participants` only when multiplayer (grant, non-owner member, or a non-owner author) and derives `respondingTo` from `ai_message_context` across every attempt of the answer.
- **Owner-only (P-04).** `update` and the test activity route use `managedChat`; snapshot/page use `readableChat`; stop = requester or owner (403 `not_generation_requester`); regenerate = `ai_chat.use` + owner or latest requester (403 `not_answer_requester`), on the caller's backend; snapshot-link create/list decide `ai_chat.share`.

## Verification

- `vitest --project unit build-model-messages.test.ts`: 40/40 (14 new multiplayer cases; 12 failed RED first). The `.snap` file is untouched: `git diff --quiet <merge-base origin/main> -- apps/api/src/modules/ai-chat/__snapshots__` exits 0.
- `vitest --project unit resolve.test.ts guard.test.ts build-model-messages.test.ts`: 3 files, 118 tests. The 10 new resolver cases: 6 failed against the old policy (checked by swapping in `HEAD:policy.ts`).
- `multiplayer.int.test.ts` (fresh PostgreSQL + Redis, fake model): 17/17. RED first: 9 failed (Task 1) and 4 failed (Task 2) before each implementation.
- Phase 5 regressions, one file at a time: ai-chat.int 20/20, list.int 7/7, security.int 5/5, tools.int 17/17, stop.int 8/8, regenerate.int 6/6, shares.int 14/14, search.int 27/27; api unit suite 29 files / 421 tests.
- `pnpm verify`: exit 0. Lint clean (the 4 warnings already in local-runtime), typecheck 8 of 8, 172 files and 2371 tests passed.
- Acceptance greps: `export function aiAccessSql` (chat/service.ts), `registerGrantRoutes` (ai-chat/index.ts), `export const IDENTITY_RULE`, `aiMessageContext` (ai-chat/service.ts), `ai_chat_view_only` (policy.ts), `not_generation_requester` (generations.ts), `ai_chat.share` in shares.ts ≥ 2 lines: all print.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `GET /ai-chats?scope=shared` answered 500 (no permission decision)**
- **Found during:** Task 1 (multiplayer.int, lists case).
- **Issue:** the authz guard requires a request-level decision; skipping `perms.can("ai_chat.use")` for non-`mine` scopes left none (`readableIds` is request-less).
- **Fix:** always decide `ai_chat.use` at organization scope; only `mine` is gated on it (shared chats are decided per chat by `channel.read`).
- **Commit:** 0845b44

**2. [Rule 1 - Regression guard] Snapshot-link revoke keeps the 05-13 rule**
- **Issue:** the plan lists revoke among the routes that decide `ai_chat.share`. 05-13 deliberately lets a creator withdraw a link even after `ai_chat.share` is denied to them; the row filter `created_by = caller` plus the readable chat already make revoke owner-only (only the owner can ever create a link).
- **Fix:** create and list decide `ai_chat.share` (hidden 404); revoke is unchanged. Alex, the admin and org B get 404 on revoke (tested).
- **Commit:** 504fd89

**3. [Note] `promptName` keeps the `sanitizeName` space**
- The behaviour list expects `Víctor (admin)"\n<x>` → `Víctor (admin)x`; `sanitizeName` turns the newline into a space, so the result is `Víctor (admin) x`. The test asserts that exact string; no quote, newline or angle bracket survives either way.

**4. [Note] "last user item contains Víctor's earlier block"**
- Víctor's first message is answered before Alex writes, so it sits in an earlier user item; the test asserts Víctor's block in the first user item and Alex's block + `<responding_to name="Alex Kim">` in the last one.

**5. [Note] The plan's snapshot check uses `merge-base HEAD main`**
- Local `main` is stale (Phase 2, see 06-01); the check was run against `origin/main` and the 06-01 merge (both exit 0).

**6. [Note] CLAUDE.md plan mode for permission changes**
- Implemented exactly as specified by P-03/P-04 under the owner's delegated approval, without an interactive plan-mode step.

## Known Stubs

None. Unit and organization subjects return 400 `grant_subject_unsupported` by design until 06-04 (planned, not a stub of this plan's goal).

## Threat Flags

None beyond the plan's register. T-06-02-01 … 09 are mitigated and tested (forged bodies/names, personal instructions with a grant and no second poster, requester-paid turns and regenerates, owner-only routes, admin/org-B 404 and no subscription, stale member rows, foreign subject ids, audit + context rows, cap under an advisory lock).

## Open items for later plans

- 06-04: revoke/downgrade must re-decide member rows and register the `ai_chat.access_changed` invalidator (P-09); `aiAccessSql` and `matchingGrant` get unit/org subjects.
- 06-06: multiplayer sends still answer 409 while a generation runs (Phase 5 semantics); the queue replaces this.

## Broken-windows ledger

`gsd windows`: nothing to append (no stubs, skipped tests or unrun verifies).

## Self-Check: PASSED

- Files exist: grants.ts, multiplayer.int.test.ts, this SUMMARY.
- Commits 0845b44 and 504fd89 are on wt/06-02.
