#!/usr/bin/env bash
# Isolated e2e stack for executors. It never touches the owner's running demo: it uses its own database
# (ocw_e2e) in the existing compose postgres, Redis logical DB 9, API 127.0.0.1:4290, web 127.0.0.1:3290
# built into apps/web/.next-e2e, the fake model/MCP/ClawHub server (infra/fake-model) on 127.0.0.1:4291, its own
# Garage (attachments, ADR-0015) in the separate compose project `ocw-e2e-storage` on 127.0.0.1:4292, and a
# machine-wide lock so concurrent runs queue. CI uses it only for the real-cell proof (.github/workflows/cell-proof.yml).
#   bash scripts/e2e-isolated.sh [--keep-db] [--rebuild-web] [--sandbox] [playwright args...]
#   bash scripts/e2e-isolated.sh [--keep-db] [--sandbox] --cmd "<shell command run against the stack>"
# Bot sandboxes (07.8-08, P-13): by default the API's sandboxd is the in-memory fake the fake server mounts at
# http://127.0.0.1:4291/__sandboxd (no Docker). `--sandbox` runs the REAL broker instead: it builds the `sbx` image as
# ocw-sandbox-sbx:e2e (and every other sandbox image the broker reads, once its Dockerfile and its env var exist), starts
# apps/sandboxd as a host process on 127.0.0.1:4293 with namespace `ocw-e2e` and a generated token, and removes every
# `ocw.namespace=ocw-e2e` container, volume and network (and the :e2e images) before the run and on exit.
# Optional env (scripts/cell-proof.sh): OCW_E2E_API_HOST (API bind address, default 127.0.0.1; 0.0.0.0 only where a
# container must reach the API and the host is disposable, e.g. CI), OCW_E2E_CLAWHUB_URL (ClawHub the API proxies,
# default the fake); OCW_BUNDLED_PLUGINS and OCW_MOCK_MODEL_BASE_URL are kept over .env when the caller sets them.
# OCW_PRESIDIO_URL (07.2-13): the e2e API's Presidio analyzer is the caller's value or empty (off), never .env's, so a
# demo .env never points the e2e API at a real or internal Presidio; memory-proposals.spec runs once with a
# non-answering address (e.g. http://192.0.2.1:3000) to show the "Extended scan unavailable" warning.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

E2E_DB=ocw_e2e          # the ONLY database this script may drop; never parameterised
E2E_REDIS_DB=9
API_PORT=4290           # Node fetch blocks some ports (e.g. 4190); 4290/3290 are verified usable
WEB_PORT=3290
FAKE_PORT=4291          # fake model + fake MCP (/mcp, bearer FAKE_MCP_TOKEN) + fake ClawHub (/api/v1/*)
STORAGE_PORT=4292       # Garage S3 API of the harness's own compose project
STORAGE_PROJECT=ocw-e2e-storage   # the ONLY compose project this script runs lifecycle commands on
WEB_DIST=.next-e2e
LOCK=/tmp/ocw-e2e.lock
SANDBOX_PORT=4293       # --sandbox: the real sandboxd broker (host process, loopback)
SANDBOX_NS=ocw-e2e      # --sandbox: the ONLY label namespace this script removes (ocw.namespace=ocw-e2e)
# Default mode: the fake sandboxd behind this fixed, loopback-only test token (never a real broker's token).
FAKE_SANDBOX_TOKEN=e2e-sandbox-token-0123456789abcdef0123456789

keep_db=0; rebuild_web=0; sandbox=0; cmd=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-db) keep_db=1 ;;
    --rebuild-web) rebuild_web=1 ;;
    --sandbox) sandbox=1 ;;
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

