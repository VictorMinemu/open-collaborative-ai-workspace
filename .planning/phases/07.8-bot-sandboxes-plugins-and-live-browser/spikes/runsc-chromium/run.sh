#!/usr/bin/env bash
# Spike (i), 07.8-03: Playwright 1.63's Chromium under gVisor runsc (systrap) and under hardened runc. Throwaway; run
# from a workstation:
#
#   bash .planning/phases/07.8-bot-sandboxes-plugins-and-live-browser/spikes/runsc-chromium/run.sh > report.jsonl
#
# Layout: CI host  ->  woodpecker-dind (never reconfigured)  ->  ocw-spike-078-dind (a NEW privileged nested
# docker:29.8.2-dind with runsc registered through its own --config-file)  ->  the probe containers.
# Every object in the Woodpecker dind carries ocw.spike=07.8; the EXIT trap removes them by label, then the dind image
# by name. Probe images and containers live in the nested daemon's volume and vanish with it.
#
# gVisor source (gate deviation, approved): the Google bucket has no release/20261005.0/x86_64/runsc, so the official
# GitHub release asset google/gvisor release-20261005.0 gvisor-x86_64.tar.bz2 is used, verified against the SHA512
# from that release's SHA512SUMS before extraction.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${SPIKE_HOST:-hetzner-ci}"
DIND="${SPIKE_DIND:-woodpecker-dind}"
DIND_IMAGE="docker:29.8.2-dind@sha256:1e08cdb63405ca788aea94ef35b792d1e299607c667d33d7bcbcae1fd2611ced"
GVISOR_URL="https://github.com/google/gvisor/releases/download/release-20261005.0/gvisor-x86_64.tar.bz2"
GVISOR_SHA512="79869ae9a589355a46d46fdac068d9a954e741741ffe77c64e38c56ea955498c1cb04e9bce44e1cce5155333e6b76bee72347c6661bb7c78fd2fe3aad198c8fe"
# Docker's own default seccomp profile at the daemon's exact version (moby vendors moby/profiles/seccomp v0.2.3).
SECCOMP_URL="https://raw.githubusercontent.com/moby/moby/docker-v29.8.2/vendor/github.com/moby/profiles/seccomp/default.json"
SECCOMP_SHA256="536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74"
NESTED=ocw-spike-078-dind
BRW_IMAGE=ocw-spike-078-brw:spike

dind() { ssh "$HOST" "docker exec -i $DIND $(printf '%q ' "$@")"; }
nested() { dind docker exec -i "$NESTED" "$@"; }

cleanup() {
  echo "== cleanup by label ocw.spike=07.8 in $DIND" >&2
  dind sh -c '
    ids=$(docker ps -aq --filter label=ocw.spike=07.8); [ -z "$ids" ] || docker rm -fv $ids >/dev/null
    for v in $(docker volume ls -q --filter label=ocw.spike=07.8); do docker volume rm "$v" >/dev/null; done
    docker image rm docker:29.8.2-dind >/dev/null 2>&1 || true
    docker image rm '"${DIND_IMAGE#*@}"' >/dev/null 2>&1 || true' >&2 || true
  rm -rf "${CTX:-}"
}
trap cleanup EXIT

running="$(dind docker ps -q | wc -l | tr -d ' ')"
[[ "$running" == "0" ]] || { echo "dind is busy ($running containers): wait for the pipeline" >&2; exit 1; }

# Build context: Dockerfile, probe, and the Chromium seccomp profile = Docker's default + user-namespace clone/unshare/
# setns (Playwright's documented seccomp_profile.json delta, applied to the daemon's current default).
CTX="$(mktemp -d "${TMPDIR:-/tmp}/ocw-spike-078-ctx.XXXXXX")"
cp "$HERE/Dockerfile" "$HERE/probe.mjs" "$CTX/"
curl -fsSL "$SECCOMP_URL" -o "$CTX/default.json"
echo "$SECCOMP_SHA256  $CTX/default.json" | shasum -a 256 -c - >&2
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  p.syscalls.push({ comment: "Allow create user namespaces (Chromium sandbox)", names: ["clone", "setns", "unshare"],
    action: "SCMP_ACT_ALLOW", args: [], includes: {}, excludes: {} });
  fs.writeFileSync(process.argv[2], JSON.stringify(p, null, 1));' "$CTX/default.json" "$CTX/seccomp-chromium.json"
rm "$CTX/default.json"

echo "== pull $DIND_IMAGE into $DIND" >&2
dind docker pull -q "$DIND_IMAGE" >&2
dind docker volume create --label ocw.spike=07.8 ocw-spike-078-runsc >/dev/null
dind docker volume create --label ocw.spike=07.8 ocw-spike-078-nested-lib >/dev/null

