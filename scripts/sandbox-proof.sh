#!/usr/bin/env bash
# Phase 07.8 tracer, end to end (07.8-08 Task 1; D-01, D-02, D-09, SBX-01, SBX-02): a REAL OpenClaw cell next to the
# isolated e2e stack, talking to the REAL API, whose sandbox broker is the REAL sandboxd running real hardened `sbx`
# containers. A bot runs a command in its own sandbox, another bot cannot see its file, the admin's kill switch stops a
# running command, every run is audited with ids only, and the sandbox environment holds no token. The model is the
# deterministic fake. Run it only through the isolated stack in --sandbox mode:
#
#   OCW_BUNDLED_PLUGINS=none OCW_E2E_API_HOST=0.0.0.0 OCW_MOCK_MODEL_BASE_URL=http://fake-model:18999/v1 PROOF_BUILD=1 \
#     bash scripts/e2e-isolated.sh --sandbox --cmd "bash scripts/sandbox-proof.sh"
#
# It creates ONLY a cell, a fake model container, a network and a volume, all named ocw-proof-sandbox-* and labelled
# ocw.namespace=ocw-proof-sandbox, removed by label by the EXIT trap (the sandboxes themselves are e2e-isolated.sh's
# ocw.namespace=ocw-e2e objects, removed by it). Images are tagged :e2e (never :local) and removed when this run built
# them. It reads the ocw_e2e database read-only (settings, private hosts and switches go through the API).
# 07.8-28 adds the sign-in journey with real Chromium (steps 6-10): the real `brw`, the fake sites scripts/e2e-isolated.sh
# --sandbox starts (panel, idp and evil.fake.test), a takeover over the real live-view socket typing the four E1
# strings, takeover and member-session privacy, the
# D-13 attempts to reach evil.fake.test (open, the Export link, curl to /collect) and the E1 sweep over the database, the
# API, sandboxd, brw, egress and cell logs and every model request. 07.8-24 runs it in Woodpecker. The E1 strings:
#   username   ana@example.test
#   password   S3cr3t-Hunter2-OCW
#   one-time   735190
#   revealed   Visible-Secret-99   (typed after the show-password toggle)
#   PROOF_BUILD=1          build ocw-openclaw:e2e and ocw-fake-model:e2e from this tree first (else they must exist)
#   PROOF_OUT=<dir>        where state.json, cell.log, fake-model.log and audit.tsv are written (default: a temp dir)
#   PROOF_SUBNET           proof network subnet (default 10.231.80.0/24)
#   PROOF_CELL_MEMORY      optional hard memory cap for the cell (e.g. 2g)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

P=ocw-proof-sandbox
LABEL="ocw.namespace=$P"   # the ONLY label this script removes
NET="${P}-net"
VOL="${P}-state"
CELL="${P}-openclaw"
MODEL="${P}-model"
CELL_IMAGE=ocw-openclaw:e2e
MODEL_IMAGE=ocw-fake-model:e2e
OUT="${PROOF_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ocw-sandbox-proof-out.XXXXXX")}"
mkdir -p "$OUT"
SECRETS="$(mktemp -d "${TMPDIR:-/tmp}/ocw-sandbox-proof.XXXXXX")"
CAPTURE="$(mktemp -d "${TMPDIR:-/tmp}/ocw-sandbox-proof-capture.XXXXXX")"
chmod 711 "$SECRETS"
chmod 777 "$CAPTURE"   # the fake model runs as `node` in its container and writes its request captures here
built=0

fail() { echo "sandbox-proof: $*" >&2; exit 1; }

# ---------------------------------------------------------------- preconditions
command -v docker >/dev/null || fail "docker is required"
[[ -n "${OCW_E2E_API_URL:-}" ]] || fail "OCW_E2E_API_URL is not set: run through scripts/e2e-isolated.sh --sandbox --cmd"
[[ "${OCW_E2E_SANDBOX:-}" == "real" ]] ||
  fail "OCW_E2E_SANDBOX is '${OCW_E2E_SANDBOX:-}': the proof needs the real sandboxd (scripts/e2e-isolated.sh --sandbox)"
[[ -n "${OCW_SANDBOX_URL:-}" && -n "${OCW_SANDBOX_TOKEN:-}" ]] || fail "the API's sandboxd is not configured"
API_PORT="$(node -e 'console.log(new URL(process.argv[1]).port)' "$OCW_E2E_API_URL")"
[[ -n "${OCW_CELL_TOKEN:-}" ]] || fail "OCW_CELL_TOKEN is not set (.env)"
[[ "${OCW_BUNDLED_PLUGINS:-}" == "none" ]] || fail "OCW_BUNDLED_PLUGINS must be 'none' (no plugin downloads in the proof)"
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
if [[ -n "$(docker ps -aq --filter "label=$LABEL")" ]]; then fail "objects labelled $LABEL exist (another proof running?)"; fi

