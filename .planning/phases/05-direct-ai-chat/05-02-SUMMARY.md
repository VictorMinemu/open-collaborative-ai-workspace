---
phase: 05-direct-ai-chat
plan: 02
subsystem: api
tags: [ai-sdk, model-gateway, chatgpt-plan, streaming, websocket, rls, permissions, fake-model]

requires:
  - phase: 05-direct-ai-chat
    plan: 01
    provides: Phase 5 contracts, the ai_chat schema (8 tables), user_model_credential secrets kind
provides:
  - "@ocw/api pins: ai 7.0.122, @ai-sdk/openai 4.0.80, @ai-sdk/anthropic 4.0.68, @ai-sdk/openai-compatible 3.0.59"
  - "modules/model-gateway: createModelGateway (resolve/listModels/classify/reportFailure/labelOf), plan credentials (sealed, requester-only), catalog (1 h Redis cache), GET /ai-chat/models, GET /me/model-credentials/chatgpt, test-only POST /test/ai/chatgpt-plan"
  - "modules/ai-chat: buildModelMessages (pure), turn.ts seam, run loop (streamText, 50 ms ai.delta, 1 s partial flush, one finalize), usage.ts, POST /ai-chats, POST /ai-chats/:id/messages, GET /ai-chats/:id, GET /ai-chats/:id/messages"
  - "Resolver state ai_chat with ai_chat_private and not_ai_chat_owner; readable set and conv:<id> topic accept ai_chat (not a default kind)"
  - "Env OCW_CHATGPT_API_BASE_URL, OCW_CHATGPT_AUTH_BASE_URL (test-only, refused in production), OCW_AI_MOCK_BASE_URL, OCW_AI_SEARXNG_URL, OCW_AI_SEND_RATE_LIMIT_PER_MINUTE"
  - "infra/fake-model/fake-responses.mjs (Responses SSE, plan preview rules, [[slow]], [[plan:*]], catalog) and apps/api/src/testing-ai.ts (startFakeModel, startAiStack, seedPlan, subscribeConv, startSecondInstance)"
affects: [05-03, 05-04, 05-05, 05-06, 05-07, 05-08, 05-09, 05-10, 05-11, 05-12, 05-13, 05-14, 05-15]

actuals:
  tokens: 45248   # chars/4 over added lines of the realized diff, lockfile excluded
  tasks: 3
  commits: 7

tech-stack:
  added: ["ai@7.0.122", "@ai-sdk/openai@4.0.80", "@ai-sdk/anthropic@4.0.68", "@ai-sdk/openai-compatible@3.0.59"]
  patterns:
    - "streamText always receives a provider instance from the gateway and an explicit onError (the SDK default console.error()s the error object, which carries the prompt)"
    - "Ephemeral ai.delta frames with UTF-16 offsets coalesced on a 50 ms timer; partial text to ai_generations.partial_text, the message body written once at finalize"
    - "Per-user pg_advisory_xact_lock(hashtext('ai:'||user)) before the running-generation count (concurrency cap)"
    - "Secrets sealed with an explicit AAD (putSealed/revealSealed) for per-member credentials"

key-files:
  created:
    - apps/api/src/modules/model-gateway/index.ts
    - apps/api/src/modules/model-gateway/errors.ts
    - apps/api/src/modules/model-gateway/errors.test.ts
    - apps/api/src/modules/model-gateway/policy.ts
    - apps/api/src/modules/model-gateway/routes.ts
    - apps/api/src/modules/model-gateway/chatgpt-plan/credentials.ts
    - apps/api/src/modules/model-gateway/chatgpt-plan/catalog.ts
    - apps/api/src/modules/model-gateway/chatgpt-plan/routes.ts
    - apps/api/src/modules/ai-chat/index.ts
    - apps/api/src/modules/ai-chat/routes.ts
    - apps/api/src/modules/ai-chat/service.ts
    - apps/api/src/modules/ai-chat/dto.ts
    - apps/api/src/modules/ai-chat/turn.ts
    - apps/api/src/modules/ai-chat/run-loop.ts
    - apps/api/src/modules/ai-chat/build-model-messages.ts
    - apps/api/src/modules/ai-chat/build-model-messages.test.ts
    - apps/api/src/modules/ai-chat/usage.ts
    - apps/api/src/modules/ai-chat/guard.test.ts
    - apps/api/src/modules/ai-chat/ai-chat.int.test.ts
    - apps/api/src/testing-ai.ts
    - infra/fake-model/fake-responses.mjs
    - infra/fake-model/fake-responses.test.mjs
    - infra/fake-model/server.d.mts
  modified:
    - apps/api/package.json
    - pnpm-lock.yaml
    - apps/api/src/config/env.ts
    - apps/api/src/config/env.test.ts
    - apps/api/src/app.ts
    - apps/api/src/modules/secrets/index.ts
    - apps/api/src/modules/organization/permissions/resolve.ts
    - apps/api/src/modules/organization/permissions/policy.ts
    - apps/api/src/modules/organization/permissions/resolve.test.ts
    - apps/api/src/modules/chat/access.ts
    - apps/api/src/modules/chat/index.ts
    - apps/api/src/modules/chat/service.ts
    - apps/api/src/modules/identity/service.ts
    - infra/fake-model/server.mjs
    - infra/fake-model/Dockerfile

