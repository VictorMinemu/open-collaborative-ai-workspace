# ADR-0003: Infrastructure baseline — PostgreSQL, Redis, S3, OpenBao, OpenTelemetry; NATS and Temporal deferred

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

PRD v0.3 lists PostgreSQL, Redis, NATS JetStream, Temporal, OpenBao/KMS, S3-compatible storage and
OpenTelemetry as the initial stack. MVP1 (collaborative workspace: organizations, hierarchy,
channels, threads, DMs, realtime, direct and multiplayer AI chats, agents in conversations) does not
need durable event streaming or workflow orchestration. Adding NATS and Temporal from day one would
double the moving parts in `docker compose up` before any feature requires them, which conflicts
with the "open source first, one-command install" principle.

## Decision

- **PostgreSQL** is the only database in MVP1. All organization-scoped tables carry
  `organization_id` and are protected with Row Level Security; tenant isolation is a test target.
- **Redis** provides pub/sub for realtime fan-out across API instances, presence, typing indicators,
  rate-limit state and other ephemeral data. Nothing durable lives only in Redis.
- **S3-compatible object storage** (MinIO in self-hosted compose) for artifacts and attachments,
  following the PRD artifact pipeline (containment check → policy → SHA-256 → security checks →
  encrypted upload).
- **Secrets** go through an abstraction whose first implementation targets **OpenBao**; cloud KMS
  implementations may follow. Code never holds provider or MCP credentials directly; it holds a
  `SecretReference`.
- **OpenTelemetry** instrumentation (traces, metrics, logs) is present from the first service, with
  Prometheus / Grafana / Loki as the self-hosted backend.
- **NATS JetStream** and **Temporal** are **deferred**. Triggers to revisit, each requiring a new ADR:
  - NATS: when session events must be replayed across processes or the Device Relay needs durable,
    multi-consumer streams (expected MVP2 / MVP6).
  - Temporal: when scheduled automations, retries and idempotent delivery are implemented (expected
    MVP5). Until then, a PostgreSQL-backed job table is acceptable.

## Consequences

- Positive: `docker compose up` for MVP1 is API + web + PostgreSQL + Redis + MinIO + OpenBao +
  observability. Fewer components to secure and document.
- Positive: replayable session events are still guaranteed at the data level because every
  `SessionEvent` is persisted in PostgreSQL before broadcast.
- Negative: when NATS/Temporal are introduced, the outbox / job code written for PostgreSQL must be
  migrated. Keep those paths behind small interfaces to contain the cost.
