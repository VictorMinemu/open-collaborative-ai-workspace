#!/usr/bin/env node
// node scripts/release-tag.mjs dispatch <tag>
// node scripts/release-tag.mjs latest <tag> <current-latest-tag | "">
// The release workflow's two tag decisions (review WR-06), in plain Node with no dependencies (the jobs run it on the
// runner's own node, before any install):
//   - `dispatch`: a workflow_dispatch rebuild only from v0.5.2 on (exit 0), else exit 1. An older tag's
//     electron-builder config has neither the release names nor the update manifests the later steps expect.
//   - `latest`: prints `true` when <tag> is a stable tag at least as new as the current latest release (or there is
//     none), else `false`. Rebuilding an older tag must never mark it "Latest" again: the GitHub update provider reads
//     /releases/latest, so every device would stop being offered the newer release.
// Exit 2: a usage error (an unknown command, or a value that is not a release tag).

// The release workflow's "Check the tag" regex.
const RELEASE_TAG = /^v([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.-]+)?$/;
const FIRST_DISPATCH = "v0.5.2";

function parse(tag) {
  const m = typeof tag === "string" ? RELEASE_TAG.exec(tag) : null;
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined };
}

/** Semver order: the numeric core, then a pre-release before its release. */
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (d !== 0) return d;
  }
  return Number(!a.pre) - Number(!b.pre);
}

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function main([command, tag, current]) {
  const parsed = parse(tag);
  if (command === "dispatch") {
    if (!parsed) return usage(`not a release tag: ${tag ?? ""} (expected vX.Y.Z or vX.Y.Z-suffix)`);
    const first = parse(FIRST_DISPATCH);
    if (first && compare(parsed, first) < 0) {
      process.stderr.write(
        `${tag} cannot be rebuilt: workflow_dispatch rebuilds only tags from ${FIRST_DISPATCH} on (an older tag has no release names or update manifests)\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === "latest") {
    if (!parsed) return usage(`not a release tag: ${tag ?? ""}`);
    let latest = null;
    if (current !== undefined && current !== "") {
      latest = parse(current);
      if (!latest) return usage(`not a release tag: ${current}`);
    }
    const mark = !parsed.pre && (latest === null || compare(parsed, latest) >= 0);
    process.stdout.write(`${mark}\n`);
    return;
  }
  usage("usage: release-tag.mjs dispatch <tag> | latest <tag> <current-latest-tag>");
}

main(process.argv.slice(2));
