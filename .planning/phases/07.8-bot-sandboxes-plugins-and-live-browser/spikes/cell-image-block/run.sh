#!/usr/bin/env bash
# Spike (ii), 07.8-03: does an image block returned by a plugin tool reach the model in a real OpenClaw 2026.9.7 cell?
# Throwaway; run locally (Docker), from anywhere:
#
#   bash .planning/phases/07.8-bot-sandboxes-plugins-and-live-browser/spikes/cell-image-block/run.sh > report.json
#
# It builds, from a SCRATCH copy of the tree outside the repository, the cell image ocw-openclaw:spike-078 (the
# product plugin + spike-tool.ts registered from register-full.ts) and the fake model ocw-fake-model:spike-078. It then
# runs fake model + fake Agent Channel API + the cell on an internal network ocw-spike-078-net and offers the bot the
# one tool `ocw_spike_image` (its alsoAllow + the turn's tools). One mention calls it through the fake model's
# `[[call ocw_spike_image {}]]` directive. The fake model captures every request body (FAKE_MODEL_CAPTURE_DIR); the
# report shows the request that carries the tool result, part by part.
# Two variants: the provider model as our cell renders it today (`{id, name}`, no `input`), then the same model declared
# `input: ["text", "image"]` (scratch-only patch of reconciler.ts behind OCW_SPIKE_MODEL_INPUT).
# Everything carries ocw.spike=07.8; the EXIT trap removes containers, network, volumes and both :spike-078 images. No
# demo container, network, volume or :local image is used.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
P=ocw-spike-078
NET="$P-net"
CELL="$P-openclaw"
CELL_IMAGE=ocw-openclaw:spike-078
MODEL_IMAGE=ocw-fake-model:spike-078
NODE_IMAGE=node:24.21.0-bookworm-slim
BOT=0199a6f0-0000-7000-8000-00000000a001
L=(--label ocw.spike=07.8)
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ocw-spike-078.XXXXXX")"
log() { echo "$*" >&2; }

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    for c in "$CELL" "$P-api" "$P-model"; do
      log "---- docker logs $c (tail)"; docker logs "$c" 2>&1 | tail -60 >&2 || true
    done
  fi
  local ids
  ids="$(docker ps -aq --filter label=ocw.spike=07.8)"
  [[ -z "$ids" ]] || docker rm -fv $ids >/dev/null
  for v in $(docker volume ls -q --filter label=ocw.spike=07.8); do docker volume rm "$v" >/dev/null; done
  for n in $(docker network ls -q --filter label=ocw.spike=07.8); do docker network rm "$n" >/dev/null; done
  docker image rm "$CELL_IMAGE" "$MODEL_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# ------------------------------------------------------------------ scratch copy (never the repository's files)
log "== scratch copy in $SCRATCH"
CTX="$SCRATCH/ctx"
mkdir -p "$CTX/apps/openclaw-channel" "$CTX/infra"
(cd "$ROOT/apps/openclaw-channel" && tar --exclude node_modules --exclude dist -cf - .) | tar -C "$CTX/apps/openclaw-channel" -xf -
cp -R "$ROOT/infra/openclaw" "$ROOT/infra/fake-model" "$CTX/infra/"
cp "$HERE/spike-tool.ts" "$CTX/apps/openclaw-channel/src/spike-tool.ts"
node - "$CTX/apps/openclaw-channel/src" <<'EOF'
const fs = require("node:fs");
const dir = process.argv[2];
const edit = (file, from, to) => {
  const p = `${dir}/${file}`;
  const s = fs.readFileSync(p, "utf8");
  if (!s.includes(from)) throw new Error(`anchor not found in ${file}: ${from}`);
  fs.writeFileSync(p, s.replace(from, to));
};
edit("register-full.ts", 'import { registerMemoryTool } from "./memory-tool.js";',
  'import { registerMemoryTool } from "./memory-tool.js";\nimport { registerSpikeImageTool } from "./spike-tool.js";');
edit("register-full.ts", "  registerConnectorTools(api, { guard, client });",
  "  registerConnectorTools(api, { guard, client });\n  registerSpikeImageTool(api);");
edit("reconciler.ts", "models: ids.map((id) => ({ id, name: id })),",
  'models: ids.map((id) => ({ id, name: id, ...(process.env.OCW_SPIKE_MODEL_INPUT ? { input: process.env.OCW_SPIKE_MODEL_INPUT.split(",") } : {}) })),');
// OpenClaw resolves plugin tools only if the manifest declares them (contracts.tools); otherwise a turn fails with
// "No callable tools remain … no registered tools matched".
const manifest = `${dir}/../openclaw.plugin.json`;
const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
m.contracts.tools.push("ocw_spike_image");
fs.writeFileSync(manifest, JSON.stringify(m, null, 2));
EOF

