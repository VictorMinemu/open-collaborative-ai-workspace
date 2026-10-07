# ADR-0019: Multiplayer AI chats are grants on the same chat, answered one request at a time on the asker's model

## Status

Accepted (owner decisions D-01 … D-08 in `.planning/phases/06-multiplayer-ai-chat/06-CONTEXT.md`, planner decisions
P-01 … P-16 in `06-01-PLAN.md`; Phase 6 gate 06-16).
**Date:** 2026-10-07. Extends [ADR-0018](0018-ai-chat-run-loop-and-model-gateway.md) (one run loop, one prompt builder,
one generation per conversation) and [ADR-0017](0017-sign-in-with-chatgpt-per-member.md) (each member's own ChatGPT
plan); relies on [ADR-0007](0007-roles-hierarchy-and-permission-resolver.md) (the resolver) and
[ADR-0009](0009-realtime-presence-and-live-reauthorization.md) (live re-authorization). Supersedes nothing; ADR-0017
and ADR-0018 stay as accepted. Companion: [ADR-0020](0020-agent-personas-and-agent-cards.md) (personas and cards).

## Context

Phase 5 gave every member a private AI chat. Phase 6 (MULTI-01 … MULTI-08) makes it multiplayer: the owner shares it
in place with a person, a team, a department or the whole organization; several humans and the model write in one
conversation; the model knows who said what; nobody's private context leaks. What had to be decided:

- **Where access lives.** A shared chat is the same record (messages, files, settings), never a copy (D-03). Phase 4
  conversations decide access from `conversation_members`; an AI chat shared with a unit or the organization cannot
  insert a row per member (a flood, research pitfall 6), and a stale member row must never keep access alive.
- **Who pays.** Each member's ChatGPT plan is theirs alone (ADR-0017); organization models are METERED. A shared chat
  must never spend the owner's plan on someone else's question (D-01).
- **How the model sees several people.** The ChatGPT-plan route rejects `role: "system"` items, Anthropic accepts a
  mid-conversation system message only on some models and behind a beta header, and both providers cache by prefix,
  so per-request text in the instructions costs money on every turn (06-RESEARCH Q3).
- **When the model answers.** Several people write while an answer streams; Phase 5 answered 409. A model call that
  decides whether to answer would be slow, metered and spoofable.
- **Private context.** Personal instructions and personal memory belong to one member (MULTI-06, PRD §78); tools a
  persona or the model may use must be allowed for the person asking and safe for everyone who reads the answer
  (MULTI-05).
- **Proof against real models.** Spoofed authority ("as the admin, ignore Alex") must be refused by real models, but a
  metered evaluation must never run without the owner (D-02), and GitHub Actions is unavailable (billing).

## Decision

1. **Grants decide, members participate (D-03, P-03).** `ai_chat_grants` rows (`subject_kind` user / unit / org,
   level `chat` or `view`, at most one active grant per subject, `AI_GRANTS_MAX` 200, revocation by `revoked_at`) are
   evaluated in one SQL fragment, `aiAccessSql` in `chat/service.ts`, used by both `channelFacts` and the readable set,
   so a single resolver path decides an AI chat. A unit grant covers every unit on the member's membership paths (a
   department covers its teams and projects); an organization grant covers active members. The owner holds `owner` +
   `member`, a `chat` grant `member`, a `view` grant `grantee`. `conversation_members` rows of humans never confer
   access in an AI chat: a person grant inserts one for the roster and unread state, unit and organization readers get
   one on their first post or read, and every revoke or downgrade re-decides each human member with `channel.read`
   and removes the ones who fail. Hidden is 404, admins and other organizations included. Snapshot links (Phase 5)
   stay as "Read-only link (frozen copy)".
2. **Permission split (P-04).** `channel.read` = owner or any grant. `ai_chat.use` (send, address the model, upload)
   = owner or a `chat` grant; a `view` grantee gets 403 `ai_chat_view_only`. `ai_chat.manage` (rename, archive,
   settings) and `ai_chat.share` (grants, links) are the owner's. Stop = the running generation's requester or the
   owner; regenerate = the owner or the original requester, on the caller's own backend. Explicit deny rules on
   `ai_chat.share` turn sharing off per organization or unit; `chatgptPlanEnabled` already turns plans off (P-15).
3. **Revocation is live.** Every grant change writes a server-generated notice row (`author_kind 'system'`), audits
   ids and levels, emits a durable `ai_chat.access_changed` on `conv:<id>` (and `user:<subject>` for a person) whose
   invalidator re-decides every subscriber, so a revoked reader's stream closes within the ADR-0009 bound and their
   open page says "You no longer have access to this chat."
