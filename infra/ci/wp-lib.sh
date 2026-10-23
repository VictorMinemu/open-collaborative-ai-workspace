# Shared helpers for the CI scripts that must tell a running Woodpecker workflow from a finished one (sourced, POSIX sh).
# Every Woodpecker workflow owns one volume, `wp_<uuid>_<n>_default`, mounted in each of its step containers and
# removed by the agent when the workflow ends (success, failure, cancel or kill). While that volume exists and is younger
# than the repo timeout (120 min) plus a margin, its workflow may still be running; an agent that crashed leaves it
# behind, and the age bound stops it from looking alive forever.
OCW_CI_LIVE_MIN="${OCW_CI_LIVE_MIN:-150}"

# This step's workflow volume, or nothing. Woodpecker's step containers keep Docker's default hostname (the container
# id), so a step without host networking can inspect itself; a host-network step gets nothing.
wp_own_volume() {
  docker inspect --format '{{range .Mounts}}{{println .Name}}{{end}}' "$(hostname)" 2>/dev/null | grep '^wp_' | head -n 1
}

# Seconds since the epoch of a Docker timestamp, read as UTC ("2026-10-22T07:22:10Z", "2026-10-22T07:22:10.5+00:00",
# "2026-10-22 07:22:10 +0000 UTC"). Prints nothing when it cannot be parsed. GNU/BusyBox date, else BSD date (tests).
docker_epoch() {
  t="$(printf '%s' "$1" | sed -nE 's/^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2}:[0-9]{2}).*/\1 \2/p')"
  [ -n "$t" ] || return 0
  date -u -d "$t" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$t" +%s 2>/dev/null || true
}

# Exit 0 when the volume exists and is younger than OCW_CI_LIVE_MIN minutes (an unreadable age counts as live).
wp_volume_live() {
  created="$(docker volume inspect --format '{{.CreatedAt}}' "$1" 2>/dev/null)" || return 1
  at="$(docker_epoch "$created")"
  [ -n "$at" ] || return 0
  [ $(($(date +%s) - at)) -lt $((OCW_CI_LIVE_MIN * 60)) ]
}

# The live workflow volumes other than this step's own, one per line (the other workflows running on this daemon).
wp_other_live_volumes() {
  own="$(wp_own_volume)"
  for v in $(docker volume ls -q --filter name=wp_); do
    case "$v" in wp_*) ;; *) continue ;; esac
    [ "$v" = "$own" ] && continue
    if wp_volume_live "$v"; then echo "$v"; fi
  done
}
