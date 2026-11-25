#!/usr/bin/env bash
# Phase 07.13-04 probe (A-6, D-06, research Pitfall 4): which apt packages does the pinned Chrome for Testing headless
# shell need on each Linux distribution the Local Runtime supports? Opt-in, needs Docker and network (one ~126 MB
# download from Google's Chrome for Testing bucket plus the distributions' apt mirrors), never part of `pnpm verify`.
#
#   bash scripts/probes/browser-linux-libs.sh            # linux64 (x86_64; emulated on an arm64 Docker host)
#   bash scripts/probes/browser-linux-libs.sh arm64      # linux-arm64
#
# 1. Downloads the pinned zip once into a temp dir, checks its sha256 (the table in RESEARCH § Standard Stack and the
#    brw Dockerfile's `ADD --checksum`), unzips it there.
# 2. For debian:bookworm-slim, ubuntu:22.04 and ubuntu:24.04 (throwaway containers, the unzipped shell mounted
#    read-only, nothing else from the host): `ldd chrome-headless-shell | grep "not found"`, each missing soname mapped
#    to its Debian package (the brw Dockerfile's names), each name resolved against that distribution's apt index
#    (`<name>t64` when only that exists, Ubuntu 24.04's 64-bit time_t rename), then the packages installed and ldd
#    re-run to prove nothing is still missing.
# 3. Prints one line per distribution: `<distro>: apt-get install -y <packages>` (plan 06 prints it verbatim), then
#    `<distro>: verified, 0 missing after install` (or the sonames still missing).
# The temp dir and the containers are removed on exit, whatever happens.
set -euo pipefail

VERSION="156.0.8078.47"
case "${1:-x64}" in
  x64 | amd64 | linux64)
    PLAT=linux64
    DOCKER_PLATFORM=linux/amd64
    SHA256=0d5acc62c3e213f8c87d3c298d66ffcf9a236d12ea4b9f85318bf85dbc279daa
    ;;
  arm64 | linux-arm64)
    PLAT=linux-arm64
    DOCKER_PLATFORM=linux/arm64
    SHA256=955059fa7020d7be85eb503e21339fd4d718f51f5996d3b60633fbf908bda132
    ;;
  *)
    echo "browser-linux-libs: unknown arch ${1} (x64 | arm64)" >&2
    exit 1
    ;;
esac
URL="https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${PLAT}/chrome-headless-shell-${PLAT}.zip"
# Pinned by index digest (multi-arch), as measured on 2026-11-25; bump the digests to re-measure newer point releases.
DISTROS=(
  debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e
  ubuntu:22.04@sha256:b000e69a50ff940390233025e7a337fb8469b509e2334fa4d018ac30f3e18cdb
  ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
)