key-decisions:
  - "Package gate (Task 1) approved 2026-10-06 by the orchestrator, owner-delegated; exact pins installed, accepted by minimumReleaseAge, no install scripts, lockfile adds only the approved set plus json-schema 0.4.0"
  - "streamText gets onError: () => {} because the AI SDK's default handler console.error()s the error object (request body = prompt)"
  - "A ChatGPT catalog outage (network/5xx) does not block a turn; 401/403 on the catalog means needs_reconnect; a known catalog without the slug refuses with not_in_catalog"
  - "Sends with attachmentIds are refused with 400 attachments_unavailable until 05-12 instead of being silently ignored"
  - "[[slow]] replies are the echo followed by counting ' 1' … ' 40' (40 non-empty deltas for any prompt)"

patterns-established:
  - "Phase 5 API tests: startAiStack + seedPlan + subscribeConv; assert the fake's captured requests instead of mocking the SDK"

requirements-completed: [AICHAT-02, AICHAT-03, AICHAT-07]

duration: 50min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 02: API tracer — ChatGPT-plan turn streams over WS and persists Summary

**Through the API alone, a member's own ChatGPT-plan turn now runs end to end: `POST /ai-chats` (owner-only, one generation per chat, per-user cap, idempotent) → model gateway with the member's sealed token → AI SDK 7 `streamText` → fake `POST /v1/responses` (`store:false`, `stream:true`, developer instructions, no forbidden field) → 50 ms-coalesced `ai.delta` frames with chained offsets on `conv:<id>` → one durable `message.updated` and exactly one usage record (plan cost null). AI chats are hidden from everyone but their owner, admins and other tenants included, and two static guards pin prompts to `buildModelMessages` and models to the gateway.**

## Performance

- **Duration:** ~50 min (2026-10-06, 10:30 to 11:20 local)
- **Tasks:** 3/3 (Task 1 is the package gate, approved before execution)
- **Files:** 38 changed (23 created, 15 modified), lockfile included

## Package approval record (Task 1)

APPROVED 2026-10-06 by the orchestrator (owner-delegated), recorded in 05-02-PLAN.md. `npm view` evidence: ai@7.0.122, @ai-sdk/openai@4.0.80, @ai-sdk/anthropic@4.0.68, @ai-sdk/openai-compatible@3.0.59, all github.com/vercel/ai, Apache-2.0, published 2026-09-28, no install scripts. Transitives: @ai-sdk/gateway 4.0.100, @ai-sdk/provider 4.0.19, @ai-sdk/provider-utils 5.0.51 (same repo), @vercel/oidc 3.2.0 and @workflow/serde 4.1.0 (Vercel, Apache-2.0, no install scripts). `pnpm --filter @ocw/api add` with exact pins passed the supply-chain policy (`minimumReleaseAge`, no exclusions added). The lockfile gained exactly those ten packages plus `json-schema@0.4.0`, a range the record already lists. `pnpm install --frozen-lockfile` passes.

## Accomplishments

