---
phase: 05-direct-ai-chat
plan: 08
subsystem: api, web, contracts
tags: [metering, usage, prices, daily-limits, policy, ai-chat, playwright]

requires:
  - phase: 05-direct-ai-chat
    plan: 01
    provides: model-prices table, AiUsage/AiUsageToday/AiChatPolicy contracts, ai_usage_records (append-only), ai_usage_daily, ai_chat_policies
  - phase: 05-direct-ai-chat
    plan: 06
    provides: one finalize per outcome (completed, stopped, interrupted, failed), regenerate route
  - phase: 05-direct-ai-chat
    plan: 07
    provides: failed-turn usage with reported counts, usage-limit dialog
provides:
  - "MODEL_PRICES with a source (URL + date) on every row: Anthropic (claude-api skill = platform.claude.com pricing), OpenAI gpt-5 / gpt-5-mini / gpt-4.1, OpenRouter anthropic/claude-sonnet-5-5 and openai/gpt-5; PRICE_TABLE_VERSION 2026-10-06.2; costMicrosOf"
  - "recordUsage final semantics: one record per generation and kind, today's ai_usage_daily gains tokens and cost in the same transaction (mock counts as org_key); backendClassOf"
  - "limits.ts: consumeGeneration (one conditional upsert with setWhere), usageToday, refuseOverLimit (429 daily_limit_reached + audit ai_chat.limit_reached)"
  - "usage-routes.ts: registerUsageRoutes with GET /me/ai-usage/today, registered once in ai-chat/index.ts (05-09 adds the reports there)"
  - "GET/PUT /ai-chat/policy (provider.manage, audit ai_chat.policy_updated {changed}); saveAiChatPolicy keeps chatgpt_host_id"
  - "Web: lib/ai-format.ts (formatTokens, formatCostMicros, formatUsage, footerParts, usageTitle, formatResetTime, limitNoticeText), lib/ai-usage-queries.ts, the answer footer, the composer limit notice, Settings › Models › AI chats (AiChatPolicySettings)"
  - "Fake Anthropic directives [[cache:N]] and [[http:NNN]]"
affects: [05-09, 05-10, 05-11, 05-12, 05-13]

actuals:
  tokens: 27300   # chars/4 over added lines of the realized diff (109,082 chars), screenshots excluded
  tasks: 2
  commits: 6

tech-stack:
  added: []
  patterns:
    - "A refused send commits only its audit row: the send transaction returns {refused: HttpError} and the route throws it after commit"
    - "Daily counters: the answer is counted at send time (consumeGeneration, before any insert or model call); tokens and cost are added at finalize to the row of the generation's start day"
    - "Footer rendered as parts that never break inside (whitespace-nowrap spans joined by ' · '), so it wraps cleanly at 390"

key-files:
  created:
    - apps/api/src/modules/ai-chat/limits.ts
    - apps/api/src/modules/ai-chat/usage-routes.ts
    - apps/api/src/modules/ai-chat/usage.int.test.ts
    - apps/web/lib/ai-format.ts
    - apps/web/lib/ai-format.test.ts
    - apps/web/lib/ai-usage-queries.ts
    - apps/web/components/ai-chat/admin/ai-chat-policy-settings.tsx
    - e2e/tests/ai-chat-usage.spec.ts
  modified:
    - packages/contracts/src/model-prices.ts
    - packages/contracts/src/model-prices.test.ts
    - apps/api/src/modules/ai-chat/usage.ts
    - apps/api/src/modules/ai-chat/service.ts
    - apps/api/src/modules/ai-chat/generations.ts
    - apps/api/src/modules/ai-chat/index.ts
    - apps/api/src/modules/model-gateway/routes.ts
    - apps/api/src/modules/model-gateway/policy.ts
    - apps/web/components/ai-chat/ai-message.tsx
    - apps/web/components/ai-chat/ai-composer.tsx
    - apps/web/components/ai-chat/ai-chat-view.tsx
    - apps/web/components/ai-chat/regenerate-menu.tsx
    - apps/web/app/(app)/settings/models/page.tsx
    - infra/fake-model/server.mjs
    - e2e/tests/ai-chat.spec.ts
    - e2e/tests/ai-chat-stop.spec.ts
    - e2e/tests/ai-chat-models.spec.ts
    - e2e/tests/ai-chat-plan-errors.spec.ts

