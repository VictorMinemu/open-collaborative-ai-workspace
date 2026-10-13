# ADR-0022: Board channels are channels with a board layout; cards are thread roots; record templates name them

## Status

Accepted (owner decisions D-01 to D-08 in
`.planning/phases/07.1-board-channels-and-record-templates/07.1-CONTEXT.md`, planner decisions P-01 to P-15 in
`07.1-01-PLAN.md`, UI contract `07.1-UI-SPEC.md`; Phase 07.1 gate 07.1-14).
**Date:** 2026-10-12. Builds on [ADR-0003](0003-infrastructure-baseline.md) (PostgreSQL, RLS, Redis),
[ADR-0007](0007-roles-hierarchy-and-permission-resolver.md) (units, grains, the resolver),
[ADR-0010](0010-personal-bots-capability-model-and-tool-gate.md) (turn tools, taint, the tool budget),
[ADR-0016](0016-chat-search-and-renderer.md) (chat search over message bodies),
[ADR-0018](0018-ai-chat-run-loop-and-model-gateway.md) (no model call without a usage kind and a payer) and
[ADR-0020](0020-agent-personas-and-agent-cards.md) (agents act through the Agent Channel API). Follows
[ADR-0024](0024-module-access-per-unit.md) (module access, Phase 07.3), which landed first. Supersedes nothing.

## Context

The operations meeting behind `.planning/research/OPS-FEATURES.md` asked for structured work inside chat: case files,
orders, tickets and candidates as boards whose cards are conversations with their people and agents (F12), and record
templates that give every card of a kind the same fields, columns and name (F14). Keeping that work in a separate
tool would split each case's history from its discussion and put it outside the Control Plane's permissions, audit and
agents. Syncing columns with external systems is out of scope (backlog OPS-BL-04); watched records are Phase 07.6.

## Decision

1. **A board is a channel with `layout = 'board'` (D-01).** `conversations.layout` is `text` or `board` and only a
   `kind = 'channel'` row may be `board` (a check constraint). There is no new conversation kind, because about 35
   sites switch on `kind`. A board inherits everything from its channel: members, visibility, unit, sidebar, archive,
   permissions, notifications and search. The layout is chosen at creation (`POST /channels`, the create-channel
   dialog) and does not change.
2. **Tables and the card-as-root rule (D-02).** Migration `20261010010825_board_channels` adds four tables under
   forced RLS: `boards` (keyed by the conversation, holding the snapshot of the naming rule, prefix, fields and the
   per-board counter), `board_columns` (name, rank, category `backlog | started | done | cancelled`,
   `default_waiting_on`, reserved `external_state_id`), `board_cards` (keyed by the root `message_id`; column, rank,
   `waiting_on` `none | us | customer | both`, title and `title_source`, description, number, typed `fields`, reserved
   `external_ref`, `version`) and `record_templates`. A card **is** the root message of an ordinary thread. Its body is
   the plain-text `cardMessageBody` (title, description, field lines), so chat search, notifications, permalinks and
   the Messages view work unchanged and no card JSON enters `search_tsv`. Integrity lives in the database:
   composite foreign keys tie a card to a column of the same board, `(column_id, conversation_id)` with RESTRICT, and to
   a root message of the same conversation, `(message_id, conversation_id)` with CASCADE, and a column to a board.
   - **The extra index on `messages`.** A composite foreign key needs a unique index on exactly the columns it
     references, so the migration adds `messages_id_conversation_uq` UNIQUE `(id, conversation_id)`. It cannot
     conflict, because `id` is already the primary key, but it is not free: it is a second btree on `messages`, and
     every message insert maintains it. **It is built once when an existing install upgrades, inside the migration
     transaction, and blocks writes to `messages` while it builds**, which takes longer on a large message table.
     There is no cheaper way to get a composite foreign key target; the N-1 upgrade test and the schema guard pass
     with it.
3. **Ranks are minted by the server only, under the stream lock (D-05).** Columns and cards are ordered by fractional
   keys from `fractional-indexing` 4.0.0, imported only in `chat/board/rank.ts`. Both rank columns are
   `COLLATE "C"`, so `ORDER BY rank` in SQL equals JavaScript's string order. Every board writer takes the
   conversation's stream lock first (`lockNextSeq` on `conv:<id>`), then the card row, checks the optimistic
   `expectedVersion` (a stale one is 409 `board_card_version_conflict` with the current card in `error.details.card`),
   reads the neighbours in `rank COLLATE "C", message_id` order and asks `keyBetween` for a key. A tie, inverted or
   corrupt neighbours, or a key over 64 characters re-rank the whole column with fresh keys and one
   `board.column_reranked` event (no version bump). Clients never send a rank, only an intent
   `{ columnId, afterCardId }`. A message delete on a card root takes the same stream lock before the message row, so
   a delete racing a card text edit queues instead of deadlocking (07.1-14).
