#!/usr/bin/env bash
# Isolated e2e stack for executors. It never touches the owner's running demo: it uses its own database
# (ocw_e2e) in the existing compose postgres, Redis logical DB 9, API 127.0.0.1:4290, web 127.0.0.1:3290
# built into apps/web/.next-e2e, the fake model/MCP/ClawHub server (infra/fake-model) on 127.0.0.1:4291, and a
# machine-wide lock so concurrent runs queue. CI does not use it.
#   bash scripts/e2e-isolated.sh [--keep-db] [--rebuild-web] [playwright args...]
#   bash scripts/e2e-isolated.sh [--keep-db] --cmd "<shell command run against the stack>"
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

E2E_DB=ocw_e2e          # the ONLY database this script may drop; never parameterised
E2E_REDIS_DB=9
API_PORT=4290           # Node fetch blocks some ports (e.g. 4190); 4290/3290 are verified usable
WEB_PORT=3290
FAKE_PORT=4291          # fake model + fake MCP (/mcp, bearer FAKE_MCP_TOKEN) + fake ClawHub (/api/v1/*)
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
  stop_pid "$RUN_DIR/web.pid"; stop_pid "$RUN_DIR/api.pid"; stop_pid "$RUN_DIR/fake.pid"
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
# Every spec signs real browsers in from 127.0.0.1; production keeps the default (30/min).
export OCW_SIGNIN_RATE_LIMIT_PER_MINUTE="${OCW_SIGNIN_RATE_LIMIT_PER_MINUTE:-600}"
export OCW_E2E_BASE_URL="$OCW_PUBLIC_WEB_URL" OCW_E2E_API_URL="$OCW_PUBLIC_API_URL" OCW_API_URL="$OCW_PUBLIC_API_URL"
# The marketplace and MCP specs: the API proxies the fake ClawHub; the simulated cell probes the fake MCP.
export OCW_E2E_FAKE_URL="http://127.0.0.1:$FAKE_PORT" OCW_CLAWHUB_URL="http://127.0.0.1:$FAKE_PORT"
export OCW_E2E_FAKE_MCP_TOKEN="e2e-mcp-token"

for p in "$API_PORT" "$WEB_PORT" "$FAKE_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "e2e-isolated: port $p is busy (not started by this run); stop that process and retry"; exit 1
  fi
done

# ---------------------------------------------------------------- database + redis (e2e only)
# Reuse the already-running postgres/redis even when this script runs from another git worktree
# (each worktree would otherwise get its own empty compose project): adopt the compose project of the
# postgres container that publishes OCW_POSTGRES_PORT.
if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
  pg_port="$(grep -E '^OCW_POSTGRES_PORT=' .env 2>/dev/null | cut -d= -f2)"
  pg_port="${pg_port:-54329}"
  for c in $(docker ps -q --filter label=com.docker.compose.service=postgres); do
    if docker port "$c" 5432 2>/dev/null | grep -q ":${pg_port}\$"; then
      COMPOSE_PROJECT_NAME="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c")"
      export COMPOSE_PROJECT_NAME
      break
    fi
  done
fi
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

# ---------------------------------------------------------------- fake server + API + web
(PORT="$FAKE_PORT" FAKE_MODEL_HOST=127.0.0.1 FAKE_MCP_TOKEN="$OCW_E2E_FAKE_MCP_TOKEN" nohup node infra/fake-model/server.mjs >"$RUN_DIR/fake.log" 2>&1 & echo $! >"$RUN_DIR/fake.pid")
(cd apps/api && nohup node --env-file-if-exists=../../.env --import tsx src/main.ts >"$RUN_DIR/api.log" 2>&1 & echo $! >"$RUN_DIR/api.pid")
(cd apps/web && OCW_NEXT_DIST_DIR="$WEB_DIST" nohup node --env-file-if-exists=../../.env ./node_modules/next/dist/bin/next start -p "$WEB_PORT" -H 127.0.0.1 >"$RUN_DIR/web.log" 2>&1 & echo $! >"$RUN_DIR/web.pid")
ready=0
for _ in $(seq 1 90); do
  if curl -sf "$OCW_E2E_API_URL/health" >/dev/null && curl -sf -o /dev/null "$OCW_E2E_BASE_URL/login" \
    && curl -sf -o /dev/null "$OCW_E2E_FAKE_URL/v1/models"; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || { tail -40 "$RUN_DIR/api.log"; tail -40 "$RUN_DIR/web.log"; tail -20 "$RUN_DIR/fake.log"; exit 1; }

# ---------------------------------------------------------------- run
status=0
if [ -n "$cmd" ]; then
  bash -c "$cmd" || status=$?
else
  pnpm e2e ${args[@]+"${args[@]}"} || status=$?
fi
exit "$status"
