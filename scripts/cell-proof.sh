#!/usr/bin/env bash
# Real-cell proof of the Phase 3.1 owner's done-criterion: a real OpenClaw cell next to the isolated e2e stack installs
# the official DuckDuckGo plugin from the REAL ClawHub through the admin's pinned approval, a personal bot searches the
# REAL web with it, calls a (fake) MCP server's tool in the same private chat, both calls are audited, and after the
# uninstall the next turn has no web_search. The model is the deterministic fake. Run it only through the isolated stack:
#
#   OCW_BUNDLED_PLUGINS=none OCW_E2E_API_HOST=0.0.0.0 OCW_E2E_CLAWHUB_URL=https://clawhub.ai \
#     OCW_MOCK_MODEL_BASE_URL=http://fake-model:18999/v1 PROOF_BUILD=1 \
#     bash scripts/e2e-isolated.sh --cmd "bash scripts/cell-proof.sh"
#
# CI runs it on demand (.github/workflows/cell-proof.yml, PR label `cell-proof`). It creates ONLY containers, a network
# and a volume named ocw-proof-*, all removed by the EXIT trap, and reads the ocw_e2e database read-only.
#   PROOF_BUILD=1          build ocw-openclaw:local and ocw-fake-model:local from this tree first (else they must exist)
#   PROOF_OUT=<dir>        where audit.tsv and cell.log are written (default: a temp dir)
#   PROOF_SUBNET           proof network subnet (default 10.231.79.0/24)
#   PROOF_CELL_MEMORY      optional hard memory cap for the cell (e.g. 2g)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

P=ocw-proof
NET="${P}-net"
VOL="${P}-state"
CELL="${P}-openclaw"
MODEL="${P}-model"
MCP_TOKEN=proof-mcp-token
OUT="${PROOF_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ocw-proof-out.XXXXXX")}"
mkdir -p "$OUT"
SECRETS="$(mktemp -d "${TMPDIR:-/tmp}/ocw-proof.XXXXXX")"
chmod 711 "$SECRETS"

fail() { echo "cell-proof: $*" >&2; exit 1; }

# ---------------------------------------------------------------- preconditions
command -v docker >/dev/null || fail "docker is required"
[[ -n "${OCW_E2E_API_URL:-}" ]] || fail "OCW_E2E_API_URL is not set: run through scripts/e2e-isolated.sh --cmd"
API_PORT="$(node -e 'console.log(new URL(process.argv[1]).port)' "$OCW_E2E_API_URL")"
[[ -n "${OCW_CELL_TOKEN:-}" ]] || fail "OCW_CELL_TOKEN is not set (.env)"
[[ "${OCW_BUNDLED_PLUGINS:-}" == "none" ]] ||
  fail "OCW_BUNDLED_PLUGINS must be 'none': web search must come from the marketplace install to be attributable to it"
case "${OCW_CLAWHUB_URL:-}" in
  https://*) ;;
  *) fail "OCW_CLAWHUB_URL is '${OCW_CLAWHUB_URL:-}': the proof needs the real ClawHub (OCW_E2E_CLAWHUB_URL=https://clawhub.ai)" ;;
esac
case "${MIGRATE_SUPERUSER_URL:-}" in
  */ocw_e2e | */ocw_e2e\?*) ;;
  *) fail "MIGRATE_SUPERUSER_URL does not target ocw_e2e (run through scripts/e2e-isolated.sh)" ;;
esac
case "${OCW_MOCK_MODEL_BASE_URL:-http://fake-model:18999/v1}" in
  http://fake-model:18999/*) ;;
  *) fail "OCW_MOCK_MODEL_BASE_URL must be http://fake-model:18999/v1 (the proof's fake model container)" ;;
esac
for name in "$CELL" "$MODEL"; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then fail "$name already exists (another proof running?)"; fi
done

if [[ "${PROOF_BUILD:-0}" == "1" ]]; then
  echo "== build ocw-openclaw:local and ocw-fake-model:local from this tree"
  docker build -q -f infra/openclaw/Dockerfile -t ocw-openclaw:local . >/dev/null
  docker build -q -f infra/fake-model/Dockerfile -t ocw-fake-model:local . >/dev/null
fi
for image in ocw-openclaw:local ocw-fake-model:local; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "image $image is missing (PROOF_BUILD=1 builds it)"
done
FREE_KB="$(docker run --rm --entrypoint df ocw-fake-model:local -Pk / | awk 'NR==2 {print $4}')"
[[ "${FREE_KB:-0}" -ge 1048576 ]] || fail "less than 1 GB free on the Docker VM (${FREE_KB:-?} KB): not starting a cell"

cleanup() {
  local status=$?
  set +e
  if [[ $status -ne 0 ]]; then
    echo "== FAILURE DIAGNOSTICS (exit $status): docker logs $CELL (last 120 lines)" >&2
    docker logs "$CELL" 2>&1 | tail -120 >&2
  fi
  docker logs "$CELL" >"$OUT/cell-full.log" 2>&1
  tail -400 "$OUT/cell-full.log" >"$OUT/cell.log" 2>/dev/null
  rm -f "$OUT/cell-full.log"
  docker logs "$MODEL" 2>&1 | tail -100 >"$OUT/fake-model.log"
  docker rm -f "$CELL" "$MODEL" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$SECRETS"
  echo "cell-proof: outputs in $OUT"
  exit "$status"
}
trap cleanup EXIT

umask 022
printf '%s' "$OCW_CELL_TOKEN" >"$SECRETS/cell_token"

# ---------------------------------------------------------------- network (with egress), fake model + MCP, cell
echo "== network $NET (egress allowed: real ClawHub and DuckDuckGo are part of the proof)"
docker network create --subnet "${PROOF_SUBNET:-10.231.79.0/24}" "$NET" >/dev/null
OOM=(--oom-score-adj 1000)

