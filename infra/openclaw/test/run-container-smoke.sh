#!/usr/bin/env bash
# Real-container smoke test: OpenClaw 2026.9.7 cell + our plugin + the bundled search plugins + fake
# model (also a fake SearXNG) + fake Agent Channel API, all on an egress-less internal network. Proves:
# plugins load, cell sync, WS connect, a mention produces a reply in the right thread naming the asker
# and participants, a mention without a turn offers 0 tools, internet on offers exactly
# web_fetch,web_search and a search goes through the tool gate (authorized + outcome reported), no
# published ports, and a ChatGPT-subscription sign-in command reaches OpenClaw's own device-code login
# (which cannot reach auth.openai.com here, so it must report a classified error), and the bot's memory
# tool `ocw_memory_save` stores a note through `POST /memories` while the turn's notes reach the model, and an
# MCP server (the fake MCP behind a bearer token) is probed through the cell, rendered with an env-referenced
# credential and exact tool filter, called through the gate, and its output taints the turn (scenario mcp), and
# marketplace plugins are installed only as approved (scenario marketplace, 03.1-12 / D-14): the official
# DuckDuckGo plugin (pinned, sha512-checked npm pack) and the ocw-echo test plugin are served by the fake ClawHub,
# installed by the executor through OpenClaw's install gate, kept across a restart, used by a bot in a conversation
# (ocw_echo) and uninstalled; a manual install is blocked (also with a forged local cache and with the API down).
#
# Usage (repo root):  infra/openclaw/test/run-container-smoke.sh [--keep]
#   SMOKE_ONLY=<comma list>  run only these scenarios (unset = all): mention, signin, dm, capabilities,
#                            dm-isolation, memory, mcp, marketplace
#   FAKE_MODEL_DEBUG=1       the fake model logs a preview of each tool-offering request (off by default)
# Requires: docker, node + npm (bundled plugins are installed on the host from the pinned registry
# tarballs), apps/openclaw-channel/node_modules (pnpm install / npm install in that dir).
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

# MCP (scenario mcp): one org server on the fake model's /mcp, bearer-protected. The snapshot delivers the header
# value; the cell may only ever write ${OCW_MCP_<SAFE>_0} into its config.
MCP_SAFE=m5e0c0de1
MCP_SERVER_ID=0199a6f0-0000-7000-8000-000000000c51
MCP_ENV="OCW_MCP_$(tr '[:lower:]' '[:upper:]' <<<"$MCP_SAFE")_0"
MCP_TOKEN="mcp-$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
# CellMcpServer[] with the given toolFilter.include (JSON array of raw MCP tool names).
mcp_servers_json() {
  printf '[{"id":"%s","safeName":"%s","transport":"streamable-http","url":"http://fake-model:18999/mcp","headers":[{"name":"Authorization","envName":"%s","value":"Bearer %s"}],"tools":%s}]' \
    "$MCP_SERVER_ID" "$MCP_SAFE" "$MCP_ENV" "$MCP_TOKEN" "$1"
}

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    # Diagnose real-cell failures from CI logs (no local cell can run on starved dev VMs).
    echo "== FAILURE DIAGNOSTICS (exit $status)" >&2
    for c in "${P}-openclaw" "${P}-api" "${P}-model"; do
      echo "---- docker logs $c (last 200 lines)" >&2
      docker logs "$c" 2>&1 | tail -200 >&2 || true
    done
  fi
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
# Runtime dependencies exactly as the image build installs them (exact pins in package.json, no lifecycle scripts):
# the MCP SDK's transitive dependencies are not reachable through pnpm's symlinks.
(cd "$PLUGIN" && npm install --omit=dev --omit=peer --no-package-lock --legacy-peer-deps --ignore-scripts \
  --no-audit --no-fund --loglevel=error >/dev/null)
