---
phase: 06-multiplayer-ai-chat
plan: 11
subsystem: web (ai-chat), e2e, infra/fake-model
status: complete
tags: [multiplayer-ai, queue, addressing, typing, payer, composer, tracer, scenario-b]
requires:
  - "06-01: AiQueueState, AiQueueUpdatedEvent, AiAddressing, AiPostedMessageResponse, askAi, requesterUserId"
  - "06-03: AiChatPeopleContext, ai-chat-multiplayer.spec, VICTOR/shareWith/humanTurn"
  - "06-04: ai_chat.access_changed on conv:<id>, subscription invalidator"
  - "06-06: 201/202 sends, queue derived from ai_message_context, snapshot queue, stop rule"
  - "06-10: GET /ai-chats/:id/participants, persona rows (agent author with an id)"
provides:
  - "QueueChip (components/ai-chat/queue-chip.tsx): running requesters, next authors, Stop for the requester or ai_chat.manage"
  - "payerLabel, queueText and footerParts(g, payer) in lib/ai-format.ts"
  - "Reducer: AiChatState.queue, ai.queue.updated by seq, aiAddressing that never steps back, `posted` action for 202"
  - "sendAiMessage → AiSendResult (201 | 202), isPosted, askAi forwarded only in multiplayer chats; useAiParticipants"
  - "useAiChat: queue, typers, sendTyping, applyPosted, lost (revoked stream or 404 after a loaded snapshot)"
  - "AiComposer: multiplayer Ask AI toggle and @ suggestions (AI + participants); onTyping"
  - "Persona rows rendered as bots; addressing status line on human turns; regenerate only for requester/manager"
  - "Fake model [[slow:N]] directive; e2e sendAiAs/askAiToggle helpers"
affects: [06-12 (dialog adds teams/personas; chip and composer read the same participants), 06-16 (phase verification)]
tech-stack:
  added: []
  patterns:
    - "Multiplayer UI = detail.shared || snapshot/queue present (server's isMultiplayer); solo chats render the Phase 5 components untouched"
    - "Request status derived on the client only from server data: message aiAddressing + ai.queue.updated (pending ids, respondingTo author ids)"
    - "Viewer-relative payer wording only in footers; the chip always uses names"
key-files:
  created:
    - apps/web/components/ai-chat/queue-chip.tsx
  modified:
    - apps/web/lib/ai-chat-stream.ts
    - apps/web/lib/ai-chat-stream.test.ts
    - apps/web/lib/ai-chat-queries.ts
    - apps/web/lib/ai-format.ts
    - apps/web/lib/ai-format.test.ts
    - apps/web/components/ai-chat/ai-composer.tsx
    - apps/web/components/ai-chat/ai-message.tsx
    - apps/web/components/ai-chat/ai-message-list.tsx
    - apps/web/components/ai-chat/ai-chat-view.tsx
    - apps/web/components/chat/composer.tsx
    - e2e/support/ai-chat.ts
    - e2e/tests/ai-chat-multiplayer.spec.ts
    - infra/fake-model/fake-responses.mjs
    - infra/fake-model/fake-responses.test.mjs
decisions:
  - "`running.respondingTo` carries author user ids (as 06-06 emits), not message ids: a request that leaves `pending` while a turn runs is 'answering'; one answered by an older generation, or left when nothing runs, is 'answered'"
  - "An answered request shows no status line (its answer and footer say it); Queued / AI is answering / Not sent to AI / AI couldn't answer: <reason> are shown"
  - "The payer replaces the backend label in multiplayer footers: '… · GPT-6 Astra · for Alex Kim · Alex's ChatGPT plan'; to the requester 'for you · your ChatGPT plan'"
  - "The chip always names people (also the viewer), so every page reads the same sentence"
  - "@ suggestions come from /participants (channel.read-gated) with people's handles from the org directory; the directory is loaded only in multiplayer chats"
  - "On conv ai_chat.access_changed the view always re-reads the snapshot (the conv copy carries the subject's access, not the viewer's)"
metrics:
  duration: "~1h50m"
  completed: 2026-10-07
estimate:
  tokens: 160000
actuals:
  tokens: 17000   # chars/4 over the added lines of the diff, screenshots excluded (68 299 chars)
  tasks: 2
  commits: 7
---

# Phase 6 Plan 11: Live multiplayer AI chat surface Summary

