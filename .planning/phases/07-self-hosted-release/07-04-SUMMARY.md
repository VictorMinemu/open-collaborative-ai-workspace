---
phase: 07-self-hosted-release
plan: 04
subsystem: operator-cli
status: complete
tags: [cli, self-hosting, secrets, compose]
requires: []
provides:
  - "scripts/ocw.mjs: `pnpm ocw <cmd> [<sub>]` dispatcher by file name"
  - "scripts/ocw/env-file.mjs: parseArgs, resolveEnvFile, readEnv, parseEnvText, updateEnvText, setKeys, writePrivate, addProfile, gen, reportWritten, composeArgs, runCompose, DEMO, assertNotDemoProject, assertNotDemoEnvFile, defaultProjectName, usageError"
  - "scripts/ocw/setup.mjs: ocw setup (fresh / --force / --add-missing / --dir / --env-file / --ports / --project / --image-tag / --help), exports main, runMain, portBlock"
affects: [07-03, 07-06, 07-07, 07-08, 07-09, 07-10, 07-11]
tech-stack:
  added: []
  patterns:
    - "Commands are files: scripts/ocw/<cmd>-<sub>.mjs or <cmd>.mjs; first `//` line = help text"
    - "Every env write goes through setKeys/writePrivate (0600); every report of secrets through reportWritten (names only)"
    - "composeArgs always passes an explicit -p computed from the env file (or Compose's directory default)"
key-files:
  created:
    - scripts/ocw.mjs
    - scripts/ocw.test.mjs
    - scripts/ocw/env-file.mjs
    - scripts/ocw/env-file.test.mjs
    - scripts/ocw/setup.mjs
    - scripts/ocw/setup.test.mjs
  modified:
    - scripts/setup-env.mjs
    - scripts/setup-env.test.mjs
    - .env.example
    - .gitignore
decisions:
  - "composeArgs refuses the demo project t3code-81d72154 from the env file or from the directory-derived default, and the demo env files by path (.env.demo, ~/.ocw-demo/**, ~/.ocw/**), without reading them"
  - "runCompose refuses build/--build when the effective OCW_IMAGE_TAG is local (it would retag the demo's images); demo ports are not refused because they are the product defaults"
  - "Node 24 checks that a path after --env-file exists, even after the script name (exit 9, file not loaded): the dispatcher runs `node -- <file>`; the pnpm `ocw` alias should be `node -- scripts/ocw.mjs`"
  - "--ports NN accepts blocks 10..654; settings land on their commented template line (uncommented in place), else under '# Written by pnpm ocw setup'"
  - "--add-missing cannot be combined with --force/--ports/--project/--image-tag (exit 2)"
metrics:
  duration: "~95 min (two verify runs of ~13 min each, one interrupted by a session end and re-run)"
  completed: 2026-10-07
actuals:
  tokens: 15200
  tasks: 2
  commits: 4
---

# Phase 7 Plan 04: `pnpm ocw` CLI and `ocw setup` Summary

The dependency-free `pnpm ocw` dispatcher, plus `ocw setup`, which writes every secret into a 0600 `.env` at setup time and prints key names, never values. It supports `--ports NN` blocks with derived URLs, `--project` and `--image-tag`. It also adds the shared env/compose helpers that wave-2 commands import. Those helpers refuse to operate on the demo. `pnpm setup:env` is now an alias.

## Commits

| Task | Type | Commit | Message |
|------|------|--------|---------|
| 1 RED | test | 9d740ec | failing tests for the ocw dispatcher, env helpers and ocw setup |
| 1 GREEN | feat | bf4f14a | pnpm ocw dispatcher, shared env helpers and ocw setup |
| 2 RED | test | 3c67242 | setup:env prints key names, never a value from the written file |
| 2 GREEN | feat | ac7c862 | setup:env becomes an alias of ocw setup; template documents release keys |

## Results

- `node --test 'scripts/**/*.test.mjs'`: **37 tests, 37 pass, 0 fail, 0 skipped**. By file:
  - `scripts/ocw.test.mjs`: 6
  - `scripts/ocw/env-file.test.mjs`: 18
  - `scripts/ocw/setup.test.mjs`: 8. The `docker compose config` case ran against real Compose v5.3.1 and was not skipped.
  - `scripts/setup-env.test.mjs`: 5. These are the 4 existing tests, unchanged, plus the new no-value case.
