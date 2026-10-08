---
phase: 07-self-hosted-release
plan: 09
subsystem: operator-cli
tags: [backup, restore, postgres, garage, openclaw, self-hosting, gate]
status: complete

requires:
  - phase: 07-02
    provides: schema guard messages, N-1 baseline, ocw_app read grant on drizzle
  - phase: 07-03
    provides: scripts/gate/lib.mjs (withGateStack, ctx.compose, ctx.psql, ensureAdmin, demo snapshot)
  - phase: 07-04
    provides: scripts/ocw/env-file.mjs (parseArgs, resolveEnvFile, readEnv, composeArgs demo refusal)
provides:
  - "pnpm ocw backup [--out DIR] [--env-file F | --dir D] [--consistent]"
  - "pnpm ocw restore DIR --yes [--env-file F | --dir D]"
  - "apps/api/src/cli/object-store.ts export|import <dir> [--delete-extra] (runs in the api image)"
  - "scripts/gate/backup-roundtrip.mjs (--up | --attach): round trip, fresh volumes, --consistent, --force-recreate"
  - "docs/self-hosting/backup-restore.md (contents, restore, upgrade, rollback, N-1, Garage key rotation)"
affects: [07-10 (full gate re-runs backup-roundtrip), 07-11 (install guide links the runbook)]

tech-stack:
  added: []
  patterns:
    - "Docker calls of ocw commands go through an injectable runner (composeArgs-based), so refusal rules are unit-tested without Docker"
    - "Binary streams (pg_dump, pg_restore, tar) go through file descriptors on stdin/stdout, never through bind mounts or argv"
    - "Backup object files are named sha256(key); the key text (untrusted on restore) never becomes a path"

key-files:
  created:
    - apps/api/src/cli/object-store.ts
    - apps/api/src/cli/object-store.int.test.ts
    - scripts/ocw/backup.mjs
    - scripts/ocw/restore.mjs
    - scripts/ocw/backup.test.mjs
    - scripts/gate/backup-roundtrip.mjs
    - docs/self-hosting/backup-restore.md
  modified:
    - apps/api/src/modules/artifact/storage.ts
    - apps/api/src/modules/artifact/index.ts

key-decisions:
  - "Restore makes the bucket equal the backup (import --delete-extra): objects uploaded after the backup would be orphans once their rows are gone"
  - "Cell state goes through `docker compose run --no-deps --user 0 --entrypoint tar|sh openclaw` with the archive on stdin/stdout: no volume-name guessing, no root-owned files on the host"
  - "pg_dump/psql/pg_restore get PGPASSWORD through `exec -e PGPASSWORD` with the value in docker's environment only"
  - "Restore follows the research-verified sequence (drop schemas, then pg_restore --single-transaction); a failed pg_restore leaves empty schemas and is re-runnable (documented), not half-restored"
  - "--consistent and the online cell pause only restart services that were running before"

requirements-completed: [SELF-04]

metrics:
  duration: "~2 h 10 min (incl. one 13-min pnpm verify, a kept dev stack and the final --up gate run)"
  completed: 2026-10-08

actuals:
  tokens: 20960   # chars/4 over the full diff from e27f267 (9 files, +1969/-6)
  tasks: 2
  commits: 5
---

# Phase 7 Plan 09: `ocw backup` / `ocw restore` and the upgrade runbook Summary

**`pnpm ocw backup` writes the whole database (pg_dump -Fc as `ocw_migrator`), every bucket object with its content type,
the OpenClaw cell's state and a sha256 manifest into one 0700 directory. `pnpm ocw restore DIR --yes` verifies it,
refuses newer or tampered backups, and puts exactly that state back, also onto brand-new volumes. On a real gate
stack, data, sign-in and downloads are identical across `up -d --force-recreate --wait`.**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `b01b9a8` | feat(api): object-store CLI exports and imports every bucket object for backups |
| 1 | `f6222b6` | test(gate): backup round trip, fresh volumes and force-recreate gate step |
| 2 | `d7eb9a9` | test(ocw): backup and restore refusal rules and restore order through a fake runner |
| 1+2 | `ca9f2bf` | feat(ocw): ocw backup and ocw restore as the migrator role |
| 2 | `f42cb60` | docs: backup, restore, upgrade and rollback runbook |

Branch `wt/07-09` (worktree `ocw-07-09`), base `e27f267`. Not pushed, not merged.

## Results (exact)

