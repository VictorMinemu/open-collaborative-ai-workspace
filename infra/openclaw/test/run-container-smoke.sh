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
# Scenario sandbox (03.1-14 / D-13): a vetted stdio MCP server runs only in the hardened `ocw-mcp-sandbox` sidecar; the
# cell sees it as a remote streamable-HTTP server on an internal network shared with the sidecar alone, probes it and a
# bot calls its `echo` tool through the gate, while no third-party MCP code runs inside the gateway container.
# Scenario card (06-14 / AGENT-04): a turn offering `ocw_agent_card` posts a typed card through the gate and
# `POST /cards`, bound to the turn's conversation, thread and message; an `agent.card_action.v1` (approval) reaches the
# persona as a turn in the same thread, which updates the card with the version it saw (`PATCH /cards/:id`).
# Scenario board (07.1-13 / BOARD-02): a board channel's turn offering `ocw_board_card` runs the plugin tool in OpenClaw
# (configured through the bot's alsoAllow, narrowed by the turn's toolsAllow), which creates a card through
# `POST /board/cards` bound to the turn's event, never through `/tool-calls`; the card scenario's text turn still runs
# with exactly `ocw_agent_card`.
# Scenario memory-files (07.2-15 / MEM-04, D-01): a DM turn offering `ocw_memory_read` and `ocw_memory_propose` (and
# carrying the person's private MEMORY.md as a turn memory file) reads the file through the gate and `/memory/read`, and
# proposes a team note through `/memory/propose` (self-validated, never `/tool-calls`), which ends in one platform-owned
# approval card answering the turn; nothing is written. A turn whose human no longer reads its conversation gets 403
# `no_trigger` on both calls (read by the plugin as "this conversation turn is no longer active"), and the cell's own
# memory slot stays `none`.
# Scenario connectors (07.4-09 / CONN-03, CONN-04, CONN-05, D-07, C-01): a DM turn offering the static
# `ocw_connector_call` and the logical `m1a2b3c4d__whoami` runs the plugin tool in OpenClaw, which asks
# `POST /connectors/call` with the turn's event and agent only (self-validated, never `/tool-calls`); the logical tool
# itself never reaches the model as a tool. A 30 s call (the API proxy's upstream limit, 07.4-14 / ADR-0025 upgrade
# checklist) still completes inside the turn (research A4); not connected, needs reconnect and member-account refusals
# reach the model as the fixed sentences, never the API's error body; a channel turn withholding
# the member's connector (`member_account`) hands the persona the share link (R7); `ocw_connector_list` and
# `ocw_http_request` (a GET by key handle) go through their own routes; the cell's config has no per-member MCP server
# and no state file or log line carries the member's connector token.
# Scenario breaker (stability 2026-10-06): SIGKILLed boots trip OpenClaw's restart-loop breaker, which refuses the ocw
# channel's automatic start; the plugin reports the pause to the API and starts the channel itself after its back-off.
#
# Usage (repo root):  infra/openclaw/test/run-container-smoke.sh [--keep]
#   SMOKE_ONLY=<comma list>  run only these scenarios (unset = all): mention, signin, dm, capabilities,
#                            dm-isolation, memory, memory-files, card, board, connectors, mcp, marketplace, breaker
#                            and sandbox (runs when it is listed, with SMOKE_BUILD=1, or when ocw-mcp-sandbox:local
#                            exists; otherwise it prints "SKIP sandbox (image not built)")
#   FAKE_MODEL_DEBUG=1       the fake model logs a preview of each tool-offering request (off by default)
#   SMOKE_CELL_IMAGE / SMOKE_MODEL_IMAGE / SMOKE_SANDBOX_IMAGE  image tags to build and run (defaults
#                            ocw-openclaw:local, ocw-fake-model:local, ocw-mcp-sandbox:local); a unique tag keeps a
#                            smoke away from the images a running stack uses
# Requires: docker, node + npm (bundled plugins are installed on the host from the pinned registry
# tarballs), apps/openclaw-channel/node_modules (pnpm install / npm install in that dir).
set -euo pipefail

CELL_IMAGE="${SMOKE_CELL_IMAGE:-ocw-openclaw:local}"
MODEL_IMAGE="${SMOKE_MODEL_IMAGE:-ocw-fake-model:local}"
SANDBOX_IMAGE="${SMOKE_SANDBOX_IMAGE:-ocw-mcp-sandbox:local}"

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
# Connectors (scenario connectors): the member credential the API would use upstream. Only the fake API holds it; it must
# never reach the cell (config, state volume, logs).
CONN_TOKEN="conn-$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
# CellMcpServer[] with the given toolFilter.include (JSON array of raw MCP tool names).
mcp_servers_json() {
  printf '[{"id":"%s","safeName":"%s","transport":"streamable-http","url":"http://fake-model:18999/mcp","headers":[{"name":"Authorization","envName":"%s","value":"Bearer %s"}],"tools":%s}]' \
    "$MCP_SERVER_ID" "$MCP_SAFE" "$MCP_ENV" "$MCP_TOKEN" "$1"
}

# Stdio MCP sandbox (scenario sandbox): the sidecar serves the baked `everything` server; the cell reaches it on a second
# internal network shared with the sidecar alone (compose network `mcp-sandbox`). No header, no credential.
SBX_NET="${P}-sbx-net"
SBX_SAFE=m5a4db0c5
SBX_SERVER_ID=0199a6f0-0000-7000-8000-000000000c52
SBX_URL=http://mcp-sandbox:8080/everything/mcp
# Fake MCP + sandbox servers (CellMcpServer[]): the fake keeps echo and write_note enabled, the sandbox only echo.
sandbox_servers_json() {
  printf '[%s,{"id":"%s","safeName":"%s","transport":"streamable-http","url":"%s","headers":[],"tools":["echo"]}]' \
    "$(mcp_servers_json '["echo","write_note"]' | sed 's/^\[//; s/\]$//')" "$SBX_SERVER_ID" "$SBX_SAFE" "$SBX_URL"
}
SANDBOX=0
if want sandbox; then
  if [[ ",${SMOKE_ONLY:-}," == *",sandbox,"* || "${SMOKE_BUILD:-0}" == "1" ]] ||
    docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
    SANDBOX=1
  else
    echo "SKIP sandbox (image not built)"
  fi
fi

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
# Scenario sandbox: its sidecar and network are diagnosed and removed first, then cleanup runs as before.
sandbox_cleanup() {
  if [[ "$SANDBOX" == "1" ]]; then
    if [[ "$1" -ne 0 ]]; then
      echo "---- docker logs ${P}-mcp-sandbox (last 50 lines)" >&2
      docker logs "${P}-mcp-sandbox" 2>&1 | tail -50 >&2 || true
    fi
    if [[ "$KEEP" != "--keep" ]]; then
      docker rm -f "${P}-mcp-sandbox" >/dev/null 2>&1 || true
      # The cell (removed by cleanup) is still attached to the network here.
      docker network disconnect -f "$SBX_NET" "${P}-openclaw" >/dev/null 2>&1 || true
      docker network rm "$SBX_NET" >/dev/null 2>&1 || true
    fi
  fi
}
# errexit is off inside the trap so cleanup always runs, and `(exit …)` hands it the script's real exit status.
trap 'SMOKE_STATUS=$?; set +e; sandbox_cleanup "$SMOKE_STATUS"; (exit "$SMOKE_STATUS"); cleanup' EXIT

# Images are built only when missing or SMOKE_BUILD=1 (the cell image is ~1.3 GB compressed).
# The working-tree plugin (dist, copied with its runtime deps) and entrypoint are bind-mounted over
# the image copies, so plugin changes never need a rebuild: run `pnpm --filter @ocw/openclaw-channel build`.
if [[ "${SMOKE_BUILD:-0}" == "1" ]] || ! docker image inspect "$CELL_IMAGE" >/dev/null 2>&1; then
  echo "== build $CELL_IMAGE"
  docker build -q -f "$ROOT/infra/openclaw/Dockerfile" -t "$CELL_IMAGE" "$ROOT" >/dev/null
