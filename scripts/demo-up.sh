#!/usr/bin/env bash
# Starts the local demo stack: postgres + redis (compose), API and web (native, production build of
# the web), and the OpenClaw cell (container talking to the native API). Idempotent: services that
# are already up are left alone. Logs: ~/.ocw-demo/logs/.
#   pnpm demo:up            # start
#   pnpm demo:up --rebuild  # also rebuild the web app first
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
STATE="$HOME/.ocw-demo"
mkdir -p "$STATE/logs"
# Owner-only directory: the cell token below is 0644 only so the container user can read it through
# the bind mount; the 0700 parent keeps it unreachable for other local users.
chmod 700 "$STATE"
[[ -f .env ]] || { echo "No .env: run pnpm setup:env first"; exit 1; }

up() { curl -sf -m 2 "$1" >/dev/null; }

docker compose up -d --wait postgres redis
pnpm db:migrate >/dev/null

if ! up http://localhost:4000/health; then
  (cd apps/api && nohup node --env-file-if-exists=../../.env --import tsx src/main.ts >"$STATE/logs/api.log" 2>&1 &)
  for _ in $(seq 1 30); do up http://localhost:4000/health && break; sleep 1; done
fi
echo "api  http://localhost:4000  $(curl -s http://localhost:4000/health)"

if [[ "${1:-}" == "--rebuild" || ! -f apps/web/.next/BUILD_ID ]]; then
  (cd apps/web && pnpm build >"$STATE/logs/web-build.log" 2>&1)
fi
if ! up http://localhost:3000/login; then
  (cd apps/web && nohup node --env-file-if-exists=../../.env ./node_modules/next/dist/bin/next start -p 3000 >"$STATE/logs/web.log" 2>&1 &)
  for _ in $(seq 1 30); do up http://localhost:3000/login && break; sleep 1; done
fi
echo "web  http://localhost:3000"

# OpenClaw cell: the token file lives outside the repo, inside the owner-only $STATE directory.
(set -a; . ./.env; set +a; umask 022; printf '%s' "$OCW_CELL_TOKEN" >"$STATE/cell_token")
docker network inspect ocw-demo-net >/dev/null 2>&1 || docker network create --subnet 10.231.78.0/24 ocw-demo-net >/dev/null
docker image inspect ocw-openclaw:local >/dev/null 2>&1 || docker build -q -f infra/openclaw/Dockerfile -t ocw-openclaw:local "$ROOT" >/dev/null
if ! docker ps --format '{{.Names}}' | grep -qx ocw-demo-openclaw; then
  docker rm ocw-demo-openclaw >/dev/null 2>&1 || true
  docker run -d --name ocw-demo-openclaw --network ocw-demo-net --restart unless-stopped \
    --memory 2g --stop-timeout 30 --add-host host.docker.internal:host-gateway \
    -v ocw-demo-openclaw-state:/home/node/.openclaw \
    -v "$STATE/cell_token:/run/secrets/ocw_cell_token:ro" \
    -e OCW_API_URL=http://host.docker.internal:4000 \
    -e OCW_CELL_TOKEN_FILE=/run/secrets/ocw_cell_token \
    -e NODE_OPTIONS=--max-old-space-size=512 \
    ocw-openclaw:local >/dev/null
fi
# Capture first: `docker logs | grep -q` under pipefail fails on SIGPIPE and would never break.
for _ in $(seq 1 120); do grep -q "subscribed to cell" <<<"$(docker logs ocw-demo-openclaw 2>&1)" && break; sleep 2; done
echo "bots $(docker logs ocw-demo-openclaw 2>&1 | grep '\[ocw\]' | tail -1)"
