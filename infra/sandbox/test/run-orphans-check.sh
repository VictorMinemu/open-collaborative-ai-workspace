#!/usr/bin/env bash
# Real-Docker orphan check (07.8-28 Task 3; Pitfall 9, P-17; WINDOWS #260). A sandboxd that dies mid-command adopts its
# namespace's objects when it starts again, and nothing of a smoke namespace survives the label cleanup:
#
#   1. sandboxd (a host process) runs two sandboxes and one browser for one organization and a long command in one
#      of them; a package run's network and container are left as a sandboxd crash leaves them (#260);
#   2. sandboxd is killed with SIGKILL (kill -9): no shutdown hook runs, its containers keep running;
#   3. a new sandboxd starts: `reconciled` counts the adopted objects, the package run's leftovers are swept at boot,
#      `info` answers, `usage` reports both sandboxes and the browser as running, the long command's container still
#      carries its labels, and `killOrg` stops every one of them;
#   4. `infra/ci/smoke-reset.sh` removes every object of the smoke namespace and leaves an unlabelled decoy container
#      and a container of another namespace (`ocw-other-<pid>`) untouched. smoke-reset removes every `ocw-smoke-*`,
#      `ocw-e2e` and `ocw-proof-*` object of the daemon, so it runs only when no other run's objects of those
#      namespaces exist (a parallel smoke or e2e would lose its own); otherwise the step is reported SKIP with that
#      reason, and ORPHANS_RESET=force runs it anyway.
#
# Usage (repo root):  bash infra/sandbox/test/run-orphans-check.sh
#   DOCKER_SOCKET=<path>   the daemon socket (default: the current docker context's unix socket)
#
# Every object carries `ocw.namespace=ocw-smoke-orphans-<pid>` (the decoys are named, the other-namespace one carries
# `ocw-other-<pid>`) and is removed by that label or name before and after the run, with the `:smoke-<sha>` images.
# It never prunes and never touches any other object.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

NS="ocw-smoke-orphans-$$"
OTHER_NS="ocw-other-$$"
SHA="$(git rev-parse --short=12 HEAD)"
SBX_IMAGE="ocw-sandbox-sbx:smoke-${SHA}"
BRW_IMAGE="ocw-sandbox-brw:smoke-${SHA}"
EGRESS_IMAGE="ocw-sandbox-egress:smoke-${SHA}"
BASE="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"
DECOY="ocw-orphans-decoy-$$"
OTHER="ocw-orphans-other-$$"
WORK="$(mktemp -d)"
SANDBOXD_PID=""
FAILURES=0
MIB=1048576

log() { printf '%s\n' "$*" >&2; }
ok() { log "ok   $*"; }
fail() {
  log "FAIL $*"
  FAILURES=$((FAILURES + 1))
}

cleanup_ns() {
  local ids
  ids="$(docker ps -aq --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker rm -f -v $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker network rm $ids >/dev/null 2>&1 || true; fi
  ids="$(docker volume ls -q --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker volume rm -f $ids >/dev/null 2>&1 || true; fi
}