fi
if [[ "${SMOKE_BUILD:-0}" == "1" ]] || ! docker image inspect "$MODEL_IMAGE" >/dev/null 2>&1; then
  echo "== build $MODEL_IMAGE"
  docker build -q -f "$ROOT/infra/fake-model/Dockerfile" -t "$MODEL_IMAGE" "$ROOT" >/dev/null
fi
# The stdio MCP sandbox image is small (node slim base shared with the cell, the pinned servers from its lockfile).
if [[ "$SANDBOX" == "1" ]] && { [[ "${SMOKE_BUILD:-0}" == "1" ]] || ! docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; }; then
  echo "== build $SANDBOX_IMAGE"
  docker build -q -f "$ROOT/infra/mcp-sandbox/Dockerfile" -t "$SANDBOX_IMAGE" "$ROOT/infra/mcp-sandbox" >/dev/null
fi
[[ -f "$ROOT/apps/openclaw-channel/dist/index.js" ]] || { echo "FAIL: build the plugin first (dist/ missing)"; exit 1; }

# Self-contained copy of the working-tree plugin: pnpm's node_modules are symlinks into the repo root
# store, which do not resolve inside the containers.
PLUGIN="$SECRETS/plugin"
mkdir -p "$PLUGIN/node_modules"
cp -R "$ROOT/apps/openclaw-channel/dist" "$ROOT/apps/openclaw-channel/src" "$PLUGIN/"
cp "$ROOT/apps/openclaw-channel/package.json" "$ROOT/apps/openclaw-channel/openclaw.plugin.json" "$PLUGIN/"
# Runtime dependencies exactly as the image build installs them (`npm ci` from infra/openclaw/plugin-runtime's
# lockfile, no lifecycle scripts): the MCP SDK's transitive dependencies are not reachable through pnpm's symlinks.
mkdir -p "$SECRETS/plugin-deps"
cp "$ROOT/infra/openclaw/plugin-runtime/package.json" "$ROOT/infra/openclaw/plugin-runtime/package-lock.json" \
  "$SECRETS/plugin-deps/"
(cd "$SECRETS/plugin-deps" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null)
rm -rf "$PLUGIN/node_modules"
cp -R "$SECRETS/plugin-deps/node_modules" "$PLUGIN/node_modules"
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
if [[ "$SANDBOX" == "1" ]]; then
  docker network rm "$SBX_NET" >/dev/null 2>&1 || true
  docker network create --internal --subnet "${SMOKE_SANDBOX_SUBNET:-10.231.76.0/24}" "$SBX_NET" >/dev/null
fi

# Smoke containers are the kernel's first OOM victims (oom-score-adj 1000): on a memory-tight Docker VM the
# smoke must fail, never take down another workload (e.g. a running demo cell).
OOM=(--oom-score-adj 1000)
# Optional hard cap for the cell (e.g. SMOKE_CELL_MEMORY=1g on a shared, memory-starved Docker VM).
CELL_LIMIT=()
[[ -n "${SMOKE_CELL_MEMORY:-}" ]] && CELL_LIMIT=(--memory "$SMOKE_CELL_MEMORY")

# Stdio MCP sandbox sidecar with the compose hardening (compose.yaml service mcp-sandbox): only on its own internal
# network, which the cell joins below. Nothing mounted, no secrets, no ports.
if [[ "$SANDBOX" == "1" ]]; then
  docker run -d --name "${P}-mcp-sandbox" "${OOM[@]}" --network "$SBX_NET" --network-alias mcp-sandbox \
    --init --user node --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 128 --memory 512m --cpus 1 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    "$SANDBOX_IMAGE" >/dev/null
fi

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
  "$MODEL_IMAGE" >/dev/null

# The bot may use the sandbox's echo (its alsoAllow); the server itself reaches the snapshot in scenario sandbox.
SBX_TOOLS=""
[[ "$SANDBOX" == "1" ]] && SBX_TOOLS=",${SBX_SAFE}__echo"
docker run -d --name "${P}-api" "${OOM[@]}" --network "$NET" --network-alias api \
  -v "$PLUGIN:/plugin:ro" \
  -e FAKE_API_PORT=4000 -e FAKE_API_TOKEN="$TOKEN" \
  -e FAKE_BOT_ID=0199a6f0-0000-7000-8000-00000000a001 \
  -e FAKE_CELL_ID=0199a6f0-0000-7000-8000-0000000000c0 \
  -e FAKE_MODEL_BASE_URL=http://fake-model:18999/v1 \
  -e FAKE_AGENT_TOOLS="web_search,web_fetch,ocw_memory_save,ocw_memory_read,ocw_memory_propose,ocw_agent_card,ocw_connector_list,ocw_connector_call,ocw_http_request,${MCP_SAFE}__echo,${MCP_SAFE}__write_note,ocw_echo${SBX_TOOLS:-}" \
  -e FAKE_MCP_SERVERS="$(mcp_servers_json '["echo"]')" \
  -e FAKE_CONNECTOR_TOKEN="$CONN_TOKEN" \
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
  -e OCW_BREAKER_BACKOFF_MS=5000 \
  -e NODE_OPTIONS="${CELL_NODE_OPTIONS:---max-old-space-size=512}" \
  "$CELL_IMAGE" >/dev/null
if [[ "${SMOKE_BUILD:-0}" != "1" ]]; then
  # OpenClaw refuses an install-policy script that is not root- (or gateway-) owned: a bind mount would carry the
  # runner's uid, so the working-tree gate is copied in (docker cp writes root-owned files).
  docker cp "$ROOT/infra/openclaw/install-policy.mjs" "${P}-openclaw:/opt/ocw/install-policy.mjs"
fi
# The cell also joins the sandbox network (compose: openclaw is on default + mcp-sandbox).
[[ "$SANDBOX" == "1" ]] && docker network connect "$SBX_NET" "${P}-openclaw"
docker start "${P}-openclaw" >/dev/null

echo "== waiting for the plugin to connect"
for i in $(seq 1 120); do
  if docker logs "${P}-openclaw" 2>&1 | grep "agent channel connected" >/dev/null; then break; fi
  if ! docker ps --format '{{.Names}}' | grep -q "^${P}-openclaw$"; then
    docker logs "${P}-openclaw" 2>&1 | tail -40
    echo "FAIL: openclaw container exited"
    exit 1
  fi
  sleep 1
done
if ! docker logs "${P}-openclaw" 2>&1 | grep "agent channel connected" >/dev/null; then
  echo "FAIL: the ocw channel plugin never connected to the Agent Channel API within 120 s" >&2
  exit 1
fi
docker logs "${P}-openclaw" 2>&1 | grep -E "ocw-cell|http server listening|\[ocw\]|heartbeat" | sed 's/^/   /'

api_exec() { docker exec -i "${P}-api" node --input-type=module -e "$1"; }

