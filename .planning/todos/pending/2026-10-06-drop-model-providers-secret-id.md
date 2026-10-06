---
created: 2026-10-06
title: Drop model_providers.secret_id after the SecretReference move has settled
area: db
---

## Problem
Phase 5 (D-07, plans 05-01 and 05-04) moves organization provider keys onto `model_providers.secret_ref`
(`{provider: "db", secretId, organizationId}` for UI-entered keys). The data migration `*_provider_secret_refs`
backfills it from `secret_id`, and from 05-04 every key is resolved through `secrets.resolve(tx, secret_ref)` only
(a test proves `secret_id` is never read for resolution). `secret_id` is kept on purpose: it makes the backfill's
rollback trivial (`UPDATE app.model_providers SET secret_ref = NULL;` plus the pre-Phase-5 code) and its foreign key
still sets the column to NULL when a secret row is deleted.

## Solution (after Phase 5 has run on the demo and on at least one self-hosted install without a rollback)
- A schema migration that drops `model_providers.secret_id` (and its FK), in its own phase plan with the usual
  [BLOCKING] proof on a fresh ephemeral PostgreSQL and an N-1 → N upgrade test (Phase 7 tooling).
- Remove the upsert code that keeps `secret_id` in sync, and make `secret_ref` deletion clean up the `db` secret.
- Update ADR-0018's consequences (the rollback note no longer applies).
