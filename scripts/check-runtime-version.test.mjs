// node --test scripts/check-runtime-version.test.mjs
// The release tag and the Local Runtime's package version agree (ADR-0040 § 13, 07.17.1 D-10, PD-21). Every case runs
// the script against a temporary package.json passed with --package; the real apps/local-runtime/package.json is only
// read, never written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "check-runtime-version.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "ocw-runtime-version-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function packageAt(version, name = "package.json") {
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify({ name: "@ocw/local-runtime", version }, null, 2)}\n`);
  return file;
}

function check(...args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("check-runtime-version", () => {
  const pkg = packageAt("0.3.1");

  it("accepts a tag equal to the runtime's version", () => {
    const res = check("v0.3.1", "--package", pkg);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ocw-runtime 0\.3\.1 matches v0\.3\.1/);
  });

  it("refuses a tag whose version differs, naming both versions and the file to change", () => {
    const res = check("v0.3.2", "--package", pkg);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /0\.3\.1/);
    assert.match(res.stderr, /0\.3\.2/);
    assert.match(res.stderr, /apps\/local-runtime\/package\.json/);
  });

  it("ignores a pre-release suffix", () => {
    const res = check("v0.3.1-rc.1", "--package", pkg);
    assert.equal(res.status, 0, res.stderr);
  });

  it("accepts the option before the tag", () => {
    assert.equal(check("--package", pkg, "v0.3.1").status, 0);
  });

  for (const tag of ["0.3.1", "vX", "v0.3", "v0.3.1.4", ""]) {
    it(`refuses ${JSON.stringify(tag)} as not a release tag (exit 2)`, () => {
      const res = check(tag, "--package", pkg);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /not a release tag/);
    });
  }

  it("exits 2 without a tag", () => {
    const res = check("--package", pkg);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /not a release tag/);
  });

  it("exits 2 when the package has no version", () => {
    const file = path.join(dir, "no-version.json");
    writeFileSync(file, "{}\n");
    const res = check("v0.3.1", "--package", file);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no version/);
  });

  it("exits 2 when the package file is missing", () => {
    const res = check("v0.3.1", "--package", path.join(dir, "missing.json"));
    assert.equal(res.status, 2);
  });

  it("defaults to apps/local-runtime/package.json, which carries the release version (D-10)", () => {
    const real = JSON.parse(readFileSync(path.join(ROOT, "apps", "local-runtime", "package.json"), "utf8"));
    assert.match(real.version, /^\d+\.\d+\.\d+$/);
    const res = check(`v${real.version}`);
    assert.equal(res.status, 0, res.stderr);
  });
});