# Publishes a fixture event through the fake Agent Channel API, then waits until a reply answering
# `$2` (inReplyToMessageId) is stored and typing for its conversation switched off; prints the state.
# `$3` (optional): the test route, `/__test/mention` (a mention body) or `/__test/event` (a `{type, data}` body).
inject_and_wait() {
  local fixture="$1" reply_to="$2" route="${3:-/__test/mention}" state=""
  api_exec "
const body = await new Response(process.stdin).text();
const r = await fetch('http://127.0.0.1:4000$route', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
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

if want memory-files; then
echo "== [memory-files] a DM turn offering ocw_memory_read and ocw_memory_propose: the bot reads its memory file and proposes a team note, which ends in an approval card"
# The fake API's memory store: the person's private MEMORY.md with this bot (what the real API serves to the read) and
# the reader count a proposal into the team scope answers with.
api_exec "
await fetch('http://127.0.0.1:4000/__test/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  files: [{ scope: 'personal', path: 'MEMORY.md', version: 2, content: '# Memory\n- prefers calls after 4 pm\n' }],
  readerCount: 4,
}) });
"
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention-memory-files.json" 0199a6f0-0000-7000-8000-00000000d0b1)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const EV = "0199a6f0-0000-7000-8000-00000000e021";
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0b1");
if (!m) { console.log("FAIL: no reply to the memory-files mention"); process.exit(1); }
const calls = (s.memoryCalls ?? []).filter((c) => c.body.eventId === EV);
const reads = calls.filter((c) => c.route === "read");
const proposes = calls.filter((c) => c.route === "propose");
const gated = s.toolCalls.filter((c) => c.eventId === EV);
const cards = (s.approvalCards ?? []).filter((c) => c.eventId === EV);
const keys = (c) => Object.keys(c.body).sort().join();
console.log("   reply      :", m.text.replace(/\n/g, " / "));
console.log("   memory     :", JSON.stringify(calls.map((c) => ({ route: c.route, keys: keys(c) }))));
console.log("   tool calls :", JSON.stringify(gated.map((c) => ({ tool: c.tool, allowed: c.allowed }))));
console.log("   cards      :", JSON.stringify(cards.map(({ conversationId, inReplyToMessageId, platformOwned, card }) => ({ conversationId, inReplyToMessageId, platformOwned, kind: card.kind, title: card.title, status: card.status }))));
const c = cards[0];
const ok =
  /\[tools: 2 \| ocw_memory_propose,ocw_memory_read\]/.test(m.text) &&
  // The read result (path, version and the file body) and the proposal result reach the reply.
  m.text.includes("Tool ocw_memory_read said: MEMORY.md (version 2)") && m.text.includes("prefers calls after 4 pm") &&
  m.text.includes("Tool ocw_memory_propose said: Proposed. A person must approve it before it is saved.") &&
  m.text.includes("4 people could read it once approved.") &&
  reads.length === 1 && keys(reads[0]) === "agentId,eventId,path,scope" &&
  reads[0].body.scope === "personal" && reads[0].body.path === "MEMORY.md" &&
  proposes.length === 1 && keys(proposes[0]) === "agentId,content,eventId,op,path,scope" &&
  proposes[0].body.scope === "0199a6f0-0000-7000-8000-0000000005c1" && proposes[0].body.op === "append" &&
  proposes[0].body.agentId === "0199a6f0-0000-7000-8000-00000000a001" &&
  // read goes through the generic gate; propose is self-validated by its route (never /tool-calls).
  gated.length === 1 && gated[0].tool === "ocw_memory_read" && gated[0].allowed === true &&
  // The proposal ends in exactly one platform-owned approval card answering the turn in its conversation.
  cards.length === 1 && c.platformOwned === true && c.card.kind === "approval" && c.card.status === "pending" &&
  c.card.title === "Append to clients/acme.md" &&
  c.conversationId === "0199a6f0-0000-7000-8000-00000000c021" &&
  c.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0b1" &&
  (s.cards ?? []).every((x) => !x.idempotencyKey.startsWith(EV)) &&
  // Nothing was written: a person approves first.
  s.memoryFileStore.length === 1 && s.memoryFileStore[0].version === 2;
