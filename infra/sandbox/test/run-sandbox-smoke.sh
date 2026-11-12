#!/usr/bin/env bash
# Real-Docker sandbox smoke (07.8-04; D-01, D-02, D-11, SBX-01, SBX-02). Builds the real `sbx` image from
# infra/sandbox/sbx/Dockerfile (no stand-in), runs sandboxd as a host process on 127.0.0.1 and a random port, and
# proves through its HTTP API that a bot's argv runs as uid 10001 in /workspace of its own hardened container. The
# smoke also `docker exec`s into that same labelled container on its own to check the file and its owner.
#
# 07.8-09 adds the files section: people's and bots' file operations through sandboxd (as 10001, realpath-confined,
# through the network-none `files` helper when the sandbox is stopped or killed), the soft quota (`quota`) and the idle
# stop (`idle`) and the event feed the API long-polls (`events`: boot id, long poll, crash detection, and no path,
# argv or content in any event). sandboxd runs with a 3 s sweep here (OCW_SANDBOXD_SWEEP_MS).
#
# The 07.8 policy fix adds the restart section: sandboxd has no default policy, so every section pushes its
# organization's policy first (as the API does); then sandboxd is restarted mid-run (a new boot id, every policy
# forgotten) and a killed organization stays killed: `policy_missing` until the policy is pushed again, `killed` after,
# its container never started, while a live organization runs again after one push.
#
# 07.17.1.1.1 (D-03 … D-08, PD-18) adds the docs section: the document toolkit through the bot's real path, sandboxd's
# API only (people's file write, exec as 10001 with background polling, never `docker exec`). It writes
# make_fixtures.py into a bot's workspace, generates the fixtures in the bot's shell and reads every common type with
# `ocw-extract` (a scanned PDF through OCR, Office files, mail, an archive listing), resumes a batch, and checks that
# every answer stays under the 16 KiB tail. There is no egress proxy here, so the shell has no way out: the section is
# offline by construction. It runs on runc (every section) and under gVisor (`--only core,docs`), capped at 900 s.
# The macro rule (D-08, PD-11): neither `ocw-extract` nor the bot's own `soffice --convert-to` runs a document's load
# macro; on runc a positive control opens the same document in a test-only image without `ocw.xcd` with a low-security
# profile (the macro writes its marker there, or the smoke says the control was not achieved) and the same open in the
# real image (never a marker). The drift section (D-10, PD-10) rebuilds the image tag on real Docker: a stopped shell
# is re-created on the new image with its workspace kept, a running one is left alone until it stops or restarts. It
# runs last because it moves the image tag.
#
# Usage (repo root):  bash infra/sandbox/test/run-sandbox-smoke.sh [--only core,files,quota,idle,events,restart,docs,drift]
#   --only <list>          run only these sections (comma separated): core, files, quota, idle, events, restart,
#                          docs, drift; default all
#   DOCKER_SOCKET=<path>   the daemon socket (default: the current docker context's unix socket)
#
# Every Docker object it creates carries `ocw.namespace=ocw-smoke-<pid>` and is removed by that label before the run
# and on exit; the image tag is `ocw-sandbox-sbx:smoke-<sha>` and is removed on exit, with every image the docs and
# drift sections build (by tag and by ID, all labelled the same). It never prunes.
set -euo pipefail

