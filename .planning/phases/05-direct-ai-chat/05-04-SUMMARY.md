---
phase: 05-direct-ai-chat
plan: 04
subsystem: api, web
tags: [secrets, secret-reference, model-gateway, ai-sdk, org-keys, metered, model-picker, playwright]

requires:
  - phase: 05-direct-ai-chat
    plan: 01
    provides: model_providers.secret_ref + the provider_secret_refs backfill, ModelRef / AiModelOption contracts
  - phase: 05-direct-ai-chat
    plan: 02
    provides: model gateway (plan backend), run loop, usage records, startAiStack / seedPlan / subscribeConv
  - phase: 05-direct-ai-chat
    plan: 03
    provides: AI chat screen, composer, e2e support helpers
provides:
  - "SecretsService.resolve(tx, ref): the single entry point for env | file | db SecretReferences (foreign-org db refs refused)"
  - "Provider upsert writes secret_ref (secret_id mirrored for the documented rollback); usable / hasKey / cellProviders read secret_ref only"
  - "model-gateway/registry.ts: orgLanguageModel, mockLanguageModel, orgModelCaps, anthropicBase"
  - "Gateway org_key + mock backends in resolve/listModels: groups organization (METERED) and mock; same allowed list as bots; policy orgKeysEnabled for chats only"
  - "Web: ModelPicker / ModelPickerList / MeteredBadge, lib/ai-chat-model-store.ts (useAiChatModel, setAiChatModel, clearAiChatModel), live models refetch on model_providers.updated"
  - "Settings › Models: METERED badge + billing sentence on API-key cards, allowed-models help, subscription card 'bots only' copy"
affects: [05-05, 05-06, 05-07, 05-08, 05-11, 05-12]

actuals:
  tokens: 23100   # chars/4 over added lines of the realized diff, screenshots excluded (92,373 chars)
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Provider keys are read only through core.secrets.resolve(tx, row.secretRef); a MissingSecretError becomes no_key (chats) or leaves the provider out of the cell"
    - "Org-key availability calls allowedModels(core, tx), the very rule bots are checked against"
    - "Pure ModelPickerList (no hooks) so the web project tests groups, badges and onChange from static markup and the element tree"

key-files:
  created:
    - apps/api/src/modules/model-gateway/registry.ts
    - apps/api/src/modules/model-gateway/registry.test.ts
    - apps/api/src/modules/model-gateway/org-models.int.test.ts
    - apps/api/src/modules/agent/providers-secret-ref.int.test.ts
    - apps/web/components/ai-chat/model-picker.tsx
    - apps/web/components/ai-chat/model-picker.test.tsx
    - apps/web/lib/ai-chat-model-store.ts
    - e2e/tests/ai-chat-models.spec.ts
  modified:
    - apps/api/src/modules/secrets/index.ts
    - apps/api/src/app.ts
    - apps/api/src/modules/agent/index.ts
    - apps/api/src/modules/agent/service.ts
    - apps/api/src/modules/model-gateway/index.ts
    - apps/api/src/modules/ai-chat/ai-chat.int.test.ts
    - apps/web/components/ai-chat/ai-composer.tsx
    - apps/web/components/ai-chat/ai-chat-view.tsx
    - apps/web/lib/ai-chat-queries.ts
    - apps/web/components/bots/models-settings.tsx
    - apps/web/components/bots/provider-bits.tsx
    - apps/web/components/bots/subscription-card.tsx

key-decisions:
  - "A disabled provider row is not_allowed, a row without secret_ref (or an openai-compatible row without base URL) is no_key; an unresolvable reference is no_key at send time"
  - "listModels shows every allowed model of every ENABLED API-key provider; the default is preference → first available plan model → org Claude Sonnet 5.5 → first available row (the mock in e2e when no plan is connected)"
  - "Org keys get maxRetries 2; the mock and the plan keep 0"
  - "The model selection is per chat in a zustand store; on reload the chat's lastModel is the default; /chat/ai/new forgets its pick once the chat exists"
  - "secret_id stays mirrored on upsert and is removed with the provider; nothing reads it for resolution"