| Check | Result |
|-------|--------|
| `node --test scripts/ocw/backup.test.mjs` | 14 tests, 14 pass, 0 fail, 0 skipped |
| `node --test 'scripts/**/*.test.mjs'` (regression) | 83 tests, 83 pass, 0 fail, 0 skipped |
| `pnpm exec vitest run --project integration apps/api/src/cli/object-store.int.test.ts` | 1 file, 5/5 passed, 0 skipped |
| `pnpm typecheck --force` | 8/8 tasks successful, 0 cached |
| **`pnpm verify`** (tree with all code, before the commits) | **lint 0 errors (4 pre-existing warnings), guard semgrep/licenses/fields/codeowners ok, typecheck ok, vitest 200 files, 2778/2778 passed, exit 0** |
| `pnpm lint` + `pnpm guard` after the last gate-step and docs edits | exit 0 (same 4 warnings), semgrep ok |
| **`node scripts/gate/backup-roundtrip.mjs --up`** (final, clean tree `f42cb60`) | **exit 0, every step ok, 493 s total** |
| No leftovers | `docker ps -aq` / `docker volume ls -q` for the run's project: 0 / 0; its 4 images removed; 55 build-cache records pruned; backup temp dir removed |
| Acceptance greps | `ocw_migrator` in backup.mjs and restore.mjs; `single-transaction` in restore.mjs:159; `newer release` in restore.mjs; `force-recreate` in backup-roundtrip.mjs; `## Upgrading` heading in the runbook |

Final gate run (tag `gate-f42cb60303c3-muyw40n4802e`, project `ocw-gate-muyw40n4802e`, ports 34xx):

| Step | ms | Details |
|------|----|---------|
| build / up | 55927 / 28464 | api 213 MB, web 95 MB, openclaw 1203 MB, fake-model 77 MB |
| seed | 1515 | admin, member (`developer`), channel with 2 messages, PNG attachment on message 2, cell marker |
| backup | 6460 (CLI) | `db.dump` 252284 B, `openclaw-state.tar` 1730560 B, 3 objects, all files 0600 / dirs 0700, no secret value in the output |
| change | 1745 | message 1 deleted, message 3 with a new attachment posted, attachment 1's objects removed (download fails), marker removed |
| restore | 32442 | exit 0 |
| restored | 2745 | rows identical (messages, attachments, users, org_members, migrations, policy count, FORCE RLS count), message 3 gone, PNG bytes identical, admin and member sign in, bucket = backup, cell marker back, `ocw_app` without tenant sees 0 org rows |
| fresh-volumes | 66980 | `down -v` → `up -d --wait` (admin sign-in fails: empty) → restore 26798 ms |
| restored-on-fresh-volumes | 1620 | the same nine checks, all true |
| consistent-backup | 10237 (CLI) | exit 0; api, web, openclaw running again afterwards |
| force-recreate | 44566 (recreate) | counts `2,2,1,2,1,17` (users, org_members, conversations, messages, attachments, migrations) before = after; sign-in and download ok before and after |
| demo-untouched | | the `:local` image ids and the demo's containers and ports did not change |

Earlier, a dev stack was left up with `--keep` and the step ran against it twice with `--attach`. The second run
passed every check. The first run found the transient-port issue described in deviation 2. That stack was then removed
with `--down`: 4 images removed, 49 cache records pruned.

## What was built

- **`object-store.ts`**
  - Reads only `OCW_S3_*` through a narrow Zod schema. The secret goes through `createEnvFileSecretStore`, so `_FILE` also works.
  - Export: lists the bucket with pagination and streams each object to `objects/<sha256(key)>` while hashing it, then writes `objects.json`.
  - Import: validates the index schema (the file must equal `objects/<sha256(key)>`), checks every size and sha256 before the first PUT, waits for the bucket (Garage creates it at start), PUTs each object with its content type and, with `--delete-extra`, removes keys not in the backup.
  - It prints counts only. `storage.ts` now takes `ObjectStorageEnv` (a `Pick` of `Env`) and exports `s3Client`. API behaviour is unchanged.
- **`ocw backup`**
  - Refuses the demo through `composeArgs`, then requires postgres to be running.
  - Reads the applied migration names as `ocw_migrator`.
  - Streams `pg_dump -U ocw_migrator -d ocw -Fc` into `db.dump`.
  - Exports the objects through `run --rm --no-deps -v DIR:/backup api …`. On Linux it adds `--user uid:gid`.
  - Tars `/home/node/.openclaw` through the openclaw image. openclaw is stopped around the copy and started even if the copy fails.
  - Writes `manifest.json`: format 1, createdAt, apiVersion, gitSha, project, consistent, migrations, components, and the sha256 of each file. It then enforces 0600/0700.
- **`ocw restore`**
  - Without `--yes`: exit 2, nothing runs.
  - Before any Docker call: the demo refusal, the manifest format, known file names only, the sha256 of every file and of every object, and the migration names against `packages/db/drizzle/`. An unknown name means "made by a newer release", and the restore is refused.
  - Then: stop api/web/openclaw → `up -d --wait postgres redis garage` → `run --rm migrate` → `DROP SCHEMA IF EXISTS app, auth, drizzle CASCADE` as `ocw_migrator` → `pg_restore --exit-on-error --single-transaction` from stdin → `run --rm migrate` → object import `--delete-extra` → cell state replaced from stdin → `up -d --wait`.

