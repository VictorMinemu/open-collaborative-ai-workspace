# ADR-0023: Scoped memory files and the approve-and-apply primitive

## Status

Accepted (owner decisions D-01 to D-09 in `.planning/phases/07.2-scoped-memory-files-and-governed-promotion/07.2-CONTEXT.md`,
research design accepted as D-08; written in plan 07.2-06, amended by the 07.2 fix rounds, accepted at the phase gate
07.2-15 with the decisions taken during execution under "As built" and the upgrade cost under "Consequences";
decision 15 amended 2026-10-13 by owner decision: self-approval follows the decision right).
**Date:** 2026-10-13. Extends [ADR-0010](0010-personal-bots-capability-model-and-tool-gate.md) (memory in Postgres,
"admins never read personal memory") and [ADR-0020](0020-agent-personas-and-agent-cards.md) (Agent Cards: adds
platform-owned cards). Supersedes nothing.

## Context

Bots keep memory today as short notes per (bot, human) in `agent_memories` (ADR-0010, D-10). The owner wants a viewer
of files, folders and subfolders where bots keep their memory as Markdown, and shared memory must never change
without a person approving the exact change. Phases 07.5 (one tool call needs a human's yes) and 07.6 (automations
ask for confirmation) need the same "a person approves, the server does exactly that" step, so it is built once,
generically, here.

Two facts shaped the design:

- An approval card that an agent can edit is worthless: today the posting agent may rewrite any field of its card
  (ADR-0020 decision 4), so a model could falsify the findings or the reader count it shows.
- Approvers may not read the conversation a request is born in (a bot proposes into team memory from a member's DM;
  the team lead decides). The decision cannot live only on the card.

## Decision

### Memory

1. **Platform-owned virtual Markdown files per scope (D-01).** `memory_scopes` (kinds `personal`, `agent`, `unit` for
   department, team and project, `org`), `memory_files` (relative paths, folders derived from paths, a `MEMORY.md` per
   scope, case-insensitive unique path, STORED full-text column like chat search) and append-only
   `memory_file_revisions` (UPDATE and TRUNCATE revoked from the app role). Paths follow `parseMemoryPath` (NFC,
   reject and never repair). OpenClaw's memory slot stays `none`; the cell's files are never read or written.
2. **Permissions (D-04).** `memory.read`, `memory.write`, `memory.promote`, decided by the resolver on the scope's
   unit. Rules may carry a folder `pathPrefix` (memory grains only), matched case-insensitively on segment boundaries;
   deny wins. Unit memory follows the unit-persona read rule (subtree members, leads on the path, admins); a team
   bot's notebook is readable by the bot's readers. Agents may hold read and write, never promote.
3. **Personal memory in three layers (ADR-0010).** (a) The resolver: owner only, admins included. (b) The database:
   every row of a personal scope or of a personal bot's notebook carries `personal_owner_user_id`, set by SECURITY
   DEFINER triggers from the parent row (never from application input), and a RESTRICTIVE `personal_owner_only`
   policy keyed on `app.user_id` hides it from any other session, an admin of the same organization included.
   (c) Audit: ids, versions and byte counts only, never paths or content.
4. **Agent reads follow the audience rule.** What a bot may read for a turn is agent ∩ asking human ∩ every human
   reader of the turn's conversation. An unbounded audience (a public channel, a group-granted AI chat) reads only
   organization-wide files nobody is denied; personal memory only in the owner's 1:1 DM with the bot.
5. **Writes.** Agents write only their own scopes (`personal`, `agent`) and propose into shared ones. A tainted turn
   (it read web or tool content) may propose, flagged, never write. Secrets are refused on every write path, human
   edits included.
6. **Detectors (D-06).** Layer 1 in TypeScript (secrets through the shared redact patterns, IBAN, cards with Luhn,
   NIF/NIE, e-mail, phone), always on. Layer 2: Presidio as the optional `pii` compose profile, called with a short
   timeout; when it does not answer the proposal carries a visible "extended scan unavailable" marker (fail open,
   visibly). No layer ever approves anything. Both layers run before the proposal's transaction, with no connection
   or lock held; the transaction recomputes the hash of what was scanned (op, base and proposed text) and refuses
   `version_conflict` when it changed (WINDOWS 145).