log "== build $CELL_IMAGE and $MODEL_IMAGE from the scratch copy"
docker build -q "${L[@]}" -f "$CTX/infra/openclaw/Dockerfile" -t "$CELL_IMAGE" "$CTX" >&2
docker build -q "${L[@]}" -f "$CTX/infra/fake-model/Dockerfile" -t "$MODEL_IMAGE" "$CTX" >&2

# The fake Agent Channel API runs from a self-contained copy of the plugin sources + its locked runtime deps.
PLUGIN="$SCRATCH/plugin"
mkdir -p "$PLUGIN" "$SCRATCH/deps"
cp -R "$CTX/apps/openclaw-channel/src" "$CTX/apps/openclaw-channel/package.json" "$PLUGIN/"
cp "$CTX/infra/openclaw/plugin-runtime/package.json" "$CTX/infra/openclaw/plugin-runtime/package-lock.json" "$SCRATCH/deps/"
(cd "$SCRATCH/deps" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null)
mv "$SCRATCH/deps/node_modules" "$PLUGIN/node_modules"
TOKEN="spike-$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
mkdir -p "$SCRATCH/secrets"
printf '%s' "$TOKEN" >"$SCRATCH/secrets/cell_token"
chmod -R a+rX "$SCRATCH/secrets" "$PLUGIN"

# ------------------------------------------------------------------ fake model + fake API on an internal network
docker network create "${L[@]}" --internal --subnet "${SPIKE_SUBNET:-10.231.81.0/24}" "$NET" >/dev/null
docker run -d --name "$P-model" "${L[@]}" --oom-score-adj 1000 --network "$NET" --network-alias fake-model \
  -e FAKE_MODEL_DEBUG=1 -e FAKE_MODEL_CAPTURE_DIR=/tmp/capture "$MODEL_IMAGE" >/dev/null
docker run -d --name "$P-api" "${L[@]}" --oom-score-adj 1000 --network "$NET" --network-alias api \
  -v "$PLUGIN:/plugin:ro" -e FAKE_API_PORT=4000 -e FAKE_API_TOKEN="$TOKEN" -e FAKE_BOT_ID="$BOT" \
  -e FAKE_CELL_ID=0199a6f0-0000-7000-8000-0000000000c0 -e FAKE_MODEL_BASE_URL=http://fake-model:18999/v1 \
  -e FAKE_AGENT_TOOLS=ocw_spike_image "$NODE_IMAGE" node /plugin/src/testing/run-fake-api.ts >/dev/null

api_exec() { docker exec -i "$P-api" node --input-type=module -e "$1"; }

# The mention: a DM turn offering only ocw_spike_image (untrusted output, no side effect).
mention() { # $1 suffix (event/message ids)
  node -e '
const s = process.argv[1];
console.log(JSON.stringify({
  eventId: `0199a6f0-0000-7000-8000-0000000e078${s}`,
  agent: { id: process.argv[2], handle: "archie", displayName: "Archie" },
  conversation: { id: "0199a6f0-0000-7000-8000-00000000c078", kind: "dm", name: null },
  thread: { rootMessageId: `0199a6f0-0000-7000-8000-0000000d078${s}` },
  message: {
    id: `0199a6f0-0000-7000-8000-0000000d078${s}`,
    text: "show me the page [[call ocw_spike_image {}]]",
    createdAt: "2026-10-15T09:00:00.000Z",
    author: { kind: "user", id: "0199a6f0-0000-7000-8000-0000000000f1", displayName: "Víctor Ruiz" },
    mentions: [{ kind: "agent", id: process.argv[2] }],
  },
  threadHistory: [],
  roster: [
    { kind: "user", id: "0199a6f0-0000-7000-8000-0000000000f1", displayName: "Víctor Ruiz", role: "owner" },
    { kind: "agent", id: process.argv[2], displayName: "Archie", handle: "archie" },
  ],
  turn: {
    tools: ["ocw_spike_image"],
    toolFlags: { ocw_spike_image: { untrustedOutput: true, sideEffecting: false } },
    memory: [], now: null, maxToolCalls: 8, maxWebCalls: 5,
  },
}));' "$1" "$BOT"
}

