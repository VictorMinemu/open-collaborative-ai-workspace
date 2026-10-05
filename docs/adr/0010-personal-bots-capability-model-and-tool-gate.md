# ADR-0010: Personal bots, the capability model and the cell tool gate

## Status

Accepted. **Date:** 2026-10-05. **Deciders:** Víctor Ruiz (Autofy Labs).

## Context

Phase 3.1 (BOT-01 … BOT-10) turns OpenClaw bots from shared team assistants into something every member can own and
equip. Every member gets a private bot. Bots get the internet, memory, the asker's local time and per-bot tools, and
admins keep the final say on all of it. The PRD principles that constrain this are:

- agents are first-class principals (principle 2);
- effective permission is the intersection of every layer (principle 6);
- every sensitive action is audited (principle 12).

The OpenClaw cell runs bots in-process with the gateway. Phase 3 already proved that a tool which bypasses our hooks
also bypasses the audit (debug report `03.1-tool-gate`). Personal bots also raise privacy questions that team bots
never did: an admin must be able to govern a personal bot without reading its chat, its memory or its instructions.

## Decision

**Personal bots are agent principals with an owner (D-01, D-02).**
- A personal bot is an `agents` row with `scope = 'personal'` and `owner_user_id`.
- The resolver (ADR-0007) gains resource type `agent` with relation `owner` and the states `personal` and `disabled`.
  New permissions are add-only:
  - `bot.create_personal`;
  - `bot.configure`: owner relation for personal bots, admin role for team bots;
  - `bot.internet` and `bot.tool.use`: decided as agent ∩ triggering human; the tool layer is `ResourceFacts.tool`;
  - `plugin.manage` and `mcp.manage`: admin only, non-delegable.
- Admins see governance metadata only (name, owner, model, capabilities, usage) and may disable or delete a personal
  bot. They can never read its chat, memory or instructions.
- An owner cannot re-enable a bot an admin disabled (`disabled_by_admin`).
- The default limit is 3 personal bots per user. Code: `apps/api/src/modules/agent/personal.ts`,
  `packages/contracts/src/permissions.ts`.

**DMs are private two-member conversations (D-03, D-04).**
- A DM is `conversations.kind = 'dm'` with exactly the owner and the bot, unique per pair through `dm_key`.
- Every human message in a DM produces exactly one `agent.mention.v1` with no @mention needed.
- The cell replies flat, with one OpenClaw session per DM conversation (`session.dmScope: "per-channel-peer"` as
  defence in depth).
- A personal bot never joins a channel.

**One migration (D-05).** `packages/db/drizzle/20261005005954_personal_bots_capabilities` carries every table of the
phase. Later plans changed code only.

**Capabilities, policy and reasons (D-06).**
- Per-bot toggles: `internet`, `memory`, `dateTime`, `replyMode`, `dailyLimit`.
- One organization policy row (`bot_policies`) holds per-capability `{orgWide, personal}`, the search provider, the
  personal-bot cap, the personal daily-limit ceiling and the models allowed for personal bots.
- Tool sources (MCP servers, installed plugins) carry `org_enabled` and `personal_allowed` (the latter off by default).
- Effective = toggle ∧ org policy ∧ personal policy ∧ configured ∧ resolver(agent ∩ human).
- A denial always carries one reason code (`org_policy`, `personal_policy`, `not_configured`, `denied_for_you`,
  `source_unavailable`, `dangerous`, `dm_only`), so the UI explains it instead of hiding the switch.
- Internet is `configured` only when the policy's provider is bundled in the image or installed from the marketplace.
- Code: `apps/api/src/modules/bot-capabilities/{capabilities,policy,catalog}.ts`.

**The API decides every turn (D-07).**
- `turnPolicy` (`bot-capabilities/turn-policy.ts`) computes the effective tools, their flags, the memory notes, the
  asker's local time and the caps for every delivery.
- It ships them in the `turn` block of `agent.mention.v1` and records the turn in `agent_turns`.
- The cell only intersects the turn with its snapshot. A delivery without a `turn` runs with no tools.
- A policy change therefore bites on the next turn, even before the cell reconciles.

**Three layers plus a fail-closed gate in the cell (D-08).**
1. The global layer is `tools.profile: "minimal"` plus an explicit deny list of dangerous tool classes. The list never
   holds the wildcard or our own tools (`infra/openclaw/render-config.mjs` `DANGEROUS_TOOLS`).
