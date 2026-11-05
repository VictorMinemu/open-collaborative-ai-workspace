#!/usr/bin/env node
// Upgrade this install to a release: backup, the release's code, new keys, new images, schema migration.
//   pnpm ocw upgrade [--to vX.Y.Z] [--yes] [--check] [--env-file F | --dir D]
//   --to vX.Y.Z   the release to install (default: the newest vX.Y.Z tag on origin; pre-releases only by name)
//   --check       print the current and the newest release, change nothing
//   --yes         do not ask (required when stdin is not a terminal)
// Steps: fetch the tag → `ocw backup --consistent` into backups/pre-<tag>-<time> → `git checkout <tag>` →
// OCW_IMAGE_TAG=<tag> (the previous images stay for a rollback) → `ocw setup --add-missing` → `docker compose up -d
// --build --wait` (the one-shot migrate service upgrades the schema). Never moves backwards: a rollback is a restore.
// docs/self-hosting/backup-restore.md
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { main as backupMain } from "./backup.mjs";
import {
  composeArgs,
  parseArgs,
  REPO_ROOT,
  readEnv,
  resolveEnvFile,
  setKeys,
  usageError,
} from "./env-file.mjs";

const SPEC = { boolean: ["yes", "check", "help"], string: ["to", "env-file", "dir"] };
const RELEASE = /^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const STABLE = /^v\d+\.\d+\.\d+$/;

/** [major, minor, patch, prerelease|null] of a release tag, or null when the name is not one. */
export function parseRelease(tag) {
  const m = RELEASE.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].slice(1) : null] : null;
}

