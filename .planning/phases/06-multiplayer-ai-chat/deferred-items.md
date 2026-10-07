# Phase 6 — deferred items

## From 06-03 (out of scope: API files owned by other plans)

- **Grantees never hear that an answer ended or that the chat was renamed.** `ai_chat.updated` from the run loop
  (`run-loop.ts` finalize), titles (`titles.ts`) and rename/archive (`service.ts` update) is appended to
  `user:<owner>` only; a grantee's copy of the summary keeps `generating: true` from their own send and the old title
  until the shared list refetches. The web's "Shared with me" rows therefore show no "Answering" dot. Fix belongs with
  the participant fan-out (06-04 invalidator / 06-06 queue): append the viewer's summary to every participant's topic.
- **Regenerate is offered to every `ai_chat.use` viewer on the last answer.** The API refuses a grantee who is not the
  owner or the latest requester (403 `not_answer_requester`, 06-02); the menu could hide itself using
  `generation.requesterUserId`. Left to the queue/regenerate UI work (06-06/06-11).

## From 06-09 (out of scope: pre-existing failure after the 06-04 + 06-05 merges)

- **`grants.int.test.ts` › "after every grant is revoked … sends are solo again" fails deterministically on
  `28a31e4` + 06-09.** Line 606 asserts `"shared this chat with"` / `"removed access for"` never reach the model, but
  06-05 deliberately puts notices newer than the last kept answer into the trailing `<turn_context>` (`<notice>Víctor
  Ruiz shared this chat with …</notice>`). The two plans' expectations disagree; 06-09 touches neither the builder,
  turn.ts nor the grants path. Fix: either update 06-04's assertion to "notices only inside `<turn_context>`, never as
  their own messages", or decide (D-04) that a chat that went solo again drops notices. Owner of the decision: the
  phase orchestrator / 06-04 follow-up.