## Deviations from Plan

1. **[Process] Task order and RED evidence.**
   - The object-store integration test moved from Task 2 to Task 1, because Task 1's tracer needs that code inside the api image before the stack is built. RED was observed (the import failed with the module missing). It is committed together with the implementation in `b01b9a8`, so `pnpm verify` is green at every commit.
   - `backup.test.mjs` was written before `restore.mjs` existed and failed (RED), then passed 14/14.
   - The gate step's RED (commands missing) was not run as a separate gate stack. Building a stack only to watch it fail costs about 5 minutes and about 2 GB of build cache on a 7 GB-free disk. It was committed before the feature commit (`f6222b6` before `ca9f2bf`).
   - `ca9f2bf` implements Task 1 (round trip) and Task 2 (refusal rules, cell state, `--consistent`) in the same two files.
2. **[Rule 1 - Test robustness] `reachable()` retry in the gate step.** The first attach run failed `restored` and `force-recreate` with a bare `fetch failed` right after containers were restarted or recreated. The data checks themselves were fine: on fresh volumes, all nine passed. The likely cause is Garage, which has no healthcheck, so `--wait` does not wait for its S3 listener; or Docker Desktop's port forward lagging. Sign-in and download now retry connection errors (never HTTP answers) for up to 60 s, and they name the endpoint if they still fail. The next attach run and the final `--up` run passed.
3. **[Rule 2 - Correctness] Restore removes objects that are not in the backup** (`--delete-extra`). The plan's "exactly the backed-up state" includes the bucket. Without this, every upload made after the backup would be left as an orphan, and the gate's `bucketEqualsBackup` check proves it.
4. **[Rule 2 - Security] Object files are named by the sha256 of the key, not by the key.** On restore a key comes from an untrusted directory. The index schema and the restore check both refuse any other file name, so an entry like `../db.dump` cannot escape `objects/`. The int test covers this.
5. **[Rule 2] Linux bind-mount ownership.** `--user uid:gid` is also used for the restore import (read-only mount of a 0700 directory), not only for the export.
6. **[Rule 2] Extra gate check `consistent-backup`.** It runs the real `--consistent` path once on the stack and checks that the writers are back up. This adds 10 s.
7. **Quiet schema drop.** `SET client_min_messages = warning` before the DROP removes about 75 lines of NOTICE output from the restore log.

## Known Stubs

None.

## Broken windows (for the orchestrator's WINDOWS.md; not written here per instructions)

- **deviation, phase 7, `scripts/ocw/backup.mjs`:** `docker compose start <svc>` (used to resume openclaw after the
  online copy, and the writers after `--consistent`) also starts the one-shot `migrate` dependency again. It is
  idempotent and was harmless in every run, but an online backup briefly runs `migrate`. `up -d --no-deps` would avoid
  it; this was left as is so the restart does not recreate containers.
- **deviation, phase 7, `compose.yaml` (not owned here):** Garage has no healthcheck, so `up --wait` returns before its
  S3 listener answers. The API copes (it retries), and the gate step now retries connections too (deviation 2). A real
  healthcheck needs a probe binary that the Garage image does not ship.

## Open items

- **07-10:** add `node scripts/gate/backup-roundtrip.mjs --up` (or its `run(ctx)` on the shared stack) to the full gate,
  and list it among the CI commands (D-12). It also works with `--attach` on a used stack, because it uses unique names.
- **07-11:** link `docs/self-hosting/backup-restore.md` from the install guide. Once `v0.1.0` is tagged, the runbook's
  N-1 sentence ("until v0.1.0 … Phase 5 merge 3bbcbd9") should read "the previous release tag".
- The runbook's cron example and its key-rotation procedure are documented but were not executed. The rotation steps
  only use commands that the gate did exercise: backup, `down`, volume removal through `down -v`, `up` and restore.
- A failed `pg_restore` leaves empty schemas (documented, re-runnable). Making the drop and the restore one transaction
  would need a plain-SQL pipe through psql. This was not done, to stay on the research-verified sequence.

## Threat Flags

None beyond the plan's register. T-07-09-01..06 are mitigated as planned:

- 0600/0700, no `.env` or `secrets/`, and no secret value in the output (checked in the unit test and in the gate).
- sha256 of every file and object, checked before any change.
- Newer-release refusal.
- `--yes`, plus the demo refusal, unit-tested for its project, its env file and a directory-derived default project.
- Restore runs as `ocw_migrator`; then migrate runs and RLS is checked.
- The password never reaches argv.

## Self-Check: PASSED

- Files: the 7 created and 2 modified files exist on `wt/07-09`.
- Commits: `b01b9a8`, `f6222b6`, `d7eb9a9`, `ca9f2bf` and `f42cb60` are in `git log`. No commit deletes a tracked file.
