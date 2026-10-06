---
phase: 05-direct-ai-chat
plan: 06
subsystem: api, web
tags: [ai-chat, streaming, redis, pubsub, sweeper, security-definer, regenerate, message-versions, playwright]

requires:
  - phase: 05-direct-ai-chat
    plan: 02
    provides: run loop (RunLoop.abort/shutdown/instanceId, heartbeat, partial flush, one finalize), sends with the 409 gate and 429 cap, testing-ai harness (startSecondInstance, subscribeConv, seedPlan)
  - phase: 05-direct-ai-chat
    plan: 03
    provides: AI chat screen, composer, pure stream reducer, snapshot cursor-first, e2e helpers
  - phase: 05-direct-ai-chat
    plan: 04
    provides: ModelPickerList groups with METERED, mock backend, org keys
provides:
  - "POST /api/v1/ai-chats/:id/generations/:gid/stop → 202 {status} (owner only, hidden 404, idempotent, audited once)"
  - "ABORT_CHANNEL = ocw:ai:abort (ids only) and registerGenerationRoutes (every instance aborts what it holds)"
  - "POST /api/v1/ai-chats/:id/regenerate → 201 SendAiMessageResponse (409 not_last_answer | nothing_to_regenerate | generation_in_progress | model_unavailable, 429 cap)"
  - "app.stale_ai_generations(p_limit, p_before) SECURITY DEFINER, ids only, EXECUTE to ocw_app only"
  - "createGenerationSweeper (15 s, advisory lock, per-org withTenant) and RunLoop.finalizeStale"
  - "Audits ai_generation.stopped {conversationId, generationId} and ai_chat.regenerated {conversationId, messageId, generationId, backend, provider, modelId, attempt}"
  - "Contracts: AiGenerationParams, StopAiGenerationResponse, RegenerateRequest.messageId"
  - "Web: Stop in the composer (Esc), Stopped/Interrupted label, RegenerateMenu, stopGeneration/regenerate in ai-chat-queries"
affects: [05-07, 05-08, 05-10, 05-11, 05-12, 05-15]

actuals:
  tokens: 20930   # chars/4 over added lines of the realized diff, screenshots excluded (83,719 chars)
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Abort fan-out: authorize + audit in the route transaction, publish {organizationId, generationId} after commit, every instance aborts only what its run loop holds"
    - "An abort flushes the unsent delta tail and freezes the text, so what the browser saw equals the persisted body"
    - "Sweeper = SECURITY DEFINER ids-only candidates + per-org withTenant re-check under for update + the run loop's single finalize"
    - "Regenerate keeps history append-only: message_versions(kind regenerate) in the same transaction that resets the message"

key-files:
  created:
    - apps/api/src/modules/ai-chat/generations.ts
    - apps/api/src/modules/ai-chat/sweeper.ts
    - apps/api/src/modules/ai-chat/stop.int.test.ts
    - apps/api/src/modules/ai-chat/regenerate.int.test.ts
    - apps/web/components/ai-chat/regenerate-menu.tsx
    - e2e/tests/ai-chat-stop.spec.ts
  modified:
    - packages/contracts/src/ai-chat.ts
    - packages/db/sql/post-migrate.sql
    - apps/api/src/modules/ai-chat/run-loop.ts
    - apps/api/src/modules/ai-chat/service.ts
    - apps/api/src/modules/ai-chat/index.ts
    - apps/web/components/ai-chat/ai-composer.tsx
    - apps/web/components/ai-chat/ai-message.tsx
    - apps/web/components/ai-chat/ai-message-list.tsx
    - apps/web/components/ai-chat/ai-chat-view.tsx
    - apps/web/lib/ai-chat-queries.ts
    - apps/web/lib/ai-chat-stream.ts
    - apps/web/lib/ai-chat-stream.test.ts

