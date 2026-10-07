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

## From 06-08 (resolved in 06-08)

- **`grants.int.test.ts` › "after every grant is revoked › the owner's next turn still attributes former grantees'
  messages …" failed on the merged branch** (not caused by 06-08: no prompt code changed). 06-04 asserted that notice
  lines never reach the model; 06-05 then made notices newer than the last kept answer `<notice>` lines of the
  `<turn_context>`, as P-09 specifies. The assertion now checks that notice text never appears outside `<notice>`
  lines (never as a message), which keeps 06-04's intent under P-09. `pnpm verify` needed it green.