requirements-completed: [AICHAT-01, AICHAT-02]

coverage:
  - id: D1
    description: "Org provider keys live behind SecretReferences and reach AI chats and the cell only through secrets.resolve"
    requirement: AICHAT-01
    verification:
      - kind: integration
        ref: "apps/api/src/modules/model-gateway/org-models.int.test.ts, apps/api/src/modules/agent/providers-secret-ref.int.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "One allowed list governs AI chats and bots; orgKeysEnabled=false affects chats only; no personal key route; no key leak"
    requirement: AICHAT-01
    verification:
      - kind: integration
        ref: "apps/api/src/modules/agent/providers-secret-ref.int.test.ts"
        status: pass
      - kind: e2e
        ref: "e2e/tests/ai-chat-models.spec.ts › Settings › Models labels org keys METERED…"
        status: pass
    human_judgment: false
  - id: D3
    description: "Grouped picker with METERED labels; per-message switching across plan, org key and mock with history preserved"
    requirement: AICHAT-02
    verification:
      - kind: unit
        ref: "apps/web/components/ai-chat/model-picker.test.tsx, apps/api/src/modules/model-gateway/registry.test.ts"
        status: pass
      - kind: e2e
        ref: "e2e/tests/ai-chat-models.spec.ts (desktop + mobile)"
        status: pass
    human_judgment: true

duration: ~60min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 04: Org keys, METERED model picker and per-message model switching Summary

**An admin's provider key is now stored and read as a SecretReference end to end, and `secrets.resolve` is the only reader for AI chats and the OpenClaw cell. A member picks "Claude Sonnet 5.5 · METERED" in a grouped picker, and the answer streams from the fake Anthropic endpoint through the 05-02 run loop. One allowed-models list governs chats and bots, and models switch per message across the plan, org-key and mock backends.**

## Performance

- **Duration:** about 60 min (2026-10-06)
- **Tasks:** 3/3
- **Files:** 20 source/test files (8 created, 12 modified), plus 16 screenshots

## Accomplishments

- **Secrets (P-10, D-07):** `SecretsService.resolve(tx, ref)` handles three kinds of reference:
  - `env`/`file` go through the operator `SecretStore`, now wired into the service in `app.ts`.
  - `db` goes through `reveal` inside the tenant transaction, and only when `ref.organizationId` is the transaction's own organization. Everything else is a `MissingSecretError` with no detail.
- **Providers:**
  - Upsert writes `secret_ref = {db, secretId, organizationId}` and mirrors `secret_id`.
  - Replacing a key or deleting a provider removes the old sealed row whichever column pointed at it.
  - `usable()`, `hasKey` and `cellProviders` read `secret_ref` only.
  - A dangling reference drops the provider from the cell with a `{provider, ref kind}` warning; the value is never logged.
