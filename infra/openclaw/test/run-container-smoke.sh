#!/usr/bin/env bash
# Real-container smoke test: OpenClaw 2026.9.7 cell + our plugin + fake model + fake Agent Channel
# API, all on an egress-less internal network. Proves: plugin loads, cell sync, WS connect, a
# mention produces a reply in the right thread naming the asker and participants, 0 tools reach the
# model, no published ports, and a ChatGPT-subscription sign-in command reaches OpenClaw's own
# device-code login (which cannot reach auth.openai.com here, so it must report a classified error).
#
# Usage (repo root):  infra/openclaw/test/run-container-smoke.sh [--keep]
#   SMOKE_ONLY=<comma list>  run only these scenarios (unset = all): mention, signin, dm
# Requires: docker, apps/openclaw-channel/node_modules (pnpm install / npm install in that dir).
set -euo pipefail

# Scenario selection: `want <name>` is true when SMOKE_ONLY is unset or lists <name>.
want() { [[ -z "${SMOKE_ONLY:-}" || ",${SMOKE_ONLY}," == *",$1,"* ]]; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
KEEP="${1:-}"
P=ocw-smoke
NET="${P}-net"
VOL="${P}-state"
TOKEN="smoke-$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
SECRETS="$(mktemp -d)"
printf '%s' "$TOKEN" >"$SECRETS/cell_token"
chmod 644 "$SECRETS/cell_token"

cleanup() {
  if [[ "$KEEP" != "--keep" ]]; then
    docker rm -f "${P}-openclaw" "${P}-api" "${P}-model" >/dev/null 2>&1 || true
    docker volume rm "$VOL" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
  fi
  rm -rf "$SECRETS"
}
trap cleanup EXIT

# Images are built only when missing or SMOKE_BUILD=1 (the cell image is ~1.3 GB compressed).
# The working-tree plugin (dist, copied with its runtime deps) and entrypoint are bind-mounted over
# the image copies, so plugin changes never need a rebuild: run `pnpm --filter @ocw/openclaw-channel build`.
if [[ "${SMOKE_BUILD:-0}" == "1" ]] || ! docker image inspect ocw-openclaw:local >/dev/null 2>&1; then
  echo "== build ocw-openclaw:local"
  docker build -q -f "$ROOT/infra/openclaw/Dockerfile" -t ocw-openclaw:local "$ROOT" >/dev/null
fi
if [[ "${SMOKE_BUILD:-0}" == "1" ]] || ! docker image inspect ocw-fake-model:local >/dev/null 2>&1; then
  echo "== build ocw-fake-model:local"
  docker build -q -f "$ROOT/infra/fake-model/Dockerfile" -t ocw-fake-model:local "$ROOT" >/dev/null
fi
[[ -f "$ROOT/apps/openclaw-channel/dist/index.js" ]] || { echo "FAIL: build the plugin first (dist/ missing)"; exit 1; }

# Self-contained copy of the working-tree plugin: pnpm's node_modules are symlinks into the repo root
# store, which do not resolve inside the containers.
PLUGIN="$SECRETS/plugin"
mkdir -p "$PLUGIN/node_modules"
cp -R "$ROOT/apps/openclaw-channel/dist" "$ROOT/apps/openclaw-channel/src" "$PLUGIN/"
cp "$ROOT/apps/openclaw-channel/package.json" "$ROOT/apps/openclaw-channel/openclaw.plugin.json" "$PLUGIN/"
for dep in ws zod; do cp -RL "$ROOT/apps/openclaw-channel/node_modules/$dep" "$PLUGIN/node_modules/$dep"; done
chmod -R a+rX "$SECRETS"

echo "== internal network (no egress)"
docker network rm "$NET" >/dev/null 2>&1 || true
# Explicit subnet: hosts with many compose projects can exhaust Docker's default address pools.
docker network create --internal --subnet "${SMOKE_SUBNET:-10.231.77.0/24}" "$NET" >/dev/null

# Smoke containers are the kernel's first OOM victims (oom-score-adj 1000): on a memory-tight Docker VM the
# smoke must fail, never take down another workload (e.g. a running demo cell).
OOM=(--oom-score-adj 1000)

docker run -d --name "${P}-model" "${OOM[@]}" --network "$NET" --network-alias fake-model ocw-fake-model:local >/dev/null

docker run -d --name "${P}-api" "${OOM[@]}" --network "$NET" --network-alias api \
  -v "$PLUGIN:/plugin:ro" \
  -e FAKE_API_PORT=4000 -e FAKE_API_TOKEN="$TOKEN" \
  -e FAKE_BOT_ID=0199a6f0-0000-7000-8000-00000000a001 \
  -e FAKE_CELL_ID=0199a6f0-0000-7000-8000-0000000000c0 \
  -e FAKE_MODEL_BASE_URL=http://fake-model:18999/v1 \
  node:24.21.0-bookworm-slim node /plugin/src/testing/run-fake-api.ts >/dev/null

docker run -d --name "${P}-openclaw" "${OOM[@]}" --network "$NET" \
  -v "$VOL:/home/node/.openclaw" \
  -v "$SECRETS/cell_token:/run/secrets/ocw_cell_token:ro" \
  -v "$PLUGIN:/opt/ocw/openclaw-channel:ro" \
  -v "$ROOT/infra/openclaw/entrypoint.mjs:/opt/ocw/entrypoint.mjs:ro" \
  -v "$ROOT/infra/openclaw/render-config.mjs:/opt/ocw/render-config.mjs:ro" \
  -e OCW_API_URL=http://api:4000 \
  -e OCW_CELL_TOKEN_FILE=/run/secrets/ocw_cell_token \
  -e NODE_OPTIONS="${CELL_NODE_OPTIONS:---max-old-space-size=512}" \
  ocw-openclaw:local >/dev/null

echo "== waiting for the plugin to connect"
for i in $(seq 1 120); do
  if docker logs "${P}-openclaw" 2>&1 | grep -q "agent channel connected"; then break; fi
  if ! docker ps --format '{{.Names}}' | grep -q "^${P}-openclaw$"; then
    docker logs "${P}-openclaw" 2>&1 | tail -40
    echo "FAIL: openclaw container exited"
    exit 1
  fi
  sleep 1
done
docker logs "${P}-openclaw" 2>&1 | grep -E "ocw-cell|http server listening|\[ocw\]|heartbeat" | sed 's/^/   /'

api_exec() { docker exec -i "${P}-api" node --input-type=module -e "$1"; }

# Publishes a fixture event through the fake Agent Channel API, then waits until a reply answering
# `$2` (inReplyToMessageId) is stored and typing for its conversation switched off; prints the state.
inject_and_wait() {
  local fixture="$1" reply_to="$2" state=""
  api_exec "
const body = await new Response(process.stdin).text();
const r = await fetch('http://127.0.0.1:4000/__test/mention', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
console.log('   published seq', (await r.json()).seq);
" <"$fixture" >&2
  for i in $(seq 1 90); do
    state="$(api_exec "const r = await fetch('http://127.0.0.1:4000/__test/state'); console.log(JSON.stringify(await r.json()));")"
    if REPLY_TO="$reply_to" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === process.env.REPLY_TO);
const t = m && s.typing.filter((x) => x.conversationId === m.conversationId);
process.exit(m && t.length && t.at(-1).typing === false ? 0 : 1);
' <<<"$state"; then break; fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "${P}-openclaw")" != "true" ]]; then
      echo "FAIL: openclaw container died: $(docker inspect -f 'exit={{.State.ExitCode}} oomKilled={{.State.OOMKilled}}' "${P}-openclaw")" >&2
      exit 1
    fi
    sleep 1
  done
  printf '%s' "$state"
}

if want mention; then
echo "== [mention] inject agent.mention.v1 (channel thread)"
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention.json" 0199a6f0-0000-7000-8000-00000000d003)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d003");
if (!m) { console.log("FAIL: no reply"); process.exit(1); }
const typing = s.typing.filter((t) => t.conversationId === m.conversationId);
console.log("   status ack :", JSON.stringify(s.statusReports));
console.log("   reply      :", m.text);
console.log("   thread     :", m.threadRootMessageId, "inReplyTo", m.inReplyToMessageId);
console.log("   idempotency:", m.idempotencyKey);
console.log("   typing     :", typing.map((t) => t.typing).join(","));
const ok =
  s.statusReports.some((r) => r.agentId === "0199a6f0-0000-7000-8000-00000000a001" && r.status === "ready") &&
  m.text.startsWith("Hi Víctor Ruiz! (participants: Alex, Víctor Ruiz)") &&
  m.text.includes("[asker id: 0199a6f0-0000-7000-8000-0000000000f1]") &&
  m.text.endsWith("[tools: 0]") &&
  m.threadRootMessageId === "0199a6f0-0000-7000-8000-00000000d001" &&
  m.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d003" &&
  m.idempotencyKey === "evt:0199a6f0-0000-7000-8000-00000000e001" &&
  typing[0]?.typing === true && typing.at(-1)?.typing === false;
