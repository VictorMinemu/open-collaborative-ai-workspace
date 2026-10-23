#!/bin/sh
# One run per CI slot at a time. Every heavy workflow (and each e2e viewport) owns a slot, OCW_CI_SLOT: its compose
# projects, port block, label namespaces and directories under /home/ocw-ci (table in infra/ci/README.md, checked by
# infra/ci/slots.test.mjs). Workflows of different slots run side by side; two pipelines (two open pull requests) never
# run the SAME slot at once, because they would share its ports and names and its reset would remove the other's
# objects. A new push to the same pull request cancels the older pipeline (repo setting), so the usual wait is zero.
#
#   sh infra/ci/slot-lease.sh acquire   # first command of the workflow's install step, before anything of the slot
#   sh infra/ci/slot-lease.sh release   # last command of its cleanup step
#
# The lease is /home/ocw-ci/slots/<slot>.lease: "<pipeline> <workflow volume> <epoch>". A holder is alive while its
# Woodpecker workflow volume exists (infra/ci/wp-lib.sh); a cancelled or killed run's lease is taken over at once, and
# that run's leftovers are then removed by infra/ci/slot-reset.sh. A short mkdir mutex makes check-and-write atomic.
set -eu
. "$(dirname "$0")/wp-lib.sh"

SLOT="${OCW_CI_SLOT:?OCW_CI_SLOT is required}"
DIR="${OCW_CI_SLOTS_DIR:-/home/ocw-ci/slots}"
WAIT_S="${OCW_CI_LEASE_WAIT_S:-6000}"
POLL_S="${OCW_CI_LEASE_POLL_S:-30}"
LEASE="$DIR/$SLOT.lease"
MUTEX="$DIR/.mutex"
ME_PIPELINE="${CI_PIPELINE_NUMBER:-local}"
ME_VOLUME="$(wp_own_volume)"
ME_VOLUME="${ME_VOLUME:--}"
mkdir -p "$DIR"

lock() {
  until mkdir "$MUTEX" 2>/dev/null; do
    # Held for milliseconds: one older than a minute was left by a killed step.
    if [ -n "$(find "$MUTEX" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$MUTEX" 2>/dev/null || true; fi
    sleep 1
  done
}
unlock() { rmdir "$MUTEX" 2>/dev/null || true; }

# Reads the lease into HOLDER_PIPELINE / HOLDER_VOLUME / HOLDER_AT and sets STATE to free, mine or held.
lease_state() {
  HOLDER_PIPELINE=""
  HOLDER_VOLUME=""
  HOLDER_AT=0
  STATE=free
  [ -s "$LEASE" ] || return 0
  read -r HOLDER_PIPELINE HOLDER_VOLUME HOLDER_AT <"$LEASE" || true
  if [ "$HOLDER_PIPELINE" = "$ME_PIPELINE" ] && [ "$HOLDER_VOLUME" = "$ME_VOLUME" ]; then
    STATE=mine
  elif [ -n "$HOLDER_VOLUME" ] && [ "$HOLDER_VOLUME" != "-" ]; then
    if wp_volume_live "$HOLDER_VOLUME"; then STATE=held; fi
  elif [ $(($(date +%s) - ${HOLDER_AT:-0})) -lt $((OCW_CI_LIVE_MIN * 60)) ]; then
    # A holder whose workflow volume was unknown: alive until the age bound.
    STATE=held
  fi
}

acquire() {
  [ "$ME_VOLUME" != "-" ] || echo "slot-lease: WARNING no Woodpecker workflow volume found; this lease ends by age only" >&2
  deadline=$(($(date +%s) + WAIT_S))
  while :; do
    lock
    lease_state
    if [ "$STATE" != held ]; then
      if [ "$STATE" = free ] && [ -n "$HOLDER_PIPELINE" ]; then
        echo "slot-lease: $SLOT: pipeline $HOLDER_PIPELINE's run has ended; taking its slot over"
      fi
      printf '%s %s %s\n' "$ME_PIPELINE" "$ME_VOLUME" "$(date +%s)" >"$LEASE"
      unlock
      echo "slot-lease: $SLOT held by pipeline $ME_PIPELINE"
      return 0
    fi
    unlock
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "slot-lease: $SLOT is still held by pipeline $HOLDER_PIPELINE after ${WAIT_S}s; giving up" >&2
      return 1
    fi
    echo "slot-lease: $SLOT is in use by pipeline $HOLDER_PIPELINE (running); waiting ${POLL_S}s"
    sleep "$POLL_S"
  done
}

release() {
  lock
  lease_state
  if [ "$STATE" = mine ]; then
    rm -f "$LEASE"
    echo "slot-lease: $SLOT released"
  fi
  unlock
}

case "${1:-}" in
  acquire) acquire ;;
  release) release ;;
  *)
    echo "usage: OCW_CI_SLOT=<slot> sh infra/ci/slot-lease.sh acquire|release" >&2
    exit 2
    ;;
esac