7. **Viewer.** `@headless-tree/react` for the tree (instead of react-arborist), the shared `<Markdown>` to read,
   CodeMirror 6 to edit and `@codemirror/merge` for diffs.

### The approve-and-apply primitive (`apps/api/src/modules/approval`)

8. **Public interface** (verbatim from 07.2-06):

```ts
export type HashAtom = string | number | boolean | null            // numbers: safe integers only
export function actionHash(kind: string, tuple: readonly HashAtom[]): string
  // sha256Hex(JSON.stringify(["ocw-approval", 1, kind, ...tuple])); throws on a non-integer number or undefined
export interface ApprovalRow { id; organizationId; kind; mode; resourceType; resourceId; actionHash; status;
  requestedByAgentId; requestedForUserId; eventId; cardMessageId; decidedBy; decidedAt; consumedAt; appliedAt;
  resultCode; expiresAt; createdAt }
export type ApplyResult = { ok: true } | { ok: false; code: string }
export interface ApprovalKind {
  readonly kind: string; readonly mode: ApprovalMode; readonly resourceType: string; readonly ttlMs: number;
  hashInput(tx: Tx, row: ApprovalRow): Promise<readonly HashAtom[]>;      // from the STORED action only
  canDecide(tx: Tx, deciderUserId: string, row: ApprovalRow): Promise<boolean>;   // live rules at decision time
  audience(tx: Tx, row: ApprovalRow): Promise<readonly string[]>;          // ids-only update recipients
  view(tx: Tx, row: ApprovalRow, viewerUserId: string): Promise<ApprovalView>;
  card?(tx: Tx, row: ApprovalRow): Promise<{ card: AgentCardInput; warnings?: string[] }>;   // server-composed mirror content;
                                                                          // warnings (≤ 3) are stored in card_warnings
  apply?(tx: Tx, row: ApprovalRow, ctx: { deciderUserId: string }): Promise<ApplyResult>;   // server_apply only
  isPrivate?(tx: Tx, row: ApprovalRow): Promise<boolean>;   // true → audit records the note's length, never its text
}
export interface RequestApprovalInput { kind: string; resourceId: string; requestedByAgentId: string | null;
  requestedForUserId: string | null; eventId: string | null;
  card?: { agentId: string; conversationId: string; inReplyToMessageId: string; threadRootMessageId: string | null } }
export interface ApprovalService {
  register(kind: ApprovalKind): void;                                      // duplicate id or apply/mode mismatch → throws
  request(tx, input: RequestApprovalInput): Promise<{ id: string; actionHash: string; cardMessageId: string | null }>;
  decide(tx, input: { id; deciderUserId; outcome: "approved" | "denied"; actionHash; note?: string }): Promise<ApprovalSummary>;
  consumeGrant(tx, input: { id; kind; actionHash }): Promise<{ ok: true } |
    { ok: false; code: "approval_not_found" | "not_approved" | "already_used" | "approval_expired" | "approval_action_changed" }>;
  get(tx, id, viewerUserId): Promise<ApprovalDetail>;                      // 404 unless decider or requester
  list(tx, viewerUserId, q: ApprovalListQuery): Promise<ApprovalList>;
}
export function createApprovalModule(core: Core): { module: ApiModule; service: ApprovalService }
// routes (authz "user"): GET /api/v1/approvals, GET /api/v1/approvals/:id, POST /api/v1/approvals/:id/decision
// bridge (lib/chat-agent-bridge.ts): cardPlatformOwned?: boolean on postAgentMessage input;
//   registerLinkedCards({ linkOf(tx, messageIds) → Map<messageId, {id, actionHash, status, requestedForUserId, warnings}>,
//                          canDecide(tx, messageIds, userId) → Set<messageId>,
//                          decide(tx, {messageId, deciderUserId, outcome, actionHash, note?}) → ApprovalSummary })
//   CardAction (bridge type) += note?: string
// chat (public index): mirrorCardDecision(tx, deps, { messageId, outcome, deciderUserId, status, note? }) for the approval service
// agent-channel/cards.ts emitCardAction: the server sentence gains `: “<note>”` when a note exists (human-authored, quoted)
```

   As built, `ApprovalRow` is the full `approval_requests` row (it also carries `decisionNote` and `cardWarnings`),
   `ApprovalService` also exposes `linkedCards` (the provider the module registers on the bridge), and the bridge
   gains `postAgentMessageIn(tx, input)` so the mirror card is posted inside the request's transaction.
   The gone path (07.2 fixes, WINDOWS 144 and 164) adds `gone?(tx, row): Promise<string | null>` to `ApprovalKind`
   and `closeGone(tx, { ids } | { requestedByAgentId })` to `ApprovalService`: the owner of a lifecycle that makes an
   action vanish (a unit deletion, a bot deletion, a forget) calls it in that transaction, and every pending request
   whose kind answers a code is closed as `failed` with it, with no decider, audited `approval.closed` (ids and the
   code), announced like a decision and mirrored on its card (status `failed`, `message.updated`, no card action turn).
   `memory.write` answers `bot_deleted` (its bot was deleted) or `scope_gone` (its proposal went with a cascade), and its
   `apply` also refuses `bot_deleted` / `bot_disabled`, so the server never writes on behalf of a deleted or turned-off
   bot.