key-decisions:
  - "Prices are the providers' standard tier. OpenAI rows come from developers.openai.com/api/docs/pricing, because openai.com/api/pricing answered 403 to a plain fetch. OpenRouter rows come from its public models API. Every price the plan asked for was sourced, so none is missing"
  - "PRICE_TABLE_VERSION is '2026-10-06.2'. It is a same-day revision of the 05-01 seed, so every stored priceRef names exactly one table"
  - "The mock counts as an organization model for caps (cost 0); the plan is capped only when planDailyGenerations is set"
  - "The 429 carries details {limit, backendClass, max, resetsAt}. The web reads the reset time and the counts from GET /me/ai-usage/today, so ApiRequestError did not change"
  - "Answer footer order: usage, model, who pays ('1.2k in · 340 out · ~$0.004 · Claude Sonnet 5.5 · METERED', '… · GPT-6 Astra · ChatGPT plan')"

requirements-completed: [AICHAT-07]

coverage:
  - id: D1
    description: "Every outcome (completed, cached input, stopped, failed 500, interrupted, plan, mock) writes exactly one correct usage record; today's counters gain it in the same transaction; no text columns"
    requirement: AICHAT-07
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/usage.int.test.ts (Task 1 describes)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sourced price table; unknown model → cost null / '—'"
    requirement: AICHAT-07
    verification:
      - kind: unit
        ref: "packages/contracts/src/model-prices.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Tokens and cost under every answer, ~ when estimated, ChatGPT plan without cost"
    requirement: AICHAT-07
    verification:
      - kind: unit
        ref: "apps/web/lib/ai-format.test.ts"
        status: pass
      - kind: e2e
        ref: "e2e/tests/ai-chat-usage.spec.ts › every answer shows its tokens and cost (desktop + mobile)"
        status: pass
    human_judgment: true
  - id: D4
    description: "Atomic daily caps with no model call at the cap; 10 concurrent at cap 5 → exactly 5; dollar cap; regenerate counts; audit"
    requirement: AICHAT-07
    verification:
      - kind: integration
        ref: "usage.int.test.ts › daily caps stop organization-key use before any model call"
        status: pass
    human_judgment: false
  - id: D5
    description: "Admin AI chat policy (provider.manage, Zod, audit with changed keys, org isolation) and the member limit notice"
    requirement: AICHAT-07
    verification:
      - kind: integration
        ref: "usage.int.test.ts › the admin AI chat policy; GET /me/ai-usage/today"
        status: pass
      - kind: e2e
        ref: "e2e/tests/ai-chat-usage.spec.ts › an admin caps organization models at 1 a day (desktop + mobile)"
        status: pass
    human_judgment: true

duration: ~95min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 08: Metering, daily caps and the AI chat policy Summary

**Every AI chat answer now shows its tokens and, on organization keys, its cost, for example "100 in · 20 out · $0.0004 · Claude Sonnet 5.5 · METERED". Every outcome writes exactly one usage record, priced from a table that names its source for each row. Today's per-member counters are updated in the same transaction. Daily caps count each answer before any model call with one conditional upsert. At the cap the member sees the local reset time and is offered their own ChatGPT plan. Admins tune the whole policy in Settings › Models › AI chats.**

## Performance

- **Duration:** ~95 min (2026-10-06)
- **Tasks:** 2/2 (Task 1 tracer, Task 2)
- **Files:** 26 source/test files (8 created, 18 modified) plus 16 screenshots

## Prices (D-06, T-05-08-05)

| Row | In / cached / out (USD per MTok) | Source (read 2026-10-06) |
| --- | --- | --- |
| anthropic/claude-opus-5-5 | 4 / 0.20 / 20 | platform.claude.com pricing (matches the claude-api skill table) |
| anthropic/claude-sonnet-5-5 | 2 / 0.20 / 10 | same |
| anthropic/claude-haiku-4-5 | 1 / 0.10 / 5 | same (the cache-read rate is new; the 05-01 seed had none) |
| openai/gpt-5 | 1.25 / 0.125 / 10 | developers.openai.com/api/docs/pricing, standard tier |
| openai/gpt-5-mini | 0.25 / 0.025 / 2 | same |
| openai/gpt-4.1 | 2 / 0.50 / 8 | same |
| openrouter/anthropic/claude-sonnet-5-5 | 2 / 0.20 / 10 | openrouter.ai/api/v1/models (OpenRouter lists it as `anthropic/claude-sonnet-5.5`) |
| openrouter/openai/gpt-5 | 1.25 / 0.125 / 10 | same |

