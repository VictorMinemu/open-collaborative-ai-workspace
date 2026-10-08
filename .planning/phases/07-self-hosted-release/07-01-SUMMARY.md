---
phase: 07-self-hosted-release
plan: 01
subsystem: guardrails
status: complete
tags: [semgrep, licenses, codeowners, verify, policy]
requires: []
provides:
  - "pnpm guard (Semgrep rules, dependency licenses, package license fields, CODEOWNERS lint) inside pnpm verify"
  - "root scripts guard, verify, ocw (node -- scripts/ocw.mjs), gate:compose"
affects: [07-03, 07-04, 07-05, 07-10, 07-11]
tech-stack:
  added: ["Semgrep 1.178.0 (uvx pin; Docker image pinned by digest as fallback; not an npm dependency)"]
  patterns:
    - "Semgrep path allowlists anchored at the repo root (/path), exact files only"
    - "Guard fails closed: no Semgrep runner means exit 1 with an install hint"
key-files:
  created:
    - .semgrep/rules.yml
    - .semgrep/tests/rules.ts
    - .semgrep/tests/rules.sql
    - .semgrepignore
    - scripts/guard/run.mjs
    - scripts/guard/licenses.mjs
    - scripts/guard/codeowners.mjs
    - scripts/guard/license-policy.json
    - scripts/guard/guard.test.mjs
    - .github/CODEOWNERS
    - apps/openclaw-channel/LICENSE
    - packages/realtime-client/LICENSE
  modified:
    - package.json
    - vitest.config.ts
    - biome.json
decisions:
  - "@modelcontextprotocol/server-everything@2026.8.31 (mcp-sandbox) declares 'SEE LICENSE IN LICENSE' and ships no LICENSE file; the upstream repository LICENSE text says Apache-2.0 (new code) and MIT (contributions not yet relicensed). Recorded as a version-pinned clarification ('Apache-2.0 AND MIT'), not as a second exception, so claude-agent-sdk stays the only exception"
  - "ocw.ai-telemetry-records-prompts also covers the stable AI SDK 7 `telemetry` key (ai@7.0.122 has both `telemetry` and the deprecated `experimental_telemetry`) inside generateText/streamText/generateObject/streamObject/embed/agent calls"
  - "ocw.focused-test covers every TypeScript file under apps/, packages/ and e2e/ (apps/web tests live outside src/)"
  - "Semgrep fixture annotations in rules.sql use '#' because Semgrep's test runner does not read '--' comments"
metrics:
  duration: "about 75 min (including 3 full pnpm verify runs of about 12-13 min each on a shared, loaded machine)"
  completed: 2026-10-07
actuals:
  tokens: 12000
  tasks: 3
  commits: 4
---

# Phase 7 Plan 01: Guardrails in `pnpm verify` Summary

`pnpm verify` is now `lint && guard && typecheck && test`. `pnpm guard` runs five Semgrep rules (pinned 1.178.0, fails
closed), checks every dependency license in the full pnpm graph and the mcp-sandbox lockfile against a policy with one
explicit claude-agent-sdk exception, checks workspace license fields and LICENSE files, and lints CODEOWNERS against
`git ls-files`.

## What was built

- **Semgrep rules** (`.semgrep/rules.yml`, 5 rules): `ocw.permission-bypass-token` (ADR-0012 path + 5 denial tests
  allowlisted), `ocw.rls-bypass` (only `bootstrap.sql` and `rls-isolation.int.test.ts`; SQL `--` comment lines are
  skipped, so `post-migrate.sql:55` passes untouched), `ocw.skipped-policy-test` (the Q7 policy-test globs),
  `ocw.focused-test`, `ocw.ai-telemetry-records-prompts`. Fixtures in `.semgrep/tests/` (`rules.ts`: 4 rules, `rules.sql`:
  1 rule) run via `--rule-tests`. They are excluded from the scan and from Biome.
- **`scripts/guard/run.mjs`**: semgrep → licenses → fields → codeowners. Every failure is reported before it exits 1.
  Options: `--only`, `--root`, `--rule-tests`. Runner: `uvx --from semgrep==1.178.0`, then the pinned Docker image,
  then exit 1 with an install hint. Flags: `--error --metrics=off --disable-version-check`.
- **Licenses**: `licenses.mjs` (SPDX parser: OR = any, AND = all, WITH = base license, anything unparseable or Unknown =
  deny). `license-policy.json` holds the allow/deny lists from 07-RESEARCH Q7, plus exactly one exception
  (`@anthropic-ai/claude-agent-sdk` and `-*` platform binaries, status "pending owner/legal confirmation", ADR-0021).
  Each run prints:
  `exception: @anthropic-ai/claude-agent-sdk (pending owner/legal confirmation, ADR-0021) covers ...`.
