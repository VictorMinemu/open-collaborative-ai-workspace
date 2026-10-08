# ADR-0021: Self-hosted release — profiles, `pnpm ocw`, schema guard, backups, proxy, guardrails and the local gate

## Status

Accepted (owner-delegated decisions D-01 … D-18 in `.planning/phases/07-self-hosted-release/07-CONTEXT.md`), **except
two license points that are pending owner/legal confirmation** before public distribution:

- the `@anthropic-ai/claude-agent-sdk` exception (decision 11);
- the `@modelcontextprotocol/server-everything` clarification (decision 11).

**Date:** 2026-10-08. Extends [ADR-0003](0003-infrastructure-baseline.md) (OpenBao and observability as compose
profiles) and [ADR-0015](0015-object-storage-garage.md) (presigned URLs behind one public origin). Neither is edited.

## Context

Phase 7 closes MVP 1. Any engineering team must be able to install, upgrade, back up, observe and expose an instance
with one command each, and the MVP 1 acceptance scenario (Scenario B minus Work Zone creation) must run against that
exact stack (SELF-01 … SELF-07, FOUND-05 … FOUND-07).

Three constraints shaped the decisions:

- **CI was unavailable.** GitHub Actions was blocked by account billing during the phase.
- **The owner's demo runs on the same Docker daemon.** It uses project `t3code-81d72154`, ports 3000/4000 and the
  `:local` images.
- **Principle 10.** Nothing core may need the managed cloud or a paid service.

## Decision

1. **Optional profiles through compose `include:`.** `compose.yaml` stays the minimal stack: postgres, redis,
   garage, the one-shot `migrate`, api, web and the OpenClaw cell. It includes three files whose services carry a
   profile, so they stay off until named in `COMPOSE_PROFILES` in `.env`:
   - `infra/caddy/compose.yaml` (`proxy`);
   - `infra/observability/compose.yaml` (`observability`);
   - `infra/openbao/compose.yaml` (`vault`).

   Each profile can be turned on later without reinstalling. This extends ADR-0003, which named OpenBao and
   observability as optional.
2. **`OCW_IMAGE_TAG` and isolated projects.** Locally built images are `ocw-<service>:${OCW_IMAGE_TAG:-local}`.
   Gate stacks use their own projects and tags:
   - projects `ocw-gate-<run>` and `ocw-cleanroom-<run>`;
   - tags `gate-<sha>-<run>` and `cleanroom-<sha>-<run>`;
   - a port block `NN00-NN99`, 34xx by default.

   A gate never builds or removes another stack's images. `scripts/gate/lib.mjs` `assertSafe` refuses the demo's
   project, ports, `:local` tag and env files before any Docker call.
3. **The `pnpm ocw` CLI** is dependency-free Node in `scripts/ocw/`:
   - `setup` (with `--ports`, `--project`, `--image-tag`, `--add-missing`, `--force`);
   - `enable proxy|observability|vault`;
   - `backup` and `restore`.

   Secrets are generated **only at setup**, into a 0600 `.env`, and never at boot. Commands print key names and paths,
   never values (D-13). `pnpm setup:env` remains an alias.
4. **OpenBao for the four API-only secrets.** These are `BETTER_AUTH_SECRET`, `OCW_ENCRYPTION_KEY`, `OCW_SETUP_TOKEN`
   and `OCW_SMTP_URL`.
   - They live in KV v2 and are referenced as `openbao://secret/ocw/api#FIELD`.
   - The API resolves them once at boot through the same `SecretStore` interface as env/file, logging in with AppRole.
   - OpenBao runs in server mode with integrated (raft) storage and static auto-unseal from a key file in `secrets/`,
     with no published port.
   - Secrets shared with other containers (database passwords, the cell token, Garage keys) stay env/file.
5. **Telemetry is off unless an OTLP endpoint is set** (`OTEL_EXPORTER_OTLP_ENDPOINT`). Without one, no SDK module is
   loaded.
   - Redaction happens at the source and again in the collector: no query strings, credentials, prompts, argv or
     absolute host paths. AI SDK telemetry never records prompts, and a Semgrep rule enforces that.
   - The `observability` profile is the OTel Collector, Tempo, Prometheus, Loki and Grafana. All are self-hosted and
     pinned. Grafana is on loopback behind a generated password.
6. **Schema guard and the N-1 rule.**
   - At boot the API compares `drizzle.__drizzle_migrations` (names and sha256) with the migrations it ships. It exits
     with one clear message when the database is behind, ahead ("migrated by a newer release"), diverged or never
     migrated.
   - The `N-1 → N` upgrade test restores a committed golden dump and migrates it to HEAD on every `pnpm verify`.
   - **N-1 is the Phase 5 merge `3bbcbd9` until `v0.1.0`; from then on it is the previous release tag.** `v0.1.0` is
     tagged by the orchestrator when this phase merges (D-17). The baseline moves with
     `pnpm --filter @ocw/db upgrade:baseline <tag>`.
7. **Backup format and restore sequence.**
   - **Backup contents.** One 0700 directory holds:
     - `pg_dump -Fc` of the whole database, taken as `ocw_migrator`;
     - every bucket object, with its content type, in a sha256-named file;
     - the OpenClaw cell's state;
     - a sha256 manifest.

     With the `vault` profile on, the backup also holds OpenBao's raft data, the seal key and the init material.
   - **Restore** refuses newer or tampered backups. It drops and recreates the schemas, runs `pg_restore` as
     `ocw_migrator` and then `migrate`, and replaces the bucket exactly (`--delete-extra`). It also works onto brand-new
     volumes.
   - **What is excluded.** `.env` is never put in the archive. Without the vault, `secrets/` is excluded too.
