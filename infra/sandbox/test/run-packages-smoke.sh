#!/usr/bin/env bash
# Real-Docker sandbox packages smoke (07.8-17; D-03, D-11 F-3, P-12, P-13; SBX-04). Builds the real `sbx` and
# `sandbox-egress` images, starts the offline fake registries (infra/sandbox/test/fake-registry.mjs: npm, PyPI,
# ClawHub; generated at start, no real registry is ever contacted) on a fixtures network, and drives a host-process
# sandboxd through its HTTP API only (packages-smoke.mjs), as the API does:
#
#   npm      review resolves the whole tree (two entries, one dependency, install script, lockfile, tree hash) in a
#            review container; install for bot A runs `npm ci` from the recorded lockfile in an installer container
#            (the postinstall marker shows it ran there, as 10001); A's exec runs the CLI and its dependency; the
#            volume is read-only in `sbx`; bot B sees nothing; installs are idempotent and serialised per bot; a
#            sha1-only package is reviewed and refused at install; a forged tree is `tree_changed`; the kill switch
#            refuses installs; a dependency republished after approval is `digest_mismatch` and bot C's volume stays
#            empty while A keeps working
#   pypi     review records both wheels' sha256 and a hashed requirement set; install with `--no-deps
#            --require-hashes`; A imports it; a republished dependency is `digest_mismatch`, C unchanged
#   clawhub  the bundle extracts to /opt/ocw-packages/skills/<name>; a swapped tarball is `digest_mismatch`
#   remove   one package's files go, the others stay
#
# Debian is unit-proven only (no real mirror in tests); the real install is a manual VALIDATION row.
#
# Usage (repo root):  bash infra/sandbox/test/run-packages-smoke.sh [--only npm|all]
#   DOCKER_SOCKET=<path> the daemon socket (default: the current docker context's unix socket)
#
# Every Docker object carries `ocw.namespace=ocw-smoke-pkg-<pid>` (the fixtures by the smoke, every sandbox object by
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
case "$ONLY" in all | npm) ;; *)
  printf 'unknown --only: %s (npm or all)\n' "$ONLY" >&2
  exit 2
  ;;
esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

# The label namespace (CI sets OCW_SMOKE_NS_PREFIX to its slot's, infra/ci/slot-reset.sh; default ocw-smoke).
NS="${OCW_SMOKE_NS_PREFIX:-ocw-smoke}-pkg-$$"
SHA="$(git rev-parse --short=12 HEAD)"
SBX_IMAGE="ocw-sandbox-sbx:smoke-${SHA}"
EGRESS_IMAGE="ocw-sandbox-egress:smoke-${SHA}"
BASE="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"
NET_FIX="${NS}-fixtures"
FAKE="${NS}-registry"
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
  docker image rm -f "$SBX_IMAGE" "$EGRESS_IMAGE" >/dev/null 2>&1 || true
  if [ "$left" != "0" ]; then
    log "FAIL ${left} object(s) labelled ocw.namespace=${NS} left after cleanup"
    code=1
  fi
  for image in "$SBX_IMAGE" "$EGRESS_IMAGE"; do
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

log "building ${SBX_IMAGE}, ${EGRESS_IMAGE}"
docker build -q --label "ocw.namespace=${NS}" -t "$SBX_IMAGE" -f infra/sandbox/sbx/Dockerfile infra/sandbox/sbx >/dev/null
docker build -q --label "ocw.namespace=${NS}" -t "$EGRESS_IMAGE" -f infra/sandbox/egress/Dockerfile . >/dev/null

# ---------------------------------------------------------------- the fake registries (the outside world)

docker network create --internal --label "ocw.namespace=${NS}" "$NET_FIX" >/dev/null
docker run -d --name "$FAKE" --label "ocw.namespace=${NS}" --network "$NET_FIX" \
  --network-alias registry.fake.test \
  --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$ROOT/infra/sandbox/test/fake-registry.mjs:/registry/fake-registry.mjs:ro" "$BASE" \
  node /registry/fake-registry.mjs 8080 >/dev/null
for _ in $(seq 1 50); do
  docker exec "$FAKE" node -e 'fetch("http://127.0.0.1:8080/__stats").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
    >/dev/null 2>&1 && break
  sleep 0.2
done

# ---------------------------------------------------------------- the driver (sandboxd is its child process)

node infra/sandbox/test/packages-smoke.mjs \
  --ns "$NS" --work "$WORK" --fixtures "$NET_FIX" --fake "$FAKE" \
  --sbx "$SBX_IMAGE" --egress "$EGRESS_IMAGE" --only "$ONLY"
