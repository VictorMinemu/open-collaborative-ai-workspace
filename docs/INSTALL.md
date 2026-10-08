# Installing Open Collaborative AI Workspace (self-hosted)

This guide takes you from a clean machine to a working MVP 1 instance. It then covers how to expose the instance,
observe it, move its secrets to OpenBao, back it up and upgrade it. Every step is one command. The topic guides in
[`docs/self-hosting/`](self-hosting/) have the details. Decisions behind this setup:
[ADR-0021](adr/0021-self-hosted-release.md).

## Requirements

| What | Version / size |
| --- | --- |
| Docker Engine with Compose v2 (`docker compose`) | Compose 2.20 or newer (for `include:`); tested with Compose 5.3 |
| git | any recent version |
| Node.js | 24 LTS (`.nvmrc` pins the exact version) |
| pnpm | 12, through corepack: `corepack enable` (the version comes from `package.json`) |
| CPU / RAM | 2 vCPU and 4 GB RAM minimum; 4 vCPU and 8 GB recommended; about 1 GB more for the `observability` profile |
| Disk | 20 GB free for images, build cache and data (the OpenClaw cell image alone is about 1.2 GB) |

Node and pnpm run only the `pnpm ocw` command-line tool on the host. The services run in containers.

**Build time.** On a machine that already holds the base images and the build cache,
`docker compose up -d --build --wait` took 79 to 94 s (three `pnpm gate:cleanroom` runs, 2026-10-08). A first build on a clean machine also
downloads the base images and every dependency, so allow 10 to 20 minutes. The owner's clean-machine check below
records the measured time.

## Install

```bash
git clone https://github.com/VictorMinemu/open-collaborative-ai-workspace.git ocw
cd ocw
corepack enable
pnpm ocw setup
docker compose up -d --build --wait
```

- **`pnpm ocw setup`** writes `.env` (mode 0600) from `.env.example`, with every secret generated now: database
  passwords, the auth secret, the encryption key, the setup token, the cell token and the Garage keys. It prints which
  keys it wrote, never their values. It refuses to overwrite an existing `.env`.
  - In a fresh clone, pnpm first installs the workspace dependencies. To skip that on a server,
    `node scripts/ocw.mjs setup` runs the same tool, which uses only Node's built-ins.
- **`docker compose up -d --build --wait`** builds the `api`, `web` and `openclaw` images. It then runs the one-shot
  `migrate` service and waits until every service is healthy.
  - Compose first prints `Error pull access denied for ocw-api`, because that image is built locally, not pulled.
    The line is expected; the build follows.

Then open the web app:

1. Go to **http://localhost:3000/setup**.
2. Read the setup token on the server:

   ```bash
   grep '^OCW_SETUP_TOKEN=' .env
   ```

3. Enter the token and create the organization and the first admin. The token works once.

The API is at http://localhost:4000 (OpenAPI at `/docs`, health at `/health`).

## What runs

The minimal stack in `compose.yaml`:

| Service | Role | Published port |
| --- | --- | --- |
| `postgres` | PostgreSQL 18, the only database | `127.0.0.1:54329` |
| `redis` | Realtime fan-out, presence, rate limits | `127.0.0.1:63799` |
| `garage` | S3-compatible object storage for attachments ([ADR-0015](adr/0015-object-storage-garage.md)) | `127.0.0.1:3900` |
| `migrate` | One-shot: applies migrations and grants, then exits 0 | none |
| `api` | Fastify control plane | `4000` |
| `web` | Next.js app | `3000` |
| `openclaw` | The OpenClaw cell for server-side agents | none |

Three optional profiles stay off until they are named in `COMPOSE_PROFILES` in `.env`: `proxy`, `observability` and
`vault`. The `pnpm ocw enable …` commands below turn them on without a reinstall. Telemetry is off unless an OTLP
endpoint is configured.

## Expose it (HTTPS through Caddy)

```bash
pnpm ocw enable proxy --site-address ocw.example.com
```

This puts web, API, WebSockets and attachments on one HTTPS origin (`https://ocw.example.com`), with a certificate
from Let's Encrypt. It also republishes api and web on loopback only and trusts exactly one proxy hop.

- The DNS name must point at the server, and ports 80 and 443 must be open.
- For an internal name, add `--tls internal`.
- To use your own reverse proxy instead, see the reverse-proxy guide.

Details and the trusted-proxy caveat: [reverse-proxy.md](self-hosting/reverse-proxy.md).

## Observe it

```bash
pnpm ocw enable observability
```

This starts the OpenTelemetry Collector, Tempo, Prometheus, Loki and Grafana, and recreates only the api with the
OTLP endpoint. Grafana listens on `127.0.0.1:3301` behind a generated password. Prompts, secrets, query strings and
host paths are never exported. See [observability.md](self-hosting/observability.md).

## Secrets and OpenBao

Every secret is either a value in `.env` or a file: `NAME_FILE=/path`, for Docker or Kubernetes secrets and anything
outside compose. To move the four secrets that only the API reads into OpenBao:

```bash
pnpm ocw enable vault
```

