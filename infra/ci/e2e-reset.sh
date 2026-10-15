#!/bin/sh
# Takes down every e2e compose stack (projects ocw-e2e-*) with its volumes. A cancelled run skips its cleanup step and
# its stack would hold the published ports the next run needs. Only one workflow runs at a time on the CI daemon.
for p in $(docker ps -a --filter label=com.docker.compose.project --format '{{.Label "com.docker.compose.project"}}' |
  grep '^ocw-e2e-' | sort -u); do
  docker compose -p "$p" down -v --remove-orphans
done

# Bot sandboxes (07.8-08, P-13): a killed `scripts/e2e-isolated.sh --sandbox` run or sandbox proof leaves the objects of
# its label namespace behind (ocw.namespace=ocw-e2e for the broker's sandboxes, ocw-proof-sandbox for the proof's cell).
# Removed by that label only: never a prune, never another namespace.
for ns in ocw-e2e ocw-proof-sandbox; do
  ids="$(docker ps -aq --filter "label=ocw.namespace=$ns")"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null
  ids="$(docker volume ls -q --filter "label=ocw.namespace=$ns")"
  [ -n "$ids" ] && docker volume rm -f $ids >/dev/null
  ids="$(docker network ls -q --filter "label=ocw.namespace=$ns")"
  [ -n "$ids" ] && docker network rm $ids >/dev/null
  echo "e2e-reset: objects labelled ocw.namespace=$ns removed"
done
exit 0
