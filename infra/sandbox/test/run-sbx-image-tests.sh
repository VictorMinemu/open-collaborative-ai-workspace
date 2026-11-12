#!/bin/sh
# Image unit tests of the bot sandbox `sbx` (phase 07.17.1.1.1, D-05, D-07; ADR-0043). Streams
# infra/sandbox/sbx/tools/tests into a container hardened exactly like a bot's shell (apps/sandboxd/src/spec.ts
# shellSpec: uid 10001, read-only root, cap-drop ALL, no-new-privileges, init, 256 pids, 1 GiB, 1 CPU, noexec /tmp) with
# no network at all, and runs them there with the stdlib `unittest`. A second, root, read-only, network-less throwaway
# run measures the root filesystem (10001 cannot read every directory); over the budget fails.
#
# Usage (repo root):  sh infra/sandbox/test/run-sbx-image-tests.sh <image>
#   e.g. sh infra/sandbox/test/run-sbx-image-tests.sh ocw-sandbox-sbx:ci
#
# POSIX sh on purpose: the Woodpecker `docker:29.8.2-cli` step has no bash. Needs only docker, tar and sh. The tests are
# streamed with tar (no bind mount: a dind daemon cannot see the step's workspace). It never builds, removes or retags
# the image it is given; every container it starts is `--rm`.
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: sh infra/sandbox/test/run-sbx-image-tests.sh <image>" >&2
  exit 2
fi
IMAGE=$1
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TOOLS="$ROOT/infra/sandbox/sbx/tools"
ROOTFS_MAX_MIB=1300
LABEL=ocw.test=sbx-image-tests

if [ ! -d "$TOOLS/tests" ]; then
  echo "FAIL: $TOOLS/tests not found" >&2
  exit 1
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: image $IMAGE not found (build it first)" >&2
  exit 1
fi

# The interpreter: the toolkit venv's once the image has it (07.17.1.1.1-03), else the system Python. -I either way:
# neither PYTHONPATH nor the working directory reaches the tests.
if docker run --rm --label "$LABEL" --network none "$IMAGE" test -x /opt/ocw-tools/venv/bin/python3; then
  PY=/opt/ocw-tools/venv/bin/python3
else
  PY=/usr/bin/python3
fi
echo "image tests: $IMAGE with $PY"

STATUS=0
# COPYFILE_DISABLE keeps macOS tar from adding AppleDouble files; GNU and BusyBox tar ignore it.
if COPYFILE_DISABLE=1 tar -C "$TOOLS" -cf - tests | docker run -i --rm --label "$LABEL" \
  --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --init \
  --pids-limit 256 --memory 1g --memory-swap 1g --cpus 1 --network none \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --tmpfs /workspace:rw,nosuid,nodev,size=512m,uid=10001,gid=10001 \
  "$IMAGE" sh -c 'mkdir -p /tmp/t && tar -x -C /tmp/t && exec "$0" -I -m unittest discover -s /tmp/t/tests -t /tmp/t/tests -v' "$PY"; then
  :
else
  STATUS=$?
  echo "FAIL: image unit tests exited $STATUS" >&2
fi

# The size gate (PD-16): `du -sxm /` as root on a read-only root and no network; the compressed size is not gated.
ROOTFS=$(docker run --rm --label "$LABEL" --user 0:0 --read-only --network none "$IMAGE" du -sxm / | cut -f1)
echo "rootfs ${ROOTFS} MiB (budget ${ROOTFS_MAX_MIB})"
case "$ROOTFS" in
  '' | *[!0-9]*)
    echo "FAIL: could not measure the root filesystem" >&2
    STATUS=1
    ;;
  *)
    if [ "$ROOTFS" -gt "$ROOTFS_MAX_MIB" ]; then
      echo "FAIL: rootfs ${ROOTFS} MiB is over ${ROOTFS_MAX_MIB} MiB" >&2
      STATUS=1
    fi
    ;;
esac

if [ "$STATUS" -ne 0 ]; then
  echo "image tests: FAILED" >&2
  exit "$STATUS"
fi
echo "image tests: all passed"