if (!ok) { console.log("FAIL: unexpected reply"); process.exit(1); }
'
fi

if want dm; then
echo "== [dm] inject agent.mention.v1 for a direct conversation (D-04: flat reply, no mention)"
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention-dm.json" 0199a6f0-0000-7000-8000-00000000d012)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d012");
if (!m) { console.log("FAIL: no dm reply"); process.exit(1); }
const typing = s.typing.filter((t) => t.conversationId === m.conversationId);
console.log("   reply      :", m.text);
console.log("   thread     :", m.threadRootMessageId, "conversation", m.conversationId);
console.log("   typing     :", typing.map((t) => `${t.typing}/${t.threadRootMessageId ?? null}`).join(","));
const ok =
  m.conversationId === "0199a6f0-0000-7000-8000-00000000c002" &&
  m.threadRootMessageId === null &&
  m.text.startsWith("Hi Víctor Ruiz!") &&
  m.text.includes("[asker id: 0199a6f0-0000-7000-8000-0000000000f1]") &&
  m.text.endsWith("[tools: 0]") &&
  m.idempotencyKey === "evt:0199a6f0-0000-7000-8000-00000000e002" &&
  typing.length > 0 && typing.every((t) => (t.threadRootMessageId ?? null) === null);
if (!ok) { console.log("FAIL: unexpected dm reply"); process.exit(1); }
'
fi