These are `BETTER_AUTH_SECRET`, `OCW_ENCRYPTION_KEY`, `OCW_SETUP_TOKEN` and `OCW_SMTP_URL`. They become `openbao://`
references, and OpenBao unseals itself from a key file in `secrets/`. Back up `secrets/` with `.env`. See
[secrets.md](self-hosting/secrets.md).

## Back up, restore and upgrade

```bash
pnpm ocw backup                    # database, objects, cell state (and OpenBao with the vault on) → backups/<time>/
pnpm ocw restore backups/<time> --yes
```

The runbook covers cron, `--consistent`, restoring onto a new machine, upgrading and rolling back:
[backup-restore.md](self-hosting/backup-restore.md). An upgrade is a backup, `git checkout <tag>`,
`pnpm ocw setup --add-missing`, then `docker compose up -d --build --wait`. The API refuses to start on a schema it
does not match.

> A backup never contains `.env`. With the vault on, it does contain OpenBao's seal key, so it can unseal the secrets
> by itself. Keep it as private as `.env`.

## A second instance on the same host

```bash
git clone https://github.com/VictorMinemu/open-collaborative-ai-workspace.git ocw-staging && cd ocw-staging
pnpm ocw setup --ports 35 --project ocw-staging --image-tag staging
docker compose up -d --build --wait
```

`--ports 35` moves every published port into the block 3500-3599: web 3500, api 3501, postgres 3502, redis 3503,
S3 3504, Grafana 3505, and the proxy on 3543 and 3580. `--project` keeps its containers and volumes apart, and
`--image-tag` keeps its images apart.

## Troubleshooting

**A secret is missing.** Compose stops before starting anything, for example:

```text
required variable BETTER_AUTH_SECRET is missing a value: Set BETTER_AUTH_SECRET in .env (run pnpm setup:env)
```

If the API itself is missing a secret, it exits naming it (`docker compose logs api`):

```text
Invalid API configuration (see .env.example):
  - OCW_ENCRYPTION_KEY: … (set OCW_ENCRYPTION_KEY or OCW_ENCRYPTION_KEY_FILE)
```

Run `pnpm ocw setup --add-missing`. It appends only the missing keys and never rotates existing values.

**The schema does not match the image.** The API exits with one of these messages:

```text
Database schema is behind this API (N pending, newest X). Run: docker compose run --rm migrate (from a source checkout: pnpm db:migrate)
Database was migrated by a newer release (unknown: Y). Restore a backup or run the newer image.
```

The first means `migrate` did not run or failed: run it and read its error. The second means an older image is
running on a newer database: run the newer release, or roll back with a restore. All four messages, with their fixes,
are in [backup-restore.md](self-hosting/backup-restore.md#upgrading).

**A port is already in use.** `Bind for 0.0.0.0:3000 failed: port is already allocated` means another program holds
the port. Move the whole install to another port block with `pnpm ocw setup --force --ports 35`. Note that `--force`
rotates every secret, so use it only on an install without data. Alternatively, change the single `OCW_*_PORT` value
in `.env`.

**The first build is slow.** The OpenClaw cell image and the web build take most of the time. A failed build
(network, disk) can be resumed with the same `docker compose up -d --build --wait`, which reuses the finished layers.
Check free space with `docker system df`.

**The OpenClaw cell is not healthy yet.** On first boot its gateway can take a few minutes; `--wait` waits for it.
`docker compose logs openclaw` shows its progress.

## Uninstall

```bash
docker compose down              # stops and removes the containers; data volumes are kept
docker compose down -v           # also deletes every volume: database, objects, cell state (cannot be undone)
```

Then delete the directory. It contains `.env`, `secrets/` and `backups/`, all of which are sensitive.

## Clean-machine check

The owner's install on a machine that has never had this repository, its images or a pnpm store (a fresh VM or a
spare server). It repeats what `pnpm gate:cleanroom` proves on a development machine, and adds cold downloads and a
real Linux host.

1. Install Docker Engine with Compose, git and Node 24, then run `corepack enable`.
2. Follow [Install](#install) exactly: `git clone …`, `pnpm ocw setup`, `docker compose up -d --build --wait`. Note
   the total time.
3. Open the web URL and create the organization and admin with the setup token read from `.env`.
4. Invite a second user and accept the invitation in another browser. Post in a channel and check that the message
   appears live in both browsers. Upload an image attachment and open it.
5. Optional, if the machine has a DNS name with ports 80 and 443 open: run
   `pnpm ocw enable proxy --site-address <name>`, then repeat step 4 over https.
6. Optional: run `pnpm ocw enable vault` (checks OpenBao's capabilities on Linux), then `pnpm ocw backup`, and check
   that the backup directory and its `manifest.json` exist.
7. Record the result below.

| Field | Value |
| --- | --- |
| Date | _pending_ |
| Machine (provider, OS, vCPU / RAM / disk) | _pending_ |
| Docker / Compose / Node versions | _pending_ |
| `pnpm ocw setup` time (including the dependency install) | _pending_ |
| `docker compose up -d --build --wait` time (cold) | _pending_ |
| Steps 3-4 (setup, invite, live message, attachment) | _pending_ |
| Optional: proxy over https / vault / backup | _pending_ |
| Result | **Deferred (`human_needed`)**: the owner has not run this check yet (2026-10-08) |