echo "== fetch gVisor release-20261005.0, verify SHA512, extract runsc + shim, write the nested daemon config" >&2
dind docker run --rm --label ocw.spike=07.8 -v ocw-spike-078-runsc:/opt/runsc --entrypoint sh "$DIND_IMAGE" -ec "
  cd /opt/runsc
  wget -q -O gvisor.tar.bz2 '$GVISOR_URL'
  echo '$GVISOR_SHA512  gvisor.tar.bz2' | sha512sum -c -
  # runsc release-20261005.0 refuses to start without its sidecar binaries (gvisor-bin/gvisor_sentry, STRICT policy).
  tar -xjf gvisor.tar.bz2 runsc containerd-shim-runsc-v1 gvisor-bin
  rm gvisor.tar.bz2
  chmod 0755 runsc containerd-shim-runsc-v1 gvisor-bin/*
  printf '%s\n' '{\"runtimes\":{\"runsc\":{\"path\":\"/opt/runsc/runsc\",\"runtimeArgs\":[\"--platform=systrap\"]}}}' > daemon.json
  ./runsc --version" >&2

echo "== start the nested daemon $NESTED (unix socket only, runsc registered)" >&2
dind docker run -d --privileged --name "$NESTED" --label ocw.spike=07.8 -e DOCKER_TLS_CERTDIR= \
  -v ocw-spike-078-runsc:/opt/runsc -v ocw-spike-078-nested-lib:/var/lib/docker \
  "$DIND_IMAGE" dockerd --host=unix:///var/run/docker.sock --config-file /opt/runsc/daemon.json >/dev/null
for _ in $(seq 1 60); do nested docker info >/dev/null 2>&1 && break; sleep 1; done
nested docker info --format '{"nested":{"ServerVersion":"{{.ServerVersion}}","Runtimes":"{{range $k,$v := .Runtimes}}{{$k}} {{end}}","Kernel":"{{.KernelVersion}}","Cgroup":"{{.CgroupVersion}}","SecurityOptions":"{{.SecurityOptions}}"}}'

echo "== build $BRW_IMAGE in the nested daemon" >&2
tar -C "$CTX" -cf - Dockerfile probe.mjs seccomp-chromium.json | nested sh -ec 'mkdir -p /spike && tar -C /spike -xf -'
nested docker build -q -t "$BRW_IMAGE" /spike >&2
nested docker run --rm --entrypoint sh "$BRW_IMAGE" -c \
  'cat /ms-playwright/*/INSTALLATION_COMPLETE >/dev/null 2>&1; ls /ms-playwright; du -sh /ms-playwright' >&2
nested docker image inspect "$BRW_IMAGE" --format '{"image":{"size":{{.Size}}}}'

# The hardened profile (07.8-RESEARCH.md §3) with the brw limits; never host IPC; no network needed (inline page).
HARD=(--user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --init
  --pids-limit 512 --memory 2g --memory-swap 2g --cpus 1 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m
  --shm-size 512m --network none --label ocw.spike=07.8)

probe() { # $1 mode label, $2 sandbox 1|0, rest: extra docker run flags
  local mode="$1" sb="$2"; shift 2
  echo "== mode ($mode): sandbox=$sb $*" >&2
  local out
  out="$(nested timeout 240 docker run --rm "${HARD[@]}" "$@" -e SPIKE_MODE="$mode" -e CHROMIUM_SANDBOX="$sb" \
    "$BRW_IMAGE" 2>&1)" || true
  local json
  json="$(printf '%s\n' "$out" | grep '^{"mode"' | tail -1 || true)"
  if [[ -n "$json" ]]; then echo "$json"; else
    node -e 'console.log(JSON.stringify({mode:process.argv[1],ok:false,dockerError:process.argv[2].slice(-3000)}))' \
      "$mode" "$out"
  fi
}

# Can an unprivileged process (uid 10001, no caps) create the namespaces Chromium's sandbox needs? util-linux unshare.
userns() { # $1 label, rest: extra docker run flags
  local label="$1"; shift
  local out
  local flags=("${HARD[@]}")
  # "plain-*": only the uid, no hardening at all, seccomp and AppArmor off: isolates the host's own restriction.
  [[ "$label" == plain-* ]] && flags=(--user 10001:10001 --network none --label ocw.spike=07.8)
  out="$(nested timeout 60 docker run --rm "${flags[@]}" "$@" --entrypoint sh "$BRW_IMAGE" -c '
    for a in "-U" "-Ur" "-Urpf" "-Urn"; do
      if r=$(unshare $a true 2>&1); then printf "%s=ok " "$a"; else printf "%s=%s " "$a" "$(echo "$r" | tail -1 | tr " " _)"; fi
    done' 2>&1)" || true
  node -e 'console.log(JSON.stringify({userns:process.argv[1],result:process.argv[2].trim()}))' "$label" "$out"
}

probe a 1 --runtime runsc
probe b 0 --runtime runsc
probe c 1 --runtime runc --security-opt seccomp=/spike/seccomp-chromium.json
probe d 1 --runtime runc
# Diagnostics for (c): is the remaining blocker AppArmor (Ubuntu 24.04 restricts unprivileged user namespaces)?
probe c-aa 1 --runtime runc --security-opt seccomp=/spike/seccomp-chromium.json --security-opt apparmor=unconfined
userns runsc --runtime runsc
userns runc-seccomp-chromium --runtime runc --security-opt seccomp=/spike/seccomp-chromium.json
userns runc-seccomp-chromium-apparmor-unconfined --runtime runc --security-opt seccomp=/spike/seccomp-chromium.json \
  --security-opt apparmor=unconfined
userns runc-default --runtime runc
userns plain-runc-unconfined --runtime runc --security-opt seccomp=unconfined --security-opt apparmor=unconfined
ssh "$HOST" 'sysctl -n kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone' |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [r,c]=s.trim().split(/\s+/);
    console.log(JSON.stringify({host:{apparmor_restrict_unprivileged_userns:r,unprivileged_userns_clone:c}}))})'
nested sh -c 'cat /proc/self/attr/current 2>/dev/null; echo; cat /sys/kernel/security/apparmor/profiles 2>/dev/null |
  grep -c . ; grep -l "userns" /sys/kernel/security/apparmor/features/policy/* 2>/dev/null | head -3' |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({apparmorFromNested:s.trim()})))'
