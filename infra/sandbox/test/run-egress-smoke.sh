#!/usr/bin/env bash
# Real-Docker egress smoke (07.8-12; D-01, D-11, SBX-03). Builds the real `sandbox-egress` image from
# infra/sandbox/egress/Dockerfile and the real `sbx` image as the client, wires them like sandboxd will (07.8-13) and
# proves on real Docker that a bot's only way out is the proxy, which applies the API's own 07.4 rules:
#   - an internal bot network has no route out and no external DNS (Docker >= 26);
#   - through the proxy, a private fixture host is reachable only while its exact host:port is allowed;
#   - platform names (`sandboxd`) and metadata (169.254.169.254) are refused, CONNECT tunnels work;
#   - the policy arrives as a file written into the proxy's tmpfs by `docker exec` as root, reloaded on SIGHUP;
#   - decision lines on stdout carry the host only, never a path or a query;
#   - the proxy is the single shared hop (D-01): bot A (mode public) and bot B (mode off) share it, B's same request
#     fails, and A can reach neither B's container nor the proxy's own address on B's network, even when listed as
#     private hosts; a policy without bot networks or own addresses refuses everything (fail closed).
#
# Usage (repo root):  bash infra/sandbox/test/run-egress-smoke.sh
#
# Every Docker object it creates carries `ocw.namespace=ocw-smoke-<pid>` and is removed by that label before the run
# and on exit; image tags are `:smoke-<sha>` and are removed on exit. It never prunes and calls no external site.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

NS="ocw-smoke-$$"
SHA="$(git rev-parse --short HEAD)"
PROXY_IMAGE="ocw-sandbox-egress:smoke-${SHA}"
CLIENT_IMAGE="ocw-sandbox-egress-client:smoke-${SHA}"
BASE="node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
NET_A="${NS}-bot-a"
NET_B="${NS}-bot-b"
NET_FIX="${NS}-fixtures"
PROXY="${NS}-egress"
CLIENT_A="${NS}-client-a"
CLIENT_B="${NS}-client-b"
FAKE="${NS}-fake-site"
FAILURES=0
CHECKS=0

log() { printf '%s\n' "$*" >&2; }
ok() {
  CHECKS=$((CHECKS + 1))
  log "ok   $*"
}
fail() {
  CHECKS=$((CHECKS + 1))
  log "FAIL $*"
  FAILURES=$((FAILURES + 1))
}

# ---------------------------------------------------------------- cleanup by label (never a prune)

cleanup_ns() {
  local ids
  ids="$(docker ps -aq --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker rm -f -v $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter "label=ocw.namespace=${NS}")"
  if [ -n "$ids" ]; then docker network rm $ids >/dev/null 2>&1 || true; fi
}

on_exit() {
  local code=$?
  if [ "$code" != "0" ] && docker inspect "$PROXY" >/dev/null 2>&1; then
    log "--- proxy log (decision lines and operational lines) ---"
    docker logs "$PROXY" 2>&1 | tail -n 40 >&2 || true
  fi
  cleanup_ns
  docker image rm -f "$PROXY_IMAGE" "$CLIENT_IMAGE" >/dev/null 2>&1 || true
  local left
  left="$(docker ps -aq --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')"
  left=$((left + $(docker network ls -q --filter "label=ocw.namespace=${NS}" | wc -l | tr -d ' ')))
  if [ "$left" != "0" ]; then
    log "FAIL ${left} object(s) labelled ocw.namespace=${NS} left after cleanup"
    code=1
  fi
  exit "$code"
}
trap on_exit EXIT

# ---------------------------------------------------------------- helpers

