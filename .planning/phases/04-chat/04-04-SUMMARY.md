---
phase: 04-chat
plan: 04
subsystem: artifact
status: complete
tags: [attachments, object-storage, garage, s3, presigned-urls, sharp, audit, compose, ci, adr]
requirements: [CHAT-12]
dependency_graph:
  requires: [04-01 (attachments table, contracts, createConversationAccess, attachment.upload), 04-02]
  provides:
    - "Artifact module: createArtifactModule, linkAttachments, attachmentsForMessages, toAttachment (Plan 04-12 imports these)"
    - "ObjectStorage (createObjectStorage, attachmentKey) on any S3-compatible store"
    - "Routes GET /attachments/config, POST /conversations/:id/attachments, POST /attachments/:id/complete, GET /attachments/:id/{download,preview,large}"
    - "startTestStorage (Garage testcontainer) for integration suites"
    - "Garage in compose, setup-env --add-missing, harness Garage on 127.0.0.1:4292 (ocw-e2e-storage), CI garage"
    - "ADR-0015"
  affects: [04-12 (composer + message list wire the pipeline; removes the attachments_unavailable guard), Phase 12 (artifacts reuse ObjectStorage)]
tech-stack:
  added: ["@aws-sdk/client-s3 3.1141.0", "@aws-sdk/s3-request-presigner 3.1141.0", "file-type 22.1.1", "sharp 0.35.4 (api)", "testcontainers 12.1.0 (api dev)", "dxflrs/garage:v2.4.1"]
  patterns:
    - "authorize in a short tx → verify bytes outside any tx → mark ready + audit in a second tx (status guard 'pending')"
    - "storage errors → 503 storage_unavailable, only the error name logged"
    - "background bucket CORS with backoff; config reports unavailable until it succeeds"
key-files:
  created:
    - apps/api/src/modules/artifact/{index,storage,attachments,model,sniff,renditions,disposition,sweeper}.ts
    - apps/api/src/modules/artifact/{attachments.int.test.ts,disposition.test.ts}
    - apps/api/src/testing-storage.ts
    - infra/garage/{garage.toml,README.md,compose-garage.test.mjs}
    - scripts/setup-env.test.mjs
    - e2e/tests/attachments-api.spec.ts
    - docs/adr/0015-object-storage-garage.md
  modified:
    - apps/api/src/{app.ts,testing.ts,config/env.ts,config/env.test.ts}, apps/api/package.json, pnpm-lock.yaml
    - packages/db/sql/post-migrate.sql
    - compose.yaml, scripts/setup-env.mjs, scripts/e2e-isolated.sh, .github/workflows/ci.yml, .env.example
decisions:
  - "Pixel-limit failures (decompression bombs) reject the upload (409 image_too_large); other sharp failures leave the file ready without previews"
  - "complete is idempotent for an already-ready attachment; before the PUT it answers 409 upload_missing and stays pending"
  - "config.enabled also reflects the caller's attachment.upload decision (the route needs a resolver decision; a denied user sees no paperclip, reason null)"
  - "Active types (HTML, SVG, XML, JS) are stored as application/octet-stream even as downloads"
  - "app.due_attachment_sweeps takes p_now (default now()) so the sweeper's injected clock reaches SQL"
  - "--add-missing never appends database passwords or lines that embed them"
metrics:
  duration: "~35 min"
  completed: 2026-10-06
  tasks: 3
  files: 29
estimate:
  tokens: 220000
actuals:
  tokens: 34000
  tasks: 3
  commits: 3
---

# Phase 4 Plan 04: Garage object storage and the attachment pipeline Summary

Browser → presigned PUT (signed content type and length) → Garage → `complete` (size, magic-byte sniff, SHA-256, EXIF-free webp renditions) → audited 302 download through the conversation's read decision, on a real Garage container; Garage ships in `docker compose up` with no init step and no `:?` guards, and setup-env, the isolated harness (:4292) and CI all get their own storage.