Every price the plan asked for was sourced, so none is missing. Any other model, such as an openai-compatible server, stores cost null and shows "—".

## Accomplishments

- **Records:** `recordUsage` writes the record, then adds its tokens and cost to `ai_usage_daily` in a single upsert in the same transaction. The row is keyed by member, the generation's UTC start day and backend class. A retried finalize adds nothing, and a rollback leaves neither the record nor the counter change. A stopped, interrupted or failed answer stores an estimate. Cached input is stored inside the input count and priced at the cache rate.
- **Caps (T-05-08-01):** `consumeGeneration` runs inside the send, new-chat and regenerate transactions, after the model resolve and the concurrency cap and before anything is inserted. It is one `insert … on conflict do update … setWhere (generations < cap [and cost < cap]) returning`. A refusal commits only `ai_chat.limit_reached` (`result: denied`, `{backendClass, limit}`) and answers 429 `daily_limit_reached` with `resetsAt` set to the next 00:00Z. No message or generation is written and no model request is made.
- **Routes:** `GET /me/ai-usage/today` returns only the caller's rows. `GET/PUT /ai-chat/policy` requires `provider.manage`, validates with Zod and audits `ai_chat.policy_updated {changed}` only when something changed. The upsert never touches `chatgpt_host_id`, and a change applies to the next send.
- **Web:**
  - The footer shows usage, model and who pays, with exact counts in its tooltip and "~" when the counts are estimated. On a phone it wraps between parts.
  - The composer shows a notice at the cap, for example "You've used today's 1 answer on organization models. Resets at 7:00 PM." It also offers "Use your ChatGPT plan" when a plan model is available. Close to the cap it shows "N of M answers left today on organization models".
  - Settings › Models › AI chats has four cards: Who pays, Daily limits, Answers and Models (plan allowlist chips, title model per backend). Every org-key field carries METERED. The page has one sticky Save.

## Task Commits

1. **Task 1 (tracer):** `f913c14` test (RED) · `69c85d2` feat (prices, daily counters, footer)
2. **Task 2:** `9b7676c` test (RED) · `54dbea0` feat(api) (caps, today, policy routes) · `33f4616` feat(web) (policy settings, limit notice)

## Verification

- **Unit:** `model-prices.test.ts` 9/9 pass and contracts 213/213 pass. `ai-format.test.ts` 8/8 pass in the web project.
- **Integration:** `usage.int.test.ts` 16/16 pass on ephemeral PostgreSQL + Redis with the in-process fake. All `ai-chat/*.int` tests pass (50/50), including stop, regenerate and the 05-02 suite.
- **E2E** (isolated harness only):
  - Task 1 (`--rebuild-web ai-chat-usage ai-chat.spec ai-chat-stop`): 15/15 pass.
  - Task 2 (`ai-chat-usage bots.spec`): 11/11 pass.
  - Final run (`--rebuild-web ai-chat bots.spec`, which covers every ai-chat-* spec plus bots and personal-bots on desktop and mobile): **51/51** pass, with no skips or flakes.
- **`pnpm verify`:** passed after each task and on the final code. Lint has 4 warnings, all pre-existing in `apps/local-runtime`. Typecheck passes. Tests: **159 files, 2185 tests, all pass**.
- **Acceptance greps:**
  - `source:` appears 10 times in `model-prices.ts`.
  - `export function formatUsage` is at `ai-format.ts:50`.
  - `consumeGeneration` is called at `service.ts:354` and `:421` and at `generations.ts:217`.
  - `setWhere` is at `limits.ts:69`.
  - `"/ai-chat/policy"` is registered for both GET and PUT in `model-gateway/routes.ts`.
- **Screenshots reviewed with Read:** `ai-chat-usage-footer-{1440,390}[-dark]`, `ai-chat-limit-notice-{1440,390}[-dark]`, `settings-ai-chat-policy-{1440,390}[-dark]` and `settings-ai-chat-policy-models-{1440,390}`. The review led to two changes:
  - The footer now wraps between parts at 390. It used to truncate.
  - The settings screenshots now start at "AI chats" after the save toast is gone, and the save bar keeps both buttons on one row at 390.
