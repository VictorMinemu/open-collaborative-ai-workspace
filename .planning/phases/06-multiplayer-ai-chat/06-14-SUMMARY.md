---
phase: 06-multiplayer-ai-chat
plan: 14
subsystem: openclaw-channel (card tool, card-action turns), api (turn policy), contracts
status: complete
tags: [agents, agent-cards, openclaw, tool-gate, tracer]
requires:
  - "06-13: POST/PATCH /agent-channel/v1/cards (cell-agent check, card:<key> idempotency, 409 card_version_conflict), agent.card_action.v1 built like a mention with turnPolicy"
  - "03.1: tool gate (before_tool_call in registerCapabilities, POST /tool-calls), memory-tool pattern, openclaw-host contract harness"
provides:
  - "BUILTIN_TOOLS.agentCard = ocw_agent_card, offered by assemble() on every delivered turn and in the cell-wide view (alsoAllow), flags {untrustedOutput:false, sideEffecting:false}"
  - "Plugin: card-tool.ts (CARD_TOOL_NAME, registerCardTool), AgentChannelClient.postCard/patchCard, AgentChannelHttpError.code, manifest contracts.tools += ocw_agent_card"
  - "Plugin: mapCardAction + sanitizeCardTitle (mention-mapper.ts); bridge.handleFrame dispatches agent.card_action.v1 through the mention path (handleCardAction)"
  - "ActiveTurn.threadRootId / messageId (the reply target the card tool binds to), set by openclaw-port"
  - "Fake Agent Channel API: POST /cards, PATCH /cards/:id (cards, cardPatches); cell-smoke scenario card"
affects: [06-15 (renderer shows cards personas now post), 06-16 (security matrix: card tool binding, gate on ocw_agent_card)]
tech-stack:
  added: []
  patterns:
    - "Tool binding from the trusted turn: ids come from the active turn (session key / conversation), never from params; unknown param keys are stripped"
    - "Per-tool-call idempotency <eventId>:card:<n>: a new call gets n+1, an OpenClaw retry of the same toolCallId reuses its n"
    - "Process-wide tool state under Symbol.for (as the gate), so every registry instance shares turns, call counters and card versions"
key-files:
  created:
    - apps/openclaw-channel/src/card-tool.ts
    - apps/openclaw-channel/src/card-tool.test.ts
    - infra/openclaw/test/mention-card.json
  modified:
    - packages/contracts/src/bot-capabilities.ts
    - apps/api/src/modules/bot-capabilities/turn-policy.ts
    - apps/api/src/modules/agent-channel/cards.int.test.ts
    - apps/openclaw-channel/{openclaw.plugin.json,src/agent-channel-protocol.ts,src/api-client.ts,src/register-full.ts,src/index.ts}
    - apps/openclaw-channel/src/{mention-mapper.ts,mention-mapper.test.ts,bridge.ts,plugin-contract.test.ts,openclaw-registration.test.ts}
    - apps/openclaw-channel/src/{tool-guard.ts,openclaw-port.ts,testing/fake-agent-channel-api.ts}
    - infra/openclaw/test/run-container-smoke.sh, infra/openclaw/README.md
    - "ripple: apps/api capabilities.int, mcp.int, agent-channel.int; e2e bot-capabilities/marketplace/mcp-servers specs"
decisions:
  - "ocw_agent_card is not self-validated: the gate asks POST /tool-calls for it (audited as a builtin, fail closed), then the tool posts through /cards"
  - "Flags {untrustedOutput:false, sideEffecting:false} as planned: a card lands only in the turn's own conversation, like the reply, so it stays usable after web content"
  - "A create answers 'Card posted. Card id: <id> …' (the id only, never the API body): the persona needs it to update the card later"
  - "Updates are allowed only for a card this cell posted or updated in the same conversation (process-wide memory keyed by agent+card); the version sent is the one remembered, never the model's"
  - "The card tool lives in registerFull next to ocw_memory_save (plugin tools resolve from the boot / tool-discovery registry); the gate stays in registerCapabilities, proven in the turn (discovery) registry by openclaw-registration.test.ts"
metrics:
  duration: "~1h20m"
  completed: 2026-10-07
estimate:
  tokens: 140000
actuals:
  tokens: 28000
  tasks: 2
  commits: 5
---

# Phase 6 Plan 14: ocw_agent_card tool and card-action turns Summary

Personas in the OpenClaw cell now post and update typed Agent Cards themselves through a gated `ocw_agent_card` tool bound to the conversation, thread and message of the turn they are answering, and a human's approval or denial of a card comes back to the persona as a new turn in the same conversation.

## What was built

