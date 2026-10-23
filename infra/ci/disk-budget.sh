#!/bin/sh
# Keeps the Woodpecker dind daemon (and its /home/ocw-ci scratch dir) inside a disk budget. Runs as the last workflow
# of every pipeline (.woodpecker/housekeeping.yaml) against the dind socket ONLY: never point it at a host daemon.
#
# Workflows of other pipelines may be running on the same daemon (WOODPECKER_MAX_WORKFLOWS > 1), so it never removes
# anything a running workflow could still use:
#   - Always: dangling images (no tag, so no step can name them); stopped containers, unused networks and unused
#     volumes only when older than OCW_CI_STALE_H hours (default 3: a workflow ends within the 120-minute repo timeout,
#     so they belong to finished runs; Woodpecker's own wp_* volumes and networks are unused between two steps);
#     workspaces untouched for 4 hours and failure reports older than 7 days.
#   - Only when no other workflow is running (infra/ci/wp-lib.sh: no live wp_* volume but this one's): `ocw-*:smoke-*`
#     and `ocw-*:ci` images older than OCW_CI_IMAGE_WINDOW_H hours (default 24) and the `ocw-ci:<commit>` step image
#     tags but one, by tag; over budget (dind images + build cache + volumes > OCW_CI_DIND_BUDGET_GB, or host free
#     space < OCW_CI_MIN_HOST_FREE_GB): every unused image except the step image (label ocw.ci.keep=1); scratch dir over
#     OCW_CI_SCRATCH_BUDGET_GB: the pnpm and uv caches. A tag or a cache can be in use between two steps of a running
#     workflow, and a cached build gives a fresh tag an old creation date, so with others running these wait for the
#     next housekeeping run.
#   - Over budget, always: build cache down to OCW_CI_KEEP_CACHE_GB (BuildKit never drops records an active build uses).
# Bot sandboxes (07.8-24): the images workflow keeps ocw-sandboxd/-sbx/-brw/-egress:ci (about 2 GB, the browser image
# alone ~1.2 GB) and a killed smoke leaves its ocw-sandbox-*:smoke-<sha> images (also removed by the next run of its
# slot, infra/ci/slot-reset.sh); the budget carries 2 GB more for them.
set -eu
. "$(dirname "$0")/wp-lib.sh"
BUDGET_GB="${OCW_CI_DIND_BUDGET_GB:-62}"
IMAGE_WINDOW_H="${OCW_CI_IMAGE_WINDOW_H:-24}"
STALE_H="${OCW_CI_STALE_H:-3}"
SCRATCH_BUDGET_GB="${OCW_CI_SCRATCH_BUDGET_GB:-15}"
MIN_HOST_FREE_GB="${OCW_CI_MIN_HOST_FREE_GB:-60}"
KEEP_CACHE_GB="${OCW_CI_KEEP_CACHE_GB:-15}"
SCRATCH="${OCW_CI_SCRATCH:-/home/ocw-ci}"
OWN_STEP_IMAGE="ocw-ci:${CI_COMMIT_SHA:-}"

# docker system df sizes ("1.234GB", "512MB", "0B") summed in GB.
dind_gb() {
  docker system df --format '{{.Size}}' | awk '
    { v = $1; u = v; sub(/[0-9.]+/, "", u); sub(/[A-Za-z]+$/, "", v)
      m = (u == "kB" || u == "KB") ? 1e-6 : (u == "MB") ? 1e-3 : (u == "GB") ? 1 : (u == "TB") ? 1e3 : 0
      s += v * m }
    END { printf "%.1f", s }'
}
scratch_gb() { du -sk "$SCRATCH" 2>/dev/null | awk '{ printf "%.1f", $1 / 1048576 }'; }
host_free_gb() { df -Pk "$SCRATCH" | awk 'NR == 2 { printf "%.0f", $4 / 1048576 }'; }
over() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a > b) }'; }
report() { echo "$1: dind $(dind_gb) GB (budget $BUDGET_GB), scratch $(scratch_gb) GB (budget $SCRATCH_BUDGET_GB), host free $(host_free_gb) GB (min $MIN_HOST_FREE_GB)"; }
older_than_h() { at="$(docker_epoch "$1")" && [ -n "$at" ] && [ $(($(date +%s) - at)) -gt $(($2 * 3600)) ]; }