- **Safety:** screenshots overwritten by regression specs were reverted. No real provider call was made, no migration was added, and `pnpm db:migrate` was never run. The demo was not touched. The `.env` symlink was removed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fake Anthropic directives (`infra/fake-model/server.mjs`, not in files_modified)**
- The cached-input and "failed (fake 500)" cases need the fake to report `cache_read_input_tokens` and to fail with an HTTP status. `[[cache:N]]` and `[[http:NNN]]` were added and documented in the file header. Commit f913c14.

**2. [Plan format] Earlier specs' footer assertions follow the new order**
- The plan defines the footer as "1.2k in · 340 out · ~$0.004 · Claude Sonnet 5.5 · METERED", and a plan answer's footer must end with "ChatGPT plan". The anchored regexes in `ai-chat.spec`, `ai-chat-stop.spec`, `ai-chat-models.spec` and `ai-chat-plan-errors.spec` were moved to the new order. No assertion was weakened. Commit 69c85d2.

**3. [Data] Haiku 4.5 cache-read price added, and PRICE_TABLE_VERSION is `2026-10-06.2`**
- The official page lists $0.10 per MTok for Haiku 4.5 cache reads. The 05-01 case "a model without a cache price bills cached input at the input price" now tests `costMicrosOf` with an inline price row. The version gets a same-day suffix because the date alone would equal the 05-01 seed.

**4. [Test determinism] The e2e cap test uses a fresh member for each project (Morgan Reyes), not Sam**
- Sam already has org-key answers today earlier in the same run, so a cap of 1 would refuse his first send. The test sets the cap through the admin UI and restores 200 in `finally`, so later specs run at the default.

**5. [Scope] Small additions outside files_modified**
- `ai-chat-view.tsx` shows no toast on `daily_limit_reached` because the notice explains it.
- `regenerate-menu.tsx` refreshes today's usage after a regenerate.
- The composer shows an "answers left" line close to the cap, so members see their usage against the cap before they reach it (plan truth 4).
- The 429 `details` also carry `max`.

### Notes (no change made)
- **Failed answers:** a failed answer with no reported usage, such as the HTTP 500 case, stores an estimated input count priced at the input rate. The provider most likely billed nothing, so this deliberately overestimates.
- **Cache writes:** cache-write tokens are priced as plain input, because AI SDK 7 counts them in `inputTokens`. AI chats send no `cache_control`, so in practice there are none.

## Deferred Issues

- **OpenRouter catalog id (pre-existing, `packages/contracts/src/agent.ts:289`):** OpenRouter lists the model as `anthropic/claude-sonnet-5.5`, but the catalog uses `anthropic/claude-sonnet-5-5`. A real OpenRouter call with the catalog id would most likely fail. The price row is keyed by the catalog id and its source notes OpenRouter's slug.

## Windows Ledger

`gsd windows append --kind todo --phase 05 --file packages/contracts/src/agent.ts --line 289 --description "OpenRouter catalog id anthropic/claude-sonnet-5-5 is not OpenRouter's slug (anthropic/claude-sonnet-5.5); a real OpenRouter call would 404"`

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-05-08-01 to T-05-08-05 are each mitigated and covered by an integration test: 10 concurrent at cap 5; append-only plus both audits; own rows and org-B isolation; no text columns; every price row sourced.

## Next Phase Readiness

- 05-09 adds its report routes to `usage-routes.ts` (already registered) and renders below `AiChatPolicySettings` on Settings › Models. It can reuse `formatTokens`/`formatCostMicros` and `lib/ai-usage-queries.ts`.
- 05-10 reads `policy.titleModels` (keys `chatgpt_plan` and provider names, as set in the settings UI). Title usage goes through `recordUsage(kind: "title")`, which already adds to today's counters without counting an answer.

## Self-Check: PASSED

- Files exist: limits.ts, usage-routes.ts, usage.int.test.ts, ai-format.ts, ai-format.test.ts, ai-usage-queries.ts, ai-chat-policy-settings.tsx, ai-chat-usage.spec.ts.
- Commits found: f913c14, 69c85d2, 9b7676c, 54dbea0, 33f4616.