9. **Two modes.** `server_apply` (07.2): the server applies the approved action inside the decision transaction.
   `grant` (07.5): an approval leaves a one-use grant that `consumeGrant` spends exactly once, only with the matching
   hash and before expiry (a second use, another hash or an expired grant is refused; concurrent uses: exactly one
   succeeds).
10. **The action hash.** Each kind fixes the order of its tuple and builds it only from the stored action; there is
    no generic JSON canonicalization. Numbers are safe integers; `undefined` and non-atoms throw. The domain tag and
    the version keep pinned hashes stable and kinds apart.
11. **The decision transaction** (one `withTenant`): lock the request `FOR UPDATE` → hide it (404
    `approval_not_found`) unless the caller may decide it now, it was requested for them, or they decided it → 409
    `approval_already_decided` unless pending → 409 `approval_expired` when past `expires_at` (derived, nothing
    written) → 403 `not_approver` when the caller is only the requester → recompute the hash and compare it with the
    stored one and the one the approver sent (409 `approval_action_changed`; an approval whose action changed is
    unusable, never re-targeted) → conditional `pending → approved|denied` (the loser of a race gets 409) → audit
    `approval.decided` → for `server_apply` approvals, consume the grant with a conditional update on (id,
    unconsumed, hash) and run `apply` in a savepoint (`withSavepoint`: a not-ok result rolls back every write of
    `apply` and drops its after-commit hooks) → `applied` + `approval.applied`, or `failed` + `result_code` +
    `approval.apply_failed` → `approval_request.updated {id, status}` on the `user:` streams of the kind's audience,
    the requester and the decider (never `org:`) → mirror the card.
12. **The decision note.** Optional, plain text, at most 280 characters (`ApprovalNote`). It is stored on the request
    (and on the mirrored card), shown on the decision line and quoted in the agent's card-action turn. Audit carries
    the text, or only `noteChars` when the kind says the request is private (`isPrivate`).
13. **Visibility.** `get`, `list` and `decide` apply one rule: deciders now, the requester and the decider see a
    request; everyone else, other tenants included, gets 404 or nothing. `list` applies it to every row whatever the
    role and refuses an unknown role; the role only narrows (`decider`: may decide or decided; `requester`: asked for
    me). `expired` is derived from `expires_at` in every read.
14. **Platform-owned cards (extends ADR-0020).** `message_cards.platform_owned`: the server composes the card from the
    kind's `card()` (kind `approval`, status `pending`, the service's own Approve action without an approver list, the
    kind's Open action, warnings stored in `card_warnings`) and posts it as the requesting agent, through the same
    chat checks as any agent post, in the request's transaction. An agent PATCH is 403 `card_platform_owned`. A
    decision on the card (`POST /cards/:messageId/decision`) needs the readable conversation and the hash the reader
    saw (400 `action_hash_required`) and delegates to the primitive: `agent_card.approve` and approver lists are not
    consulted, the kind is the authority; a reader who fails `canDecide` gets 403. Every decision, from the card or
    the inbox, mirrors the card once (status `succeeded`, `failed` or `cancelled` for denied; the decision with its
    note; `message.updated`) and the agent hears it as one `agent.card_action.v1` turn. Ordinary cards are unchanged.
