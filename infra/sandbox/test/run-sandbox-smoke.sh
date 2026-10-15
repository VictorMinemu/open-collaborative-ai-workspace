#!/usr/bin/env bash
# Real-Docker sandbox smoke (07.8-04; D-01, D-02, D-11, SBX-01, SBX-02). Builds the real `sbx` image from
# infra/sandbox/sbx/Dockerfile (no stand-in), runs sandboxd as a host process on 127.0.0.1 and a random port, and
# proves through its HTTP API that a bot's argv runs as uid 10001 in /workspace of its own hardened container. The
# smoke also `docker exec`s into that same labelled container on its own to check the file and its owner.
#
# Usage (repo root):  bash infra/sandbox/test/run-sandbox-smoke.sh
#   DOCKER_SOCKET=<path>   the daemon socket (default: the current docker context's unix socket)
#
# Every Docker object it creates carries `ocw.namespace=ocw-smoke-<pid>` and is removed by that label before the run
# and on exit; the image tag is `ocw-sandbox-sbx:smoke-<sha>` and is removed on exit. It never prunes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

NS="ocw-smoke-$$"
SHA="$(git rev-parse --short HEAD)"
IMAGE="ocw-sandbox-sbx:smoke-${SHA}"
WORK="$(mktemp -d)"
SANDBOXD_PID=""
FAILURES=0

log() { printf '%s\n' "$*" >&2; }
ok() { log "ok   $*"; }
fail() {
  log "FAIL $*"
  FAILURES=$((FAILURES + 1))
}

# ---------------------------------------------------------------- cleanup by label (never a prune)

cleanup_ns() {
  local ids
  ids="$(docker ps -aq --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker rm -f -v $ids >/dev/null 2>&1 || true; fi
  ids="$(docker volume ls -q --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker volume rm -f $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker network rm $ids >/dev/null 2>&1 || true; fi
}