if (!ok) { console.log("FAIL: expected one gated read, one self-validated propose and one pending approval card"); process.exit(1); }
'
# The turn's memory file (turn.memoryFiles, rendered into the prompt) reaches the model for this conversation only.
FILE_REQS="$(docker exec "${P}-model" sh -c "grep -l '0199a6f0-0000-7000-8000-00000000c021' /tmp/capture/*.json 2>/dev/null | xargs -r grep -l 'prefers calls after 4 pm' | wc -l")"
FILE_LEAKS="$(docker exec "${P}-model" sh -c "grep -L '0199a6f0-0000-7000-8000-00000000c021' /tmp/capture/*.json 2>/dev/null | xargs -r grep -l 'prefers calls after 4 pm' | wc -l")"
echo "   files      : $FILE_REQS model request(s) of this DM carry the memory file, $FILE_LEAKS other request(s) do"
[[ "$FILE_REQS" -ge 1 ]] || { echo "FAIL: the turn's memory file did not reach the model"; exit 1; }
[[ "$FILE_LEAKS" -eq 0 ]] || { echo "FAIL: the memory file reached a model request of another conversation"; exit 1; }

echo "== [memory-files] a turn whose human no longer reads the conversation: both calls answer no_trigger, nothing is proposed"
EXPIRED="$SECRETS/memory-files-expired.json"
node -e '
const fs = require("fs");
const e = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
e.eventId = "0199a6f0-0000-7000-8000-00000000e022";
e.conversation = { ...e.conversation, id: "0199a6f0-0000-7000-8000-00000000c022" };
e.thread = { rootMessageId: "0199a6f0-0000-7000-8000-00000000d0b2" };
e.message = { ...e.message, id: "0199a6f0-0000-7000-8000-00000000d0b2" };
fs.writeFileSync(process.argv[2], JSON.stringify(e));
' "$ROOT/infra/openclaw/test/mention-memory-files.json" "$EXPIRED"
# The real API answers 403 no_trigger to every memory route once the turn is no longer live for its human (PR #25).
api_exec "
await fetch('http://127.0.0.1:4000/__test/end-turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventId: '0199a6f0-0000-7000-8000-00000000e022' }) });
"
STATE="$(inject_and_wait "$EXPIRED" 0199a6f0-0000-7000-8000-00000000d0b2)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const EV = "0199a6f0-0000-7000-8000-00000000e022";
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0b2");
if (!m) { console.log("FAIL: no reply to the expired-turn mention"); process.exit(1); }
const refused = (s.memoryNoTriggers ?? []).filter((c) => c.eventId === EV).map((c) => c.route);
console.log("   reply      :", m.text.replace(/\n/g, " / "));
console.log("   no_trigger :", JSON.stringify(refused));
const ok =
  m.text.includes("Tool ocw_memory_read said: Not read: this conversation turn is no longer active.") &&
  m.text.includes("Tool ocw_memory_propose said: Not proposed: this conversation turn is no longer active.") &&
  refused.join() === "read,propose" &&
  (s.approvalCards ?? []).every((c) => c.eventId !== EV) &&
  s.memoryFileStore.length === 1 && s.memoryFileStore[0].version === 2;
if (!ok) { console.log("FAIL: expected both memory calls of the ended turn to answer no_trigger and nothing to be proposed"); process.exit(1); }
'

echo "== [memory-files] the cell's own memory stays off (render-config memory slot none)"
SLOT="$(docker exec "${P}-openclaw" cat /home/node/.openclaw/openclaw.json | node -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(c.plugins?.slots?.memory ?? null));
')"
echo "   memory slot: $SLOT"
[[ "$SLOT" == '"none"' ]] || { echo "FAIL: the cell's memory slot is not none"; exit 1; }
fi

if want card; then
echo "== [card] a channel turn offering ocw_agent_card: the model posts a card through the gate and POST /cards"
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention-card.json" 0199a6f0-0000-7000-8000-00000000d091)"
CARD_ID="$(echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d091");
if (!m) { console.error("FAIL: no reply to the card mention"); process.exit(1); }
const cards = (s.cards ?? []).filter((c) => c.idempotencyKey.startsWith("0199a6f0-0000-7000-8000-00000000e006:"));
const gated = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e006");
console.error("   reply      :", m.text);
console.error("   cards      :", JSON.stringify(cards.map(({ conversationId, threadRootId, inReplyToMessageId, idempotencyKey, card }) => ({ conversationId, threadRootId, inReplyToMessageId, idempotencyKey, kind: card.kind, title: card.title }))));
console.error("   tool calls :", JSON.stringify(gated.map((c) => ({ tool: c.tool, params: c.params, allowed: c.allowed }))));
const c = cards[0];
const ok =
  m.text.includes("Tool ocw_agent_card said: Card posted.") &&
  /\[tools: 1 \| ocw_agent_card\]/.test(m.text) &&
  cards.length === 1 && c.agentId === "0199a6f0-0000-7000-8000-00000000a001" &&
  c.conversationId === "0199a6f0-0000-7000-8000-00000000c001" &&
  c.threadRootId === "0199a6f0-0000-7000-8000-00000000d090" &&
  c.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d091" &&
  c.idempotencyKey === "0199a6f0-0000-7000-8000-00000000e006:card:0" &&
  c.card.kind === "deployment" && c.card.title === "Deploy api v2.3" && c.card.actions.length === 3 &&
  // Gated like every tool: asked once, allowed, only the query/url params travel (none here).
  gated.length === 1 && gated[0].tool === "ocw_agent_card" && gated[0].allowed === true &&
  Object.keys(gated[0].params).length === 0;
if (!ok) { console.error("FAIL: expected one gated ocw_agent_card that posts one card bound to the turn"); process.exit(1); }
console.log(c.messageId);
')"
echo "== [card] agent.card_action.v1 (Sam approved): a turn in the card's thread that updates the card"
ACTION="$SECRETS/card-action.json"
CARD_ID="$CARD_ID" node -e '
const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const id = process.env.CARD_ID;
e.eventId = "0199a6f0-0000-7000-8000-00000000e007";
// The real API sends the server sentence only; the directive drives the fake model (update with the id it got).
const update = JSON.stringify({ action: "update", cardId: id, patch: { status: "succeeded" } });
e.message = {
  ...e.message,
  id,
  text: `Sam Lee approved “Deploy api v2.3” [[call ocw_agent_card ${update}]]`,
  author: { kind: "user", id: "0199a6f0-0000-7000-8000-0000000000f3", displayName: "Sam Lee" },
};
e.cardAction = { messageId: id, kind: "deployment", title: "Deploy api v2.3", outcome: "approved" };
require("fs").writeFileSync(process.argv[2], JSON.stringify({ type: "agent.card_action.v1", data: e }));
' "$ROOT/infra/openclaw/test/mention-card.json" "$ACTION"
STATE="$(inject_and_wait "$ACTION" "$CARD_ID" /__test/event)"
echo "$STATE" | CARD_ID="$CARD_ID" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const id = process.env.CARD_ID;
const m = s.messages.find((x) => x.inReplyToMessageId === id);
if (!m) { console.log("FAIL: no reply to the card action"); process.exit(1); }
const patches = (s.cardPatches ?? []).filter((p) => p.messageId === id);
const gated = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e007");
console.log("   reply      :", m.text);
console.log("   thread     :", m.threadRootMessageId, "idempotency", m.idempotencyKey);
console.log("   patches    :", JSON.stringify(patches.map(({ agentId, patch, status }) => ({ agentId, patch, status }))));
const ok =
  m.text.includes("Tool ocw_agent_card said: Card updated.") &&
  m.threadRootMessageId === "0199a6f0-0000-7000-8000-00000000d090" &&
  m.idempotencyKey === "evt:0199a6f0-0000-7000-8000-00000000e007" &&
  patches.length === 1 && patches[0].status === 200 &&
  patches[0].agentId === "0199a6f0-0000-7000-8000-00000000a001" &&
  patches[0].patch.expectedVersion === 1 && patches[0].patch.status === "succeeded" &&
  gated.length === 1 && gated[0].allowed === true;
if (!ok) { console.log("FAIL: expected the card action as a turn in the thread and one versioned PATCH /cards"); process.exit(1); }
'
fi

if want board; then
echo "== [board] a board channel's turn offering ocw_board_card: the plugin tool creates a card through POST /board/cards"
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention-board.json" 0199a6f0-0000-7000-8000-00000000d0a1)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0a1");
if (!m) { console.log("FAIL: no reply to the board mention"); process.exit(1); }
const cards = (s.boardCards ?? []).filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e008");
const gated = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e008");
console.log("   reply      :", m.text);
console.log("   cards      :", JSON.stringify(cards.map(({ agentId, idempotencyKey, description, conversationId }) => ({ agentId, idempotencyKey, description, conversationId }))));
console.log("   tool calls :", JSON.stringify(gated.map((c) => c.tool)));
const c = cards[0];
const ok =
  c !== undefined &&
  m.text.includes(`Tool ocw_board_card said: Card created. Card id: ${c.messageId}.`) &&
  /\[tools: 2 \| ocw_agent_card,ocw_board_card\]/.test(m.text) &&
  m.threadRootMessageId === "0199a6f0-0000-7000-8000-00000000d0a0" &&
  cards.length === 1 && c.agentId === "0199a6f0-0000-7000-8000-00000000a001" &&
  c.idempotencyKey === "0199a6f0-0000-7000-8000-00000000e008:board:1" &&
  c.description === "Order spare valve" && c.conversationId === undefined &&
  // Self-validated by the board routes: never asked to /tool-calls (no policy_changed, no double count).
  gated.length === 0;
if (!ok) { console.log("FAIL: expected one turn-bound card through POST /board/cards and no /tool-calls request"); process.exit(1); }
'
docker logs "${P}-openclaw" 2>&1 | grep -E "turn 0199a6f0-0000-7000-8000-00000000e008 → session" | sed 's/^/   /' || true
fi

if want connectors; then
CONN_EVENT=0199a6f0-0000-7000-8000-00000000e0c1
echo "== [connectors] a DM turn offering ocw_connector_call: the plugin tool asks POST /connectors/call with the turn's ids only"
STATE="$(inject_and_wait "$ROOT/infra/openclaw/test/mention-connector.json" 0199a6f0-0000-7000-8000-00000000d0c1)"
echo "$STATE" | EVENT="$CONN_EVENT" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0c1");
if (!m) { console.log("FAIL: no reply to the connector mention"); process.exit(1); }
const calls = (s.connectorCalls ?? []).filter((c) => c.eventId === process.env.EVENT);
const gated = s.toolCalls.filter((c) => c.eventId === process.env.EVENT);
console.log("   reply      :", m.text);
console.log("   calls      :", JSON.stringify(calls));
console.log("   tool calls :", JSON.stringify(gated.map((c) => c.tool)));
const c = calls[0];
const ok =
  m.text.includes("Tool ocw_connector_call said: whoami: sub_smoke") &&
  /\[tools: \d+ \| [^\]]*ocw_connector_call[^\]]*\]/.test(m.text) && !m.text.includes("m1a2b3c4d__whoami") &&
  calls.length === 1 && c.agentId === "0199a6f0-0000-7000-8000-00000000a001" &&
  c.connector === "m1a2b3c4d" && c.tool === "whoami" && JSON.stringify(c.arguments) === "{}" &&
  // Exactly the call fields (the fake adds only its own receivedAt / answeredAt): never a user.
  Object.keys(c).filter((k) => k !== "receivedAt" && k !== "answeredAt").sort().join() === "agentId,arguments,connector,eventId,tool" &&
  // Self-validated by /connectors/call: never asked to /tool-calls.
  gated.length === 0;
if (!ok) { console.log("FAIL: expected one ocw_connector_call through POST /connectors/call with the turn ids only and no /tool-calls request"); process.exit(1); }
'
# Fake API knobs for the connector routes ({} resets them).
connectors_control() {
  api_exec "
await fetch('http://127.0.0.1:4000/__test/connectors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify($1) });
"
}
# A variant of mention-connector.json: its own event and message ids (suffix $1), optional message text ($2) and turn JSON
# patch ($3, merged into the turn) and conversation ($4).
connector_variant() {
  local out="$SECRETS/mention-connector-$1.json"
  node -e '
const [src, out, suffix, text, turnPatch, conversation] = process.argv.slice(1);
const e = JSON.parse(require("fs").readFileSync(src, "utf8"));
e.eventId = `0199a6f0-0000-7000-8000-00000000e0${suffix}`;
e.thread.rootMessageId = e.message.id = `0199a6f0-0000-7000-8000-00000000d0${suffix}`;
if (text) e.message.text = text;
if (turnPatch) e.turn = { ...e.turn, ...JSON.parse(turnPatch) };
if (conversation) e.conversation = JSON.parse(conversation);
require("fs").writeFileSync(out, JSON.stringify(e));
' "$ROOT/infra/openclaw/test/mention-connector.json" "$out" "$1" "${2:-}" "${3:-}" "${4:-}"
  printf '%s' "$out"
}

echo "== [connectors] slow: a 30 s connector call completes inside the cell turn (research A4, ADR-0025 checklist)"
connectors_control '{ slowMs: 30000 }'
FIXTURE="$(connector_variant c2)"
STATE="$(inject_and_wait "$FIXTURE" 0199a6f0-0000-7000-8000-00000000d0c2)"
connectors_control '{}'
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0c2");
if (!m) { console.log("FAIL: no reply to the slow connector mention"); process.exit(1); }
const c = (s.connectorCalls ?? []).find((x) => x.eventId === "0199a6f0-0000-7000-8000-00000000e0c2");
console.log("   reply      :", m.text);
console.log("   call took  :", c ? `${((c.answeredAt - c.receivedAt) / 1000).toFixed(1)} s at the API, reply ${((m.receivedAt - c.receivedAt) / 1000).toFixed(1)} s after the call arrived` : "no call");
// The fake held the call 30 s (a timer may fire a few ms early); the reply still carries its result.
const ok = c && c.answeredAt - c.receivedAt >= 29500 && m.text.includes("Tool ocw_connector_call said: whoami: sub_smoke");
if (!ok) { console.log("FAIL: the 30 s connector call did not complete inside the turn"); process.exit(1); }
'

echo "== [connectors] not connected: the reply is the fixed connect sentence, never the API body"
connectors_control '{ refusal: "not_connected" }'
FIXTURE="$(connector_variant c3)"
STATE="$(inject_and_wait "$FIXTURE" 0199a6f0-0000-7000-8000-00000000d0c3)"
connectors_control '{}'
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0c3");
if (!m) { console.log("FAIL: no reply to the not-connected mention"); process.exit(1); }
console.log("   reply      :", m.text);
const ok =
  m.text.includes("Tool ocw_connector_call said: You haven\x27t connected your account for this connector yet. I posted a link so you can connect it, then ask me again.") &&
  !m.text.includes("fake-api-error-body-canary") && !m.text.includes("refused by test");
if (!ok) { console.log("FAIL: expected exactly the fixed connect sentence"); process.exit(1); }
'

echo "== [connectors] needs reconnect: the reply asks to reconnect (07.4-14, WINDOWS #198), never the API body"
connectors_control '{ refusal: "needs_reconnect" }'
FIXTURE="$(connector_variant c7)"
STATE="$(inject_and_wait "$FIXTURE" 0199a6f0-0000-7000-8000-00000000d0c7)"
connectors_control '{}'
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0c7");
if (!m) { console.log("FAIL: no reply to the needs-reconnect mention"); process.exit(1); }
console.log("   reply      :", m.text);
const ok =
  m.text.includes("Tool ocw_connector_call said: Your sign-in for this connector stopped working. I posted a link so you can reconnect it, then ask me again.") &&
  !m.text.includes("fake-api-error-body-canary") && !m.text.includes("refused by test");
if (!ok) { console.log("FAIL: expected exactly the fixed reconnect sentence"); process.exit(1); }
'

echo "== [connectors] member account refused by the API: the private-chat sentence"
connectors_control '{ refusal: "member_account" }'
FIXTURE="$(connector_variant c4)"
STATE="$(inject_and_wait "$FIXTURE" 0199a6f0-0000-7000-8000-00000000d0c4)"
connectors_control '{}'
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0c4");
if (!m) { console.log("FAIL: no reply to the member-account mention"); process.exit(1); }
console.log("   reply      :", m.text);
const ok =
  m.text.includes("Tool ocw_connector_call said: This uses your own account, so I can only do it in our private chat") &&
  !m.text.includes("fake-api-error-body-canary");
if (!ok) { console.log("FAIL: expected the member-account sentence"); process.exit(1); }
'

echo "== [connectors] a channel turn withholding the member's connector: the persona gets the share link (R7)"
CONN_CHANNEL=0199a6f0-0000-7000-8000-00000000c0c2
CONN_SERVER_ID=0199a6f0-0000-7000-8000-000000000c71
# Nothing offered; the member's connector is withheld with its resource (no tool ever enables from a withheld entry).
WITHHELD_TURN="$(printf '{"tools":[],"toolFlags":{},"withheld":[{"tool":"m1a2b3c4d__whoami","reason":"member_account","resource":{"kind":"connector","id":"%s","name":"Smoke CRM"}}]}' "$CONN_SERVER_ID")"
OPS="$(printf '{"id":"%s","kind":"channel","name":"ops"}' "$CONN_CHANNEL")"
WITHHELD_FIXTURE="$(connector_variant c5 "@archie what is the status of the Acme deal?" "$WITHHELD_TURN" "$OPS")"
STATE="$(inject_and_wait "$WITHHELD_FIXTURE" 0199a6f0-0000-7000-8000-00000000d0c5)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0c5");
if (!m) { console.log("FAIL: no reply to the withheld-connector mention"); process.exit(1); }
console.log("   reply      :", m.text);
if (!m.text.endsWith("[tools: 0]")) { console.log("FAIL: a withheld tool reached the model"); process.exit(1); }
'
SHARE_LINK="/settings/connections?share=${CONN_CHANNEL}&connector=${CONN_SERVER_ID}"
LINKED="$(docker exec "${P}-model" sh -c "grep -l '$CONN_CHANNEL' /tmp/capture/*.json 2>/dev/null | xargs -r grep -lF '$SHARE_LINK' | xargs -r grep -l 'Allow Smoke CRM in #ops' | wc -l")"
echo "   share link : $LINKED model request(s) of #ops carry [Allow Smoke CRM in #ops]($SHARE_LINK)"
[[ "$LINKED" -ge 1 ]] || { echo "FAIL: the withheld block with the share link did not reach the model"; exit 1; }

echo "== [connectors] a DM turn offering ocw_connector_list and ocw_http_request: the bot lists its keys and sends a GET by handle"
HTTP_TEXT='check my billing profile [[call ocw_connector_list {}]] [[call ocw_http_request {"handle":"k_abcdefgh23","method":"GET","url":"https://api.example.com/v1/me"}]]'
HTTP_TURN='{"tools":["ocw_connector_list","ocw_http_request"],"toolFlags":{"ocw_connector_list":{"untrustedOutput":false,"sideEffecting":false},"ocw_http_request":{"untrustedOutput":true,"sideEffecting":true}}}'
HTTP_FIXTURE="$(connector_variant c6 "$HTTP_TEXT" "$HTTP_TURN")"
STATE="$(inject_and_wait "$HTTP_FIXTURE" 0199a6f0-0000-7000-8000-00000000d0c6)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const EV = "0199a6f0-0000-7000-8000-00000000e0c6";
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d0c6");
if (!m) { console.log("FAIL: no reply to the http mention"); process.exit(1); }
const lists = (s.connectorLists ?? []).filter((x) => x.eventId === EV);
const reqs = (s.httpRequests ?? []).filter((x) => x.eventId === EV);
const gated = s.toolCalls.filter((c) => c.eventId === EV);
console.log("   reply      :", m.text.replace(/\n/g, " / "));
console.log("   lists      :", JSON.stringify(lists));
console.log("   requests   :", JSON.stringify(reqs));
const r = reqs[0];
const ok =
  m.text.includes("Tool ocw_connector_list said: Connectors") &&
  m.text.includes("Tool ocw_http_request said: HTTP 200 (application/json)") &&
  /\[tools: 2 \| ocw_connector_list,ocw_http_request\]/.test(m.text) &&
  lists.length === 1 && Object.keys(lists[0]).sort().join() === "agentId,eventId" &&
  reqs.length === 1 && r.handle === "k_abcdefgh23" && r.method === "GET" && r.url === "https://api.example.com/v1/me" &&
  Object.keys(r).sort().join() === "agentId,eventId,handle,method,url" &&
  gated.length === 0;
if (!ok) { console.log("FAIL: expected one list and one GET by handle through their own routes, no /tool-calls"); process.exit(1); }
'

echo "== [connectors] no per-member MCP server and no member credential anywhere in the cell"
CONFIG="$(docker exec "${P}-openclaw" cat /home/node/.openclaw/openclaw.json)"
CONFIG="$CONFIG" node -e '
const cfg = JSON.parse(process.env.CONFIG);
const servers = Object.keys(cfg.mcp?.servers ?? {});
console.log("   mcp servers:", JSON.stringify(servers));
if (servers.includes("m1a2b3c4d")) { console.log("FAIL: the per-member connector is rendered as an in-cell MCP server"); process.exit(1); }
'
CRED_FILES="$(docker exec "${P}-openclaw" sh -c "grep -rlF 'Bearer $CONN_TOKEN' /home/node/.openclaw 2>/dev/null | wc -l")"
CRED_LOGS="$(docker logs "${P}-openclaw" 2>&1 | grep -cF "$CONN_TOKEN" || true)"
echo "   credential : $CRED_FILES state file(s) and $CRED_LOGS log line(s) carry the member's connector token"
[[ "$CRED_FILES" -eq 0 && "$CRED_LOGS" -eq 0 ]] || { echo "FAIL: a member credential reached the cell"; exit 1; }
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

if [[ "$SANDBOX" == "1" ]]; then
# Stdio MCP sandbox (03.1-14, D-13). The API maps a `sandboxed-stdio` server to ${OCW_MCP_SANDBOX_URL}/<id>/mcp
# (cellMcpServers); the fake Agent Channel API delivers exactly that remote entry.
SBX="${P}-mcp-sandbox"
echo "== [sandbox] the stdio sidecar is locked down: non-root, read-only, no capabilities, limits, no ports, no mounts"
for i in $(seq 1 30); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$SBX" 2>/dev/null)" == "healthy" ]] && break
  sleep 1
done
docker logs "$SBX" 2>&1 | head -n 3 | sed 's/^/   /'
INSPECT="$(docker inspect "$SBX")"
INSPECT="$INSPECT" SBX_NET="$SBX_NET" node -e '
const [c] = JSON.parse(process.env.INSPECT);
const h = c.HostConfig;
const nets = Object.keys(c.NetworkSettings.Networks);
const facts = {
  health: c.State.Health?.Status, user: c.Config.User, readOnly: h.ReadonlyRootfs, capDrop: h.CapDrop, capAdd: h.CapAdd,
  securityOpt: h.SecurityOpt, pids: h.PidsLimit, memory: h.Memory, nanoCpus: h.NanoCpus, tmpfs: Object.keys(h.Tmpfs ?? {}),
  mounts: c.Mounts.length, ports: Object.keys(c.NetworkSettings.Ports ?? {}).length, privileged: h.Privileged, networks: nets,
  envNames: c.Config.Env.map((e) => e.split("=")[0]).sort(),
};
console.log("   sidecar    :", JSON.stringify(facts));
const ok =
  facts.health === "healthy" && facts.user === "node" && facts.readOnly === true &&
  JSON.stringify(facts.capDrop) === "[\"ALL\"]" && !facts.capAdd?.length && facts.privileged === false &&
  facts.securityOpt?.includes("no-new-privileges") && facts.pids === 128 && facts.memory > 0 && facts.nanoCpus > 0 &&
  JSON.stringify(facts.tmpfs) === "[\"/tmp\"]" && facts.mounts === 0 && facts.ports === 0 &&
  JSON.stringify(nets) === JSON.stringify([process.env.SBX_NET]) &&
  facts.envNames.every((n) => /^(PATH|HOSTNAME|HOME|NODE_ENV|NODE_VERSION|YARN_VERSION|MCP_SANDBOX_\w+)$/.test(n));
if (!ok) { console.log("FAIL: the sandbox sidecar is not hardened as compose.yaml specifies"); process.exit(1); }
'
SBX_UID="$(docker exec "$SBX" id -u)"
echo "   sidecar uid: $SBX_UID; writes to / and /app: $(docker exec "$SBX" sh -c 'touch /x /app/x 2>&1 | grep -c "Read-only file system"') refused"
[[ "$SBX_UID" != "0" ]] || { echo "FAIL: the sandbox runs as root"; exit 1; }
if docker exec "$SBX" node -e "fetch('http://api:4000/agent-channel/v1/cell').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
  echo "FAIL: the sandbox reaches the Agent Channel API"; exit 1
fi
if docker exec "$SBX" node -e "fetch('https://api.anthropic.com').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
  echo "FAIL: the sandbox has internet egress"; exit 1
fi
echo "   sidecar reaches neither the API nor the internet"
CELL_SEES="$(docker exec "${P}-openclaw" node -e "fetch('http://mcp-sandbox:8080/healthz').then(async (r) => console.log(r.status, await r.text())).catch((e) => console.log('unreachable', e.cause?.code ?? e.message))")"
echo "   cell → sidecar /healthz: $CELL_SEES"
[[ "$CELL_SEES" == 200* ]] || { echo "FAIL: the cell cannot reach the sandbox"; exit 1; }

echo "== [sandbox] the stdio child gets only PATH and HOME=/tmp, whatever the sidecar's environment holds"
CHILD_ENV="$(docker exec "$SBX" node --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "smoke", version: "0" });
const t = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8080/everything/mcp"));
await c.connect(t);
const r = await c.callTool({ name: "get-env", arguments: {} });
const env = JSON.parse(r.content[0].text);
console.log(JSON.stringify({ names: Object.keys(env).sort(), home: env.HOME }));
await t.terminateSession();
await c.close();
')"
echo "   child env  : $CHILD_ENV"
[[ "$CHILD_ENV" == '{"names":["HOME","PATH"],"home":"/tmp"}' ]] || { echo "FAIL: the stdio child inherited more than PATH and HOME"; exit 1; }

echo "== [sandbox] the admin attaches the sandboxed stdio server: the cell renders it as a remote streamable-HTTP server"
docker exec -e SERVERS="$(sandbox_servers_json)" -i "${P}-api" node --input-type=module -e "
const mcpServers = JSON.parse(process.env.SERVERS);
await fetch('http://127.0.0.1:4000/__test/cell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mcpServers, reason: 'tools.updated' }) });
"
RENDERED="null"
for i in $(seq 1 60); do
  RENDERED="$(docker exec "${P}-openclaw" cat /home/node/.openclaw/openclaw.json | SBX_SAFE="$SBX_SAFE" node -e '
const cfg = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(cfg.mcp?.servers?.[process.env.SBX_SAFE] ?? null));')"
  [[ "$RENDERED" != "null" ]] && break
  sleep 1
done
echo "   rendered   : $RENDERED"
RENDERED="$RENDERED" SBX_URL="$SBX_URL" node -e '
const s = JSON.parse(process.env.RENDERED);
const ok = s && s.url === process.env.SBX_URL && s.transport === "streamable-http" &&
  JSON.stringify(s.toolFilter) === JSON.stringify({ include: ["echo"] }) && Object.keys(s.headers ?? {}).length === 0 &&
  s.command === undefined && s.args === undefined;
if (!ok) { console.log("FAIL: the sandboxed server is not rendered as a remote streamable-HTTP server with filter [echo]"); process.exit(1); }
'

echo "== [sandbox] mcp.probe: the cell lists the stdio server's tools through the bridge"
SBX_PROBE_ID=0199a6f0-0000-7000-8000-0000000f2071
api_exec "
const body = JSON.stringify({ type: 'mcp.probe', data: { probeId: '$SBX_PROBE_ID', serverId: '$SBX_SERVER_ID' } });
await fetch('http://127.0.0.1:4000/__test/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
"
PROBES=""
for i in $(seq 1 60); do
  PROBES="$(api_exec "const r = await fetch('http://127.0.0.1:4000/__test/state'); console.log(JSON.stringify((await r.json()).mcpProbes));")"
  if grep -q "$SBX_PROBE_ID" <<<"$PROBES"; then break; fi
  sleep 1
done
echo "$PROBES" | PROBE_ID="$SBX_PROBE_ID" node -e '
const probes = JSON.parse(require("fs").readFileSync(0, "utf8")).filter((p) => p.probeId === process.env.PROBE_ID);
const p = probes[0];
console.log("   probe      :", JSON.stringify(probes.map(({ ok, error, tools }) => ({ ok, error, tools: tools?.map((t) => t.name) }))));
const echo = p?.tools?.find((t) => t.name === "echo");
if (!(probes.length === 1 && p.ok === true && echo?.annotations?.readOnlyHint === true)) {
  console.log("FAIL: expected one successful probe listing the stdio echo tool as read-only"); process.exit(1);
}
'

echo "== [sandbox] a bot calls the stdio server's echo through the gate"
SBX_EVENT=0199a6f0-0000-7000-8000-00000000e081
SBX_MENTION="$SECRETS/mention-sandbox.json"
SBX_SAFE="$SBX_SAFE" SBX_EVENT="$SBX_EVENT" node -e '
const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const echo = `${process.env.SBX_SAFE}__echo`;
e.eventId = process.env.SBX_EVENT;
e.thread.rootMessageId = e.message.id = "0199a6f0-0000-7000-8000-00000000d081";
e.message.text = "@archie stdio echo [[call echo {\"message\":\"from stdio\"}]]";
e.turn = { ...e.turn, tools: [echo], toolFlags: { [echo]: { untrustedOutput: true, sideEffecting: false } } };
require("fs").writeFileSync(process.argv[2], JSON.stringify(e));
' "$ROOT/infra/openclaw/test/mention-mcp.json" "$SBX_MENTION"
STATE="$(inject_and_wait "$SBX_MENTION" 0199a6f0-0000-7000-8000-00000000d081)"
echo "$STATE" | SBX_SAFE="$SBX_SAFE" EVENT="$SBX_EVENT" node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const tool = `${process.env.SBX_SAFE}__echo`;
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d081");
if (!m) { console.log("FAIL: no reply to the sandbox mention"); process.exit(1); }
const calls = s.toolCalls.filter((c) => c.eventId === process.env.EVENT);
const results = s.toolResults.filter((r) => calls.some((c) => c.callId === r.callId));
console.log("   reply      :", m.text);
console.log("   tool calls :", JSON.stringify(calls.map((c) => ({ tool: c.tool, params: c.params, allowed: c.allowed }))));
console.log("   outcomes   :", JSON.stringify(results.map(({ status }) => ({ status }))));
const ok =
  m.text.includes("Tool echo said: Echo: from stdio") && m.text.includes(`[tools: 1 | ${tool}]`) &&
  calls.length === 1 && calls[0].tool === tool && calls[0].allowed === true &&
  results.length === 1 && results[0].status === "ok";
if (!ok) { console.log("FAIL: expected one gated, reported call of the sandboxed echo and an answer from its result"); process.exit(1); }
'

echo "== [sandbox] the stdio server ran in the sidecar, never in the gateway container"
SBX_LOG="$(docker logs "$SBX" 2>&1)"
STARTED="$(grep -c "started server=everything" <<<"$SBX_LOG" || true)"
echo "   sidecar log: $STARTED session(s) started; $(grep -c "ended reason=" <<<"$SBX_LOG" || true) ended"
grep -E "session [0-9a-f]{8} (started|ended)" <<<"$SBX_LOG" | tail -n 4 | sed 's/^/     /'
# The probe, the env check and OpenClaw's own MCP runtime each opened a session.
[[ "$STARTED" -ge 3 ]] || { echo "FAIL: expected the probe, the env check and the bot's call to reach the sidecar"; exit 1; }
if grep -q "from stdio" <<<"$SBX_LOG"; then echo "FAIL: the sidecar logged a payload"; exit 1; fi
# (The bracket keeps this probe's own command line from matching itself.)
IN_CELL="$(docker exec "${P}-openclaw" sh -c 'for f in /proc/[0-9]*/cmdline; do tr "\0" " " <"$f" 2>/dev/null; echo; done | grep -c "server-everythin[g]" || true')"
echo "   gateway container: $IN_CELL process(es) of the stdio server"
[[ "$IN_CELL" -eq 0 ]] || { echo "FAIL: the stdio server runs inside the gateway container"; exit 1; }
if docker exec "${P}-openclaw" sh -c 'test -e /app/node_modules/@modelcontextprotocol/server-everything'; then
  echo "FAIL: the stdio server package is present in the gateway container"; exit 1
