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

## Install with one command (Linux server)

On Ubuntu 24.04 or Debian 12, [`scripts/install.sh`](../scripts/install.sh) runs every step below:

```bash
curl -fsSL https://raw.githubusercontent.com/VictorMinemu/open-collaborative-ai-workspace/main/scripts/install.sh \
  | sudo bash -s -- --domain ocw.example.com
```

To read it first, `curl -fsSLo install.sh <same URL>`, then `sudo bash install.sh --domain ocw.example.com`.

It installs the prerequisites when they are missing: git, Docker Engine with Compose from Docker's apt repository,
and Node 24, checksum-verified from nodejs.org. Then it:

1. clones into `/opt/ocw`;
2. runs `ocw setup`;
3. runs `ocw enable proxy --site-address <domain>`;
4. runs `docker compose up -d --build --wait`.

Re-running it resumes a failed install. It never overwrites `.env` or rotates a secret. From a checkout,
`sudo ./scripts/install.sh --domain …` installs that checkout in place. `--help` lists the options:

| Option | Effect |
| --- | --- |
| `--domain <IPv4>` | Caddy's internal CA instead of Let's Encrypt |
| `--tls internal` | Caddy's internal CA for a DNS name too |
| `--local` | No proxy |
| `--dir` | Install directory (default `/opt/ocw`) |
| `--ref` | Branch or tag to install (default `main`) |
| `--prepare-only` | Install the prerequisites only |
| `--dry-run` | Print the steps without changing anything |

