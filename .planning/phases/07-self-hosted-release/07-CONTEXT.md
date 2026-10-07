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
