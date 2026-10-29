#!/usr/bin/env bash
# Phase 07.12-10 (HSR-07, D-08, D-11): the headless Linux server proof. A clean, pinned Node 24 container becomes a
# shared Work Zone device using only what the workspace serves. Opt-in, never part of `pnpm verify`; needs Docker and
# runs only against the isolated e2e stack:
#
#   bash scripts/e2e-isolated.sh --cmd "bash scripts/headless-server-proof.sh"
#
# On a Linux host the container reaches the host's loopback only when the API listens on every interface: add
# OCW_E2E_API_HOST=0.0.0.0 in front (disposable hosts only, as for scripts/cell-proof.sh). Docker Desktop forwards
# host.docker.internal to the host's loopback, so macOS needs nothing more.
#
# What it proves, in order:
#   1. the pinned slim image plus only `curl git ca-certificates` (D-11), as the image's non-root user `node`, under
#      dash: `curl …/api/v1/runtime/install.sh | sh` from the isolated API installs the runtime (sha256 checked);
#   2. `ocw-runtime setup --yes --name proof-server --project ~/work/repo --service none` prints the pairing link;
#   3. e2e/proof/headless-server.proof.ts: the owner approves it in the web, the device comes online with `repo`, the
#      owner shares it with Sam, Sam starts a Claude Code session from the web and gets the fake runtime's reply;
#   4. in the container, `ocw-runtime doctor --json` has no fail, the service is a warn, and neither the device token
#      nor /home/node is in it; `ocw-runtime service install` refuses with the own-supervisor line (no systemd);
#   5. the proof's facts (image digest, /bin/sh, installed version and sha, SDK version, doctor) are printed for the
#      gate (07.12-11), then the proof's ok line as its last line.
#
# PD-19, no real tools: the daemon runs the fake runtime (OCW_RUNTIME_FAKE=1, OCW_RUNTIME_UPDATES=off), no Claude Code
# or Codex is installed, and no registry is contacted for the SDK. install.sh's `npm install` meets an offline fake npm
# (first on PATH for that one command only) that accepts only exact pins with --omit=optional --ignore-scripts and
# copies those exact package versions from this checkout's lockfile install (each copied file by file, nested
# node_modules excluded). The real npm is never run (npm_config_registry also points at a closed loopback port).
# Nothing from the host is mounted: no HOME, node_modules or .env; the container downloads only from the isolated API
# and the Debian mirrors (apt). The container is removed on exit, whatever happens.
#   PROOF_KEEP_LOG=1   keep install.log, setup.log, run.log and the proof's facts in the printed temp directory
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The same pinned image scripts/e2e-isolated.sh and scripts/runtime-update-proof.sh use (Node 24.22.1, Debian bookworm,
# user `node` uid 1000). It has neither curl nor wget: the proof installs curl, as a server admin would (D-11).
IMAGE="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"
NAME="ocw-headless-proof-$$"
DEVICE_NAME=proof-server
PROJECT_NAME=repo
HOME_IN=/home/node
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ocw-headless-proof.XXXXXX")"
FACTS="$WORK/facts.txt"

fail() { echo "headless-server-proof: $*" >&2; exit 1; }
step() { echo "== $*"; }
as_root() { docker exec -u root "$NAME" "$@"; }
as_node() { docker exec -u node -e "HOME=$HOME_IN" -w "$HOME_IN" "$NAME" "$@"; }

container_logs() {
  local f
  for f in install.log setup.log run.log; do
    as_node test -f "$HOME_IN/$f" 2>/dev/null || continue
    echo "---- $f (last 40 lines)" >&2
    as_node tail -n 40 "$HOME_IN/$f" >&2 2>/dev/null
  done
}
keep_logs() {
  local f
  for f in install.log setup.log run.log; do as_node cat "$HOME_IN/$f" >"$WORK/$f" 2>/dev/null || rm -f "$WORK/$f"; done
  rm -rf "$WORK/proof"
}
finish() {
  local status=$?
  set +e
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    [[ $status -ne 0 ]] && container_logs
    [[ "${PROOF_KEEP_LOG:-}" == "1" ]] && keep_logs
    docker rm -f "$NAME" >/dev/null 2>&1
  fi
  if [[ "${PROOF_KEEP_LOG:-}" == "1" ]]; then
    echo "headless-server-proof: logs kept in $WORK" >&2
  else
    rm -rf "$WORK"
  fi
  trap - EXIT
  exit "$status"
}
trap finish EXIT

# ---------------------------------------------------------------- preconditions
command -v docker >/dev/null || fail "docker is required"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable"
command -v node >/dev/null || fail "node is required"
[[ -n "${OCW_E2E_API_URL:-}" ]] || fail "OCW_E2E_API_URL is not set: run through scripts/e2e-isolated.sh --cmd"
[[ -n "${OCW_E2E_BASE_URL:-}" ]] || fail "OCW_E2E_BASE_URL is not set: run through scripts/e2e-isolated.sh --cmd"
API_PORT="$(node -e 'console.log(new URL(process.argv[1]).port)' "$OCW_E2E_API_URL")"
[[ "$API_PORT" =~ ^[0-9]+$ ]] || fail "OCW_E2E_API_URL ($OCW_E2E_API_URL) has no explicit port"
SERVER="http://host.docker.internal:$API_PORT"
curl -sf -o /dev/null "$OCW_E2E_API_URL/health" || fail "the isolated API does not answer on $OCW_E2E_API_URL"
if [[ -n "$(docker ps -aq --filter "name=^/$NAME\$")" ]]; then fail "$NAME already exists"; fi

# ---------------------------------------------------------------- the bundle the API serves
# The API caches the first verified bundle it reads until it restarts: build it before anything asks for it, then
# check the API serves exactly this build.
step "build the runtime bundle the isolated API serves"
node apps/local-runtime/scripts/build-bundle.mjs
BUILT_SHA="$(node -p 'require("./apps/local-runtime/dist/manifest.json").sha256')"
SERVED_SHA="$(curl -sf "$OCW_E2E_API_URL/api/v1/runtime/version" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).sha256))')" ||
  fail "GET /api/v1/runtime/version failed"
[[ "$SERVED_SHA" == "$BUILT_SHA" ]] ||
  fail "the API serves ${SERVED_SHA:0:12}, not this build (${BUILT_SHA:0:12}): it read an older bundle; restart the stack"
echo "   served ${SERVED_SHA:0:12}"

# The offline fake npm and the exact package versions it may copy (see the header).
mkdir -p "$WORK/proof/bin" "$WORK/proof/npm-packages"
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions; the values come in as arguments.
node -e '
const fs = require("node:fs");
const path = require("node:path");
const [manifestPath, from, to] = process.argv.slice(1);
const { external } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const { name, version } of external) {
  const src = fs.realpathSync(path.join(from, name));
  const got = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version;
  if (got !== version) throw new Error(`${name}: this checkout has ${got}, the manifest pins ${version}`);
  fs.cpSync(src, path.join(to, name), {
    recursive: true,
    dereference: true,
    filter: (p) => path.basename(p) !== "node_modules",
  });
  console.log(`   offline package ${name}@${version}`);
}
' apps/local-runtime/dist/manifest.json apps/local-runtime/node_modules "$WORK/proof/npm-packages"
cat >"$WORK/proof/bin/npm" <<'FAKE_NPM'
#!/usr/local/bin/node
// Proof-only fake npm (scripts/headless-server-proof.sh, PD-19): offline, never a registry. It accepts only what
// install.sh runs (`install --prefix <dir> … --omit=optional --ignore-scripts <name>@<x.y.z>…`) and copies those exact
// package versions from /opt/ocw-proof/npm-packages into <dir>/node_modules.
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync("/tmp/ocw-proof-npm.log", `npm ${args.join(" ")}\n`);
const die = (m) => {
  console.error(`fake npm: ${m}`);
  process.exit(1);
};
if (args[0] !== "install") die(`only "install" is supported, got "${args[0] ?? ""}"`);
let prefix = null;
const flags = [];
const pins = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--prefix") prefix = args[++i];
  else if (args[i].startsWith("-")) flags.push(args[i]);
  else pins.push(args[i]);
}
if (!prefix || !path.isAbsolute(prefix)) die("--prefix <absolute dir> is required");
for (const f of ["--omit=optional", "--ignore-scripts"]) if (!flags.includes(f)) die(`${f} is required`);
if (pins.length === 0) die("no package to install");
const deps = {};
for (const pin of pins) {
  const m = /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@(\d+\.\d+\.\d+)$/.exec(pin);
  if (!m) die(`not an exact pin: ${pin}`);
  const [, name, version] = m;
  const src = path.join("/opt/ocw-proof/npm-packages", name);
  const got = fs.existsSync(src) ? JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version : null;
  if (got !== version) die(`${name}@${version} is not available offline (have ${got ?? "nothing"})`);
  fs.cpSync(src, path.join(prefix, "node_modules", name), { recursive: true });
  deps[name] = version;
}
fs.writeFileSync(path.join(prefix, "package.json"), `${JSON.stringify({ dependencies: deps }, null, 2)}\n`);
console.log(`added ${pins.length} packages offline (proof fake npm)`);
FAKE_NPM

