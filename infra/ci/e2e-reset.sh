#!/bin/sh
# Takes down every e2e compose stack (projects ocw-e2e-*) with its volumes. A cancelled run skips its cleanup step and
# its stack would hold the published ports the next run needs. Only one workflow runs at a time on the CI daemon.
for p in $(docker ps -a --filter label=com.docker.compose.project --format '{{.Label "com.docker.compose.project"}}' |
  grep '^ocw-e2e-' | sort -u); do
  docker compose -p "$p" down -v --remove-orphans
done