# The official search plugins, same pins + integrity check as the image build, bind-mounted read-only
# (an image built before Phase 3.1 has no /opt/ocw/plugins; the mount works on either).
echo "== bundled search plugins (pinned, sha512-checked)"
bash "$ROOT/infra/openclaw/install-bundled-plugins.sh" "$SECRETS/bundled" | sed 's/^/   /'
# Marketplace (scenario marketplace): tarballs the fake ClawHub serves (it reports their real digests). The official
# DuckDuckGo plugin comes from the npm registry at the pinned version and must match the pinned sha512 (T-03.1-SC);
# ocw-echo is the test-only fixture (infra/openclaw/test/fixtures, never shipped).
ARTIFACTS="$SECRETS/clawhub-artifacts"
mkdir -p "$ARTIFACTS"
if want marketplace; then
  echo "== [marketplace] artifacts for the fake ClawHub (pinned official DuckDuckGo + the ocw-echo test fixture)"
  read -r DDG_PKG DDG_VERSION DDG_INTEGRITY < <(node -e '
const p = require(process.argv[1]).find((x) => x.id === "duckduckgo");
console.log([p.package, p.version, p.integrity].join(" "));' "$ROOT/infra/openclaw/bundled-plugins.json")
  DDG_TGZ="$(cd "$ARTIFACTS" && npm pack "${DDG_PKG}@${DDG_VERSION}" --silent --ignore-scripts --no-audit --no-fund | tail -n 1)"
  ECHO_TGZ="$(cd "$ARTIFACTS" && npm pack "$ROOT/infra/openclaw/test/fixtures/ocw-echo-plugin" --silent --ignore-scripts | tail -n 1)"
  digest() { node -e 'const c=require("crypto"),f=require("fs"),b=f.readFileSync(process.argv[1]); console.log(c.createHash("sha256").update(b).digest("hex"), "sha512-"+c.createHash("sha512").update(b).digest("base64"))' "$1"; }
  read -r DDG_SHA DDG_SHA512 < <(digest "$ARTIFACTS/$DDG_TGZ")
  read -r ECHO_SHA ECHO_SHA512 < <(digest "$ARTIFACTS/$ECHO_TGZ")
  if [[ "$DDG_SHA512" != "$DDG_INTEGRITY" ]]; then
    echo "FAIL: ${DDG_PKG}@${DDG_VERSION} does not match the pinned integrity" >&2; exit 1
  fi
  echo "   $DDG_TGZ sha256 $DDG_SHA (sha512 = pin)"
  echo "   $ECHO_TGZ sha256 $ECHO_SHA"
fi
chmod -R a+rX "$SECRETS"

echo "== internal network (no egress)"
docker network rm "$NET" >/dev/null 2>&1 || true
# Explicit subnet: hosts with many compose projects can exhaust Docker's default address pools.
docker network create --internal --subnet "${SMOKE_SUBNET:-10.231.77.0/24}" "$NET" >/dev/null

# Smoke containers are the kernel's first OOM victims (oom-score-adj 1000): on a memory-tight Docker VM the
# smoke must fail, never take down another workload (e.g. a running demo cell).
OOM=(--oom-score-adj 1000)
# Optional hard cap for the cell (e.g. SMOKE_CELL_MEMORY=1g on a shared, memory-starved Docker VM).
CELL_LIMIT=()
[[ -n "${SMOKE_CELL_MEMORY:-}" ]] && CELL_LIMIT=(--memory "$SMOKE_CELL_MEMORY")

# The working-tree fake model (tool-call directives, fake SearXNG /search) over the image copy: no rebuild.
docker run -d --name "${P}-model" "${OOM[@]}" --network "$NET" --network-alias fake-model \
  -e FAKE_MODEL_DEBUG="${FAKE_MODEL_DEBUG:-0}" \
  -v "$ROOT/infra/fake-model/server.mjs:/app/server.mjs:ro" \
  -v "$ROOT/infra/fake-model/fake-mcp.mjs:/app/fake-mcp.mjs:ro" \
  -v "$ROOT/infra/fake-model/fake-clawhub.mjs:/app/fake-clawhub.mjs:ro" \
  -v "$ROOT/infra/fake-model/fixtures/clawhub:/app/fixtures/clawhub:ro" \
  -v "$ARTIFACTS:/artifacts:ro" \
  -e FAKE_CLAWHUB_ARTIFACT_DIR=/artifacts \
  -e FAKE_MCP_TOKEN="$MCP_TOKEN" \
  -e FAKE_MODEL_CAPTURE_DIR=/tmp/capture \
  ocw-fake-model:local >/dev/null

docker run -d --name "${P}-api" "${OOM[@]}" --network "$NET" --network-alias api \
  -v "$PLUGIN:/plugin:ro" \
  -e FAKE_API_PORT=4000 -e FAKE_API_TOKEN="$TOKEN" \
  -e FAKE_BOT_ID=0199a6f0-0000-7000-8000-00000000a001 \
  -e FAKE_CELL_ID=0199a6f0-0000-7000-8000-0000000000c0 \
  -e FAKE_MODEL_BASE_URL=http://fake-model:18999/v1 \
  -e FAKE_AGENT_TOOLS="web_search,web_fetch,ocw_memory_save,${MCP_SAFE}__echo,${MCP_SAFE}__write_note,ocw_echo" \
  -e FAKE_MCP_SERVERS="$(mcp_servers_json '["echo"]')" \
  -e FAKE_WEB_SEARCH_PROVIDER=searxng \
  node:24.21.0-bookworm-slim node /plugin/src/testing/run-fake-api.ts >/dev/null

# A freshly built image (SMOKE_BUILD=1, e.g. CI) already contains this tree's plugin, entrypoint and bundled
# plugins owned by root. Bind-mounting the checkout over them would hand OpenClaw directories owned by the
# runner's uid, which it refuses to load ("suspicious ownership"). Overlay only when reusing an older image.
OVERLAY=()
if [[ "${SMOKE_BUILD:-0}" != "1" ]]; then
  OVERLAY=(
    -v "$PLUGIN:/opt/ocw/openclaw-channel:ro"
    -v "$ROOT/infra/openclaw/entrypoint.mjs:/opt/ocw/entrypoint.mjs:ro"
    -v "$ROOT/infra/openclaw/render-config.mjs:/opt/ocw/render-config.mjs:ro"
    -v "$SECRETS/bundled:/opt/ocw/plugins:ro"
  )
fi
# Only SearXNG is bundled: DuckDuckGo is the marketplace scenario's install target (an image-bundled copy would
# shadow it); the capabilities scenario searches through SearXNG either way. The executor downloads only from
# OCW_CLAWHUB_URL (the fake ClawHub on the fake model).
docker create --name "${P}-openclaw" "${OOM[@]}" ${CELL_LIMIT[@]+"${CELL_LIMIT[@]}"} --network "$NET" \
  -v "$VOL:/home/node/.openclaw" \
  -v "$SECRETS/cell_token:/run/secrets/ocw_cell_token:ro" \
  ${OVERLAY[@]+"${OVERLAY[@]}"} \
  -e OCW_API_URL=http://api:4000 \
  -e OCW_CELL_TOKEN_FILE=/run/secrets/ocw_cell_token \
  -e OCW_SEARXNG_URL=http://fake-model:18999 \
  -e OCW_BUNDLED_PLUGINS=searxng \
  -e OCW_CLAWHUB_URL=http://fake-model:18999 \
  -e NODE_OPTIONS="${CELL_NODE_OPTIONS:---max-old-space-size=512}" \
  ocw-openclaw:local >/dev/null
if [[ "${SMOKE_BUILD:-0}" != "1" ]]; then
  # OpenClaw refuses an install-policy script that is not root- (or gateway-) owned: a bind mount would carry the
  # runner's uid, so the working-tree gate is copied in (docker cp writes root-owned files).
  docker cp "$ROOT/infra/openclaw/install-policy.mjs" "${P}-openclaw:/opt/ocw/install-policy.mjs"
fi
docker start "${P}-openclaw" >/dev/null

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
if ! docker logs "${P}-openclaw" 2>&1 | grep -q "agent channel connected"; then
  echo "FAIL: the ocw channel plugin never connected to the Agent Channel API within 120 s" >&2
  exit 1
fi
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

if want capabilities; then
echo "== [capabilities] internet on: the model is offered exactly the web tools and searches through the gate"
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention-web.json" 0199a6f0-0000-7000-8000-00000000d021)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d021");
if (!m) { console.log("FAIL: no reply to the web mention"); process.exit(1); }
const calls = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e003");
const results = s.toolResults.filter((r) => calls.some((c) => c.callId === r.callId));
console.log("   reply      :", m.text);
console.log("   tool calls :", JSON.stringify(calls.map((c) => ({ tool: c.tool, params: c.params, allowed: c.allowed }))));
console.log("   outcomes   :", JSON.stringify(results.map(({ status, resultCount, provider }) => ({ status, resultCount, provider }))));
const ok =
  m.text.includes("Fake result for ocw smoke") &&
  m.text.includes("[tools: 2 | web_fetch,web_search]") &&
  calls.length === 1 && calls[0].tool === "web_search" && calls[0].allowed === true &&
  calls[0].params.query === "ocw smoke" && Object.keys(calls[0].params).join() === "query" &&
  results.length === 1 && results[0].status === "ok";