# ---------------------------------------------------------------- a clean Linux server
step "container $NAME from the pinned image"
docker run -d --init --name "$NAME" --add-host host.docker.internal:host-gateway "$IMAGE" sleep infinity >/dev/null
step "as root: apt-get install curl git ca-certificates (D-11)"
as_root sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null &&
  apt-get install -y --no-install-recommends curl git ca-certificates >/dev/null' || fail "apt-get failed"
docker cp "$WORK/proof/." "$NAME:/opt/ocw-proof/" >/dev/null
as_root sh -c 'chown -R root:root /opt/ocw-proof && chmod -R a+rX,go-w /opt/ocw-proof && chmod 755 /opt/ocw-proof/bin/npm'

step "the isolated API from the container ($SERVER)"
reach=""
for _ in 1 2 3 4 5; do
  reach="$(as_node curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$SERVER/health" || true)"
  [[ "$reach" == "200" ]] && break
  sleep 2
done
[[ "$reach" == "200" ]] ||
  fail "the container cannot reach the API on $SERVER (HTTP ${reach:-none}); on Linux start the stack with OCW_E2E_API_HOST=0.0.0.0 (disposable hosts only)"
echo "   GET /health 200"

SH_TARGET="$(as_node readlink -f /bin/sh)"
[[ "$SH_TARGET" == */dash ]] || fail "/bin/sh is $SH_TARGET, not dash"
echo "   running as $(as_node id -un) (uid $(as_node id -u)), /bin/sh -> $SH_TARGET"

