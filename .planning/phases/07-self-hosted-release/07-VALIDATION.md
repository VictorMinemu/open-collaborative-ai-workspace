---
phase: "07"
slug: "self-hosted-release"
# status lifecycle: draft → validated. Phase 7 had no seeded validation file; 07-11 (the phase gate) creates and signs it.
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-08"
validated: "2026-10-08"
manual_pending: human_needed   # 07-11 Task 3: the owner's clean-machine install on real hardware (deferred)
---

# Phase 7 — Validation

> Validation record for the self-hosted release. Sources: `07-RESEARCH.md` §Validation Architecture, `07-CONTEXT.md`
> (D-01 … D-18), the 07-01 … 07-11 SUMMARYs. CI was unavailable during the phase (D-01). The local gate below is the
> merge evidence, and the CI (Woodpecker, D-12, a separate task) runs the same commands.

## Test infrastructure

| Property | Value |
|----------|-------|
| **Frameworks** | Vitest 5 (`unit`, `integration` on testcontainers PostgreSQL/Redis/Garage/OpenBao, `web`); `node --test` for `scripts/**` and `infra/**`; Semgrep rule tests; Playwright through Caddy on production images (`e2e/playwright.compose.config.ts`: setup → desktop 1440, mobile 390) |
| **Per-commit** | `pnpm verify` = lint + guard (Semgrep, licenses, fields, CODEOWNERS) + typecheck + test |
| **Phase gate** | `pnpm gate:compose --with-observability --with-vault`, then `pnpm gate:cleanroom` |
| **Isolation** | Gate stacks: `ocw-gate-*` / `ocw-cleanroom-*` projects, 34xx loopback ports, per-run image tags, one machine-wide lock, demo fingerprint before and after (D-11) |
| **No real providers** | The org mock model and `infra/fake-model` only |

## Per-plan verification map

| Plan | Requirements | Automated evidence | Status |
|------|--------------|--------------------|--------|
| 07-01 Guardrails | FOUND-07, SELF-06 | `scripts/guard/guard.test.mjs`; `node scripts/guard/run.mjs --rule-tests`; guard in `pnpm verify` | ✅ green |
| 07-02 Schema guard, N-1 → N | SELF-03 | `schema-check.test.ts`, `schema-guard.int.test.ts`, `upgrade.int.test.ts` (in `pnpm verify`) | ✅ green |
| 07-03 Compose gate harness | FOUND-06, D-11 | `scripts/gate/lib.test.mjs`, `infra/compose.test.mjs`; gate stage `compose` | ✅ green |
| 07-04 `pnpm ocw` + `setup` | SELF-01, SELF-02, D-13 | `scripts/ocw.test.mjs`, `setup.test.mjs`, `env-file.test.mjs`, `setup-env.test.mjs` | ✅ green |
| 07-05 OpenTelemetry, trust proxy | FOUND-05, SELF-05 | `telemetry.int.test.ts`, `redact.test.ts`, `trust-proxy.int.test.ts`, `config/env.test.ts` | ✅ green |
| 07-06 OpenBao, `vault` profile | SELF-02 | `secret-store.test.ts`, `openbao.int.test.ts`, `compose-vault.test.mjs`, `enable-vault.test.mjs`; gate stage `vault` | ✅ green |
| 07-07 Observability profile | FOUND-05, SELF-01 | `compose-observability.test.mjs`, `enable-observability.test.mjs`; gate stage `observability` | ✅ green |
| 07-08 Caddy `proxy` profile | SELF-05 | `compose-proxy.test.mjs`, `enable-proxy.test.mjs`, `session-ip.int.test.ts`; gate stage `proxy` | ✅ green |
| 07-09 Backup / restore | SELF-04 | `backup.test.mjs`, `object-store.int.test.ts`; gate stage `backup` | ✅ green |
| 07-10 Scenario B, one-command gate | SELF-07, SELF-03, SELF-04 | `e2e/compose/scenario-b.spec.ts`, `compose-gate.test.mjs`; gate stages `playwright`, `schema-refusal`, `vault-backup` | ✅ green |
| 07-11 Clean room, docs, ADR | SELF-01, D-02, D-10, D-14 | `scripts/gate/cleanroom.test.mjs`; `pnpm gate:cleanroom`; doc/ADR/traceability greps | ✅ green |
| 07-11 Task 3 (owner) | SELF-01 | The owner installs on a real clean machine (`docs/INSTALL.md` "Clean-machine check") | ⏸ `human_needed` (deferred) |

## Phase gate run (2026-10-08, HEAD `3e48c44`, one command at a time)

The exact results are in `07-11-SUMMARY.md` ("Gate record").

## Validation sign-off

- [x] Every plan has automated verification, and every check has a local entry point (D-01, D-12)
- [x] The full local gate is green on one HEAD, with no skipped, failed or flaky Playwright test
- [x] Gate stacks left nothing behind, and the demo fingerprint was unchanged on every run
- [x] No permission check, RLS policy or approval gate was weakened
- [x] `nyquist_compliant: true` is set in the frontmatter

**Approval:** validated on 2026-10-08 by the 07-11 executor, on the gate run recorded in `07-11-SUMMARY.md`.

Still open (`human_needed`):

- the owner's clean-machine install on real hardware (07-11 Task 3; deferred under delegated autonomy);
- owner/legal confirmation of the `@anthropic-ai/claude-agent-sdk` exception and the `server-everything`
  clarification (ADR-0021);
- the first green Woodpecker run of the CI command list.
