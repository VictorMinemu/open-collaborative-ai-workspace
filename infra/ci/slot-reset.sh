#!/bin/sh
# Removes what an earlier run of THIS CI slot left on the dind daemon (a cancelled run skips its own cleanup step), and
# nothing else. Run it only while holding the slot (infra/ci/slot-lease.sh), so no run of the slot is alive. The slot's
# prefix is ocw-ci-<OCW_CI_SLOT>; it removes exactly the objects whose
#   - compose project (com.docker.compose.project), containers, networks and volumes: the e2e stacks, the proof's
#     postgres/redis and the isolated runner's Garage project,
#   - ocw.namespace label, containers, networks, volumes and images: the sandbox smokes and every sandbox their
#     sandboxd created, the isolated runner's sandboxes, the proofs' cells and the nested gVisor daemon,
#   - name, containers, networks and volumes: the cell smoke's unlabelled objects,
# equal the prefix or start with "<prefix>-". Slot names are never "<another slot>-<suffix>" (infra/ci/slots.test.mjs),
# so another slot's objects never match. Never a prune, never an unprefixed object (Woodpecker's wp_*, a demo, a gate).
set -u
SLOT="${OCW_CI_SLOT:?OCW_CI_SLOT is required}"
PREFIX="ocw-ci-$SLOT"

# Reads "<id> <key>" lines and prints the ids whose key is the prefix or starts with "<prefix>-".
ours() {
  while read -r id key; do
    case "$key" in "$PREFIX" | "$PREFIX"-*) echo "$id" ;; esac
  done
}

ids="$({
  docker ps -a --filter label=com.docker.compose.project --format '{{.ID}} {{.Label "com.docker.compose.project"}}'
  docker ps -a --filter label=ocw.namespace --format '{{.ID}} {{.Label "ocw.namespace"}}'
  docker ps -a --format '{{.ID}} {{.Names}}'
} | ours | sort -u)"
[ -n "$ids" ] && docker rm -fv $ids >/dev/null 2>&1
ids="$({
  docker network ls --filter label=com.docker.compose.project --format '{{.ID}} {{.Label "com.docker.compose.project"}}'
  docker network ls --filter label=ocw.namespace --format '{{.ID}} {{.Label "ocw.namespace"}}'
  docker network ls --format '{{.ID}} {{.Name}}'
} | ours | sort -u)"
[ -n "$ids" ] && docker network rm $ids >/dev/null 2>&1
ids="$({
  docker volume ls --filter label=com.docker.compose.project --format '{{.Name}} {{.Label "com.docker.compose.project"}}'
  docker volume ls --filter label=ocw.namespace --format '{{.Name}} {{.Label "ocw.namespace"}}'
  docker volume ls --format '{{.Name}} {{.Name}}'
} | ours | sort -u)"
[ -n "$ids" ] && docker volume rm -f $ids >/dev/null 2>&1
ids="$(docker image ls --filter label=ocw.namespace --format '{{.ID}} {{.Label "ocw.namespace"}}' | ours | sort -u)"
[ -n "$ids" ] && docker image rm -f $ids >/dev/null 2>&1
echo "slot-reset: objects of $PREFIX removed (compose project, ocw.namespace or name $PREFIX or $PREFIX-*)"
exit 0
