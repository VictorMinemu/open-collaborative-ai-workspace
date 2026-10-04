---
phase: "02"
slug: "identity-and-organization"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-04"
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 02-RESEARCH.md §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.2 (root projects `unit`, `integration` — testcontainers PostgreSQL 18 + Redis 8); Playwright 1.63.0 (`desktop` 1440×900, `mobile` 390×844, after `setup`); fast-check (property tests, installed in 02-01) |
| **Config file** | `vitest.config.ts`, `e2e/playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run --project unit <path>` / `pnpm exec vitest run --project integration <path>` |
| **Full suite command** | `pnpm verify && pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test` |
| **E2E command** | `bash scripts/e2e-isolated.sh [spec filters]` — isolated stack (database `ocw_e2e`, API 127.0.0.1:4290, web 127.0.0.1:3290), see below; never `pnpm e2e` against the demo |
| **Estimated runtime** | unit ≈ 20 s; one integration file ≈ 30–60 s; `pnpm verify` ≈ 6–10 min; `pnpm e2e` ≈ 8–12 min |

---

## Sampling Rate

- **After every task commit:** the task's `<automated>` commands (unit project for the touched package + the one integration file of the touched module), then `pnpm verify` (D-10).
- **After every plan:** `pnpm verify`, `pnpm --filter @ocw/local-runtime test`, `pnpm --filter @ocw/desktop test`, and `bash scripts/e2e-isolated.sh` when the plan touches API behaviour or web.
- **After every wave:** full suite + `bash scripts/e2e-isolated.sh`.
- **Before `/gsd-verify-work 2`:** full suite and `bash scripts/e2e-isolated.sh` green; strict authz coverage on; no legacy marker left (02-15).
- **Max feedback latency:** ≈ 60 s per targeted command.

---

## Isolated e2e stack (referenced by every plan — replaces any "fresh worktree stack" procedure)

**Hard rule:** the owner's demo runs from this worktree's compose project (postgres database `ocw`, Redis DB 0, API on :4000, web on :3000, OpenClaw container `ocw-demo-openclaw`). No plan in this phase may stop, recreate, migrate, reset or reseed any of it: never `docker compose down` / `rm` / `stop` / `restart`, never `pnpm db:migrate` with the default `.env`, never `pnpm demo:up` / `pnpm demo:reset`, never bind :4000/:3000, never touch the OpenClaw container. The only databases an executor may create or drop are `ocw_e2e` (this script) and, once in 02-01 Task 1, the scratch restore-check database `ocw_restore_check`; the demo database `ocw` is only ever read by `pg_dump`. The Stage A handoff advice to run `docker compose down -v` does not apply in this phase. CI (`.github/workflows/ci.yml`) keeps its own flow unchanged.

All e2e runs go through `scripts/e2e-isolated.sh` (created by 02-01 Task 3 with exactly the body below):