4. **Events on `conv:` only, one cursor (D-03, P-06).** `board.card_upserted` (one card), `board.updated` (the board
   and its full ordered column list) and `board.column_reranked` (one column's new ranks) are durable events on the
   channel's own `conv:<id>` stream, with seq and cursor replay. Card removal rides `message.deleted` and reply counts
   ride `thread.updated`. The web keeps one subscription per channel (`boardAfterSeq` of the messages and board
   cursors). Frames at or below the snapshot's `lastSeq` are skipped, and a card is replaced only by a newer version.
   The realtime client follows the browser's `online` / `offline` events, so an offline tab shows the board's
   connection banner and catches up by replay.
5. **Who may do what (D-07, P-02, P-09).** Reading needs `channel.read` (hidden equals missing, 404). Creating cards,
   moving them and setting their waiting state need `channel.post` on a live board (410 `channel_archived` otherwise).
   A card whose text uses `@channel` or `@here` also needs `channel.mention_all` and the channel's one-per-minute gate,
   claimed only after the card is validated. Card text (title, description, fields) belongs to the card's human
   author, as Phase 4 decided for messages: nobody else edits it, admins included (403 `not_author`). Every text edit
   goes through chat's `editMessage` (version history, the "edited" marker); an edit never broadcasts `@channel`, and
   the generic `PATCH /messages/:id` refuses card roots (400 `board_card_use_board`). Deleting a card is the message
   delete: its author, or `message.delete_any`. Columns are managed with `channel.update` (the channel's owner or an
   admin): at most 20, names unique per board, the last column cannot go, and a non-empty column is deleted only with
   a `moveCardsTo` target. Templates use the unit grains: `unit.members.manage` on the template's unit, `unit.manage`
   for organization-wide ones, and `unit.read` to list them. No new permission was added.
6. **Agents only through the Agent Channel (D-07, principle 9).** `agent-channel/board.ts` serves
   `POST /agent-channel/v1/board/read`, `POST /agent-channel/v1/board/cards` and
   `PATCH /agent-channel/v1/board/cards/:messageId`. The conversation and the human come from `agent_turns`, never
   from the request. A call that answers no live turn of this agent is 403 `no_trigger`, the PR #25 rule. Each call is
   decided for the agent and for the agent acting for the turn's human, counted against the turn's tool budget before
   it acts, refused once the turn is tainted, and audited with both the agent and the human. Agents create cards, move
   them and set their waiting state; they never edit card text (P-03). The plugin tool `ocw_board_card` is offered
   only on a board channel's turns (`turn-policy.ts`), is self-validated by the plugin's tool guard, and reaches
   OpenClaw 2026.9.7 through the bot's own `alsoAllow`, because a bot's `alsoAllow` replaces the global one. **An agent
   may move a card or set its waiting state only on the turn thread's card or on a card it created in this
   conversation**, because `/board/read` returns only the thread card's version and the API needs `expectedVersion`.
   Every refusal is audited as `agent.board.refused` (ids and reasons only).
7. **Record templates are snapshots along the unit path (D-06, P-08).** A template belongs to a unit or to the whole
   organization. It has typed fields (text, number, date, select), default columns with a category and an initial
   waiting state, a prefix and a naming rule. A board created in unit U may use templates of U, of U's ancestors or
   organization-wide ones; any other id, including another organization's, is a uniform 400
   `template_not_available`. Creation snapshots the rule, prefix and fields into `boards` and copies the columns, so
   later template edits and deletes affect new boards only. Edits are versioned (409 `template_version_conflict` with
   the current template).
8. **Deterministic titles (D-06, D-08).** The naming rule is a fixed token grammar: `{prefix}`, `{seq}` or
   `{seq:0000}`, `{field:<key>}` and `{summary}` (the description's first line). An empty token is dropped together with the separator
   before it, so `EXP-0007 · Acme · Broken pump` never becomes `EXP-0007 ·  · Broken pump`. Numbers come from the
   board's counter under the stream lock, only on prefixed boards. A typed title (`title_source = 'user'`) is never
   replaced: a SQL `CASE` on `title_source` inside the version-guarded update recomputes only automatic titles. A
   model-written summary is deferred. There is no usage kind or payer rule for it under ADR-0018, and a board must
   not spend anyone's plan behind their back.
9. **Drag and drop on `@dnd-kit/react` 0.5.0 (D-04, P-05).** The spike was 07.1-08's tracer: focus the grip, Space,
   ArrowRight, Space moves a card into an empty lane and the live region reads "“Broken pump” dropped in In progress,
   position 1 of 1". It passed on `@dnd-kit/react` and `@dnd-kit/helpers` 0.5.0, pinned exactly, so the approved
   fallback (`@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0) was not installed. dnd-kit is imported only in
   `board-view.tsx` and `sortable-card.tsx`. Two 0.5.0 caveats are handled there: the `Accessibility` plugin is
   configured by replacing its entry in the default plugin list (the class is not re-exported), and the cancel
   announcement reads the start column from the board's own drag-start map. Pointer drags start after 5 px, touch after
   a 250 ms long-press, and every card also has **Move to…**, Move to top and Move to bottom. At 390 the columns are
   tabs.
10. **Accessibility is checked, not assumed.** `@axe-core/playwright` 4.13.0 runs in the e2e specs and fails on any
    serious or critical violation: the board, menus, dialogs, the card strip, the template editor and the offline
    banner, in both themes and at 1440 and 390. At the gate it found that white text on the dark `--primary` measured
    3.44:1. The dark theme now fills primary buttons with `oklch(0.565 0.19 278)` (white text 4.7:1). `text-primary`
    keeps the lighter `oklch(0.64 0.19 278)` (5.5:1 on the background) through a text-only token,
    `--text-color-primary`. Light mode is unchanged.

**Audit actions added by this phase:** `board.card.created`, `board.card.moved`, `board.card.updated`,
`board.column.created`, `board.column.updated`, `board.column.deleted`, `record_template.created`,
`record_template.updated`, `record_template.deleted` and `agent.board.refused`. `channel.created` gains `layout` and
`templateId`. Every one carries ids, categories, versions, counts and booleans only, never a title, description, field
value, column name or template name.

## Consequences

- **Tests keep the shape.** API (`chat/board/`): `board.int`, `board-concurrency.int`, `board-access.int`,
  `card-edit.int`, `columns.int`, `templates.int`, and `cross-tenant.int`, the guard that lists every registered
  `/api/v1/boards*`, `/api/v1/record-templates*` and `/agent-channel/v1/board*` route from the authz registry and fails
  when one has no org-B case. Agents: `agent-channel/board.int`, `openclaw-channel/src/board-tool.test.ts`, the
  real-cell smoke scenario `board`. Web and e2e: `board-queries.test`, `board-view.test`, `board-manage.test`,
  `record-template-form.test`, and the specs `board-channels`, `board-live`, `board-manage`, `board-agents`,
  `record-templates` and `theme-contrast`. Contracts and DB: `board.test`, `rank.test`, `rls-isolation.int` (collation
  and constraints) and the N-1 upgrade test.
- **What later phases inherit.** Phase 07.6 (watched records) writes `board_cards.external_ref`. OPS-BL-04 (column sync
  with external systems) writes `board_columns.external_state_id`. Phase 07.1 never writes either.
- **Limits.** 20 columns and 20 fields per board; the snapshot returns 100 cards per column with `hasMore` and a paging
  route ("Show more cards"); one re-rank event carries a whole column, up to 10,000 ranks. Move to bottom in a column
  past its first 100 cards lands after the last loaded card. A card permalink beyond the first 100 of its column
  opens in the Messages view, not over the board.
- **Upgrade.** The migration is forward-only. Existing channels read `layout = 'text'`. Building
  `messages_id_conversation_uq` blocks message writes for the length of the build (decision 2): plan the upgrade of a
  large install for a quiet moment.
- **Agents.** Each board call spends one of the turn's tool calls, reads included, so a move by the plugin can cost
  one extra read. A future read that returns any card's version, or a patch of "the turn's card" without a version,
  would lift both that cost and the thread-card-only rule of decision 6.
- **Open.** The real ops board run on a phone and a laptop (DEMO.md › Board channels and record templates › Owner
  check). Dark destructive buttons (white on `--destructive`, about 3.3:1) have the same contrast problem as primary
  buttons had; that fix belongs to a design pass, not this phase. The realtime client still has no pong deadline, so
  a socket that dies silently while the browser reports online stays "Live" until TCP gives up.
