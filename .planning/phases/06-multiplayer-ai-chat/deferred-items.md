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
## From 06-08 (resolved in 06-08)

- **`grants.int.test.ts` › "after every grant is revoked › the owner's next turn still attributes former grantees'
  messages …" failed on the merged branch** (not caused by 06-08: no prompt code changed). 06-04 asserted that notice
  lines never reach the model; 06-05 then made notices newer than the last kept answer `<notice>` lines of the
  `<turn_context>`, as P-09 specifies. The assertion now checks that notice text never appears outside `<notice>`
  lines (never as a message), which keeps 06-04's intent under P-09. `pnpm verify` needed it green.

## From 06-16 (out of scope: Phase 4 chat routes)

- **Phase 4 chat routes authenticate in `preHandler`, after body validation.** `apps/api/src/modules/chat/index.ts`
  registers its routes with `preHandler: requireUser`, so an anonymous request with a malformed body gets 400 (schema
  validation) instead of 401. Nothing is read or written, and a well-formed anonymous request still gets 401. The
  Phase 6 card routes in `chat/card-actions.ts` had the same shape and were fixed in 06-16 (`onRequest`, proven by the
  anonymous sweep in `ai-chat/security.int.test.ts`). Fix for the rest: move `requireUser` to `onRequest` in
  `chat/index.ts` and extend an OpenAPI-driven anonymous sweep to `/api/v1/conversations*`, `/channels*`, `/dms*`.
- **Bots › Add to channel offers channels the caller cannot add a bot to.** The dialog lists every visible channel; for
  a channel the admin is not a member of (here 06-15's `backend-*`, created by another admin) `POST
  /channels/:id/members` answers 403 and the dialog stays open with an error toast. `bots.spec.ts` picked the first
  channel, so 06-15's channel name made it fail in the full run; 06-16 makes the spec pick `#general`. Product fix
  (Phase 1/4 surface): list only channels where the caller may add members, or say why a channel is disabled.