- **Gateway (P-04):**
  - `registry.ts` builds the provider instance per kind:
    - Anthropic adds `/v1` to the base URL.
    - OpenAI uses the Responses API with `store:false`.
    - OpenRouter and OpenAI-compatible use chat completions with `includeUsage`.
    - The mock model runs on the fake.
  - `resolve` handles `org_key`: it checks the policy, then the provider row, then `allowedModels()` (the bots' rule), then `secrets.resolve`. It returns `metered: true`, catalog labels and `maxRetries: 2`.
  - `mock` exists only with `OCW_MODEL_PROVIDER=mock`.
  - `openai-codex` is never an AI chat model.
- **Web (P-09, P-11):**
  - `ModelPicker` is the Work Zone control surface: a popover on desktop and a bottom sheet at 390. It has three groups: "Your ChatGPT plan", "Organization models" (sub-label "METERED · billed to your organization") and "Testing". Unavailable rows stay disabled and give the reason in plain words.
  - The composer chip shows METERED for org models, and the plan usage line appears only for plan models.
  - The model selection is kept per chat. The models query refetches live on `model_providers.updated`.
- **Settings › Models:**
  - Every API-key provider card has a METERED badge and the line "Every AI chat and bot turn on this key is billed to your organization".
  - The allowed-models help says the models are available to AI chats and bots.
  - The ChatGPT subscription card says it is used by bots only.
  - Every existing control and test id is unchanged.

## Task Commits

1. **Task 1 (tracer):** `93da0c0` test (RED), `d916725` feat
2. **Task 2:** `b3a39ef` test, `313ac7a` feat (Settings copy + e2e)
3. **Task 3:** `ea71e34` test, `4714cdf` screenshots
4. **Regression fix:** `b481c64` test (05-02 assertions scoped to the plan group)

## Verification

- **Unit (`registry.test.ts`):** 12/12. **Web (`model-picker.test.tsx`):** 5/5.
- **RED:** recorded before the feat commit. `org-models.int` had 8 of 12 failing, and the unit and web files failed because their modules were missing.
- **Integration**, each run on its own ephemeral PostgreSQL + Redis:
  - `org-models.int`: 13/13
  - `providers-secret-ref.int`: 12/12
  - `agent-channel.int`: 23/23, unchanged
  - `ai-chat.int`: 20/20, after the assertion fix
- **Mutation probe:** making `cellProviders` prefer `secret_id` fails exactly "secret_id → A while secret_ref → B" (1/12), and it was reverted.
- **Isolated e2e** (`scripts/e2e-isolated.sh`, all three runs with `--rebuild-web`; no skips or flakes):
  - Task 1: ai-chat-models, ai-chat.spec, bots.spec and personal-bots: 17/17 on desktop and mobile.
  - Task 2: ai-chat-models, bots.spec and personal-bots: 13/13.
  - Task 3: ai-chat-models (4 tests) and ai-chat.spec: 15/15.
  - The final web code was built for the Task 2 run, so the bot regressions cover it. Task 3 changed only tests.
- **`pnpm typecheck --force`:** 8/8. **`pnpm verify`:** lint has 4 warnings, all already present in `apps/local-runtime`. Typecheck passes, and tests show **151 files, 2068 passed**.
- **Screenshots reviewed with Read:**
  - `ai-model-picker-1440`, `ai-model-picker-390-dark`
  - `ai-chat-metered-1440-dark`, `ai-chat-metered-390`
  - `settings-models-metered-1440`, `settings-models-metered-390-dark`
  - `ai-chat-model-switch-1440`, `ai-chat-model-switch-390-dark`
  - The METERED badge is legible in dark mode, the sheet is usable at 390, rows are not truncated, and the footer does not wrap at 390.
- **Acceptance greps:**
  - `resolve(tx` is in `secrets/index.ts`.
  - `secrets.reveal(tx, p.secretId)` is gone from `service.ts`, and `secrets.resolve` is there.
  - `export function orgLanguageModel` exists.
  - METERED appears 1 or more times in `provider-bits` / `models-settings`.
  - `apiKey` appears in `providers-secret-ref.int`.
  - `chatgpt_plan/openai` and `org_key/anthropic` appear in `org-models.int`.
- **Safety:**
  - No real provider was called, no migration was added, and the default `.env` was used only through the harness (symlink removed).
  - The demo and other worktrees were not touched.
  - My test containers are gone; the ones still running belong to 05-05's suite.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `apps/api/src/app.ts` passes the operator `SecretStore` into `createSecretsService`**
- `env`/`file` references cannot resolve without it, and the store is created in `app.ts`.
- `store` is optional in the service's deps. Commit d916725.

**2. [Rule 3 - Blocking] `apps/web/components/ai-chat/ai-chat-view.tsx` is not in `files_modified`**
- The composer now takes `chatKey`, `models` and `preferred` instead of a resolved option.
- `pickModel` moved into `ai-composer.tsx`.
- New chat clears its pick after the first send. Commit d916725.

**3. [Rule 3 - Blocking] `apps/web/components/bots/subscription-card.tsx` gets one copy line**
- The card's header is the only place the "Used by bots only…" sentence shows when the subscription is not connected, which is the case in e2e. No control or test id changed. Commit 313ac7a.

**4. [Rule 1 - Regression] `apps/api/src/modules/ai-chat/ai-chat.int.test.ts`**
- Three 05-02 assertions assumed the model list held only plan rows.
- They now filter to the `chatgpt_plan` group.
- The "before seeding" case expects the mock row as the default, following the plan's `defaultRef` order (first available row). Commit b481c64.

**5. [Spec precision] `PUT /model-providers` does not exist; the upsert route is `POST`**
- The test asserts 403 for a standard member on `POST` and on `DELETE /model-providers/anthropic`.
- The OpenAPI scan finds exactly one request body with `apiKey`, at `POST /api/v1/model-providers`.

**6. [Spec precision] The OpenAPI scan matches `properties.apiKey` anywhere under an operation's `requestBody`, at any depth.**

**7. [Scope] Exports beyond the interfaces block (add-only):**
- `ModelPickerList`, `reasonText`, `MeteredBadge`, `pickModel`, `clearAiChatModel`
- `registry.ts`: an optional `fetch` option, plus `OrgProviderKind`
- `usable()` is now exported from `agent/service.ts` (not re-exported from the module index)

**8. [Rule 2 - Rigor] Extra assertions:**
- An org model outside the allowed list gets 409 `not_allowed`.
- An `org_key/openai-codex` ref is refused.
- A foreign key never appears in the cell snapshot.
- Two foreign-reference shapes are covered: one naming the other org, and one claiming our org id for another org's secret, which RLS hides.
- The conversation stream of an org-key chat is scanned for keys.
- The legacy bot also replies through the fake cell.

**Plan mode note:** this touches secrets resolution, a security path. The plan specified the exact interface and threat mitigations (T-05-04-01 to 03), so it was implemented as written. Every mitigation is covered by a test.

## Known Stubs

None that block this plan. Costs show as tokens only in the footer; cost formatting is owned by 05-08. The "Not connected" plan row is disabled with no action; 05-07 turns it into "Continue with ChatGPT".

## Windows Ledger

No entries: there are no stubs, skipped tests, unrun verifies or open deviations.

## Threat Flags

None beyond the plan's threat model.
- **T-05-04-01:** the key never appears in responses, WS frames, audit rows or logs. Keys are write-only, with `hasKey` and a 4-character hint.
- **T-05-04-02:** `resolve` refuses foreign-org references and reads under RLS.
- **T-05-04-03:** there is no personal key route; a standard member gets 403 and the OpenAPI scan passes.
- **T-05-04-04:** the allowed list is checked on every resolve, for chats and bots.
- **T-05-04-05:** METERED is shown on every org row, the chip, the footer and the provider card.

## Issues Encountered / Open

- **Rows written before this plan:** provider rows upserted after the 05-01 migration by 05-01..05-03 code have `secret_ref = NULL`. Under this plan's reference-only code they read as "no key" (bots lose that provider, chats get `no_key`). This only matters for a database migrated by an earlier Phase 5 build. Fix: rerun the idempotent backfill statement in `packages/db/drizzle/*_provider_secret_refs/migration.sql`. A fresh migration with this code has no gap.
- **Bot model pickers:** the bot form's model select (bots UI, not in this plan's files) still lists org-key models without a METERED badge. Settings › Models states the billing for bots. This could be a small follow-up if the owner wants the label in that picker too.

## Self-Check: PASSED

- Files exist: every path in `key-files`.
- Commits found: 93da0c0, d916725, b3a39ef, 313ac7a, ea71e34, 4714cdf, b481c64.