count_ns() {
  local n
  n="$(docker ps -aq --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')"
  n=$((n + $(docker network ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
  n=$((n + $(docker volume ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
  printf '%s' "$n"
}

on_exit() {
  local code=$?
  if [ -n "$SANDBOXD_PID" ]; then kill -9 "$SANDBOXD_PID" 2>/dev/null || true; fi
  local left attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    cleanup_ns
    left="$(count_ns)"
    [ "$left" = "0" ] && break
    sleep 1
  done
  docker rm -f "$DECOY" "$OTHER" >/dev/null 2>&1 || true
  docker image rm -f "$SBX_IMAGE" "$BRW_IMAGE" "$EGRESS_IMAGE" >/dev/null 2>&1 || true
  if [ "$left" != "0" ]; then
    log "FAIL ${left} object(s) labelled ocw.namespace=${NS} left after cleanup"
    code=1
  fi
  if [ "$code" != "0" ] && [ -f "$WORK/sandboxd.log" ]; then
    log "--- sandboxd log (ids, ops and statuses only) ---"
    tail -n 30 "$WORK/sandboxd.log" >&2 || true
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap on_exit EXIT

# ---------------------------------------------------------------- helpers

jfield() {
  node -e '
    const v = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")));
    process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$2"
}

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o "$WORK/body.json" -w '%{http_code}' -X "$method" --max-time 120 -H "authorization: Bearer ${TOKEN}")
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' --data "$body"); fi
  curl "${args[@]}" "http://127.0.0.1:${PORT}${path}"
}

uuid() { node -e 'process.stdout.write(require("crypto").randomUUID())'; }
target() { printf '{"orgId":"%s","agentId":"%s"}' "$ORG" "$1"; }
running_of() { docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || echo gone; }
log_count() { grep -c "\"msg\":\"$1\"" "$WORK/sandboxd.log" 2>/dev/null || true; }

start_sandboxd() {
  local from
  from="$(wc -l <"$WORK/sandboxd.log" | tr -d ' ')"
  OCW_SANDBOX_TOKEN="$TOKEN" OCW_SANDBOX_NAMESPACE="$NS" OCW_SANDBOXD_HOST=127.0.0.1 OCW_SANDBOXD_PORT=0 \
    OCW_SANDBOX_RUNTIME=auto OCW_SANDBOX_SBX_IMAGE="$SBX_IMAGE" OCW_SANDBOX_BRW_IMAGE="$BRW_IMAGE" \
    OCW_SANDBOX_EGRESS_IMAGE="$EGRESS_IMAGE" OCW_SANDBOX_BRW_SECCOMP="$ROOT/infra/sandbox/browser/seccomp.json" \
    OCW_SANDBOXD_SWEEP_MS=60000 \
    node --import tsx apps/sandboxd/src/main.ts >>"$WORK/sandboxd.log" 2>&1 &
  SANDBOXD_PID=$!
  PORT=""
  for _ in $(seq 1 150); do
    PORT="$(node -e '
      const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").slice(Number(process.argv[2]));
      for (const l of lines) { try { const j = JSON.parse(l); if (j.msg === "listening") { process.stdout.write(String(j.port)); break; } } catch {} }
    ' "$WORK/sandboxd.log" "$from" 2>/dev/null || true)"
    [ -n "$PORT" ] && break
    kill -0 "$SANDBOXD_PID" 2>/dev/null || {
      log "FAIL sandboxd exited"
      exit 1
    }
    sleep 0.2
  done
  [ -n "$PORT" ] || {
    log "FAIL sandboxd did not listen"
    exit 1
  }
  START_LINE="$from"
}

# A line of this boot's log (`msg`), as JSON, or empty.
boot_line() {
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").slice(Number(process.argv[2]));
    for (const l of lines) { try { const j = JSON.parse(l); if (j.msg === process.argv[3]) { process.stdout.write(JSON.stringify(j)); break; } } catch {} }
  ' "$WORK/sandboxd.log" "$START_LINE" "$1"
}

policy_json() {
  printf '{"orgId":"%s","sandboxEgress":"off","browserEgress":"off","allowHosts":[],"privateHosts":[],"limits":{"nanoCpus":1000000000,"memoryBytes":1073741824,"pids":256,"diskQuotaBytes":%s,"idleStopMs":900000},"browserLimits":{"nanoCpus":1000000000,"memoryBytes":2147483648,"pids":512,"diskQuotaBytes":%s,"idleStopMs":900000},"killed":false,"version":1}' \
    "$ORG" $((2048 * MIB)) $((2048 * MIB))
}

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
if [ "${server_version%%.*}" -lt 26 ]; then
  log "FAIL Docker ${server_version} < 26 (CVE-2024-29018); refusing to run"
  exit 1
fi
ok "Docker ${server_version} >= 26"
cleanup_ns

TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
ORG="$(uuid)"
A="$(uuid)"
B="$(uuid)"

log "building ${SBX_IMAGE}, ${BRW_IMAGE}, ${EGRESS_IMAGE}"
docker build -q --label "ocw.namespace=${NS}" -t "$SBX_IMAGE" -f infra/sandbox/sbx/Dockerfile infra/sandbox/sbx >/dev/null
docker build -q --label "ocw.namespace=${NS}" -t "$BRW_IMAGE" infra/sandbox/browser >/dev/null
docker build -q --label "ocw.namespace=${NS}" -t "$EGRESS_IMAGE" -f infra/sandbox/egress/Dockerfile . >/dev/null

# ---------------------------------------------------------------- 1. two sandboxes, one browser, a long command

: >"$WORK/sandboxd.log"
start_sandboxd
ok "sandboxd listening on 127.0.0.1:${PORT}"
status="$(api POST /v1/policy "$(policy_json)")"
[ "$status" = 200 ] && ok "policy → 200" || fail "policy → ${status} $(cat "$WORK/body.json")"
for bot in "$A" "$B"; do
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$bot")}")"
  [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" state)" = running ] && ok "ensure ${bot:0:8} → running" ||
    fail "ensure ${bot:0:8} → ${status} $(cat "$WORK/body.json")"
done
status="$(api POST /v1/browsers/ensure "{\"target\":$(target "$A")}")"
[ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" state)" = running ] && ok "browserEnsure A → running" ||
  fail "browserEnsure A → ${status} $(cat "$WORK/body.json")"

status="$(api POST /v1/sandboxes/exec "{\"target\":$(target "$A"),\"argv\":[\"sleep\",\"600\"],\"cwd\":\"\",\"timeoutMs\":600000,\"yieldMs\":1000}")"
if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" status)" = running ]; then
  ok "a long command runs in A (yielded with a process id)"
else
  fail "long exec → ${status} $(cat "$WORK/body.json")"
fi
CID_A="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${A}" --filter "label=ocw.kind=sbx")"
CID_B="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${B}" --filter "label=ocw.kind=sbx")"
BRW_A="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${A}" --filter "label=ocw.kind=brw")"
[ -n "$CID_A" ] && [ -n "$CID_B" ] && [ -n "$BRW_A" ] && ok "sbx A, sbx B and brw A are running containers" ||
  fail "containers: A=${CID_A} B=${CID_B} brw=${BRW_A}"
