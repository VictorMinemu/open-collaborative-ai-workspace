// node --test scripts/release-tag.test.mjs
// Review WR-06: the release workflow's two tag decisions. A workflow_dispatch rebuild is refused for a tag before
// v0.5.2 (its electron-builder config has neither the release names nor the update manifests), and a release is
// marked "Latest" only when it is a stable tag at least as new as the current latest release, so rebuilding an older
// tag never turns every device's /releases/latest back to it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "release-tag.mjs");

function run(...args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr };
}

describe("release-tag dispatch", () => {
  for (const tag of ["v0.5.2", "v0.5.3", "v0.6.0", "v1.0.0", "v0.5.10", "v0.5.3-rc.1"]) {
    it(`allows a rebuild of ${tag}`, () => {
      const res = run("dispatch", tag);
      assert.equal(res.status, 0, res.stderr);
    });
  }

  for (const tag of ["v0.5.1", "v0.5.0", "v0.4.9", "v0.5.2-rc.1", "v0.1.0"]) {
    it(`refuses a rebuild of ${tag}, saying why`, () => {
      const res = run("dispatch", tag);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /v0\.5\.2/);
    });
  }

  for (const bad of ["0.5.2", "v0.5", "main", "v0.5.2;rm", ""]) {
    it(`refuses a non-tag ${JSON.stringify(bad)} as a usage error`, () => {
      assert.equal(run("dispatch", bad).status, 2);
    });
  }
});

describe("release-tag latest", () => {
  const cases = [
    ["v0.5.3", "v0.5.2", "true"],
    ["v0.5.3", "v0.5.3", "true"],
    ["v0.5.10", "v0.5.9", "true"],
    ["v0.5.2", "", "true"],
    ["v0.5.2", "v0.5.3", "false"],
    ["v0.5.9", "v0.5.10", "false"],
    ["v0.5.4-rc.1", "v0.5.3", "false"],
    ["v1.0.0", "v0.9.9", "true"],
  ];
  for (const [tag, latest, want] of cases) {
    it(`${tag} over latest ${JSON.stringify(latest)} → ${want}`, () => {
      const res = run("latest", tag, latest);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, want);
    });
  }

  it("treats an unreadable current latest as none only when it is empty; anything else is a usage error", () => {
    assert.equal(run("latest", "v0.5.3", "garbage").status, 2);
    assert.equal(run("latest", "nope", "v0.5.3").status, 2);
  });

  it("refuses an unknown command", () => {
    assert.equal(run("publish", "v0.5.3").status, 2);
  });
});
