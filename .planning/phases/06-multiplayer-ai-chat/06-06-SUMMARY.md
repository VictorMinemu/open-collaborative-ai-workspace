---
phase: 06-multiplayer-ai-chat
plan: 06
subsystem: api (ai-chat queue, sweeper), db (post-migrate)
status: complete
tags: [multiplayer-ai, queue, addressing, requester-pays, sweeper, tracer]
requires: [06-01 contracts (AI_QUEUE_MAX, AiQueueState, AiAddressing, AiPostedMessageResponse, ai_message_context), 06-02 grants/resolver/context rows, Phase 5 run loop, finalize hook, caps and sweeper]
provides:
  - "queue.ts: addressedOf, isMultiplayer, queueState, publishQueue, startNext, startNextAlone, registerQueue, pendingCount"
  - "POST /ai-chats/:id/messages in shared chats: 201 started / 202 queued|not_addressed|skipped / 429 ai_queue_full; never 409"
  - "POST /ai-chats/:id/regenerate in a shared chat with pending messages: 409 queue_pending"
  - "Message.aiAddressing (shared chats) and AiChatSnapshot.queue; durable ai.queue.updated on conv:<id>"
  - "app.pending_ai_queues(p_limit) SECURITY DEFINER, ids only; sweeper starts idle queues"
  - "Audit ai_generation.queued_started {conversationId, generationId, requesterUserId, messageIds}"
affects: [06-11 (queue chip, Ask AI toggle, requester-only Stop read these shapes)]
tech-stack:
  added: []
  patterns:
    - "Queue derived from ai_message_context (addressed, unanswered, unskipped), never a separate store"
    - "Next turn started inside the finalize transaction; run loop started after commit"
    - "Finalize hook only try-locks the requester's advisory lock and retries in a fresh transaction (no lock-order deadlock)"
key-files:
  created:
    - apps/api/src/modules/ai-chat/queue.ts
    - apps/api/src/modules/ai-chat/queue.int.test.ts
  modified:
    - apps/api/src/modules/ai-chat/service.ts
    - apps/api/src/modules/ai-chat/dto.ts
    - apps/api/src/modules/ai-chat/index.ts
    - apps/api/src/modules/ai-chat/routes.ts
    - apps/api/src/modules/ai-chat/limits.ts
    - apps/api/src/modules/ai-chat/generations.ts
    - apps/api/src/modules/ai-chat/sweeper.ts
    - packages/db/sql/post-migrate.sql
decisions:
  - "A coalesced turn answers every pending message and is billed to the first waiting author, on the model they sent with their earliest pending message (D-01)"
  - "An author whose model is refused or who is at the daily cap has ALL their pending messages skipped with the reason; the next author is tried in the same pass"
  - "First waiting author at the concurrency cap: nothing starts, order kept, the sweeper retries (≤ 15 s)"
  - "message.created carries the initial addressing (queued / not_addressed); skips add a message.updated with the reason; answering/answered are derived (DTOs) and visible through ai.queue.updated"
  - "Regenerate checks queue_pending before generation_in_progress, so it also applies while an answer runs"
  - "Archived chats never start a queued turn; pending_ai_queues skips archived chats and deleted messages"
metrics:
  duration: "~25 min"
  completed: 2026-10-07
actuals:
  tokens: 15500   # chars/4 over the added lines of the diff (62 219 chars)
  tasks: 2
  commits: 2
---

# Phase 6 Plan 06: One generation per shared AI chat (queue, coalescing, requester pays) Summary

Shared AI chats now take messages from everyone while exactly one answer runs. A message is answered only when it is addressed (`askAi`, or no mention in the text). A message addressed while an answer runs is queued with 202, never refused, and every participant sees it through `ai.queue.updated`. When the running answer ends (completed, stopped, failed or interrupted), the finalize transaction starts one coalesced turn for everything that waited, billed to the first waiting author on their own plan. Solo chats keep the Phase 5 409.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Addressing, visible queue, coalesced turn on the first waiting author's plan (tracer) | 400ea81 |
| 2 | Stop/crash/two-instance safety, sweeper pickup, regenerate waits for the queue | 777f6ab |

## What changed

- **queue.ts.** `startNext` takes the stream lock, returns null when something runs, then loops over pending authors. For each it resolves the first author's own model ref (refused → skip `reason`), checks the per-user concurrency cap (at cap → null, FIFO kept), then the daily cap (refused → `ai_chat.limit_reached` audit for that author + skip `daily_limit_reached`). Then it inserts the placeholder and the running generation, sets `answered_by_generation_id` on every pending row, audits `ai_generation.queued_started` and starts the run loop after commit. `registerQueue` is the `onAfterFinalize` listener (multiplayer chats only); it always publishes the new queue.
- **Sends (service.ts).** `isMultiplayer` = active grant or any member besides the owner. Shared chats branch after the archive check:
  - mentions come from `resolveMentions(body, loadDirectory)`, and the request's `mentions` field is ignored;
  - an addressed message checks files against the sender's own model when it resolves, and checks `AI_QUEUE_MAX` (429, nothing written);
  - the message and its context row (`answered_by` null) are written, `message.created` is appended, and then `startNext` runs;
  - the response is 201 `SendAiMessageResponse` when the started turn answers this message, else 202 `AiPostedMessageResponse`.
  - Retries of a shared send answer the same way. The solo path is unchanged; `prepareSend` only extracts the shared naming/participation code.