on_exit() {
  local code=$?
  if [ -n "$SANDBOXD_PID" ]; then
    kill "$SANDBOXD_PID" 2>/dev/null || true
    wait "$SANDBOXD_PID" 2>/dev/null || true
  fi
  cleanup_ns
  docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
  local left
  left="$(docker ps -aq --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')"
  left=$((left + $(docker volume ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
  left=$((left + $(docker network ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
  if [ "$left" != "0" ]; then
    log "FAIL ${left} object(s) labelled ocw.namespace=${NS} left after cleanup"
    code=1
  fi
  if [ "$code" != "0" ] && [ -f "$WORK/sandboxd.log" ]; then
    log "--- sandboxd log (ids only) ---"
    tail -n 40 "$WORK/sandboxd.log" >&2 || true
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap on_exit EXIT

# ---------------------------------------------------------------- helpers

# Field of a JSON file: jfield <file> <dot.path>
jfield() {
  node -e '
    const v = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")));
    process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$2"
}

# api <method> <path> [json body] [token] → prints the HTTP status, body in $WORK/body.json
api() {
  local method="$1" path="$2" body="${3:-}" token="${4-$TOKEN}"
  local args=(-sS -o "$WORK/body.json" -w '%{http_code}' -X "$method" --max-time 60)
  if [ -n "$token" ]; then args+=(-H "authorization: Bearer ${token}"); fi
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' --data "$body"); fi
  curl "${args[@]}" "http://127.0.0.1:${PORT}${path}"
}

target() { printf '{"orgId":"%s","agentId":"%s"}' "$1" "$2"; }

# exec_json <org> <agent> <argv json> [timeoutMs] [yieldMs] [cwd]
exec_json() {
  printf '{"target":%s,"argv":%s,"cwd":"%s","timeoutMs":%s,"yieldMs":%s}' \
    "$(target "$1" "$2")" "$3" "${6:-}" "${4:-60000}" "${5:-25000}"
}

uuid() { node -e 'process.stdout.write(require("crypto").randomUUID())'; }

# ---------------------------------------------------------------- preflight

if [ -z "${DOCKER_SOCKET:-}" ]; then
  host="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  case "$host" in
    unix://*) DOCKER_SOCKET="${host#unix://}" ;;
    *) DOCKER_SOCKET=/var/run/docker.sock ;;
  esac
fi
export DOCKER_SOCKET

server_version="$(docker version --format '{{.Server.Version}}')"
major="${server_version%%.*}"
if [ "$major" -lt 26 ]; then
  log "FAIL Docker ${server_version} < 26 (CVE-2024-29018: internal networks forward DNS); refusing to run"
  exit 1
fi
ok "Docker ${server_version} >= 26"

cleanup_ns

TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
ORG="$(uuid)"
A="$(uuid)"

# ---------------------------------------------------------------- the real sbx image

log "building ${IMAGE} from infra/sandbox/sbx/Dockerfile"
docker build -q --label "ocw.namespace=${NS}" -t "$IMAGE" -f infra/sandbox/sbx/Dockerfile infra/sandbox/sbx >/dev/null

# ---------------------------------------------------------------- sandboxd as a host process

OCW_SANDBOX_TOKEN="$TOKEN" OCW_SANDBOX_NAMESPACE="$NS" OCW_SANDBOXD_HOST=127.0.0.1 OCW_SANDBOXD_PORT=0 \
  OCW_SANDBOX_RUNTIME=auto OCW_SANDBOX_SBX_IMAGE="$IMAGE" \
  node --import tsx apps/sandboxd/src/main.ts >"$WORK/sandboxd.log" 2>&1 &
SANDBOXD_PID=$!

PORT=""
for _ in $(seq 1 100); do
  PORT="$(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
    for (const l of lines) { try { const j = JSON.parse(l); if (j.msg === "listening") { process.stdout.write(String(j.port)); break; } } catch {} }
  ' "$WORK/sandboxd.log" 2>/dev/null || true)"
  [ -n "$PORT" ] && break
  if ! kill -0 "$SANDBOXD_PID" 2>/dev/null; then
    log "FAIL sandboxd exited"
    exit 1
  fi
  sleep 0.2
done
[ -n "$PORT" ] || {
  log "FAIL sandboxd did not listen"
  exit 1
}
ok "sandboxd listening on 127.0.0.1:${PORT}"

# ---------------------------------------------------------------- info and the token

status="$(api GET /v1/info)"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" dockerOk)" = true ] && [ -n "$(jfield "$WORK/body.json" runtime)" ]; then
  RUNTIME="$(jfield "$WORK/body.json" runtime)"
  ok "GET /v1/info → 200, dockerOk, runtime ${RUNTIME}"
else
  fail "GET /v1/info → ${status} $(cat "$WORK/body.json")"
fi

status="$(api GET /v1/info "" "")"
[ "$status" = 401 ] && ok "GET /v1/info without the token → 401" || fail "no token → ${status}"

# ---------------------------------------------------------------- ensure bot A

status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$ORG" "$A")}")"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" state)" = running ]; then
  ok "ensure A → running"
else
  fail "ensure A → ${status} $(cat "$WORK/body.json")"
fi

running="$(docker ps -q --filter "label=ocw.sandbox=1" --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${A}")"
count="$(printf '%s\n' "$running" | grep -c . || true)"
CID_A="$(printf '%s\n' "$running" | head -n 1)"
if [ "$count" = 1 ] && [ "$(docker inspect --format '{{.Config.Image}}' "$CID_A")" = "$IMAGE" ]; then
  ok "exactly one running container for A, from ${IMAGE}"
else
  fail "containers for A: ${count}"
fi

# ---------------------------------------------------------------- exec as 10001 in /workspace

status="$(api POST /v1/sandboxes/exec "$(exec_json "$ORG" "$A" '["sh","-c","echo hi > note.txt && cat note.txt && id -u"]')")"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" status)" = exited ] &&
  [ "$(jfield "$WORK/body.json" exitCode)" = 0 ] && [ "$(jfield "$WORK/body.json" stdout)" = "$(printf 'hi\n10001\n')" ]; then
  ok "exec writes note.txt and runs as 10001"
else
  fail "exec → ${status} $(cat "$WORK/body.json")"
fi

# The smoke's own look into the same labelled container, not through sandboxd.
stat_line="$(docker exec "$CID_A" stat -c '%u %n' /workspace/note.txt 2>&1 || true)"
[ "$stat_line" = "10001 /workspace/note.txt" ] && ok "docker exec stat: ${stat_line}" || fail "docker exec stat: ${stat_line}"

# ---------------------------------------------------------------- yield, poll, kill, timeout, tails

t0=$(date +%s)
status="$(api POST /v1/sandboxes/exec "$(exec_json "$ORG" "$A" '["sleep","40"]' 60000 25000)")"
PID_SLEEP="$(jfield "$WORK/body.json" processId)"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" status)" = running ] && [ -n "$PID_SLEEP" ]; then
  ok "sleep 40 yields after the default 25 s with a process id"