A shared AI chat now shows who is typing, a queue chip above the composer ("AI is answering Víctor Ruiz · Alex Kim and Sam Lee are next") with Stop only for the running requester or the owner, a status under each human turn (Queued, AI is answering, Not sent to AI, or why the AI couldn't answer) and, on each answer, whose request it answered and who paid ("for Alex Kim · Alex's ChatGPT plan" / "· METERED"). The composer has an "Ask AI" toggle and @ suggestions (AI first, then the chat's people and agents). Send stays available while an answer runs. A participant who loses access sees "You no longer have access to this chat." at once. Solo chats are unchanged.

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | Alex asks while Víctor's answer streams: queued, chip, coalesced answer with for-whom and payer (tracer) | 3c4a572 (RED), d741253 (fake), e0bdcfd (GREEN) |
| 2 | Ask AI toggle and @ autocomplete | a071611 (RED e2e), b33499a (GREEN), f4931b5 (format) |
| — | Screenshots from the final regression build | 3028b1f |

## What changed

- **Reducer (`ai-chat-stream.ts`).** `queue` comes from the snapshot, then from each `ai.queue.updated` by seq. A snapshot older than the latest queue frame never steps it back, because newer frames are re-applied over it. Queue frames move the addressing of messages. `mergeAddressing` keeps a further-along status when a replayed `message.created` still says `queued` (06-06 open item). A new `posted` action inserts a 202 message once, with its addressing.
- **Queries.**
  - `sendAiMessage` parses 201 or 202 (`isPosted`) and forwards `askAi` only with `{multiplayer: true}`.
  - `useAiParticipants` reads `/participants`.
  - `useAiChat` adds `queue`, typers (`user.typing` / `agent.typing`, Phase 4 expiry, names from authors and participants), a throttled `sendTyping` (3 s), `applyPosted` and `lost`.
  - `ai_chat.access_changed` on `conv:` re-reads the snapshot and the participants, so `viewerCan` (composer vs read-only) follows live.
- **Format.** `payerLabel(g, requesterName, viewerId)` and `queueText(queue, nameOf)`. `footerParts(g, payer)` swaps the backend label for the payer only when a payer is given.
- **UI.**
  - `QueueChip` sits above the composer. It truncates at 390, with the full text in its title, and is hidden when idle.
  - `TypingIndicator` sits under the list.
  - Human turns show an `AddressingLine`. Skip reasons use the Phase 5 `reasonText` plus daily cap, usage unavailable and too many answers.
  - Persona rows (an agent with an author id and no generation) render with avatar, name and Bot badge, never with the model footer.
  - In a multiplayer chat the composer keeps Send and Stop moves to the chip.
  - Regenerate shows only for the answer's requester or `ai_chat.manage`, and is disabled while messages wait (06-03 deferred item; `queue_pending`).
- **Composer.**
  - "Ask AI" pill: on by default. It turns off automatically while the draft mentions a participant handle, unless the AI was chosen. Choosing "AI" from the suggestions or the toggle sets the choice explicitly; the choice resets after a send.
  - @ suggestions use the Phase 4 ranking (`rankMention`, now exported from `chat/composer.tsx`) and support ↑ ↓ Enter Tab Esc.
  - People are listed with avatars and agents with a Bot badge. The viewer is never listed.
  - Picking the AI removes the `@…` token, so no "@AI" text is left.
  - Solo chats render the plain Phase 5 `AiComposer` (no org directory request).

## Verification

- **RED first.**
  - Web unit: 5 reducer and 6 format cases failed before the implementation.
  - Fake `[[slow:N]]`: failed (3 deltas instead of 40).
  - Task 2 e2e: failed on the missing toggle.
- **Web unit.** `vitest --project web ai-chat-stream.test.ts ai-format.test.ts`: 34/34 (20 + 14), plus `ai-chat-list-cache` 5/5.
- **Fake model.** `node --test 'infra/fake-model/*.test.mjs'`: 87/87.
- **Plan e2e, Task 1.** `--rebuild-web ai-chat-multiplayer ai-chat-stop ai-chat.spec`: 19/19, desktop and mobile.
- **Plan e2e, Task 2.** `--rebuild-web ai-chat-multiplayer ai-chat-tools ai-chat-attachments`: 19/19.
- **Full ai-chat regression.** `--rebuild-web ai-chat` (all 15 ai-chat specs, including models, list, share, shared-inbox, usage, visual, signin, plan-errors and day): 95/95 on desktop and mobile, 0 flaky.
- **`pnpm verify`.** Exit 0. Typecheck 8/8, 180 files and 2533 tests. Lint shows only the 4 existing local-runtime warnings.
- **No contract change**, so `typecheck --force` was not needed.
- **Acceptance.**
  - `export function QueueChip` and `export function payerLabel` are both present.
  - `askAi` is in `ai-composer.tsx` and `ai-chat-queries.ts`.
  - Screenshots: `multiplayer-queue-*` 8 files, `multiplayer-composer-*` 8.
- **Screenshots reviewed with Read** (light and dark, 1440 and 390): `multiplayer-queue-<w>[-alex][-dark]`, `multiplayer-coalesced-<w>[-dark]`, `multiplayer-composer-<w>[-addressed][-dark]`. The captures of other specs in the same runs were deleted, and the 06-03 and 06-08 shots they overwrote were restored. The `.env` symlink was removed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `respondingTo` holds user ids, not message ids**
- **Found during:** Task 1 e2e. The chip read "AI is answering Alex Kim" for a coalesced turn.
- **Issue:** 06-06 emits the authors the turn answers (`queue.ts` `queueState`). The first reducer and chip read the field as message ids.
- **Fix:** the reducer moves requests by `pending` and the running generation instead. `queueText` reads author ids. The unit fixtures were corrected to the server's shape.
- **Commit:** e0bdcfd

**2. [Rule 1 - Bug] Caret jump after an @ pick**
- **Found during:** Task 2 e2e. Keys typed right after a pick landed before the inserted handle.
- **Fix:** the caret is restored in a layout effect on the committed value, as in the Phase 4 composer, not in `requestAnimationFrame`.
- **Commit:** b33499a

**3. [Rule 3 - Blocking] Fake model `[[slow:N]]` (infra/fake-model, outside the file list)**
- The 4 s `[[slow]]` window was too short for two people to type, send and be checked as next on three pages, with screenshots.
- `[[slow:N]]` streams the same 40 deltas over about N seconds (1–60). It has its own test.
- **Commits:** d741253, f4931b5

**4. [Rule 2 - Correctness] Files outside the list**
- **`ai-message-list.tsx`:** regenerate is gated (06-03 deferred: the API answers 403 unless the requester or owner) and blocked while the queue holds messages (`queue_pending`). Persona rows are never regenerable.
- **`chat/composer.tsx`:** exports the Phase 4 ranking as `rankMention`, so @ suggestions rank the same everywhere.

**5. [Clarification] The payer wording depends on the viewer**
- The behaviour list says the footer reads "for Alex Kim · Alex's ChatGPT plan" on every page. The `payerLabel` behaviour says it reads "for you · your ChatGPT plan" to the requester.
- The e2e asserts the named form on Víctor's and Sam's pages and the "you" form on Alex's.

**6. [Note] QueueChip interface**
- `viewerId` is optional, because the chip always uses names (the e2e expects the same sentence on every page).

**7. [Note] Answered requests show no status line**
- "Answered" is visible through the answer and its "for …" footer. Only queued, answering, not sent and couldn't answer get a line, to keep long chats quiet.

**8. [Note] Agents in the e2e**
- The @ list renders agents with a Bot badge, but the e2e covers people only. Adding a persona needs a team bot set up through the 06-10 routes, and 06-12 adds the UI for that.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register.
- **T-06-11-01:** labels come only from `generation.requesterUserId` and `backend`, and are unit-tested.
- **T-06-11-02:** `canStop` = running requester or `ai_chat.manage`, asserted in the e2e (Alex and Sam see no Stop during Víctor's turn; Sam sees none during Alex's). The API enforces the same rule.
- **T-06-11-03:** suggestions come from `/participants` only, never the org list. The directory only supplies handles.

## Open items

- Persona rows and agent typing in AI chats are rendered but not exercised end to end; 06-12 adds personas through the UI.
- Unit or organization grantees who have not joined do not appear in `/participants`, so they are not in the @ list until they post or read (06-08/P-09). Their names in typing lines fall back to their message authorship, or "Someone".

## Broken-windows ledger

`gsd windows`: nothing to append (no stubs, skipped tests or unrun verifies).

## Self-Check: PASSED

- Files exist: `queue-chip.tsx`, this SUMMARY, 20 `multiplayer-{queue,coalesced,composer}-*.png`.
- Commits 3c4a572, d741253, e0bdcfd, a071611, f4931b5, b33499a and 3028b1f are on wt/06-11.
