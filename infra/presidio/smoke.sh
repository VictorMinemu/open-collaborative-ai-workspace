#!/usr/bin/env bash
# Live smoke of the optional `pii` profile (MEM-05, D-06, D-08). Opt-in, never run by `pnpm verify`:
#   bash infra/presidio/smoke.sh
# Builds the derived image (tag ocw-presidio:pii-smoke-<pid>, or OCW_PII_SMOKE_TAG), starts infra/presidio/compose.yaml
# under its own project ocw-pii-smoke-<pid> with the real hardening, and probes it from a throwaway client container
# (the same image, entrypoint curl) on the internal network: health, cold start, Spanish (ES_NIF, PERSON) and English
# (EMAIL_ADDRESS) analysis, response shape, read-only root and no egress. Only fixed sample texts are sent; only entity
# types, offsets and timings are printed. On exit it removes its own project, and the image tag if it created it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="ocw-pii-smoke-$$"
TAG="${OCW_PII_SMOKE_TAG:-pii-smoke-$$}"
IMAGE="ocw-presidio:${TAG}"
NETWORK="${PROJECT}_pii"
ENTITIES='["PERSON","LOCATION","ES_NIF","ES_NIE","IBAN_CODE","CREDIT_CARD","EMAIL_ADDRESS","PHONE_NUMBER","IP_ADDRESS"]'

case "$TAG" in
  local) echo "smoke: refusing tag :local (reserved for the running stack)" >&2; exit 2 ;;
esac

created_image=0
docker image inspect "$IMAGE" >/dev/null 2>&1 || created_image=1

compose() {
  OCW_IMAGE_TAG="$TAG" docker compose -p "$PROJECT" --project-directory "$HERE" -f "$HERE/compose.yaml" --profile pii "$@"
}

# shellcheck disable=SC2329 # invoked by the trap below
cleanup() {
  local rc=$?
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  for c in $(docker ps -aq --filter "name=^${PROJECT}-client"); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  if [ "$created_image" = 1 ]; then docker image rm "$IMAGE" >/dev/null 2>&1 || true; fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

client() {
  docker run --rm --name "${PROJECT}-client-$RANDOM" --network "$NETWORK" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint curl "$IMAGE" -sS --max-time 30 "$@"
}

analyze() { # $1 language, $2 text (fixed samples only)
  local body
  body=$(printf '{"text":"%s","language":"%s","entities":%s,"score_threshold":0.5}' "$2" "$1" "$ENTITIES")
  client -X POST -H 'content-type: application/json' --data "$body" http://presidio:3000/analyze
}

types_of() { # entity types and offsets of a JSON array on stdin
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
  node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const a = JSON.parse(s);
      if (!Array.isArray(a)) { console.error("not an array"); process.exit(1); }
      for (const x of a) console.log(`${x.entity_type} [${x.start},${x.end}) score=${x.score}`);
      if (a[0]) console.log(`shape: ${Object.keys(a[0]).sort().join(",")}`);
    });'
}

echo "smoke: building $IMAGE"
compose build --quiet presidio
size=$(docker image inspect -f '{{.Size}}' "$IMAGE")
echo "smoke: image size $((size / 1024 / 1024)) MiB"

echo "smoke: starting project $PROJECT"
started=$(node -e 'console.log(Date.now())')
compose up -d --no-build presidio >/dev/null
for _ in $(seq 1 240); do
  if client -f -o /dev/null http://presidio:3000/health 2>/dev/null; then break; fi
  sleep 0.5
done
client -f -o /dev/null http://presidio:3000/health || { echo "smoke: presidio never became healthy" >&2; compose logs --tail 40 presidio >&2; exit 1; }
ready=$(node -e 'console.log(Date.now())')
echo "smoke: cold start $(( (ready - started) / 1000 )).$(( (ready - started) % 1000 / 100 )) s (up to /health 200)"

cid=$(compose ps -q presidio)
echo "smoke: container read-only root: $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid"), cap_drop: $(docker inspect -f '{{.HostConfig.CapDrop}}' "$cid"), ports: $(docker port "$cid" | wc -l | tr -d ' ')"
if docker exec "$cid" sh -c 'touch /app/ocw-smoke-write' 2>/dev/null; then
  echo "smoke: FAIL the root filesystem is writable" >&2; exit 1
fi
if docker exec "$cid" curl -sS -m 5 -o /dev/null https://github.com 2>/dev/null; then
  echo "smoke: FAIL the container has egress" >&2; exit 1
fi
echo "smoke: no write to the root filesystem, no egress"

es=$(analyze es 'Reunión con Ana García en Valencia. Su DNI es 12345678Z y su correo ana@acme.com.')
echo "smoke: es →"; printf '%s' "$es" | types_of | sed 's/^/  /'
en=$(analyze en 'Please email john.smith@example.com about the invoice for John Smith.')
echo "smoke: en →"; printf '%s' "$en" | types_of | sed 's/^/  /'

fail=0
for want in ES_NIF PERSON; do
  printf '%s' "$es" | grep -q "\"entity_type\": \"$want\"" || { echo "smoke: FAIL es missing $want" >&2; fail=1; }
done
printf '%s' "$en" | grep -q '"entity_type": "EMAIL_ADDRESS"' || { echo "smoke: FAIL en missing EMAIL_ADDRESS" >&2; fail=1; }

t0=$(node -e 'console.log(Date.now())')
analyze es 'Su DNI es 12345678Z.' >/dev/null
t1=$(node -e 'console.log(Date.now())')
echo "smoke: warm es request (incl. client container start) $((t1 - t0)) ms"
echo "smoke: memory $(docker stats --no-stream --format '{{.MemUsage}}' "$cid")"

[ "$fail" = 0 ] && echo "smoke: OK (ES_NIF, PERSON, EMAIL_ADDRESS)"
exit "$fail"