ONLY=all
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only)
      ONLY="${2:-}"
      shift 2
      ;;
    --only=*)
      ONLY="${1#--only=}"
      shift
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
SECTIONS="core files quota idle events restart docs drift"
for s in ${ONLY//,/ }; do
  if [ "$s" != all ] && [[ " $SECTIONS " != *" $s "* ]]; then
    printf 'unknown section: %s (known: %s)\n' "$s" "$SECTIONS" >&2
    exit 2
  fi
done
want() { [ "$ONLY" = all ] || [[ ",$ONLY," == *",$1,"* ]]; }

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

# The label namespace (CI sets OCW_SMOKE_NS_PREFIX to its slot's, infra/ci/slot-reset.sh; default ocw-smoke).
NS="${OCW_SMOKE_NS_PREFIX:-ocw-smoke}-$$"
SHA="$(git rev-parse --short HEAD)"
IMAGE="ocw-sandbox-sbx:smoke-${SHA}"
# The docs section's positive-control image (runc only) and every image ID the run built (on_exit removes them by ID:
# the drift section moves the $IMAGE tag, so the original smoke image is untagged by then).
MACRO_IMAGE="${IMAGE}-macro-control"
BUILT_IMAGES=""
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
  # Under gVisor a removed container can hold its volumes and network for a moment after `rm -f` returns (07.8-24, CI
  # gVisor job): retry the label cleanup briefly before counting what is left.
  local left attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    cleanup_ns
    left="$(docker ps -aq --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')"
    left=$((left + $(docker volume ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
    left=$((left + $(docker network ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
    [ "$left" = "0" ] && break
    sleep 1
  done
  docker image rm -f "$IMAGE" "$MACRO_IMAGE" >/dev/null 2>&1 || true
  local id
  for id in $BUILT_IMAGES; do docker image rm -f "$id" >/dev/null 2>&1 || true; done
  left=$((left + $(docker image ls -q --filter "label=ocw.namespace=${NS}" | sort -u | wc -l | tr -d ' ')))
  if [ "$left" != "0" ]; then
    log "FAIL ${left} object(s) labelled ocw.namespace=${NS} left after cleanup (containers, volumes, networks, images)"
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

# run_in <org> <agent> <argv json> [timeoutMs] → status; body in $WORK/body.json
run_in() { api POST /v1/sandboxes/exec "$(exec_json "$1" "$2" "$3" "${4:-30000}" 25000)"; }
exited_with() { # exited_with <expected: 0|nonzero>
  [ "$(jfield "$WORK/body.json" status)" = exited ] || return 1
  local code
  code="$(jfield "$WORK/body.json" exitCode)"
  if [ "$1" = 0 ]; then [ "$code" = 0 ]; else [ -n "$code" ] && [ "$code" != 0 ]; fi
}
running_of() { docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || echo gone; }

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
BUILT_IMAGES="$(docker image inspect --format '{{.Id}}' "$IMAGE")"

# ---------------------------------------------------------------- D-14: a required runsc that is missing refuses to start
if want core; then

  if docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
    log "skip runsc-required refusal (this daemon has runsc)"
  else
    set +e
    OCW_SANDBOX_TOKEN="$TOKEN" OCW_SANDBOX_NAMESPACE="$NS" OCW_SANDBOXD_HOST=127.0.0.1 OCW_SANDBOXD_PORT=0 \
      OCW_SANDBOX_RUNTIME=runsc OCW_SANDBOX_SBX_IMAGE="$IMAGE" \
      node --import tsx apps/sandboxd/src/main.ts >"$WORK/refusal.log" 2>&1 &
    refusal_pid=$!
    for _ in $(seq 1 100); do
      kill -0 "$refusal_pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$refusal_pid" 2>/dev/null; then
      kill "$refusal_pid" 2>/dev/null
      refusal_code=running
    else
      wait "$refusal_pid"
      refusal_code=$?
    fi
    set -e
    if [ "$refusal_code" = 1 ] && grep -q '"refusing to start"' "$WORK/refusal.log" &&
      ! grep -q '"listening"' "$WORK/refusal.log" &&
      [ -z "$(docker ps -aq --filter "label=ocw.namespace=${NS}" --filter "label=ocw.sandbox=1")" ]; then
      ok "OCW_SANDBOX_RUNTIME=runsc without runsc → sandboxd refuses to start (exit 1), nothing created"
    else
      fail "runsc-required start → ${refusal_code}: $(tail -n 3 "$WORK/refusal.log")"
    fi
  fi
fi

# ---------------------------------------------------------------- sandboxd as a host process

# start_sandboxd: one sandboxd process (its log appended to $WORK/sandboxd.log); sets SANDBOXD_PID and PORT.
start_sandboxd() {
  local from
  from="$(wc -l <"$WORK/sandboxd.log" 2>/dev/null | tr -d ' ' || echo 0)"
  OCW_SANDBOX_TOKEN="$TOKEN" OCW_SANDBOX_NAMESPACE="$NS" OCW_SANDBOXD_HOST=127.0.0.1 OCW_SANDBOXD_PORT=0 \
    OCW_SANDBOX_RUNTIME=auto OCW_SANDBOX_SBX_IMAGE="$IMAGE" OCW_SANDBOXD_SWEEP_MS=3000 \
    node --import tsx apps/sandboxd/src/main.ts >>"$WORK/sandboxd.log" 2>&1 &
  SANDBOXD_PID=$!
  PORT=""
  for _ in $(seq 1 100); do
    PORT="$(node -e '
      const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").slice(Number(process.argv[2]));
      for (const l of lines) { try { const j = JSON.parse(l); if (j.msg === "listening") { process.stdout.write(String(j.port)); break; } } catch {} }
    ' "$WORK/sandboxd.log" "${from:-0}" 2>/dev/null || true)"
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
}

# stop_sandboxd: ends the sandboxd process (its containers, volumes and networks stay, as on a real restart).
stop_sandboxd() {
  kill "$SANDBOXD_PID" 2>/dev/null || true
  wait "$SANDBOXD_PID" 2>/dev/null || true
  SANDBOXD_PID=""
}

: >"$WORK/sandboxd.log"
start_sandboxd
ok "sandboxd listening on 127.0.0.1:${PORT}"

MIB=1048576

# policy_json <org> <diskQuotaBytes> <idleStopMs> [killed] [version]: the organization's policy as the API pushes it
# (11). sandboxd has no default: nothing starts for an organization until its policy is pushed.
policy_json() {
  printf '{"orgId":"%s","sandboxEgress":"off","browserEgress":"off","allowHosts":[],"privateHosts":[],"limits":{"nanoCpus":1000000000,"memoryBytes":1073741824,"pids":256,"diskQuotaBytes":%s,"idleStopMs":%s},"browserLimits":{"nanoCpus":1000000000,"memoryBytes":2147483648,"pids":512,"diskQuotaBytes":%s,"idleStopMs":300000},"killed":%s,"version":%s}' \
    "$1" "$2" "$3" "$2" "${4:-false}" "${5:-1}"
}

# push_policy <org> [killed] [version]: a 2 GiB quota and 15 minutes idle → the HTTP status.
push_policy() { api POST /v1/policy "$(policy_json "$1" $((2048 * MIB)) 900000 "${2:-false}" "${3:-1}")"; }

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

# ================================================================ section: core (07.8-04)

section_core() {
  # ---------------------------------------------------------------- ensure bot A

  status="$(push_policy "$ORG")"
  [ "$status" = 200 ] && ok "policy for the core org → 200" || fail "core: policy → ${status} $(cat "$WORK/body.json")"

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

  # timeoutMs is the command's own budget: ocw-run runs argv under `timeout -s KILL`, counted from when it starts in the
  # container. Docker answers the exec start before runc has spawned it, so on a loaded daemon the start itself can lag
  # by seconds (CI p202: answered in 6492 ms, exit 137, inside sandboxd's 5 s backstop). The check times the command,
  # not the request: its first line prints its start (ms, the same kernel clock as the daemon's), and Docker's
  # `exec_die` for that exit code is when it was killed. It may live at most its 2 s plus 1 s for ocw-run and `date`.
  s0=$(node -e 'process.stdout.write(String(Date.now()))')
  docker events --since "$((s0 / 1000))" --filter "container=${CID_A}" --filter event=exec_die \
    --format '{{json .}}' >"$WORK/exec-die.jsonl" 2>/dev/null &
  EVENTS_PID=$!
  status="$(api POST /v1/sandboxes/exec "$(exec_json "$ORG" "$A" '["sh","-c","date +%s%3N; exec sleep 10"]' 2000 25000)")"
  s1=$(node -e 'process.stdout.write(String(Date.now()))')
  code="$(jfield "$WORK/body.json" exitCode)"
  began="$(jfield "$WORK/body.json" stdout | tr -d '\n')"
  died=""
  for _ in $(seq 1 50); do
    died="$(node -e '
      const [file, code, began] = process.argv.slice(1);
      const lines = require("fs").readFileSync(file, "utf8").split("\n").filter(Boolean);
      const hit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) =>
        e && e.Actor?.Attributes?.exitCode === code && Number(e.timeNano) / 1e6 >= Number(began));
      process.stdout.write(hit ? String(Math.round(Number(hit.timeNano) / 1e6)) : "");
    ' "$WORK/exec-die.jsonl" "$code" "${began:-0}")"
    [ -n "$died" ] && break
    sleep 0.1
  done
  kill "$EVENTS_PID" 2>/dev/null || true
  wait "$EVENTS_PID" 2>/dev/null || true
  lived=$((${died:-0} - ${began:-0}))
  if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" status)" = exited ] && [ "$code" != 0 ] &&
    [[ "$began" =~ ^[0-9]{13}$ ]] && [ -n "$died" ] && [ "$lived" -ge 0 ] && [ "$lived" -lt 3000 ]; then
    ok "timeoutMs 2000 on sleep 10 → killed ${lived} ms after it started, exited ${code}; answered in $((s1 - s0)) ms"
  else
    fail "timeout → ${status}, lived ${lived} ms (exec_die ${died:-none}), answered in $((s1 - s0)) ms $(cat "$WORK/body.json")"
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

  # ---------------------------------------------------------------- hardening seen from inside A (D-01, D-11)


  run_in "$ORG" "$A" '["sh","-c","grep -E \"^(CapEff|NoNewPrivs):\" /proc/self/status"]' >/dev/null
  caps="$(jfield "$WORK/body.json" stdout | tr -s '\t ' ' ')"
  if printf '%s' "$caps" | grep -q '^CapEff: 0000000000000000$' && printf '%s' "$caps" | grep -q '^NoNewPrivs: 1$'; then
    ok "A: CapEff 0000000000000000, NoNewPrivs 1"
  else
    fail "A capabilities: ${caps}"
  fi

  for path in /etc/x /usr/x; do
    run_in "$ORG" "$A" "[\"sh\",\"-c\",\"echo x > ${path}\"]" >/dev/null
    exited_with nonzero && ok "A: writing ${path} fails (read-only root)" || fail "A: write ${path} $(cat "$WORK/body.json")"
  done

  run_in "$ORG" "$A" '["sh","-c","printf \"#!/bin/sh\\necho ran\\n\" > /tmp/x.sh && chmod +x /tmp/x.sh && /tmp/x.sh"]' >/dev/null
  if exited_with nonzero && ! jfield "$WORK/body.json" stdout | grep -q ran; then
    ok "A: a script copied to /tmp does not execute (noexec)"
  else
    fail "A: /tmp exec $(cat "$WORK/body.json")"
  fi

  run_in "$ORG" "$A" '["env"]' >/dev/null
  envs="$(jfield "$WORK/body.json" stdout)"
  if exited_with 0 && ! printf '%s' "$envs" | grep -q 'OCW_' && ! printf '%s' "$envs" | grep -qF "$TOKEN"; then
    ok "A: env has no OCW_ variable and no token value"
  else
    fail "A: env leaks ($(printf '%s' "$envs" | grep -c 'OCW_' || true) OCW_ lines)"
  fi

  if [ "${RUNTIME:-}" = gvisor ]; then
    # gVisor counts neither threads against pids.max, nor survives hundreds of real processes on a loaded runner
    # (pipelines 63-68: yields past 25 s, WaitPID EOF). The spec is the same on every runtime (spec.ts), so here the
    # limit is checked on the container; the runc smoke proves it by behaviour.
    cid_a="$(docker ps -q --filter "label=ocw.sandbox=1" --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${A}" | head -n 1)"
    pids_limit="$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$cid_a" 2>/dev/null || true)"
    if [ -n "$pids_limit" ] && [ "$pids_limit" -gt 0 ] && [ "$pids_limit" -le 4096 ]; then
      ok "A: pids limit ${pids_limit} set on the gVisor sandbox (enforcement proven by the runc smoke)"
    else
      fail "A: no pids limit on the gVisor sandbox (${pids_limit:-none})"
    fi
  else
    # On runc, threads count against pids.max like processes and are far lighter than 300 processes.
    run_in "$ORG" "$A" '["python3","-c","import threading\nev=threading.Event();ts=[];fail=0\nfor i in range(300):\n  try:\n    t=threading.Thread(target=ev.wait,args=(30,));t.start();ts.append(t)\n  except RuntimeError: fail+=1\nprint(len(ts), fail)\nev.set()\nfor t in ts: t.join()"]' 120000 >/dev/null
    # On a loaded runner the run can outlast the 25 s yield: poll the process until it exits.
    pids_proc="$(jfield "$WORK/body.json" processId)"
    for _ in $(seq 1 120); do
      [ "$(jfield "$WORK/body.json" status)" = running ] || break
      sleep 1
      api POST /v1/sandboxes/process "$(printf '{"target":%s,"processId":"%s","action":"poll"}' "$(target "$ORG" "$A")" "$pids_proc")" >/dev/null
    done
    pids_line="$(jfield "$WORK/body.json" stdout | tr -d '\n')"
    pids_failed="${pids_line##* }"
    if exited_with 0 && [ -n "$pids_failed" ] && [ "$pids_failed" -gt 0 ]; then
      ok "A: 300 threads hit the pids limit (started/refused: ${pids_line})"
    else
      fail "A: pids limit not hit: ${pids_line} $(head -c 300 "$WORK/body.json")"
    fi
  fi

  run_in "$ORG" "$A" '["getent","hosts","example.com"]' >/dev/null
  exited_with nonzero && ok "A: getent hosts example.com fails (no DNS out)" || fail "A: DNS resolved $(cat "$WORK/body.json")"

  run_in "$ORG" "$A" '["bash","-c","exec 3<>/dev/tcp/1.1.1.1/443"]' 8000 >/dev/null
  exited_with nonzero && ok "A: connect to 1.1.1.1:443 fails (no route out)" || fail "A: route out $(cat "$WORK/body.json")"

  # ---------------------------------------------------------------- bot B is isolated from A (E3, E4)

  B="$(uuid)"
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$ORG" "$B")}")"
  [ "$status" = 200 ] && ok "ensure B → running" || fail "ensure B → ${status} $(cat "$WORK/body.json")"
  CID_B="$(docker ps -q --filter "label=ocw.sandbox=1" --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${B}" | head -n 1)"

  run_in "$ORG" "$B" '["test","-e","/workspace/note.txt"]' >/dev/null
  exited_with nonzero && ok "B: /workspace/note.txt of A does not exist" || fail "B sees A's file $(cat "$WORK/body.json")"

  A_IP="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CID_A")"
  api POST /v1/sandboxes/exec "$(exec_json "$ORG" "$A" '["python3","-m","http.server","8080","--bind","0.0.0.0"]' 300000 1500)" >/dev/null
  PID_LISTEN="$(jfield "$WORK/body.json" processId)"
  sleep 1
  run_in "$ORG" "$A" "[\"bash\",\"-c\",\"exec 3<>/dev/tcp/${A_IP}/8080\"]" 8000 >/dev/null
  exited_with 0 && ok "control: A reaches its own listener at ${A_IP}:8080" || fail "control: A to itself $(cat "$WORK/body.json")"
  run_in "$ORG" "$B" "[\"bash\",\"-c\",\"exec 3<>/dev/tcp/${A_IP}/8080\"]" 8000 >/dev/null
  exited_with nonzero && ok "B: connect to A's container IP fails" || fail "B reached A $(cat "$WORK/body.json")"
  api POST /v1/sandboxes/process "$(printf '{"target":%s,"processId":"%s","action":"kill"}' "$(target "$ORG" "$A")" "$PID_LISTEN")" >/dev/null

  # ---------------------------------------------------------------- objects sandboxd did not create are refused

  C="$(uuid)"
  C_NAME="$(node -e 'process.stdout.write("ocw-sbx-" + process.argv[1] + "-" + require("crypto").createHash("sha256").update(process.argv[2]).digest("hex").slice(0, 12))' "$NS" "$C")"
  docker create -q --name "$C_NAME" --label "ocw.namespace=${NS}" "$IMAGE" sleep 60 >/dev/null
  docker start "$C_NAME" >/dev/null
  for path in /v1/sandboxes/ensure /v1/sandboxes/exec; do
    if [ "$path" = /v1/sandboxes/ensure ]; then body="{\"target\":$(target "$ORG" "$C")}"; else body="$(exec_json "$ORG" "$C" '["id"]')"; fi
    status="$(api POST "$path" "$body")"
    if [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = label_mismatch ]; then
      ok "unlabelled container named ${C_NAME%-*}-… refused by ${path##*/} (409 label_mismatch)"
    else
      fail "unlabelled container via ${path##*/} → ${status} $(cat "$WORK/body.json")"
    fi
  done

  D="$(uuid)"
  D_NAME="$(node -e 'process.stdout.write("ocw-sbx-" + process.argv[1] + "-" + require("crypto").createHash("sha256").update(process.argv[2]).digest("hex").slice(0, 12))' "$NS" "$D")"
  docker create -q --name "$D_NAME" --label "ocw.namespace=${NS}" --label ocw.sandbox=1 --label "ocw.org=$(uuid)" \
    --label "ocw.agent=${D}" --label ocw.kind=sbx "$IMAGE" sleep 60 >/dev/null
  docker start "$D_NAME" >/dev/null
  status="$(api POST /v1/sandboxes/exec "$(exec_json "$ORG" "$D" '["id"]')")"
  [ "$status" = 409 ] && ok "a container labelled for another org is refused for exec (409)" || fail "other-org container → ${status}"

  # ---------------------------------------------------------------- exec latency (recorded in the SUMMARY)

  lat="$(node -e '
    const [port, token, body] = process.argv.slice(1);
    (async () => {
      const ms = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const r = await fetch(`http://127.0.0.1:${port}/v1/sandboxes/exec`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
        await r.text();
        ms.push(Math.round(performance.now() - t));
      }
      ms.sort((a, b) => a - b);
      process.stdout.write(`median ${ms[2]} ms (min ${ms[0]}, max ${ms[4]})`);
    })();
  ' "$PORT" "$TOKEN" "$(exec_json "$ORG" "$A" '["true"]')")"
  ok "exec latency of [\"true\"] through sandboxd: ${lat}"

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

  # ---------------------------------------------------------------- kill, killOrg, purge act by label (D-02)


  status="$(api POST /v1/sandboxes/kill "{\"target\":$(target "$ORG" "$A")}")"
  if [ "$status" = 200 ] && [ "$(running_of "$CID_A")" = false ] && [ "$(running_of "$CID_B")" = true ]; then
    ok "kill A → A stopped while B runs"
  else
    fail "kill A → ${status} A=$(running_of "$CID_A") B=$(running_of "$CID_B")"
  fi

  status="$(api POST /v1/orgs/kill "{\"orgId\":\"${ORG}\"}")"
  if [ "$status" = 200 ] && [ "$(running_of "$CID_A")" = false ] && [ "$(running_of "$CID_B")" = false ] &&
    [ "$(running_of "$D_NAME")" = true ]; then
    ok "killOrg → both bots stopped (another org's container untouched)"
  else
    fail "killOrg → ${status} A=$(running_of "$CID_A") B=$(running_of "$CID_B") other=$(running_of "$D_NAME")"
  fi

  # B's objects right before the purge: at least its shell, workspace and packages volumes and network (07.8-17), plus
  # the files helper when a sweep's quota measurement of the stopped bot created one. A measurement already in flight
  # can still create that helper after this count (purge then removes it too), so one more is accepted, and only
  # when no helper was counted (its name is fixed: there is at most one).
  b_objects() {
    echo $(($(docker ps -aq --filter "label=ocw.agent=${B}" | wc -l) + $(docker volume ls -q --filter "label=ocw.agent=${B}" | wc -l) + $(docker network ls -q --filter "label=ocw.agent=${B}" | wc -l)))
  }
  before_b="$(b_objects)"
  helper_b="$(docker ps -aq --filter "label=ocw.agent=${B}" --filter "label=ocw.kind=files" | wc -l | tr -d ' ')"
  status="$(api POST /v1/sandboxes/purge "{\"target\":$(target "$ORG" "$B")}")"
  removed_b="$(jfield "$WORK/body.json" removed)"
  left_b="$(b_objects)"
  if [ "$status" = 200 ] && [ "$before_b" -ge 4 ] && [ "$left_b" = 0 ] &&
    { [ "$removed_b" = "$before_b" ] || { [ "$helper_b" = 0 ] && [ "$removed_b" = "$((before_b + 1))" ]; }; } &&
    [ "$(running_of "$CID_A")" = false ]; then
    ok "purge B removes its container, workspace and packages volumes and network (${removed_b} of ${before_b} counted before; A's objects stay)"
  else
    fail "purge B → ${status} $(cat "$WORK/body.json") of ${before_b} counted before (files helper ${helper_b}), ${left_b} object(s) left"
    # Name what stayed so a failure is diagnosable (it once was a files helper a measurement created mid-purge).
    docker ps -a --filter "label=ocw.agent=${B}" --format '     left container {{.Names}} kind={{.Label "ocw.kind"}} {{.Status}}' || true
    docker volume ls --filter "label=ocw.agent=${B}" --format '     left volume {{.Name}}' || true
    for n in $(docker network ls -q --filter "label=ocw.agent=${B}"); do
      docker network inspect -f '     left network {{.Name}} endpoints: {{range .Containers}}{{.Name}} {{end}}' "$n" || true
    done
  fi
}

