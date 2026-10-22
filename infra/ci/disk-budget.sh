#!/bin/sh
# Keeps the Woodpecker dind daemon (and its /home/ocw-ci scratch dir) inside a disk budget. Runs as the last workflow
# of every pipeline (.woodpecker/housekeeping.yaml) against the dind socket ONLY: never point it at a host daemon.
# Always: dangling images, stopped containers, unused networks/volumes, stale workspaces and old failure reports.
# Over budget (dind images + build cache + volumes > OCW_CI_DIND_BUDGET_GB, scratch dir > OCW_CI_SCRATCH_BUDGET_GB,
# or host free space < OCW_CI_MIN_HOST_FREE_GB): build cache down to OCW_CI_KEEP_CACHE_GB and every unused image
# except ocw-ci (label ocw.ci.keep=1); the pnpm/uv caches are dropped when the scratch dir is over budget.
# Bot sandboxes (07.8-24): the images workflow keeps ocw-sandboxd/-sbx/-brw/-egress:ci (about 2 GB, the browser image
# alone ~1.2 GB) and a killed smoke leaves its ocw-sandbox-*:smoke-<sha> images; the budget carries 2 GB more for them,
# and `:smoke-*` and `:ci` images older than OCW_CI_IMAGE_WINDOW_H hours (default 24) are removed by tag, always.
set -eu
BUDGET_GB="${OCW_CI_DIND_BUDGET_GB:-62}"
IMAGE_WINDOW_H="${OCW_CI_IMAGE_WINDOW_H:-24}"
SCRATCH_BUDGET_GB="${OCW_CI_SCRATCH_BUDGET_GB:-15}"
MIN_HOST_FREE_GB="${OCW_CI_MIN_HOST_FREE_GB:-60}"
KEEP_CACHE_GB="${OCW_CI_KEEP_CACHE_GB:-15}"
SCRATCH=/home/ocw-ci

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

mkdir -p "$SCRATCH"
report before
docker system df

docker container prune -f >/dev/null
docker image prune -f >/dev/null
docker network prune -f >/dev/null
docker volume prune -af >/dev/null
# Stale smoke and CI images, by tag only (`ocw-*:smoke-*`, `ocw-*:ci`): never another image, never one in use.
now="$(date +%s)"
docker image ls --filter 'reference=ocw-*:smoke-*' --filter 'reference=ocw-*:ci' \
  --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | while read -r ref day time _; do
  created="$(date -d "$day $time" +%s 2>/dev/null || echo "$now")"
  if [ $((now - created)) -gt $((IMAGE_WINDOW_H * 3600)) ]; then
    docker image rm "$ref" >/dev/null 2>&1 && echo "removed stale image $ref" || true
  fi
done
# Workspaces whose cleanup never ran (killed agent) and failure reports older than 7 days.
find "$SCRATCH/ws" "$SCRATCH/tmp" -mindepth 1 -maxdepth 1 -mmin +240 -exec rm -rf {} + 2>/dev/null || true
find "$SCRATCH/artifacts" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null || true

if over "$(dind_gb)" "$BUDGET_GB" || over "$MIN_HOST_FREE_GB" "$(host_free_gb)"; then
  echo "over budget: pruning build cache to ${KEEP_CACHE_GB} GB and unused images"
  docker builder prune -f --max-used-space "${KEEP_CACHE_GB}gb" >/dev/null
  docker image prune -af --filter 'label!=ocw.ci.keep=1' >/dev/null
fi
if over "$(scratch_gb)" "$SCRATCH_BUDGET_GB" || over "$MIN_HOST_FREE_GB" "$(host_free_gb)"; then
  echo "scratch over budget: dropping the pnpm and uv caches"
  rm -rf "$SCRATCH/cache"
fi

report after
docker system df