## What was built

- **Storage (P-10):** `storage.ts` with two S3 clients (internal `OCW_S3_ENDPOINT`, presigning on `OCW_S3_PUBLIC_URL`), `WHEN_REQUIRED` checksums, `signableHeaders: content-type`, keys `org/<org>/conv/<conv>/att/<att>/{original,thumb.webp,large.webp}`. Configured only when endpoint, key id and secret (SecretReference `OCW_S3_SECRET_ACCESS_KEY`, `_FILE`) are all set.
- **Routes:** config (`not_configured` / `unavailable`), presign (readable → archived 410 → `channel.post` + `attachment.upload` → `too_large` → pending row, 60/min/user), complete (uploader only, 404 otherwise; `upload_missing`, `size_mismatch`, `type_mismatch`, `image_too_large`; audit `attachment.uploaded`), download (audited, `attachment` disposition), preview/large (inline webp, not audited). 302s carry `Cache-Control: private, no-store`; `res.headers.location` redacted from logs.
- **Helpers for 04-12:** `linkAttachments` (same uploader/conversation, ready, unlinked, ≤10, else 409 `attachment_not_linkable`), `attachmentsForMessages`, `toAttachment`. Artifact imports only the `ConversationAccess` type from chat.
- **Sweeper:** 10 min, `pg_try_advisory_lock`, SECURITY DEFINER `app.due_attachment_sweeps(p_limit, p_now)` (ids only; REVOKE PUBLIC, GRANT ocw_app), per-row `withTenant` re-check under RLS, removes all three keys, sets `purged_at`.
- **Compose/infra:** `garage` service, volumes `garage-meta`/`garage-data`, loopback `${OCW_S3_PORT:-3900}`; api env + `depends_on: garage: service_started`; secret-free `infra/garage/garage.toml` (shared with the testcontainer); README with the `--add-missing` upgrade step, encryption-at-rest and antivirus deferrals.
- **setup-env:** generates `GARAGE_RPC_SECRET` (64 hex), `OCW_S3_ACCESS_KEY_ID` (GK+24 hex), `OCW_S3_SECRET_ACCESS_KEY` (64 hex); `--add-missing` (append-only, idempotent), `--dir`. `.env.example`: 14-line commented S3 block appended with printf.
- **Harness/CI:** `e2e-isolated.sh` runs Garage in compose project `ocw-e2e-storage` on 127.0.0.1:4292 with fixed loopback test keys, `down -v` unless `--keep-db`, stops it in cleanup; CI e2e starts `postgres redis garage`, verify runs `node --test 'scripts/**/*.test.mjs'` (infra tests incl. compose-garage already run in cell-smoke). Validated by reading (CI runs after push).
- **ADR-0015** (supersedes ADR-0003's MinIO clause; ADR-0003 untouched).

## Verification

| Check | Result |
| --- | --- |
| `vitest --project unit` env.test.ts + disposition.test.ts | 11/11 |
| `vitest --project integration` attachments.int.test.ts (PG + Redis + Garage) | 25/25 |
| `node --test infra/garage/compose-garage.test.mjs scripts/setup-env.test.mjs` | 9/9 |
| `docker compose -f compose.yaml config -q` | exit 0 |
| `bash scripts/e2e-isolated.sh attachments-api chat.spec` | 4 passed, 1 skipped (attachments-api on mobile, by design) |
| `pnpm verify` after each task | 120/1650, 121/1666, 121/1666 files/tests, exit 0 |
| Acceptance greps (WHEN_REQUIRED ×2, signableHeaders, createArtifactModule, pins, due_attachment_sweeps ×3, limitInputPixels/rotate(), attachment.downloaded, garage image, 0 `:?` guards, ocw-e2e-storage ×3, garage in ci.yml, Supersedes) | all satisfied |

**Garage memory (ADR-0015):** idle ~3.5 MiB; peak 34–58 MiB across three runs of 3×5 concurrent 25 MiB uploads (`docker stats`, ~1 s sampling). **Harness ports:** API 4290, web 3290, fake 4291, Garage S3 4292.

Demo untouched: `t3code-81d72154-postgres-1/redis-1` and `ocw-demo-*` kept running; only `-p ocw-e2e-storage` lifecycle commands ran; throwaway probe containers (`ocw-0404-*`) removed.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 3] `buildApp` accepts `secretStore`; `startTestStack` resolves SecretReferences from its env.** The secret never enters `Env`, and the default store reads `process.env`, so a testcontainer's secret was unreachable. Additive test hook (app.ts, testing.ts). Commit a842288.
2. **[Rule 3] `model.ts` added** (`toAttachment`, `AttachmentRow`) so routes and the public index share it without a cycle.
3. **[Rule 2] `config.enabled` includes the caller's `attachment.upload` decision** (the strict authz hook requires a resolver decision on every `user` 2xx).
4. **[Rule 2] Active sniffed types (HTML/SVG/XML/JS) stored as `application/octet-stream`;** `file-type` reports an SVG with an XML prolog as `application/xml`.
5. **[Rule 1] Decompression bombs are rejected (`image_too_large`), not silently left without previews** (behaviour list says "rejected"; action said failures stay ready — applied to non-pixel-limit failures only).
6. **[Rule 2] `due_attachment_sweeps(p_limit, p_now DEFAULT now())`** — second parameter so the injected clock reaches SQL; limit clamped 1..1000.
7. **[Rule 2] `complete` before the PUT → 409 `upload_missing` (stays pending); a ready attachment completes idempotently.**
8. **Task 1 commit reconstruction:** Task 2 code was written before Task 1 was committed; the Task 1 slice of `attachments.ts` was reconstructed and its 13 integration tests re-run green before commit a842288, then the Task 2 version restored.
9. **`.env.example` confirmation:** the permission rules block `git diff` on `.env*`, so the append was confirmed with `git diff --numstat` (14 added, 0 removed vs HEAD and origin/main; 7 `OCW_S3_*` lines). Local `main` is stale (phase 01/02), so the plan's `git diff main` grep would compare against an old file; use origin/main.

