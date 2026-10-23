#!/usr/bin/env bash
# Real-Docker stack smoke (07.8-13; D-01, D-05, D-06, D-07, D-11, D-12, D-13, D-14; SBX-01, SBX-03, BRW-01, BRW-02).
# Builds the real `sbx`, `brw` and `sandbox-egress` images, starts the fake sites on a fixtures network, and drives a
# host-process sandboxd through its HTTP API (stack-smoke.mjs): each bot's browser in its own `brw` container on its
# own browser network, the namespace's egress proxy created and attached by sandboxd, policy written into the proxy,
# frames streamed over HTTP, takeover input, downloads into the workspace, resize, two bots kept apart, the site lock,
# a sandboxd restart that re-attaches to a running browser, and the kill switch.
#
# Steps after `open` (stack-smoke.mjs `stepFull`):
#   takeover    contextTakeover on → bot ops answer `paused`; input frames sign in on the fake site; takeover off
#   state       contextExportState keeps the site's cookie only
#   downloads   contextDownload streams the downloaded file by its token, never through the broker's disk;
#               filesImport writes it to /workspace/downloads of A's sbx, owned by 10001
#   resize      a phone resize streams frames at the phone size
#   two bots    B's browser egress `off` → navigation_refused and a refused egress event; A's brw reaches neither B's
#               sbx nor B's brw; A's sbx gets bot_network / proxy_self for B's address and the proxy's, though listed
#   site lock   blockedNavigation, then one allowCrossSite navigation
#   restart     a new sandboxd re-attaches to the running brw (no restart), policy_missing until the push
#   kill        killOrg stops every sbx and brw of the organization; the other org and the proxy keep running
#
# Usage (repo root):  bash infra/sandbox/test/run-stack-smoke.sh [--only open|full]
#   --only open    Task 1's tracer only: open → navigate → snapshot → frames → egress event, containment checks
#   --only coldstart  fresh browsers, each first contextOpen right after ensure, timed (STACK_COLDSTARTS, default 8)
#   (default)      every step
#   STACK_KEEP_LOG=<file>  copy sandboxd's log there on exit
#   STACK_REAL_EGRESS=0  skip the public-internet navigation (on by default; recorded when the network forbids it)
#   DOCKER_SOCKET=<path> the daemon socket (default: the current docker context's unix socket)
#
# Every Docker object carries `ocw.namespace=ocw-smoke-<pid>` (the fixtures by the smoke, every sandbox object by
# sandboxd itself) and is removed by that label BEFORE the run and again on exit (P-13); the `:smoke-<sha>` images are
# removed on exit. It never prunes, and refuses to build when the Docker VM has under 8 GB free.
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
case "$ONLY" in all | open | coldstart) ;; *)
  printf 'unknown --only: %s (open, coldstart or all)\n' "$ONLY" >&2
  exit 2
  ;;
esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

NS="ocw-smoke-$$"
SHA="$(git rev-parse --short=12 HEAD)"
SBX_IMAGE="ocw-sandbox-sbx:smoke-${SHA}"
BRW_IMAGE="ocw-sandbox-brw:smoke-${SHA}"
EGRESS_IMAGE="ocw-sandbox-egress:smoke-${SHA}"
BASE="node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
NET_FIX="${NS}-fixtures"
FAKE="${NS}-fake-site"
WORK="$(mktemp -d)"
MIN_FREE_KB=$((8 * 1024 * 1024))

log() { printf '%s\n' "$*" >&2; }

# ---------------------------------------------------------------- cleanup by label (never a prune)

cleanup_ns() {
  local ids
  ids="$(docker ps -aq --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker rm -f -v $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker network rm $ids >/dev/null 2>&1 || true; fi
  ids="$(docker volume ls -q --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker volume rm -f $ids >/dev/null 2>&1 || true; fi
}

stop_sandboxd() {
  if [ -f "$WORK/sandboxd.pid" ]; then
    local pid
    pid="$(cat "$WORK/sandboxd.pid")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
}