run_variant() { # $1 name, $2 OCW_SPIKE_MODEL_INPUT ("" = as rendered today), $3 id suffix
  local name="$1" input="$2" sfx="$3" vol="$P-state-$1"
  log "== variant $name (model input: ${input:-<not declared>})"
  docker exec "$P-model" sh -c 'rm -rf /tmp/capture' || true
  docker volume create "${L[@]}" "$vol" >/dev/null
  docker run -d --name "$CELL" "${L[@]}" --oom-score-adj 1000 --network "$NET" \
    -v "$vol:/home/node/.openclaw" -v "$SCRATCH/secrets/cell_token:/run/secrets/ocw_cell_token:ro" \
    -e OCW_API_URL=http://api:4000 -e OCW_CELL_TOKEN_FILE=/run/secrets/ocw_cell_token -e OCW_BUNDLED_PLUGINS=none \
    -e OCW_SPIKE_MODEL_INPUT="$input" -e NODE_OPTIONS=--max-old-space-size=768 "$CELL_IMAGE" >/dev/null
  for _ in $(seq 1 180); do
    docker logs "$CELL" 2>&1 | grep -q "agent channel connected" && break
    docker ps -q --filter "name=^${CELL}$" | grep -q . || { log "FAIL: cell exited"; exit 1; }
    sleep 1
  done
  docker logs "$CELL" 2>&1 | grep -q "agent channel connected" || { log "FAIL: plugin never connected"; exit 1; }
  # Let the reconciler write the bot and provider into OpenClaw's config.
  for _ in $(seq 1 60); do docker logs "$CELL" 2>&1 | grep -q "reconciled OpenClaw" && break; sleep 1; done

  mention "$sfx" | api_exec "
const body = await new Response(process.stdin).text();
const r = await fetch('http://127.0.0.1:4000/__test/mention', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
console.error('   published seq', (await r.json()).seq);" >&2
  local reply_to="0199a6f0-0000-7000-8000-0000000d078$sfx" state=""
  for _ in $(seq 1 120); do
    state="$(api_exec "console.log(JSON.stringify(await (await fetch('http://127.0.0.1:4000/__test/state')).json()))")"
    REPLY_TO="$reply_to" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
process.exit(s.messages.some((m) => m.inReplyToMessageId === process.env.REPLY_TO) ? 0 : 1);' <<<"$state" && break
    sleep 1
  done

  local captures config
  # One compact JSON line per captured request (the fake model writes them pretty-printed).
  captures="$(docker exec "$P-model" node -e '
const fs = require("fs"), d = "/tmp/capture";
if (fs.existsSync(d)) for (const f of fs.readdirSync(d).sort()) console.log(JSON.stringify(JSON.parse(fs.readFileSync(`${d}/${f}`, "utf8"))));' || true)"
  config="$(docker exec "$CELL" sh -c 'cat /home/node/.openclaw/openclaw.json' 2>/dev/null || echo '{}')"
  NAME="$name" INPUT="$input" REPLY_TO="$reply_to" EVENT="0199a6f0-0000-7000-8000-0000000e078$sfx" \
    STATE="$state" CONFIG="$config" node -e '
const lines = require("fs").readFileSync(0, "utf8").split("\n").filter((l) => l.trim());
const bodies = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const s = JSON.parse(process.env.STATE || "{}");
const reply = (s.messages ?? []).find((m) => m.inReplyToMessageId === process.env.REPLY_TO);
const calls = (s.toolCalls ?? []).filter((c) => c.eventId === process.env.EVENT);
let cfg = {}; try { cfg = JSON.parse(process.env.CONFIG); } catch {}
const part = (p) => {
  if (typeof p === "string") return { type: "string", text: p.slice(0, 120) };
  const o = { type: p?.type };
  if (p?.type === "text") o.text = String(p.text).slice(0, 120);
  if (p?.type === "image_url") { const u = String(p.image_url?.url ?? ""); o.url = u.slice(0, 48) + "…"; o.urlLength = u.length; }
  if (p?.type === "image") o.source = { ...p.source, data: p.source?.data ? `${String(p.source.data).slice(0, 16)}… (${String(p.source.data).length})` : undefined };
  return o;
};
const summarize = (b) => ({
  model: b.model,
  tools: (b.tools ?? []).map((t) => t.function?.name ?? t.name),
  messages: (b.messages ?? []).map((m) => ({
    role: m.role,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls.map((c) => c.function?.name) } : {}),
    content: Array.isArray(m.content) ? m.content.map(part) : part(m.content ?? ""),
  })),
});
const afterTool = bodies.filter((b) => (b.messages ?? []).some((m) => m.role === "tool"));
const imageParts = afterTool.flatMap((b) => (b.messages ?? []).flatMap((m, i) =>
  (Array.isArray(m.content) ? m.content : []).filter((p) => p?.type === "image_url" || p?.type === "image")
    .map((p) => ({ messageIndex: i, role: m.role, type: p.type }))));
console.log(JSON.stringify({
  variant: process.env.NAME,
  modelInputDeclared: process.env.INPUT || null,
  renderedProviderModels: cfg?.models?.providers?.fake?.models ?? null,
  toolCalls: calls.map((c) => ({ tool: c.tool, allowed: c.allowed })),
  reply: reply?.text ?? null,
  capturedRequests: bodies.length,
  imagePartsAfterToolResult: imageParts,
  imageReachedModel: imageParts.length > 0,
  requestAfterToolResult: afterTool.length ? summarize(afterTool[0]) : null,
}));' <<<"$captures"
  docker logs "$CELL" 2>&1 | grep -i -E "image|ocw_spike" | grep -v -i "docker" | tail -5 >&2 || true
  docker rm -fv "$CELL" >/dev/null
  docker volume rm "$vol" >/dev/null
}

run_variant as-rendered "" 1
run_variant input-image "text,image" 2
