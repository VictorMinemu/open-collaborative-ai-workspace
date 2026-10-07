---
phase: 06-multiplayer-ai-chat
plan: 10
subsystem: api (ai-chat members, agent-channel delivery, bot-capabilities turn policy), contracts, openclaw-channel
status: complete
tags: [multiplayer-ai, agents, personas, openclaw, tools, memory, tracer]
requires:
  - "06-01: AiParticipant, AiChatParticipants, AddAiChatAgentRequest, AiAgentParams"
  - "06-02/06-04: aiAccessSql/aiAccessOf, addMember/removeMember, postNotice"
  - "06-05: persona rows rendered as kind=\"agent\" blocks in the model prompt"
  - "06-06: isMultiplayer, addressedOf, sendShared; 06-07: unit personas behind bot.read; 06-08: emitChatUpdated, ai_chat in chat events"
provides:
  - "GET /api/v1/ai-chats/:id/participants, POST /api/v1/ai-chats/:id/agents, DELETE /api/v1/ai-chats/:id/agents/:agentId"
  - "participantsOf, audienceOf (ai-chat public index); answerModelsOf (model of each assistant message)"
  - "AI chat sends dispatch one flat agent.mention.v1 per mentioned member persona (conversation kind ai_chat)"
  - "Member agents post into AI chats through POST /agent-channel/v1/messages (flat), refreshing every sidebar"
  - "TurnContext.withheld (add-only) + turnPolicy/currentTurnTools audience; tool gate re-decides AI chat turns with today's audience"
  - "Plugin: ai_chat mapped flat with an AI chat label, one OpenClaw session per mention, 'Tools withheld in this conversation' block"
affects: [06-11 (persona messages arrive as message.created with an agent author), 06-12 (UI to add/remove personas uses these routes), 06-16]
tech-stack:
  added: []
  patterns:
    - "Audience-aware tools: catalog tools need bot.tool.use for every listed reader (agent on behalf of each) and no unit/org grant"
    - "Per-mention OpenClaw session in shared chats: no transcript (or tool result) is reused across askers"
key-files:
  created:
    - apps/api/src/modules/ai-chat/members.ts
    - apps/api/src/modules/agent-channel/ai-chat-delivery.int.test.ts
  modified:
    - apps/api/src/modules/ai-chat/{index,service,dto}.ts
    - apps/api/src/modules/chat/index.ts
    - apps/api/src/modules/organization/permissions/policy.ts
    - apps/api/src/modules/agent-channel/{mentions,index,tool-calls}.ts
    - apps/api/src/modules/bot-capabilities/{turn-policy,index}.ts
    - apps/api/src/app.ts
    - packages/contracts/src/bot-capabilities.ts
    - apps/openclaw-channel/src/{agent-channel-protocol,mention-mapper,openclaw-port}.ts
    - apps/openclaw-channel/src/{mention-mapper,plugin-contract}.test.ts
    - e2e/support/fake-cell-plugin.ts
decisions:
  - "A persona in an AI chat runs each mention in its own OpenClaw session (sessionThreadId = the message) while replying flat: the attributed chat history is its only memory of earlier turns"
  - "Web tools follow the asker only (public pages); MCP/plugin tools follow every listed reader; web denied for the asker alone is also listed as withheld (denied_for_you)"
  - "The tool gate re-decides an AI chat turn with the audience at call time, so a team/org grant or a participant's deny added mid-turn withdraws scoped tools (policy_changed)"
  - "Group DM mapping in the plugin is unchanged (thread-scoped sessions, server-side flattening); only ai_chat is newly flat"
  - "The chat model's answers in persona history are {kind: system, id: <conversationId>, displayName: 'AI assistant (<model label>)'}; streaming/empty placeholders and notices are left out"
metrics:
  duration: "~1h50m"
  completed: 2026-10-07
estimate:
  tokens: 180000
actuals:
  tokens: 15400   # chars/4 over the added lines of the diff (61 499 chars)
  tasks: 2
  commits: 5
---

# Phase 6 Plan 10: Agent personas in AI chats Summary

