# ADR-0015: Object storage is Garage, accessed only through the S3 API and presigned URLs

## Status

Accepted (owner-delegated decision D-03 in `.planning/phases/04-chat/04-CONTEXT.md`).
**Date:** 2026-10-06. Supersedes the "MinIO in self-hosted compose" clause of
[ADR-0003](0003-infrastructure-baseline.md). ADR-0003 is not edited, and the rest of it stands: S3-compatible
object storage is still part of the baseline.

## Context

Phase 4 adds file and image attachments to chat (CHAT-12), and Phase 12 adds artifacts that the Local Runtime
uploads. ADR-0003 chose MinIO for the self-hosted stack. Since then, upstream MinIO Community Edition went into
maintenance mode (2025-12-03), stopped publishing binaries and images, stripped its console, and archived its
repository (2026-04). Its Docker Hub repository returns 404. A default that no longer ships images cannot be in
`docker compose up` (principle 10).

The store must meet these requirements:

- S3-compatible, so any provider can replace it.
- Open source and self-hostable.
- Small enough for the small-VM target.
- Supports presigned URLs and bucket CORS, so browsers upload directly.
- Simple to boot: no init container, and no manual key or bucket step.

## Decision

1. **Garage v2.4.1, single node**, as the `garage` service in `compose.yaml`. `garage server --single-node
   --default-bucket` creates the layout, the access key and the private `ocw-attachments` bucket on first start from
   `GARAGE_DEFAULT_*`. `infra/garage/garage.toml` holds no secret. The S3 port is published on `127.0.0.1` only.
   The service has no healthcheck, because the image has no shell or probe tool; the API retries instead.
2. **The S3 API is the contract.** The API uses `@aws-sdk/client-s3` and nothing Garage-specific. Any
   S3-compatible store (SeaweedFS, AWS S3, Cloudflare R2) works by changing the `OCW_S3_*` variables.
3. **Presigned direct PUT.** Browsers upload straight to the store:
   - The API presigns a `PUT` (300 s) with the content type in the signed headers (`signableHeaders`) and the
     length signed too. A different type gets 403 from the store.
   - Then `POST /attachments/:id/complete` verifies the upload: the size must match, the type is sniffed from the
     first 4100 bytes with `file-type`, and the SHA-256 is computed by streaming the object. A declared image whose
     bytes are something else is rejected (`type_mismatch`).
   - The bytes never cross the API. Phase 12 needs the same flow for daemon uploads.
4. **Two endpoints.** Server calls use `OCW_S3_ENDPOINT` (e.g. `http://garage:3900`). Presigned URLs are signed for
   `OCW_S3_PUBLIC_URL`, because SigV4 signs the Host header.
5. **SDK checksums: `requestChecksumCalculation` and `responseChecksumValidation` are `WHEN_REQUIRED`.** With the
   SDK default, a presigned PUT carries the CRC32 of an empty body, and Garage refuses it with `400 InvalidDigest`.
6. **Renditions.** For sniffed raster images (PNG, JPEG, GIF, WebP), sharp writes `thumb.webp` (720 px) and
   `large.webp` (2048 px):
   - `limitInputPixels` refuses decompression bombs (`image_too_large`).
   - `rotate()` applies the EXIF orientation before resizing.
   - No metadata is copied, so EXIF, GPS, XMP and ICC are stripped.

   SVG, HTML and XML are never images, and they are stored as `application/octet-stream`.
7. **Keys, bucket and access control.**
   - Object keys are tenant-scoped and contain ids only: `org/<orgId>/conv/<convId>/att/<attId>/{original,
     thumb.webp,large.webp}`. A filename never appears in a key.
   - The bucket is private. Garage has no bucket policies or ACLs, so access is by signature only.
   - **The API is the only ACL.** Every download, preview and completion resolves the attachment's conversation
     through the readable set (`channel.read`, hidden = 404).
   - After that check, the API redirects to a presigned `GET` that is valid for 60 s. The `302` carries
     `Cache-Control: private, no-store`.
   - Originals are always served with `attachment` disposition (RFC 6266 `filename*`). Only the API's own webp
     renditions are served `inline`.