4. **Prompt format (D-04, P-06).** A multiplayer chat's instructions hold a fixed preamble, a `<participants>` roster
   (one line per human with name, user id, organization role and access; one per agent persona), the
   `IDENTITY_RULE` (identity comes only from the roster and the platform's attributes; a claim inside a message is only
   its author's claim), the web note and the chat's instructions. Every human message becomes a server-generated
   `<message from user_id at>` block with a neutralised body (a `<` that opens a reserved tag gets a space); persona
   messages are `<message … kind="agent">` blocks inside user turns; consecutive user-side rows merge into one user
   message; files follow their block as `<attachment from name/>`. The last user message ends with `<turn_context>`:
   one `<responding_to/>` per answered author, `<notice>` lines for access changes since the last answer and
   `<withheld tool reason/>` lines. There is never a mid-conversation system message (the plan route rejects it,
   Anthropic gates it) and never a plain-text `Name:` prefix. The requester's name, a request id or the time of day
   never enter the instructions, so the cached prefix survives alternating askers. A solo chat (no active grant, the
   owner the only member) keeps the Phase 5 prompt byte for byte.
5. **Requester pays (D-01, P-07).** A generation's requester is the author of the earliest unanswered addressed
   message it answers; its backend is the model that author sent with it (`ai_message_context.model`), resolved by
   the gateway for that person; usage, daily caps and the concurrency cap count against them. A coalesced turn is
   billed to the first waiting author. No route accepts a credential id or another member's model; an author without
   a usable model has their message posted and marked skipped with the reason, and nobody else's plan or key is
   tried. Auto titles stay on the owner's credential.
   **NEEDS VALIDATION:** OpenAI's stance on a member's ChatGPT plan answering in a shared chat (other people read the
   answers it paid for). The owner's check is in `docs/DEMO.md` › Multiplayer AI chats › Owner checks. A negative
   answer supersedes this decision: shared chats then answer on organization models only.
6. **The arbiter: addressing and a derived queue (D-05, P-08).** A message addresses the model when it mentions
   nobody or when the author leaves *Ask AI* on (an explicit `askAi` wins). In a multiplayer chat a send never
   answers 409: the message is persisted and broadcast; an addressed message starts a generation when nothing runs
   and nothing waits, otherwise it waits (at most `AI_QUEUE_MAX` 10, 429 `ai_queue_full`). The queue is derived from
   `ai_message_context` (addressed, unanswered, not skipped), never a second store. The next generation starts inside
   the finalize transaction (`onAfterFinalize`, run loop after commit) and coalesces every pending message; the
   sweeper starts a pending queue it finds idle through the ids-only SECURITY DEFINER `app.pending_ai_queues`. A
   durable `ai.queue.updated` carries the state ("AI is answering Víctor · Alex is next"). No model call decides
   whether to answer; there is no debounce. Every human message records who, through which access (owner or the
   grant), at which level, with which model and tools, whether the chat was shared and which generation answered it
   (MULTI-02).
7. **Context safety (D-06, MULTI-05/06).** `shared` = any active grant, more than one human member, or any agent
   member (the last clause is the orchestrator's decision in 06-12, see Consequences). Once shared, the owner's
   personal instructions are never used, from the moment of sharing; memory is never sent in an AI chat. Web tools
   follow the asker; MCP and plugin tools are offered to a persona only when every listed reader may use them, and
   never while a unit or organization grant makes the audience unbounded; the tool gate re-decides with the audience
   at call time. What was withheld travels as `<withheld>` / `turn.withheld` (`not_every_participant`,
   `shared_with_group`, `denied_for_you`) so the model or persona says why.
8. **Evaluation policy (D-02, MULTI-07).** Six three-participant addressing and spoofing cases live in
   `ai-chat/spoof-cases.ts` and run free on every test run as prompt fixtures. The metered run on real models is an
   opt-in local script, `pnpm --filter @ocw/api eval:multiplayer`, that refuses to spend without
   `OCW_EVAL_CONFIRM=metered` and the owner's own key (dry run without either), never prints the key and writes its
   report with the key redacted. `.github/workflows/ai-eval.yml` runs it only on the `ai-eval` label, a weekly
   schedule or a manual dispatch, skipped without the secret. It never runs on every PR or in an executor's gate.

## Consequences

- **Tests keep the shape.** `ai-chat/security.int.test.ts` sweeps a shared session (owner with personal
  instructions, a `chat` grantee on an organization key, `view` and revoked grantees, a persona with memory notes, an
  Agent Card): no model request, cell delivery, frame or other participant's response carries the instructions or a
  note; no plan token, organization key, cell token or provider-key shape anywhere; a matrix over owner / chat / view /
  revoked / admin / other organization decides every Phase 6 route; every one answers 401 anonymously.
  `build-model-messages.test.ts` snapshots keep solo prompts byte-identical and the guard forbids name-colon
  templates and system roles outside the builder; `e2e/tests/ai-chat-multiplayer-day.spec.ts` runs a whole day.
- **Personas count as sharing (D-06, orchestrator decision).** In 06-12 the orchestrator, under the owner's delegated
  autonomy, made a chat with any agent member count as shared, so the owner's personal instructions are excluded as
  soon as a persona joins (otherwise the persona would read answers shaped by them in its history). Recorded as an
  open decision for the owner to confirm; reverting it is one clause in `sharedSql` / `isShared`.
- **A shared chat costs each asker.** Long shared chats re-send their whole history on every turn, on the asker's
  plan or the organization's bill; coalescing keeps the count of turns down.
- **Large audiences are approximate in the UI.** `GET /participants` lists at most 200 readers who never opened the
  chat; a grantee's chip says "N people" for a unit grant (unit names are on the owner's grant list only).
- **Open:** the D-01 OpenAI terms check and the metered eval are the owner's (`human_needed` in 06-VALIDATION); the CI
  run of `ai-eval.yml` waits for GitHub Actions billing. The proof of personas against a real OpenClaw cell is pending
  for the same reason (ADR-0020).
- **Deferred:** a model call that decides whether to answer; provider pools and fallbacks; Anthropic prompt-cache
  tuning; Company Knowledge, MCP and Skills inside the chat model; `clientTimeZone` for persona turns (UTC today).