fi
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

echo "== [marketplace] OpenClaw's doctor validated the install gate at boot (root-owned script, trusted dirs)"
GATE_NOTE="$(docker logs "${P}-openclaw" 2>&1 | grep -E "Install policy enabled|Static checks passed|install-policy|fail closed until this is fixed" | head -5 || true)"
[[ -n "$GATE_NOTE" ]] && sed 's/^/   /' <<<"$GATE_NOTE"
if grep -q "fail closed until this is fixed" <<<"$GATE_NOTE"; then
  echo "FAIL: OpenClaw rejects the install gate configuration (every install would be blocked)"; exit 1
fi

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
  if docker logs --since "$T0" "${P}-openclaw" 2>&1 | grep "agent channel connected" >/dev/null; then break; fi
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

echo "== [marketplace] the ocw-echo test plugin (community fixture) is installed and reports its tool"
ECHO_FLOW=0199a6f0-0000-7000-8000-0000000f3003
publish_plugin_event "$(install_event "$ECHO_ROW" "$ECHO_FLOW" "@ocw-test/echo-plugin" 0.1.0 "$ECHO_SHA" "$ECHO_SHA512" ocw-echo)"
REPORT="$(wait_report "$ECHO_FLOW")"
echo "   report     : $REPORT"
if [[ "$(REPORT="$REPORT" node -e '
const r = JSON.parse(process.env.REPORT);
console.log(r?.state === "installed" && r.pluginId === "ocw-echo" && JSON.stringify(r.declaredTools) === JSON.stringify([{ name: "ocw_echo" }]) ? "ok" : "no");')" != "ok" ]]; then
  echo "FAIL: expected ocw-echo installed, declaring exactly ocw_echo"; exit 1
fi
STATUS="$(listed ocw-echo)"
echo "   plugins list: ocw-echo $STATUS"
[[ "$STATUS" == "enabled" ]] || { echo "FAIL: ocw-echo is not enabled in the cell"; exit 1; }

echo "== [marketplace] a bot granted ocw_echo calls it in a conversation, through the tool gate"
ECHO_MENTION="$SECRETS/mention-echo.json"
mention_echo() { # <event id> <message id> <text> [turn tools, JSON; default ["ocw_echo"]]
  node -e '
const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
e.eventId = process.argv[3];
e.conversation = { ...e.conversation, id: "0199a6f0-0000-7000-8000-00000000c007", name: "marketplace" };
e.thread.rootMessageId = e.message.id = process.argv[4];
e.message.text = process.argv[5];
const tools = JSON.parse(process.argv[6] || "[\"ocw_echo\"]");
const flags = { ocw_echo: { untrustedOutput: true, sideEffecting: true }, web_fetch: { untrustedOutput: true, sideEffecting: false } };
e.turn = { ...e.turn, tools, toolFlags: Object.fromEntries(tools.map((t) => [t, flags[t]])) };
require("fs").writeFileSync(process.argv[2], JSON.stringify(e));
' "$ROOT/infra/openclaw/test/mention-mcp.json" "$ECHO_MENTION" "$1" "$2" "$3" "${4:-}"
}
mention_echo 0199a6f0-0000-7000-8000-00000000e071 0199a6f0-0000-7000-8000-00000000d071 \
  '@archie please echo [[call ocw_echo {"text":"marketplace"}]]'
STATE="$(inject_and_wait "$ECHO_MENTION" 0199a6f0-0000-7000-8000-00000000d071)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d071");
if (!m) { console.log("FAIL: no reply to the echo mention"); process.exit(1); }
const calls = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e071");
const results = s.toolResults.filter((r) => calls.some((c) => c.callId === r.callId));
console.log("   reply      :", m.text);
console.log("   tool calls :", JSON.stringify(calls.map((c) => ({ tool: c.tool, allowed: c.allowed }))));
console.log("   outcomes   :", JSON.stringify(results.map(({ status }) => ({ status }))));
const ok =
  m.text.includes("Tool ocw_echo said: echo marketplace") && m.text.includes("[tools: 1 | ocw_echo]") &&
  calls.length === 1 && calls[0].tool === "ocw_echo" && calls[0].allowed === true &&
  results.length === 1 && results[0].status === "ok";
if (!ok) { console.log("FAIL: expected one gated ocw_echo call answering echo marketplace"); process.exit(1); }
'

echo "== [marketplace] uninstalled: a turn that still lists ocw_echo (stale grant) is offered no such tool"
ECHO_UNFLOW=0199a6f0-0000-7000-8000-0000000f3004
publish_plugin_event "$(uninstall_event "$ECHO_ROW" "$ECHO_UNFLOW" ocw-echo)"
REPORT="$(wait_report "$ECHO_UNFLOW")"
echo "   report     : $REPORT"
[[ "$(REPORT="$REPORT" node -e 'console.log(JSON.parse(process.env.REPORT)?.state ?? "none")')" == "uninstalled" ]] \
  || { echo "FAIL: ocw-echo was not uninstalled"; exit 1; }
STATUS="$(listed ocw-echo)"
echo "   plugins list: ocw-echo $STATUS"
[[ "$STATUS" == "absent" ]] || { echo "FAIL: ocw-echo is still in the cell"; exit 1; }
# The turn (and the bot's alsoAllow) still list ocw_echo, next to web_fetch: OpenClaw refuses a turn whose
# allowlist matches no registered tool, so web_fetch keeps the turn alive while the removed tool cannot be offered.
mention_echo 0199a6f0-0000-7000-8000-00000000e072 0199a6f0-0000-7000-8000-00000000d072 \
  '@archie echo once more [[call ocw_echo {"text":"after uninstall"}]]' '["ocw_echo","web_fetch"]'
STATE="$(inject_and_wait "$ECHO_MENTION" 0199a6f0-0000-7000-8000-00000000d072)"
echo "$STATE" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = s.messages.find((x) => x.inReplyToMessageId === "0199a6f0-0000-7000-8000-00000000d072");
if (!m) { console.log("FAIL: no reply to the post-uninstall mention"); process.exit(1); }
const calls = s.toolCalls.filter((c) => c.eventId === "0199a6f0-0000-7000-8000-00000000e072");
console.log("   reply      :", m.text);
if (!m.text.includes("Tool ocw_echo not offered") || !m.text.endsWith("[tools: 1 | web_fetch]") || calls.length !== 0) {
  console.log("FAIL: the uninstalled plugin tool still reached the model"); process.exit(1);
}
'

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
  if docker logs "${P}-openclaw" 2>&1 | grep "reconciled OpenClaw: agents upsert=0 remove=1" >/dev/null; then break; fi
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

if want breaker; then
echo "== [breaker] unclean restarts trip OpenClaw's restart-loop breaker; the plugin reports the pause and starts ocw"
# OpenClaw counts boots that never completed (SIGKILL) and started within the last 5 minutes; 3 trip the next boot.
# The cell's first boot may be older than the window by now, so kill until the breaker trips (at most 6 times).
boots() { docker logs "${P}-openclaw" 2>&1 | grep -c "http server listening" || true; }
tripped() { docker logs "${P}-openclaw" 2>&1 | grep -c "restart-loop breaker tripped" || true; }
for i in $(seq 1 6); do
  [[ "$(tripped)" -gt 0 ]] && break
  B="$(boots)"
  docker kill -s KILL "${P}-openclaw" >/dev/null
  docker start "${P}-openclaw" >/dev/null
  for _ in $(seq 1 180); do [[ "$(boots)" -gt "$B" ]] && break; sleep 1; done
  [[ "$(boots)" -gt "$B" ]] || { echo "FAIL: the cell did not boot again after unclean stop $i"; exit 1; }
  echo "   unclean stop $i: boot $((B + 1)) up"
done
[[ "$(tripped)" -gt 0 ]] || { echo "FAIL: OpenClaw's restart-loop breaker never tripped"; exit 1; }
# Only the log of the breaker boot (from its breaker line on).
since_breaker() { docker logs "${P}-openclaw" 2>&1 | awk '/restart-loop breaker tripped/ { buf = "" } { buf = buf $0 "\n" } END { printf "%s", buf }'; }
for i in $(seq 1 120); do
  if since_breaker | grep "agent channel connected" >/dev/null; then break; fi
  sleep 1
done
AFTER="$(since_breaker)"
grep -E "restart-loop breaker|autostart suppressed|\[ocw\] (OpenClaw's|started the ocw|agent channel connected)" <<<"$AFTER" | cut -c1-220 | sed 's/^/   /'
grep -q "suppressed this channel's auto-start" <<<"$AFTER" || { echo "FAIL: the plugin did not notice the suppressed channel"; exit 1; }
grep -q "started the ocw channel after the restart-loop breaker back-off" <<<"$AFTER" || {
  echo "FAIL: the plugin did not start the ocw channel (channels.start in process)"; exit 1
}
grep -q "agent channel connected" <<<"$AFTER" || { echo "FAIL: the ocw channel never connected after the breaker"; exit 1; }
REPORTS="$(api_exec "const r = await fetch('http://127.0.0.1:4000/__test/state'); console.log(JSON.stringify((await r.json()).runtimeReports));")"
echo "   runtime    : $REPORTS"
REPORTS="$REPORTS" node -e '
const reports = JSON.parse(process.env.REPORTS);
const p = reports.at(-1)?.paused;
const ok = p && p.reason === "restart_loop_breaker" && /^\d+ unclean restarts within 5 min$/.test(p.detail ?? "") &&
  typeof p.resumeAt === "string";
if (!ok) { console.log("FAIL: the API was not told why the channel was paused"); process.exit(1); }
'
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
# `sed -E` with `?`: BSD sed (macOS hosts) has no `\?` in basic regexes and would leave the prefix in place.
PLUGINS="$(grep -o "http server listening ([0-9]* plugins\?: [^;)]*" <<<"$LOGS" | tail -n 1 | sed -E 's/.*plugins?: //')"
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
