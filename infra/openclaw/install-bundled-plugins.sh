#!/usr/bin/env bash
# Installs the pinned official OpenClaw search plugins (bundled-plugins.json) into <dest>/<id>.
# Used by the cell Dockerfile (build stage) and by the container smoke (host temp dir, bind-mounted).
#
#   infra/openclaw/install-bundled-plugins.sh <dest> [bundled-plugins.json]
#
# Supply chain (T-03.1-SC): exact versions only, the tarball's sha512 must equal the pinned npm
# `dist.integrity` (abort on mismatch), no lifecycle scripts, never npx, never a range. The result is
# made world-readable; the Dockerfile copies it root-owned (read-only for the gateway user).
set -euo pipefail

DEST="${1:?usage: install-bundled-plugins.sh <dest> [bundled-plugins.json]}"
PINS="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bundled-plugins.json}"
[[ -f "$PINS" ]] || { echo "install-bundled-plugins: pins file not found: $PINS" >&2; exit 1; }
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# One TSV line per pin: id, package, version, integrity (validated: exact semver, sha512 SRI).
node -e '
const pins = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const p of pins) {
  if (!/^[a-z0-9-]+$/.test(p.id)) throw new Error(`bad id ${p.id}`);
  if (!/^@openclaw\/[a-z0-9-]+$/.test(p.package)) throw new Error(`bad package ${p.package}`);
  if (!/^\d+\.\d+\.\d+$/.test(p.version)) throw new Error(`${p.package}: version must be exact, got ${p.version}`);
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(p.integrity)) throw new Error(`${p.package}: integrity must be sha512`);
  console.log([p.id, p.package, p.version, p.integrity].join("\t"));
}' "$PINS" >"$WORK/pins.tsv"

while IFS=$'\t' read -r id package version integrity; do
  echo "install-bundled-plugins: ${package}@${version} -> ${DEST}/${id}"
  mkdir -p "$WORK/$id"
  tarball="$(cd "$WORK/$id" && npm pack "${package}@${version}" --silent --ignore-scripts --no-audit --no-fund | tail -n 1)"
  # node, not openssl: the slim build image has no openssl binary.
  actual="$(node -e 'const c=require("crypto"),f=require("fs"); console.log("sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64"))' "$WORK/$id/$tarball")"
  if [[ "$actual" != "$integrity" ]]; then
    echo "install-bundled-plugins: INTEGRITY MISMATCH for ${package}@${version}" >&2
    echo "  expected $integrity" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
  rm -rf "${DEST:?}/${id}"
  mkdir -p "$DEST/$id"
  tar -xzf "$WORK/$id/$tarball" -C "$DEST/$id" --strip-components=1 --no-same-owner
  [[ -f "$DEST/$id/openclaw.plugin.json" ]] || { echo "install-bundled-plugins: $package has no openclaw.plugin.json" >&2; exit 1; }
  # Runtime dependencies only when the package declares any (peers such as `openclaw` come from the host).
  if node -e 'const p=require(process.argv[1]); process.exit(Object.keys(p.dependencies||{}).length?0:1)' "$DEST/$id/package.json"; then
    (cd "$DEST/$id" && npm install --omit=dev --omit=peer --ignore-scripts --no-package-lock --no-audit --no-fund)
  fi
done <"$WORK/pins.tsv"

chmod -R a+rX "$DEST"
echo "install-bundled-plugins: done"
