# Open Collaborative AI Workspace

## What This Is

An open-source, self-hostable, federable, multiplayer workspace where a company's people and AI
agents collaborate in one place. It merges Slack-style chat, ChatGPT-style AI chats that several
people can share, **Work Zones** (Codex / Claude Code / OpenCode sessions that run on a developer's
machine but are owned, watched and controlled from the cloud), persistent server-side agents
(OpenClaw), and a Control Plane that centrally governs models, skills, MCPs, permissions, devices
and audit. Built by Autofy Labs; first users are Autofy's own engineering team, then other companies
with real hierarchies (organization → department → team → project).

The authoritative specification is `docs/prd/PRD.md` (v1.0). This file is the GSD working summary.

## Core Value

**AI sessions are multiplayer.** An AI chat or a coding session can be shared by several people at
once, the model knows who each participant is, and everything stays attributed and auditable. If
nothing else works, a private AI chat must be shareable in real time with a colleague.

## Business Context

- **Customer**: engineering-led companies that already pay for ChatGPT / Claude / Codex per seat and
  want shared, governed AI infrastructure. First customer is Autofy Labs itself.
- **Revenue model**: open core stays free (AGPL-3.0). Revenue from managed cloud, agent runtime
  compute, model-usage metering, enterprise (SSO/SCIM, dedicated deployments, SLA) and a future
  marketplace. Pricing is not seat-only (base workspace + users + agent runtime + compute + models).
- **Success metric**: AI-assisted tasks successfully completed per active organization.
- **Strategy notes**: PRD Part XI (Business), Part XII (Roadmap).

## Requirements

### Validated

(None yet — ship to validate)

### Active

This milestone covers PRD **MVP 1 (Collaborative Workspace)** and **MVP 2 (Multiplayer Work Zone)**.

MVP 1 — Collaborative Workspace:

- [ ] Organizations with departments, teams and projects; users with memberships and the four
      roles (Standard User, Developer, Team Lead/Manager, Organization Admin)
- [ ] Channels, threads (side panel, no infinite nesting) and DMs (human↔human, human↔agent,
      groups mixing both)
- [ ] Realtime messaging, presence and typing with < 500 ms typical propagation
- [ ] Direct AI Chats (choose model, tools, private by default, owned by a user)
- [ ] Multiplayer AI Chats: several humans + a model in one conversation; every message carries
      author, timestamp, device, context and permissions; the model sees distinct participants
- [ ] Shareable AI conversations: private → shared with a person → shared with a team, keeping
      context, messages, attachments, artifacts, model, tools, permissions and participants
- [ ] Agents as first-class participants in channels and DMs (mentions, replies, threads, cards)
- [ ] Self-hosted install with `docker compose up`

MVP 2 — Multiplayer Work Zone:

- [ ] Electron desktop app with a separate Local Runtime daemon
- [ ] Runtime adapters for Codex and Claude Code behind a common `AgentRuntime` interface
- [ ] `WorkSession` as a server entity with participants, permissions and execution host
- [ ] Unified Session Event Protocol streamed in realtime (assistant, tool, command, file, git,
      approval, participant, prompt, artifact events)
- [ ] Prompt identity (author, origin device, session, mode, status) and a persisted Prompt Queue
      with add / edit / remove / reorder / run-next / priority
- [ ] Steer / Queue / Interrupt prompting modes where the runtime supports them
- [ ] Multiple controllers, single executor: one runtime, one working tree
- [ ] Work Zone permissions (VIEW … FULL_CONTROL) enforced server-side
- [ ] Git state per session (repo, branch, base commit, current commit, working-tree state) and
      changed-files / diff view
- [ ] Basic shared artifacts through the upload pipeline (containment → policy → SHA-256 →
      security checks → encrypted upload → object storage)
- [ ] Chat → Work Zone creation flow with an agent card posted back in the channel/thread
- [ ] Acceptance Scenario B (multiplayer AI chat) end to end; Scenario A (multiplayer coding)
      except the mobile-approval step

### Out of Scope

Deferred to later milestones (tracked as v2 in REQUIREMENTS.md):

- Model Gateway, provider pools, intelligent routing, budgets (MVP 3) — needs stable API first
- Skills inheritance/versioning, MCP scopes, policies, device sync (MVP 4)
- OpenClaw runtime, native channel plugin, proactive messaging, automations (MVP 5)
- Device Relay for web/mobile remote control, file requests, follow session (MVP 6)
- Mobile apps and push notifications (MVP 7)
- Federation, marketplace, session forking, office/browser automation (Future)

Explicit non-goals (PRD §106), never in scope without a PRD change:

- Full IDE; realtime collaborative filesystem; multiple agents writing the same working tree
- Desktop streaming or remote mouse/keyboard; arbitrary filesystem browsing from remote devices
- Infinite thread nesting; full marketplace; complex office automation