as_node sh -c 'set -e; mkdir -p ~/work/repo; cd ~/work/repo; git init -q -b main
  printf "# repo\n\nThe headless server proof'"'"'s repository.\n" >README.md
  git add -A; git -c user.email=proof@ocw.test -c user.name=Proof commit -qm init'

# ---------------------------------------------------------------- install.sh, exactly as Settings › Devices shows it
step "as node, under dash: curl $SERVER/api/v1/runtime/install.sh | sh"
docker exec -u node -e "HOME=$HOME_IN" -w "$HOME_IN" \
  -e PATH=/opt/ocw-proof/bin:/usr/local/bin:/usr/bin:/bin -e npm_config_registry=http://127.0.0.1:9/ \
  -e "SERVER=$SERVER" "$NAME" \
  sh -c 'set -e; curl -fsSL "$SERVER/api/v1/runtime/install.sh" | OCW_SERVER_URL="$SERVER" OCW_INSTALL_ALLOW_HTTP=1 sh 2>&1 | tee ~/install.log'
as_node grep -q "Installed ocw-runtime" "$HOME_IN/install.log" || fail "install.sh did not report an install"
NPM_CALL="$(as_node cat /tmp/ocw-proof-npm.log)"
[[ "$(wc -l <<<"$NPM_CALL" | tr -d ' ')" == "1" && "$NPM_CALL" == *"--omit=optional --ignore-scripts"* ]] ||
  fail "unexpected npm calls: $NPM_CALL"