- **Gateway (P-04, P-10):** `resolve()` reads only the requester's `user_model_credentials` row. The token bundle is sealed with AAD `<orgId>:<userId>:chatgpt_plan` (`secrets.putSealed/revealSealed`), and the model is `createOpenAI({apiKey, baseURL, name}).responses(slug)`. Provider options are `{store:false, systemMessageMode:"developer"}` with `maxRetries: 0`. `classify()` maps the six SIWC codes, `{detail}` 401s, aborts and 429s to `AiErrorCode` plus the implied credential transition, and never copies request or response bodies. `org_key`/`mock` refuse with `not_allowed` until 05-04.
- **Run loop (P-06, P-07):** a 50 ms timer publishes the unseen suffix as `ai.delta {offset, text}`. Partial text and the heartbeat flush to `ai_generations` every second, never to `messages.body`. One finalize transaction writes the body, status, generation outcome, one usage record (provider counts, else `estimated`), credential transitions, `message.updated` and `ai_chat.updated`. A fail-safe marks a crashed generation `failed`. `onAfterFinalize` listeners are ready for 05-10.
- **Sends:** in one tenant transaction the route decides `ai_chat.use`, resolves the model (409 `model_unavailable` + reason), retries are idempotent on `clientMessageId`, and it then applies the 409 `generation_in_progress` gate and the advisory-locked cap (429 `concurrent_generations`). The user message and the streaming assistant placeholder carry their own `message.created` seqs. Audit rows hold ids, backend, provider and model only.
- **Privacy (P-03):** `ai_chat` is a resource state (always also `private`). `ai_chat_private` denies membership, archive, update, moderation, `@channel` and generic posting even for the owner. `not_ai_chat_owner` denies `ai_chat.*` on any channel resource that is not the principal's AI chat. The `conv:` authorizer accepts `ai_chat`, while the default readable kinds stay channel/dm/group.
- **Fake + harness:** `/v1/responses` emits the exact SSE events @ai-sdk/openai 4.0.80 parses (each with `sequence_number`), enforces the plan preview rules for `fake-plan-` bearers, and serves the plan catalog. It supports `[[slow]]`, `[[plan:*]]`, `[images:N]`/`[files:N]` and `onRequest` capture. The fake image now also ships `fake-responses.mjs`.

## Task Commits

1. **Task 1 (package gate):** `f1cf75e` chore — install of the approved pins
2. **Task 2 (tracer), split as the plan checker asked:** `29b84d9` env + fake Responses API · `8fbb161` model gateway · `aa476d1` buildModelMessages · `905dc90` test (RED: harness + integration tracer) · `1f8518a` run loop, sends, snapshots, WS (GREEN)
3. **Task 3:** `b212dcb` resolver state, guard, privacy/cross-tenant/seed-route/log-scan cases

## Verification

- `pnpm install --frozen-lockfile`: passes.
- Unit (`errors`, `build-model-messages`, `env`, `resolve`, `guard`): 5 files, 106/106. That includes 13 classifier cases, 13 prompt-builder cases (2 snapshots), 5 env cases, 6 AI chat resolver cases and 6 guard cases. A probe file violating every guard rule made 4 guard tests fail and was then removed.
- Node (`fake-responses` + `server`): 46/46. All `infra/**/*.test.mjs`: 89/89.
- Integration `ai-chat.int.test.ts` on ephemeral PostgreSQL + Redis with the in-process fake: 20/20. This covers models before and after seeding, the 201 shape, Sam's bearer with `store:false`/`stream:true`/a developer item/no forbidden key, one usage record (cost null), deltas chained from offset 0 equal to the final body, an empty body mid-stream with growing `partial_text`, snapshot and pages, 409 gate, idempotent retries, 429 cap, Alex `not_connected` with zero fake requests, and audit metadata without bodies. Privacy: member/admin 404 on all routes and no `conv:` subscription; generic chat routes 404 even for the owner; an org-B admin gets 404 and `not_connected`; the seed route is absent without the override. Failure paths: a mid-stream usage limit keeps the partial text; invalid_user moves the credential to needs_reconnect. A final log scan finds no `fake-plan-`, `fake-refresh-` or prompt text.
- `pnpm typecheck --force`: 8/8. `pnpm verify`: lint shows 4 warnings, all pre-existing in `apps/local-runtime`. Typecheck and tests pass: **146 files, 2013 tests** (05-01 baseline: 142/1950).
- Acceptance greps: the four exact pins are in `apps/api/package.json`; no `@ai-sdk/` import exists outside `modules/model-gateway/`; `EphemeralTypes.aiDelta` is in `run-loop.ts`; `ai_chat_private` and `not_ai_chat_owner` are in `policy.ts`.
- No real provider, ChatGPT or SearXNG call. No migration, and no default `.env` used. Demo resources untouched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Files outside `files_modified`**
- `apps/api/src/modules/chat/service.ts`: `getConversation` accepts `ai_chat`, and `channelFacts` maps kind `ai_chat`. The readable set and topic authorizer could not include AI chats without this.
- `apps/api/src/modules/identity/service.ts`: `organizationName(id)`. The `app` role cannot read `auth.organization`, and the prompt preamble needs the org name.
- `infra/fake-model/server.d.mts`: types for importing the fake into TypeScript tests. This follows the existing `fake-clawhub.d.mts`.
- Commits: 1f8518a, b212dcb, 29b84d9

**2. [Rule 2 - Correctness] Fake image ships `fake-responses.mjs`**
- `infra/fake-model/Dockerfile` copies the new module, so a containerized fake (compose e2e) serves `/v1/responses`. `server.mjs` imports it dynamically and still runs alone when bind-mounted (container smoke). Commit 29b84d9.