# ---------------------------------------------------------------- keep the Mac awake (macOS)
# A sleep mid-run freezes the browser, the API and Playwright together, and on wake the test that was running fails,
# usually on its timeout, as if the product hung (07.2 gate: a 38 s lid-close sleep timed out memory-files on desktop;
# the same run had idle-slept 17 s three minutes earlier). caffeinate -i blocks idle sleep while this script runs.
# Closing the lid on battery still sleeps, so cleanup lists every sleep that happened during the run.
run_started="$(date '+%Y-%m-%d %H:%M:%S')"
if command -v caffeinate >/dev/null 2>&1; then caffeinate -i -w $$ & fi
report_sleeps() {
  command -v pmset >/dev/null 2>&1 || return 0
  local slept
  slept="$(pmset -g log 2>/dev/null | awk -v since="$run_started" '/Entering Sleep state/ && ($1 " " $2) >= since' || true)"
  [ -n "$slept" ] || return 0
  echo "e2e-isolated: WARNING the Mac slept during this run; a test that failed at one of these times failed on wake,"
  echo "e2e-isolated: not because of the product (pmset -g log):"
  printf '%s\n' "$slept" | sed -E 's/^([0-9-]+ [0-9:]+) [+-][0-9]+[[:space:]]+Sleep[[:space:]]+/  \1  /'
}

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ocw-e2e.XXXXXX")"
stop_pid() {
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
}
storage() { docker compose -p "$STORAGE_PROJECT" -f compose.yaml "$@"; }
# --sandbox: images this script builds (tag :e2e, label ocw.namespace=ocw-e2e). Each row: Dockerfile, build context, tag,
# and the broker variable that reads it; a row is built only when its Dockerfile exists and apps/sandboxd reads its
# variable, so the browser and egress images join once their broker plans (07.8-12/13) wire them.
SANDBOX_IMAGES=(
  "infra/sandbox/sbx/Dockerfile infra/sandbox/sbx ocw-sandbox-sbx:e2e OCW_SANDBOX_SBX_IMAGE"
  "infra/sandbox/browser/Dockerfile infra/sandbox/browser ocw-sandbox-brw:e2e OCW_SANDBOX_BRW_IMAGE"
  "infra/sandbox/egress/Dockerfile . ocw-sandbox-egress:e2e OCW_SANDBOX_EGRESS_IMAGE"
)
sandbox_objects() {
  { docker ps -aq --filter "label=ocw.namespace=$SANDBOX_NS"
    docker volume ls -q --filter "label=ocw.namespace=$SANDBOX_NS"
    docker network ls -q --filter "label=ocw.namespace=$SANDBOX_NS"; } 2>/dev/null | wc -l | tr -d ' '
}
# Removes every object of the e2e namespace by label (never a prune, never another namespace).
sandbox_clean() {
  local ids
  ids="$(docker ps -aq --filter "label=ocw.namespace=$SANDBOX_NS")"
  if [ -n "$ids" ]; then docker rm -f $ids >/dev/null 2>&1 || true; fi
  ids="$(docker volume ls -q --filter "label=ocw.namespace=$SANDBOX_NS")"
  if [ -n "$ids" ]; then docker volume rm -f $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter "label=ocw.namespace=$SANDBOX_NS")"
  if [ -n "$ids" ]; then docker network rm $ids >/dev/null 2>&1 || true; fi
}
sandbox_images_rm() {
  local row tag
  for row in "${SANDBOX_IMAGES[@]}"; do
    set -- $row; tag="$3"
    docker image rm -f "$tag" >/dev/null 2>&1 || true
  done
}
cleanup() {
  local code=$?
  stop_pid "$RUN_DIR/web.pid"; stop_pid "$RUN_DIR/api.pid"; stop_pid "$RUN_DIR/fake.pid"
  if [ "$sandbox" -eq 1 ]; then
    stop_pid "$RUN_DIR/sandboxd.pid"
    sandbox_clean
    sandbox_images_rm
    left="$(sandbox_objects)"
    if [ "$left" != "0" ]; then
      echo "e2e-isolated: FAIL $left object(s) labelled ocw.namespace=$SANDBOX_NS left after cleanup"; code=1
    else
      echo "e2e-isolated: no ocw.namespace=$SANDBOX_NS object left; :e2e sandbox images removed"
    fi
  fi
  storage stop garage >/dev/null 2>&1 || true
  release_lock
  report_sleeps
  echo "e2e-isolated: logs in $RUN_DIR"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------- environment (demo values → e2e values)
# The caller's values of these win over .env (the real-cell proof sets them).
caller_keep=()
for v in OCW_BUNDLED_PLUGINS OCW_MOCK_MODEL_BASE_URL; do
  if [ -n "${!v-}" ]; then caller_keep+=("$v=${!v}"); fi
done
caller_presidio="${OCW_PRESIDIO_URL-}"
set -a; . ./.env; set +a
for kv in ${caller_keep[@]+"${caller_keep[@]}"}; do export "${kv?}"; done
export OCW_PRESIDIO_URL="$caller_presidio"
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
export OCW_TRUSTED_ORIGINS="" OCW_MODEL_PROVIDER=mock HOST="${OCW_E2E_API_HOST:-127.0.0.1}" PORT="$API_PORT"
# Every spec signs real browsers in from 127.0.0.1; production keeps the default (30/min).
export OCW_SIGNIN_RATE_LIMIT_PER_MINUTE="${OCW_SIGNIN_RATE_LIMIT_PER_MINUTE:-600}"
# The search specs type and filter as one user many times a minute; production keeps 30/min/user (P-11).
export OCW_SEARCH_RATE_LIMIT_PER_MINUTE="${OCW_SEARCH_RATE_LIMIT_PER_MINUTE:-600}"
export OCW_E2E_BASE_URL="$OCW_PUBLIC_WEB_URL" OCW_E2E_API_URL="$OCW_PUBLIC_API_URL" OCW_API_URL="$OCW_PUBLIC_API_URL"
# The marketplace and MCP specs: the API proxies the fake ClawHub; the simulated cell probes the fake MCP.
export OCW_E2E_FAKE_URL="http://127.0.0.1:$FAKE_PORT" OCW_CLAWHUB_URL="${OCW_E2E_CLAWHUB_URL:-http://127.0.0.1:$FAKE_PORT}"
export OCW_E2E_FAKE_MCP_TOKEN="e2e-mcp-token"
# Per-member connectors (07.4-13): the API reaches the fake OAuth MCP server by the name an admin registers
# (http://fake-mcp:4291/mcp-oauth/mcp) through its egress guard. TEST-ONLY: the API refuses this variable when
# NODE_ENV is production, and only this script exports it.
export OCW_EGRESS_TEST_HOSTS="fake-mcp=127.0.0.1"
# AI chats (Phase 5, P-08/P-12): the API's ChatGPT plan (Responses API + SIWC), mock backend and AI web search all
# point at the fake. The bots' own SearXNG variable stays unset: bot-capabilities.spec expects that option disabled.
export OCW_CHATGPT_API_BASE_URL="http://127.0.0.1:$FAKE_PORT/v1" OCW_CHATGPT_AUTH_BASE_URL="http://127.0.0.1:$FAKE_PORT/siwc"
export OCW_AI_MOCK_BASE_URL="http://127.0.0.1:$FAKE_PORT/v1" OCW_AI_SEARXNG_URL="http://127.0.0.1:$FAKE_PORT"
# The AI chat specs send many turns a minute as one member; production keeps 30/min/user.
export OCW_AI_SEND_RATE_LIMIT_PER_MINUTE="${OCW_AI_SEND_RATE_LIMIT_PER_MINUTE:-600}"
# Attachments: the harness's own Garage with fixed, loopback-only test credentials (never the demo's keys).
export OCW_S3_PORT="$STORAGE_PORT" OCW_S3_ENDPOINT="http://127.0.0.1:$STORAGE_PORT" OCW_S3_PUBLIC_URL="http://127.0.0.1:$STORAGE_PORT"
export OCW_S3_BUCKET=ocw-attachments OCW_S3_REGION=garage
export GARAGE_RPC_SECRET="e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0"
export OCW_S3_ACCESS_KEY_ID="GKe2e0e2e0e2e0e2e0e2e0e2e0"
export OCW_S3_SECRET_ACCESS_KEY="e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5e2e5"
# Bot sandboxes (07.8-05/08): the API's broker is the fake sandboxd the fake server mounts at /__sandboxd, behind a fixed
# loopback-only test token. --sandbox replaces both with the real broker below. Never .env's values.
export OCW_SANDBOX_URL="http://127.0.0.1:$FAKE_PORT/__sandboxd" OCW_SANDBOX_TOKEN="$FAKE_SANDBOX_TOKEN"
# Which broker the specs run against (e2e/support/sandbox.ts): `fake` (seed, stats, down/up controls) or `real`.
export OCW_E2E_SANDBOX=fake

# A Garage left running by an interrupted earlier run of this script is ours to stop (never another project's).
storage stop garage >/dev/null 2>&1 || true
ports=("$API_PORT" "$WEB_PORT" "$FAKE_PORT" "$STORAGE_PORT")
if [ "$sandbox" -eq 1 ]; then ports+=("$SANDBOX_PORT"); fi
for p in "${ports[@]}"; do
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

# ---------------------------------------------------------------- object storage (own compose project)
# Only `-p ocw-e2e-storage` lifecycle commands: the demo project's containers are never stopped or recreated.
if [ "$keep_db" -eq 0 ]; then
  storage down -v >/dev/null 2>&1 || true
fi
storage up -d garage >"$RUN_DIR/garage.log" 2>&1 || { tail -20 "$RUN_DIR/garage.log"; exit 1; }
s3_ready=0
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$OCW_S3_ENDPOINT/" || true)" != "000" ]; then s3_ready=1; break; fi
  sleep 1
