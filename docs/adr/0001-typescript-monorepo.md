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
- **Node 22 LTS**, exact patch pinned in `.nvmrc` (currently `22.17.0`). Odd-numbered Node releases
  are not used.
- **pnpm workspaces** for dependency management with a frozen lockfile in CI.
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