if (!ok) { console.log("FAIL: expected one gated, audited web_search and an answer from its result"); process.exit(1); }
'
echo "== [capabilities] internet off (turn.tools = []): the model is offered no tool at all"
NOTOOLS="$SECRETS/mention-no-tools.json"
node -e '
const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
e.eventId = "0199a6f0-0000-7000-8000-00000000e004";
e.thread.rootMessageId = e.message.id = "0199a6f0-0000-7000-8000-00000000d022";
e.turn = { ...e.turn, tools: [], toolFlags: {} };
require("fs").writeFileSync(process.argv[2], JSON.stringify(e));
' "$ROOT/infra/openclaw/test/mention-web.json" "$NOTOOLS"
STATE="$(inject_and_wait "$NOTOOLS" 0199a6f0-0000-7000-8000-00000000d022)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d022");
if (!m) { console.log("FAIL: no reply to the no-tools mention"); process.exit(1); }
const calls = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e004");
console.log("   reply      :", m.text);
if (!m.text.endsWith("[tools: 0]") || calls.length !== 0) { console.log("FAIL: tools reached the model with internet off"); process.exit(1); }
'
fi

if want memory; then
echo "== [memory] DM turn offering ocw_memory_save with one saved note: the model reads the note and saves a new one"
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention-memory.json" 0199a6f0-0000-7000-8000-00000000d051)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d051");
if (!m) { console.log("FAIL: no reply to the memory mention"); process.exit(1); }
const saves = (s.memories ?? []).filter((x) => x.eventId === "0199a6f0-0000-7000-8000-00000000e005");
const gated = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e005");
console.log("   reply      :", m.text);
console.log("   saves      :", JSON.stringify(saves.map(({ agentId, text, created }) => ({ agentId, text, created }))));
const ok =
  m.text.includes("Tool ocw_memory_save said:") &&
  /\[tools: 1 \| [^\]]*ocw_memory_save\]/.test(m.text) &&
  saves.length === 1 && saves[0].text === "lives in Madrid" && saves[0].created === true &&
  saves[0].agentId === "0199a6f0-0000-7000-8000-00000000a001" &&
  Object.keys(saves[0]).sort().join() === "agentId,created,eventId,memoryId,text" &&
  // Validated by its own route: never sent to /tool-calls.
  gated.length === 0;