key-decisions:
  - "Stop answers 202 with the generation's current status (running until the abort lands, then its final status); a finished generation is not audited again"
  - "The stop audit is deduplicated per generation with a Redis NX key (10 min), so a double press before the abort lands writes one row"
  - "Aborted streams record provider usage from finished steps when present, otherwise estimated (input from the rebuilt prompt, output ceil(chars/4))"
  - "The sweeper never touches a generation its own process still streams and finalizes through RunLoop.finalizeStale (same finalize as the run loop)"
  - "Regenerate without a model reuses the previous generation's model; RegenerateRequest.messageId lets the API refuse a stale tab with 409 not_last_answer"
  - "The Stopped/Interrupted label sits on its own line under the answer: inline in the footer it truncated the token counts at 390"

requirements-completed: [AICHAT-03, AICHAT-02]

coverage:
  - id: D1
    description: "Stop from any API instance keeps exactly the streamed text, marked Stopped, with estimated usage and one audit"
    requirement: AICHAT-03
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/stop.int.test.ts › Stop crosses API instances…"
        status: pass
      - kind: e2e
        ref: "e2e/tests/ai-chat-stop.spec.ts › Stop keeps the text… (desktop + mobile)"
        status: pass
    human_judgment: false
  - id: D2
    description: "One generation per chat (409, Stop instead of Send); per-user cap 429 then accepted"
    requirement: AICHAT-03
    verification:
      - kind: integration
        ref: "stop.int.test.ts (409 while running, fourth answer 429)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Crash and shutdown never leave an answer spinning: sweeper and close() finalize interrupted with the partial text"
    requirement: AICHAT-03
    verification:
      - kind: integration
        ref: "stop.int.test.ts › crashed and closing instances…"
        status: pass
    human_judgment: false
  - id: D4
    description: "Reload mid-stream resumes to the persisted text"
    requirement: AICHAT-03
    verification:
      - kind: e2e
        ref: "ai-chat-stop.spec.ts › a reload mid-answer… (desktop + mobile)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Regenerate the last answer, also with another model, keeping the replaced answer in message_versions"
    requirement: AICHAT-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/regenerate.int.test.ts"
        status: pass
      - kind: e2e
        ref: "ai-chat-stop.spec.ts › the last answer regenerates… (desktop + mobile)"
        status: pass
    human_judgment: true

duration: ~45min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 06: Stop, crash recovery, reload-resume and regenerate Summary

**A member can now press Stop while an answer is being written, and the stop works from any API instance. The route authorizes and audits, then publishes `{organizationId, generationId}` on `ocw:ai:abort`. The instance that holds the stream aborts it, sends the last unsent text, freezes it and finalizes the answer as `stopped`. The browser keeps exactly the text it saw, marked "Stopped", and Send comes back. Answers whose process died are finalized `interrupted` within about a minute. Answers on an instance that is closing are finalized `interrupted` at once. Either way the partial text is kept. A reload mid-answer picks up the same stream. The last answer can be regenerated on the same model or another one, and the old text is kept append-only in `message_versions`.**

## Performance

- **Duration:** ~45 min (2026-10-06)
- **Tasks:** 3/3
- **Files:** 18 source/test files (6 created, 12 modified) plus 16 screenshots

## Accomplishments

- **Stop (D-05, P-07):**
  - The route `POST /ai-chats/:id/generations/:gid/stop` checks access first: the caller must be able to read the chat and hold `ai_chat.use`, otherwise it answers 404. The generation must also belong to that chat.
  - It audits `ai_generation.stopped` once and publishes the ids after commit.
  - Every instance subscribes to `ocw:ai:abort`. The listener parses the message defensively (exactly two UUIDs) and calls `runLoop.abort(gid, "stop")`.
  - In the run loop, an abort first sends the unsent tail as `ai.delta`, then freezes the text. Later provider deltas are dropped, so no delta ever follows the final `message.updated`.
  - Usage comes from the steps that finished, when there are any. Otherwise it is estimated.
- **One generation per chat (UI):** while an answer streams, Send becomes Stop (`ai-stop`, Esc also stops). The textarea keeps taking text, and Enter does nothing.
- **Crash and shutdown:**
  - `app.stale_ai_generations` is SECURITY DEFINER, pins `search_path`, returns ids only, has EXECUTE revoked from PUBLIC and granted to `ocw_app`.
  - `createGenerationSweeper` takes an advisory lock, picks rows whose heartbeat is more than 60 s old, and skips any generation this process still streams.
  - `RunLoop.finalizeStale` re-checks each row under `for update` in that organization's own transaction, then runs the one finalize: partial text becomes the body, the message is `completed`, the generation `interrupted`, usage is recorded as estimated, and `message.updated` plus `ai_chat.updated` are emitted.
  - Module `close()` unsubscribes, stops the sweeper and shuts the run loop down. `closeWithGrace` calls it on SIGTERM.
