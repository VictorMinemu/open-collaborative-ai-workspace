# Open Collaborative AI Workspace

**The open-source multiplayer workspace for humans and AI agents.**

A self-hostable, federable platform where people and AI agents collaborate inside a company:

- **Chats** — Slack-style channels, threads and DMs where humans and agents are peers, plus
  ChatGPT-style AI chats that are multiplayer and shareable.
- **Work Zone** — Codex, Claude Code and OpenCode sessions that run on a developer's machine but are
  owned by the platform: multiple people can watch, prompt, queue, steer and approve from desktop,
  web or mobile.
- **Agents** — persistent, proactive server-side agents (OpenClaw) scoped to a person, project, team,
  department or organization, with scheduled automations and delivery targets.
- **Shared AI infrastructure** — centrally governed models, provider pools and routing, versioned and
  inheritable skills, scoped MCP servers, policies, secrets, devices and a full audit log.

The thesis: turn individual AI usage (everyone's own ChatGPT, Claude, Codex, skills and MCPs) into
shared, governable company infrastructure, while keeping local execution wherever it is needed.

## Status

Pre-code. This repository currently holds the product specification, architecture decisions and
planning artifacts. Application code will follow the roadmap in `docs/prd/PRD.md` (MVP 1–7).

## Documents

| Document | Purpose |
| --- | --- |
| [`docs/prd/PRD.md`](docs/prd/PRD.md) | Authoritative Product Requirements Document (v1.0) |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records |
| [`AGENTS.md`](AGENTS.md) | Instructions for AI coding agents (single source of truth) |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code wrapper that imports `AGENTS.md` |
| `.planning/` | GSD planning: project, requirements, research, roadmap |

## Stack (decided)

TypeScript monorepo (pnpm + Turborepo + Biome + Vitest, Node 22 LTS) · Fastify modular monolith ·
Next.js web · Electron desktop with a Local Runtime daemon · Expo mobile · PostgreSQL · Redis ·
S3-compatible storage · OpenBao/KMS · OpenTelemetry · OpenClaw for server-side agents.
See the ADRs for rationale and for what is still deliberately undecided.

## Self-hosting goal

```bash
git clone https://github.com/VictorMinemu/open-collaborative-ai-workspace.git
cd open-collaborative-ai-workspace
docker compose up
```

No essential feature will depend on a managed cloud.

## License

Server, control plane, desktop, web and mobile: **AGPL-3.0** (see `LICENSE`).
Protocol, SDKs and plugins will be published under **Apache-2.0** in their own packages.
The trademark is protected independently of the code.
