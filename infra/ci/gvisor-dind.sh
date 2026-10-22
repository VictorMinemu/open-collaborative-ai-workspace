#!/bin/sh
# A nested Docker daemon with gVisor `runsc` registered, for the CI gVisor job (07.8-24; D-14, spike i). The Woodpecker
# dind is runc-only and is never reconfigured: this starts a NEW privileged `docker:dind` container next to the steps,
# with its own --config-file registering runsc (systrap), and exposes its socket on the shared /home/ocw-ci volume.
#
#   sh infra/ci/gvisor-dind.sh up     # prints the socket path on stdout once `docker info` lists runsc
#   sh infra/ci/gvisor-dind.sh down   # removes the nested daemon, its volumes and the socket directory (by label)
#   sh infra/ci/gvisor-dind.sh sock   # prints the socket path (for the steps after `up`)
#
# gVisor comes from the GitHub release google/gvisor release-20261005.0 (the Google bucket path returns 404), verified
# with its SHA512 before extraction; the WHOLE tarball is needed (runsc refuses to start without gvisor-bin/ sidecars).
# Every object is named ocw-ci-<slot>-gvisor-* and labelled ocw.namespace=ocw-ci-<slot>-gvisor (OCW_CI_SLOT, default
# sandbox), and the socket lives in /home/ocw-ci/run/ocw-ci-<slot>-gvisor, so infra/ci/slot-reset.sh of that slot also
# removes a daemon a cancelled run left, and no other slot's run is touched. Run it only against the CI dind (never a
# host or demo daemon).
set -eu

DIND_IMAGE="docker:29.8.2-dind@sha256:1e08cdb63405ca788aea94ef35b792d1e299607c667d33d7bcbcae1fd2611ced"
GVISOR_URL="https://github.com/google/gvisor/releases/download/release-20261005.0/gvisor-x86_64.tar.bz2"
GVISOR_SHA512="79869ae9a589355a46d46fdac068d9a954e741741ffe77c64e38c56ea955498c1cb04e9bce44e1cce5155333e6b76bee72347c6661bb7c78fd2fe3aad198c8fe"
PREFIX="ocw-ci-${OCW_CI_SLOT:-sandbox}-gvisor"
NAME="$PREFIX-dind"
LABEL="ocw.namespace=$PREFIX"
SOCK_DIR="${OCW_GVISOR_SOCK_DIR:-/home/ocw-ci/run/$PREFIX}"
SHARED=/home/ocw-ci

down() {
  ids="$(docker ps -aq --filter "label=$LABEL")"
  [ -n "$ids" ] && docker rm -fv $ids >/dev/null 2>&1
  for v in $(docker volume ls -q --filter "label=$LABEL"); do docker volume rm -f "$v" >/dev/null 2>&1 || true; done
  rm -rf "$SOCK_DIR"
  return 0
}

up() {
  [ "$(uname -m)" = x86_64 ] || { echo "gvisor-dind: x86_64 only (this release asset)" >&2; exit 1; }
  down
  mkdir -p "$SOCK_DIR"
  docker volume create --label "$LABEL" "$PREFIX-runsc" >/dev/null
  docker volume create --label "$LABEL" "$PREFIX-lib" >/dev/null
  # runsc + shim + sidecars, SHA512-checked, then the nested daemon's config registering runsc on systrap.
  docker run --rm --label "$LABEL" -v "$PREFIX-runsc:/opt/runsc" --entrypoint sh "$DIND_IMAGE" -ec "
    cd /opt/runsc
    wget -q -O gvisor.tar.bz2 '$GVISOR_URL'
    echo '$GVISOR_SHA512  gvisor.tar.bz2' | sha512sum -c - >/dev/null
    tar -xjf gvisor.tar.bz2 runsc containerd-shim-runsc-v1 gvisor-bin
    rm gvisor.tar.bz2
    chmod 0755 runsc containerd-shim-runsc-v1 gvisor-bin/*
    printf '%s\n' '{\"runtimes\":{\"runsc\":{\"path\":\"/opt/runsc/runsc\",\"runtimeArgs\":[\"--platform=systrap\"]}}}' > daemon.json
    ./runsc --version | head -1" >&2
  # Unix socket only (no TCP); /home/ocw-ci at the same path so the smokes' bind mounts resolve in the nested daemon.
  docker run -d --privileged --name "$NAME" --label "$LABEL" -e DOCKER_TLS_CERTDIR= \
    -v "$PREFIX-runsc:/opt/runsc" -v "$PREFIX-lib:/var/lib/docker" \
    -v "$SHARED:$SHARED" \
    "$DIND_IMAGE" dockerd --host="unix://$SOCK_DIR/docker.sock" --config-file /opt/runsc/daemon.json >/dev/null
  i=0
  until DOCKER_HOST="unix://$SOCK_DIR/docker.sock" docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then
      echo "gvisor-dind: the nested daemon did not come up with runsc" >&2
      docker logs --tail 40 "$NAME" >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "$SOCK_DIR/docker.sock"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  sock) echo "$SOCK_DIR/docker.sock" ;;
  *)
    echo "usage: sh infra/ci/gvisor-dind.sh up|down|sock" >&2
    exit 2
    ;;
esac