- **Regenerate (AICHAT-02/03):**
  - All of this happens in one transaction: the stream lock, the running gate, and a row lock on the last top-level message.
  - The model is the one requested, or else the previous generation's, resolved through the gateway. The per-user cap applies.
  - The old body goes into `message_versions` (kind `regenerate`, version N+1, edited by the member). The message is reset to an empty stream and attempt N+1 starts.
  - The transaction also emits `message.updated` and `ai_chat.updated`, updates `last_model`, and audits without the body.
  - The prompt ends at the last user turn.
- **Web:**
  - `RegenerateMenu` appears on the last answer only, as a popover on desktop and a bottom sheet at 390. "Regenerate" shows the same model's name. "Regenerate with…" shows the grouped model list, METERED badges included.
  - The reducer restarts an answer when a newer attempt arrives, and never steps back.
  - "Stopped" or "Interrupted" appears as a quiet pill under the answer.

## Task Commits

1. **Task 1 (tracer):** `46609c1` test (RED), `0ffb099` feat
2. **Task 2:** `80f61ad` test (RED), `3d434be` feat
3. **Task 3:** `2df493b` test (RED), `661cb7d` feat

## Verification

- **Integration** (ephemeral PostgreSQL + Redis, in-process fake):
  - `stop.int.test.ts`: 8/8. Two API instances throughout, plus a third that is closed mid-answer.
  - `regenerate.int.test.ts`: 6/6.
  - RED was recorded for each task before its feat commit: Task 1 failed on the missing module, Task 2 had 5 of 8 failing, Task 3 had 5 of 6 failing.
- **Unit:** `ai-chat-stream.test.ts` 15/15 (2 new regenerate cases; the POST-reset case was RED first).
- **Isolated e2e** (`scripts/e2e-isolated.sh`, always with `--rebuild-web`):
  - Task 1: `ai-chat-stop ai-chat.spec` 9/9.
  - Task 2: `ai-chat-stop` 5/5.
  - Final: `ai-chat-stop ai-chat-models ai-chat.spec` **21/21** on desktop and mobile. No skips or flakes. ai-chat.spec and ai-chat-models are unchanged regressions.
- **`pnpm typecheck --force`:** run after the contract change. **`pnpm verify`:** exit 0, with **155 files and 2120 tests passed** (05-05 baseline: 149/2062). Lint shows 4 warnings, all pre-existing in `apps/local-runtime`.
- **Acceptance greps:** all pass:
  - `"ocw:ai:abort"` and `generations/:gid/stop` appear in `generations.ts`.
  - `stale_ai_generations` appears 3 times in `post-migrate.sql`.
  - `export function createGenerationSweeper` and `kind: "regenerate"` are present.
  - `export function RegenerateMenu` is present.
- **Screenshots reviewed with Read:**
  - `ai-chat-stopped-1440`, `ai-chat-stopped-390-dark`, `ai-chat-stop-button-390`
  - `ai-chat-regenerate-menu-390`, `ai-chat-regenerate-menu-1440-dark`
  - `ai-chat-regenerate-with-390`
  - Result: a stopped answer reads as cut short on purpose (a neutral pill, not an error). The regenerate sheet sits at thumb height at 390.
  - The review led to one fix: at 390, the inline "Stopped" pill truncated the token counts, so it moved under the answer.
  - Regression screenshots regenerated by other specs were reverted and not committed.
- **Safety:**
  - No migration was added (only a `post-migrate.sql` function), and `pnpm db:migrate` was never run.
  - No real provider was called. The demo, other worktrees and branches were not touched.
  - `.env` was symlinked only for the isolated e2e runs and has been removed. The test containers were removed by ryuk.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Contract] `RegenerateRequest.messageId` (optional) plus two new contracts**