### Not changed (per instructions)
- The 04-01 `attachments_unavailable` guard in `chat/index.ts` stays for 04-12.

## Known Stubs

None. `previewUrl`/`largeUrl` are null only for non-images by design.

## Threat model coverage

T-04-04-01 (readable → 404, cross-conversation/org/uploader tests), -02 (403 on signed type mismatch, `type_mismatch`, SVG not inline), -03 (60 s GET, no-store, Location redacted, audit metadata scanned for `X-Amz-`/secret), -04 (`limitInputPixels`, max bytes, 10 per message, 429 at 61), -05 (renditions have no EXIF/XMP/ICC), -06 (RFC 6266 unit tests), -07 (SecretReference, secret-free toml, setup-env), -08 (private bucket, id-only keys), -09 (unreachable store → `unavailable`, boot not blocked), -SC (research pins). No new surface beyond the plan.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/api/src/app.ts --description "buildApp gained an optional secretStore test hook so testcontainer S3 secrets resolve via SecretReference"
gsd windows append --kind deviation --phase 04 --file packages/db/sql/post-migrate.sql --description "app.due_attachment_sweeps takes p_now (default now()) in addition to p_limit, for the sweeper's injectable clock"
```

## Commits

- a842288 feat(api): presigned attachment upload to Garage with authorized download (04-04 task 1)
- 1613b91 feat(api): sniffed, hashed and EXIF-stripped attachments; audited downloads; sweeper (04-04 task 2)
- 7c99c9b feat(infra): Garage in compose, setup-env --add-missing, harness and CI storage, ADR-0015 (04-04 task 3)

## Self-Check: PASSED

All created files exist; commits a842288, 1613b91, 7c99c9b are on wt/04-04.