- a separate database **`ocw_e2e`** inside the already-running compose postgres (only that database is dropped and recreated, then migrated with the four migration URLs swapped to `ocw_e2e`);
- Redis **logical DB 9** of the existing compose Redis (only that DB is flushed; pub/sub channel names carry UUIDs, so they never collide with the demo);
- the API on **127.0.0.1:4290** and the web on **127.0.0.1:3290** (`next start` from a build in `apps/web/.next-e2e`, rebuilt automatically when web or contracts sources changed — the demo's `.next` is never overwritten);
- Playwright with `OCW_E2E_BASE_URL` / `OCW_E2E_API_URL` pointing at those ports, `OCW_MODEL_PROVIDER=mock`;
- one run at a time machine-wide (lock `/tmp/ocw-e2e.lock`: `flock` on Linux, `shlock` on macOS, `mkdir` lock with stale-PID recovery otherwise), so same-wave plans queue instead of colliding;
- PIDs and logs in a per-run temp dir; on exit it stops only the processes it started and prints the log dir.

Usage:

```bash
bash scripts/e2e-isolated.sh                         # full suite (setup + every spec at 1440 and 390), fresh ocw_e2e
bash scripts/e2e-isolated.sh admin-members chat      # Playwright file filters
OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/02-identity-and-organization/screenshots bash scripts/e2e-isolated.sh account
bash scripts/e2e-isolated.sh --keep-db admin-org     # reuse the current ocw_e2e (faster iteration while polishing)
bash scripts/e2e-isolated.sh --rebuild-web           # force a web rebuild into .next-e2e
DEMO_PASSWORD=Demo-e2e-check bash scripts/e2e-isolated.sh --cmd "node scripts/demo-seed.mjs"   # any command against the stack
pnpm exec playwright install chromium               # once per machine
```

Script body (`scripts/e2e-isolated.sh`, bash 3.2 compatible for macOS):

```bash
#!/usr/bin/env bash
# Isolated e2e stack for executors. It never touches the owner's running demo: it uses its own database
# (ocw_e2e) in the existing compose postgres, Redis logical DB 9, API 127.0.0.1:4290, web 127.0.0.1:3290
# built into apps/web/.next-e2e, and a machine-wide lock so concurrent runs queue. CI does not use it.
#   bash scripts/e2e-isolated.sh [--keep-db] [--rebuild-web] [playwright args...]
#   bash scripts/e2e-isolated.sh [--keep-db] --cmd "<shell command run against the stack>"
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

E2E_DB=ocw_e2e          # the ONLY database this script may drop; never parameterised
E2E_REDIS_DB=9
API_PORT=4290           # Node fetch blocks some ports (e.g. 4190); 4290/3290 are verified usable
WEB_PORT=3290
WEB_DIST=.next-e2e
LOCK=/tmp/ocw-e2e.lock

keep_db=0; rebuild_web=0; cmd=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-db) keep_db=1 ;;
    --rebuild-web) rebuild_web=1 ;;
    --cmd) cmd="${2:?--cmd needs a command}"; shift ;;
    *) args+=("$1") ;;
  esac
  shift
done
[ -f .env ] || { echo "e2e-isolated: .env missing (pnpm setup:env)"; exit 1; }

# ---------------------------------------------------------------- lock (portable)
release_lock() { :; }
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  echo "e2e-isolated: waiting for $LOCK"; flock 9
elif command -v shlock >/dev/null 2>&1; then
  until shlock -f "$LOCK" -p $$; do echo "e2e-isolated: waiting for $LOCK"; sleep 3; done
  release_lock() { rm -f "$LOCK"; }
else
  until mkdir "$LOCK.d" 2>/dev/null; do
    holder="$(cat "$LOCK.d/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$LOCK.d"; continue; fi
    echo "e2e-isolated: waiting for $LOCK.d"; sleep 3
  done
  echo $$ >"$LOCK.d/pid"
  release_lock() { rm -rf "$LOCK.d"; }
fi

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ocw-e2e.XXXXXX")"
stop_pid() {
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
}
cleanup() {
  stop_pid "$RUN_DIR/web.pid"; stop_pid "$RUN_DIR/api.pid"
  release_lock
  echo "e2e-isolated: logs in $RUN_DIR"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- environment (demo values → e2e values)
set -a; . ./.env; set +a
swap_path() { node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; process.stdout.write(u.toString())' "$1" "$2"; }
E2E_DATABASE_URL="$(swap_path "$DATABASE_URL" "$E2E_DB")"
E2E_AUTH_DATABASE_URL="$(swap_path "$AUTH_DATABASE_URL" "$E2E_DB")"
E2E_SUPERUSER_URL="$(swap_path "$MIGRATE_SUPERUSER_URL" "$E2E_DB")"
E2E_MIGRATOR_URL="$(swap_path "$MIGRATOR_DATABASE_URL" "$E2E_DB")"
E2E_REDIS_URL="$(swap_path "$REDIS_URL" "$E2E_REDIS_DB")"
for u in "$E2E_DATABASE_URL" "$E2E_AUTH_DATABASE_URL" "$E2E_SUPERUSER_URL" "$E2E_MIGRATOR_URL"; do
  case "$u" in */"$E2E_DB"|*/"$E2E_DB"\?*) ;; *) echo "e2e-isolated: refusing, URL does not target $E2E_DB"; exit 1 ;; esac
done
export DATABASE_URL="$E2E_DATABASE_URL" AUTH_DATABASE_URL="$E2E_AUTH_DATABASE_URL" REDIS_URL="$E2E_REDIS_URL"
export MIGRATE_SUPERUSER_URL="$E2E_SUPERUSER_URL" MIGRATOR_DATABASE_URL="$E2E_MIGRATOR_URL"
export OCW_PUBLIC_API_URL="http://127.0.0.1:$API_PORT" OCW_PUBLIC_WEB_URL="http://127.0.0.1:$WEB_PORT"
export OCW_TRUSTED_ORIGINS="" OCW_MODEL_PROVIDER=mock HOST=127.0.0.1 PORT="$API_PORT"
export OCW_E2E_BASE_URL="$OCW_PUBLIC_WEB_URL" OCW_E2E_API_URL="$OCW_PUBLIC_API_URL" OCW_API_URL="$OCW_PUBLIC_API_URL"

for p in "$API_PORT" "$WEB_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "e2e-isolated: port $p is busy (not started by this run); stop that process and retry"; exit 1
  fi
done

# ---------------------------------------------------------------- database + redis (e2e only)
if [ -z "$(docker compose ps --status running -q postgres)" ] || [ -z "$(docker compose ps --status running -q redis)" ]; then
  docker compose up -d --wait postgres redis   # only when they are not running; never stops anything
fi
if [ "$keep_db" -eq 0 ]; then
  docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $E2E_DB WITH (FORCE)" -c "CREATE DATABASE $E2E_DB" >/dev/null
  docker compose exec -T redis redis-cli -n "$E2E_REDIS_DB" FLUSHDB >/dev/null
  pnpm --filter @ocw/db migrate >"$RUN_DIR/migrate.log" 2>&1 || { tail -40 "$RUN_DIR/migrate.log"; exit 1; }
fi

# ---------------------------------------------------------------- web build (separate distDir)
need_build=$rebuild_web
[ -f "apps/web/$WEB_DIST/BUILD_ID" ] || need_build=1
if [ "$need_build" -eq 0 ] && [ -n "$(find apps/web/app apps/web/components apps/web/lib apps/web/hooks packages/contracts/src packages/realtime-client/src -type f -newer "apps/web/$WEB_DIST/BUILD_ID" -print 2>/dev/null | head -1)" ]; then
  need_build=1
fi
if [ "$need_build" -eq 1 ]; then
  (cd apps/web && OCW_NEXT_DIST_DIR="$WEB_DIST" pnpm build) >"$RUN_DIR/web-build.log" 2>&1 || { tail -60 "$RUN_DIR/web-build.log"; exit 1; }
fi

# ---------------------------------------------------------------- API + web
(cd apps/api && nohup node --env-file-if-exists=../../.env --import tsx src/main.ts >"$RUN_DIR/api.log" 2>&1 & echo $! >"$RUN_DIR/api.pid")
(cd apps/web && OCW_NEXT_DIST_DIR="$WEB_DIST" nohup node --env-file-if-exists=../../.env ./node_modules/next/dist/bin/next start -p "$WEB_PORT" -H 127.0.0.1 >"$RUN_DIR/web.log" 2>&1 & echo $! >"$RUN_DIR/web.pid")
ready=0
for _ in $(seq 1 90); do
  if curl -sf "$OCW_E2E_API_URL/health" >/dev/null && curl -sf -o /dev/null "$OCW_E2E_BASE_URL/login"; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || { tail -40 "$RUN_DIR/api.log"; tail -40 "$RUN_DIR/web.log"; exit 1; }

# ---------------------------------------------------------------- run
status=0
if [ -n "$cmd" ]; then
  bash -c "$cmd" || status=$?
else
  pnpm e2e ${args[@]+"${args[@]}"} || status=$?
fi
exit "$status"
```

Notes for executors:

- Exported variables override `.env` because Node's `--env-file` never overwrites variables already set; this is how the API, the web server and `pnpm --filter @ocw/db migrate` all target `ocw_e2e`.
- The role bootstrap that `migrate` runs as superuser is idempotent and only re-applies the same role passwords from `.env`; it does not touch the demo database.
- `setup.spec.ts` redeems `OCW_SETUP_TOKEN` against the fresh `ocw_e2e`; with `--keep-db` it skips because the stack is already set up.
- On failure read `api.log`, `web.log`, `migrate.log` in the printed temp dir and the Playwright report in `e2e/playwright-report`.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | ORG-02, ORG-01, ORG-03, ORG-06, AUTH-05, AUTH-06 | T-02-01-01/04/05/06 | demo DB dumped + restore-checked; owner/admin→admin, member→developer only; CHECK rejects legacy roles; new tables tenant-isolated; isolated commit | integration + unit | `pnpm exec vitest run --project integration packages/db/src/role-migration.int.test.ts packages/db/src/rls-isolation.int.test.ts` · `pnpm exec vitest run --project unit packages/contracts/src/permissions.test.ts packages/contracts/src/contracts.test.ts` | ❌ W0 (role-migration, permissions.test) | ⬜ pending |
| 02-01-02 | 01 | 1 | ORG-02 | T-02-01-02/03/07 | invitations not via the plugin; admins keep every capability; members become developers | integration | `pnpm exec vitest run --project integration apps/api/src/identity.int.test.ts` · `pnpm verify` | ✅ extend | ⬜ pending |
| 02-01-03 | 01 | 1 | ORG-03 (tooling) | T-02-01-08, T-02-01-SC | packages pinned; e2e isolated from the demo | e2e | `bash -n scripts/e2e-isolated.sh && pnpm verify` · `bash scripts/e2e-isolated.sh` | ❌ W0 (script) | ⬜ pending |
| 02-02-01 | 02 | 2 | ORG-03, ORG-05 | T-02-02-04/05 | archive decided by resolver; denial audited after rollback; private → 404 | integration | `pnpm exec vitest run --project integration apps/api/src/modules/chat/chat.int.test.ts` | ✅ extend | ⬜ pending |
| 02-02-02 | 02 | 2 | ORG-03 | T-02-02-01/02/03/07 | deny precedence, non-delegable allows, agent ∩ human, surfaces | unit (fast-check) + integration | `pnpm exec vitest run --project unit apps/api/src/modules/organization/permissions/resolve.test.ts` · `pnpm exec vitest run --project integration apps/api/src/modules/organization/permissions/facts.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-03 | 02 | 2 | ORG-03 | T-02-02-06 | undecided 2xx recorded; legacy checks fail the guard | unit | `pnpm exec vitest run --project unit apps/api/src/authz.test.ts apps/api/src/modules/organization/permissions/guard.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 2 | AUTH-06, AUTH-05 | T-02-03-01/02/03/04 | minimal claims, JWKS verify, deactivated cannot sign in | unit + integration | `pnpm exec vitest run --project unit apps/api/src/modules/identity/client-kind.test.ts` · `pnpm exec vitest run --project integration apps/api/src/modules/identity/tokens.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 2 | AUTH-05, ORG-05 | T-02-03-06/07/08 | audit rows carry session/client; revocation flagged ≥ JWT life; store never returns tokens | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/tokens.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-03 | 03 | 2 | ORG-01, ORG-02, ORG-06, AUTH-04 | — | https-only avatars, non-delegable allows rejected | unit | `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts` | ✅ extend | ⬜ pending |
| 02-04-01 | 04 | 3 | ORG-03 | T-02-04-01 | private channels hidden in list/detail/topic | integration | `pnpm exec vitest run --project integration apps/api/src/modules/chat/chat.int.test.ts` | ✅ extend | ⬜ pending |
| 02-04-02 | 04 | 3 | ORG-03, AUTH-05 | T-02-04-02/03/04/06 | mutations + bot replies via resolver; desktop client kind on messages | integration | `pnpm exec vitest run --project integration apps/api/src/modules/chat/chat.int.test.ts apps/api/src/modules/agent-channel/agent-channel.int.test.ts` | ✅ extend | ⬜ pending |
| 02-05-01 | 05 | 3 | ORG-03 | T-02-05-01 | approvals: creator/device owner/admin; Tool-layer deny | integration | `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` | ✅ extend | ⬜ pending |
| 02-05-02 | 05 | 3 | ORG-03, AUTH-05 | T-02-05-02/03/04/06 | device.use via owner/shared only; standard has no Work Zone | integration | `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` | ✅ extend | ⬜ pending |
| 02-06-01 | 06 | 3 | ORG-01 | T-02-06-01 | units CRUD + move, audited | integration | `pnpm exec vitest run --project integration apps/api/src/modules/organization/units.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-06-02 | 06 | 3 | ORG-01, ORG-02 | T-02-06-02/03 | no cycles under concurrency; leads scoped to subtree | unit (fast-check) + integration | `pnpm exec vitest run --project unit apps/api/src/modules/organization/units.test.ts` · `pnpm exec vitest run --project integration apps/api/src/modules/organization/units.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-06-03 | 06 | 3 | ORG-03 | T-02-06-04/05/06 | unit-scoped deny enforced end to end; org/user topics decided | integration | `pnpm exec vitest run --project integration apps/api/src/modules/organization/rules.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-07-01 | 07 | 3 | ORG-02 | T-02-07-03/06 | role change effective; last admin protected | integration | `pnpm exec vitest run --project integration apps/api/src/modules/organization/members.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-07-02 | 07 | 3 | ORG-06, ORG-05 | T-02-07-04/05 | deactivation ends sessions/sockets; profiles readable | integration | `pnpm exec vitest run --project integration apps/api/src/modules/organization/members.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-07-03 | 07 | 3 | ORG-02, ORG-03 | T-02-07-01/02 | lead invite ceiling; lead revokes own only | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/invitations.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-08-01 | 08 | 3 | AUTH-06 | T-02-08-04/05 | WS JWT before upgrade; cookie-only refused; replay exactly once | integration + unit | `pnpm exec vitest run --project integration apps/api/src/identity.int.test.ts` · `pnpm exec vitest run --project unit packages/realtime-client/src/client.test.ts` | ✅ extend | ⬜ pending |
| 02-08-02 | 08 | 3 | AUTH-06 | T-02-08-01/02/07 | Bearer on REST; tampered/expired/wrong-aud/revoked/deactivated → 401 | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/jwt.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-08-03 | 08 | 3 | AUTH-06, AUTH-05 | T-02-08-03 | revocation closes sockets 4401 < 1 s; client refreshes once | integration + unit | same as 02-08-01 | ✅ extend | ⬜ pending |
| 02-09-01 | 09 | 3 | AUTH-05, ORG-05 | T-02-09-01/02/08 | own sessions only, no tokens; sign-in failure and sign-out audited | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/sessions.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-09-02 | 09 | 3 | AUTH-04 | T-02-09-03/04/05/06 | single-use reset; no enumeration; sessions revoked | unit + integration | `pnpm exec vitest run --project unit apps/api/src/lib/mailer.test.ts` · `pnpm exec vitest run --project integration apps/api/src/modules/identity/password.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-09-03 | 09 | 3 | ORG-06 | T-02-09-07 | https/emoji avatars only; profile propagates | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/profile.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-10-01 | 10 | 4 | ORG-03 | T-02-10-01 | providers/bots admin-only; explicit deny beats admin role | integration | `pnpm exec vitest run --project integration apps/api/src/modules/agent-channel/agent-channel.int.test.ts` | ✅ extend | ⬜ pending |
| 02-10-02 | 10 | 4 | ORG-03 | T-02-10-02/03/04 | cell/agent principals; agent ∩ human through the plugin route | integration | `pnpm exec vitest run --project integration apps/api/src/modules/agent-channel/agent-channel.int.test.ts apps/api/src/modules/agent-channel/provider-auth.int.test.ts` | ✅ extend | ⬜ pending |
| 02-11-01 | 11 | 4 | AUTH-06 | T-02-11-04/05 | daemon exchanges token; Device Link verifies device JWT | unit (local-runtime) + integration | `pnpm --filter @ocw/local-runtime test` · `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` | ✅ extend | ⬜ pending |
| 02-11-02 | 11 | 4 | AUTH-06 | T-02-11-01/02/03 | legacy flag on/off; revoked device and user JWT refused | integration | `pnpm exec vitest run --project integration apps/api/src/device-link-auth.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-12-01 | 12 | 4 | ORG-04, ORG-02 | T-02-12-01 | role change via UI; lead invite ceiling in UI | e2e | `bash scripts/e2e-isolated.sh admin-members` | ❌ W0 | ⬜ pending |
| 02-12-02 | 12 | 4 | ORG-04, ORG-06 | T-02-12-02/03 | reset link shown once; profile sheet | e2e | `bash scripts/e2e-isolated.sh admin-members chat` | ❌ W0 | ⬜ pending |
| 02-12-03 | 12 | 4 | ORG-04 | — | visual review 390/1440 light/dark | e2e + manual | `bash scripts/e2e-isolated.sh admin-members` | ❌ W0 | ⬜ pending |
| 02-13-01 | 13 | 4 | ORG-04, ORG-01 | T-02-13-01 | build hierarchy from empty state | e2e | `bash scripts/e2e-isolated.sh admin-org` | ❌ W0 | ⬜ pending |
| 02-13-02 | 13 | 4 | ORG-04, ORG-01, ORG-02 | T-02-13-02/03 | move/delete/staff; rules read-only | e2e | `bash scripts/e2e-isolated.sh admin-org` | ❌ W0 | ⬜ pending |
| 02-13-03 | 13 | 4 | ORG-04 | — | visual review 390/1440 light/dark | e2e + manual | `bash scripts/e2e-isolated.sh admin-org` | ❌ W0 | ⬜ pending |
| 02-14-01 | 14 | 4 | ORG-06 | T-02-14-03 | profile edit propagates | e2e | `bash scripts/e2e-isolated.sh account` | ❌ W0 | ⬜ pending |
| 02-14-02 | 14 | 4 | AUTH-04, AUTH-05 | T-02-14-01/02 | sessions revoke across contexts; reset/forgot flows | e2e | `bash scripts/e2e-isolated.sh account smoke` | ❌ W0 | ⬜ pending |
| 02-14-03 | 14 | 4 | ORG-06, AUTH-04 | — | visual review 390/1440 light/dark | e2e + manual | `bash scripts/e2e-isolated.sh account` | ❌ W0 | ⬜ pending |
| 02-15-01 | 15 | 5 | ORG-03 | T-02-15-01/02/03 | strict coverage; no role in AuthContext; clean guard | unit + integration | `pnpm exec vitest run --project unit apps/api/src/modules/organization/permissions/guard.test.ts apps/api/src/authz.test.ts` · `pnpm verify` | ❌ W0 (authz.int) | ⬜ pending |
| 02-15-02 | 15 | 5 | all | — | phase gate | full + e2e | `pnpm verify && pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test` · `bash scripts/e2e-isolated.sh` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠ flaky*

### Requirement → plan coverage

| Req | Behaviour | Plans (API → UI) | Proof |
|-----|-----------|------------------|-------|
| AUTH-04 | Reset by e-mail (SMTP) or admin link; change password (D-04) | 02-09 → 02-12 (admin link UI), 02-14 | password.int.test.ts, mailer.test.ts, account.spec.ts, admin-members.spec.ts |
| AUTH-05 | Sessions list/revoke with client identifier; identifier on messages and audit | 02-01 (columns), 02-03, 02-04/05/10 (client kind), 02-08 (sockets), 02-09 → 02-14 | tokens.int.test.ts, sessions.int.test.ts, chat.int.test.ts, account.spec.ts |
| AUTH-06 | JWT/JWKS for API, WebSocket, daemon | 02-01 (jwks), 02-03 (issue), 02-08 (REST + WS), 02-11 (daemon), 02-15 (ADR-0008) | tokens/jwt/identity/device-link-auth int tests, client.test.ts, daemon.test.ts, e2e chat + work-zone |
| ORG-01 | Hierarchy CRUD incl. moves | 02-01 (schema), 02-06 → 02-13 | units.test.ts, units.int.test.ts, admin-org.spec.ts |
| ORG-02 | Four roles; unit memberships member/lead | 02-01 (migration), 02-06 (memberships), 02-07 (roles, invitations) → 02-12, 02-13 | role-migration, members, invitations, units int tests; admin specs |
| ORG-03 | One resolver, explicit-deny precedence, every route | 02-01 (vocabulary), 02-02, 02-04, 02-05, 02-06, 02-07, 02-10, 02-11, 02-15 | resolve.test.ts (matrix + properties), guard.test.ts, authz.int.test.ts (strict), module int tests |
| ORG-04 | Admin console CRUD pages | 02-06/02-07 (API) → 02-12, 02-13 | admin-members.spec.ts, admin-org.spec.ts + reviewed screenshots |
| ORG-05 | Same-transaction audit incl. failed sign-in, hierarchy, roles, memberships, sessions, denials | 02-02 (denials), 02-03 (session/client on rows), 02-06, 02-07, 02-09 | audit assertions in every int test listed above |
| ORG-06 | Edit own profile; see others' profiles | 02-01 (columns), 02-07 (member profile), 02-09 (edit) → 02-12 (sheet), 02-14 (page) | profile.int.test.ts, members.int.test.ts, account.spec.ts, admin-members.spec.ts |

---

## Wave 0 Requirements

Created inside the plans that first need them (each plan's first task writes the failing test before the code):

- [ ] `packages/db/src/role-migration.int.test.ts` — 02-01
- [ ] `packages/contracts/src/permissions.test.ts` — 02-01
- [ ] `fast-check`, `jose`, `nodemailer`, `@types/nodemailer` pinned — 02-01 (D-08)
- [ ] `apps/api/src/modules/organization/permissions/{resolve.test.ts,facts.int.test.ts,guard.test.ts}`, `apps/api/src/authz.test.ts` — 02-02
- [ ] `apps/api/src/modules/identity/{client-kind.test.ts,tokens.int.test.ts}` — 02-03
- [ ] `apps/api/src/modules/organization/{units.test.ts,units.int.test.ts,rules.int.test.ts,members.int.test.ts}` — 02-06, 02-07
- [ ] `apps/api/src/modules/identity/{invitations,jwt,sessions,password,profile}.int.test.ts`, `apps/api/src/lib/mailer.test.ts` — 02-07, 02-08, 02-09
- [ ] `TestClient.token()` + header options in `apps/api/src/testing.ts` — 02-08
- [ ] `apps/api/src/device-link-auth.int.test.ts` — 02-11
- [ ] `e2e/tests/{admin-members,admin-org,account}.spec.ts` — 02-12, 02-13, 02-14
- [ ] `apps/api/src/authz.int.test.ts` — 02-15
- [ ] `scripts/e2e-isolated.sh` (isolated e2e stack) — 02-01 Task 3

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual quality of the admin console and account pages at 390/1440, light/dark | ORG-04, ORG-06, AUTH-04, AUTH-05 | Visual polish cannot be grepped (D-09) | Open `screenshots/members-*.png`, `org-*.png`, `account-*.png`; harvested at end of phase from each UI plan's `<human-check>` |
| Installed desktop app built before Phase 2 keeps pairing and running sessions | AUTH-06 (D-03) | Needs the owner's existing ad-hoc signed .app | With `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` unset, start the old app; it connects; one `device.legacy_token_used` audit row per hour |
| Real SMTP delivery of a reset e-mail | AUTH-04 | Needs a real SMTP account (optional feature) | Set `OCW_SMTP_URL`/`OCW_MAIL_FROM`, use "Forgot password?" on /login, follow the link |

---

## Artifacts this phase produces

- **Contracts:** `packages/contracts/src/permissions.ts` (+ test); DTOs for units, memberships, rules, member detail, sessions, password reset, profile (`organization.ts`, `identity.ts`); `viewerCan` on ChannelSummary/Device/WorkSessionDetail/Invitation; new EventTypes.
- **Database:** migrations `*_role_values` (data), `*_role_check`, `*_identity_org` (org_units, unit_memberships, permission_rules, org_members status/deactivation, session client columns, auth.jwks); `role-migration.int.test.ts`; RLS enumerator seeds.
- **API — authorization:** `organization/permissions/{resolve,policy,facts,service,errors}.ts`, `apps/api/src/authz.ts`, guard and coverage tests; `organization/{members,units,rules}.ts`; GET `/api/v1/me/permissions`.
- **API — identity:** `identity/{authenticate,client-kind,session-store,invitations,jwt,sessions,password,profile}.ts`, `lib/mailer.ts`, revocation fan-out in `realtime/service.ts`, JWT WebSocket gateway, `device/token.ts`, `OCW_SMTP_URL`, `OCW_MAIL_FROM`, `OCW_ACCEPT_LEGACY_DEVICE_TOKEN`.
- **Clients:** `packages/realtime-client` getToken; `apps/web/lib/{permissions,auth-token,member-queries,org-queries,account-queries}.ts`; Settings › Members (extended), › Organization, › Profile, › Security; `/reset-password`; daemon device-JWT exchange.
- **Tests/E2E:** `scripts/e2e-isolated.sh` (isolated, locked e2e stack); `admin-members.spec.ts`, `admin-org.spec.ts`, `account.spec.ts`; screenshots in `.planning/phases/02-identity-and-organization/screenshots/`.
- **Safety:** restore-checked dump of the demo database in `$HOME/.ocw-backups` (outside the repo), restore command in 02-01-SUMMARY.md.
- **Docs:** ADR-0007 (roles, hierarchy, resolver), ADR-0008 (JWT transport), `docs/DEMO.md`, `scripts/demo-seed.mjs` hierarchy and roles.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60 s per targeted command
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
