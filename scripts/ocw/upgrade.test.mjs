// node --test scripts/ocw/upgrade.test.mjs
//
// `ocw upgrade` against real git repositories in temp dirs: a local "origin" with release tags and an install cloned
// from it the way scripts/install.sh does (shallow). Backup, setup and docker compose are injected fakes that record
// the order. Proves the release choice (newest stable, never a pre-release by default), the refusals before any change
// (no --yes, local edits, a downgrade, a release older than an install from main, the demo), and the rollback hint.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { compareReleases, main, stableReleases } from "./upgrade.mjs";

const tmp = mkdtempSync(path.join(tmpdir(), "ocw-upgrade-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function git(cwd, args, env = {}) {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** origin with commits tagged as given (one commit per tag, a minute apart), then `main` one minute later. */
function makeOrigin(tags) {
  const dir = path.join(tmp, `origin-${++n}`);
  const src = `${dir}-src`;
  git(tmp, ["init", "--quiet", "--initial-branch", "main", src]);
  let t = 1_700_000_000;
  const commit = (label) => {
    writeFileSync(path.join(src, "compose.yaml"), `# ${label}\n`);
    git(src, ["add", "."]);
    t += 60;
    const date = `@${t} +0000`;
    git(src, ["commit", "--quiet", "-m", label], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
  };
  for (const tag of tags) {
    commit(tag);
    git(src, ["tag", tag]);
  }
  commit("main");
  git(tmp, ["clone", "--quiet", "--bare", src, dir]);
  git(dir, ["config", "uploadpack.allowFilter", "true"]); // GitHub serves partial clones
  return { url: `file://${dir}`, src };
}

/** An install as scripts/install.sh clones it: shallow, blobless and sparse (no .planning/), at `ref`. */
function install(origin, ref) {
  const dir = path.join(tmp, `install-${++n}`);
  git(tmp, [
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--branch",
    ref,
    "--filter=blob:none",
    "--sparse",
    origin.url,
    dir,
  ]);
  git(dir, ["sparse-checkout", "set", "--no-cone", "/*", "!/.planning/"]);
  return dir;
}

let calls;
let lines;
let envFile;
beforeEach(() => {
  calls = [];
  lines = [];
  envFile = path.join(tmp, `env-${++n}`);
  writeFileSync(envFile, "COMPOSE_PROJECT_NAME=ocw-test-upgrade\nOCW_IMAGE_TAG=local\n", { mode: 0o600 });
});

const record = (call) => {
  calls.push(call);
  return 0;
};
const fakes = (projectDir, over = {}) => ({
  projectDir,
  log: (l) => lines.push(l),
  isTTY: false,
  now: new Date("2026-11-05T10:00:00Z"),
  backup: async (argv) => record(["backup", ...argv]),
  setup: (argv) => record(["setup", ...argv]),
  compose: (_file, args) => record(["compose", ...args]),
  ...over,
});
const headOf = (dir) => git(dir, ["describe", "--tags", "--always"]);
const run = (dir, argv, over) => main(["--env-file", envFile, ...argv], fakes(dir, over));

describe("release tags", () => {
  it("orders by semver, newest first, and leaves out pre-releases and other names", () => {
    const out = ["v0.9.0", "v0.10.0", "v0.10.0-rc.1", "v1.0", "latest", "v0.2.1"]
      .map((t) => `abc\trefs/tags/${t}`)
      .join("\n");
    assert.deepEqual(stableReleases(out), ["v0.10.0", "v0.9.0", "v0.2.1"]);
    assert.ok(compareReleases("v0.10.0-rc.1", "v0.10.0") < 0);
  });
});

describe("ocw upgrade", () => {
  it("--check names the current and the newest release and changes nothing", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0"]), "v0.1.0");
    assert.equal(await run(dir, ["--check"]), 0);
    assert.match(lines.join("\n"), /Current: v0\.1\.0\nNewest release: v0\.2\.0\nUpgrade with: ocw upgrade/);
    assert.deepEqual(calls, []);
    assert.equal(headOf(dir), "v0.1.0");
  });

  it("goes to the newest stable release: backup, checkout, image tag, setup, then compose up --build --wait", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0", "v0.3.0-rc.1"]), "v0.1.0");
    assert.equal(await run(dir, ["--yes"]), 0);
    assert.equal(headOf(dir), "v0.2.0");
    const backupDir = path.join(dir, "backups", "pre-v0.2.0-20261105T100000Z");
    assert.deepEqual(calls, [
      ["backup", "--consistent", "--out", backupDir, "--env-file", envFile],
      ["setup", "setup", "--add-missing", "--env-file", envFile],
      ["compose", "up", "-d", "--build", "--wait"],
    ]);
    assert.match(readFileSync(envFile, "utf8"), /^OCW_IMAGE_TAG=v0\.2\.0$/m);
    assert.match(readFileSync(envFile, "utf8"), /^COMPOSE_PROJECT_NAME=ocw-test-upgrade$/m);
  });

  it("does nothing on the newest release", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0"]), "v0.2.0");
    assert.equal(await run(dir, ["--yes"]), 0);
    assert.match(lines.join("\n"), /Already on v0\.2\.0/);
    assert.deepEqual(calls, []);
  });

  it("refuses to go backwards, before any backup", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0"]), "v0.2.0");
    await assert.rejects(
      run(dir, ["--yes", "--to", "v0.1.0"]),
      /older than v0\.2\.0: migrations only move forward/,
    );
    assert.deepEqual(calls, []);
    assert.equal(headOf(dir), "v0.2.0");
  });

  it("without --yes and without a terminal, changes nothing", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0"]), "v0.1.0");
    await assert.rejects(run(dir, []), /re-run with --yes/);
    assert.deepEqual(calls, []);
    assert.equal(headOf(dir), "v0.1.0");
  });

  it("asks on a terminal, and a no changes nothing", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0"]), "v0.1.0");
    assert.equal(await run(dir, [], { isTTY: true, confirm: async () => false }), 1);
    assert.deepEqual(calls, []);
  });

  it("refuses an install with edited tracked files", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0"]), "v0.1.0");
    writeFileSync(path.join(dir, "compose.yaml"), "# edited\n");
    await assert.rejects(run(dir, ["--yes"]), /tracked files were changed/);
    assert.deepEqual(calls, []);
  });

  it("an install from main moves to a newer release, never to one made before it", async () => {
    const origin = makeOrigin(["v0.1.0"]);
    const dir = install(origin, "main");
    await assert.rejects(run(dir, ["--yes"]), /v0\.1\.0 predates this install \(main@/);
    assert.deepEqual(calls, []);

    writeFileSync(path.join(origin.src, "compose.yaml"), "# v0.2.0\n");
    git(origin.src, ["commit", "--quiet", "-am", "v0.2.0"], { GIT_COMMITTER_DATE: "@1800000000 +0000" });
    git(origin.src, ["tag", "v0.2.0"]);
    git(origin.src, ["push", "--quiet", "--tags", origin.url.replace("file://", ""), "main"]);
    assert.equal(await run(dir, ["--yes"]), 0);
    assert.equal(headOf(dir), "v0.2.0");
  });

  it("a failed start prints how to go back: the previous commit, image tag and the backup", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0"]), "v0.1.0");
    const before = git(dir, ["rev-parse", "HEAD"]).slice(0, 12);
    assert.equal(await run(dir, ["--yes"], { compose: () => 1 }), 1);
    const out = lines.join("\n");
    assert.match(out, /docker compose up failed/);
    assert.ok(out.includes(`checkout ${before}`), out);
    assert.match(out, /set OCW_IMAGE_TAG=local/);
    assert.match(out, /restore ".*pre-v0\.2\.0-20261105T100000Z" --yes/);
  });

  it("a failed backup stops before the checkout", async () => {
    const dir = install(makeOrigin(["v0.1.0", "v0.2.0"]), "v0.1.0");
    await assert.rejects(run(dir, ["--yes"], { backup: async () => 1 }), /the backup failed/);
    assert.equal(headOf(dir), "v0.1.0");
  });

  it("refuses an unknown --to, a malformed one and the demo's project", async () => {
    const dir = install(makeOrigin(["v0.1.0"]), "v0.1.0");
    await assert.rejects(run(dir, ["--yes", "--to", "v9.9.9"]), /v9\.9\.9 is not a tag on origin/);
    await assert.rejects(run(dir, ["--to", "main"]), /--to takes a release tag/);
    writeFileSync(envFile, "COMPOSE_PROJECT_NAME=t3code-81d72154\n", { mode: 0o600 });
    await assert.rejects(run(dir, ["--yes"]));
    assert.deepEqual(calls, []);
  });
});