8. **One public origin behind Caddy.** `pnpm ocw enable proxy --site-address <host>` sets everything up:
   - web, API, both WebSockets, `/docs`, `/health` and the attachments bucket are served on one HTTPS origin;
   - api and web are published on loopback only;
   - `OCW_TRUST_PROXY=1` is set, so the API takes the client IP from `X-Forwarded-For` only from that one hop.

   Presigned URLs are signed for the public origin (`OCW_S3_PUBLIC_URL`). This extends ADR-0015 decision 4.
   `OCW_TRUST_PROXY` defaults to false.
9. **Guardrails in `pnpm verify`.** `verify` is `lint && guard && typecheck && test`. `pnpm guard` runs:
   - five pinned Semgrep rules: permission-bypass tokens, RLS bypass, skipped or focused policy tests, and
     AI-telemetry prompts. Their only allowlist is ADR-0012's full-access path;
   - the dependency-license policy over the full pnpm graph and the mcp-sandbox lockfile;
   - license fields and LICENSE files;
   - a CODEOWNERS lint.

   CODEOWNERS (owner @VictorMinemu) requests reviews only. "Require code owner review" is not enabled while there is a
   single maintainer, because it would block self-merge (D-15).
10. **The local gate is the merge evidence, and CI runs the same commands (D-01, D-12).** Every check has a local
    entry point, and the CI runs exactly those:

    ```bash
    pnpm install --frozen-lockfile
    pnpm verify
    node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'
    node scripts/guard/run.mjs --rule-tests
    pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test
    pnpm gate:compose --with-observability --with-vault      # every PR touching the stack, or merges to main
    pnpm gate:cleanroom                                      # release or nightly
    ```

    **CI system.** The owner chose self-hosted **Woodpecker CI** on their own server (https://ci.autofy.ing), posting
    statuses to GitHub pull requests. It is open source and needs no paid service. Its pipelines (`.woodpecker/**`)
    are a separate task. `.github/workflows/**` stays in the repository unchanged, ready for when GitHub Actions
    billing returns. Until a CI run is green, the local gate recorded in the phase SUMMARY is the merge evidence.
11. **Dependency licenses: one exception, one clarification. Both are pending owner/legal confirmation.**
    - **`@anthropic-ai/claude-agent-sdk` (exception).** This package (and its platform packages) is under Anthropic's
      commercial terms, not an open-source license. It is a production dependency of the AGPL Local Runtime, used
      only by the Work Zone Claude Code adapter (ADR-0005, RUNTIME-03).
      - The license check admits it through **one** documented exception in `scripts/guard/license-policy.json`,
        which names this ADR and is printed on every run.
      - It is **pending owner/legal confirmation** before any public distribution of the desktop app or the Local
        Runtime.
      - **Fallback if refused:** the Claude Code adapter ships as a separate, optional download outside the AGPL
        bundle. The user installs it next to the Local Runtime, and the core distribution carries no
        commercially-licensed code. The Codex adapter and everything server-side are unaffected.
    - **`@modelcontextprotocol/server-everything@2026.8.31` (clarification).** Its package field is only
      `SEE LICENSE IN LICENSE`, and the tarball ships no LICENSE. The upstream repository's LICENSE states Apache-2.0
      for new code and MIT for older contributions.
      - The policy pins a clarification to that exact `name@version`, so a version bump re-opens the review.
      - It is used only in the `mcp-sandbox` sidecar.
      - It is **pending owner/legal confirmation** together with the exception above.

## Consequences

- One guide covers the operator workflow end to end ([`docs/INSTALL.md`](../INSTALL.md) and `docs/self-hosting/*.md`).
  The install is three commands: `git clone`, `pnpm ocw setup`, `docker compose up -d --build --wait`.
  `pnpm gate:cleanroom` proves that sequence from a fresh clone on every release. The owner's run on a real clean
  machine is the remaining check, recorded as `human_needed` until it is done.
- `pnpm verify` is slower (Semgrep, the license scan and the upgrade test) and now needs `uv` or Docker for Semgrep.
- **Residual risk: `OCW_TRUST_PROXY=1` trusts any immediate peer.** Behind Caddy, a client cannot forge its address:
  Caddy drops incoming `X-Forwarded-*` headers. But anything that reaches the API directly can still send its own
  `X-Forwarded-For` and have it recorded as the client IP:
  - a process on the host, through the loopback-published port;
  - a container on the compose network.

  This was measured: a forged address appeared in the audit event. Operators whose threat model includes those can set
  `OCW_TRUST_PROXY` to the proxy's fixed address or CIDR. Making that the default needs a fixed-subnet network,
  deferred.
- **A backup taken with the vault enabled contains the seal key.** It also holds OpenBao's data and init material, so
  it can unseal OpenBao and reveal the four API secrets by itself. Such a backup is as sensitive as `.env` and must be
  stored with the same care: 0600 files in a 0700 directory, never in the repository, encrypted off-site.
  `docs/self-hosting/backup-restore.md` states this.
- Docker Desktop (macOS) shows every client behind Caddy as the gateway IP. Gate stacks therefore raise the sign-in
  limit to 600/min, while the product default stays 30. On Linux, real client addresses are kept.
- Garage has no healthcheck, so `--wait` does not cover its S3 listener. The API retries instead.
- If the license exception is refused, the desktop and Local Runtime packaging changes (decision 11, fallback). The
  server stack does not.