if (!ok) { console.log("FAIL: expected one ocw_memory_save through POST /memories and a reply from its result"); process.exit(1); }
'
# The turn's notes (only ever in turn.memory, rendered as the DM's "Your notes about <name>" block) reach the
# model for this conversation only.
NOTE_FILES="$(docker exec "${P}-model" sh -c "grep -l '0199a6f0-0000-7000-8000-00000000c005' /tmp/capture/*.json 2>/dev/null | xargs -r grep -l 'likes green tea' | wc -l")"
LEAKED="$(docker exec "${P}-model" sh -c "grep -L '0199a6f0-0000-7000-8000-00000000c005' /tmp/capture/*.json 2>/dev/null | xargs -r grep -l 'likes green tea' | wc -l")"
echo "   notes      : $NOTE_FILES model request(s) of this DM carry the note, $LEAKED other request(s) do"
if [[ "$NOTE_FILES" -lt 1 ]]; then echo "FAIL: the turn's notes did not reach the model"; exit 1; fi
if [[ "$LEAKED" -ne 0 ]]; then echo "FAIL: the note reached a model request of another conversation"; exit 1; fi
fi

if want mcp; then
echo "== [mcp] mcp.probe: the cell lists the registered server's tools with the official SDK client"
PROBE_ID=0199a6f0-0000-7000-8000-0000000f2001
api_exec "
const body = JSON.stringify({ type: 'mcp.probe', data: { probeId: '$PROBE_ID', serverId: '$MCP_SERVER_ID' } });
await fetch('http://127.0.0.1:4000/__test/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
"
PROBES=""
for i in $(seq 1 60); do
  PROBES="$(api_exec "const r = await fetch('http://127.0.0.1:4000/__test/state'); console.log(JSON.stringify((await r.json()).mcpProbes));")"
  if grep -q "$PROBE_ID" <<<"$PROBES"; then break; fi
  sleep 1
done
echo "$PROBES" | PROBE_ID="$PROBE_ID" MCP_TOKEN="$MCP_TOKEN" node -e '
const all = JSON.parse(require("fs").readFileSync(0, "utf8"));
const probes = all.filter((p) => p.probeId === process.env.PROBE_ID);
const p = probes[0];
console.log("   probe      :", JSON.stringify(probes.map(({ ok, error, tools }) => ({ ok, error, tools: tools?.map((t) => [t.name, t.annotations]) }))));
const echo = p?.tools?.find((t) => t.name === "echo");
const note = p?.tools?.find((t) => t.name === "write_note");
const ok =
  probes.length === 1 && p.ok === true && p.tools.length === 2 &&
  echo?.annotations?.readOnlyHint === true && note?.annotations?.destructiveHint === true &&
  !JSON.stringify(all).includes(process.env.MCP_TOKEN);
if (!ok) { console.log("FAIL: expected one successful probe reporting echo (read-only) and write_note (destructive)"); process.exit(1); }
'

echo "== [mcp] the credential reaches OpenClaw only as \${$MCP_ENV}; idle MCP runtimes are evicted"
CONFIG="$(docker exec "${P}-openclaw" cat /home/node/.openclaw/openclaw.json)"
CONFIG="$CONFIG" MCP_SAFE="$MCP_SAFE" MCP_ENV="$MCP_ENV" MCP_TOKEN="$MCP_TOKEN" node -e '
const cfg = JSON.parse(process.env.CONFIG);
const server = cfg.mcp?.servers?.[process.env.MCP_SAFE];
console.log("   rendered   :", JSON.stringify({ ...server, headers: server?.headers }), "sessionIdleTtlMs", cfg.mcp?.sessionIdleTtlMs);
const ok =
  server?.url === "http://fake-model:18999/mcp" && server?.transport === "streamable-http" &&
  server?.headers?.Authorization === "${" + process.env.MCP_ENV + "}" &&
  JSON.stringify(server?.toolFilter) === JSON.stringify({ include: ["echo"] }) &&
  cfg.mcp?.sessionIdleTtlMs === 600000 &&
  !process.env.CONFIG.includes(process.env.MCP_TOKEN);
if (!ok) { console.log("FAIL: mcp.servers is not rendered as expected (or holds the literal credential)"); process.exit(1); }
'

echo "== [mcp] a turn allowing echo and write_note, server filter [echo]: only echo reaches the model; it is gated and audited"
MCP_EVENT_1=0199a6f0-0000-7000-8000-00000000e061
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention-mcp.json" 0199a6f0-0000-7000-8000-00000000d061)"
echo "$STATE" | MCP_SAFE="$MCP_SAFE" EVENT="$MCP_EVENT_1" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const safe = process.env.MCP_SAFE;
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d061");
if (!m) { console.log("FAIL: no reply to the mcp mention"); process.exit(1); }
const calls = s.toolCalls.filter((c) => c.eventId === process.env.EVENT);
const results = s.toolResults.filter((r) => calls.some((c) => c.callId === r.callId));
console.log("   reply      :", m.text);
console.log("   tool calls :", JSON.stringify(calls.map((c) => ({ tool: c.tool, params: c.params, allowed: c.allowed }))));
console.log("   outcomes   :", JSON.stringify(results.map(({ status, durationMs }) => ({ status, durationMs }))));
const ok =
  m.text.includes("Tool echo said: echo: hi from mcp") &&
  m.text.includes(`[tools: 1 | ${safe}__echo]`) && !m.text.includes("write_note") &&
  calls.length === 1 && calls[0].tool === `${safe}__echo` && calls[0].allowed === true &&
  Object.keys(calls[0].params).length === 0 &&
  results.length === 1 && results[0].status === "ok";
if (!ok) { console.log("FAIL: expected exactly the enabled MCP tool offered, one gated echo call and an answer from its result"); process.exit(1); }
'

echo "== [mcp] the admin enables write_note on the server: the cell re-renders the tool filter"
docker exec -e SERVERS="$(mcp_servers_json '["echo","write_note"]')" -i "${P}-api" node --input-type=module -e "
const mcpServers = JSON.parse(process.env.SERVERS);
await fetch('http://127.0.0.1:4000/__test/cell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mcpServers, reason: 'tools.updated' }) });
"
for i in $(seq 1 60); do
  if [[ "$(docker logs "${P}-openclaw" 2>&1 | grep -c "mcp servers upsert=1")" -ge 2 ]]; then break; fi
  sleep 1
done
docker logs "${P}-openclaw" 2>&1 | grep -E "reconciled OpenClaw" | tail -n 1 | sed 's/^/   /'
FILTER="$(docker exec "${P}-openclaw" cat /home/node/.openclaw/openclaw.json | MCP_SAFE="$MCP_SAFE" node -e '
const cfg = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(cfg.mcp?.servers?.[process.env.MCP_SAFE]?.toolFilter?.include ?? null));
')"
echo "   filter     : $FILTER"
[[ "$FILTER" == '["echo","write_note"]' ]] || { echo "FAIL: the tool filter was not re-rendered"; exit 1; }

echo "== [mcp] a turn allowing only echo: the per-turn cap still hides write_note from the model"
NARROW="$SECRETS/mention-mcp-narrow.json"
MCP_SAFE="$MCP_SAFE" node -e '
const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const echo = `${process.env.MCP_SAFE}__echo`;
e.eventId = "0199a6f0-0000-7000-8000-00000000e062";
e.thread.rootMessageId = e.message.id = "0199a6f0-0000-7000-8000-00000000d062";
e.message.text = "@archie echo again [[call echo {\"text\":\"narrow\"}]]";
e.turn = { ...e.turn, tools: [echo], toolFlags: { [echo]: e.turn.toolFlags[echo] } };
require("fs").writeFileSync(process.argv[2], JSON.stringify(e));
' "$ROOT/infra/openclaw/test/mention-mcp.json" "$NARROW"
STATE="$(inject_and_wait "$NARROW" 0199a6f0-0000-7000-8000-00000000d062)"
echo "$STATE" | MCP_SAFE="$MCP_SAFE" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const safe = process.env.MCP_SAFE;
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d062");
if (!m) { console.log("FAIL: no reply to the narrow mcp mention"); process.exit(1); }
console.log("   reply      :", m.text);
if (!m.text.includes("Tool echo said: echo: narrow") || !m.text.includes(`[tools: 1 | ${safe}__echo]`)) {
  console.log("FAIL: write_note reached the model although the turn did not allow it"); process.exit(1);
}
'

echo "== [mcp] taint: after echo (untrusted MCP output) the destructive write_note is blocked in the same turn"
TAINT="$SECRETS/mention-mcp-taint.json"
node -e '
const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
e.eventId = "0199a6f0-0000-7000-8000-00000000e063";
e.thread.rootMessageId = e.message.id = "0199a6f0-0000-7000-8000-00000000d063";
e.message.text = "@archie read then write [[call echo {\"text\":\"x\"}]] [[call write_note {\"text\":\"y\"}]]";
require("fs").writeFileSync(process.argv[2], JSON.stringify(e));
' "$ROOT/infra/openclaw/test/mention-mcp.json" "$TAINT"
STATE="$(inject_and_wait "$TAINT" 0199a6f0-0000-7000-8000-00000000d063)"
echo "$STATE" | MCP_SAFE="$MCP_SAFE" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const safe = process.env.MCP_SAFE;
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d063");
if (!m) { console.log("FAIL: no reply to the taint mention"); process.exit(1); }
const calls = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e063");
console.log("   reply      :", m.text.replace(/\n/g, " / "));
console.log("   tool calls :", JSON.stringify(calls.map((c) => ({ tool: c.tool, allowed: c.allowed }))));
const ok =
  m.text.includes("Tool echo said: echo: x") &&
  m.text.includes("Tool write_note said:") && !m.text.includes("noted:") &&
  m.text.includes(`[tools: 2 | ${safe}__echo,${safe}__write_note]`) &&
  calls.length === 1 && calls[0].tool === `${safe}__echo` && calls[0].allowed === true &&
  !calls.some((c) => c.tool === `${safe}__write_note` && c.allowed);
if (!ok) { console.log("FAIL: expected echo to answer and write_note to be blocked by the taint rule before reaching the server"); process.exit(1); }
'
LEAKS="$(docker logs "${P}-openclaw" 2>&1 | grep -c "$MCP_TOKEN" || true)"
echo "   cell log   : $LEAKS line(s) carry the MCP credential"
[[ "$LEAKS" -eq 0 ]] || { echo "FAIL: the MCP credential appears in the cell log"; exit 1; }
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

if want marketplace; then
# Marketplace (03.1-12, D-14). The fake Agent Channel API plays the API's part: it delivers the approved rows in GET /cell
# (CellApprovedPlugin), publishes plugin.install.v1 / plugin.uninstall.v1 (moving the row to installing / uninstalling),
# answers the install gate (POST /plugins/verify-install: only a row in flight with the same package, version and
# sha256) and records POST /plugins/report.
DDG_ROW=0199a6f0-0000-7000-8000-00000000c1a1
ECHO_ROW=0199a6f0-0000-7000-8000-00000000c1a2
set_plugins() { # <duckduckgo status> <ocw-echo status>
  local rows
  rows="$(DDG_STATUS="$1" ECHO_STATUS="$2" DDG_ROW="$DDG_ROW" ECHO_ROW="$ECHO_ROW" DDG_PKG="$DDG_PKG" \
    DDG_VERSION="$DDG_VERSION" DDG_SHA="$DDG_SHA" ECHO_SHA="$ECHO_SHA" node -e '
const e = process.env;
console.log(JSON.stringify([
  { pluginRowId: e.DDG_ROW, packageName: e.DDG_PKG, version: e.DDG_VERSION, sha256: e.DDG_SHA, pluginId: "duckduckgo", status: e.DDG_STATUS },
  { pluginRowId: e.ECHO_ROW, packageName: "@ocw-test/echo-plugin", version: "0.1.0", sha256: e.ECHO_SHA, pluginId: "ocw-echo", status: e.ECHO_STATUS },
]));')"
  docker exec -e ROWS="$rows" -i "${P}-api" node --input-type=module -e "
await fetch('http://127.0.0.1:4000/__test/plugins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: JSON.parse(process.env.ROWS) }) });
"
}
publish_plugin_event() { # <json {type, data}>
  docker exec -e EV="$1" -i "${P}-api" node --input-type=module -e "
await fetch('http://127.0.0.1:4000/__test/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.env.EV });
"
}
install_event() { # <row> <flow> <package> <version> <sha256> <sha512> <plugin id>
  ROW="$1" FLOW="$2" PKG="$3" VER="$4" SHA="$5" SRI="$6" PLUGIN="$7" node -e '
const e = process.env;
console.log(JSON.stringify({ type: "plugin.install.v1", data: {
  flowId: e.FLOW, pluginRowId: e.ROW, packageName: e.PKG, version: e.VER,
  artifactUrl: `http://fake-model:18999/api/v1/packages/${encodeURIComponent(e.PKG)}/versions/${encodeURIComponent(e.VER)}/artifact/download`,
  sha256: e.SHA, npmIntegrity: e.SRI, expectedPluginId: e.PLUGIN, mode: "install" } }));'
}
uninstall_event() { # <row> <flow> <plugin id>
  printf '{"type":"plugin.uninstall.v1","data":{"flowId":"%s","pluginRowId":"%s","pluginId":"%s"}}' "$2" "$1" "$3"
}
wait_report() { # <flow id> → the flow's final report (JSON) or null after 240 s
  local r="null"
  for i in $(seq 1 240); do
    r="$(api_exec "const s = await (await fetch('http://127.0.0.1:4000/__test/state')).json(); const x = s.pluginReports.filter((p) => p.flowId === '$1' && p.state !== 'installing'); console.log(JSON.stringify(x.at(-1) ?? null));")"
    [[ "$r" != "null" ]] && break
    if [[ "$(docker inspect -f '{{.State.Running}}' "${P}-openclaw")" != "true" ]]; then
      echo "FAIL: openclaw container died during a plugin flow" >&2; exit 1
    fi
    sleep 1
  done
  printf '%s' "$r"
}
# OpenClaw's CLI inside the cell with the gateway's own environment (its token, and the provider and MCP env refs the
# config needs): what someone with a shell in the cell could run.
cat >"$SECRETS/ocw-cli.mjs" <<'JS'
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
let gateway = {};
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try {
    const vars = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
    if (vars.some((v) => v.startsWith("OPENCLAW_GATEWAY_TOKEN="))) {
      gateway = Object.fromEntries(vars.map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
      break;
    }
  } catch {}
}
const r = spawnSync(process.execPath, ["/app/openclaw.mjs", ...process.argv.slice(2)], {
  env: { ...process.env, ...gateway },
  encoding: "utf8",
  timeout: 180000,
  maxBuffer: 16 * 1024 * 1024,
});
console.log(JSON.stringify({ code: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.slice(-1500) }));
JS
cell_cli() { docker exec "${P}-openclaw" node /tmp/ocw-cli.mjs "$@"; }
listed() { # <plugin id> → enabled | disabled | absent (OpenClaw's own inventory inside the cell)
  cell_cli plugins list --json | ID="$1" node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
let p;
try { p = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))).plugins.find((x) => x.id === process.env.ID); } catch { console.log("unreadable"); process.exit(0); }
console.log(!p ? "absent" : p.enabled ? "enabled" : "disabled");'
}
manual_install() { # <tarball in the container> → {code, out}
  cell_cli plugins install "npm-pack:$1" --force --accept-capabilities
}
docker cp "$SECRETS/ocw-cli.mjs" "${P}-openclaw:/tmp/ocw-cli.mjs"
docker cp "$ARTIFACTS/$ECHO_TGZ" "${P}-openclaw:/tmp/ocw-echo.tgz"

echo "== [marketplace] plugin.install.v1 for the official DuckDuckGo plugin: downloaded, verified, gated, installed"
set_plugins approved approved
DDG_FLOW=0199a6f0-0000-7000-8000-0000000f3001
publish_plugin_event "$(install_event "$DDG_ROW" "$DDG_FLOW" "$DDG_PKG" "$DDG_VERSION" "$DDG_SHA" "$DDG_SHA512" duckduckgo)"
REPORT="$(wait_report "$DDG_FLOW")"
echo "   report     : $REPORT"
STATE="$(api_exec "const r = await fetch('http://127.0.0.1:4000/__test/state'); console.log(JSON.stringify(await r.json()));")"
echo "$STATE" | DDG_SHA="$DDG_SHA" REPORT="$REPORT" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const r = JSON.parse(process.env.REPORT);
const gate = s.verifyCalls.filter((c) => c.sha256 === process.env.DDG_SHA);
console.log("   gate       :", JSON.stringify(gate.map(({ packageName, version, approved }) => ({ packageName, version, approved }))));
const ok =
  r?.state === "installed" && r.pluginId === "duckduckgo" && r.version === "2026.9.7" &&
  JSON.stringify(r.declared?.webSearchProviders) === "[\"duckduckgo\"]" && (r.declared?.tools ?? []).length === 0 &&
  gate.length >= 1 && gate.every((c) => c.approved === true);
if (!ok) { console.log("FAIL: expected an installed report for duckduckgo, approved by the install gate for the exact digest"); process.exit(1); }
'
STATUS="$(listed duckduckgo)"
echo "   plugins list: duckduckgo $STATUS"
[[ "$STATUS" == "enabled" ]] || { echo "FAIL: duckduckgo is not enabled in OpenClaw's plugin inventory"; exit 1; }
CONFIG="$(docker exec "${P}-openclaw" cat /home/node/.openclaw/openclaw.json)"
CONFIG="$CONFIG" node -e '
const cfg = JSON.parse(process.env.CONFIG);
const entry = cfg.plugins?.entries?.duckduckgo;
console.log("   config     :", JSON.stringify({ allow: cfg.plugins?.allow, duckduckgo: entry, gate: cfg.security?.installPolicy?.exec?.args }));
const ok =
  cfg.plugins.allow.includes("duckduckgo") && entry?.hooks?.allowConversationAccess === false &&
  entry?.hooks?.allowPromptInjection === false && cfg.security?.installPolicy?.enabled === true;
if (!ok) { console.log("FAIL: duckduckgo must be allowed with conversation access and prompt injection off, behind the gate"); process.exit(1); }
'

echo "== [marketplace] a manual install of an unapproved package is blocked by the install gate"
OUT="$(manual_install /tmp/ocw-echo.tgz)"
echo "$OUT" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("   manual     : exit", r.code, "|", (r.out.match(/Reason: [^\n]*/) ?? [""])[0]);
if (r.code === 0 || !/blocked by policy/i.test(r.out) || !/not_in_flight|not_approved/.test(r.out)) { console.log("FAIL: the unapproved install was not blocked by the gate"); process.exit(1); }
'
echo "== [marketplace] a forged local cache listing the tuple changes nothing (the gate asks only the API)"
docker exec -i "${P}-openclaw" sh -c 'cat > /home/node/.openclaw/ocw-plugins.json' <<EOF
{"version":1,"installed":[{"pluginId":"ocw-echo","packageName":"@ocw-test/echo-plugin","version":"0.1.0"}],"approved":[{"packageName":"@ocw-test/echo-plugin","version":"0.1.0","sha256":"$ECHO_SHA"}]}
EOF
OUT="$(manual_install /tmp/ocw-echo.tgz)"
echo "$OUT" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("   manual     : exit", r.code, "|", (r.out.match(/Reason: [^\n]*/) ?? [""])[0]);
if (r.code === 0 || !/blocked by policy/i.test(r.out)) { console.log("FAIL: a forged cache turned a refusal into an install"); process.exit(1); }
'
echo "== [marketplace] with the API down even an in-flight tuple is blocked (fail closed)"
set_plugins installed installing
docker pause "${P}-api" >/dev/null
OUT="$(manual_install /tmp/ocw-echo.tgz || true)"
docker unpause "${P}-api" >/dev/null
set_plugins installed approved
echo "$OUT" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("   manual     : exit", r.code, "|", (r.out.match(/Reason: [^\n]*/) ?? [""])[0]);
if (r.code === 0 || !/blocked by policy|failed closed/i.test(r.out) || !/unreachable|did not answer/i.test(r.out)) { console.log("FAIL: the gate did not fail closed with the API down"); process.exit(1); }
'
STATUS="$(listed ocw-echo)"
echo "   plugins list: ocw-echo $STATUS"
[[ "$STATUS" == "absent" ]] || { echo "FAIL: a blocked install left ocw-echo in the cell"; exit 1; }