/** Semver order of two release tags (a pre-release sorts before its release). */
export function compareReleases(a, b) {
  const x = parseRelease(a);
  const y = parseRelease(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1;
  if (y[3] === null) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/** Stable release tags from `git ls-remote --tags --refs` output, newest first. */
export function stableReleases(lsRemote) {
  const tags = lsRemote
    .split("\n")
    .map((l) => l.split("\t")[1]?.replace(/^refs\/tags\//, ""))
    .filter((t) => t && STABLE.test(t));
  return [...new Set(tags)].sort((a, b) => compareReleases(b, a));
}

function gitRunner(projectDir) {
  return (args) => {
    const r = spawnSync("git", ["-C", projectDir, ...args], { encoding: "utf8" });
    return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
  };
}

function timestamp(d) {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

async function askTerminal(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const { opts, positionals } = parseArgs(argv, SPEC);
  if (opts.help) {
    log(
      readFileSync(new URL(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 9)
        .join("\n")
        .replace(/^\/\/ ?/gm, ""),
    );
    return 0;
  }
  if (positionals.length > 0) throw usageError(`Unexpected argument ${positionals[0]}; did you mean --to?`);
  if (opts.to !== undefined && !parseRelease(opts.to))
    throw usageError("--to takes a release tag such as v0.2.0");

  const projectDir = deps.projectDir ?? REPO_ROOT;
  const envFile = resolveEnvFile(opts);
  const envArgs = opts["env-file"] ? ["--env-file", envFile] : opts.dir ? ["--dir", opts.dir] : [];
  composeArgs(envFile, { projectDir }); // refuses the demo and a missing env file before anything else
  const git = deps.git ?? gitRunner(projectDir);

  // Where this install is now.
  if (git(["rev-parse", "--is-inside-work-tree"]).stdout !== "true") {
    throw new Error(
      `${projectDir} is not a git checkout: upgrade by hand (docs/self-hosting/backup-restore.md)`,
    );
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).stdout;
  if (dirty) {
    throw new Error(
      `tracked files were changed in ${projectDir}; commit or revert them first (git status), nothing was changed`,
    );
  }
  const head = git(["rev-parse", "HEAD"]).stdout;
  const describe = git(["describe", "--tags", "--exact-match", "HEAD"]);
  const current = describe.status === 0 && parseRelease(describe.stdout) ? describe.stdout : null;
  const currentLabel =
    current ?? `${git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "HEAD"}@${head.slice(0, 7)}`;

  // The release to install.
  const remote = git(["ls-remote", "--tags", "--refs", "origin", "v*"]);
  if (remote.status !== 0)
    throw new Error(`cannot list the releases on origin: ${remote.stderr || "git ls-remote failed"}`);
  const releases = stableReleases(remote.stdout);
  const target = opts.to ?? releases[0];
  if (!target) {
    log(`No release is published yet. This install runs ${currentLabel}.`);
    return 0;
  }
  if (opts.to && !remote.stdout.split("\n").some((l) => l.endsWith(`refs/tags/${opts.to}`))) {
    throw usageError(`${opts.to} is not a tag on origin (newest release: ${releases[0] ?? "none"})`);
  }
  if (opts.check) {
    log(`Current: ${currentLabel}`);
    log(`Newest release: ${releases[0] ?? "none"}`);
    if (current && releases[0] && compareReleases(releases[0], current) > 0) log("Upgrade with: ocw upgrade");
    return 0;
  }
  if (current === target) {
    log(`Already on ${target}. Nothing to do.`);
    return 0;
  }
  if (current && compareReleases(target, current) < 0) {
    throw new Error(
      `${target} is older than ${current}: migrations only move forward. Roll back by restoring the backup taken ` +
        "before the upgrade (docs/self-hosting/backup-restore.md#upgrading)",
    );
  }

  const fetchArgs = ["fetch", "--quiet", "--no-tags"];
  if (git(["rev-parse", "--is-shallow-repository"]).stdout === "true") fetchArgs.push("--depth", "1");
  const fetched = git([...fetchArgs, "origin", `refs/tags/${target}:refs/tags/${target}`]);
  if (fetched.status !== 0) throw new Error(`cannot fetch ${target}: ${fetched.stderr}`);
  if (!current) {
    // Not on a release (an install from main): moving to a release made before this commit would go backwards.
    const headTime = Number(git(["log", "-1", "--format=%ct", "HEAD"]).stdout);
    const targetTime = Number(git(["log", "-1", "--format=%ct", `refs/tags/${target}^{commit}`]).stdout);
    if (targetTime < headTime) {
      throw new Error(
        `${target} predates this install (${currentLabel}): it is not an upgrade. Stay on this install until a newer ` +
          "release is published (ocw upgrade --check)",
      );
    }
  }

  const backupDir = path.join(projectDir, "backups", `pre-${target}-${timestamp(deps.now ?? new Date())}`);
  log(`Upgrade ${currentLabel} → ${target}`);
  log(`  1. backup (api, web and openclaw stop meanwhile) into ${backupDir}`);
  log(`  2. git checkout ${target}, images tagged ${target}, new keys added to the env file`);
  log(
    "  3. docker compose up -d --build --wait (the image build takes a while; migrate upgrades the schema)",
  );
  if (!opts.yes) {
    const tty = deps.isTTY ?? Boolean(process.stdin.isTTY);
    if (!tty) throw usageError("Nothing was changed; re-run with --yes to proceed.");
    if (!(await (deps.confirm ?? askTerminal)("Proceed? [y/N] "))) {
      log("Nothing was changed.");
      return 1;
    }
  }

  const backupStatus = await (deps.backup ?? backupMain)(["--consistent", "--out", backupDir, ...envArgs], {
    log,
  });
  if (backupStatus !== 0) throw new Error("the backup failed; nothing else was changed");

  const previousTag = readEnv(envFile).values.get("OCW_IMAGE_TAG") || "local";
  const rollback = [
    "To go back to where you were:",
    `  git -C ${JSON.stringify(projectDir)} checkout ${head.slice(0, 12)}`,
    `  set OCW_IMAGE_TAG=${previousTag} in ${envFile}, then: docker compose up -d --wait`,
    `  node scripts/ocw.mjs restore ${JSON.stringify(backupDir)} --yes`,
  ];
  const fail = (message) => {
    for (const line of [`ocw upgrade: ${message}`, ...rollback]) log(line);
    return 1;
  };

  const checkout = git(["-c", "advice.detachedHead=false", "checkout", "--quiet", target]);
  if (checkout.status !== 0) return fail(`git checkout ${target} failed: ${checkout.stderr}`);
  setKeys(envFile, { OCW_IMAGE_TAG: target });

  // The new release's own setup adds the keys it needs (never rotates one).
  const setup = (deps.setup ?? runNewOcw(projectDir))(["setup", "--add-missing", ...envArgs]);
  if (setup !== 0) return fail("ocw setup --add-missing failed");

  const up = (deps.compose ?? composeRunner(projectDir))(envFile, ["up", "-d", "--build", "--wait"]);
  if (up !== 0) return fail("docker compose up failed (docker compose logs migrate api)");

  log(`Upgraded to ${target}. Backup: ${backupDir}`);
  return 0;
}

/** Runs the checked-out release's `scripts/ocw.mjs` (not this process's code, which is the previous release). */
function runNewOcw(projectDir) {
  return (args) => {
    const r = spawnSync(process.execPath, ["--", path.join(projectDir, "scripts", "ocw.mjs"), ...args], {
      stdio: "inherit",
    });
    return r.status ?? 1;
  };
}

function composeRunner(projectDir) {
  return (envFile, args) => {
    const r = spawnSync("docker", ["compose", ...composeArgs(envFile, { projectDir }), ...args], {
      cwd: projectDir,
      stdio: "inherit",
    });
    return r.status ?? 1;
  };
}

export async function runMain(argv, deps = {}) {
  try {
    process.exitCode = await main(argv, deps);
  } catch (err) {
    console.error(`ocw upgrade: ${err.message}`);
    process.exitCode = err.usage ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(process.argv.slice(2));
}
