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
- **07.3 Module access per unit:** Work Zone, AI chats and Bots on or off per organization, unit or person as resolver
  deny rules, from Settings › Organization and Settings › Modules; the web hides what the API refuses (ADR-0024).
