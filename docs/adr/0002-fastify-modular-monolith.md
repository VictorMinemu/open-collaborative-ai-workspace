# ADR-0002: Fastify modular monolith for the Control Plane

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

PRD v0.3 left the backend framework open between NestJS and Fastify and stated that the logical
services (Identity, Organization, Chat, Realtime, Work Session, Device Relay, Model Gateway, Provider
Router, Agent, OpenClaw Channel API, Automation, Skills, MCP, Policy, Artifact, Audit, Notification,
Federation) "may start in a modular monolith and be separated later". The workload is dominated by
realtime WebSocket traffic, streaming model output and relay of session events, with a
< 500 ms propagation target.

## Decision

- The Control Plane is a **Fastify** application in `apps/api`.
- It is a **modular monolith**: one folder per PRD service under `apps/api/src/modules/<name>/`,
  each exposing a single public `index.ts`. Modules depend on each other only through those public
  interfaces; cross-module database access is forbidden.
- Realtime uses Fastify's WebSocket support; horizontal fan-out uses Redis pub/sub (see ADR-0003).
- Schemas are Zod, shared from `packages/contracts`, and attached to routes for validation and
  OpenAPI generation.
- NestJS is not used.

## Rationale

- Fastify has lower overhead and simpler streaming/WebSocket ergonomics, which matters for the
  realtime and Model Gateway paths.
- Plain functions and explicit module boundaries are easier for AI coding agents to reason about
  and refactor than decorator-driven dependency injection.
- Extracting a module into its own service later is a matter of moving a folder and replacing the
  in-process interface with a transport, which the public-`index.ts` rule keeps cheap.

## Consequences

- Positive: minimal framework magic, fast startup, one process to run for `docker compose up`.
- Negative: module discipline is enforced by convention and lint rules, not by the framework. A
  dependency-boundary check (for example a Biome/ESLint import rule or `dependency-cruiser`) must be
  added when the first two modules exist.
- Negative: no built-in DI; dependencies are passed explicitly at module construction. This is
  intentional.