if want signin; then
echo "== [signin] subscription sign-in command → OpenClaw's device-code login (no egress → reported error)"
api_exec "
const startBefore = new Date(Date.now() + 60000).toISOString();
const body = JSON.stringify({ type: 'provider.auth.start', data: { flowId: '0199a6f0-0000-7000-8000-0000000f1001', provider: 'openai-codex', method: 'device-code', startBefore } });
await fetch('http://127.0.0.1:4000/__test/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
"
AUTH=""
for i in $(seq 1 60); do
  AUTH="$(api_exec "const r = await fetch('http://127.0.0.1:4000/__test/state'); console.log(JSON.stringify((await r.json()).authReports));")"
  if echo "$AUTH" | grep -q '"flowId":"0199a6f0-0000-7000-8000-0000000f1001"'; then break; fi
  sleep 1
done
echo "$AUTH" | node -e '
const reports = JSON.parse(require("fs").readFileSync(0, "utf8")).filter((r) => r.flowId);
const r = reports[0];
console.log("   report     :", r ? `${r.state} ${r.error?.code ?? ""}` : "none");
if (!r || r.state !== "error" || !["failed", "unsupported"].includes(r.error?.code)) {
  console.log("FAIL: expected a classified sign-in error from the cell"); process.exit(1);
}
'
fi

echo "== hardening checks"
PORTS="$(docker port "${P}-openclaw" || true)"
[[ -z "$PORTS" ]] || { echo "FAIL: published ports: $PORTS"; exit 1; }
echo "   no published ports"
# Capture once: `docker logs | grep -q` under pipefail can fail on SIGPIPE.
LOGS="$(docker logs "${P}-openclaw" 2>&1)"
if grep -q "(2 plugins: ocw, openai;" <<<"$LOGS"; then echo "   plugins loaded: ocw + openai (sign-in owner)"; else
  echo "FAIL: unexpected plugin set"; grep "plugins\? loaded\|http server listening" <<<"$LOGS" | head; exit 1
fi
if grep -q "\[heartbeat\] disabled" <<<"$LOGS"; then echo "   heartbeat disabled"; else echo "FAIL: heartbeat not disabled"; exit 1; fi
if docker exec "${P}-openclaw" node -e "fetch('https://api.anthropic.com').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
  echo "FAIL: container has internet egress"; exit 1
fi
echo "   no internet egress"
docker stats --no-stream --format '   memory: {{.MemUsage}}' "${P}-openclaw"
echo "PASS"