- `pnpm verify` was green on the Task 1 tree and again on the final tree. Each run: lint exit 0, with the 4 warnings that were already there in `apps/local-runtime`; typecheck OK; vitest **193 files, 2716 tests passed**.
- Acceptance greps: `export function setKeys` is present; `reportWritten` is used in setup.mjs; `Setup token (paste it on /setup)` is gone from both files; `.env.example` has OCW_IMAGE_TAG, OCW_TRUST_PROXY, OCW_OPENBAO_ADDR and COMPOSE_PROFILES; `.gitignore` has `/secrets/` and `/backups/`.
- RED gates seen fail before GREEN: task 1 failed because the modules were missing; task 2 failed with "OCW_SETUP_TOKEN's value appears in the output".

## TDD Gate Compliance

Both tasks have a `test(...)` commit followed by a `feat(...)` commit. No refactor commit was needed.

## Deviations from Plan

**1. [Rule 2 - Security, plan checker addition] Demo refusal in `composeArgs` / `runCompose`.**
- `composeArgs` refuses project `t3code-81d72154` whether it comes from `COMPOSE_PROJECT_NAME` or from Compose's directory-derived default. That default matters because a run in the main worktree without a project name would target the demo.
- It also refuses `.env.demo`, `~/.ocw-demo/**` and `~/.ocw/**` by path, without reading them.
- `runCompose` refuses `build`/`--build` under the `:local` tag.
- `ocw setup --project t3code-81d72154` exits 2.
- Demo ports are **not** refused. They are the product defaults (3000/4000/3900/54329/63799), so refusing them would break `ocw backup`/`enable` on every default install. A second project publishing them cannot affect the demo, because Docker refuses the bind.
- Unit tests are in `env-file.test.mjs`.
- Commits: 9d740ec, bf4f14a.

**2. [Rule 3 - Blocking] Node 24 intercepts `--env-file` after the script name.**
- What happens: `node script.mjs --env-file X` exits 9 with "X: not found" when X does not exist. When X exists, it is not loaded and the script runs normally.
- Effect: only `ocw setup --env-file <new file>` breaks. backup, restore and enable work on files that already exist.
- Fix: the dispatcher spawns `node -- <cmd file>`; the test and the setup help use `node -- scripts/ocw.mjs` for a new `--env-file`. `--dir` always works.
- Commit: bf4f14a.

**3. [Rule 3] `COMPOSE_FILE` from `--env-file` resolves against the cwd in Compose 5.3.1 (verified), not against the project directory.** `composeArgs` passes `-f` entries resolved against the project directory. `COMPOSE_PROJECT_NAME` and `COMPOSE_PROFILES` from `--env-file` are honoured (verified). The project is still passed explicitly with `-p`. `runCompose` runs with `cwd: REPO_ROOT`. Commit: bf4f14a.

**4. Process: RED test commits were checked with `pnpm lint` plus the node tests, not a full `pnpm verify`.** Full `pnpm verify` (~13 min) ran on the baseline and before each `feat` commit. The RED commits only add `node:test` files, which vitest and typecheck do not include.

**5. `--add-missing` now leaves the file at mode 0600.** It goes through `setKeys` and uses the header `# Added by pnpm ocw setup --add-missing`. The behaviour is otherwise unchanged and still byte-preserving (existing tests pass).

## Open Items

- **For 07-01 / merge:** the root `package.json` `ocw` script should be `node -- scripts/ocw.mjs`, not `node scripts/ocw.mjs`. Without it, `pnpm ocw setup --env-file <new file>` dies in Node (deviation 2). 07-01's acceptance grep `"ocw": "node scripts/ocw.mjs"` would need the same change.
- **For 07-07..07-10 executors:** call `node -- scripts/ocw.mjs …` (or `spawnSync(process.execPath, ["--", OCW, …])`) whenever the `--env-file` target might not exist yet.
- **For 07-03 `assertSafe`:** these helpers' demo rules only partly cover the gate rules. Gates still need their own stricter `assertSafe`, covering 34xx ports, a non-`local` tag and an env file under tmp.
- Docs that still say `pnpm setup:env` (`docs/DEMO.md`, `infra/garage/README.md`, `compose.yaml` comments) remain correct through the alias. 07-11's install guide switches them to `pnpm ocw setup`.

## Known Stubs

None.

## Broken-windows entries (for the gate to transfer to WINDOWS.md)

- `deviation`, `package.json` (07-01 owned): the `ocw` alias must be `node -- scripts/ocw.mjs` so `--env-file <new path>` reaches the CLI (Node 24 argv interception).

## Threat Flags

None beyond the plan's threat model. T-07-04-01..05 are mitigated as planned. T-07-04-02 also now covers the in-place updates made by `--add-missing`.

## Self-Check: PASSED

- All 6 created files and 4 modified files exist on `wt/07-04`.
- Commits 9d740ec, bf4f14a, 3c67242 and ac7c862 are present in `git log`.
