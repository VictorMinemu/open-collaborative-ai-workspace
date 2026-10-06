# Garage: object storage for chat attachments

[Garage](https://garagehq.deuxfleurs.fr/) v2.4.1 (AGPL-3.0) is the S3-compatible store in the self-hosted stack
(ADR-0015, which supersedes the MinIO clause of ADR-0003). It runs as one process with no init container:
`garage server --single-node --default-bucket` creates the cluster layout, the access key and the private
`ocw-attachments` bucket on first start. The S3 API is the contract, so any S3-compatible store (SeaweedFS, AWS S3,
Cloudflare R2) works by pointing the `OCW_S3_*` variables at it.

## How the stack uses it

- Browsers upload straight to Garage with a presigned `PUT` (5 minutes, content type and length signed), then
  call `POST /api/v1/attachments/:id/complete`. The API checks the size, sniffs the type from the first bytes,
  hashes the file and writes EXIF-free webp previews.
- Downloads and previews go through the API (`/api/v1/attachments/:id/{download,preview,large}`). The API checks
  that the caller can read the conversation and then redirects to a presigned `GET` that is valid for 60 seconds.
  The bucket is never public, and object keys contain ids only (`org/<orgId>/conv/<convId>/att/<attId>/…`).
- The API sets the bucket CORS policy itself when it starts (`PUT` and `GET` from `OCW_PUBLIC_WEB_URL` and
  `OCW_TRUSTED_ORIGINS`). Until Garage answers, attachments report `enabled: false` (`reason: "unavailable"`).
  The API keeps retrying in the background and never fails to start because of Garage.

## Ports

| Port | Purpose | Published |
| --- | --- | --- |
| 3900 | S3 API | `127.0.0.1:${OCW_S3_PORT:-3900}` only, for presigned browser URLs |
| 3901 | RPC between nodes (unused by a single node) | no |
| 3903 | Admin API (needs `GARAGE_ADMIN_TOKEN`, unset by default) | no |

The isolated e2e harness (`scripts/e2e-isolated.sh`) runs its own Garage in the `ocw-e2e-storage` compose project
on `127.0.0.1:4292`. It never touches the demo stack.

## Keys

| Variable | Used by | Format |
| --- | --- | --- |
| `GARAGE_RPC_SECRET` | garage | 64 hex characters |
| `OCW_S3_ACCESS_KEY_ID` | garage (default key) and api | `GK` + 24 hex characters |
| `OCW_S3_SECRET_ACCESS_KEY` | garage (default key) and api (SecretReference, `_FILE` supported) | 64 hex characters |
| `OCW_S3_PUBLIC_URL` | api (presigning) | URL the browser reaches, default `http://localhost:3900` |
| `OCW_S3_BUCKET`, `OCW_S3_REGION` | both | `ocw-attachments`, `garage` |
| `OCW_ATTACHMENT_MAX_BYTES` | api | per-file limit, default 26214400 (25 MiB), at most 1 GiB |

`pnpm setup:env` generates the three secrets. `garage.toml` contains no secret; Garage reads them from the
environment.

### Upgrading an existing install

An `.env` written before attachments existed lacks these keys. Without them Garage exits at start (it requires an
RPC secret) and the API reports attachments as disabled. Postgres, Redis, chat and everything else keep working,
because compose uses no `:?` guard for these variables. To enable attachments:

```bash
pnpm setup:env --add-missing   # appends only the keys your .env lacks; never rotates an existing value
docker compose up -d
```

`--force` rewrites the whole `.env` and rotates every secret, including the database passwords. Do not use it to
upgrade.

## Not in Phase 4

- **Encryption at rest:** Garage has no SSE-S3. Use an encrypted volume or disk on the host now. SSE-C or an
  `encrypted only` artifact policy comes with Phase 12 (ART-03).
- **Antivirus:** ClamAV needs 3 to 4 GiB of RAM, which is too much for the small-VM target (P-12). Files are
  sniffed, never served inline unless the API rendered them, and always downloaded as `attachment`. The
  `scan_status` column leaves room for an optional scanner profile later.
- **Versioning and object lock:** Garage does not support them. If they become requirements, ADR-0015 lists
  SeaweedFS as the fallback.
