#!/usr/bin/env node
// node scripts/check-runtime-version.mjs <tag> [--package <file>]
// The Local Runtime's version follows the release (ADR-0040 § 13, 07.17.1 D-10, PD-21): a vX.Y.Z tag must equal the
// `version` of apps/local-runtime/package.json, ignoring a pre-release suffix (v0.3.1-rc.1 → 0.3.1). The release
// workflow's `prepare` job runs this before it drafts a release, so a served bundle's manifest always names the release
// it came from. Plain Node, no dependencies: the job runs it on the runner's own node, before any install.
// Exit 0: they match. Exit 1: they differ. Exit 2: not a release tag, or the package file is unreadable.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_PACKAGE = "apps/local-runtime/package.json";
// The release workflow's "Check the tag" regex.
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function main(argv) {
  let tag;
  let packageFile = path.join(ROOT, DEFAULT_PACKAGE);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package") {
      const value = argv[++i];
      if (!value) return fail(2, "--package needs a file");
      packageFile = path.resolve(value);
    } else if (tag === undefined) {
      tag = arg;
    } else {
      return fail(2, `unexpected argument: ${arg}`);
    }
  }

  if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) {
    return fail(2, `not a release tag: ${tag ?? ""} (expected vX.Y.Z or vX.Y.Z-suffix)`);
  }
  const release = tag.slice(1).split("-")[0];

  let version;
  try {
    version = JSON.parse(readFileSync(packageFile, "utf8")).version;
  } catch (err) {
    return fail(2, `cannot read ${DEFAULT_PACKAGE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof version !== "string" || version === "") {
    return fail(2, `${DEFAULT_PACKAGE} has no version`);
  }

  if (version !== release) {
    return fail(
      1,
      `ocw-runtime ${version} does not match ${tag} (release ${release}): set "version": "${release}" in ${DEFAULT_PACKAGE} before tagging (ADR-0040, D-10)`,
    );
  }
  process.stdout.write(`ocw-runtime ${version} matches ${tag}\n`);
}

main(process.argv.slice(2));
