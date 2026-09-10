# ADR-0001: Single TypeScript monorepo with pnpm, Turborepo, Biome and Vitest

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

The PRD defines five runtime surfaces (API, web, desktop, local runtime daemon, mobile) plus an
OpenClaw channel plugin, all sharing contracts such as the Unified Session Event Protocol, permission
enums and DTOs. They must evolve together, and AI coding agents will do most of the implementation,
so tooling should be minimal, deterministic and uniform.

## Decision

- One repository, one language: **TypeScript** with `strict: true`, runtime schema validation (Zod)
  at every process boundary.
- **Node 24 LTS**, exact patch pinned in `.nvmrc` (currently `24.21.0`). Odd-numbered Node releases
  are not used. *(Amended 2026-09-10: originally Node 22; changed because 22.x entered Maintenance in
  October 2025 and Electron 44 embeds Node 24, so daemon and desktop share one ABI.)*
- **TypeScript 7.0.x** (native compiler). Tools that still need the JavaScript compiler API use a
  `typescript6@npm:typescript@6.0.3` alias until TS 7.1 restores it; `isolatedDeclarations` is on so
  declaration output does not depend on the API. *(Added 2026-09-10.)*
- **pnpm 12 workspaces** for dependency management with a frozen lockfile in CI; pnpm settings live in
  `pnpm-workspace.yaml` (pnpm 12 ignores `package.json#pnpm`).
- **Turborepo** for the task graph (`dev`, `build`, `lint`, `typecheck`, `test`) with remote cache
  disabled until secrets handling in cache is reviewed.
- **Biome** as the single lint + format tool. ESLint is not added unless a rule Biome cannot express
  becomes necessary; that would be its own ADR.
- **Vitest** for unit and integration tests; **Playwright** for browser E2E once a UI exists.
- Shared config lives in `packages/config`.

## Consequences

- Positive: a single `pnpm verify` gate, uniform DX for humans and agents, shared types with zero
  serialization drift between apps.
- Positive: Biome is one dependency and one config for the whole repo; it is fast enough to run on
  every commit.
- Negative: Electron and Expo have their own build pipelines that must be wired into Turbo; this is
  accepted and tackled in MVP2 / MVP7.
- Negative: the Local Runtime daemon is TypeScript for now. The PRD recommends Rust as a future
  target; that remains undecided and would be a separate ADR.