- The request had no message id, so the API could not answer `not_last_answer` (an older answer, or a stale tab).
- Added `messageId?`, `AiGenerationParams` (`{id, gid}`) and `StopAiGenerationResponse` (`{status}`). Commit 0ffb099.

**2. [Rule 2 - Correctness] An abort flushes and freezes the text**
- Without this, deltas buffered when the controller fired could reach the client after it had already seen the final message, or be missing from what it showed.
- Now what the browser saw equals the persisted body, and the test asserts it. Commit 0ffb099.

**3. [Rule 2 - Audit] One `ai_generation.stopped` per generation**
- A Redis NX key (10 min) dedupes a double Stop that lands before the abort finishes. Commit 0ffb099.

**4. [Scope] `RunLoop.finalizeStale` (add-only)**
- The sweeper reuses the run loop's single finalize, refactored into `finalizeIn(tx, …)`, instead of duplicating the body, usage and event logic. Commit 3d434be.

**5. [Scope] Files outside `files_modified`**
- `packages/contracts/src/ai-chat.ts`
- `apps/web/components/ai-chat/{ai-chat-view,ai-message-list}.tsx`
- `apps/web/lib/ai-chat-stream.ts` and its test
- `service.ts` now exports `resolveModelOr409` and `capOr429`, so regenerate shares the 409/503 and 429 rules with sends.
- Regenerate has its own per-user rate limit, at the send limit's value.

**6. [Spec precision] Mock label**
- The gateway labels the mock "Mock (E2E)" (since 05-04), so the e2e asserts `Mock (E2E) · not metered`, not "Mock model (E2E)". No label was changed.

**7. [Design] `RegenerateMenu` reuses `ModelPickerList` inside its own surface**
- It does not use `ModelPicker trigger="menu-item"`, which would nest two popovers or sheets.
- The query helper is `regenerate(chatId, { messageId, model? })` rather than `regenerate(chatId, model?)`.
- Copy already existed (05-03) and stays next to Regenerate.

**8. [Test] Shutdown test**
- It closes a third instance that holds the answer and checks the result through A. A is the test stack and cannot be closed in the middle of the file.

**9. [Process] `pnpm verify`**
- It ran once, at the end, on the final tree (exit 0), not after each task. This was a choice to spare the memory-constrained machine three full suites; it did not fail per task.
- Each task's own integration and e2e commands ran green before its feat commit.

**Plan mode note:** the plan delegated approval for its permission, audit and tenant-isolation pieces: the SECURITY DEFINER lookup and per-org re-checks, the hidden-404 routes, and the new audits. They were implemented as specified, and each is covered by a test (T-05-06-01/03/04/05/06).

## Known Stubs

None.

## Windows Ledger

No entries: no stubs, skipped tests, unrun verifies or open deviations. No `gsd windows append` command is needed.

## Threat Flags

None beyond the plan's threat model:
- **T-05-06-01:** Alex and the admin get 404 on stop and regenerate. A generation id from another chat gets 404.
- **T-05-06-02:** the abort hint carries ids only, is parsed defensively, and its shape is asserted.
- **T-05-06-03:** `message_versions` is written in the same transaction as the reset, and `ai_chat.regenerated` is audited.
- **T-05-06-04:** covered by the sweeper and shutdown tests.
- **T-05-06-05:** ids-only lookup plus a per-org `withTenant` re-check; the test asserts no PUBLIC execute.
- **T-05-06-06:** the 429 cap test.

## Issues Encountered / Open

- **Stop needs a live holder.** A Stop whose holder instance is already dead only publishes the hint. That answer is then finalized `interrupted` by the sweeper after its heartbeat goes stale (≤ about 75 s), not `stopped` at once. Closing an instance cleanly finalizes immediately.
- **Expected parallel-merge conflicts with 05-07:**
  - `packages/contracts/src/ai-chat.ts`: additions after `RegenerateRequest`.
  - `apps/web/components/ai-chat/ai-message.tsx`: footer and `GenerationError` area.

## Self-Check: PASSED

- Files exist: every path in `key-files`.
- Commits found: 46609c1, 0ffb099, 80f61ad, 3d434be, 2df493b, 661cb7d.
