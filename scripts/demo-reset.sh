#!/usr/bin/env bash
# Resets the LOCAL demo database to an empty instance and re-runs migrations, then seeds the demo
# workspace. Destroys all data in this worktree's postgres volume — local demo use only.
#   scripts/demo-reset.sh            # reset + seed (API must be running on OCW_API_URL)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
project="$(docker compose config --format json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).name)')"
docker compose rm -sfv postgres >/dev/null
docker volume rm "${project}_pgdata" >/dev/null 2>&1 || true
docker compose up -d --wait postgres redis
pnpm db:migrate
# The running API reconnects lazily after the database was recreated: wait until it reports db ok.
api="${OCW_API_URL:-http://localhost:4000}"
for _ in $(seq 1 30); do curl -sf -m 2 "$api/health" | grep -q '"db":"ok"' && break; sleep 1; done
node scripts/demo-seed.mjs