- **Fields**: every workspace package (root, apps/*, packages/*, infra/*) must be AGPL-3.0-only or Apache-2.0. The
  Apache set is contracts, realtime-client, openclaw-channel and protocol (once it exists), and an Apache package must
  ship a LICENSE file. LICENSE was copied to `apps/openclaw-channel` and `packages/realtime-client`. `pnpm pack
  --dry-run` shows npm already includes LICENSE in openclaw-channel despite its `files` field, so `files` was left
  unchanged.
- **CODEOWNERS**: 23 `@VictorMinemu` rules (the Q7 list; every path exists). The lint checks four things: every pattern
  matches a tracked file, every rule has an owner, owners are well formed, and each of 10 required areas (db policies,
  tenant, auth, authz, resolver, permission contracts, both adapters, guardrails) is owned by its winning rule. No
  enforcement setting was added (D-15).
- **`vitest.config.ts`**: root `allowOnly: false`. A probe showed it applies to the `unit` and `web` inline projects
  (`Unexpected .only modifier`). The probe files were deleted.
- **Root scripts**: `guard`, `verify`, `ocw` = `node -- scripts/ocw.mjs` (see deviation 5), `gate:compose`.

## Results

| Check | Result |
| --- | --- |
| `node --test scripts/guard/guard.test.mjs` | 21/21 pass |
| `node --test 'scripts/**/*.test.mjs'` | 25/25 pass |
| `node scripts/guard/run.mjs --rule-tests` | rules.ts 4/4, rules.sql 1/1 pass |
| `pnpm guard` | exit 0: semgrep, licenses (954 package versions), fields and codeowners all ok; prints the exception line |
| `pnpm verify` (Task 3 state, and again after the `ocw` fix) | exit 0 both times: lint ok (4 pre-existing warnings), guard ok, typecheck 8/8, **193/193 files, 2716/2716 tests, 0 skipped** (12m13s, then 9m03s) |
| `pnpm guard` warm wall time | 10.3–12.1 s on a machine at load average 12–14 (five parallel worktrees running verify); Semgrep accounts for about 8.7 s, licenses 0.4 s |

The guard is slower than the research estimate of about 2 s (which used a single rule on an idle machine). Under load,
parsing about 1,600 TypeScript files for the TS rules dominates. Limiting the telemetry rule to `apps/api` saved only
about 2 s, so the rule keeps covering all of `apps/` and `packages/`. Re-measure on an idle machine or in CI.

## Deviations from Plan

1. **[Rule 3 - Blocking] `biome.json` excludes `.semgrep/tests`.** Biome linted the fixtures (unused variables, `.only`).
   The fixtures are intentional bad code. Commit deb7e59.
2. **[Rule 3 - Blocking] Clarification for `@modelcontextprotocol/server-everything`.** Its lockfile license is
   "SEE LICENSE IN LICENSE", which is denied. The upstream LICENSE text was checked (Apache-2.0 / MIT), and a
   `clarifications` entry pinned to `name@version` was added, so a version bump re-opens the review. It is not counted
   as an exception. Commit f6b96e8.
3. **[Rule 2 - Missing critical] The telemetry rule also covers the AI SDK 7 `telemetry` key.** Without this, the
   non-deprecated key would bypass the rule. Commit 77fa166.
4. **[Rule 3] Test temp trees are `git init`ed.** Outside a git repository, Semgrep matches no anchored `paths` pattern.
   The repository is always git, so the test mirrors it. The guard also spawns `pnpm licenses` through a shell, because
   the nvm pnpm stub has no shebang and a direct spawn fails with ENOEXEC. Commits deb7e59 and f6b96e8.
5. **[Coordinator note from 07-04] `ocw` script = `node -- scripts/ocw.mjs`.** Without `--`, Node 24 intercepts
   `--env-file` passed after the script name and exits 9. Verified here: exit 9 without `--`, args passed through with
   it. The plan's acceptance grep `"ocw": "node scripts/ocw.mjs"` now matches `"ocw": "node -- scripts/ocw.mjs"`.
   Commit 791b081.
6. **Plan-checker note:** the Task 2 `git status` check omitted `packages/db/sql` (07-02 owns it). `packages/db/sql` was
   still never edited.
7. **Transient infra flakes during verify (not code).** Before the Task 1 commit, one integration suite failed with
   `ECONNREFUSED /var/run/docker.sock`. Before the Task 2 commit, a different suite hit a testcontainers port-bind
   timeout. Each one passed when re-run alone (shares.int 14/14, security.int 16/16). The Task 3 verify was fully green.

## Known Stubs

None. The `ocw` and `gate:compose` scripts point to files that 07-04 and 07-03 create in this wave.

## Broken-windows entries (for the orchestrator; WINDOWS.md not edited)

- `deviation`: the claude-agent-sdk license exception is pending owner/legal confirmation (D-14). ADR-0021 (07-11) must
  record it.
- `deviation`: the `server-everything` license is a clarification based on the upstream LICENSE text. The owner should
  confirm it together with D-14.
- `lint-warning` (pre-existing, not touched): 4 Biome warnings in `apps/local-runtime` (detect.ts ×2, jsonrpc.ts,
  sanitize.ts).

## Threat Flags

None. No new network endpoints or auth paths. The guard runs local tools only. The single network use is uvx fetching
the pinned Semgrep once, or the digest-pinned Docker image.

## Commands for CI (D-12)

`pnpm install --frozen-lockfile && pnpm verify` (it includes `pnpm guard`), plus `node --test 'scripts/**/*.test.mjs'`
and `node scripts/guard/run.mjs --rule-tests`. The CI image needs `uv` (or Docker) for Semgrep.

## Self-Check: PASSED

Every key file exists. Commits deb7e59, 77fa166, f6b96e8 and 791b081 are on `wt/07-01`. Nothing changed under
`.github/workflows`, `.woodpecker`, `infra/ci-runner` or `packages/db/sql`.