The README walks a team through the first hour after the install: [the tutorial](../README.md#install-it-on-a-server).

## Install

The same steps by hand, on any host with the [requirements](#requirements):

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
| `migrate` | One-shot: applies migrations and grants and installs the job queue (`pgboss`), then exits 0 | none |
| `api` | Fastify control plane | `4000` |
| `web` | Next.js app | `3000` |
| `openclaw` | The OpenClaw cell for server-side agents | none |

Five optional profiles stay off until they are named in `COMPOSE_PROFILES` in `.env`: `proxy`, `observability`,
`vault`, `pii` and `sandbox`. The `pnpm ocw enable …` commands below turn on the first three without a reinstall;
`pii` and `sandbox` are two lines in `.env` each (see below). Telemetry is off unless an OTLP endpoint is configured.

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

## Sensitive-data scan (optional `pii` profile)

Before anyone approves a memory proposal, OCW scans the proposed text. The built-in scan always runs. It blocks
secrets and flags IBANs, cards, NIF/NIE, e-mails and phone numbers. The `pii` profile adds Microsoft Presidio in
Spanish and English. It flags names, places and the same identifiers with more context. Its findings are shown,
masked, on the approval card. Nothing is ever approved automatically.

To turn it on, add these two lines to `.env`. If `COMPOSE_PROFILES` already exists, append `pii` to it, for example
`COMPOSE_PROFILES=vault,pii`.

```dotenv
COMPOSE_PROFILES=pii
OCW_PRESIDIO_URL=http://presidio:3000
```

Then run `docker compose up -d --build --wait`.

- **What it runs.** The `presidio` container (`infra/presidio`) is Microsoft's `presidio-analyzer` image, pinned by
  digest. It adds the Spanish spaCy model, pinned by hash, next to the English one.
- **Isolation.** The container has no published port, a read-only root and no capabilities. It sits on an internal
  network shared only with the api. Text goes from the api to this container and nowhere else: it never leaves the
  host, and neither side logs it.
- **Resources.** About 600 MB of image and 1 GB of RAM while idle (limit 1.5 GB). It is ready about 10 s after start.
  Each scan sends at most 100 KB of text per language.
- **Options.** `OCW_PRESIDIO_LANGUAGES` defaults to `es,en`. `OCW_PRESIDIO_TIMEOUT_MS` defaults to `2000` and accepts
  100 to 10000.
- **When it does not answer.** If Presidio is down, slow past the timeout or returns something unexpected, the
  proposal still goes ahead with the built-in findings. The card then shows **"Extended scan unavailable"**, and the
  approver decides knowing that. A text over 100 KB is scanned up to that point and marked **"Extended scan
  partial"**.
- **Licences.** Presidio is MIT. The Spanish model (`es_core_news_md`) is GPL-3.0. It runs only inside this
  separate, optional container and is never linked into OCW.

Check it with `docker compose ps presidio` (healthy) and `docker compose logs presidio`. Developers can run
`bash infra/presidio/smoke.sh`, which builds the image and tests Spanish and English under its own project, then
removes everything it created.

## Bot sandboxes and browser (optional `sandbox` profile)

Each bot can get its own isolated sandbox (files, shell, approved packages) and its own Chromium, which people watch
live and take over to sign in (ADR-0029). Nothing of this runs until you turn on the profile **and** an admin
turns on Sandbox & Browser in Settings (off by default), and then each bot's switch.

To turn it on, add these two lines to `.env`. If `COMPOSE_PROFILES` already exists, append `sandbox` to it.
`OCW_SANDBOX_TOKEN` is already there: `pnpm ocw setup` writes it, and `pnpm ocw setup --add-missing` adds it to an
install that predates it.

```dotenv
COMPOSE_PROFILES=sandbox
OCW_SANDBOX_URL=http://sandboxd:8090
```

Then run `docker compose up -d --build --wait` and open Settings › Sandbox & Browser, which shows the isolation in use.

- **What it runs.** `sandboxd` (`infra/sandbox/sandboxd`), the broker, is the only service that holds the Docker
  socket. It creates each bot's containers from a fixed spec: a `sbx` shell, a `brw` browser, and one
  `sandbox-egress` proxy, which is every sandbox's only way out. Compose builds those three images but never starts
  them (`scale: 0`).
- **Isolation.** sandboxd publishes no port and sits on the internal `sandbox-control` network, shared only with the
  api. The openclaw cell can never reach it. The broker runs as root only because the socket needs it. It has a
  read-only root, no capabilities and `no-new-privileges`. Every bot container runs as uid 10001 with a read-only root,
  no capabilities, limits, no host mounts and its own internal network.
- **gVisor.** With `OCW_SANDBOX_RUNTIME=auto` (the default), sandboxes run under gVisor `runsc` when the Docker daemon
  has it registered, and otherwise on hardened runc. Settings says which. Under runc on hosts that restrict
  unprivileged user namespaces (Ubuntu 23.10 and later), Chromium runs without its own sandbox, and Settings shows
  **container-only**. To install gVisor, use the GitHub release `google/gvisor` `release-20261005.0`, check its SHA512,
  and install the whole tarball (`runsc` plus `gvisor-bin/`); `runsc` alone does not start. Then register it in
  `/etc/docker/daemon.json` with `--platform=systrap`. `OCW_SANDBOX_RUNTIME=runsc` refuses to start without it.
  gVisor does not answer Docker's internal DNS on the sandbox networks, so sandboxd writes the egress proxy's address
  into each sandbox's `/etc/hosts` when it creates it. If the proxy restarts, a stopped sandbox is recreated with the
  new address on its next start (its workspace is kept), and a running one at its next restart or start.
- **Host hardening.** Anyone who controls sandboxd controls the host's Docker. Consider rootless Docker or a Docker
  authorization plugin behind the socket, and an XFS project quota for hard disk limits. Docker 26 or later is
  required: older internal networks forward DNS.
- **Resources.** About 2 GB of images, of which the browser is 1.2 GB. Each running browser needs up to 2 GB of RAM
  and each shell up to its configured limit.
- **Options.** `.env.example` lists them with their defaults: `OCW_SANDBOX_RUNTIME`, `OCW_SANDBOX_NAMESPACE` (default:
  the compose project), `OCW_SANDBOXD_SWEEP_MS`, the package registries (`OCW_SANDBOX_NPM_REGISTRY`,
  `OCW_SANDBOX_PYPI_INDEX`, `OCW_SANDBOX_REGISTRIES`) and `OCW_CLAWHUB_URL`, which the api, the cell and sandboxd
  share.
- **Removing it.** `docker compose down` does not remove the bots' sandboxes, because sandboxd created them, not
  compose. List them with `docker ps -a --filter label=ocw.namespace=<project>`. They are removed when a bot is deleted.
  To remove them all, use `docker rm -f` on that list, then the same filter with `docker network ls` and
  `docker volume ls`.

Developers run the real-Docker smokes with `bash infra/sandbox/test/run-sandbox-smoke.sh` (and `run-egress-`,
`run-browser-`, `run-stack-` and `run-packages-smoke.sh`). Each one removes everything it created, by label.

Settings, limits, network modes, sandbox packages and sign-ins are explained in
[self-hosting/sandbox.md](self-hosting/sandbox.md); the gVisor install, rootless Docker, a Docker authorization plugin
and XFS project quotas in [infra/sandbox/README.md](../infra/sandbox/README.md).

## Work Zone servers (no desktop app)

A Linux or macOS machine can run Work Zone sessions for the team without the desktop app. Your workspace serves the
Local Runtime and its installer (`/api/v1/runtime/install.sh`, shown in Settings › Devices › Add a device › Server).
On the server, `ocw-runtime setup` pairs it with a code you approve in the web, registers repositories and installs a
systemd or launchd service; `ocw-runtime doctor` checks it. You then share the server with members and teams in
Settings › Devices. Requirements, sign-ins, the service, proxies and troubleshooting: [SERVER.md](SERVER.md).

A server's runtime updates itself from your workspace: one click on **Update** in Settings › Devices › the server's
card › Runtime updates, or by itself at the organization's *Automatic* level. It waits until no turn runs and restarts
through systemd or launchd. A server still on v0.3.0 needs the install command once more; after that, updates are one
click. Details: [SERVER.md › Updates](SERVER.md#updates).

## Automations and job workers

Bots' automations (schedules, signed webhooks, mailboxes), watched records, digests and Work Zone summaries run as jobs
in PostgreSQL, in the `pgboss` schema the `migrate` service installs; no extra service runs. Every API replica runs
the job workers unless `OCW_JOBS_WORKER=off` is set in `.env` (keep at least one replica on). Webhook URLs, mail app
passwords through Keychain, limits, retention and troubleshooting:
[self-hosting/automations.md](self-hosting/automations.md).

## Long bot conversations

When a bot's conversation outgrows its model, the cell summarizes the older part. How (strict summaries, identifiers,
recent history kept, a fresh session when a summary fails) is set in Settings › Bot policy › Conversations:
[self-hosting/bot-conversations.md](self-hosting/bot-conversations.md).

## Keep Claude Code and Codex up to date on devices

The Local Runtime on each device (desktop app or headless daemon) keeps the Claude Code and Codex CLIs it drives up to
date by itself. It never cuts a running turn: it updates a CLI when that CLI has no turn running on the device, and
new turns wait a few minutes at most (ADR-0032). This matters most on a shared server where several members run
sessions and nobody watches the machine.

**Install the CLIs so the daemon can update them.** Install them as the same OS user that runs the daemon, in that
user's home:

- Claude Code with Anthropic's native installer (`curl -fsSL https://claude.ai/install.sh | bash`): it lives in
  `~/.local/bin` and `~/.local/share/claude`, and the daemon updates it with `claude update`.
- Codex with OpenAI's standalone installer (see the Codex README): it lives in `~/.codex/packages/standalone` (or
  under `CODEX_HOME`), and the daemon updates it with `codex update`.
- An npm global install in a prefix the daemon's user owns (for example under nvm) and a Homebrew install owned by
  that user also work.

Root-owned installs (apt, dnf or apk packages, a system npm prefix such as `/usr/lib/node_modules`, another user's
Homebrew) are shown as **Needs admin on this machine** with the command to run, and the daemon never runs it. It
never uses `sudo`. pnpm, bun, yarn, Volta, mise and asdf installs are shown with their command and stay manual.

**Levels.** The organization's level is in Settings › Work Zone policy › Runtime updates:

| Level | What the device does |
|---|---|
| Automatic (default) | Checks at start and every 6 hours, and installs a newer version when the CLI is idle |
| Notify only | Checks and shows "{version} available"; installs only when the owner or an admin presses Update now |
| Off | Never asks for the latest version and never installs |

A device can only lower that level:

```bash
ocw-runtime updates notify          # or automatic | off; written to runtime.json, applied at once
ocw-runtime updates status          # what the daemon sees: versions, install method, level
ocw-runtime updates check           # check now
ocw-runtime updates now claude-code # update one CLI now (waits for its running turns to end)
```

`OCW_RUNTIME_UPDATES=automatic|notify|off` in the daemon's environment wins over `runtime.json`. The desktop app has
the same choice in its tray menu (Runtime updates). A daemon that has not heard from its server yet behaves as
*Notify only*.

**Network.** To learn the latest version the device asks the npm registry (`https://registry.npmjs.org`) for
`@anthropic-ai/claude-code` and `@openai/codex`. Set `OCW_RUNTIME_REGISTRY_URL` in the daemon's environment to use a
corporate npm mirror instead. The device makes no other outbound call for this, besides what the installer itself
downloads. At *Off* it makes none.

The owner and admins see versions, status and history in Settings › Devices; other members see only the versions.

The runtime itself follows the same level on servers: the **OCW runtime** row in the same list updates it to the
build your workspace serves ([SERVER.md › Updates](SERVER.md#updates)). On a desktop, the runtime ships inside the
app and changes when you install a new app release.

## Back up, restore and upgrade

```bash
pnpm ocw backup                    # database, objects, cell state (and OpenBao with the vault on) → backups/<time>/
pnpm ocw restore backups/<time> --yes
```

Upgrade to the newest release with one command:

```bash
pnpm ocw upgrade --check           # current and newest release; changes nothing
pnpm ocw upgrade                   # backup → git checkout <tag> → new keys → docker compose up -d --build --wait
```

The runbook covers cron, `--consistent`, restoring onto a new machine, upgrading and rolling back:
[backup-restore.md](self-hosting/backup-restore.md). The API refuses to start on a schema it does not match.

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