2. Per agent, `alsoAllow` holds the tools that bot may ever use. `bundle-mcp` and `bundle-lsp` are refused.
3. Per run, `toolsAllow` = `turn.tools` ∩ snapshot.
- On top of that, a `before_tool_call` hook (priority 10 000, no matcher) blocks any tool outside the active turn and
  asks `POST /agent-channel/v1/tool-calls` for every call. It fails closed on an error or a timeout (under 15 s), and
  `after_tool_call` reports the outcome.
- The gate is registered from `registerCapabilities` (`apps/openclaw-channel/src/register-capabilities.ts`) because
  OpenClaw 2026.9.7 runs turns in non-activated `discovery` registries, where `registerFull` never runs.
- The hook sees case-folded tool names. The guard resolves them back to the turn's exact name.
- **Taint:** once a tool with untrusted output has been allowed in a turn, side-effecting tools are blocked for the
  rest of that turn unless their source is trusted for chained calls. Side-effecting tools are `ocw_memory_save`, MCP
  tools without `readOnlyHint`, and every plugin tool.
- **Caps:** 8 tool calls and 5 web calls per turn, enforced in one conditional `UPDATE` in the API.
- **Parity:** `isDangerousToolName` (`packages/contracts/src/bot-capabilities.ts`) applies the same dangerous list to
  catalogs, grants, plugin reports and the cell.

**Internet without paid or hosted search (D-09).**
- `web_fetch` is OpenClaw core. `web_search` uses the official keyless `@openclaw/duckduckgo-plugin@2026.9.7`,
  bundled with a pinned sha512, or SearXNG through the optional `search` compose profile.
- Brave is excluded (paid), and hosted Codex search is off (`openaiCodex.enabled: false`).
- The provider is pinned only when its plugin is loaded; with `OCW_BUNDLED_PLUGINS=none`, DuckDuckGo can arrive
  through the marketplace instead (ADR-0011).

**Memory in Postgres (D-10).**
- Notes live in `agent_memories` per (bot, human). They are read and written only in that human's DM with the bot,
  through our `ocw_memory_save` tool.
- The tool takes the note's owner from the stored delivery (`agent_turns`), never from tool params.
- The human can see and clear the notes; admins cannot. Audit rows never carry note text.
- OpenClaw `memory-core` stays off.

**Usage metering (D-11).**
- One atomic daily counter per bot (`agent_usage_daily`, UTC day), incremented at delivery.
- At the limit there is no cell event (so provably no model call). A notice is posted as the bot, and the audit records
  `agent.limit_reached`.

**Reply mode and time (D-12).**
- Reply mode `all` exists for team bots in channels only. A bot answers only human-authored messages, stays silent when
  another bot is @mentioned, and is capped at 6 automatic replies per minute per conversation.
- A turn carries the asker's local time from their browser time zone, re-validated by the API, or no time when the
  toggle is off.

## Consequences

- A bot can only do what the API allowed for this turn and this asker, and every call is audited:
  - `bot.tool_call` records bot, human, tool, source and target, never arguments or results;
  - `bot.tool_call.completed` records the outcome.
- Admins govern personal bots by metadata and policy, never by content.
- The capability UI can always say why a switch is off.
- **OpenClaw upgrade checklist.** Every OpenClaw bump must re-verify, against the new image's dist:
  - the hook contract: registration modes, `before_tool_call` event shape, case-folded names;
  - the generated tool names (MCP `<safe>__<tool>` format and collision suffixes);
  - the dangerous tool list and new built-in tool classes.

  `apps/openclaw-channel/src/testing/openclaw-host.ts` models these and must be updated with them. The cell smoke
  (`infra/openclaw/test/run-container-smoke.sh`) and the on-demand real-cell proof (`scripts/cell-proof.sh`) are the
  end-to-end checks.
- **Residual risk: prompt injection.** Untrusted content (web pages, MCP output, messages in shared channel threads) can
  still steer the model's text and its read-only tool use within the turn. The taint rule, the per-turn caps and the
  absence of dangerous tools bound the damage, but they do not prevent it.
- **Fewer moving parts.** Memory, usage and policy live in the API's Postgres. A cell that loses its volume loses only
  OpenClaw session transcripts.