- **DTOs.** `addressingFor` derives the status of each message: not_addressed, queued, answering, answered or skipped (with reason and generation id). Snapshots and pages add `aiAddressing` and the snapshot `queue` only for shared chats.
- **Regenerate.** A shared chat with pending messages returns 409 `queue_pending`. Stop is unchanged: requester or owner, and the finalize hook continues the queue.
- **Sweeper + SQL.** `app.pending_ai_queues(p_limit)` returns `(organization_id, conversation_id)` of conversations that have pending human messages, no running generation and are not archived (STABLE SECURITY DEFINER, pinned search_path, PUBLIC revoked, EXECUTE to `ocw_app`). It is not a drizzle migration: it is applied by post-migrate and proven on fresh testcontainers DBs. After the stale pass, under the same advisory lock, the sweeper runs `startNextAlone` per row.

## Verification

- RED first: `queue.int.test.ts` 13/13 failed before the implementation (409 `generation_in_progress` / `model_unavailable`, missing function).
- `queue.int.test.ts`: 13/13.
  - Task 1 subset: 7/7 at its commit. It covers the tracer (queued 202 seen by 3 subscribers and the snapshot, same-finalize start, Alex's bearer, one `<responding_to>`, usage requester, queue events, audit) and coalescing (Sam then Víctor in one turn on Sam's plan, both context rows, one usage record).
  - It also covers addressing (askAi false, `@sam` only, askAi true, a forged `mentions` ignored), the queue cap (the 11th is 429 and is not stored), a `not_connected` skip with `message.updated`, a `daily_limit_reached` skip and the next author starting, and the solo 409 with an unchanged shape.
  - Task 2 adds: stop continues the queue and Sam's stop is 403, regenerate `queue_pending` then works, a sweeper tick starts a planted idle queue on Sam's plan, the sweeper never starts a second generation (direct duplicate insert → 23505), two instances (B finalizes and starts the queued turn, A's subscriber gets its deltas), and the function privileges (ids only, PUBLIC false, `ocw_app` true, definer).
- Regressions, one file at a time: ai-chat.int 20/20, multiplayer.int 17/17, stop.int 8/8, regenerate.int 6/6, prompt-matrix 9/9, tools 17/17, attachments 15/15, usage 16/16, titles 7/7, security 5/5, list 7/7, shares 14/14, usage-reports 10/10.
- `pnpm verify`: exit 0. Typecheck 8/8, 174 files and 2415 tests; lint clean except the 4 existing local-runtime warnings. No contract changed, so `typecheck --force` was not needed.
- Acceptance greps: `export async function startNext` (queue.ts), `registerQueue` (index.ts), `ai_queue_full` (service.ts), `queue_pending` (generations.ts), `pending_ai_queues` (sweeper.ts); `post-migrate.sql` contains it 3 times.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] routes.ts was not in the file list**
- The send route only declared 201. It now declares `202: AiPostedMessageResponse` and sends the status returned by the service. Commit 400ea81.

**2. [Rule 2 - Correctness] The limit audit is attributed to the queued requester**
- `refuseOverLimit` takes an optional `actor`. When the finalize hook skips Alex, the audit row names Alex (system actor), not the previous requester whose finalize transaction it runs in. `queued_started` does the same. Commit 400ea81.

**3. [Rule 1 - Bug prevention] No lock-order deadlock in the finalize hook**
- The deadlock: finalize has already appended to `user:<owner>` when the hook asks for `ai:<requester>`. A send by that requester in another chat of the same owner holds `ai:<requester>` and waits on `user:<owner>`, so the two transactions would wait on each other.
- The fix: the hook uses `pg_try_advisory_xact_lock`. When the lock is busy, it retries in a fresh transaction after commit (`startNextAlone`, which uses the blocking lock).
- Model-resolve errors that are not refusals (for example, the secret store is down) are logged and leave the queue to the sweeper. They never abort the finalize.

**4. [Rule 2] Archived chats and deleted messages**
- `startNext` does nothing on an archived chat. `pending_ai_queues` skips archived chats, deleted messages and non-human rows, so the sweeper does not retry them forever.

**5. [Note] Regenerate check order**
- `queue_pending` is checked before `generation_in_progress`, so regenerate cannot jump a queue while an answer runs either. That is the situation the test exercises.

**6. [Note] Audit metadata of shared sends**
- `ai_chat.message.sent` carries `{conversationId, messageId, addressed, generationId|null}`. A posted message may have no generation, so there is no backend or model to record. Solo sends keep the Phase 5 metadata.

**7. [Note] Test adjustment**
- The queue-full test finds the coalesced generation through the first queued message's context row. Reading the running row raced the fast fake, which could finish first.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. All six are mitigated and tested:
- T-06-06-01: first waiting author's own ref; bearer and usage requester asserted.
- T-06-06-02: `AI_QUEUE_MAX` 429; concurrency and daily caps per started turn; coalescing.
- T-06-06-03: stream lock, plus the duplicate insert asserted to fail.
- T-06-06-04: stop requester-or-owner; `queue_pending`.
- T-06-06-05: ids-only definer, PUBLIC revoked, per-org `withTenant`.
- T-06-06-06: `queued_started` audit with ids.

## Open items for later plans

- 06-11: a sender's own message arrives as `queued` in `message.created`. When its turn starts at once, `ai.queue.updated` (`running.generationId`, empty `pending`) and the assistant's `message.created` follow in the same transaction. The UI should derive "answering" from the queue event, or read `aiAddressing` from the 201 response.
- When the first waiting author is at the concurrency cap, the queue waits for the next sweep (≤ 15 s). Nothing triggers it sooner.

## Broken-windows ledger

`gsd windows`: nothing to append (no stubs, skipped tests or unrun verifies).

## Self-Check: PASSED

- Files exist: queue.ts, queue.int.test.ts, this SUMMARY.
- Commits 400ea81 and 777f6ab are on wt/06-06.