echo "== [marketplace] restart: the installed plugin is re-allowed at boot from GET /agent-channel/v1/plugins"
T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker restart "${P}-openclaw" >/dev/null
for i in $(seq 1 120); do
  if docker logs --since "$T0" "${P}-openclaw" 2>&1 | grep -q "agent channel connected"; then break; fi
  sleep 1
done
BOOT="$(docker logs --since "$T0" "${P}-openclaw" 2>&1)"
grep -E "\[ocw-cell\]" <<<"$BOOT" | sed 's/^/   /'
grep -q "agent channel connected" <<<"$BOOT" || { echo "FAIL: the cell did not reconnect after the restart"; exit 1; }
grep -q "base config rendered (plugins.allow=[^)]*duckduckgo" <<<"$BOOT" || { echo "FAIL: duckduckgo was not re-allowed at boot"; exit 1; }
if grep -q "API unreachable at boot" <<<"$BOOT"; then echo "FAIL: the boot render fell back to the local cache"; exit 1; fi
STATUS="$(listed duckduckgo)"
echo "   plugins list: duckduckgo $STATUS"
[[ "$STATUS" == "enabled" ]] || { echo "FAIL: duckduckgo did not survive the restart"; exit 1; }

echo "== [marketplace] plugin.uninstall.v1: removed from the cell"
DDG_UNFLOW=0199a6f0-0000-7000-8000-0000000f3002
publish_plugin_event "$(uninstall_event "$DDG_ROW" "$DDG_UNFLOW" duckduckgo)"
REPORT="$(wait_report "$DDG_UNFLOW")"
echo "   report     : $REPORT"
STATUS="$(listed duckduckgo)"
echo "   plugins list: duckduckgo $STATUS"
if [[ "$(REPORT="$REPORT" node -e 'console.log(JSON.parse(process.env.REPORT)?.state ?? "none")')" != "uninstalled" || "$STATUS" != "absent" ]]; then
  echo "FAIL: duckduckgo was not uninstalled"; exit 1