mkdir -p "$SCRATCH"
report before
docker system df

others="$(wp_other_live_volumes | wc -l | tr -d ' ')"
if [ "$others" -gt 0 ]; then
  echo "$others other workflow(s) running: only objects no running workflow can use are removed"
fi

docker image prune -f >/dev/null
docker container prune -f --filter "until=${STALE_H}h" >/dev/null
docker network prune -f --filter "until=${STALE_H}h" >/dev/null
# `volume prune` has no age filter: unused volumes one by one, by creation date.
for v in $(docker volume ls -q --filter dangling=true); do
  created="$(docker volume inspect --format '{{.CreatedAt}}' "$v" 2>/dev/null)" || continue
  if older_than_h "$created" "$STALE_H"; then docker volume rm "$v" >/dev/null 2>&1 && echo "removed stale volume $v" || true; fi
done
# Workspaces whose cleanup never ran (killed agent) and failure reports older than 7 days.
find "$SCRATCH/ws" "$SCRATCH/tmp" -mindepth 1 -maxdepth 1 -mmin +240 -exec rm -rf {} + 2>/dev/null || true
find "$SCRATCH/artifacts" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null || true

if [ "$others" -eq 0 ]; then
  # Stale smoke and CI images, by tag only (`ocw-*:smoke-*`, `ocw-*:ci`): never another image, never one in use.
  docker image ls --filter 'reference=ocw-*:smoke-*' --filter 'reference=ocw-*:ci' \
    --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | while read -r ref created; do
    if older_than_h "$created" "$IMAGE_WINDOW_H"; then
      docker image rm "$ref" >/dev/null 2>&1 && echo "removed stale image $ref" || true
    fi
  done
  # Step image tags of other commits (and the former shared ocw-ci:local); an image goes once untagged. It keeps this
  # pipeline's tag, or (a push to main builds none) one tag of the newest step image, so the next build stays cached.
  keep="$OWN_STEP_IMAGE"
  docker image inspect "$keep" >/dev/null 2>&1 ||
    keep="$(docker image ls --filter 'reference=ocw-ci:*' --format '{{.Repository}}:{{.Tag}}' | head -n 1)"
  docker image ls --filter 'reference=ocw-ci:*' --format '{{.Repository}}:{{.Tag}}' | while read -r ref; do
    [ "$ref" = "$keep" ] && continue
    docker image rm "$ref" >/dev/null 2>&1 && echo "removed step image tag $ref" || true
  done
  docker image prune -f >/dev/null
fi

if over "$(dind_gb)" "$BUDGET_GB" || over "$MIN_HOST_FREE_GB" "$(host_free_gb)"; then
  echo "over budget: pruning build cache to ${KEEP_CACHE_GB} GB"
  docker builder prune -f --max-used-space "${KEEP_CACHE_GB}gb" >/dev/null
  if [ "$others" -eq 0 ]; then
    echo "over budget: pruning unused images"
    docker image prune -af --filter 'label!=ocw.ci.keep=1' >/dev/null
  else
    echo "over budget: unused images are left to the next housekeeping run without other workflows running"
  fi
fi
if over "$(scratch_gb)" "$SCRATCH_BUDGET_GB" || over "$MIN_HOST_FREE_GB" "$(host_free_gb)"; then
  if [ "$others" -eq 0 ]; then
    echo "scratch over budget: dropping the pnpm and uv caches"
    rm -rf "$SCRATCH/cache"
  else
    echo "scratch over budget: the pnpm and uv caches are in use by other workflows; left to the next run"
  fi
fi

report after
docker system df