ip_on() { docker inspect -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1"; }
subnet_of() { docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$1"; }

# set_policy <json> [expected log message]: written into the tmpfs as root by `docker exec` (atomic rename), then
# SIGHUP; waits for the proxy's "policy loaded" (or the given) operational line.
set_policy() {
  local before want="${2:-policy loaded}"
  before="$(docker logs "$PROXY" 2>&1 | grep -c "\"${want}\"" || true)"
  printf '%s' "$1" | docker exec -i -u 0 "$PROXY" sh -c \
    'cat > /run/ocw-egress/policy.json.tmp && mv /run/ocw-egress/policy.json.tmp /run/ocw-egress/policy.json'
  docker kill --signal HUP "$PROXY" >/dev/null
  for _ in $(seq 1 50); do
    if [ "$(docker logs "$PROXY" 2>&1 | grep -c "\"${want}\"" || true)" -gt "$before" ]; then return 0; fi
    sleep 0.1
  done
  log "FAIL the proxy did not reload its policy"
  exit 1
}

# network_entry <proxy address> <agent> <mode> <privateHosts json>
network_entry() {
  printf '{"address":"%s","orgId":"org-smoke","agentId":"%s","kind":"sbx","mode":"%s","allowHosts":[],"privateHosts":%s}' \
    "$1" "$2" "$3" "$4"
}

# policy <network entries…>: the full file, with every bot network's subnet and the proxy's address on each network.
policy() {
  local IFS=,
  printf '{"networks":[%s],"botNetworks":["%s","%s"],"ownAddresses":["%s","%s","%s"]}' \
    "$*" "$SUBNET_A" "$SUBNET_B" "$PROXY_A" "$PROXY_B" "$PROXY_FIX"
}

# via <client> <curl args…>: the HTTP status through the proxy (000 when curl got no response).
via() {
  local client="$1"
  shift
  docker exec "$client" curl -s -o /dev/null -w '%{http_code}' -m 10 -x "http://${PROXY}:3128" "$@" 2>/dev/null || true
}

# connect_status <client> <url>: the proxy's answer to the CONNECT itself (000 when there was none).
connect_status() {
  docker exec "$1" curl -s -o /dev/null -w '%{http_connect}' -m 10 -p -x "http://${PROXY}:3128" "$2" 2>/dev/null || true
}

# reason_of <client> <url>: the proxy's refusal reason (X-OCW-Egress header) for an absolute-URI request.
reason_of() {
  docker exec "$1" curl -s -D - -o /dev/null -m 10 -x "http://${PROXY}:3128" "$2" 2>/dev/null |
    tr -d '\r' | awk -F': ' 'tolower($1)=="x-ocw-egress"{print $2}' || true
}

expect_eq() {
  if [ "$2" = "$3" ]; then ok "$1 ($3)"; else fail "$1: expected '$3', got '$2'"; fi
}

# ---------------------------------------------------------------- preflight

server_version="$(docker version --format '{{.Server.Version}}')"
major="${server_version%%.*}"
if [ "$major" -lt 26 ]; then
  log "FAIL Docker ${server_version} < 26 (CVE-2024-29018: internal networks forward DNS); refusing to run"
  exit 1
fi
ok "Docker ${server_version} >= 26"

cleanup_ns

# ---------------------------------------------------------------- images: the real proxy and the real sbx as client

log "building ${PROXY_IMAGE} from infra/sandbox/egress/Dockerfile"
docker build -q --label "ocw.namespace=${NS}" -t "$PROXY_IMAGE" -f infra/sandbox/egress/Dockerfile . >/dev/null
log "building ${CLIENT_IMAGE} from infra/sandbox/sbx/Dockerfile"
docker build -q --label "ocw.namespace=${NS}" -t "$CLIENT_IMAGE" -f infra/sandbox/sbx/Dockerfile infra/sandbox/sbx >/dev/null

if [ "$(docker image inspect -f '{{.Config.User}}' "$PROXY_IMAGE")" = "10002:10002" ]; then
  ok "the proxy image runs as 10002:10002"
else
  fail "the proxy image user is not 10002:10002"
fi

# ---------------------------------------------------------------- networks and containers

docker network create --internal --label "ocw.namespace=${NS}" "$NET_A" >/dev/null
docker network create --internal --label "ocw.namespace=${NS}" "$NET_B" >/dev/null
docker network create --internal --label "ocw.namespace=${NS}" "$NET_FIX" >/dev/null

# The fake site stands in for the outside world: a fixtures network only the proxy joins.
docker run -d --name "$FAKE" --label "ocw.namespace=${NS}" --network "$NET_FIX" --network-alias fake-site.local \
  --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$ROOT/infra/sandbox/test/fake-site.mjs:/site/fake-site.mjs:ro" "$BASE" node /site/fake-site.mjs >/dev/null

docker run -d --name "$PROXY" --label "ocw.namespace=${NS}" --network "$NET_A" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true --init \
  --tmpfs /run/ocw-egress:rw,noexec,nosuid,nodev,size=1m,mode=0755 "$PROXY_IMAGE" >/dev/null
docker network connect "$NET_FIX" "$PROXY"
docker network connect "$NET_B" "$PROXY"

docker run -d --name "$CLIENT_A" --label "ocw.namespace=${NS}" --network "$NET_A" \
  --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --init \
  "$CLIENT_IMAGE" sleep infinity >/dev/null
# Bot B listens on 8080: the target bot A must never reach through the shared proxy.
docker run -d --name "$CLIENT_B" --label "ocw.namespace=${NS}" --network "$NET_B" \
  --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --init \
  "$CLIENT_IMAGE" python3 -m http.server 8080 --bind 0.0.0.0 --directory /opt/ocw-packages >/dev/null

for _ in $(seq 1 50); do
  docker logs "$PROXY" 2>&1 | grep -q '"listening"' && break
  sleep 0.2
done
docker logs "$PROXY" 2>&1 | grep -q '"listening"' || {
  log "FAIL the proxy never listened"
  exit 1
}
for _ in $(seq 1 50); do
  docker exec "$FAKE" node -e 'fetch("http://127.0.0.1:8080/__stats").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
    >/dev/null 2>&1 && break
  sleep 0.2
done

PROXY_A="$(ip_on "$PROXY" "$NET_A")"
PROXY_B="$(ip_on "$PROXY" "$NET_B")"
PROXY_FIX="$(ip_on "$PROXY" "$NET_FIX")"
CLIENT_B_IP="$(ip_on "$CLIENT_B" "$NET_B")"
SUBNET_A="$(subnet_of "$NET_A")"
SUBNET_B="$(subnet_of "$NET_B")"
STATS="http://fake-site.local:8080/__stats"

# ---------------------------------------------------------------- the network contains the sandbox

if docker exec "$CLIENT_A" curl --noproxy '*' -s -o /dev/null -m 5 https://1.1.1.1 2>/dev/null; then
  fail "client A reached 1.1.1.1 without the proxy"
else
  ok "client A has no route out without the proxy"
fi
if docker exec "$CLIENT_A" getent hosts example.com >/dev/null 2>&1; then
  fail "client A resolved example.com (external DNS on an internal network)"
else
  ok "client A has no external DNS"
fi
if docker exec "$CLIENT_A" curl --noproxy '*' -s -o /dev/null -m 5 "$STATS" 2>/dev/null; then
  fail "client A reached the fake site directly"
else
  ok "client A cannot reach the fake site directly"
fi

# ---------------------------------------------------------------- no policy yet: fail closed

expect_eq "no policy loaded refuses everything" "$(reason_of "$CLIENT_A" "$STATS")" "unknown_network"

# ---------------------------------------------------------------- private host allowed by exact host:port

set_policy "$(policy "$(network_entry "$PROXY_A" agent-a public '["fake-site.local:8080"]')")"
expect_eq "allowed private host through the proxy (absolute URI)" "$(via "$CLIENT_A" "$STATS")" "200"
expect_eq "allowed private host through a CONNECT tunnel" "$(via "$CLIENT_A" -p "$STATS")" "200"
expect_eq "sandboxd is refused by name" "$(reason_of "$CLIENT_A" "http://sandboxd:8090/")" "platform_host"
expect_eq "sandbox-egress is refused by name" "$(reason_of "$CLIENT_A" "http://sandbox-egress:3128/")" "platform_host"
expect_eq "metadata is refused" "$(reason_of "$CLIENT_A" "http://169.254.169.254/")" "refused_address"
expect_eq "another port of the fixture is refused" "$(reason_of "$CLIENT_A" "http://fake-site.local:8081/")" "port"

set_policy "$(policy "$(network_entry "$PROXY_A" agent-a public '[]')")"
expect_eq "the same private host:port without the allow entry" "$(reason_of "$CLIENT_A" "$STATS")" "port"
expect_eq "another port of a host on a network the proxy is attached to (not allowed)" \
  "$(reason_of "$CLIENT_A" "http://fake-site.local/")" "attached_network"
expect_eq "the same private host through CONNECT without the allow entry" "$(connect_status "$CLIENT_A" "$STATS")" "403"

# ---------------------------------------------------------------- the single shared hop: A and B (D-01)

for _ in $(seq 1 50); do
  docker exec "$CLIENT_B" curl --noproxy '*' -s -o /dev/null -m 2 http://127.0.0.1:8080/ 2>/dev/null && break
  sleep 0.2
done
B_TARGET="http://${CLIENT_B_IP}:8080/"
B_BY_NAME="http://${CLIENT_B}:8080/"
PROXY_ON_B="http://${PROXY_B}:3128/"
# A's private hosts list B's container (by address and by name) and the proxy's address on B: none of it may work.
set_policy "$(policy \
  "$(network_entry "$PROXY_A" agent-a public "[\"fake-site.local:8080\",\"${CLIENT_B_IP}:8080\",\"${CLIENT_B}:8080\",\"${PROXY_B}:3128\"]")" \
  "$(network_entry "$PROXY_B" agent-b off '["fake-site.local:8080"]')")"

expect_eq "control: B's listener answers inside B" \
  "$(docker exec "$CLIENT_B" curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8080/ || true)" "200"
if docker exec "$PROXY" node -e '
  const s = require("net").connect(8080, process.argv[1]);
  s.on("connect", () => process.exit(0));
  s.on("error", () => process.exit(1));
  setTimeout(() => process.exit(1), 3000);
' "$CLIENT_B_IP" >/dev/null 2>&1; then
  ok "control: the proxy container itself can reach B (so a refusal below is the policy, not the network)"
else
  fail "control: the proxy cannot reach B's listener at all"
fi
expect_eq "A reaches the fixture through the shared proxy (mode public)" "$(via "$CLIENT_A" "$STATS")" "200"
expect_eq "B's same request fails (mode off)" "$(reason_of "$CLIENT_B" "$STATS")" "egress_off"
expect_eq "A cannot reach B's container by address, though listed" "$(reason_of "$CLIENT_A" "$B_TARGET")" "bot_network"
expect_eq "A cannot reach B's container by name, though listed" "$(reason_of "$CLIENT_A" "$B_BY_NAME")" "bot_network"
expect_eq "A cannot tunnel to B's container" "$(connect_status "$CLIENT_A" "$B_TARGET")" "403"
expect_eq "A cannot reach the proxy's own address on B, though listed" \
  "$(reason_of "$CLIENT_A" "$PROXY_ON_B")" "proxy_self"
expect_eq "A cannot reach the proxy's own address on A" "$(reason_of "$CLIENT_A" "http://${PROXY_A}:3128/")" "proxy_self"
if docker exec "$CLIENT_A" curl --noproxy '*' -s -o /dev/null -m 5 "$B_TARGET" 2>/dev/null; then
  fail "A reached B directly"
else
  ok "A has no direct route to B"
fi

# Fail closed: a policy without bot networks (or own addresses) is invalid and refuses everything.
set_policy "{\"networks\":[$(network_entry "$PROXY_A" agent-a public '["fake-site.local:8080"]')],\"botNetworks\":[],\"ownAddresses\":[\"${PROXY_A}\"]}" \
  "policy invalid"
expect_eq "a policy with no bot networks refuses everything" "$(reason_of "$CLIENT_A" "$STATS")" "unknown_network"
set_policy "$(policy "$(network_entry "$PROXY_A" agent-a public '["fake-site.local:8080"]')")"
expect_eq "a valid policy again: A reaches the fixture" "$(via "$CLIENT_A" "$STATS")" "200"

# ---------------------------------------------------------------- decision lines: host only

stdout_lines="$(docker logs "$PROXY" 2>/dev/null)"
if printf '%s\n' "$stdout_lines" | grep -q '"host":"fake-site.local","port":8080,"allowed":true,"reason":"allowed"'; then
  ok "a decision line reports the allowed host"
else
  fail "no allowed decision line for fake-site.local"
fi
if printf '%s\n' "$stdout_lines" | grep -q '__stats'; then
  fail "a decision line carries a path"
else
  ok "decision lines never carry a path"
fi
bad_keys="$(printf '%s\n' "$stdout_lines" | node -e '
  const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
  const want = "allowed,host,network,port,reason";
  process.stdout.write(String(lines.filter((l) => Object.keys(JSON.parse(l)).sort().join() !== want).length));
')"
expect_eq "every stdout line is exactly { network, host, port, allowed, reason }" "$bad_keys" "0"

# ---------------------------------------------------------------- hardening of the running proxy

if [ "$(docker exec "$PROXY" sh -c 'grep CapEff /proc/1/status' | awk '{print $2}')" = "0000000000000000" ] &&
  ! docker exec "$PROXY" sh -c 'touch /app/x' 2>/dev/null &&
  ! docker exec "$PROXY" sh -c 'touch /run/ocw-egress/x' 2>/dev/null; then
  ok "the proxy has no capabilities, a read-only root and cannot rewrite its policy"
else
  fail "the proxy hardening is incomplete"
fi

log "${CHECKS} checks, ${FAILURES} failure(s)"
[ "$FAILURES" = "0" ]