# ================================================================ section: files (07.8-09 Task 1; D-01, D-04, D-09)

# api_file <method> <path> <json file> → the HTTP status; a large body (an upload) goes from a file, not argv.
api_file() {
  curl -sS -o "$WORK/body.json" -w '%{http_code}' -X "$1" --max-time 180 -H "authorization: Bearer ${TOKEN}" \
    -H 'content-type: application/json' --data-binary "@$3" "http://127.0.0.1:${PORT}$2"
}

# upload_json <org> <agent> <path> <bytes file> <overwrite> > json: the base64 upload body.
upload_json() {
  node -e '
    const [org, agent, path, file, overwrite] = process.argv.slice(1);
    const data = require("fs").readFileSync(file).toString("base64");
    process.stdout.write(JSON.stringify({ target: { orgId: org, agentId: agent }, path, data, overwrite: overwrite === "true" }));
  ' "$1" "$2" "$3" "$4" "$5"
}

# path_json <org> <agent> <path> [extra json fields]
path_json() { printf '{"target":%s,"path":"%s"%s}' "$(target "$1" "$2")" "$3" "${4:+,$4}"; }

sha_of() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }

section_files() {
  FO="$(uuid)"
  FA="$(uuid)"
  status="$(push_policy "$FO")"
  [ "$status" = 200 ] || fail "files: policy → ${status} $(cat "$WORK/body.json")"
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$FO" "$FA")}")"
  [ "$status" = 200 ] && ok "files: ensure F → running" || fail "files: ensure F → ${status} $(cat "$WORK/body.json")"
  CID_F="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${FA}" --filter "label=ocw.kind=sbx")"

  # A 2 MB upload (base64 JSON over 1 MiB) streams into the helper's stdin as 10001.
  head -c 2097152 /dev/urandom >"$WORK/q3.csv"
  upload_json "$FO" "$FA" reports/q3.csv "$WORK/q3.csv" false >"$WORK/upload.json"
  status="$(api_file POST /v1/files/upload "$WORK/upload.json")"
  if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" size)" = 2097152 ]; then
    ok "files: upload 2 MB to reports/q3.csv → 200, size 2097152"
  else
    fail "files: upload → ${status} $(head -c 300 "$WORK/body.json")"
  fi

  status="$(api POST /v1/files/list "$(path_json "$FO" "$FA" reports)")"
  listed="$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write((j.entries ?? []).map((e) => `${e.path}:${e.kind}:${e.size}`).join(","));
  ' "$WORK/body.json")"
  [ "$status" = 200 ] && [ "$listed" = "reports/q3.csv:file:2097152" ] &&
    ok "files: list reports → q3.csv with its size" || fail "files: list → ${status} ${listed}"

  status="$(api POST /v1/files/stat "$(path_json "$FO" "$FA" reports/q3.csv)")"
  [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" kind)" = file ] && ok "files: stat q3.csv → file" ||
    fail "files: stat → ${status} $(cat "$WORK/body.json")"
  owner="$(docker exec "$CID_F" stat -c '%u:%g' /workspace/reports/q3.csv /workspace/reports 2>&1 | tr '\n' ' ')"
  [ "$owner" = "10001:10001 10001:10001 " ] && ok "files: docker exec stat → q3.csv and reports/ owned by 10001" ||
    fail "files: owner ${owner}"

  status="$(api POST /v1/files/download "$(path_json "$FO" "$FA" reports/q3.csv)")"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    require("fs").writeFileSync(process.argv[2], Buffer.from(j.data ?? "", "base64"));
  ' "$WORK/body.json" "$WORK/q3.down"
  if [ "$status" = 200 ] && [ "$(sha_of "$WORK/q3.down")" = "$(sha_of "$WORK/q3.csv")" ] &&
    [ "$(jfield "$WORK/body.json" name)" = q3.csv ]; then
    ok "files: download → the same bytes (sha256 equal)"
  else
    fail "files: download → ${status}"
  fi

  status="$(api POST /v1/files/write "$(path_json "$FO" "$FA" notes/today.txt '"content":"héllo\n","encoding":"utf8","mode":"create"')")"
  [ "$status" = 200 ] || fail "files: write → ${status} $(cat "$WORK/body.json")"
  status="$(api POST /v1/files/read "$(path_json "$FO" "$FA" notes/today.txt)")"
  if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" encoding)" = utf8 ] &&
    [ "$(jfield "$WORK/body.json" content)" = "$(printf 'héllo\n')" ]; then
    ok "files: write then read a text file → utf8"
  else
    fail "files: read → ${status} $(cat "$WORK/body.json")"
  fi
  status="$(api POST /v1/files/write "$(path_json "$FO" "$FA" notes/today.txt '"content":"x","encoding":"utf8","mode":"create"')")"
  [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = exists ] &&
    ok "files: write create on an existing file → 409 exists" || fail "files: create twice → ${status}"

  # The bot plants symlinks out of the workspace; every file op refuses them (realpath, T-07.8-09-01).
  run_in "$FO" "$FA" '["sh","-c","ln -s /etc/passwd leak && ln -s /etc etcdir && mkdir -p deep && ln -s ../../etc deep/up && test -r /etc/passwd"]' >/dev/null
  exited_with 0 || fail "files: planting symlinks $(cat "$WORK/body.json")"
  refused=0
  for req in "read leak" "download leak" "list etcdir" "read etcdir/passwd" "read deep/up/passwd" "stat leak"; do
    op="${req%% *}"
    p="${req#* }"
    status="$(api POST "/v1/files/${op}" "$(path_json "$FO" "$FA" "$p")")"
    if [ "$status" = 422 ] && [ "$(jfield "$WORK/body.json" error.code)" = invalid_path ] &&
      ! grep -q 'root:' "$WORK/body.json"; then
      refused=$((refused + 1))
    else
      fail "files: ${op} ${p} → ${status} $(head -c 200 "$WORK/body.json")"
    fi
  done
  [ "$refused" = 6 ] && ok "files: a symlink to /etc/passwd (and /etc, ../../etc) → 422 invalid_path for read, download, list, stat"
  status="$(api POST /v1/files/write "$(path_json "$FO" "$FA" etcdir/evil '"content":"x","encoding":"utf8","mode":"overwrite"')")"
  [ "$status" = 422 ] && ok "files: write through a symlinked folder → 422" || fail "files: write via etcdir → ${status}"
  status="$(api POST /v1/files/delete "$(path_json "$FO" "$FA" leak)")"
  if [ "$status" = 200 ] && docker exec "$CID_F" test -r /etc/passwd; then
    ok "files: delete of the symlink removes the link, never its target"
  else
    fail "files: delete leak → ${status}"
  fi

  status="$(api POST /v1/files/delete "$(path_json "$FO" "$FA" reports)")"
  [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = busy ] &&
    ok "files: delete a non-empty folder without recursive → 409 busy" || fail "files: delete reports → ${status}"
  status="$(api POST /v1/files/delete "$(path_json "$FO" "$FA" reports '"recursive":true')")"
  deleted="$(jfield "$WORK/body.json" deleted)"
  api POST /v1/files/list "$(path_json "$FO" "$FA" "")" >/dev/null
  if [ "$status" = 200 ] && [ "$deleted" = 2 ] && ! grep -q '"reports"' "$WORK/body.json"; then
    ok "files: delete reports recursive → 2 entries removed, gone from the root listing"
  else
    fail "files: delete recursive → ${status} deleted=${deleted}"
  fi

  # Stopped: people keep their files through the network-none helper; the bot's sbx stays stopped (D-01, D-04).
  status="$(api POST /v1/sandboxes/stop "{\"target\":$(target "$FO" "$FA"),\"reason\":\"user\"}")"
  [ "$status" = 200 ] || fail "files: stop F → ${status}"
  status="$(api POST /v1/files/list "$(path_json "$FO" "$FA" notes)")"
  HELPER="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${FA}" --filter "label=ocw.kind=files")"
  netmode="$(docker inspect --format '{{.HostConfig.NetworkMode}} {{len .NetworkSettings.Networks}} {{.Config.User}}' "$HELPER" 2>/dev/null || echo none)"
  if [ "$status" = 200 ] && grep -q 'notes/today.txt' "$WORK/body.json" && [ "$(running_of "$CID_F")" = false ] &&
    [ -n "$HELPER" ] && [ "$netmode" = "none 1 10001:10001" ]; then
    ok "files: after stop, list works through the files helper (network none, user 10001); sbx stays stopped"
  else
    fail "files: stopped list → ${status} sbx=$(running_of "$CID_F") helper=${HELPER:-none} (${netmode})"
  fi
  helper_net="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$HELPER" 2>/dev/null)"
  [ "$helper_net" = none ] && ok "files: the helper is attached to no network (only 'none')" || fail "files: helper networks ${helper_net}"

  status="$(api POST /v1/orgs/kill "{\"orgId\":\"${FO}\"}")"
  [ "$status" = 200 ] || fail "files: killOrg → ${status}"
  status="$(api POST /v1/files/read "$(path_json "$FO" "$FA" notes/today.txt)")"
  if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" content)" = "$(printf 'héllo\n')" ] &&
    [ "$(running_of "$CID_F")" = false ]; then
    ok "files: after killOrg, people's files still read through the helper; sbx stays stopped"
  else
    fail "files: killed read → ${status} sbx=$(running_of "$CID_F")"
  fi
}

