# Phase 7: Self-hosted Release - Context

**Gathered:** 2026-10-08 (owner: "ok ponte en ello"; no discuss-phase run, orchestrator decisions under delegated autonomy)
**Status:** Ready for research

<domain>
## Phase Boundary

Close MVP 1: any engineering team installs, upgrades, backs up, observes and exposes an OCW instance with one command
each, and the MVP 1 acceptance scenario (Scenario B minus Work Zone creation) runs against that exact compose stack.
Requirements SELF-01..07, FOUND-05..07 (ROADMAP Phase 7 success criteria 1–6). Device trust, Work Zone permissions
and MVP 2 work are Phase 8+.

</domain>

<decisions>
## Implementation Decisions

- **D-01: CI is unavailable (GitHub Actions blocked by account billing).** Every check this phase adds to CI
  (upgrade test, license check, Semgrep, Scenario B on compose) must also have a **local entry point** (a `pnpm`
  script or `scripts/*.sh`) that runs the same thing, and the local gate is the merge evidence until CI returns.
  Update `.github/workflows/ci.yml` too, so CI runs them when billing is back. Do not build a self-hosted runner
  (owner decision pending: fix billing vs self-hosted runner).
- **D-02: Object storage is Garage (ADR-0015), not MinIO.** FOUND-06's "minio" wording is outdated; the minimal
  profile is postgres, redis, garage (+ its key setup), migrate, api, web, and the OpenClaw cell where the current
  `compose.yaml` already defines it. Update REQUIREMENTS wording accordingly.
- **D-03: `pnpm ocw` CLI.** One small Node CLI in the repo (no new heavy dependency) with `setup` (wraps/replaces
  `pnpm setup:env`: generates required secrets into `.env` or `*_FILE` files **at setup time, never at boot**, prints
  what it wrote, never prints secret values), `backup`, `restore` (as the migrator role; DB + object storage +
  anything else stateful; documented), and whatever else the success criteria need. Existing `setup:env` behaviour and
  tests must keep working (alias or migrate the tests).
- **D-04: Secrets.** The API already fails fast naming a missing secret (`NAME` or `NAME_FILE`) — keep it. The
  `SecretStore` interface has `env`/`file` and an OpenBao client implementing the same interface, tested (OpenBao in an
  optional compose profile; integration test against a real OpenBao dev container is acceptable).
- **D-05: Observability.** `@fastify/otel` (+ OpenTelemetry SDK) in the API emitting traces, metrics and logs; an
  optional compose profile with Prometheus, Grafana, Loki, Tempo (all self-hosted, pinned versions, no paid service).
  Off by default; enabling it later needs no reinstall. Never export prompt contents, secrets, tokens or absolute host
  paths in spans/logs.
