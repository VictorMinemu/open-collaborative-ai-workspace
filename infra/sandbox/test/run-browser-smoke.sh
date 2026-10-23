#!/usr/bin/env bash
# Real-Chromium smoke of the bot browser image (07.8-07): builds `ocw-sandbox-brw:smoke-<sha>`, starts the fake sites
# on a private internal network (aliases panel.fake.test, idp.fake.test, evil.fake.test), runs the agent hardened as
# sandboxd would and drives it over its stdio (browser-smoke.mjs). Includes the E1 password-leak regression.
#
#   bash infra/sandbox/test/run-browser-smoke.sh                 # every step
#   bash infra/sandbox/test/run-browser-smoke.sh --only open     # open|masking|state|downloads|resize|lock|errors|fixtures
#   CAPTURE_FIXTURES=1 bash infra/sandbox/test/run-browser-smoke.sh --only fixtures   # rewrites the UI frame fixtures
#
# Every object carries `ocw.namespace=ocw-smoke-<pid>` and is removed by that label before and after the run, with the
# smoke image tag. The runtime is the host's default (runc): Chromium's own sandbox is tried with seccomp.json and the
# agent reports `container-only` if the host forbids unprivileged user namespaces (D-14). No port is published.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# The label namespace (CI sets OCW_SMOKE_NS_PREFIX to its slot's, infra/ci/slot-reset.sh; default ocw-smoke).
NS="${OCW_SMOKE_NS_PREFIX:-ocw-smoke}-$$"
SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
IMAGE="ocw-sandbox-brw:smoke-$SHA"
BASE="node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
NET="$NS-net"
FAKE="$NS-fake"

cleanup() {
  local ids
  ids="$(docker ps -aq --filter "label=ocw.namespace=$NS")"
  [[ -z "$ids" ]] || docker rm -fv $ids >/dev/null 2>&1 || true
  for n in $(docker network ls -q --filter "label=ocw.namespace=$NS"); do docker network rm "$n" >/dev/null 2>&1 || true; done
  for v in $(docker volume ls -q --filter "label=ocw.namespace=$NS"); do docker volume rm "$v" >/dev/null 2>&1 || true; done
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  for i in $(docker image ls -q --filter "label=ocw.namespace=$NS"); do docker image rm -f "$i" >/dev/null 2>&1 || true; done
}
cleanup
trap cleanup EXIT

echo "== build $IMAGE" >&2
docker build -q --label "ocw.namespace=$NS" -t "$IMAGE" "$ROOT/infra/sandbox/browser" >&2
docker image inspect "$IMAGE" --format 'image size {{.Size}} bytes' >&2

echo "== fake sites on $NET" >&2
docker network create --internal --label "ocw.namespace=$NS" "$NET" >/dev/null
docker run -d --name "$FAKE" --label "ocw.namespace=$NS" --network "$NET" \
  --network-alias panel.fake.test --network-alias idp.fake.test --network-alias evil.fake.test \
  --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$HERE/fake-site.mjs:/site/fake-site.mjs:ro" "$BASE" node /site/fake-site.mjs >/dev/null
for _ in $(seq 1 50); do
  docker exec "$FAKE" node -e 'fetch("http://127.0.0.1:8080/__stats").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
    >/dev/null 2>&1 && break
  sleep 0.2
done

node "$HERE/browser-smoke.mjs" --image "$IMAGE" --network "$NET" --ns "$NS" --fake "$FAKE" \
  --seccomp "$ROOT/infra/sandbox/browser/seccomp.json" "$@"
