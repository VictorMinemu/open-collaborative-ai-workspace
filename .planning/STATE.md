---
gsd_state_version: 1.0
milestone: v1.0
current_phase: 07.11
current_phase_name: runtime-cli-auto-updates
status: executing
stopped_at: Phase 03.1 complete, ready to plan Phase 1
last_updated: "2026-10-28T21:02:01.997Z"
last_activity: 2026-10-05
last_activity_desc: Phase 03.1 complete, transitioned to Phase 1
state_head: 5eb9dc1215c19f3cb49580eaba8c269eddb14700
progress:
  total_phases: 12
  completed_phases: 4
  total_plans: 270
  completed_plans: 224
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-10-02)

**Core value:** AI sessions are multiplayer — a private AI chat or coding session can be shared live with colleagues, the model knows who each participant is, and everything stays attributed and auditable.
**Current focus:** Phase 03.1 — Personal Bots and Bot Capabilities

## Current Position

Phase: 07.11 (runtime-cli-auto-updates) — READY TO EXECUTE
Plan: Not started
Status: Ready to execute
Last activity: 2026-10-05 — Phase 03.1 complete, transitioned to Phase 1

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 15
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 03.1 | 15 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: 12 phases follow the reconciled structure in research/SUMMARY.md; only DESK-06 and DESK-07 moved from Phase 9 to Phase 11 because they need a WorkSession to be observable.
- [Roadmap]: Phase 8 (Device/Contracts) and Phase 9 (Daemon/Adapters/Shell) are parallel workstreams once `packages/protocol` (DEV-01) is merged; Phase 10 needs both.
- [Roadmap]: REQUIREMENTS.md v1 count corrected from 119 to 122 (actual ID count; no duplicates).
- [Roadmap 2026-10-02]: Phase 1 restructured into the MVP 0 slice (multiplayer AI chat on `docker compose up`, deliverable in 1–2 weeks): FOUND-01…06, AUTH-01…03, ORG-05, RT-01/02/05, MULTI-02/03/04/08 and new SLICE-01…05 (22 requirements); FOUND-07 → Phase 7; Phase 2 narrowed to AUTH-04…06 + ORG-01…04/06, Phase 3 to RT-03/04 (Realtime Presence and Latency), Phase 6 to MULTI-01/05/06/07 + AGENT-01…04; v1 total 127; numbering 1–12 unchanged.
- [ADR amendments]: Node 24 LTS, TS 7 with `typescript@6` alias, Grafana Tempo in the observability profile and the env/file secret provider with OpenBao as an optional profile — accepted 2026-09-10 (commit 87972fe).
- [ADR-0005]: Local Runtime daemon is a standalone process (no Electron imports) supervised by the desktop app over a Unix socket / named pipe; built this way in Phase 1 (macOS); record the validation result in Phase 9.
- [Scope 2026-10-02]: Owner widened Phase 1 for the investor demo: Slack-style channels + threads + @mentions instead of a shared AI chat, OpenClaw bots from MVP 0 (one-click, model fixed per bot), Work Zone with desktop app and Claude Code/Codex on each user's own subscription (BYO, never pooled), MinIO dropped from Phase 1, third DB role `ocw_auth` approved. Built per 01-BUILD-SPEC.md by parallel agents, bypassing plan-phase/execute-phase (owner delegated full control).
- [Roadmap 2026-10-04]: Phase 1 re-mapped after a code audit and renamed MVP 0 — Collaborative Workspace Demo Slice: 28 full requirements + SLICE-05…18 (42); SLICE-01…04 and DEV-07 superseded; FOUND-05/06 → Phase 7, ORG-05 → Phase 2, RT-01 → Phase 3, MULTI-02/03/04/08 → Phase 6; Phase 4 adds object storage; Phases 6, 8, 9 renamed; v1 = 140 IDs, 135 active. Details: ROADMAP.md "Restructure 2026-10-04".

### Pending Todos

- [Phase 1]: Write the formal 01-VERIFICATION.md (`/gsd-verify-work 1`) against the re-mapped Phase 1 requirements and success criteria.
- [Phase 1]: ADRs owed for the "research" stack rows implemented in Phase 1 (Drizzle/RLS with three roles, better-auth, realtime, web, OpenClaw cell + Agent Channel API, BYO-subscription Work Zone).

### Blockers/Concerns

- [Demo]: Bots need the owner's Anthropic (or other) API key in Settings › Models; none is configured on this machine.
- [Infra]: Docker VM disk is ~100% full (other projects' data); full `docker compose up` with API/web images not re-verified after integration — demo runs API/web natively (`pnpm demo:up`).

- [Work Zone]: Decided 2026-10-02 — each customer runs the Work Zone with their OWN Claude Code / Codex subscription logins on their OWN device (BYO subscription; we never provide, pool or proxy subscriptions). API keys are not required. Residual check: confirm vendor terms allow a self-hosted harness to drive the official CLIs/SDKs with the user's own login.
- [Phase 8]: Decide in `packages/contracts` whether Work Zone prompts/assistant messages are also `messages` rows in a `work_session` conversation (PITFALLS position, recommended) or stream events only.
- [Phase 4 / Phase 7]: Drizzle 1.0 is on an RC line (1.0.0-rc.4 in use; fallback 0.45.x documented); MinIO community-edition trajectory needs verification before Phase 4 adds object storage (pnpm 12.8.1 + Turborepo 2.11 verified in Phase 1).
- [Phase 6]: Multi-provider prompt assembly verified only for Anthropic; OpenAI / Google / openai-compatible need a test matrix.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 261002-fns | Restructure roadmap: Phase 1 becomes MVP 0 multiplayer AI chat slice | 2026-10-02 | 5f2bda9 | [261002-fns-restructure-roadmap-phase-1-becomes-mvp-](./quick/261002-fns-restructure-roadmap-phase-1-becomes-mvp-/) |
| 261022-cip | Woodpecker workflows in parallel slots on one dind; heavy workflows not on push to main | 2026-10-22 | 52b58541 | [261022-cip-ci-parallel](./quick/261022-cip-ci-parallel/) |
| 261023-nsb | Node.js 24.22.1 security bump (Oct 2026 releases); every node base image pinned by digest | 2026-10-23 | 4f1f55a4 | [261023-nsb-node-24-22-1](./quick/261023-nsb-node-24-22-1/) |

### Roadmap Evolution

- Phase 3.1 inserted after Phase 3: Personal (owner-only) bots with an automatic private chat, and per-bot capability toggles (internet, memory, reply mode, time context, usage limit) capped by org policy — requested by the owner 2026-10-04 (URGENT)
- Phase 03.2 inserted after Phase 03.1: Work Zone session controls
- Phase 07.10 inserted after Phase 07.9: Work Zone sidebar by team like chat channels (owner request 2026-10-27)
- Phase 07.11 inserted after Phase 07.10: Runtime CLI auto-updates for Claude Code and Codex on every device, server-type shared devices first (modeled on T3 Code) (URGENT)

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-10-04
Stopped at: Phase 03.1 complete, ready to plan Phase 1
Resume file: None