# ================================================================ sections: quota and idle (07.8-09 Task 2; D-01, D-09, F-9)

# usage_of <org> <agent> <field>: one bot's field from the usage op.
usage_of() {
  api POST /v1/usage "{\"orgId\":\"$1\"}" >/dev/null
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const item = (j.items ?? []).find((i) => i.agentId === process.argv[2] && i.kind === "sbx");
    process.stdout.write(item ? String(item[process.argv[3]]) : "");
  ' "$WORK/body.json" "$2" "$3"
}

# wait_stopped <container> <seconds>: until it is not running.
wait_stopped() {
  for _ in $(seq 1 "$(($2 * 2))"); do
    [ "$(running_of "$1")" = true ] || return 0
    sleep 0.5
  done
  return 1
}

section_quota() {
  QO="$(uuid)"
  QA="$(uuid)"
  status="$(api POST /v1/policy "$(policy_json "$QO" $((64 * MIB)) 600000)")"
  [ "$status" = 200 ] && ok "quota: policy for org Q (quota 64 MiB) → 200" || fail "quota: policy → ${status} $(cat "$WORK/body.json")"
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$QO" "$QA")}")"
  [ "$status" = 200 ] || fail "quota: ensure → ${status}"
  CID_Q="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${QA}" --filter "label=ocw.kind=sbx")"

  head -c $((50 * MIB)) /dev/urandom >"$WORK/fifty.bin"
  upload_json "$QO" "$QA" data/fifty.bin "$WORK/fifty.bin" false >"$WORK/upload.json"
  status="$(api_file POST /v1/files/upload "$WORK/upload.json")"
  [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" size)" = $((50 * MIB)) ] &&
    ok "quota: a 50 MiB upload under a 64 MiB quota → 200" || fail "quota: 50 MiB upload → ${status} $(head -c 200 "$WORK/body.json")"
  disk="$(usage_of "$QO" "$QA" diskBytes)"
  [ -n "$disk" ] && [ "$disk" -ge $((50 * MIB)) ] && ok "quota: usage reports diskBytes ${disk} for the bot" ||
    fail "quota: usage diskBytes '${disk}' $(cat "$WORK/body.json")"

  head -c $((20 * MIB)) /dev/urandom >"$WORK/twenty.bin"
  upload_json "$QO" "$QA" data/twenty.bin "$WORK/twenty.bin" false >"$WORK/upload.json"
  status="$(api_file POST /v1/files/upload "$WORK/upload.json")"
  code="$(jfield "$WORK/body.json" error.code)"
  leftovers="$(docker exec "$CID_Q" sh -c 'ls -a /workspace/data' 2>&1 | tr '\n' ' ')"
  if [ "$status" = 409 ] && [ "$code" = disk_full ] && [ "$leftovers" = ". .. fifty.bin " ] &&
    [ "$(running_of "$CID_Q")" = true ]; then
    ok "quota: a further 20 MiB upload → 409 disk_full before writing (no partial file), sandbox still running"
  else
    fail "quota: 20 MiB upload → ${status} ${code}; data/: ${leftovers}; running=$(running_of "$CID_Q")"
  fi

  # The bot writes past the quota with its own shell: the next measurement stops it with disk_full.
  run_in "$QO" "$QA" '["dd","if=/dev/zero","of=big.bin","bs=1M","count=80"]' 60000 >/dev/null
  exited_with 0 || fail "quota: dd → $(head -c 200 "$WORK/body.json")"
  if wait_stopped "$CID_Q" 30; then
    ok "quota: an exec that writes 80 MiB → the next measurement stops the sandbox"
  else
    fail "quota: still running after 30 s"
  fi
  state="$(usage_of "$QO" "$QA" state)"
  [ "$state" = disk_full ] && ok "quota: usage state → disk_full" || fail "quota: usage state '${state}'"
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$QO" "$QA")}")"
  [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = disk_full ] &&
    ok "quota: ensure → 409 disk_full while over quota" || fail "quota: ensure while full → ${status} $(cat "$WORK/body.json")"
  status="$(api POST /v1/files/write "$(path_json "$QO" "$QA" note.txt '"content":"x","encoding":"utf8","mode":"create"')")"
  [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = disk_full ] &&
    ok "quota: a write while full → 409 disk_full" || fail "quota: write while full → ${status}"

  status="$(api POST /v1/files/delete "$(path_json "$QO" "$QA" big.bin)")"
  HELPER_Q="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${QA}" --filter "label=ocw.kind=files")"
  if [ "$status" = 200 ] && [ -n "$HELPER_Q" ] && [ "$(running_of "$CID_Q")" = false ]; then
    ok "quota: big.bin deleted through the files helper while the sandbox stays stopped"
  else
    fail "quota: delete big.bin → ${status} helper=${HELPER_Q:-none}"
  fi
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$QO" "$QA")}")"
  if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" state)" = running ]; then
    ok "quota: the measurement after the delete clears disk_full; ensure → running"
  else
    fail "quota: ensure after delete → ${status} $(cat "$WORK/body.json")"
  fi
  status="$(api POST /v1/files/stat "$(path_json "$QO" "$QA" data/fifty.bin)")"
  [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" size)" = $((50 * MIB)) ] &&
    ok "quota: the 50 MiB file is still there" || fail "quota: stat fifty.bin → ${status}"
  rm -f "$WORK/fifty.bin" "$WORK/twenty.bin" "$WORK/upload.json"
}

section_idle() {
  IO="$(uuid)"
  IA="$(uuid)"
  status="$(api POST /v1/policy "$(policy_json "$IO" $((2048 * MIB)) 30000)")"
  [ "$status" = 200 ] || fail "idle: policy → ${status}"
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$IO" "$IA")}")"
  [ "$status" = 200 ] || fail "idle: ensure → ${status}"
  CID_I="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${IA}" --filter "label=ocw.kind=sbx")"
  status="$(api POST /v1/files/write "$(path_json "$IO" "$IA" keep.txt '"content":"still here","encoding":"utf8","mode":"create"')")"
  [ "$status" = 200 ] || fail "idle: write → ${status}"
  i0=$(date +%s)
  if wait_stopped "$CID_I" 60; then
    elapsed=$(($(date +%s) - i0))
    if [ "$elapsed" -ge 29 ]; then
      ok "idle: no op for 30 s → stopped after ${elapsed} s"
    else
      fail "idle: stopped too early (${elapsed} s)"
    fi
  else
    fail "idle: still running after 60 s"
  fi
  state="$(usage_of "$IO" "$IA" state)"
  [ "$state" = stopped ] && ok "idle: usage state → stopped" || fail "idle: usage state '${state}'"
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$IO" "$IA")}")"
  [ "$status" = 200 ] || fail "idle: ensure again → ${status}"
  status="$(api POST /v1/files/read "$(path_json "$IO" "$IA" keep.txt)")"
  [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" content)" = "still here" ] && [ "$(running_of "$CID_I")" = true ] &&
    ok "idle: after the next ensure the sandbox runs and its file is still there" || fail "idle: read after → ${status}"
}