echo "   npm (offline fake): ${NPM_CALL#*--ignore-scripts }"

# ---------------------------------------------------------------- setup, as a server admin would run it
# The API answers 503 setup_required until the workspace exists: run the first-run setup before pairing.
step "first-run setup of the isolated workspace (Playwright project setup)"
pnpm exec playwright test -c e2e/playwright.proof.config.ts --project setup

step "ocw-runtime setup --yes --service none, then ocw-runtime run (fake runtime)"
docker exec -d -u node -e "HOME=$HOME_IN" -w "$HOME_IN" "$NAME" sh -c \
  "$HOME_IN/.local/bin/ocw-runtime setup --yes --name $DEVICE_NAME --project $HOME_IN/work/$PROJECT_NAME --service none >$HOME_IN/setup.log 2>&1 &&
   OCW_RUNTIME_FAKE=1 OCW_RUNTIME_UPDATES=off exec $HOME_IN/.local/bin/ocw-runtime run >$HOME_IN/run.log 2>&1"
PAIR_URL=""
for _ in $(seq 1 90); do
  PAIR_URL="$(as_node sh -c 'cat ~/setup.log 2>/dev/null' | grep -oE 'https?://[^[:space:]]+\?pair=[0-9A-Z]{4}-[0-9A-Z]{4}' | head -n 1 || true)"
  [[ -n "$PAIR_URL" ]] && break
  sleep 1
done
[[ -n "$PAIR_URL" ]] || fail "setup printed no pairing link within 90 s"
echo "   setup printed the pairing link for ${PAIR_URL##*\?pair=}"
case "$PAIR_URL" in
  "$OCW_E2E_BASE_URL"/*) ;;
  *) fail "the pairing link $PAIR_URL is not on the workspace's web URL $OCW_E2E_BASE_URL" ;;
esac

# ---------------------------------------------------------------- the web half (approval, sharing, Sam, doctor)
step "the proof spec: approval in the web, sharing, Sam's session, doctor and the service refusal"
PROOF_PAIR_URL="$PAIR_URL" PROOF_DEVICE_NAME="$DEVICE_NAME" PROOF_PROJECT="$PROJECT_NAME" PROOF_CONTAINER="$NAME" \
  PROOF_FACTS="$FACTS" pnpm exec playwright test -c e2e/playwright.proof.config.ts --project proof --no-deps \
  e2e/proof/headless-server.proof.ts

as_node grep -q "Registered" "$HOME_IN/setup.log" || fail "setup did not register the project"
as_node grep -q "No service installed" "$HOME_IN/setup.log" || fail "setup did not say no service was installed"

# ---------------------------------------------------------------- the proof's facts (07.12-11 copies them)
step "facts"
# shellcheck disable=SC2016 # a JavaScript template literal, not a shell expansion
INSTALLED="$(as_node node -e '
const i = require(process.env.HOME + "/.ocw/runtime/install.json");
console.log(`${i.version} ${i.sha256.slice(0, 12)} ${i.serverUrl} node ${i.nodePath}`);
')"
SDK_VERSION="$(as_node node -p 'require(process.env.HOME + "/.ocw/runtime/current/node_modules/@anthropic-ai/claude-agent-sdk/package.json").version')"
echo "proof: image ${IMAGE#*@}"
echo "proof: /bin/sh -> $SH_TARGET"
echo "proof: installed ocw-runtime ${INSTALLED}"
echo "proof: claude-agent-sdk ${SDK_VERSION} in current/node_modules (offline fake npm, exact pins)"
[[ -f "$FACTS" ]] || fail "the proof spec wrote no facts"
sed 's/^/proof: /' "$FACTS"

# Remove the container now so the ok line is the last one this script prints.
trap - EXIT
if [[ "${PROOF_KEEP_LOG:-}" == "1" ]]; then
  keep_logs
  echo "headless-server-proof: logs kept in $WORK"
else
  rm -rf "$WORK"
fi
docker rm -f "$NAME" >/dev/null
echo "headless-server proof: ok"
