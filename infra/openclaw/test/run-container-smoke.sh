#!/usr/bin/env bash
# Real-container smoke test: OpenClaw 2026.9.7 cell + our plugin + the bundled search plugins + fake
# model (also a fake SearXNG) + fake Agent Channel API, all on an egress-less internal network. Proves:
# plugins load, cell sync, WS connect, a mention produces a reply in the right thread naming the asker
# and participants, a mention without a turn offers 0 tools, internet on offers exactly
# web_fetch,web_search and a search goes through the tool gate (authorized + outcome reported), no
# published ports, and a ChatGPT-subscription sign-in command reaches OpenClaw's own device-code login
# (which cannot reach auth.openai.com here, so it must report a classified error), and the bot's memory
# tool `ocw_memory_save` stores a note through `POST /memories` while the turn's notes reach the model.
#
# Usage (repo root):  infra/openclaw/test/run-container-smoke.sh [--keep]
#   SMOKE_ONLY=<comma list>  run only these scenarios (unset = all): mention, signin, dm, capabilities,
#                            dm-isolation, memory
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
# The official search plugins, same pins + integrity check as the image build, bind-mounted read-only
# (an image built before Phase 3.1 has no /opt/ocw/plugins; the mount works on either).
echo "== bundled search plugins (pinned, sha512-checked)"
bash "$ROOT/infra/openclaw/install-bundled-plugins.sh" "$SECRETS/bundled" | sed 's/^/   /'
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
  -v "$ROOT/infra/fake-model/server.mjs:/app/server.mjs:ro" \
  -e FAKE_MODEL_CAPTURE_DIR=/tmp/capture \
  ocw-fake-model:local >/dev/null

docker run -d --name "${P}-api" "${OOM[@]}" --network "$NET" --network-alias api \
  -v "$PLUGIN:/plugin:ro" \
  -e FAKE_API_PORT=4000 -e FAKE_API_TOKEN="$TOKEN" \
  -e FAKE_BOT_ID=0199a6f0-0000-7000-8000-00000000a001 \
  -e FAKE_CELL_ID=0199a6f0-0000-7000-8000-0000000000c0 \
  -e FAKE_MODEL_BASE_URL=http://fake-model:18999/v1 \
  -e FAKE_AGENT_TOOLS=web_search,web_fetch,ocw_memory_save \
  -e FAKE_WEB_SEARCH_PROVIDER=searxng \
  node:24.21.0-bookworm-slim node /plugin/src/testing/run-fake-api.ts >/dev/null

docker run -d --name "${P}-openclaw" "${OOM[@]}" ${CELL_LIMIT[@]+"${CELL_LIMIT[@]}"} --network "$NET" \
  -v "$VOL:/home/node/.openclaw" \
  -v "$SECRETS/cell_token:/run/secrets/ocw_cell_token:ro" \
  -v "$PLUGIN:/opt/ocw/openclaw-channel:ro" \
  -v "$ROOT/infra/openclaw/entrypoint.mjs:/opt/ocw/entrypoint.mjs:ro" \
  -v "$ROOT/infra/openclaw/render-config.mjs:/opt/ocw/render-config.mjs:ro" \
  -v "$SECRETS/bundled:/opt/ocw/plugins:ro" \
  -e OCW_API_URL=http://api:4000 \
  -e OCW_CELL_TOKEN_FILE=/run/secrets/ocw_cell_token \
  -e OCW_SEARXNG_URL=http://fake-model:18999 \
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
if docker exec "${P}-openclaw" node -e "fetch('https://api.anthropic.com').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
  echo "FAIL: container has internet egress"; exit 1
fi
echo "   no internet egress"
docker stats --no-stream --format '   memory: {{.MemUsage}}' "${P}-openclaw"
echo "PASS"