on_exit() {
  local code=$?
  stop_sandboxd
  if [ "$code" != "0" ] && [ -f "$WORK/sandboxd.log" ]; then
    log "--- sandboxd log (ids, ops and statuses only) ---"
    tail -n 40 "$WORK/sandboxd.log" >&2 || true
  fi
  # STACK_KEEP_LOG=<file>: keep sandboxd's log (ids, ops, statuses, brw diagnostics) for a diagnosis.
  if [ -n "${STACK_KEEP_LOG:-}" ] && [ -f "$WORK/sandboxd.log" ]; then cp "$WORK/sandboxd.log" "$STACK_KEEP_LOG" || true; fi
  # A removed container can hold its network and volumes for a moment after `rm -f` returns (CI dind, pipeline 52):
  # retry the label cleanup briefly before counting what is left, as run-sandbox-smoke.sh does.
  local left attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    cleanup_ns
    left="$(docker ps -aq --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')"
    left=$((left + $(docker network ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
    left=$((left + $(docker volume ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
    [ "$left" = "0" ] && break
    sleep 1
  done
  docker image rm -f "$SBX_IMAGE" "$BRW_IMAGE" "$EGRESS_IMAGE" >/dev/null 2>&1 || true
  if [ "$left" != "0" ]; then
    log "FAIL ${left} object(s) labelled ocw.namespace=${NS} left after cleanup"
    code=1
  fi
  for image in "$SBX_IMAGE" "$BRW_IMAGE" "$EGRESS_IMAGE"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      log "FAIL image ${image} left after cleanup"
      code=1
    fi
  done
  rm -rf "$WORK"
  exit "$code"
}
trap on_exit EXIT

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
  log "FAIL Docker ${server_version} < 26 (CVE-2024-29018: internal networks forward DNS); refusing to run"
  exit 1
fi
log "ok   Docker ${server_version} >= 26"

# P-13: whatever a crashed earlier run with this namespace left goes first.
cleanup_ns

free_kb="$(docker run --rm --network none --label "ocw.namespace=${NS}" --entrypoint df "$BASE" -Pk /etc/hosts |
  awk 'NR==2 {print $4}')"
if [ -z "$free_kb" ] || [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
  log "FAIL the Docker VM has $((${free_kb:-0} / 1024 / 1024)) GB free (< 8 GB): not building"
  exit 1
fi
log "ok   the Docker VM has $((free_kb / 1024 / 1024)) GB free"

# ---------------------------------------------------------------- the real images

log "building ${SBX_IMAGE}, ${BRW_IMAGE}, ${EGRESS_IMAGE}"
docker build -q --label "ocw.namespace=${NS}" -t "$SBX_IMAGE" -f infra/sandbox/sbx/Dockerfile infra/sandbox/sbx >/dev/null
docker build -q --label "ocw.namespace=${NS}" -t "$BRW_IMAGE" infra/sandbox/browser >/dev/null
docker build -q --label "ocw.namespace=${NS}" -t "$EGRESS_IMAGE" -f infra/sandbox/egress/Dockerfile . >/dev/null

# ---------------------------------------------------------------- the fake sites (the outside world)

docker network create --internal --label "ocw.namespace=${NS}" "$NET_FIX" >/dev/null
docker run -d --name "$FAKE" --label "ocw.namespace=${NS}" --network "$NET_FIX" \
  --network-alias panel.fake.test --network-alias idp.fake.test --network-alias evil.fake.test \
  --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$ROOT/infra/sandbox/test/fake-site.mjs:/site/fake-site.mjs:ro" "$BASE" node /site/fake-site.mjs >/dev/null
for _ in $(seq 1 50); do
  docker exec "$FAKE" node -e 'fetch("http://127.0.0.1:8080/__stats").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
    >/dev/null 2>&1 && break
  sleep 0.2
done

# ---------------------------------------------------------------- the driver (sandboxd is its child process)

node infra/sandbox/test/stack-smoke.mjs \
  --ns "$NS" --work "$WORK" --fixtures "$NET_FIX" --fake "$FAKE" \
  --sbx "$SBX_IMAGE" --brw "$BRW_IMAGE" --egress "$EGRESS_IMAGE" \
  --seccomp "$ROOT/infra/sandbox/browser/seccomp.json" --only "$ONLY"