- **D-06: Migrations.** One-shot `migrate` service; the API refuses to start on schema mismatch with a clear message;
  an `N-1 → N` upgrade test (previous release's schema + data → current migrations → API boots, data intact).
  Define "N-1" concretely (e.g. the previous tagged release or the migration set at `main~` / the last phase merge).
- **D-07: Caddy.** A documented Caddy reverse-proxy config (optional compose profile or example file) with a test
  proving WebSocket upgrade, trusted proxy headers and presigned Garage URLs reachable from outside the compose network.
- **D-08: Licenses and policy gates.** Every package.json declares its license (AGPL-3.0-only apps/server; Apache-2.0
  `packages/contracts` and `packages/protocol` if it exists). Dependency-license compatibility check with a free tool.
  Semgrep (open-source CLI, local rules in the repo) fails on permission-bypass tokens; a check fails on skipped policy
  tests; both wired into `pnpm verify` (keep `pnpm verify` fast enough — if Semgrep is slow, a separate `pnpm` script
  called by verify is fine). CODEOWNERS covering db policies, auth, adapters and policy paths (owner: @VictorMinemu).
- **D-09: Scenario B on compose.** Playwright E2E of Scenario B minus Work Zone creation against the compose stack
  (real images, not the dev servers), with the fake model / fakes, no real provider. Local entry point per D-01.
- **D-10: Clean-machine verification** is simulated locally with a fresh clone in a temp directory, a **separate
  compose project name and non-default ports**; the owner repeats it on a real clean machine (human_needed).
- **D-11: Never disturb the running demo** (compose project `t3code-81d72154`, ports 3000/4000, `ocw-demo-*`,
  `~/.ocw-demo`, the `ocw` DB). All phase tests use their own compose projects, ports and volumes, and clean them up.

### Orchestrator decisions after research (2026-10-08)
- **D-12: CI system.** Owner chose a self-hosted open-source CI (Woodpecker CI on their Hetzner server via Portainer,
  posting statuses to GitHub PRs). Its pipeline config is a separate task outside this phase's plans. Phase 7 plans
  do **not** touch `.github/workflows/**`, `.woodpecker/**` or `infra/ci-runner/**`; they deliver every check as a
  local entry point (`pnpm` script / `scripts/`) and list the exact commands in the gate SUMMARY so the CI task can
  wire them. "In CI" success criteria are met by those commands plus the local gate until the CI is live.
- **D-13: No secret is ever printed.** `ocw setup` (and `setup:env`) report which secrets were written and where,
  never their values (fix the current token print; update its tests).
- **D-14: `@anthropic-ai/claude-agent-sdk` license.** The license checker allows it only through an explicit,
  documented exception (one entry, with the reason: Work Zone Claude Code adapter in the Local Runtime), flagged in
  ADR-0021 as **pending owner/legal confirmation** for distribution. Do not remove or replace the dependency.
- **D-15: CODEOWNERS** file only (owner @VictorMinemu); do not enable "require code owner review" (single owner would
  block self-merge).
- **D-16: OpenBao** holds the API-only secrets (research proposal: the 4 used only by the API); the rest stay env/file.
- **D-17: Release.** Tag `v0.1.0` when the phase closes (orchestrator, after merge).
- **D-18: Research proposals accepted:** `OCW_IMAGE_TAG` + 34xx ports for gate stacks (never overwrite `:local` images
  the demo uses); `OCW_TRUST_PROXY` (default false, `1` behind Caddy); N-1 = Phase 5 merge `3bbcbd9` with a committed
  golden dump; schema check by migration names/hashes vs `drizzle.__drizzle_migrations`; new Scenario B spec on the
  org mock model (no `/api/v1/test/*` routes in production images); full-database dump/restore as `ocw_migrator`;
  OTel redaction (no query strings, no executable paths/args, AI SDK telemetry never records prompts).

### Claude's Discretion
- CLI implementation details, profile names, exact tool choices for license checking, how "N-1" is pinned, plan split.

</decisions>

<canonical_refs>
## Canonical References

- `.planning/ROADMAP.md` Phase 7; `.planning/REQUIREMENTS.md` SELF-01..07, FOUND-05..07
- `docs/prd/PRD.md` (§5.1 compose, licensing section), `docs/adr/0003-*` (stack; OpenBao/observability profiles),
  `0015-*` (Garage), `0012-*`, `0002-*`
- `.planning/research/STACK.md` (pinned versions), `.planning/research/PITFALLS.md` (pitfall 13)
- `compose.yaml`, `scripts/setup-env*`, `scripts/demo-*.sh`, `scripts/e2e-isolated.sh`, `apps/api/src/config*`,
  `apps/api/Dockerfile`, `apps/web/Dockerfile`, `infra/`, `.github/workflows/ci.yml`, `docs/DEMO.md`
- Acceptance Scenario B: in `docs/prd/PRD.md` / `.planning/` (find it)

</canonical_refs>

---

*Phase: 07-self-hosted-release*
*Context gathered: 2026-10-08*