15. **No auto-approval.** Every decision names a human who passed `canDecide`. Personal-like scopes (a person's own
    memory, a personal bot's notebook) are decided by their owner only; unit, organization and team-bot notebook
    proposals by whoever holds `memory.promote` on the path, the human the proposal was made for included. A requester
    without that right still cannot decide (403 `not_approver`) and reads "Waiting for a reviewer". When the decider
    is the requester, `approval.decided` carries `selfApproved: true` (a flag, no names); the action-hash recompute,
    stale base, grants and the gone path are unchanged.
    *Amended 2026-10-13 (owner decision).* Old rule: self-approval only in personal-like scopes; shared proposals
    needed someone else holding `memory.promote` (four eyes). New rule: the decision right decides, not who asked; the
    requester who holds `memory.promote` approves or denies their own shared proposal, on the chat card (Approve /
    Deny with the confirmation and optional note, next to Review changes) or in the review, and the audit flags it.
16. **Personal approvals at the database layer.** `approval_requests` has no `personal_owner_only` policy. The kind
    of a personal-like request decides only its owner, so the API never shows it to anyone else (tested with a
    private test kind: an admin gets 404 and lists nothing). The row holds metadata (kind, ids, status, times), the
    server-composed warnings and the owner's own decision note; the proposal's content and path stay in
    `memory_proposals`, which is owner-only in RLS. The same note is also on the DM card, whose tables are tenant-only
    like every DM. A database-level owner column can be added later with a forward migration if raw-SQL access by
    admins becomes part of the threat model for decision records.

### As built (decisions taken during execution, Phase 07.2 plans 01-17 and the fix rounds)

20. **Agent routes and dead turns.** Every Agent Channel memory route (`/memory/list|read|write|propose`) answers
    403 `no_trigger` when the call answers no live turn of that agent, or the turn's human no longer reads its
    conversation (the rule of every agent post, PR #25), audited and committed before the answer; the plugin reads it
    as "this conversation turn is no longer active". Other refusals stay `200 {refused}`. `list` and `read` count one
    call against the turn's cap on their own route; `/tool-calls` only checks the cap for the memory tools.
21. **Where personal memory may be used.** A person's private scope with a bot, and a personal bot's notebook, are used
    by agents only in the owner's one-person DM with that bot: `read`/`list` elsewhere answer `audience_too_wide`,
    `propose` elsewhere `dm_only` (its card would show the excerpt to others). AI chats carry no memory files (ADR-0019),
    even a solo chat. What the human may not read reads as `not_found`, never revealed.
22. **Files never change scope.** Rename takes a path only; a move between scopes is create plus delete, so each
    history stays under the scope and owner it was written in. The database refuses a `scope_id` change for every
    role, the superuser included (trigger `memory_file_scope_fixed`).
23. **Unit memory is closed outside the unit audience** for every grain: no allow rule lets someone write or promote
    memory they cannot read. A standard owner of a team bot writes its notebook but does not promote into it
    (`memory.promote` stays on the `team` surface).
24. **Search is read-only and decided by the memory service.** Memory search ranks over the ids the memory service
    says the viewer may read (one permission pass, ids and paths only), never creates a scope, reads only the hits'
    bodies (a 16 KiB headline window) and has its own rate limit. `GET /memory/scopes` still creates missing org and
    unit scopes lazily.
25. **Live updates are ids-only and reader-exact.** `memory.changed {scopeId, fileId, version}` goes to each person who
    may read the (scope, path) on their own `user:` stream, folder rules included; organization-wide memory nobody is
    denied goes once on `org:`; private memory to its owner only. Approval updates follow decision 11.
26. **The plugin side.** The memory file tools are not turn-scoped: they reach OpenClaw through the bot's allowlist
    and every turn narrows them. `ocw_memory_save` appends to the human's private `MEMORY.md` (the legacy notes table
    is no longer read); OpenClaw's own memory slot stays `none`.
27. **Cards and inbox.** The card's failed reason comes from the approval's `result_code`
    (`AgentCardApprovalLink.resultCode`); inbox rows carry a kind-composed `headline` (title, scope, requester, chips).
    Expired cards show the pill only. Memory is a module of the ADR-0024 catalog (`memory.*`).
28. **Detectors as built.** `OCW_PRESIDIO_URL` empty means off; Presidio loads only the recognizers behind the
    entities we ask for (NIF/NIE for Spanish; card, IBAN, e-mail, phone, IP for both; spaCy NER). An out-of-range offset
    makes the whole answer invalid (the visible marker), never silently dropped. A secret blocks a write only if
    redacting it changes the text (already-redacted text does not block).

### Reuse

17. **07.5 (tool calls).** Registers a `grant` kind for one tool call whose tuple is the tool name plus its canonical
    parameters (the canonicalization is 07.5's choice), and calls `consumeGrant` from the tool gate right before the
    call.
18. **07.6 (Work Zone memory, automations).** Creates memory proposals from a system origin (`requestedByAgentId`
    null) and registers kinds for automation confirmations, using the generic `fields` view when no custom view exists.
19. **Module access (ADR-0024).** The primitive has no module of its own; a kind whose feature belongs to a module
    checks that module's grains in `canDecide` (memory kinds check `memory.*`).

## Consequences

- **Tests keep the shape.** `approval/hash.test.ts` (pinned vector), `approval/approval.int.test.ts` (test-only kinds:
  hash recomputation, races with `Promise.all`, hash change between view and decide, savepoint rollback, expiry,
  404-hiding, cross-tenant, one-use grants, platform-owned PATCH 403, linked card delegation, list visibility),
  `packages/db` `memory-privacy.int.test.ts` and `rls-isolation.int.test.ts`, and the memory plans' suites.
- **`canDecide` runs per row in the inbox.** `list` scans at most 500 rows per page and answers with a cursor; fine at
  current scale, an index-backed decider set would be the next step.
- **Mirror cards do not notify followers.** A status change made by the mirror is visible in place (`message.updated`)
  but does not create `card_updated` notifications; the decider and requester get `approval_request.updated`.
- **A deleted card message** leaves the request decidable from the inbox (`card_message_id` set null).
- **Real OpenClaw cell.** The container smoke (`memory-files`) runs our plugin in the real cell: the bot reads its
  turn's memory file and proposes a change that ends in a platform-owned approval card, and a call on a turn whose human
  no longer reads the conversation answers `no_trigger`. Both against the fake Agent Channel API; the agent's
  card-action turn after a decision is proven against the fake cell only, like ADR-0020.
- **Leaks are swept, not assumed.** `memory-leaks.int.test.ts` sends one canary through every write path and proves it
  absent from memory and chat search, realtime frames, stored stream events, debug logs, audit and notifications of
  everyone who may not read it, and pins the files that may call `withPersonalOwner`. `memory/cross-tenant.int.test.ts`
  gives every 07.2 route an org-B case through the authz registry.
- **Legacy notes table.** `app.agent_memories` is no longer read and stays as dead data; dropping it needs a later
  migration once the backfill has been in production.

### Upgrade cost

Three forward-only migrations; none rewrites an existing table.

- **`20261013025212_memory_files`.** Five new empty tables with their indexes (one GIN over the STORED `search_tsv`), so
  table and index creation is instant. On existing tables: `message_cards` gains `platform_owned boolean default false
  not null` (a constant default, metadata only since PostgreSQL 11) and `decision_note text`, and `permission_rules`
  gains `path_prefix text`; their two `CHECK` constraints are validated with one sequential scan of each table under an
  `ACCESS EXCLUSIVE` lock (every existing row is null, so the cost is one read of each table, proportional to its size;
  writes to cards wait for it). `post-migrate.sql` adds three SECURITY DEFINER owner functions, their triggers and four
  RESTRICTIVE policies on the new tables only, and revokes `UPDATE`/`TRUNCATE` on revisions and proposals.
- **`20261013031658_memory_notes_backfill`.** Reads `app.agent_memories` once and writes, per distinct (organization,
  bot, human) with notes, one personal scope, one `MEMORY.md` (version 1) and its revision 1, in the migration's
  transaction. Cost grows with the number of (bot, human) pairs that have notes: a note is at most 500 characters and a
  bot kept at most 200 per person (`MEMORY_CAP`), so each file is at most about 100 KB, and each file computes its
  three-config `search_tsv` and a GIN entry at insert. Idempotent (a pair that already has a personal scope is skipped)
  and reversible with the rollback block in the file, which keeps any backfilled scope someone edited since.
- **`20261013095705_memory_scope_immutable`.** One function and one `BEFORE UPDATE OF scope_id` trigger on
  `memory_files`: no scan, and it fires only on a `scope_id` update, which the API never issues.
