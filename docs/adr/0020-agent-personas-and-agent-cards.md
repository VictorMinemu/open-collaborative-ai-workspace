# ADR-0020: Agent personas are unit-scoped principals that answer in AI chats through OpenClaw and post typed Agent Cards

## Status

Accepted (owner decision D-07 in `.planning/phases/06-multiplayer-ai-chat/06-CONTEXT.md`, planner decisions P-04,
P-10 and P-11 in `06-01-PLAN.md`; Phase 6 gate 06-16).
**Date:** 2026-10-07. Builds on [ADR-0007](0007-roles-hierarchy-and-permission-resolver.md) (units, leads, the
resolver), [ADR-0010](0010-personal-bots-capability-model-and-tool-gate.md) (capabilities and the tool gate) and
[ADR-0011](0011-openclaw-marketplace-trust-model-and-mcp.md) (MCP and plugins for bots); companion of
[ADR-0019](0019-multiplayer-ai-chats.md) (multiplayer AI chats). Supersedes nothing.

## Context

Phase 1 made one-click bots first-class principals and Phase 3.1 gave them capabilities and personal bots. Phase 6
asks for full personas (AGENT-01: scope organization / department / team / project / personal, an owner, tools,
created by admins or Team Leads), agents in AI chats (AGENT-02) and typed Agent Cards with Open / Follow / Approve that
update in place (AGENT-04). Principle 9 says OpenClaw talks only to the Agent Channel API, so permissions, identity,
audit and cards are never bypassed; principle 2 says an agent is never "a bot flag on a message".

## Decision

1. **Unit-scoped personas (AGENT-01).** `agents.unit_id` (references `org_units`, `ON DELETE RESTRICT`) scopes a
   shared persona to a department, team or project; no unit means the organization. A personal bot must have an
   owner; a shared persona may have one (by default a unit persona's creator). The unit is read under tenant RLS
   before it is set (the foreign key bypasses RLS), so another organization's unit is 404 `unit_not_found`; deleting a
   unit that still holds personas is 409 `unit_has_bots`.
2. **Lead rights.** `bot.manage_unit` (create, enable, delete in a unit) is granted to admins and, through
   `LEAD_PERMISSIONS`, to unit leads on the subtree they lead, together with `bot.configure` (profile, tools, owner).
   A move needs the right on both places. The `unit_agent` precondition makes a unit persona visible, mentionable and
   reachable by DM only for its subtree's members, the leads on its path, its owner and admins; its realtime events go
   to its readers' `user:` topics, and whoever loses it gets `agent.deleted`.
3. **Personas in AI chats only through OpenClaw (D-07, P-10).** The owner adds a non-personal persona they can
   `bot.read` (`POST /ai-chats/:id/agents`, audited, a notice line). An @mention of it in an AI chat is one flat
   `agent.mention.v1` delivery to the cell (conversation kind `ai_chat`, the whole chat as attributed history with the
   chat model's answers as a system principal "AI assistant (<model>)", the participants as roster, the turn's tools
   and `withheld`); the reply posts flat through `POST /agent-channel/v1/messages`, one per mention, idempotent. A
   message that only addresses a persona never calls the chat model, and a persona never answers through the AI SDK
   loop. Tools follow ADR-0019 decision 7; memory is never offered in an AI chat. Channels, DMs and group DMs keep
   their Phase 3.1/4 behaviour.
4. **Agent Cards in their own table (D-07, P-11).** A card is a `message_cards` row keyed by its message: kind
   (`work_zone`, `approval`, `report`, `artifact`, `automation`, `deployment`, `pr`, `generic`), title, up to 12
   fields, status, up to 4 actions, an optimistic `version`, and the decision. The message body is the card's
   plain-text summary, so search and notifications keep working and card JSON never enters `search_tsv`. Cards are
   posted and updated only through the Agent Channel API (`POST /agent-channel/v1/cards`, `PATCH …/cards/:id`), only
   by the posting agent of the authenticated cell (404 `agent_not_found` for another cell's or another organization's
   agent, 403 `not_card_author`, 409 `card_version_conflict`), with the idempotency namespace `card:<key>`; every
   reader sees the change in place through `message.updated`. One renderer (`AgentCardView`) shows them in channels,
   threads, DMs, group DMs and AI chats, as plain text.
5. **Server-decided actions.** *Open* is an internal route only (`AgentCardRoute`: one of `AGENT_CARD_ROUTE_PREFIXES`,
   no scheme, `//`, backslash, dot segment or control character), re-checked by the client. *Follow* is a
   `message_card_follows` row; followers get a `card_updated` notification when the status changes. *Approve / Deny*
   is one decision per card (`POST /cards/:id/decision`, 409 `card_already_decided`), needing `channel.read` and
   `agent_card.approve` (deny rules win), membership of `approverIds` when the card names approvers, and in an AI
   chat the owner or a `chat` grant (a `view` grantee is 403 `ai_chat_view_only`, never offered decide). The decision
   is audited with ids and outcome and reaches the agent as `agent.card_action.v1`. Viewer fields (`following`,
   `viewerCan`) are computed per caller (`GET /cards/:messageId` for cards that arrived live) and never travel in
   realtime events. Every card route authenticates on request (401 before validation).
6. **The `ocw_agent_card` tool.** The cell plugin offers `ocw_agent_card` on every delivered turn; the tool gate
   (`POST /tool-calls`) decides it like any builtin. Its ids (conversation, thread, reply target) come from the active
   turn, never from the model's parameters; it updates only cards it posted in that conversation, with the version it
   remembers. A decision comes back to the persona as a new turn in the same conversation.

## Consequences

- **Tests keep the shape.** `agent/personas.int.test.ts` (scopes, lead rights, visibility, unit deletion guard,
  cross-tenant units), `agent-channel/ai-chat-delivery.int.test.ts` (flat delivery, attributed history, audience
  tools, no memory), `agent-channel/cards.int.test.ts` (posting, versions, follows, single decisions, view grantees,
  other organizations' cell tokens), `apps/openclaw-channel/src/card-tool.test.ts`, and the e2e specs
  `agent-personas`, `ai-chat-agents`, `agent-cards` and `ai-chat-multiplayer-day`.
- **Card versions live in the cell's memory.** After a cell restart a persona cannot update a card it posted earlier
  (a local refusal); a version in `agent.card_action.v1` or a read route would lift this.
- **Followers are notified once per card.** The notification row is one per (user, message) and only upgrades, so
  later status changes do not re-notify. The inbox says "updated a card you follow" with the summary (notifications
  carry no card title). Pins and Saved show a card message as its summary.
- **Open: proof against a real OpenClaw cell.** No OpenClaw container runs on an executor's machine and CI is
  blocked by GitHub billing, so the flat AI chat delivery, the `withheld` block in `ChannelStructuredContext`, the
  gate refusing a withheld tool and the smoke scenario `card` (`infra/openclaw/test/run-container-smoke.sh`) are
  proven only against the fake cell and the plugin's contract harness. The real-cell smokes run when CI comes back.
- **Open: personas count as sharing.** ADR-0019 Consequences (D-06, the orchestrator's decision under the owner's
  delegated autonomy) awaits the owner's confirmation.