command -v docker >/dev/null 2>&1 || { echo "browser-linux-libs: docker is required" >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "browser-linux-libs: unzip is required" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ocw-browser-libs.XXXXXX")"
NAMES=()
cleanup() {
  local n
  for n in "${NAMES[@]+"${NAMES[@]}"}"; do docker rm -f "$n" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== chrome-headless-shell ${VERSION} ${PLAT}"
curl -fsSL --retry 3 -o "$WORK/shell.zip" "$URL"
# A checksum file, not stdin: macOS's BSD sha256sum only checks files named on its command line.
echo "${SHA256}  shell.zip" >"$WORK/shell.zip.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$WORK" && sha256sum -c shell.zip.sha256 >/dev/null)
else
  (cd "$WORK" && shasum -a 256 -c shell.zip.sha256 >/dev/null)
fi
echo "sha256 ok"
unzip -q "$WORK/shell.zip" -d "$WORK/cft"
rm -f "$WORK/shell.zip"

# Runs inside each distribution container (bash is in all three images). Mapping: soname -> the brw Dockerfile's
# Debian package name (plus libexpat1 / libudev1, present in the slim images but not guaranteed elsewhere).
cat >"$WORK/inner.sh" <<'INNER'
set -euo pipefail
SHELL_BIN="/cft/chrome-headless-shell-$PLAT/chrome-headless-shell"
missing() { ldd "$SHELL_BIN" 2>/dev/null | awk '/not found/ {print $1}' | sort -u; }
pkg_of() {
  case "$1" in
    libasound.so.*) echo libasound2 ;;
    libatk-bridge-2.0.so.*) echo libatk-bridge2.0-0 ;;
    libatk-1.0.so.*) echo libatk1.0-0 ;;
    libatspi.so.*) echo libatspi2.0-0 ;;
    libcairo.so.*) echo libcairo2 ;;
    libcups.so.*) echo libcups2 ;;
    libdbus-1.so.*) echo libdbus-1-3 ;;
    libdrm.so.*) echo libdrm2 ;;
    libgbm.so.*) echo libgbm1 ;;
    libglib-2.0.so.* | libgobject-2.0.so.* | libgio-2.0.so.* | libgmodule-2.0.so.*) echo libglib2.0-0 ;;
    libnspr4.so | libplc4.so | libplds4.so) echo libnspr4 ;;
    libnss3.so | libnssutil3.so | libsmime3.so | libssl3.so) echo libnss3 ;;
    libpango-1.0.so.*) echo libpango-1.0-0 ;;
    libX11.so.*) echo libx11-6 ;;
    libxcb.so.*) echo libxcb1 ;;
    libXcomposite.so.*) echo libxcomposite1 ;;
    libXdamage.so.*) echo libxdamage1 ;;
    libXext.so.*) echo libxext6 ;;
    libXfixes.so.*) echo libxfixes3 ;;
    libxkbcommon.so.*) echo libxkbcommon0 ;;
    libXrandr.so.*) echo libxrandr2 ;;
    libexpat.so.*) echo libexpat1 ;;
    libudev.so.*) echo libudev1 ;;
    *) echo "UNMAPPED:$1" ;;
  esac
}
export DEBIAN_FRONTEND=noninteractive DEBCONF_NOWARNINGS=yes
apt-get update -qq >/dev/null
# The real package for a Debian name on this distribution: the name itself, else its t64 rename.
resolve() {
  if [ -n "$(apt-cache madison "$1" 2>/dev/null)" ]; then echo "$1"; return; fi
  if [ -n "$(apt-cache madison "${1}t64" 2>/dev/null)" ]; then echo "${1}t64"; return; fi
  echo "UNRESOLVED:$1"
}
before="$(missing)"
pkgs=""
for so in $before; do
  base="$(pkg_of "$so")"
  case "$base" in UNMAPPED:*) pkgs="$pkgs $base"; continue ;; esac
  pkgs="$pkgs $(resolve "$base")"
done
pkgs="$(echo $pkgs | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ $//')"
echo "$DISTRO: missing sonames: $(echo $before | wc -w | tr -d ' ')"
echo "$DISTRO: apt-get install -y $pkgs"
case "$pkgs" in *UNMAPPED:* | *UNRESOLVED:*) echo "$DISTRO: NOT verified (unmapped or unresolved names)"; exit 0 ;; esac
if [ -n "$pkgs" ]; then apt-get install -y -qq --no-install-recommends $pkgs >/dev/null; fi
after="$(missing)"
if [ -z "$after" ]; then
  echo "$DISTRO: verified, 0 missing after install"
else
  echo "$DISTRO: still missing after install: $(echo $after)"
fi
INNER

for image in "${DISTROS[@]}"; do
  distro="${image%@*}"
  name="ocw-browser-libs-$$-${distro//[:.]/-}"
  NAMES+=("$name")
  docker run --rm --name "$name" --platform "$DOCKER_PLATFORM" -e "PLAT=$PLAT" -e "DISTRO=$distro" \
    -v "$WORK/cft:/cft:ro" -v "$WORK/inner.sh:/probe/inner.sh:ro" "$image" bash /probe/inner.sh
done