- **Contracts / API:** `BUILTIN_TOOLS.agentCard = "ocw_agent_card"`; `assemble()` adds it to every turn (channel, thread, DM, group DM, AI chat, card-action turns) and to the cell-wide view, so `GET /cell` lists it in each enabled bot's `alsoAllow`. The gate (`POST /tool-calls`) treats it as a builtin automatically (`BUILTIN_NAMES` follows `BUILTIN_TOOLS`), re-decides it with the current policy and audits `bot.tool_call`.
- **Plugin tool (`card-tool.ts`):** `create` → `client.postCard({agentId, conversationId, threadRootId, inReplyToMessageId, idempotencyKey: "<eventId>:card:<n>", card})` with every id from the active turn; `update` → `client.patchCard(cardId, {agentId, patch: {...patch, expectedVersion: <remembered>}})`. Local refusals (no request) for no turn, a turn that does not offer it, another bot's context, an invalid card (field path only), an Open target that is not an internal route ("never to an external link"), and a card this bot did not post in this conversation. Fixed answers: "Card posted. …", "Card updated.", "The card changed since you last saw it; not updated.", short refusals per status. Logs: ids and `status/code` only.
- **Client:** `postCard` / `patchCard` (two attempts at most), `PATCH` support, `AgentChannelHttpError.code` (only a well-formed snake_case `error.code`).
- **Card actions:** `mapCardAction` re-parses the event, maps it with `mapMention` (deciding human = sender, server sentence = body, roster, history, thread in a channel / flat in DM and AI chat, the turn's tools) and adds a "Decision on your card" block `{card: {messageId, kind, title}, outcome}` with a sanitised title (one line, URLs replaced by "[link removed]", ≤200 chars). `bridge.handleFrame` parses `agent.card_action.v1` and dispatches it through the mention path (typing, reply target, retries, failure notice); an invalid payload is skipped with `seq` and the field path only.
- **Smoke:** scenario `card` in `run-container-smoke.sh` (create through the gate and `/cards`, then a card action that updates the card with the remembered version); `FAKE_AGENT_TOOLS` includes `ocw_agent_card`.

## Verification

- `pnpm typecheck --force`: 8/8 tasks.
- `pnpm --filter @ocw/openclaw-channel test`: 16 files, 231 tests (card-tool 11, registration incl. 3 card-in-turn cases, contract incl. port binding and card-action dispatch, mapper 4 new).
- `cards.int.test.ts`: 30/30 (5 new; real PostgreSQL + Redis, fake cell, no provider call). RED run before the change: 4 failed as expected.
- Ripple integration files, one at a time: capabilities.int 23/23, mcp.int 19/19, agent-channel.int 23/23, memory.int 13/13, ai-chat-delivery.int 12/12, mcp-cell.int 14/14, plugins-cell.int 12/12, tool-calls.int 12/12.
- `node --test 'infra/**/*.test.mjs'`: 129/129.
- `pnpm verify`: exit 0 (lint clean except the 4 pre-existing local-runtime warnings; typecheck; 182 files / 2573 tests, integration included).
- Acceptance greps: `ocw_agent_card` in openclaw.plugin.json and bot-capabilities.ts; `export function registerCardTool` in card-tool.ts; `export function mapCardAction` in mention-mapper.ts; `cardAction` in bridge.ts.

## Deviations from Plan

1. **[Rule 3 - Blocking] `ActiveTurn` carries the reply target.** The active turn knew only `eventId`, `agentId` and `conversationId`; the card needs `threadRootId` and `inReplyToMessageId`. `tool-guard.ts` (`ActiveTurn.threadRootId?`, `messageId?`) and `openclaw-port.ts` (passes `m.threadRootId`, `m.messageId` to `beginTurn`) changed; the card tool refuses when the binding is missing. Files outside the plan's list.
2. **[Rule 3] Exact tool-list assertions elsewhere.** Offering the tool on every turn changed exact `turn.tools` / `capabilities.tools` / `[turn tools: …]` expectations: capabilities.int (incl. a jsonb key-order fix), mcp.int, agent-channel.int and three e2e specs (bot-capabilities, marketplace, mcp-servers). The e2e specs were updated but not run (no e2e run in this plan).
3. **[Rule 2] Update binding.** `PATCH /cards` does not check the conversation, so the plugin only updates cards it posted (or updated) in the active turn's conversation; otherwise the model could steer an update to a card in another conversation (T-06-14-01).
4. **Create answer includes the card id** ("Card posted. Card id: <id> …"), not just "Card posted.": without it the persona cannot update its card. Never the API body.
5. **Fake Agent Channel API gained `/cards` routes** and a parity test pins the plugin's Agent Card mirror (kinds, statuses, route prefixes, internal-route rule) to `packages/contracts/src/agent-cards.ts`.
6. **Smoke scenario added, real-cell proof pending:** no OpenClaw container may run locally and CI is unavailable, so `SMOKE_ONLY=card` has not run in a real cell.

## Known limitations / open issues

- Card versions live in the cell process memory: after a cell restart (or for a card posted before it), the persona cannot update that card (local refusal). A version in `agent.card_action.v1` or a read route would lift this.
- A retried `PATCH` whose first attempt succeeded server-side answers the conflict text (two attempts, same expected version).
- Card calls count toward the turn's `maxToolCalls` (8).

## Broken-windows ledger (single line; not written by this executor)

`gsd windows append --kind unrun-verify --phase 06 --file infra/openclaw/test/run-container-smoke.sh --description "06-14 cell-smoke scenario card (ocw_agent_card create/update, agent.card_action.v1 turn) not yet run in a real OpenClaw cell; e2e specs updated for ocw_agent_card not run"`

## Commits

- 60e3c17 test(openclaw-channel): failing ocw_agent_card tool, turn binding and turn-policy cases (06-14)
- 218cfa7 feat(openclaw-channel): personas post and update Agent Cards through a gated ocw_agent_card tool (06-14)
- 19a2eb2 test(openclaw-channel): failing agent.card_action.v1 mapping and dispatch cases (06-14)
- bd2f4f7 feat(openclaw-channel): card decisions reach the persona as a turn in the same conversation (06-14)
- 2b05a35 test(infra): cell-smoke scenario card: ocw_agent_card through the gate and POST /cards, card action as a turn (06-14)

## TDD Gate Compliance

RED → GREEN pairs in git log for both tasks (60e3c17 → 218cfa7, 19a2eb2 → bd2f4f7).

## Threat Flags

None beyond the plan's register: the tool adds no route; it uses the 06-13 card routes through the existing gate.

## Self-Check: PASSED

Files exist (card-tool.ts, card-tool.test.ts, mention-card.json, this summary); commits 60e3c17, 218cfa7, 19a2eb2, bd2f4f7, 2b05a35 present on wt/06-14; `pnpm verify`, the plugin suite and the infra node tests green.