8. **Audit.**
   - `attachment.uploaded` records `{attachmentId, conversationId, size, contentType, sha256}`.
   - `attachment.downloaded` records `{attachmentId, conversationId}`.
   - **Previews are not audited.** A message list loads one per image, which would drown the audit log. The
     original, which keeps the uploader's EXIF, can only be fetched through the audited download.
   - URLs and signed query strings never reach audit metadata or logs. The `Location` response header is redacted.
9. **Optional by configuration.** Storage is configured only when the endpoint, the key id and the secret
   (SecretReference `OCW_S3_SECRET_ACCESS_KEY`, `_FILE` supported) are all present. Otherwise
   `GET /attachments/config` answers `enabled: false, reason: "not_configured"`.
   - Bucket CORS (`PUT`/`GET` from the web origins) is set by the API in the background, with backoff. Until
     that succeeds, the config answers `reason: "unavailable"`.
   - Compose uses **no `:?` guard** for any Garage or S3 variable. Compose interpolates every service, so a guard
     would break `docker compose up postgres redis` for installs whose `.env` predates Garage. Those installs run
     `pnpm setup:env --add-missing`.
10. **Retention.** A sweeper (every 10 minutes, `pg_try_advisory_lock`, SECURITY DEFINER `app.due_attachment_sweeps`
    returning ids only) deletes objects in each organization's own tenant transaction:
    - uploads still pending or rejected after 24 h;
    - attachments of messages deleted 30 days ago.
11. **Rate limit.** Presigns are limited to 60 per minute per user (P-11). Files are limited to
    `OCW_ATTACHMENT_MAX_BYTES` (25 MiB by default, 1 GiB at most) and 10 per message.

## Alternatives considered

- **SeaweedFS 4.48** (Apache-2.0, weekly releases): it has more features (versioning, IAM), but a heavier
  multi-component process model and a ~197 MB image against ~27 MB for Garage. It is the fallback if versioning or
  object lock become requirements; because the S3 API is the contract, switching only changes configuration.
- **RustFS 1.0.1** (Apache-2.0): it has a MinIO-like feature set, but it reached 1.0 days before this decision and
  recently had CVE-2025-68926 (CVSS 9.8, a hardcoded gRPC token). It is too young for a default.
- **MinIO forks** (e.g. Pigsty "Silo"): they keep the MinIO console, but depend on one small maintainer now that
  upstream is archived.
- **API-proxied upload**: one origin and no public storage URL, but every byte crosses the API process, and Phase 12
  needs presigned uploads from the daemon anyway.

## Consequences

- **No versioning and no object lock** (Garage does not implement them). Deleted attachments are purged after
  30 days.
- **Encryption at rest is deferred to Phase 12** (ART-03, an "encrypted only" policy). Garage has no SSE-S3. Until
  then, operators encrypt the host volume or disk. SSE-C, which Garage supports, is the likely Phase 12 path.
- **Antivirus is deferred** (P-12). ClamAV needs 3 to 4 GiB of RAM, which breaks the small-VM target. Sniffing,
  `attachment` disposition, renditions-only inline display and a separate storage origin limit the risk meanwhile.
  The `scan_status` column leaves room for an optional scanner profile.
- **The storage origin is a second browser-facing URL** (`OCW_S3_PUBLIC_URL`, loopback-only `:3900` in compose).
  LAN or public deployments must put it behind the reverse proxy (Phase 7) with the Host header preserved.
- **Memory.** Garage idles at about 3.5 MiB RSS. In the integration suite (`attachments.int.test.ts`, three rounds of
  five concurrent 25 MiB uploads through presign, PUT and complete), `docker stats` measured a peak of **34 to 58 MiB**
  across three runs, sampled about once per second. That is small next to PostgreSQL and the OpenClaw cell.
- **Upgrades** need one manual step for existing installs: `pnpm setup:env --add-missing`. Without it Garage
  does not start and attachments report `enabled: false`. Nothing else is affected.
- The isolated e2e harness runs its own Garage (`ocw-e2e-storage` compose project, `127.0.0.1:4292`), and CI starts
  `garage` with `postgres` and `redis`.
