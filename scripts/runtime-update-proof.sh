#!/usr/bin/env bash
# Phase 07.11-09 (RTU-07, D-08, D-09): the headless Linux proof of runtime CLI auto-updates. Opt-in, never part of
# `pnpm verify`; needs Docker:
#
#   bash scripts/runtime-update-proof.sh
#
# It copies this tree's files (git ls-files: tracked plus untracked-but-not-ignored minus anything shaped like a
# credential, so no node_modules, no .env, no keys and no
# build output) into a throwaway, pinned Node 24 container (`docker run --rm --init`), installs the local-runtime's
# dependencies there with the frozen lockfile (`pnpm install --filter @ocw/local-runtime... --filter ocw`), builds a
# ROOT-OWNED npm prefix with the fake CLI (`install-fake claude-npm`, as root), then runs the maintenance tests as the
# image's non-root user `node` with OCW_RUNTIME_PROOF=1, which turns on apps/local-runtime/src/maintenance/
# linux-proof.test.ts:
#   - the root-owned npm install is `needs_admin` (shown with sudo, never run, Update now refused),
#   - a native fake Claude Code in a scratch HOME updates only once its busy session is idle; Codex is untouched; the
#     lock directory is 0700,
#   - an update past its timeout fails and its whole process group is killed,
#   - no status, run frame or output carries a host path.
# Every CLI is a copy of the fake and the npm registry is a 127.0.0.1 stub inside the container (PD-19): nothing runs a
# real `claude update`, `codex update`, npm or brew, on this machine or in the container. The host's node_modules and
# home are never mounted. The container and the temp directory are removed on exit. On success its last line is the
# proof's ok line; otherwise it exits non-zero.
#   PROOF_KEEP_LOG=1   keep the container's log in the temp directory (printed path) instead of removing it
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The same pinned image scripts/e2e-isolated.sh uses (Node 24.22.1, Debian bookworm, user `node` uid 1000).
IMAGE="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"
NAME="ocw-runtime-update-proof-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ocw-runtime-update-proof.XXXXXX")"

fail() { echo "runtime-update-proof: $*" >&2; exit 1; }
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ "${PROOF_KEEP_LOG:-}" == "1" && -f "$WORK/proof.log" ]]; then
    rm -f "$WORK/src.tar"
    echo "runtime-update-proof: log kept in $WORK/proof.log"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

command -v docker >/dev/null || fail "docker is required"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable"
command -v git >/dev/null || fail "git is required"

# ---------------------------------------------------------------- the tree (no node_modules, no .env, no builds)
# Tracked files, plus untracked-but-not-ignored ones except anything shaped like a credential (07.11 review LO-07: a
# scratch `.env.local`, key or certificate never leaves this machine, even into a throwaway container).
tree_files() {
  git ls-files -z --cached
  git ls-files -z --others --exclude-standard |
    while IFS= read -r -d '' f; do
      case "/$f" in
        */.env* | *.env | *.pem | *.key | *.p12 | *.pfx | */id_rsa* | */id_ed25519* | */id_ecdsa*) continue ;;
      esac
      printf '%s\0' "$f"
    done
}
tree_files |
  while IFS= read -r -d '' f; do [[ -f "$f" || -L "$f" ]] && printf '%s\0' "$f"; done |
  COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -cf "$WORK/src.tar"   # no macOS ._* or xattr records

# ---------------------------------------------------------------- inside the container
# Root: unpack, enable corepack (pnpm from packageManager), build the root-owned npm prefix with the fake CLI.
# User node: install with the frozen lockfile, run the maintenance suite with the proof switched on, and require the
# proof file to have run (not skipped) with every case passing.
INNER='
set -euo pipefail
mkdir -p /work
tar --warning=no-unknown-keyword -xf /src.tar -C /work
chown -R node:node /work
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
node /work/apps/local-runtime/src/maintenance/fake-cli/fake-cli.mjs install-fake claude-npm /opt/ocw-proof-prefix 2.1.290
chmod -R go-w /opt/ocw-proof-prefix
echo "runtime-update-proof: root-owned prefix ready ($(stat -c %U /opt/ocw-proof-prefix/lib/node_modules))"
su node -s /bin/bash -c "
  set -euo pipefail
  export PATH=/usr/local/bin:/usr/bin:/bin COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
  cd /work
  echo \"runtime-update-proof: running as \$(id -un) (uid \$(id -u))\"
  pnpm install --frozen-lockfile --filter \"@ocw/local-runtime...\" --filter ocw
  OCW_RUNTIME_PROOF=1 OCW_PROOF_ROOT_PREFIX=/opt/ocw-proof-prefix \
    pnpm exec vitest run --project unit apps/local-runtime/src/maintenance \
      --reporter=default --reporter=json --outputFile.json=/tmp/vitest-proof.json
  node -e \"
    const r = JSON.parse(require(\\\"fs\\\").readFileSync(\\\"/tmp/vitest-proof.json\\\", \\\"utf8\\\"));
    const f = r.testResults.find((t) => t.name.endsWith(\\\"maintenance/linux-proof.test.ts\\\"));
    if (!f) { console.error(\\\"runtime-update-proof: linux-proof.test.ts did not run\\\"); process.exit(1); }
    const by = (s) => f.assertionResults.filter((a) => a.status === s).length;
    console.log(\\\"runtime-update-proof: linux-proof.test.ts passed \\\" + by(\\\"passed\\\") + \\\", failed \\\" + by(\\\"failed\\\") + \\\", skipped \\\" + (by(\\\"skipped\\\") + by(\\\"pending\\\")));
    for (const a of f.assertionResults) console.log(\\\"  \\\" + a.status + \\\"  \\\" + a.title);
    if (by(\\\"passed\\\") < 4 || by(\\\"failed\\\") > 0 || r.numFailedTests > 0) process.exit(1);
  \"
"
'

set +e
docker run --rm --init --name "$NAME" \
  -v "$WORK/src.tar:/src.tar:ro" \
  "$IMAGE" bash -c "$INNER" 2>&1 | tee "$WORK/proof.log"
status="${PIPESTATUS[0]}"
set -e
[[ "$status" == "0" ]] || fail "the proof failed (exit $status)"
echo "runtime-update proof: ok"