if [[ "${PROOF_BUILD:-0}" == "1" ]]; then
  echo "== build $CELL_IMAGE and $MODEL_IMAGE from this tree"
  built=1
  docker build -q --label "$LABEL" -f infra/openclaw/Dockerfile -t "$CELL_IMAGE" . >/dev/null
  docker build -q --label "$LABEL" -f infra/fake-model/Dockerfile -t "$MODEL_IMAGE" . >/dev/null
fi
for image in "$CELL_IMAGE" "$MODEL_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "image $image is missing (PROOF_BUILD=1 builds it)"
done
FREE_KB="$(docker run --rm --label "$LABEL" --entrypoint df "$MODEL_IMAGE" -Pk / | awk 'NR==2 {print $4}')"
[[ "${FREE_KB:-0}" -ge 1048576 ]] || fail "less than 1 GB free on the Docker VM (${FREE_KB:-?} KB): not starting a cell"

remove_by_label() {
  local ids
  ids="$(docker ps -aq --filter "label=$LABEL")"
  if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null 2>&1 || true; fi
  ids="$(docker volume ls -q --filter "label=$LABEL")"
  if [[ -n "$ids" ]]; then docker volume rm -f $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter "label=$LABEL")"
  if [[ -n "$ids" ]]; then docker network rm $ids >/dev/null 2>&1 || true; fi
}

cleanup() {
  local status=$?
  set +e
  if [[ $status -ne 0 ]]; then
    echo "== FAILURE DIAGNOSTICS (exit $status): docker logs $CELL (last 80 lines)" >&2
    docker logs "$CELL" 2>&1 | tail -80 >&2
  fi
  docker logs "$CELL" 2>&1 | tail -400 >"$OUT/cell.log"
  docker logs "$MODEL" 2>&1 | tail -100 >"$OUT/fake-model.log"
  remove_by_label
  if [[ "$built" == "1" ]]; then docker image rm -f "$CELL_IMAGE" "$MODEL_IMAGE" >/dev/null 2>&1; fi
  local left
  left="$( { docker ps -aq --filter "label=$LABEL"; docker volume ls -q --filter "label=$LABEL"
    docker network ls -q --filter "label=$LABEL"; } | wc -l | tr -d ' ')"
  if [[ "$left" != "0" ]]; then
    echo "sandbox-proof: FAIL $left object(s) labelled $LABEL left after cleanup" >&2
    status=1
  fi
  rm -rf "$SECRETS" "$CAPTURE"
  echo "sandbox-proof: outputs in $OUT"
  exit "$status"
}
trap cleanup EXIT

umask 022
printf '%s' "$OCW_CELL_TOKEN" >"$SECRETS/cell_token"

# ---------------------------------------------------------------- network, fake model (capturing), cell
echo "== network $NET"
docker network create --label "$LABEL" --subnet "${PROOF_SUBNET:-10.231.80.0/24}" "$NET" >/dev/null
docker volume create --label "$LABEL" "$VOL" >/dev/null
OOM=(--oom-score-adj 1000)

# FAKE_MODEL_CAPTURE_DIR: every model request is kept, so step 5 reads the WHOLE `env` tool result the model received.
docker run -d --name "$MODEL" --label "$LABEL" "${OOM[@]}" --network "$NET" --network-alias fake-model \
  --add-host host.docker.internal:host-gateway -v "$CAPTURE:/capture" -e FAKE_MODEL_CAPTURE_DIR=/capture \
  "$MODEL_IMAGE" >/dev/null
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
[[ "$reach" == 200* ]] ||
  fail "the cell cannot reach the API on host.docker.internal:$API_PORT; start the stack with OCW_E2E_API_HOST=0.0.0.0 (disposable hosts only)"

echo "== first-run setup of the isolated workspace (Playwright project setup)"
pnpm exec playwright test -c e2e/playwright.proof.config.ts --project setup

echo "== real OpenClaw cell $CELL (OCW_BUNDLED_PLUGINS=none)"
CELL_LIMIT=()
[[ -n "${PROOF_CELL_MEMORY:-}" ]] && CELL_LIMIT=(--memory "$PROOF_CELL_MEMORY")
docker run -d --name "$CELL" --label "$LABEL" "${OOM[@]}" ${CELL_LIMIT[@]+"${CELL_LIMIT[@]}"} --network "$NET" \
  --add-host host.docker.internal:host-gateway \
  -v "$VOL:/home/node/.openclaw" \
  -v "$SECRETS/cell_token:/run/secrets/ocw_cell_token:ro" \
  -e OCW_API_URL="http://host.docker.internal:$API_PORT" \
  -e OCW_CELL_TOKEN_FILE=/run/secrets/ocw_cell_token \
  -e OCW_BUNDLED_PLUGINS=none \
  -e NODE_OPTIONS=--max-old-space-size=512 \
  "$CELL_IMAGE" >/dev/null