else
  fail "sleep 40 → ${status} $(cat "$WORK/body.json")"
fi

status="$(api POST /v1/sandboxes/exec "$(exec_json "$ORG" "$A" '["sleep","300"]' 600000 500)")"
PID_KILL="$(jfield "$WORK/body.json" processId)"
status="$(api POST /v1/sandboxes/process "$(printf '{"target":%s,"processId":"%s","action":"kill"}' "$(target "$ORG" "$A")" "$PID_KILL")")"
code="$(jfield "$WORK/body.json" exitCode)"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" status)" = exited ] && [ -n "$code" ] && [ "$code" != 0 ]; then
  ok "process kill → exited ${code}"
else
  fail "process kill → ${status} $(cat "$WORK/body.json")"
fi

s0=$(node -e 'process.stdout.write(String(Date.now()))')
status="$(api POST /v1/sandboxes/exec "$(exec_json "$ORG" "$A" '["sleep","10"]' 2000 25000)")"
s1=$(node -e 'process.stdout.write(String(Date.now()))')
code="$(jfield "$WORK/body.json" exitCode)"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" status)" = exited ] && [ "$code" != 0 ] && [ $((s1 - s0)) -lt 3000 ]; then
  ok "timeoutMs 2000 on sleep 10 → exited ${code} in $((s1 - s0)) ms"
else
  fail "timeout → ${status} in $((s1 - s0)) ms $(cat "$WORK/body.json")"
fi

status="$(api POST /v1/sandboxes/exec "$(exec_json "$ORG" "$A" '["sh","-c","yes a | head -c 40000; echo END"]')")"
tail_ok="$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(Buffer.byteLength(j.stdout ?? "") === 16384 && /a\nEND\n$/.test(j.stdout ?? "")));
' "$WORK/body.json")"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" truncated)" = true ] && [ "$tail_ok" = true ]; then
  ok "output over 16 KiB keeps the last 16384 bytes, truncated"
else
  fail "tail → ${status} $(head -c 300 "$WORK/body.json")"
fi

# ---------------------------------------------------------------- the yielded sleep finishes

now=$(date +%s)
wait_s=$((t0 + 42 - now))
if [ "$wait_s" -gt 0 ]; then sleep "$wait_s"; fi
status="$(api POST /v1/sandboxes/process "$(printf '{"target":%s,"processId":"%s","action":"poll"}' "$(target "$ORG" "$A")" "$PID_SLEEP")")"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" status)" = exited ] && [ "$(jfield "$WORK/body.json" exitCode)" = 0 ]; then
  ok "process poll after 42 s → exited 0"
else
  fail "process poll → ${status} $(cat "$WORK/body.json")"
fi

if [ "$FAILURES" != 0 ]; then
  log "${FAILURES} check(s) failed"
  exit 1
fi
log "sandbox smoke: all checks passed (runtime ${RUNTIME:-unknown})"