done
[ "$s3_ready" -eq 1 ] || { storage logs --tail 40 garage; exit 1; }

# ---------------------------------------------------------------- web build (separate distDir)
need_build=$rebuild_web
[ -f "apps/web/$WEB_DIST/BUILD_ID" ] || need_build=1
if [ "$need_build" -eq 0 ] && [ -n "$(find apps/web/app apps/web/components apps/web/lib apps/web/hooks packages/contracts/src packages/realtime-client/src -type f -newer "apps/web/$WEB_DIST/BUILD_ID" -print 2>/dev/null | head -1)" ]; then
  need_build=1
fi
if [ "$need_build" -eq 1 ]; then
  (cd apps/web && OCW_NEXT_DIST_DIR="$WEB_DIST" pnpm build) >"$RUN_DIR/web-build.log" 2>&1 || { tail -60 "$RUN_DIR/web-build.log"; exit 1; }
fi

# ---------------------------------------------------------------- real sandboxd (--sandbox only)
if [ "$sandbox" -eq 1 ]; then
  server_version="$(docker version --format '{{.Server.Version}}')"
  if [ "${server_version%%.*}" -lt 26 ]; then
    echo "e2e-isolated: Docker $server_version < 26 (internal networks forward DNS before 26): refusing --sandbox"; exit 1
  fi
  if [ -z "${DOCKER_SOCKET:-}" ]; then
    host="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
    case "$host" in unix://*) DOCKER_SOCKET="${host#unix://}" ;; *) DOCKER_SOCKET=/var/run/docker.sock ;; esac
  fi
  sandbox_clean
  broker_env=()
  for row in "${SANDBOX_IMAGES[@]}"; do
    set -- $row
    [ -f "$1" ] || continue
    grep -q "$4" apps/sandboxd/src/main.ts || continue
    echo "e2e-isolated: building $3 from $1"
    docker build -q --label "ocw.namespace=$SANDBOX_NS" -t "$3" -f "$1" "$2" >"$RUN_DIR/sandbox-build.log" 2>&1 ||
      { tail -40 "$RUN_DIR/sandbox-build.log"; exit 1; }
    broker_env+=("$4=$3")
  done
  sandbox_token="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  (env ${broker_env[@]+"${broker_env[@]}"} OCW_SANDBOX_TOKEN="$sandbox_token" OCW_SANDBOX_NAMESPACE="$SANDBOX_NS" \
    OCW_SANDBOXD_HOST=127.0.0.1 OCW_SANDBOXD_PORT="$SANDBOX_PORT" OCW_SANDBOX_RUNTIME="${OCW_SANDBOX_RUNTIME:-auto}" \
    DOCKER_SOCKET="$DOCKER_SOCKET" nohup node --import tsx apps/sandboxd/src/main.ts >"$RUN_DIR/sandboxd.log" 2>&1 &
    echo $! >"$RUN_DIR/sandboxd.pid")
  listening=0
  for _ in $(seq 1 60); do
    if grep -q '"msg":"listening"' "$RUN_DIR/sandboxd.log" 2>/dev/null; then listening=1; break; fi
    kill -0 "$(cat "$RUN_DIR/sandboxd.pid")" 2>/dev/null || break
    sleep 1
  done
  [ "$listening" -eq 1 ] || { echo "e2e-isolated: sandboxd did not start"; tail -20 "$RUN_DIR/sandboxd.log"; exit 1; }
  export OCW_SANDBOX_URL="http://127.0.0.1:$SANDBOX_PORT" OCW_SANDBOX_TOKEN="$sandbox_token"
  export OCW_E2E_SANDBOX=real OCW_E2E_SANDBOX_NAMESPACE="$SANDBOX_NS"
  # 07.8-28: the fake sites of the browser journey (infra/sandbox/test/fake-site.mjs on the pinned node base, no image
  # built): panel.fake.test, idp.fake.test and evil.fake.test on :8080, on their own internal network. Both carry
  # ocw.namespace=ocw-e2e, so the label cleanup removes them. Only the egress proxy joins that network
  # (e2e/support/sandbox.ts `useFakeSites`, as the stack smoke does): sandboxd's outbound network keeps
  # inter-container traffic off, so a site attached there would be unreachable.
  fake_site_base="node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
  docker network create --internal --label "ocw.namespace=$SANDBOX_NS" "$SANDBOX_NS-sites" >/dev/null
  docker run -d --name "$SANDBOX_NS-fake-site" --label "ocw.namespace=$SANDBOX_NS" --network "$SANDBOX_NS-sites" \
    --network-alias panel.fake.test --network-alias idp.fake.test --network-alias evil.fake.test \
    --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$PWD/infra/sandbox/test/fake-site.mjs:/site/fake-site.mjs:ro" "$fake_site_base" node /site/fake-site.mjs >/dev/null
  export OCW_E2E_FAKE_SITES_NET="$SANDBOX_NS-sites" OCW_E2E_FAKE_SITE="$SANDBOX_NS-fake-site"
  # The logs a full-stack sweep reads (the API's and sandboxd's), by path only.
  export OCW_E2E_RUN_DIR="$RUN_DIR"
  echo "e2e-isolated: real sandboxd on $OCW_SANDBOX_URL (namespace $SANDBOX_NS)"
fi

# ---------------------------------------------------------------- fake server + API + web
(PORT="$FAKE_PORT" FAKE_MODEL_HOST=127.0.0.1 FAKE_MCP_TOKEN="$OCW_E2E_FAKE_MCP_TOKEN" FAKE_SANDBOX_TOKEN="$FAKE_SANDBOX_TOKEN" \
  nohup node infra/fake-model/server.mjs >"$RUN_DIR/fake.log" 2>&1 & echo $! >"$RUN_DIR/fake.pid")
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
