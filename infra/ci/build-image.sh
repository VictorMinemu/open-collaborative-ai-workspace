#!/bin/sh
# Builds the CI step image inside the Woodpecker dind daemon with the repo's exact pins.
# Usage (repo root): sh infra/ci/build-image.sh ocw-ci:<commit sha>
# Every workflow tags the image with its pipeline's commit (`image: ocw-ci:${CI_COMMIT_SHA}` in .woodpecker/*.yaml), so
# workflows of different pipelines running at once never move a tag another one's next step runs: a pull request that
# changes the pins gets its own image while another pull request keeps its own. Workflows of one pipeline build the same
# content, which the layer cache resolves to the same image id (re-tagging it changes nothing). Tagging is atomic in
# Docker. infra/ci/disk-budget.sh drops the tags of other commits once no other workflow is running.
set -eu
tag="${1:?usage: sh infra/ci/build-image.sh ocw-ci:<tag>}"
case "$tag" in
  ocw-ci:?*) ;;
  *)
    echo "build-image: the tag must be ocw-ci:<tag> (got $tag)" >&2
    exit 2
    ;;
esac
node_version="$(tr -d ' \n\r' < .nvmrc)"
pnpm_version="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
playwright_version="$(sed -n 's/.*"@playwright\/test": *"\([^"]*\)".*/\1/p' package.json)"
[ -n "$node_version" ] && [ -n "$pnpm_version" ] && [ -n "$playwright_version" ] || {
  echo "could not read the pins (node=$node_version pnpm=$pnpm_version playwright=$playwright_version)" >&2
  exit 1
}
echo "$tag: node $node_version, pnpm $pnpm_version, playwright $playwright_version"
docker build -q \
  --build-arg "NODE_VERSION=$node_version" \
  --build-arg "PNPM_VERSION=$pnpm_version" \
  --build-arg "PLAYWRIGHT_VERSION=$playwright_version" \
  -t "$tag" infra/ci