Owners can now add team personas to an AI chat. Any participant can @mention a persona; it answers through the Agent Channel API and the OpenClaw cell with one flat reply per mention. It sees the whole chat with every author attributed (the model's answers appear as "AI assistant (<model>)") and the participants as its roster. In a shared chat, MCP and plugin tools are offered only when every listed reader may use them, and never once a team, department or the organization holds a grant. What was withheld travels in `turn.withheld`, so the persona can explain it. No AI chat delivery ever carries memory. Channels, 1:1 DMs and group DMs deliver exactly as before.

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | Members API → send dispatch → Agent Channel event → fake cell → flat post → conv stream (tracer, TDD) | b11fcea (RED), 8b64764 (GREEN) |
| 2 | Tools = persona ∩ asker ∩ every reader, `turn.withheld`, no memory (TDD) | 8b79fcd, 5c04491 (RED), ccc6019 (GREEN) |

## What changed

- **Members (`ai-chat/members.ts`).**
  - `GET /participants` needs `channel.read`. It lists the owner first, then the humans who can still read the chat, then the member agents. `audience` is `listed`, `units` or `organization`.
  - `POST /agents` needs `ai_chat.manage`, so anyone but the owner gets the chat's 404. The bot must exist and not be deleted (404), and the owner needs `bot.read` on it (hidden 404, which covers unit personas). A personal bot is 400 `personal_bot_not_allowed`, a disabled one 400 `agent_disabled`, an archived chat 410.
  - Adding a persona that is already a member returns 200. A new one returns 201, writes the notice "Víctor Ruiz added @backend to this chat" and audits `ai_chat.agent_added` with ids only.
  - `DELETE` removes the persona, writes the notice "… removed @backend from this chat" and audits `ai_chat.agent_removed`.
  - Both writes are rate-limited at 60 per minute per user.
- **Dispatch (`ai-chat/service.ts`).** A shared send emits one `emitAgentMention` with `delivery: "dm"` and root = the message, inside the send transaction. It covers every mentioned persona that is a member, live, not personal, and visible to the author through `bot.read`. A message that mentions only a persona is `not_addressed`, so the model is never called. Persona rows in snapshots and pages render with the agent directory.
- **Posting (`chat/index.ts`, `policy.ts`).**
  - The `AI_CHAT_FIXED` precondition now lets `channel.post` through for an agent principal that holds the `member` relation. Humans still write only through the ai-chat routes.
  - `providePostAgentMessage` now loads AI chats too. `isDirect` covers `ai_chat`, so replies stay flat even when a thread root is passed. Chat events receive kind `ai_chat`.
  - The confused-deputy check is unchanged: the answered human must still be able to read the chat.
  - A new `registerPersonaActivity` observer bumps the chat and sends `emitChatUpdated` to every participant.
- **Delivery (`agent-channel/mentions.ts`).** For `ai_chat`, the history is the whole conversation, capped at 50 entries. It excludes the current message, tombstones, notices and empty streaming placeholders. The model's rows come from the system principal, and the roster comes from `participantsOf`. `turnPolicy` receives `{audience: audienceOf(...)}`. `createAgentChannelModule` takes `modelLabel` from the gateway, the same pattern search uses.
- **Turn policy (`bot-capabilities/turn-policy.ts`).**
  - With an audience, a catalog tool the asker is denied is withheld as `denied_for_you`. If the audience is unbounded (a unit or org grant), it is withheld as `shared_with_group`. Otherwise it needs `bot.tool.use` for every other reader, with the agent acting on behalf of each; if anyone fails, it is withheld as `not_every_participant`.
  - Web tools follow the asker only.
  - Memory stays off because the kind is `ai_chat`.
  - Without an audience the turn is byte-identical, with no `withheld` key.
- **Tool gate (`tool-calls.ts`).** An AI chat turn is re-decided with the audience at call time.
- **Plugin.**
  - `TurnContext.withheld` is optional and degrades to `undefined` if invalid, so the turn is kept. It never enables a tool.
  - `ai_chat` is flat: `conv:<id>` as target, label `AI chat “<name>”`, "Conversation history", and a shared-AI-chat persona line.
  - `sessionThreadId` gives one session per mention.
  - `withheld` renders as "Tools withheld in this conversation: <tool> — <reason in words>".

## Verification

- **RED first.** `ai-chat-delivery.int` failed 7/7 for Task 1, and the Task 2 additions failed 5/5 (the memory case already held). Mapper tests failed 1 (Task 1) and 2 (Task 2) before implementation.
- **`ai-chat-delivery.int.test.ts`:** 12/12 on PostgreSQL + Redis with the fake model and `FakeCellPlugin`. Covered:
  - add, list and refusals;
  - one flat delivery with no model call;
  - attributed history and roster;
  - the reply on `conv:`, in the snapshot, idempotent and flat;
  - Sam gets 404;
  - the next model prompt shows `kind="agent"`;
  - removal: no delivery and 403 on post;
  - tools for both / Víctor denied / Alex denied / team grant, plus the gate refusing `not_in_turn` and `policy_changed` mid-turn;
  - Riley via the team grant;
  - a solo owner + persona chat without memory.
- **Plugin:** `pnpm --filter @ocw/openclaw-channel test` 15 files, 210 tests (mapper 20, plus a contract test for a flat AI chat reply and typing with one session per mention).
- **Regressions, run one at a time:**

  | Suite | Result |
  |-------|--------|
  | agent-channel | 23/23 |
  | group-dm | 12/12 |
  | tool-calls | 12/12 |
  | memory | 13/13 |
  | mcp-cell | 14/14 |
  | plugins-cell | 12/12 |
  | capabilities | 23/23 |
  | reply-mode | 14/14 |
  | dm | 16/16 |
  | dm-privacy | 12/12 |
  | team-dm | 7/7 |
  | personal | 15/15 |
  | personas | 19/19 |
  | multiplayer | 17/17 |
  | queue | 13/13 |
  | shared | 17/17 |
  | grants | 15/15 |
  | prompt-matrix | 9/9 |
  | ai-chat | 20/20 |
  | security | 5/5 |
  | organization unit | 102/102 |

- **`pnpm typecheck --force`:** 8/8.
- **`pnpm verify`:** exit 0. 180 files, 2522 tests; lint shows only the 4 existing local-runtime warnings.
- **`node --test 'infra/**/*.test.mjs'`:** 129/129.
- **Isolated e2e** (`scripts/e2e-isolated.sh bots.spec team-bot-dm bot-capabilities bot-memory personal-bots agent-personas dms chat.spec ai-chat.spec ai-chat-multiplayer ai-chat-share`): 43 passed across 12 specs on desktop + mobile, 0 flaky. The plan has no e2e spec of its own; the UI lands in 06-12. The `.env` symlink was removed afterwards.
- **Acceptance greps:**
  - `registerMemberRoutes` appears in `ai-chat/index.ts`.
  - `"ai_chat"`, through the `AI_CHAT` const, appears in `mention-mapper.ts`.
  - `AI assistant (` appears in `mentions.ts`.
  - `withheld` appears in both the contracts and `turn-policy.ts`.
  - `shared_with_group` appears in `turn-policy.ts`.

## Deviations from Plan

1. **[Rule 2 - Security] One OpenClaw session per mention in AI chats (`sessionThreadId`, `openclaw-port.ts` outside the file list).**
   - The reply is flat as planned, but a per-conversation session would keep one asker's raw tool results in the transcript for later askers, including people who join after a team grant (T-06-10-01).
   - Each mention now starts from the attributed chat history only.
2. **[Rule 2 - Security] The tool gate re-decides AI chat turns with the current audience (`tool-calls.ts`, outside the list).**
   - Without this, a team grant added mid-turn would still allow a scoped tool that was already delivered. It now returns `policy_changed`, which is tested.
3. **[Plan conflict] Group DM mapping is unchanged.**
   - The action text said `dm`, `group` and `ai_chat` map flat. The behaviour text said "dm and group mapping unchanged" and the threat register forbids delivery changes, so only `ai_chat` is new.
   - Group replies were already flattened server-side.
4. **[Rule 2] Web withheld for the asker.** When the bot has internet but the asker is denied it, `web_search` and `web_fetch` are listed as `denied_for_you` in AI chats, so the persona can explain this too.
5. **[Rule 2] Sidebar activity for persona replies (`registerPersonaActivity`).** Persona posts bump the chat and send `ai_chat.updated` to every participant, as 06-08 does for human and model messages.
6. **[Rule 3] Wiring outside the list:**
   - `app.ts` and `agent-channel/index.ts` pass the model label (same pattern as search).
   - `bot-capabilities/index.ts` exports `TurnAudience`.
   - `ai-chat/dto.ts` gains `answerModelsOf`.
   - `e2e/support/fake-cell-plugin.ts` replies flat in `ai_chat`, like the plugin.
7. **[Note] Plugin `withheld` schema.** The plugin keeps `reason` as a string and drops an invalid list without dropping the turn. The API contract keeps the strict enum.
8. **[Note] Plan mode.** CLAUDE.md asks for plan mode on permission changes. The `channel.post` exception is the one the plan specifies, and the owner had delegated approval.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-06-10-01 through 05 are mitigated and tested; see deviations 1 and 2 for the hardening of T-06-10-01.

## Open items

- **Real-cell proof is pending.** The CI `cell-smoke` / `cell-proof` job is unavailable (GitHub Actions billing), and OpenClaw containers are never started locally. Still to check against OpenClaw 2026.9.7: an `ai_chat` mention dispatches flat with a per-mention session, the withheld block reaches `ChannelStructuredContext`, and the gate refuses a withheld tool.
- **Owner + persona chats are not "shared".** By P-05, a chat holding only the owner and a persona is not shared, so the owner's personal instructions still shape the model's answers, and the persona then reads those answers in its history. This is the owner's own choice and memory is never sent. Flagged for 06-12/06-16 in case D-06 should count personas.
- `SendAiMessageRequest` has no `clientTimeZone`, so persona turns in AI chats get UTC for `now`.
- The response of `POST /agent-channel/v1/messages` echoes the requested `threadRootMessageId` even though an AI chat stores the reply flat. The plugin ignores this field.

## Broken-windows ledger (single line; not written by this executor)

`gsd windows append --kind unrun-verify --phase 06 --file apps/openclaw-channel/src/mention-mapper.ts --description "06-10 ai_chat persona delivery (flat, per-mention session, withheld block, gate refusal) not yet proven in a real OpenClaw cell (CI cell-smoke unavailable)"`

## Self-Check: PASSED

- Files exist: `ai-chat/members.ts`, `agent-channel/ai-chat-delivery.int.test.ts`, this SUMMARY.
- Commits b11fcea, 8b64764, 8b79fcd, 5c04491, ccc6019 are on wt/06-10.