## Context

- Greenfield. Repository holds only docs, ADRs and this planning folder as of 2026-09-09.
- All application code will be written mostly by AI coding agents; `AGENTS.md` is the single
  source of agent instructions and `CLAUDE.md` imports it (ADR-0004).
- Prior art the product explicitly positions against: Slack/Discord bots, Codex/Claude Code GUIs,
  enterprise Claude Code wrappers. Conceptual inspiration: Slack + Inline + Discord + ChatGPT for
  Chats; Figma/Google-Docs-style multiplayer for Work Zone.
- OpenClaw (self-hosted gateway connecting chat apps to coding agents, with a channel-plugin SDK)
  is the intended persistent-agent runtime; integration goes through our Agent Channel API only.
- Known hard problems called out in the PRD: runtime fragmentation (mitigated by adapter API +
  event protocol), host disconnects (heartbeat, reconnect, persisted queue), permission complexity
  (effective-permission viewer, explicit deny precedence), file privacy (relative paths only,
  registered projects, relay-only mode).

## Constraints

- **Tech stack**: TypeScript 7 monorepo, pnpm 12 + Turborepo + Biome + Vitest, Node 24 LTS — ADR-0001 (amended 2026-09-10)
- **Backend**: Fastify modular monolith in `apps/api`, one module per PRD service — ADR-0002
- **Infrastructure**: PostgreSQL (RLS, only DB), Redis, S3-compatible storage, `SecretStore` with
  env/file provider and optional OpenBao profile, OpenTelemetry with optional Tempo/Grafana profile;
  NATS JetStream and Temporal deferred — ADR-0003 (amended 2026-09-10)
- **Daemon**: Local Runtime is a standalone process supervised by the desktop app over a Unix
  socket / named pipe — ADR-0005
- **Clients**: Next.js web, Electron desktop + Local Runtime daemon, Expo mobile — PRD
- **Open source first**: every essential feature must run self-hosted with `docker compose up`;
  AGPL-3.0 for apps, Apache-2.0 for protocol/SDK/plugins — PRD §5.1, §100
- **Security**: least privilege intersected across org/dept/team/project/user/agent/tool/device;
  no absolute host paths leave the device; secrets only via secret store; every sensitive action
  audited — PRD §48, §61, §82–84
- **Realtime**: < 500 ms typical propagation for collaborative events; sessions reconnectable,
  events replayable — PRD §85, §97
- **Language**: English for code, docs, commits; Spanish PRD kept only as archive

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Fastify over NestJS | Lighter, better WebSocket/streaming ergonomics, less framework magic for AI agents (ADR-0002) | — Pending |
| PostgreSQL + Redis only in MVP1; NATS/Temporal deferred | Keep `docker compose up` small until a phase needs streams/workflows (ADR-0003) | — Pending |
| AGENTS.md as single source, CLAUDE.md imports it | Several coding agents share the repo; avoid drift (ADR-0004) | — Pending |
| First milestone = MVP1 + MVP2 | Core value (multiplayer AI sessions) needs both chat and Work Zone to be proven | — Pending |
| Vertical MVP phasing | Each phase ships an end-to-end user capability | — Pending |
| Drizzle ORM with RLS in schema, better-auth embedded, `@fastify/websocket` + Redis with Postgres seq replay, Vercel AI SDK 7, Next.js 16 + shadcn (Base UI) | Resolved by research 2026-09-10 (`.planning/research/STACK.md`); ADRs written in the implementing phases | — Pending |
| Node 24 + TypeScript 7; OpenBao and observability as compose profiles; Tempo added | Research amendments accepted 2026-09-10 (ADR-0001, ADR-0003) | — Pending |
| Shared AI chat context rule: tools run as agent ∩ triggering human; content must be authorised for all participants; no private memory in multi-human chats | Avoids confused deputy and private-context leakage (PITFALLS 3) | — Pending |
| First-release gaps from FEATURES.md accepted as v1 requirements (122 total) | Users notice search, edit/delete, invites, permission modes in the first hour | — Pending |
| MVP 0 thin slice first (Phase 1 = multiplayer AI chat on compose) | Core value was only demonstrable at Phase 6; ship it in 1–2 weeks and widen afterwards; keep RLS, unified conversation model, seq replay and audit since they are ruinous to retrofit | — Pending |
| MVP 0 widened for the investor demo (2026-10-02): Slack-style channels + threads, one-click OpenClaw bots, Work Zone + desktop with BYO Claude Code / Codex subscriptions | Show the whole product shape (chat, persistent agents, cloud-owned coding sessions) in one demo; foundations (RLS, seq replay, same-tx audit) kept; multiplayer AI chat moves to Phases 5–6 | ✓ Built and demo-verified 2026-10-04 (PR #2) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-04 after the MVP 0 demo build and requirements re-map*
