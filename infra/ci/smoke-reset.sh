#!/bin/sh
# Removes what the smokes and proofs create with their DEFAULT names when a run was killed before its own EXIT trap
# could (local runs; infra/sandbox/test/run-orphans-check.sh calls it). CI does not use it: its workflows run in
# parallel, each removing only its own slot's objects with infra/ci/slot-reset.sh (ocw-ci-<slot>-*, which this never
# matches). Safe when nothing is left. Never a prune, never another namespace.
#   - infra/openclaw/test/run-container-smoke.sh: fixed names, prefix ocw-smoke.
#   - Bot sandbox smokes and proofs (07.8-24): containers, volumes and networks labelled `ocw.namespace=` one of
#     ocw-smoke-* (infra/sandbox/test/run-*.sh, their fixtures and every object their sandboxd creates, which also
#     carries ocw.sandbox=1), ocw-e2e (scripts/e2e-isolated.sh --sandbox) or ocw-proof-* (scripts/sandbox-proof.sh and
#     the other real-cell proofs). Objects of any other namespace (a gate stack, an install) are left alone.
docker rm -fv ocw-smoke-openclaw ocw-smoke-api ocw-smoke-model ocw-smoke-mcp-sandbox >/dev/null 2>&1 || true
docker volume rm ocw-smoke-state >/dev/null 2>&1 || true
docker network rm ocw-smoke-net ocw-smoke-sbx-net >/dev/null 2>&1 || true

# Reads "<id> <namespace>" lines and prints the ids whose namespace is one of ours.
ours() {
  while read -r id ns; do
    case "$ns" in
      ocw-smoke-* | ocw-e2e | ocw-proof-*) echo "$id" ;;
    esac
  done
}

ids="$(docker ps -a --filter label=ocw.namespace --format '{{.ID}} {{.Label "ocw.namespace"}}' | ours)"
[ -n "$ids" ] && docker rm -fv $ids >/dev/null 2>&1
ids="$(docker network ls --filter label=ocw.namespace --format '{{.ID}} {{.Label "ocw.namespace"}}' | ours)"
[ -n "$ids" ] && docker network rm $ids >/dev/null 2>&1
ids="$(docker volume ls --filter label=ocw.namespace --format '{{.Name}} {{.Label "ocw.namespace"}}' | ours)"
[ -n "$ids" ] && docker volume rm -f $ids >/dev/null 2>&1
echo "smoke-reset: smoke, e2e and proof objects removed (ocw.namespace ocw-smoke-*, ocw-e2e, ocw-proof-*)"
exit 0
