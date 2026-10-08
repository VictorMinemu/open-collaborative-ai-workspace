#!/bin/sh
# Builds the CI step image (ocw-ci:local) inside the Woodpecker dind daemon with the repo's exact pins.
# Layer cache makes this a no-op when nothing changed. Usage (repo root): sh infra/ci/build-image.sh
set -eu
node_version="$(tr -d ' \n\r' < .nvmrc)"
pnpm_version="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
playwright_version="$(sed -n 's/.*"@playwright\/test": *"\([^"]*\)".*/\1/p' package.json)"
[ -n "$node_version" ] && [ -n "$pnpm_version" ] && [ -n "$playwright_version" ] || {
  echo "could not read the pins (node=$node_version pnpm=$pnpm_version playwright=$playwright_version)" >&2
  exit 1
}
echo "ocw-ci:local node $node_version, pnpm $pnpm_version, playwright $playwright_version"
docker build -q \
  --build-arg "NODE_VERSION=$node_version" \
  --build-arg "PNPM_VERSION=$pnpm_version" \
  --build-arg "PLAYWRIGHT_VERSION=$playwright_version" \
  -t ocw-ci:local infra/ci