long_running() { docker exec "$CID_A" sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\000" " "' 2>/dev/null | grep -q 'sleep 600'; }
long_running && ok "the long command runs inside sbx A" ||
  fail "the long command is not running in sbx A"

# A package run as a crash mid-review leaves it (#260): its own network and its container, labelled like a run.
RUN="$(uuid)"
PNET="ocw-pnet-${NS}-${RUN:0:12}"
PRUN="ocw-prun-${NS}-${RUN:0:12}"
run_labels=(--label ocw.sandbox=1 --label "ocw.namespace=${NS}" --label "ocw.org=${ORG}" --label "ocw.agent=${A}" --label ocw.kind=installer)
docker network create --internal "${run_labels[@]}" "$PNET" >/dev/null
docker run -d --name "$PRUN" "${run_labels[@]}" --network "$PNET" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 10001:10001 --entrypoint sleep "$SBX_IMAGE" 600 >/dev/null
ok "a package run's network and container left as a crash leaves them"

# ---------------------------------------------------------------- 2. SIGKILL

kill -9 "$SANDBOXD_PID"
wait "$SANDBOXD_PID" 2>/dev/null || true
SANDBOXD_PID=""
ok "sandboxd killed with SIGKILL (kill -9)"
[ "$(running_of "$CID_A")" = true ] && [ "$(running_of "$CID_B")" = true ] && [ "$(running_of "$BRW_A")" = true ] &&
  ok "its containers keep running without it" || fail "containers after the kill: A=$(running_of "$CID_A") B=$(running_of "$CID_B") brw=$(running_of "$BRW_A")"

# ---------------------------------------------------------------- 3. restart: adopt, sweep, report, killOrg

start_sandboxd
ok "a new sandboxd listening on 127.0.0.1:${PORT}"
reconciled="$(boot_line reconciled)"
if [ -n "$reconciled" ] && node -e '
    const j = JSON.parse(process.argv[1]);
    process.exit(j.containers >= 4 && j.networks >= 1 && j.volumes >= 1 ? 0 : 1);
  ' "$reconciled"; then
  ok "reconciled: ${reconciled}"
else
  fail "reconcile line: ${reconciled:-none}"
fi
swept="$(boot_line "package runs swept")"
if [ -n "$swept" ] && node -e 'const j = JSON.parse(process.argv[1]); process.exit(j.containers === 1 && j.networks === 1 ? 0 : 1)' "$swept"; then
  ok "package run leftovers swept at boot: ${swept}"
else
  fail "package run sweep: ${swept:-none}"
fi
docker network inspect "$PNET" >/dev/null 2>&1 && fail "the run's network ${PNET} is still there" || ok "the run's network is gone"
docker inspect "$PRUN" >/dev/null 2>&1 && fail "the run's container is still there" || ok "the run's container is gone"

status="$(api GET /v1/info)"
[ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" dockerOk)" = true ] && ok "info → 200 after the restart" ||
  fail "info → ${status}"
status="$(api POST /v1/policy "$(policy_json)")"
[ "$status" = 200 ] || fail "policy again → ${status}"
status="$(api POST /v1/usage "{\"orgId\":\"${ORG}\"}")"
if [ "$status" = 200 ] && node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const has = (agent, kind) => (j.items ?? []).some((i) => i.agentId === agent && i.kind === kind && i.state === "running");
    process.exit(has(process.argv[2], "sbx") && has(process.argv[3], "sbx") && has(process.argv[2], "brw") ? 0 : 1);
  ' "$WORK/body.json" "$A" "$B"; then
  ok "usage reports sbx A, sbx B and brw A running (adopted)"
else
  fail "usage → ${status} $(cat "$WORK/body.json")"
fi
labels="$(docker inspect --format '{{index .Config.Labels "ocw.sandbox"}} {{index .Config.Labels "ocw.namespace"}} {{index .Config.Labels "ocw.agent"}}' "$CID_A")"
[ "$labels" = "1 ${NS} ${A}" ] && ok "the long command's container keeps its labels" || fail "labels of sbx A: ${labels}"
long_running && ok "the long command still runs" ||
  fail "the long command is gone before killOrg"

status="$(api POST /v1/orgs/kill "{\"orgId\":\"${ORG}\"}")"
[ "$status" = 200 ] || fail "killOrg → ${status} $(cat "$WORK/body.json")"
for _ in $(seq 1 60); do
  [ "$(running_of "$CID_A")" != true ] && [ "$(running_of "$CID_B")" != true ] && [ "$(running_of "$BRW_A")" != true ] && break
  sleep 0.5
done
[ "$(running_of "$CID_A")" != true ] && [ "$(running_of "$CID_B")" != true ] && [ "$(running_of "$BRW_A")" != true ] &&
  ok "killOrg stops sbx A (and its long command), sbx B and brw A" ||
  fail "after killOrg: A=$(running_of "$CID_A") B=$(running_of "$CID_B") brw=$(running_of "$BRW_A")"
kill "$SANDBOXD_PID" 2>/dev/null || true
wait "$SANDBOXD_PID" 2>/dev/null || true
SANDBOXD_PID=""

# ---------------------------------------------------------------- 4. smoke-reset removes this namespace, never others

docker run -d --name "$DECOY" --network none --entrypoint sleep "$BASE" 600 >/dev/null
docker run -d --name "$OTHER" --label "ocw.namespace=${OTHER_NS}" --label ocw.sandbox=1 --network none \
  --entrypoint sleep "$BASE" 600 >/dev/null
# Namespaces smoke-reset would remove that are not this run's (a function: macOS bash 3.2 cannot parse a `case` inside
# a command substitution).
reset_targets() {
  local ns
  {
    docker ps -a --filter label=ocw.namespace --format '{{.Label "ocw.namespace"}}'
    docker network ls --filter label=ocw.namespace --format '{{.Label "ocw.namespace"}}'
    docker volume ls --filter label=ocw.namespace --format '{{.Label "ocw.namespace"}}'
  } | sort -u | while read -r ns; do
    [ "$ns" = "$NS" ] && continue
    case "$ns" in
      ocw-smoke-* | ocw-e2e | ocw-proof-*) echo "$ns" ;;
    esac
  done
}
others="$(reset_targets)"
if [ -n "$others" ] && [ "${ORPHANS_RESET:-}" != force ]; then
  log "SKIP smoke-reset: other runs' objects exist (namespaces: $(echo "$others" | tr '\n' ' ')); smoke-reset would remove them too. Label cleanup of ${NS} instead"
  cleanup_ns
else
  [ "$(count_ns)" -gt 0 ] || fail "nothing of ${NS} left to remove before smoke-reset"
  sh infra/ci/smoke-reset.sh >/dev/null
  ok "infra/ci/smoke-reset.sh ran"
fi
left="$(count_ns)"
[ "$left" = "0" ] && ok "no object labelled ocw.namespace=${NS} left" || fail "${left} object(s) of ${NS} left"
[ "$(running_of "$DECOY")" = true ] && ok "the unlabelled decoy is untouched" || fail "the decoy is $(running_of "$DECOY")"
[ "$(running_of "$OTHER")" = true ] && ok "the ${OTHER_NS} container is untouched" || fail "the other namespace's container is $(running_of "$OTHER")"

if [ "$FAILURES" -gt 0 ]; then
  log "orphans check: ${FAILURES} failure(s)"
  exit 1
fi
log "orphans check: all checks passed"
