# What is built

What the repository already ships, by phase (planning lives in `.planning/ROADMAP.md`; decisions in `docs/adr/`).
Moved out of `AGENTS.md` so that file keeps only what every session needs.

- **1 MVP 0:** strict monorepo with RLS and audit, setup / invite / login, one WebSocket with seq replay, channels and
  threads, one-click OpenClaw bots through the Agent Channel API, device pairing, Work Zone sessions, desktop shell.
- **2 Identity and organization:** org hierarchy with four roles, one effective-permission resolver, JWT/JWKS, admin
  console, profiles (ADR-0007, ADR-0008).
- **3 Realtime:** presence, live re-authorisation of subscriptions, sub-500 ms propagation (ADR-0009).
- **03.1 Personal bots and capabilities:** bot web tools, MCP for bots, the ClawHub marketplace, bot memory
  (ADR-0010, ADR-0011).
- **03.2 Work Zone controls:** runtime settings between turns, Work Zone policy, shared devices, Full access
  (ADR-0012, ADR-0013).
- **4 Chat:** sidebar and views, DMs, Markdown, reactions, notifications, search, attachments, pins and permalinks
  (ADR-0015, ADR-0016).
- **5 AI chats:** private streaming AI chats, ChatGPT plan per member, model gateway, usage (ADR-0017, ADR-0018).
- **6 Multiplayer AI chats and agents:** shared AI chats with structural identity, personas, Agent Cards
  (ADR-0019, ADR-0020).
- **06.1 Work Zone image attachments.**
- **7 Self-hosted release:** `pnpm ocw setup` + `docker compose up`, OpenTelemetry, secrets as inputs, backups,
  release gate (ADR-0021).
- **07.1 Board channels and record templates:** a channel can be a board whose cards are threads (moves by pointer,
  keyboard, touch or Move to…, live for everyone), columns with categories and waiting states, agents on the board
  through `ocw_board_card`, and unit record templates that name cards (ADR-0022).
- **07.2 Scoped memory files and governed promotion:** Markdown memory per scope (a person's private memory with a
  bot, bot notebooks, teams, departments, projects, the organization) with a file tree, viewer, editor, history with
  diffs and search at 1440 and 390; per-folder rules; bots read through the audience rule, write only their own
  scopes and propose shared changes; the reusable approve-and-apply primitive with platform-owned approval cards and a
  proposals inbox; a built-in sensitive-data scan plus the optional Presidio `pii` profile; legacy bot notes moved to
  the private `MEMORY.md` (ADR-0023).
- **07.3 Module access per unit:** Work Zone, AI chats, Bots and Memory on or off per organization, unit or person as
  resolver deny rules, from Settings › Organization and Settings › Modules; the web hides what the API refuses
  (ADR-0024).
- **07.4 Per-member connectors, agent keychain and templates:** MCP connectors in three auth modes; each member signs
  in to their own account (OAuth 2.1 with PKCE, `resource`, `iss`; callback on the API) or pastes their own key, sealed
  per member; a shared bot calls the connector with the account of whoever asked, through the API proxy, only where
  that person alone reads the result unless they allow a conversation, and posts a "Connect your account" card that
  comes back to the chat; Settings › Connections and Keychain; keys used by handle and never seen by the model; one
  pinned, public-only egress guard for every outbound call; unit agent templates that members start as their own
  personal agent (ADR-0025).