fi
fi

if want dm-isolation; then
echo "== [dm-isolation] two humans DM the same bot: separate sessions, the second prompt holds nothing of the first"
SECRET_WORD="zebra-secret-41"
BOT_ID="0199a6f0-0000-7000-8000-00000000a001"
DM_A="$SECRETS/dm-a.json"
DM_B="$SECRETS/dm-b.json"
SECRET_WORD="$SECRET_WORD" node -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const human = (id, name) => ({ kind: "user", id, displayName: name });
const make = (n, convId, msgId, author, text) => ({
  ...base,
  eventId: `0199a6f0-0000-7000-8000-00000000e01${n}`,
  conversation: { id: convId, kind: "dm", name: null },
  thread: { rootMessageId: msgId },
  message: { ...base.message, id: msgId, text, author },
  threadHistory: [],
  roster: [{ ...author, role: "member" }, base.roster.find((r) => r.kind === "agent")],
});
const alice = human("0199a6f0-0000-7000-8000-0000000000a1", "Alice Doe");
const bob = human("0199a6f0-0000-7000-8000-0000000000b1", "Bob Roe");
fs.writeFileSync(process.argv[2], JSON.stringify(make(1, "0199a6f0-0000-7000-8000-00000000c011", "0199a6f0-0000-7000-8000-00000000d031", alice, `my locker code is ${process.env.SECRET_WORD}, keep it private`)));
fs.writeFileSync(process.argv[3], JSON.stringify(make(2, "0199a6f0-0000-7000-8000-00000000c012", "0199a6f0-0000-7000-8000-00000000d032", bob, "what did the other person tell you?")));
' "$ROOT/infra/openclaw/test/mention-dm.json" "$DM_A" "$DM_B"
inject_and_wait "$DM_A" 0199a6f0-0000-7000-8000-00000000d031 >/dev/null
inject_and_wait "$DM_B" 0199a6f0-0000-7000-8000-00000000d032 >/dev/null
# Every model request is captured by the fake model; the ones of Bob's conversation carry its chat id.
CAPTURES="$(docker exec "${P}-model" sh -c 'ls /tmp/capture/*.json 2>/dev/null | wc -l')"
B_FILES="$(docker exec "${P}-model" sh -c 'grep -l "0199a6f0-0000-7000-8000-00000000c012" /tmp/capture/*.json 2>/dev/null | wc -l')"
B_LEAKS="$(docker exec "${P}-model" sh -c "grep -l '0199a6f0-0000-7000-8000-00000000c012' /tmp/capture/*.json 2>/dev/null | xargs -r grep -l '$SECRET_WORD' | wc -l")"
A_HITS="$(docker exec "${P}-model" sh -c "grep -l '$SECRET_WORD' /tmp/capture/*.json 2>/dev/null | wc -l")"
CELL_LOG="$(docker logs "${P}-openclaw" 2>&1)"
KEY_A="$(grep -o "turn 0199a6f0-0000-7000-8000-00000000e011 → session [^ ]*" <<<"$CELL_LOG" | tail -n 1 | sed 's/.*session //')"
KEY_B="$(grep -o "turn 0199a6f0-0000-7000-8000-00000000e012 → session [^ ]*" <<<"$CELL_LOG" | tail -n 1 | sed 's/.*session //')"
echo "   captures   : $CAPTURES model requests, $B_FILES of Bob's conversation, $A_HITS containing the secret"
echo "   sessions   : alice=$KEY_A bob=$KEY_B"
if [[ "$B_FILES" -lt 1 || "$A_HITS" -lt 1 ]]; then echo "FAIL: model requests were not captured as expected"; exit 1; fi
if [[ "$B_LEAKS" -ne 0 ]]; then echo "FAIL: Bob's prompt contains Alice's private text"; exit 1; fi
if [[ -z "$KEY_A" || -z "$KEY_B" || "$KEY_A" == "$KEY_B" ]]; then echo "FAIL: the two DMs did not run in separate sessions"; exit 1; fi

echo "== [dm-isolation] deleting the bot leaves none of its DM transcripts in the state volume"
AGENT_DIR="/home/node/.openclaw/agents/ocw-${BOT_ID}"
BEFORE="$(docker exec "${P}-openclaw" sh -c "grep -rl '$SECRET_WORD' /home/node/.openclaw 2>/dev/null | wc -l")"
echo "   before     : $BEFORE state file(s) hold the secret"
api_exec "
await fetch('http://127.0.0.1:4000/__test/cell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agents: [], reason: 'agent.deleted', agentId: '$BOT_ID' }) });
"
for i in $(seq 1 60); do
  if docker logs "${P}-openclaw" 2>&1 | grep -q "reconciled OpenClaw: agents upsert=0 remove=1"; then break; fi
  sleep 1
done
docker logs "${P}-openclaw" 2>&1 | grep -E "reconciled OpenClaw|purged OpenClaw state|could not purge|agent removal refused" | tail -n 3 | sed 's/^/   /'
LEFT="$(docker exec "${P}-openclaw" sh -c "grep -rl '$SECRET_WORD' /home/node/.openclaw/agents 2>/dev/null || true")"
ELSEWHERE="$(docker exec "${P}-openclaw" sh -c "grep -rl '$SECRET_WORD' /home/node/.openclaw 2>/dev/null | grep -v '^/home/node/.openclaw/agents/' || true")"
if docker exec "${P}-openclaw" test -e "$AGENT_DIR"; then echo "FAIL: $AGENT_DIR still exists"; exit 1; fi
if [[ -n "$LEFT" ]]; then echo "FAIL: the deleted bot's DM text is still in agent state:"; echo "$LEFT" | sed 's/^/     /'; exit 1; fi
echo "   after      : agent state dir gone, no agent state file holds the secret"
# Outside agent state (gateway logs, shared indexes) is reported for the record, not a transcript.
[[ -z "$ELSEWHERE" ]] || { echo "   note       : the secret also appears outside agent state:"; echo "$ELSEWHERE" | sed 's/^/     /'; }
fi

echo "== hardening checks"
PORTS="$(docker port "${P}-openclaw" || true)"
[[ -z "$PORTS" ]] || { echo "FAIL: published ports: $PORTS"; exit 1; }
echo "   no published ports"
# Capture once: `docker logs | grep -q` under pipefail can fail on SIGPIPE.
LOGS="$(docker logs "${P}-openclaw" 2>&1)"
# Startup line (sorted ids): "http server listening (N plugins: a, b, …; …)". ocw + openai always load at
# boot; the bundled search plugins are lazily activated (manifest `onStartup: false`), so they may only load
# on first use. Nothing else may ever load.
PLUGINS="$(grep -o "http server listening ([0-9]* plugins\?: [^;)]*" <<<"$LOGS" | tail -n 1 | sed 's/.*plugins\?: //')"
if node -e '
const ids = process.argv[1].split(",").map((s) => s.trim()).filter(Boolean);
const allowed = new Set(["ocw", "openai", "duckduckgo", "searxng"]);
process.exit(ids.includes("ocw") && ids.includes("openai") && ids.every((id) => allowed.has(id)) ? 0 : 1);
' "$PLUGINS"; then
  echo "   plugins loaded at boot: $PLUGINS (only ocw, openai and the bundled search plugins are permitted)"
else
  echo "FAIL: unexpected plugin set: '$PLUGINS'"; grep "plugins\? loaded\|http server listening\|ocw-cell" <<<"$LOGS" | head; exit 1
fi
if grep -q "bundled plugin .* missing from the image; skipped" <<<"$LOGS"; then
  echo "FAIL: a bundled search plugin was skipped"; grep "ocw-cell" <<<"$LOGS"; exit 1
fi
if grep -q "\[heartbeat\] disabled" <<<"$LOGS"; then echo "   heartbeat disabled"; else echo "FAIL: heartbeat not disabled"; exit 1; fi
# Where the call-time tool gate got registered: the boot registry ("full") and the non-activated registry
# OpenClaw runs agent turns with ("discovery"); the capabilities scenario proves it actually gates.
GATES="$(grep -o "tool gate registered ([a-z-]* registry)" <<<"$LOGS" | sort -u | tr '\n' ';' || true)"
echo "   tool gate wiring: ${GATES:-none logged}"
if docker exec "${P}-openclaw" node -e "fetch('https://api.anthropic.com').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
  echo "FAIL: container has internet egress"; exit 1
fi
echo "   no internet egress"
docker stats --no-stream --format '   memory: {{.MemUsage}}' "${P}-openclaw"
echo "PASS"