echo "== waiting for the cell's agent channel"
connected=0
for _ in $(seq 1 150); do
  logs="$(docker logs "$CELL" 2>&1)"
  if grep -q "agent channel connected" <<<"$logs"; then connected=1; break; fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$CELL")" == "true" ]] || fail "the cell exited"
  sleep 2
done
[[ "$connected" == "1" ]] || fail "the cell did not connect within 300 s"

# ---------------------------------------------------------------- the proof (Playwright, API only)
status=0
started="$(date +%s)"
OCW_PROOF_STATE="$OUT/state.json" OCW_PROOF_CAPTURE_DIR="$CAPTURE" OCW_PROOF_CELL="$CELL" \
  pnpm exec playwright test -c e2e/playwright.proof.config.ts --project sandbox-proof --no-deps || status=$?
echo "== proof run: exit $status in $(($(date +%s) - started)) s"

# ---------------------------------------------------------------- one PASS line per step
passed() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.passed.includes(Number(process.argv[2]))?0:1)' "$OUT/state.json" "$1" 2>/dev/null; }
step() {
  if passed "$1"; then echo "$2"; else echo "FAIL ${2#PASS }"; status=1; fi
}
echo "== steps"
step 1 "PASS 1. two bots (Scout for Ana, Echo for Sam), switches on, the cell's alsoAllow carries ocw_sandbox_*/ocw_browser_*; Scout wrote proof-<nonce> to note.txt and read it back"
step 2 "PASS 2. Echo's cat note.txt: No such file; the two sbx containers are on different ocw-net-* networks and ocw-ws-* volumes"
step 3 "PASS 3. kill switch: no running container of the organization within 5 s; the next exec answered the killed sentence"
step 4 "PASS 4. sandbox.exec rows for both bots and one sandbox.killed row by Ana, ids, codes and durations only"
step 5 "PASS 5. after the resume, env in the sandbox holds neither the cell token, nor the sandbox token, nor an OCW_ name"
step 6 "PASS 6. Guide (team, Ana's) asked Sam to sign in to panel.fake.test; Sam typed ana@example.test, S3cr3t-Hunter2-OCW, 735190 and Visible-Secret-99 through the live view; the card turned signed in"
step 7 "PASS 7. the bot continued signed in: its snapshot read Welcome"
step 8 "PASS 8. D-13: open of evil.fake.test and the Export click answered approval required, curl to evil.fake.test member_data; /collect hits 0; two pending approvals for Sam, 15 minutes"
step 9 "PASS 9. reused without a card, revoked, never Ana's; Ana (owner) and Sam's other device got 0 frames during the takeover and the signed-in page; frames again afterwards"
step 10 "PASS 10. E1 sweep: none of the four strings in any column, audit row, stream event, API, sandboxd or cell log, or model request; brw and egress keep no log (driver none)"
if [[ -f "$OUT/state.json" ]]; then
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`== timings: first exec (cold sbx start, through the cell) ${s.coldStartMs} ms after ${s.firstExecAttempts} ask(s); kill switch to no running container ${s.killLatencyMs} ms`);if(s.journey)console.log(`== journey: take to signed in ${s.journey.signInMs} ms; controller frames ${s.journey.controllerFrames}; Ana frames while private ${s.journey.anaFrames.length}; other device ${s.journey.otherDeviceFrames.length}; /collect hits ${s.journey.collectHits}; pending approvals ${s.journey.pendingApprovals}`)' "$OUT/state.json"
fi

# ---------------------------------------------------------------- audit rows (read-only)
echo "== audit rows (app.audit_events: sandbox.*)"
(cd packages/db && OCW_PROOF_DB_URL="$MIGRATE_SUPERUSER_URL" node --input-type=module -e '
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.OCW_PROOF_DB_URL });
await c.connect();
const { rows } = await c.query(`select occurred_at::text as at, action, actor_kind, result, metadata::text as metadata
  from app.audit_events where action like $$sandbox.%$$ order by occurred_at, id`);
await c.end();
console.log(["at\taction\tactor\tresult\tmetadata", ...rows.map((r) => [r.at, r.action, r.actor_kind, r.result, r.metadata].join("\t"))].join("\n"));
') | tee "$OUT/audit.tsv" | sed 's/^/   /'
exit "$status"