# ================================================================ section: events (07.8-09 Task 3; D-09, P-04, T-07.8-09-04)

# events_get <after> <waitMs> → status; body in $WORK/events.json
events_get() {
  curl -sS -o "$WORK/events.json" -w '%{http_code}' --max-time 40 -H "authorization: Bearer ${TOKEN}" \
    "http://127.0.0.1:${PORT}/v1/events?after=$1&waitMs=$2"
}

# all_events > file: every retained event, paging 500 at a time from seq 0.
all_events() {
  node -e '
    const [port, token] = process.argv.slice(1);
    (async () => {
      const all = [];
      let after = 0;
      for (;;) {
        const r = await fetch(`http://127.0.0.1:${port}/v1/events?after=${after}&waitMs=0`, { headers: { authorization: `Bearer ${token}` } });
        const j = await r.json();
        all.push(...j.events);
        if (j.events.length === 0 || j.nextSeq === after) break;
        after = j.nextSeq;
      }
      process.stdout.write(JSON.stringify(all));
    })();
  ' "$PORT" "$TOKEN"
}

section_events() {
  EO="$(uuid)"
  EA="$(uuid)"
  status="$(push_policy "$EO")"
  [ "$status" = 200 ] || fail "events: policy → ${status} $(cat "$WORK/body.json")"
  status="$(events_get 0 0)"
  BOOT="$(jfield "$WORK/events.json" bootId)"
  if [ "$status" = 200 ] && printf '%s' "$BOOT" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
    ok "events: GET /v1/events → 200 with a uuid bootId"
  else
    fail "events: GET → ${status} $(head -c 200 "$WORK/events.json")"
  fi
  status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/v1/events?after=0&waitMs=0")"
  [ "$status" = 401 ] && ok "events: without the token → 401" || fail "events: no token → ${status}"
  status="$(events_get 0 30001)"
  [ "$status" = 400 ] && ok "events: waitMs over the contract → 400" || fail "events: waitMs 30001 → ${status}"

  # A long poll from the newest cursor resolves promptly on the event it waits for (the ensure of a new bot → its
  # `running` state event). What is timed is the poll's wake-up against the event's own `at` (sandboxd stamps it at
  # emit with this host's clock: it runs here as a host process), never Docker's container start: a cold ensure on a
  # loaded CI daemon has taken up to ~42 s (PR #60), and usage samples and other bots' state changes resolve polls
  # before it. So the polls run until a bounded 120 s deadline (about 3x that worst cold start), and the check fails if
  #   - the running event never arrives, or reaches the poller more than 2 s after it was emitted;
  #   - any poll in flight when its first event was emitted (woken by it) returns more than 2 s after that event;
  #   - any poll returns empty before its 20 s wait (empty only on timeout), or no poll was woken by an event at all.
  # The ensure's own status and duration are logged for information only.
  status="$(events_get 0 0)"
  CURSOR="$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(j.nextSeq));
  ' "$WORK/events.json")"
  while :; do
    events_get "$CURSOR" 0 >/dev/null
    next="$(jfield "$WORK/events.json" nextSeq)"
    [ "$next" = "$CURSOR" ] && break
    CURSOR="$next"
  done
  rm -f "$WORK/ensure.out"
  (
    sleep 1
    e0=$(node -e 'process.stdout.write(String(Date.now()))')
    s="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$EO" "$EA")}" || true)"
    e1=$(node -e 'process.stdout.write(String(Date.now()))')
    printf '%s in %s ms' "$s" "$((e1 - e0))" >"$WORK/ensure.out"
  ) &
  ensure_pid=$!
  verdict="$(node -e '
    const [port, token, agentId, cursor0] = process.argv.slice(1);
    const WAIT_MS = 20_000, DEADLINE_MS = 120_000, PROMPT_MS = 2_000;
    (async () => {
      const t0 = Date.now();
      let cursor = Number(cursor0), polls = 0, woken = 0, hit = null;
      const problems = [];
      while (!hit && problems.length === 0 && Date.now() - t0 < DEADLINE_MS) {
        const start = Date.now();
        const r = await fetch(`http://127.0.0.1:${port}/v1/events?after=${cursor}&waitMs=${WAIT_MS}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(40_000),
        });
        const j = r.status === 200 ? await r.json() : null;
        const end = Date.now();
        polls += 1;
        if (!j) {
          problems.push(`poll ${polls} → ${r.status}`);
          break;
        }
        if (j.events.length === 0) {
          if (end - start < WAIT_MS - 500) problems.push(`poll ${polls} returned empty after ${end - start} ms, before its ${WAIT_MS} ms wait`);
        } else {
          // Emitted after this poll started: the poll was waiting and this event woke it.
          const first = Date.parse(j.events[0].at);
          if (first >= start) {
            woken += 1;
            if (end - first > PROMPT_MS) problems.push(`poll ${polls} returned ${end - first} ms after event seq ${j.events[0].seq} woke it`);
          }
          const e = j.events.find((x) => x.type === "state" && x.target.agentId === agentId && x.state === "running");
          if (e) hit = { seq: e.seq, lag: end - Date.parse(e.at), woke: Date.parse(e.at) >= start, emittedAt: Date.parse(e.at) - t0 };
        }
        cursor = j.nextSeq;
      }
      const where = `${polls} polls over ${Date.now() - t0} ms, ${woken} woken by an event`;
      if (problems.length > 0) return console.log(`fail long poll: ${problems.join("; ")} (${where})`);
      if (!hit) return console.log(`fail long poll: no running event for the new bot within ${DEADLINE_MS} ms (${where})`);
      if (hit.lag > PROMPT_MS) return console.log(`fail long poll: the running event (seq ${hit.seq}) arrived ${hit.lag} ms after it was emitted (${where})`);
      if (woken === 0) return console.log(`fail long poll: no poll was woken by an event (${where})`);
      console.log(`ok a long poll resolves on the next state event: running (seq ${hit.seq}, emitted at +${hit.emittedAt} ms) delivered ${hit.lag} ms after emit${hit.woke ? " by the poll it woke" : ""}; every woken poll within ${PROMPT_MS} ms (${where})`);
    })().catch((e) => console.log(`fail long poll: ${e.message}`));
  ' "$PORT" "$TOKEN" "$EA" "$CURSOR")" || verdict="fail long poll: the poll script exited with an error"
  wait "$ensure_pid" || true
  ensure_info="ensure → $(cat "$WORK/ensure.out" 2>/dev/null || printf 'no result')"
  case "$verdict" in
    "ok "*) ok "events: ${verdict#ok } [${ensure_info}]" ;;
    *) fail "events: ${verdict#fail } [${ensure_info}]" ;;
  esac

  # Content the bot and people handle must never reach the feed.
  run_in "$EO" "$EA" '["sh","-c","echo SENTINEL-argv-3d1c > SENTINEL-file-6b2e.txt"]' >/dev/null
  api POST /v1/files/write "$(path_json "$EO" "$EA" SENTINEL-path-8f4a.txt '"content":"SENTINEL-content-2c7d","encoding":"utf8","mode":"create"')" >/dev/null

  # The sweep samples the running bot: a usage event with its CPU and its measured disk.
  usage=""
  for _ in $(seq 1 20); do
    all_events >"$WORK/all.json"
    usage="$(node -e '
      const all = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const hit = all.find((e) => e.type === "usage" && e.target.agentId === process.argv[2] && e.diskBytes > 0);
      process.stdout.write(hit ? `cpuMs ${hit.cpuMs}, diskBytes ${hit.diskBytes}` : "");
    ' "$WORK/all.json" "$EA")"
    [ -n "$usage" ] && break
    sleep 0.5
  done
  [ -n "$usage" ] && ok "events: a usage sample for the running bot (${usage})" || fail "events: no usage event for E"

  # A container that dies without the broker is reported (crashed: stopped with reason null).
  CID_E="$(docker ps -q --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=${EA}" --filter "label=ocw.kind=sbx")"
  docker stop -t 1 "$CID_E" >/dev/null
  crashed=""
  for _ in $(seq 1 20); do
    all_events >"$WORK/all.json"
    crashed="$(node -e '
      const all = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const hit = all.find((e) => e.type === "state" && e.target.agentId === process.argv[2] && e.state === "stopped" && e.reason === null);
      process.stdout.write(hit ? "yes" : "");
    ' "$WORK/all.json" "$EA")"
    [ -n "$crashed" ] && break
    sleep 0.5
  done
  [ -n "$crashed" ] && ok "events: a container stopped outside sandboxd → state stopped, reason null" ||
    fail "events: no crash event for E"

  all_events >"$WORK/all.json"
  summary="$(node -e '
    const all = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const seen = new Set();
    for (const e of all) seen.add(e.type === "state" ? `state:${e.state}:${e.reason}` : e.type);
    process.stdout.write([...seen].sort().join(" "));
  ' "$WORK/all.json")"
  log "     events seen: ${summary}"
  leaks=""
  for s in SENTINEL-argv-3d1c SENTINEL-file-6b2e SENTINEL-path-8f4a SENTINEL-content-2c7d q3.csv today.txt fifty.bin \
    keep.txt big.bin /etc/passwd héllo "still here" "\"path\"" "\"argv\"" "\"content\""; do
    if grep -qF -- "$s" "$WORK/all.json"; then leaks="${leaks} ${s}"; fi
  done
  [ -z "$leaks" ] && ok "events: $(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length))' "$WORK/all.json") events carry no path, argv or content" ||
    fail "events: leaked${leaks}"
  if want quota; then
    printf '%s' "$summary" | grep -q 'state:disk_full:disk_full' && ok "events: disk_full state event seen" || fail "events: no disk_full event"
  fi
  if want idle; then
    printf '%s' "$summary" | grep -q 'state:stopped:idle' && ok "events: idle stop event seen" || fail "events: no idle event"
  fi
  if want core; then
    printf '%s' "$summary" | grep -q 'state:killed:kill_switch' && ok "events: killed event seen" || fail "events: no killed event"
  fi
}

# ================================================================ section: restart (07.8 policy fix; D-09, the kill switch)

# shell_of <agent>: the bot's sbx container id (running or not).
shell_of() { docker ps -aq --filter "label=ocw.namespace=${NS}" --filter "label=ocw.agent=$1" --filter "label=ocw.kind=sbx"; }

section_restart() {
  KO="$(uuid)"
  KA="$(uuid)"
  LO="$(uuid)"
  LA="$(uuid)"
  # A fresh sandboxd has no policy and no default: nothing starts for an organization it was not told about.
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$KO" "$KA")}")"
  if [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = policy_missing ] && [ -z "$(shell_of "$KA")" ]; then
    ok "restart: ensure before any policy → 409 policy_missing, no container created"
  else
    fail "restart: ensure without policy → ${status} $(cat "$WORK/body.json") containers=$(shell_of "$KA")"
  fi

  for o in "$KO" "$LO"; do
    status="$(push_policy "$o")"
    [ "$status" = 200 ] || fail "restart: policy → ${status}"
  done
  api POST /v1/sandboxes/ensure "{\"target\":$(target "$KO" "$KA")}" >/dev/null
  api POST /v1/sandboxes/ensure "{\"target\":$(target "$LO" "$LA")}" >/dev/null
  run_in "$KO" "$KA" '["sh","-c","echo kept > kept.txt"]' >/dev/null
  CID_K="$(shell_of "$KA")"
  CID_L="$(shell_of "$LA")"
  # The admin kills organization K: the API stops its containers and pushes killed (a new settings version).
  status="$(api POST /v1/orgs/kill "{\"orgId\":\"${KO}\"}")"
  [ "$status" = 200 ] || fail "restart: killOrg → ${status}"
  status="$(push_policy "$KO" true 2)"
  [ "$status" = 200 ] || fail "restart: killed policy → ${status}"
  if [ -n "$CID_K" ] && [ "$(running_of "$CID_K")" = false ] && [ "$(running_of "$CID_L")" = true ]; then
    ok "restart: org K killed (its sbx stopped), org L running"
  else
    fail "restart: before the restart K=$(running_of "$CID_K") L=$(running_of "$CID_L")"
  fi

  # sandboxd restarts mid-run: a new process, a new boot id, every policy forgotten; Docker's objects stay.
  status="$(events_get 0 0)"
  BOOT_BEFORE="$(jfield "$WORK/events.json" bootId)"
  stop_sandboxd
  start_sandboxd
  status="$(events_get 0 0)"
  BOOT_AFTER="$(jfield "$WORK/events.json" bootId)"
  if [ "$status" = 200 ] && [ -n "$BOOT_AFTER" ] && [ "$BOOT_AFTER" != "$BOOT_BEFORE" ]; then
    ok "restart: sandboxd restarted on port ${PORT} with a new boot id"
  else
    fail "restart: boot id ${BOOT_BEFORE} → ${BOOT_AFTER} (${status})"
  fi

  # The killed organization, before the API pushes again: nothing may start or run.
  refused=0
  for req in "ensure" "restart" "exec"; do
    if [ "$req" = exec ]; then body="$(exec_json "$KO" "$KA" '["true"]')"; else body="{\"target\":$(target "$KO" "$KA")}"; fi
    status="$(api POST "/v1/sandboxes/${req}" "$body")"
    if [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = policy_missing ]; then
      refused=$((refused + 1))
    else
      fail "restart: ${req} for killed K without a policy → ${status} $(cat "$WORK/body.json")"
    fi
  done
  status="$(api POST /v1/files/write "$(path_json "$KO" "$KA" new.txt '"content":"x","encoding":"utf8","mode":"create"')")"
  [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = policy_missing ] && refused=$((refused + 1)) ||
    fail "restart: write for K without a policy → ${status}"
  if [ "$refused" = 4 ] && [ "$(running_of "$CID_K")" = false ] && [ "$(shell_of "$KA")" = "$CID_K" ]; then
    ok "restart: org K without a policy → ensure, restart, exec and write 409 policy_missing; its sbx stays stopped, no new container"
  fi
  status="$(api POST /v1/files/read "$(path_json "$KO" "$KA" kept.txt)")"
  if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" content)" = "$(printf 'kept\n')" ] && [ "$(running_of "$CID_K")" = false ]; then
    ok "restart: people still read org K's files through the helper; its sbx stays stopped"
  else
    fail "restart: read for K → ${status} sbx=$(running_of "$CID_K")"
  fi

  # The API pushes K's current policy: still killed. A stale push (an older version) cannot undo it.
  status="$(push_policy "$KO" true 2)"
  [ "$status" = 200 ] || fail "restart: re-push K → ${status}"
  status="$(push_policy "$KO" false 1)"
  [ "$status" = 200 ] || fail "restart: stale push K → ${status}"
  killed=0
  for req in "ensure" "restart" "exec"; do
    if [ "$req" = exec ]; then body="$(exec_json "$KO" "$KA" '["true"]')"; else body="{\"target\":$(target "$KO" "$KA")}"; fi
    status="$(api POST "/v1/sandboxes/${req}" "$body")"
    if [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = killed ]; then
      killed=$((killed + 1))
    else
      fail "restart: ${req} for K after the re-push → ${status} $(cat "$WORK/body.json")"
    fi
  done
  if [ "$killed" = 3 ] && [ "$(running_of "$CID_K")" = false ]; then
    ok "restart: org K after the re-push (and a stale killed=false push) → ensure, restart, exec 409 killed; its sbx never started"
  fi

  # The live organization: its container survived the restart, but nothing runs in it until the policy is back.
  status="$(run_in "$LO" "$LA" '["true"]')"
  [ "$status" = 409 ] && [ "$(jfield "$WORK/body.json" error.code)" = policy_missing ] &&
    ok "restart: org L exec before the re-push → 409 policy_missing" || fail "restart: L exec without a policy → ${status}"
  status="$(push_policy "$LO")"
  [ "$status" = 200 ] || fail "restart: re-push L → ${status}"
  status="$(run_in "$LO" "$LA" '["sh","-c","echo back"]')"
  if [ "$status" = 200 ] && exited_with 0 && [ "$(jfield "$WORK/body.json" stdout)" = "$(printf 'back\n')" ]; then
    ok "restart: org L after one re-push → exec runs again"
  else
    fail "restart: L exec after the re-push → ${status} $(cat "$WORK/body.json")"
  fi
}

# ================================================================ section: docs (07.17.1.1.1; D-03 … D-08, PD-18)

# The section's cap (W7): a slow runtime is fixed by doing less work, never by raising this without a recorded reason.
DOCS_CAP_S=900
# Every exec answer of the section (D-03): how many, and the stdout sizes over the 16 KiB tail.
DOCS_ANSWERS=0
DOCS_OVER=""
# The fixtures the section checks, and only those (make_fixtures.py builds what they derive from).
DOCS_FIXTURES="scan.pdf,text.pdf,sign.png,plan.docx,ventas.xlsx,slides.pptx,plan.odt,pedido.eml,pack.zip,blob.bin,macro.fodt"

# note_answer: counts the exec answer in $WORK/body.json and records its stdout size when it is over 16 384 bytes.
note_answer() {
  local n
  n="$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(Buffer.byteLength(j.stdout ?? "")));
  ' "$WORK/body.json" 2>/dev/null || echo 0)"
  DOCS_ANSWERS=$((DOCS_ANSWERS + 1))
  if [ "$n" -gt 16384 ]; then DOCS_OVER="${DOCS_OVER} ${n}"; fi
}

# run_long <org> <agent> <argv json> <deadline s> [timeoutMs]: exec with the 25 s yield and the 600 s command budget (or
# timeoutMs: the API sends 120000 when the bot names no timeoutSeconds); a command still running is polled every 5 s
# until it exits or the deadline passes (then it is killed and the call fails). Succeeds when the command exited,
# whatever its code; the final answer is in $WORK/body.json.
run_long() {
  local org="$1" agent="$2" argv="$3" deadline="$4" timeout_ms="${5:-600000}" t0 pid status
  t0=$(date +%s)
  status="$(api POST /v1/sandboxes/exec "$(exec_json "$org" "$agent" "$argv" "$timeout_ms" 25000)")"
  [ "$status" = 200 ] || return 1
  note_answer
  pid="$(jfield "$WORK/body.json" processId)"
  while [ "$(jfield "$WORK/body.json" status)" = running ]; do
    if [ $(($(date +%s) - t0)) -ge "$deadline" ]; then
      api POST /v1/sandboxes/process "$(printf '{"target":%s,"processId":"%s","action":"kill"}' "$(target "$org" "$agent")" "$pid")" >/dev/null || true
      return 1
    fi
    sleep 5
    status="$(api POST /v1/sandboxes/process "$(printf '{"target":%s,"processId":"%s","action":"poll"}' "$(target "$org" "$agent")" "$pid")")"
    [ "$status" = 200 ] || return 1
    note_answer
  done
  [ "$(jfield "$WORK/body.json" status)" = exited ]
}

# stdout_has <needle>...: the answer's stdout holds every needle, accents and case ignored (OCR may drop an accent).
stdout_has() {
  node -e '
    const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const out = fold(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stdout ?? "");
    process.exit(process.argv.slice(2).every((n) => out.includes(fold(n))) ? 0 : 1);
  ' "$WORK/body.json" "$@"
}

# stdout_line <regex>: some line of the answer's stdout matches.
stdout_line() {
  node -e '
    const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stdout ?? "";
    process.exit(new RegExp(process.argv[2], "m").test(out) ? 0 : 1);
  ' "$WORK/body.json" "$1"
}

exit_code() { jfield "$WORK/body.json" exitCode; }
docs_fail() { fail "docs: $1 → $(head -c 1500 "$WORK/body.json")"; }

# docs_extract <label> <file> <exit code> [needle...]: `ocw-extract <file>` in bot X's shell through sandboxd.
docs_extract() {
  local label="$1" file="$2" want="$3"
  shift 3
  if run_long "$DO" "$DA" "[\"ocw-extract\",\"${file}\"]" 300 && [ "$(exit_code)" = "$want" ] &&
    { [ "$#" = 0 ] || stdout_has "$@"; }; then
    ok "docs: ${label}"
  else
    docs_fail "$label"
  fi
}

# download_sha <org> <agent> <path>: the sha256 of the file's bytes as people download them through sandboxd.
download_sha() {
  local status
  status="$(api POST /v1/files/download "$(path_json "$1" "$2" "$3")")"
  [ "$status" = 200 ] || return 1
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(require("crypto").createHash("sha256").update(Buffer.from(j.data ?? "", "base64")).digest("hex"));
  ' "$WORK/body.json"
}

# macro_open <image>: in a throwaway container hardened like a bot's shell (run-sbx-image-tests.sh's flags, tmpfs
# /workspace and /tmp, no network), generates macro.fodt with make_fixtures.py (streamed with tar), seeds a profile
# whose MacroSecurityLevel is 0 (low: macros run without asking), opens the document the ordinary way (`soffice
# --headless`, no conversion) for at most 60 s and prints `marker yes` or `marker no`.
macro_open() {
  local tar_opts=""
  case "$(tar --version 2>/dev/null || true)" in
    bsdtar*) tar_opts=--no-xattrs ;;
  esac
  # shellcheck disable=SC2086 # tar_opts is empty or one word
  COPYFILE_DISABLE=1 tar $tar_opts -C infra/sandbox/sbx/tools/tests -cf - make_fixtures.py |
    docker run -i --rm --label "ocw.namespace=${NS}" \
      --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --init \
      --pids-limit 256 --memory 1g --memory-swap 1g --cpus 1 --network none \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
      --tmpfs /workspace:rw,nosuid,nodev,size=512m,uid=10001,gid=10001 \
      -e HOME=/workspace -e LC_ALL=C.UTF-8 \
      "$1" sh -c '
        mkdir -p /tmp/t && tar -x -C /tmp/t || exit 10
        /opt/ocw-tools/venv/bin/python3 -I /tmp/t/make_fixtures.py /workspace/fx --only macro.fodt >/dev/null || exit 11
        mkdir -p /tmp/pc/user || exit 12
        cat >/tmp/pc/user/registrymodifications.xcu <<XCU
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
XCU
        timeout -k 5 60 soffice --headless --norestore -env:UserInstallation=file:///tmp/pc /workspace/fx/macro.fodt >/dev/null 2>&1 &
        i=0
        while [ "$i" -lt 60 ] && [ ! -e /workspace/fx/MACRO-RAN ] && kill -0 "$!" 2>/dev/null; do
          sleep 1
          i=$((i + 1))
        done
        if [ -e /workspace/fx/MACRO-RAN ]; then echo "marker yes"; else echo "marker no"; fi
      '
}

# macro_control: the positive control (runc only; PD-11). A test-only image from $IMAGE without ocw.xcd must run the
# load macro on an ordinary open with a low-security profile; the real image must not. When the control does not fire,
# only the configuration proves the rule, and the smoke says so (D-08's permitted outcome, recorded in ADR-0043).
macro_control() {
  local control real
  if printf 'FROM %s\nUSER 0:0\nRUN rm -f /usr/lib/libreoffice/share/registry/ocw.xcd\nUSER 10001:10001\n' "$IMAGE" |
    docker build -q --label "ocw.namespace=${NS}" -t "$MACRO_IMAGE" - >/dev/null 2>"$WORK/macro-build.err"; then
    BUILT_IMAGES="${BUILT_IMAGES} $(docker image inspect --format '{{.Id}}' "$MACRO_IMAGE")"
    control="$(macro_open "$MACRO_IMAGE" 2>&1 || true)"
  else
    control="build failed: $(tail -n 3 "$WORK/macro-build.err" | tr '\n' ' ')"
  fi
  if [ "$control" = "marker yes" ]; then
    ok "docs: macro positive control fired (without ocw.xcd, a low-security profile and an ordinary open write MACRO-RAN)"
  else
    log "     macro positive control not achieved (configuration-only proof): ${control:-no output}"
  fi
  real="$(macro_open "$IMAGE" 2>&1 || true)"
  if [ "$real" = "marker no" ]; then
    ok "docs: the same low-security open in the real image never runs the macro (ocw.xcd finalized)"
  else
    fail "docs: the real image with a low-security profile → ${real:-no output}"
  fi
}

section_docs() {
  local docs_t0 t took code runs sha_before sha_after
  docs_t0=$(date +%s)
  DO="$(uuid)"
  DA="$(uuid)"
  status="$(push_policy "$DO")"
  [ "$status" = 200 ] || fail "docs: policy → ${status} $(cat "$WORK/body.json")"
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$DO" "$DA")}")"
  if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" state)" = running ]; then
    ok "docs: ensure X → running"
  else
    fail "docs: ensure X → ${status} $(cat "$WORK/body.json")"
    return
  fi

  # ---------------------------------------------------------------- the fixtures, generated in the bot's shell

  # People's file write (base64 from the repository file), then the bot's own python3 with the toolkit PYTHONPATH.
  node -e '
    const [org, agent, file] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      target: { orgId: org, agentId: agent },
      path: "fxgen/make_fixtures.py",
      content: require("fs").readFileSync(file).toString("base64"),
      encoding: "base64",
      mode: "create",
    }));
  ' "$DO" "$DA" infra/sandbox/sbx/tools/tests/make_fixtures.py >"$WORK/fxgen.json"
  status="$(api_file POST /v1/files/write "$WORK/fxgen.json")"
  [ "$status" = 200 ] && ok "docs: make_fixtures.py written to fxgen/ through the files API" ||
    fail "docs: write make_fixtures.py → ${status} $(cat "$WORK/body.json")"
  t=$(date +%s)
  if run_long "$DO" "$DA" "[\"python3\",\"fxgen/make_fixtures.py\",\"/workspace/fx\",\"--only\",\"${DOCS_FIXTURES}\"]" 600 &&
    [ "$(exit_code)" = 0 ]; then
    ok "docs: the bot's shell generated the fixtures it checks in $(($(date +%s) - t)) s (no network)"
  else
    docs_fail "generate fixtures"
    return
  fi

  # ---------------------------------------------------------------- one check per type (D-03, D-06)

  docs_extract "scanned PDF OCR → (ocr) pages with \"Política de devoluciones\"" fx/scan.pdf 0 "(ocr)" "politica de devoluciones"
  docs_extract "text PDF → \"facturación\"" fx/text.pdf 0 "facturación"
  docs_extract "Spanish PNG OCR → \"emergencia\"" fx/sign.png 0 "emergencia"
  docs_extract "docx → \"Región Norte\"" fx/plan.docx 0 "Región Norte"
  docs_extract "xlsx → ### sheet: Ventas with Norte,1200" fx/ventas.xlsx 0 "### sheet: Ventas" "Norte,1200"
  docs_extract "pptx → \"Plan de acción\"" fx/slides.pptx 0 "Plan de acción"
  docs_extract "odt → \"Plan anual 2026\"" fx/plan.odt 0 "Plan anual 2026"
  docs_extract ".eml → \"Pedido 42\" and ### attachment: factura.pdf" fx/pedido.eml 0 "Pedido 42" "### attachment: factura.pdf"
  if run_long "$DO" "$DA" '["ocw-extract","fx/pack.zip"]' 300 && [ "$(exit_code)" = 0 ] &&
    stdout_line '(^|/)a\.txt · [0-9]+ bytes$'; then
    ok "docs: zip → a listing line for a.txt (listed, never extracted)"
  else
    docs_fail "zip listing"
  fi
  docs_extract "unknown binary → exit 3" fx/blob.bin 3

  # ---------------------------------------------------------------- the shell's environment (PD-05)

  if run_long "$DO" "$DA" '["sh","-c","for t in ocw-extract pdftotext tesseract soffice 7zz; do command -v \"$t\" || exit 1; done"]' 60 &&
    [ "$(exit_code)" = 0 ] &&
    [ "$(jfield "$WORK/body.json" stdout | grep -c '^/')" = 5 ]; then
    ok "docs: ocw-extract, pdftotext, tesseract, soffice and 7zz are on the shell's PATH"
  else
    docs_fail "tools on PATH"
  fi
  if run_long "$DO" "$DA" '["python3","-c","import pandas, openpyxl, pdfplumber, docx; print(\"ok\")"]' 120 &&
    [ "$(exit_code)" = 0 ] && [ "$(jfield "$WORK/body.json" stdout)" = "$(printf 'ok\n')" ]; then
    ok "docs: the bot's python3 imports pandas, openpyxl, pdfplumber and docx"
  else
    docs_fail "python3 imports"
  fi
  if run_long "$DO" "$DA" '["id","-u"]' 60 && [ "$(jfield "$WORK/body.json" stdout)" = "$(printf '10001\n')" ]; then
    ok "docs: the toolkit runs as uid 10001"
  else
    docs_fail "id -u"
  fi

  # ---------------------------------------------------------------- batch: chunks, resume, originals untouched (D-04)

  sha_before="$(download_sha "$DO" "$DA" fx/text.pdf || true)"
  # The bot's default path (07.17.1.1.1 review CR-01): no timeoutSeconds means the API's 120 s. The batch refuses it at
  # once with a usage error naming the way out (never killed by ocw-run's timeout, 137); the reruns below take the
  # documented path, background with timeoutSeconds 600.
  if run_long "$DO" "$DA" '["ocw-extract","--batch","/workspace/fx"]' 150 120000 && [ "$(exit_code)" = 2 ] &&
    jfield "$WORK/body.json" stderr | grep -q "timeoutSeconds 600"; then
    ok "docs: ocw-extract --batch under the default 120 s exec timeout → exit 2 naming timeoutSeconds 600 (never 137)"
  else
    docs_fail "batch under the default 120 s timeout"
  fi
  # 07.17.1.1.1 review CR-02: a budget under the longest step (plus 10 s) is a usage error, never an endless exit 75.
  if run_long "$DO" "$DA" '["ocw-extract","--batch","/workspace/fx","--budget","1"]' 120 && [ "$(exit_code)" = 2 ] &&
    jfield "$WORK/body.json" stderr | grep -q -- "--budget must be between 130"; then
    ok "docs: ocw-extract --batch with --budget 1 → exit 2 (usage), never an endless 75"
  else
    docs_fail "batch --budget 1"
  fi
  runs=0
  code=""
  t=$(date +%s)
  while [ "$runs" -lt 5 ]; do
    runs=$((runs + 1))
    run_long "$DO" "$DA" '["ocw-extract","--batch","/workspace/fx"]' 620 || break
    code="$(exit_code)"
    [ "$code" = 75 ] || break
  done
  if [ "$code" = 0 ]; then
    ok "docs: batch reruns (background, timeoutSeconds 600) → exit 0 after ${runs} run(s), $(($(date +%s) - t)) s"
  else
    docs_fail "batch reruns (run ${runs}, exit ${code:-none})"
  fi
  status="$(api POST /v1/files/read "$(path_json "$DO" "$DA" extracted/fx/_index.tsv)")"
  if [ "$status" = 200 ] && node -e '
    const lines = (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).content ?? "").split("\n");
    const rows = lines.slice(1).map((l) => l.split("\t"));
    const ok = lines[0].startsWith("path\tsize\t") && rows.some((c) => /(^|\/)scan\.pdf$/.test(c[0]) && c[8] === "done");
    process.exit(ok ? 0 : 1);
  ' "$WORK/body.json"; then
    ok "docs: extracted/fx/_index.tsv read through sandboxd, scan.pdf done"
  else
    fail "docs: _index.tsv → ${status} $(head -c 1500 "$WORK/body.json")"
  fi
  sha_after="$(download_sha "$DO" "$DA" fx/text.pdf || true)"
  if [ -n "$sha_before" ] && [ "$sha_before" = "$sha_after" ]; then
    ok "docs: fx/text.pdf has the same sha256 before and after the batch"
  else
    fail "docs: text.pdf sha256 ${sha_before:-none} → ${sha_after:-none}"
  fi

  # ---------------------------------------------------------------- macros never run (D-08, PD-11, E18, E21)

  # ocw-extract, then the bot's own conversion with its default profile (HOME=/workspace → /workspace/.config).
  if run_long "$DO" "$DA" '["ocw-extract","fx/macro.fodt"]' 300 && [ "$(exit_code)" = 0 ] &&
    stdout_has "Documento con macro de prueba" &&
    run_long "$DO" "$DA" '["soffice","--headless","--norestore","--convert-to","pdf","--outdir","/workspace/fx/out","fx/macro.fodt"]' 300 &&
    [ "$(exit_code)" = 0 ] &&
    run_long "$DO" "$DA" '["sh","-c","test -s fx/out/macro.pdf || exit 2; test -e fx/MACRO-RAN && exit 1; exit 0"]' 60 &&
    [ "$(exit_code)" = 0 ]; then
    ok "docs: macro never runs under conversion (ocw-extract and the bot's own soffice --convert-to pdf, no MACRO-RAN)"
  else
    docs_fail "macro under conversion"
  fi
  if [ "${RUNTIME:-}" = gvisor ]; then
    log "skip docs: macro control (tests LibreOffice configuration, not the runtime)"
  else
    macro_control
  fi

  # ---------------------------------------------------------------- every answer under the 16 KiB tail, and the cap

  if [ -z "$DOCS_OVER" ] && [ "$DOCS_ANSWERS" -gt 0 ]; then
    ok "docs: every exec answer's stdout is at most 16384 bytes (${DOCS_ANSWERS} answers)"
  else
    fail "docs: exec answers over 16384 bytes:${DOCS_OVER} (of ${DOCS_ANSWERS})"
  fi
  took=$(($(date +%s) - docs_t0))
  if [ "$took" -le "$DOCS_CAP_S" ]; then
    ok "docs: section took ${took} s (cap ${DOCS_CAP_S} s, runtime ${RUNTIME:-unknown})"
  else
    fail "docs: section took ${took} s, over the ${DOCS_CAP_S} s cap (runtime ${RUNTIME:-unknown})"
  fi
}

