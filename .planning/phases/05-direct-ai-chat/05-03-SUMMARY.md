---
phase: 05-direct-ai-chat
plan: 03
subsystem: web
tags: [ai-chat, streaming, websocket, react-query, playwright, chatgpt-plan, markdown]

requires:
  - phase: 05-direct-ai-chat
    plan: 02
    provides: AI chat routes, run loop with ai.delta offsets, fake /v1/responses with [[slow]] and [[plan:*]], test seed route
provides:
  - "Harness: e2e-isolated.sh points OCW_CHATGPT_API_BASE_URL, OCW_CHATGPT_AUTH_BASE_URL, OCW_AI_MOCK_BASE_URL and OCW_AI_SEARXNG_URL at the fake (:4291); OCW_AI_SEND_RATE_LIMIT_PER_MINUTE=600; the bots' SearXNG variable stays unset"
  - "Web: /chat/ai/new and /chat/ai/[chatId]; components/ai-chat/{ai-chat-view,ai-message-list,ai-message,ai-composer,generation-error,plan-usage-line}.tsx; New chat on /chat/ai"
  - "lib/ai-chat-queries.ts: useAiModels, useAiChat (subscribe first, buffer, snapshot, stitch, gap refetch, reconnect refetch, stall re-read), createAiChat, sendAiMessage, primeAiChat"
  - "lib/ai-chat-stream.ts: pure reducer (applyAiDelta, stitchAiSnapshot, durable replace, no final-to-streaming regression), unit-tested"
  - "e2e/support/ai-chat.ts: seedPlan, openNewAiChat, sendAi, lastAssistant, answerText, chatIdOf, persistedAnswer, waitForLonger"
  - "API fix: the AI chat snapshot reads its stream cursor before its rows"
affects: [05-04, 05-05, 05-06, 05-07, 05-08, 05-09, 05-10, 05-11, 05-12, 05-13]

actuals:
  tokens: 15536   # chars/4 over added lines of the realized diff, screenshots excluded
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "AI chat page state is a pure reducer fed by WS frames and snapshots; React only wires subscribe -> query -> effects"
    - "A send answered on /chat/ai/new is handed to the /chat/ai/<id> page (primeAiChat) so both turns show before the snapshot"
    - "Snapshots read the stream cursor FIRST so replaying events after it can only move the client forward"

key-files:
  created:
    - apps/web/app/(app)/chat/ai/new/page.tsx
    - apps/web/app/(app)/chat/ai/[chatId]/page.tsx
    - apps/web/components/ai-chat/ai-chat-view.tsx
    - apps/web/components/ai-chat/ai-message-list.tsx
    - apps/web/components/ai-chat/ai-message.tsx
    - apps/web/components/ai-chat/ai-composer.tsx
    - apps/web/components/ai-chat/generation-error.tsx
    - apps/web/components/ai-chat/plan-usage-line.tsx
    - apps/web/lib/ai-chat-queries.ts
    - apps/web/lib/ai-chat-stream.ts
    - apps/web/lib/ai-chat-stream.test.ts
    - e2e/support/ai-chat.ts
    - e2e/tests/ai-chat.spec.ts
  modified:
    - scripts/e2e-isolated.sh
    - apps/web/components/chat/views/ai-chats-view.tsx
    - apps/web/components/chat/sidebar-views.tsx
    - apps/api/src/modules/ai-chat/service.ts

key-decisions:
  - "The pure reducer lives in lib/ai-chat-stream.ts (unit-testable without React); ai-chat-queries.ts wires it"
  - "First subscription replays the chat's events from seq 0 (bounded by REPLAY_LIMIT, resync beyond); a cached snapshot's lastSeq is used as the cursor when present"
  - "Snapshot cursor read first (API) plus a client rule that the same generation never goes back from final to streaming"
  - "10 s stall re-read while an answer streams, as a safety net under the durable final message"

requirements-completed: [AICHAT-02, AICHAT-03, AICHAT-07]

duration: 60min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 03: Browser tracer Summary

**In the browser, a member opens New chat, sends a message on their own ChatGPT plan and watches the answer stream in over the realtime WebSocket. It ends with `GPT-6 Astra · ChatGPT plan · <in> in · <out> out` and shows the same after a reload. A reload or a 2 s offline mid-answer resumes to exactly the persisted text. A failed answer ends with a calm one-line card. Verified on the isolated harness at 1440 and 390, light and dark.**