**3. [Rule 2 - Security] `streamText` gets an explicit `onError`**
- Without it the AI SDK `console.error()`s the error object, whose `requestBodyValues` is the prompt (P-10). Commit 1f8518a.

**4. [Rule 2 - Rigor] Extra tests**
- Provider failure paths: a mid-stream `usage_limit_exceeded` and an `invalid_user` → `needs_reconnect` → 409 → reseed. The logged failure line carries `{code, status, provider}` only.
- Guard self-tests and a mutation probe. Resolver cases for organization-scope `ai_chat.use` under a deny rule. `ai_chat` was added to the resolver property-test states.

**5. [Rule 1 - Spec precision] `ai_chat_private` "even for the owner"**
- A precondition only explains permissions the role grants. A standard owner never holds `message.delete_any` or `channel.mention_all`, so for those the denial reason is `missing_permission`.
- The test asserts all seven are denied for a standard owner, all seven carry `ai_chat_private` for an admin owner, and the four role-granted ones carry `ai_chat_private` for the standard owner.

**6. [Scope] Interfaces: add-only members and refusals**
- `ModelGateway.labelOf(ref)` gives catalog labels for DTOs. `RunLoop.textOf(id)` gives the in-memory text for the snapshot's `running.partialText`.
- Sends with `attachmentIds` answer 400 `attachments_unavailable` until 05-12 rather than silently dropping files.

**7. [Resources] Seed-route-absent case**
- This case starts a second `buildApp` on the same PostgreSQL and Redis with `OCW_CHATGPT_API_BASE_URL: null` (the production shape), not a second full `startAiStack`. That saves two containers on the memory-constrained machine.
- The assertion is the same: 404, and the route is unregistered in the authz registry. A positive control shows `GET /me/model-credentials/chatgpt` is 200 on that instance.

**8. [Spec detail] `[[slow]]` text**
- The 40 slow deltas are the echo followed by " 1" … " 40", so every prompt yields 40 non-empty deltas. It is the same contract on `/v1/responses`, chat-completions and Anthropic.

**Plan mode note:** CLAUDE.md asks for plan mode on permission changes. The plan delegates approval ("owner delegated approval"), so the resolver change went straight from the plan's specification to code.

## Known Stubs

These are intentional, each owned by a later plan, and none blocks this plan's goal:
- `model-gateway/index.ts` `resolve()`: `org_key` and `mock` refuse with `not_allowed`. Owner: 05-04.
- `chatgpt-plan/credentials.ts` `accessTokenFor`: an expired token gives `needs_reconnect` with no refresh. Owner: 05-05.
- `ai-chat/dto.ts` `chatTools`: Company knowledge, MCP and Skills show `not_available_yet`. Web follows the chat setting and policy only. Owner: 05-11 (P-14 keeps the three disabled).
- `ai-chat/service.ts` `refuseAttachments`: owner 05-12.

## Windows Ledger

No entries needed. The stubs above are planned work with named owners. There are no skipped tests, unrun verifies or open deviations. No `gsd windows append` command is required.

## Threat Flags

None beyond the plan's threat model. T-05-02-01 … T-05-02-08 and T-05-02-SC are each mitigated and covered by a test. Requester-only credential: Alex gets no fake request. Sealed tokens plus the log scan cover T-02. Privacy and cross-tenant 404s cover T-03. Generic post 404 and `ai_chat_private` cover T-04. 409, 429 and the rate limit cover T-05. `store:false` is enforced by the fake's preview rules (T-06). The seed route is double-locked (T-07). `guard.test.ts` covers T-08.

## Issues Encountered

None blocking. The integration run prints a `pg` deprecation warning ("client.query() while executing"). It comes from other suites' superuser clients; the instance in this file was removed by making `settled()` sequential.

## Next Phase Readiness

- 05-03 (web) can use every route in this plan, `seedPlan` and the `[[slow]]`/`[[plan:*]]` directives. The `ai.delta` frames chain from offset 0, and `stitchAiSnapshot` works with `running.partialText`.
- 05-04 adds the `org_key`/`mock` branches to `resolve()` and `listModels()`. 05-05 replaces `accessTokenFor` expiry with the serialized refresh. 05-06 adds stop through `RunLoop.abort` and the Redis fan-out, using `startSecondInstance` and `instance_id`. 05-10 registers titles with `onAfterFinalize`.

## Self-Check: PASSED

- Files exist: every path in `key-files`.
- Commits found: f1cf75e, 29b84d9, 8fbb161, aa476d1, 905dc90, 1f8518a, b212dcb.