docker run -d --name "$MODEL" "${OOM[@]}" --network "$NET" --network-alias fake-model \
  --add-host host.docker.internal:host-gateway -e FAKE_MCP_TOKEN="$MCP_TOKEN" ocw-fake-model:local >/dev/null
for _ in $(seq 1 30); do
  docker exec "$MODEL" node -e "fetch('http://127.0.0.1:18999/v1/models').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))" \
    2>/dev/null && break
  sleep 1
done

echo "== the isolated API must be reachable from the proof network (host.docker.internal:$API_PORT)"
reach=""
for _ in $(seq 1 5); do
  reach="$(docker exec "$MODEL" node -e "fetch('http://host.docker.internal:$API_PORT/health').then(async (r) => console.log(r.status, await r.text())).catch((e) => console.log('unreachable', e.cause?.code ?? e.message))")"
  [[ "$reach" == 200* ]] && break
  sleep 2
done
echo "   $reach"
if [[ "$reach" != 200* ]]; then
  fail "the cell cannot reach the API on host.docker.internal:$API_PORT; start the stack with OCW_E2E_API_HOST=0.0.0.0 (disposable hosts only)"
fi

echo "== real OpenClaw cell $CELL (OCW_BUNDLED_PLUGINS=none, ClawHub $OCW_CLAWHUB_URL)"
CELL_LIMIT=()
[[ -n "${PROOF_CELL_MEMORY:-}" ]] && CELL_LIMIT=(--memory "$PROOF_CELL_MEMORY")
docker run -d --name "$CELL" "${OOM[@]}" ${CELL_LIMIT[@]+"${CELL_LIMIT[@]}"} --network "$NET" \
  --add-host host.docker.internal:host-gateway \
  -v "$VOL:/home/node/.openclaw" \
  -v "$SECRETS/cell_token:/run/secrets/ocw_cell_token:ro" \
  -e OCW_API_URL="http://host.docker.internal:$API_PORT" \
  -e OCW_CELL_TOKEN_FILE=/run/secrets/ocw_cell_token \
  -e OCW_BUNDLED_PLUGINS=none \
  -e OCW_CLAWHUB_URL="$OCW_CLAWHUB_URL" \
  -e NODE_OPTIONS=--max-old-space-size=512 \
  ocw-openclaw:local >/dev/null

echo "== waiting for the cell's agent channel"
connected=0
for _ in $(seq 1 150); do
  logs="$(docker logs "$CELL" 2>&1)"
  if grep -q "agent channel connected" <<<"$logs"; then connected=1; break; fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$CELL")" == "true" ]] || fail "the cell exited"
  sleep 2
done
[[ "$connected" == "1" ]] || fail "the cell did not connect within 300 s"
grep -E "base config rendered|agent channel connected" <<<"$logs" | sed 's/^/   /'

# ---------------------------------------------------------------- the proof (Playwright, real browser)
status=0
started="$(date +%s)"
OCW_PROOF_DB_URL="$MIGRATE_SUPERUSER_URL" OCW_PROOF_MCP_URL="http://fake-model:18999/mcp" \
  OCW_PROOF_MCP_TOKEN="$MCP_TOKEN" pnpm exec playwright test -c e2e/playwright.proof.config.ts || status=$?
echo "== proof run: exit $status in $(($(date +%s) - started)) s"

# ---------------------------------------------------------------- audit rows (read-only) and the cell log
echo "== audit rows (app.audit_events: bot.tool_call*, plugin.*)"
(cd packages/db && OCW_PROOF_DB_URL="$MIGRATE_SUPERUSER_URL" node --input-type=module -e '
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.OCW_PROOF_DB_URL });
await c.connect();
const { rows } = await c.query(`select occurred_at::text as at, action, coalesce(metadata->>$$tool$$, $$$$) as tool,
  coalesce(metadata->>$$target$$, $$$$) as target, result, coalesce(metadata->>$$status$$, $$$$) as status,
  coalesce(metadata->>$$provider$$, $$$$) as provider, coalesce(metadata->>$$resultCount$$, $$$$) as count
  from app.audit_events where action like $$bot.tool_call%$$ or action like $$plugin.%$$ order by occurred_at, id`);
await c.end();
const lines = rows.map((r) => [r.at, r.action, r.tool, r.target, r.result, r.status, r.provider, r.count].join("\t"));
console.log(["at\taction\ttool\ttarget\tresult\tstatus\tprovider\tresultCount", ...lines].join("\n"));
') | tee "$OUT/audit.tsv" | sed 's/^/   /'
# row <action> <tool regex> <target regex> <result>: is there such an audit row?
row() { awk -F'\t' -v a="$1" -v t="$2" -v g="$3" -v r="$4" '$2 == a && $3 ~ t && $4 ~ g && $5 == r { f = 1 } END { exit !f }' "$OUT/audit.tsv"; }
if [[ $status -eq 0 ]]; then
  row bot.tool_call '^web_search$' '^duckduckgo[.]com$' success ||
    { echo "cell-proof: no successful bot.tool_call row for web_search"; status=1; }
  row bot.tool_call '^m[0-9a-f]+__echo$' '^m[0-9a-f]+$' success ||
    { echo "cell-proof: no successful bot.tool_call row for the MCP echo tool"; status=1; }
  for a in plugin.install_requested plugin.installed plugin.uninstall_requested plugin.uninstalled; do
    row "$a" '' '' success || { echo "cell-proof: no successful $a audit row"; status=1; }
  done
fi
echo "== cell log (last 50 lines)"
docker logs "$CELL" 2>&1 | tail -50 | sed 's/^/   /'
exit "$status"
