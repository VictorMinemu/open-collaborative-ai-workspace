#!/usr/bin/env bash
# Spike (iii), 07.8-03: the sandboxd lifecycle inside the Woodpecker dind. Throwaway; run from a workstation:
#
#   bash .planning/phases/07.8-bot-sandboxes-plugins-and-live-browser/spikes/dind-lifecycle/run.sh > report.json
#
# Every Docker command goes to the Woodpecker dind daemon (`docker exec woodpecker-dind docker …` over ssh), never to
# the CI host's own daemon. The dind daemon is not reconfigured or restarted. Every object carries ocw.spike=07.8 and
# the EXIT trap removes containers, networks and volumes by that label and the two spike images by name.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${SPIKE_HOST:-hetzner-ci}"
DIND="${SPIKE_DIND:-woodpecker-dind}"
NODE_IMAGE="node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
BOT_IMAGE="ocw-spike-078-bot:spike"

# Run a command in the dind container; arguments are quoted for the remote shell.
dind() { ssh "$HOST" "docker exec -i $DIND $(printf '%q ' "$@")"; }

cleanup() {
  dind sh -c '
    ids=$(docker ps -aq --filter label=ocw.spike=07.8; docker ps -aq --filter label=ocw.spike-runner=07.8)
    [ -z "$ids" ] || docker rm -fv $ids >/dev/null
    for n in $(docker network ls -q --filter label=ocw.spike=07.8); do docker network rm "$n" >/dev/null; done
    for v in $(docker volume ls -q --filter label=ocw.spike=07.8); do docker volume rm "$v" >/dev/null; done
    docker image rm -f '"$BOT_IMAGE"' >/dev/null 2>&1 || true' >&2 || true
}
trap cleanup EXIT

# Precondition: no pipeline step is running in the dind.
running="$(dind docker ps -q | wc -l | tr -d ' ')"
[[ "$running" == "0" ]] || { echo "dind is busy ($running containers): wait for the pipeline" >&2; exit 1; }

echo "== pull ${NODE_IMAGE%@*} by digest and build $BOT_IMAGE (/workspace owned by 10001, Pitfall 4)" >&2
dind docker pull -q "$NODE_IMAGE" >&2
printf 'FROM %s\nRUN mkdir -p /workspace && chown 10001:10001 /workspace\nLABEL ocw.spike=07.8\n' "$NODE_IMAGE" |
  dind docker build -q -t "$BOT_IMAGE" - >&2

echo "== run lifecycle.mjs from a step-like node container with the dind socket mounted" >&2
# The runner carries ocw.spike-runner (not ocw.spike): lifecycle.mjs kills everything labelled ocw.spike=07.8.
dind docker run -i --rm --name ocw-spike-078-runner --label ocw.spike-runner=07.8 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SPIKE_IMAGE="$BOT_IMAGE" "$NODE_IMAGE" node --input-type=module - <"$HERE/lifecycle.mjs"