## Performance

- **Duration:** ~60 min (2026-10-06, 11:25 to 12:25 local)
- **Tasks:** 2/2
- **Files:** 17 source files (13 created, 4 modified) plus 20 screenshots

## Accomplishments

- **Harness (P-08):** the isolated API uses the fake for the ChatGPT plan, SIWC, the mock backend and AI web search. The send rate limit is raised for specs. `bot-capabilities` still sees the bots' SearXNG option disabled.
- **Screen (D-08, P-09):** the layout follows the Work Zone language: borderless header (back on phones, New chat), a centered column of about 760 px, right-aligned user bubbles, and full-width answers through the shared `<Markdown variant="document" streaming>` with a caret. The quiet footer has copy plus model, backend and token counts (`~` when estimated). The sticky composer card has an auto-growing textarea (Enter sends, Shift+Enter adds a line) and a read-only model chip. "Using ChatGPT plan · Manage usage ↗" opens chatgpt.com/settings/usage in a new tab (P-11). A new chat centers "What can I help with?" and "Only you can see this chat" with the composer on desktop, and keeps the composer at the bottom on phones.
- **Data (P-06):** `useAiChat` subscribes to `conv:<id>` before the snapshot query is declared. Live deltas go through `applyAiDelta`; deltas past a hole are buffered and stitched onto `running.partialText` with `stitchAiSnapshot`. While a hole remains, the snapshot is refetched up to 3 times, 1.2 s apart. It is also refetched after a socket reconnect, and re-read if a streaming answer is silent for 10 s. `message.updated` always replaces the answer.
- **Failure:** `GenerationError` gives one plain line per `AiErrorCode` ("This answer failed — ChatGPT is temporarily unavailable"). Partial text stays above it, and no spinner remains.

## Task Commits

1. **Task 1 (tracer):** `086e3b1` test (RED: harness + spec + support), `b273297` feat (pages, components, queries, reducer + unit tests)
2. **Task 2:** `9ac1f53` test (reload/offline/failed specs), `e6221c6` fix(api) (snapshot cursor first), `3c40909` feat (GenerationError, stitching hardening, screenshots)

## Verification

- **Plan e2e** (`--rebuild-web ai-chat.spec chat.spec dms team-bot-dm bot-capabilities`, final code): 19/19 passed on desktop and mobile, with no skips or flakes. That covers ai-chat 3×2 plus the chat, dms, team-bot-dm and bot-capabilities regressions.
- **Stability:** `ai-chat.spec --repeat-each 5` after the fix gave 30/30 passed. The failed-card test took a steady ~1.2 s; before the fix it took 11.6 s in 1 of 6 runs.
- **Unit:** `apps/web/lib/ai-chat-stream.test.ts` has 13 tests. They cover ordered and overlapping deltas, stitching before the snapshot, a gap repaired by a refetch, never stepping back, newer durable frames over an older snapshot, replay dedupe, the primed send, and other conversations. A mutation probe makes the no-regression case fail when the rule is removed.
- **API integration:** `ai-chat.int.test.ts` passes 20/20 after the snapshot change.
- **`pnpm verify`:** lint passes (4 warnings, all pre-existing in `apps/local-runtime`), typecheck passes, and tests show **2025 passed, 1 failed of 2026 (147 files)**. The one failure is `artifact/attachments.int.test.ts › Garage memory under load`, which uploads 5×25 MiB three times and gets a 500. It failed again on retry. The Docker VM disk is at **100% (296 MB free)**, and an earlier run hit `No space left on device` inside a testcontainers PostgreSQL. This plan does not touch artifact code. An earlier `pnpm verify` in this session passed everything except a disk-space failure in `dm.int.test.ts`, which passed on retry (16/16).
- **Acceptance greps:** `OCW_CHATGPT_API_BASE_URL` is at line 102 of the harness. `OCW_SEARXNG_URL=` count is 0. `applyAiDelta` and `stitchAiSnapshot` are in `ai-chat-queries.ts`. `export function GenerationError` exists.
- **Screenshots reviewed with Read:** `ai-chat-done-1440`, `ai-chat-done-1440-dark`, `ai-chat-done-390`, `ai-chat-done-390-dark`, `ai-chat-streaming-1440`, `ai-chat-streaming-390-dark`, `ai-chat-failed-390`, `ai-chat-failed-1440`, `ai-chat-failed-1440-dark`, `ai-chat-new-390`, `ai-chat-new-1440-dark`, `ai-chats-390`, `ai-chats-1440-dark`. One fix came from that review: the failure footer was 6 px off the card when there is no copy button.
- No real provider, ChatGPT or SearXNG call was made, and no migration ran. The demo was not touched. All e2e ran only through `scripts/e2e-isolated.sh`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Snapshot read across a finalize left the answer "writing" forever**
- **Found during:** Task 2. The failed-card e2e was stuck on `streaming`; it reproduced in 1 of 6 runs with instrumentation.
- **Issue:** `GET /ai-chats/:id` read its rows before `lastSeq` (READ COMMITTED). A generation finalized between the reads came back `streaming` under a cursor that already covered its final `message.updated`, so the client dropped that frame as already seen.
- **Fix:** the API reads the cursor first. The web reducer never moves the same generation from final back to streaming, and a 10 s stall re-read acts as a safety net.
- **Files:** `apps/api/src/modules/ai-chat/service.ts` (outside `files_modified`), `apps/web/lib/ai-chat-stream.ts`, `apps/web/lib/ai-chat-queries.ts`
- **Commits:** e6221c6, 3c40909