# ================================================================ section: drift (07.17.1.1.1; D-10, PD-10, E20)

# image_of <container>: the image ID it runs (Docker's top-level `.Image`).
image_of() { docker inspect --format '{{.Image}}' "$1" 2>/dev/null || echo gone; }
# tag_id: the image ID $IMAGE names now.
tag_id() { docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || echo none; }

# rebuild_image: moves the $IMAGE tag to a new image (FROM the current one plus a random label; the namespace label
# kept) and records its ID for on_exit. Not in a subshell: BUILT_IMAGES must keep the ID.
rebuild_image() {
  printf 'FROM %s\nLABEL ocw.smoke.drift=%s\n' "$IMAGE" "$(uuid)" |
    docker build -q --label "ocw.namespace=${NS}" -t "$IMAGE" - >/dev/null
  BUILT_IMAGES="${BUILT_IMAGES} $(tag_id)"
}

# ensure_running <org> <agent>: ensure → 200 and running.
ensure_running() {
  status="$(api POST /v1/sandboxes/ensure "{\"target\":$(target "$1" "$2")}")"
  [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" state)" = running ]
}

section_drift() {
  local i1 i2 i3 p1 p2 p3 q1 q2
  DRO="$(uuid)"
  DP="$(uuid)"
  DQ="$(uuid)"
  status="$(push_policy "$DRO")"
  [ "$status" = 200 ] || fail "drift: policy → ${status} $(cat "$WORK/body.json")"

  # A stopped shell on the old image is re-created on the new one; its workspace volume stays.
  i1="$(tag_id)"
  ensure_running "$DRO" "$DP" || fail "drift: ensure P → ${status} $(cat "$WORK/body.json")"
  p1="$(shell_of "$DP")"
  if [ -n "$p1" ] && [ "$(image_of "$p1")" = "$i1" ]; then
    ok "drift: ensure P → running on the smoke image"
  else
    fail "drift: P's shell ${p1:-none} runs $(image_of "${p1:-none}"), the tag names ${i1}"
  fi
  status="$(api POST /v1/files/write "$(path_json "$DRO" "$DP" drift/kept.txt '"content":"before the rebuild","encoding":"utf8","mode":"create"')")"
  [ "$status" = 200 ] || fail "drift: write → ${status} $(cat "$WORK/body.json")"
  status="$(api POST /v1/sandboxes/stop "{\"target\":$(target "$DRO" "$DP"),\"reason\":\"user\"}")"
  [ "$status" = 200 ] && [ "$(running_of "$p1")" = false ] || fail "drift: stop P → ${status} running=$(running_of "$p1")"
  rebuild_image
  i2="$(tag_id)"
  [ "$i2" != "$i1" ] || fail "drift: the rebuild left the tag on ${i1}"
  ensure_running "$DRO" "$DP" || fail "drift: ensure P after the rebuild → ${status} $(cat "$WORK/body.json")"
  p2="$(shell_of "$DP")"
  if [ -n "$p2" ] && [ "$p2" != "$p1" ] && [ "$(image_of "$p2")" = "$i2" ] && [ "$(running_of "$p2")" = true ]; then
    ok "drift: a stopped shell is re-created after its image tag is rebuilt (new container, .Image = the new image)"
  else
    fail "drift: P after the rebuild: ${p1} → ${p2:-none} on $(image_of "${p2:-none}"), want ${i2}"
  fi
  status="$(api POST /v1/files/read "$(path_json "$DRO" "$DP" drift/kept.txt)")"
  if [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" content)" = "before the rebuild" ]; then
    ok "drift: the workspace file written before the rebuild reads back through sandboxd (volumes kept)"
  else
    fail "drift: read kept.txt → ${status} $(cat "$WORK/body.json")"
  fi

  # A running shell is never touched by ensure; it moves at its next stop.
  ensure_running "$DRO" "$DQ" || fail "drift: ensure Q → ${status} $(cat "$WORK/body.json")"
  q1="$(shell_of "$DQ")"
  rebuild_image
  i3="$(tag_id)"
  [ "$i3" != "$i2" ] || fail "drift: the second rebuild left the tag on ${i2}"
  if ensure_running "$DRO" "$DQ" && [ -n "$q1" ] && [ "$(shell_of "$DQ")" = "$q1" ] &&
    [ "$(running_of "$q1")" = true ] && [ "$(image_of "$q1")" = "$i2" ]; then
    ok "drift: a running shell is untouched by ensure after another rebuild (same container, still running)"
  else
    fail "drift: Q after the second rebuild: ${q1:-none} → $(shell_of "$DQ") running=$(running_of "${q1:-none}")"
  fi
  status="$(api POST /v1/sandboxes/stop "{\"target\":$(target "$DRO" "$DQ"),\"reason\":\"user\"}")"
  [ "$status" = 200 ] || fail "drift: stop Q → ${status}"
  ensure_running "$DRO" "$DQ" || fail "drift: ensure Q after the stop → ${status} $(cat "$WORK/body.json")"
  q2="$(shell_of "$DQ")"
  if [ -n "$q2" ] && [ "$q2" != "$q1" ] && [ "$(image_of "$q2")" = "$i3" ]; then
    ok "drift: after a stop, the next ensure re-creates the shell on the newest image"
  else
    fail "drift: Q after the stop: ${q1:-none} → ${q2:-none} on $(image_of "${q2:-none}"), want ${i3}"
  fi

  # restart re-creates a running shell that drifted (it stops the commands anyway; PD-10).
  status="$(api POST /v1/sandboxes/restart "{\"target\":$(target "$DRO" "$DP")}")"
  p3="$(shell_of "$DP")"
  if [ "$status" = 200 ] && [ -n "$p3" ] && [ "$p3" != "$p2" ] && [ "$(image_of "$p3")" = "$i3" ] &&
    [ "$(running_of "$p3")" = true ]; then
    ok "drift: restart re-creates a running shell on an older image (new container on the newest image)"
  else
    fail "drift: restart P → ${status} ${p2:-none} → ${p3:-none} on $(image_of "${p3:-none}"), want ${i3} $(cat "$WORK/body.json")"
  fi
  status="$(api POST /v1/files/read "$(path_json "$DRO" "$DP" drift/kept.txt)")"
  [ "$status" = 200 ] && [ "$(jfield "$WORK/body.json" content)" = "before the rebuild" ] &&
    ok "drift: the file is still there after the restart" || fail "drift: read after restart → ${status}"
}

# ================================================================ run the chosen sections

if want core; then section_core; fi
if want files; then section_files; fi
if want quota; then section_quota; fi
if want idle; then section_idle; fi
if want events; then section_events; fi
if want restart; then section_restart; fi
if want docs; then section_docs; fi
# Last: it moves the $IMAGE tag.
if want drift; then section_drift; fi

if [ "$FAILURES" != 0 ]; then
  log "${FAILURES} check(s) failed"
  exit 1
fi
log "sandbox smoke: all checks passed (runtime ${RUNTIME:-unknown})"