**2. [Rule 1 - Bug] Subscribe-first order**
- The snapshot query was first declared before `useTopic`, so its effect ran first. It now follows the subscription, and `resync` reaches it through a ref. Commit 3c40909.

**3. [Scope] The pure reducer is in `apps/web/lib/ai-chat-stream.ts` with a unit test (not in `files_modified`)**
- `ai-chat-queries.ts` wires it and documents the `applyAiDelta`/`stitchAiSnapshot` flow. Stitching landed with Task 1 because the reducer was built whole. In Task 2's RED run, the reload/offline test therefore already passed and only the failed-card test failed.

**4. [UX] `sidebar-views.tsx`: AI Chats stays selected on `/chat/ai/new` and `/chat/ai/<id>`**
- This changes only the `ai` view. Commit b273297.

**5. [Test] `openNewAiChat` waits for the model chip**
- A send before the models load is a deliberate no-op: the text is kept and the send button stays disabled.

**Plan mode note:** the API fix is a read-order change in the AI chat module. It is not a permission, policy, audit or tenant-isolation change.

## Known Stubs

- The model chip is read-only. Owner: 05-04 (picker).
- `/chat/ai` does not list the member's AI chats yet (only "New chat" plus the bot DMs). Owner: a later Phase 5 plan (titles/list/search).
- `GenerationError` gives one line per code with no actions. Owner: 05-07.

## Windows Ledger

The stubs are planned work with named owners, and there are no skipped tests or open deviations. One entry is recorded for the orchestrator to append: the load test that could not pass here because the Docker VM disk is full (an environment problem, not a defect of this plan).

`gsd windows append --kind unrun-verify --phase 05 --file apps/api/src/modules/artifact/attachments.int.test.ts --description "Garage memory load test (5x25 MiB x3) failed with 500 during 05-03 pnpm verify while the Docker VM disk was 100% full; rerun after pruning Docker"`

## Threat Flags

None beyond the plan's threat model:
- T-05-03-01: answers go through the shared `<Markdown>` (no new renderer).
- T-05-03-02: covered by the offset reducer, stitching, durable replacement and the exact-text e2e against the API.
- T-05-03-03: the harness exports only 127.0.0.1:4291 fakes.

## Issues Encountered

- The Docker Desktop VM disk is full (148.9 of 157.2 GB used). This plan did not prune anything, because pruning is destructive and shared with other projects. The owner should run `docker builder prune` / `docker volume prune` (about 44 GB reclaimable) before the next full `pnpm verify`.
- `context.setOffline` in Chromium may not close an open WebSocket. The offline test checks only the end result: the text exactly equals the persisted body.

## Self-Check: PASSED

- Files exist: every path in `key-files`.
- Commits found: 086e3b1, b273297, 9ac1f53, e6221c6, 3c40909.
