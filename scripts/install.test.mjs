// node --test 'scripts/**/*.test.mjs'
//
// The server installer (scripts/install.sh): it refuses unusable arguments before touching the host, and --dry-run
// prints the whole plan (clone, `ocw setup`, `ocw enable proxy`, `docker compose up`) without running any of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), "install.sh");
const run = (args) => spawnSync("bash", [INSTALL, ...args], { encoding: "utf8" });
const has = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const tmp = mkdtempSync(path.join(tmpdir(), "ocw-install-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("install.sh arguments", () => {
  it("--help prints the usage and exits 0", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: install\.sh --domain <host>/);
  });

  it("needs --domain unless --local", () => {
    const r = run([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--domain <host> is required/);
  });

  for (const bad of [
    "https://ocw.example.com",
    "ocw.example.com:8443",
    "ocw.example.com/x",
    "*.example.com",
    "a b",
  ]) {
    it(`refuses --domain ${JSON.stringify(bad)}`, () => {
      const r = run(["--domain", bad, "--dry-run"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /bare host name or IPv4 address/);
    });
  }

  it("refuses --local with --domain, an unknown --tls and a relative --dir", () => {
    assert.match(run(["--local", "--domain", "ocw.example.com"]).stderr, /exclude each other/);
    assert.match(run(["--domain", "ocw.example.com", "--tls", "acme"]).stderr, /--tls only takes 'internal'/);
    assert.match(run(["--local", "--dir", "relative/path"]).stderr, /--dir must be an absolute path/);
    assert.match(run(["--bogus"]).stderr, /unknown option: --bogus/);
  });
});

// The dry run reads the host (Docker, Node) but changes nothing; without Docker it can only plan on apt hosts.
const canPlan = has("docker", ["compose", "version"]) || has("apt-get", ["--version"]);

describe("install.sh --dry-run", { skip: canPlan ? false : "no Docker and no apt-get on this host" }, () => {
  it("plans clone, setup, the proxy and the build without running them", () => {
    const dir = path.join(tmp, "ocw");
    const r = run(["--dry-run", "--domain", "ocw.example.com", "--dir", dir, "--ref", "v1.2.3"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] git clone --quiet --depth 1 --branch v1\.2\.3 /);
    assert.match(r.stdout, /\[dry-run\] node -- .*\/ocw\/scripts\/ocw\.mjs setup\n/);
    assert.match(
      r.stdout,
      /\[dry-run\] node -- .*scripts\/ocw\.mjs enable proxy --site-address ocw\.example\.com --no-up/,
    );
    assert.match(r.stdout, /\[dry-run\] \(cd .*\/ocw && docker compose up -d --build --wait\)/);
    assert.match(r.stdout, /https:\/\/ocw\.example\.com\/setup/);
    assert.equal(existsSync(dir), false, "a dry run creates nothing");
  });

  it("an IPv4 address gets Caddy's internal CA and the root-certificate hint", () => {
    const r = run(["--dry-run", "--domain", "203.0.113.7", "--dir", path.join(tmp, "ip")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Caddy's internal CA/);
    assert.match(r.stdout, /root\.crt/);
  });

  it("a downloaded copy outside a checkout clones the repository into /opt/ocw", () => {
    const copy = path.join(tmp, "downloaded", "install.sh");
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(INSTALL, copy);
    const r = spawnSync("bash", [copy, "--dry-run", "--domain", "ocw.example.com"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /\[dry-run\] git clone --quiet --depth 1 --branch main --filter=blob:none --sparse https:\/\/github\.com\/VictorMinemu\/open-collaborative-ai-workspace\.git \/opt\/ocw/,
    );
    assert.match(
      r.stdout,
      /\[dry-run\] git -C \/opt\/ocw sparse-checkout set --no-cone \/\* !\/\.planning\//,
    );
    assert.doesNotMatch(r.stdout, /Using this checkout/);
  });

  it("--local skips the proxy and points at localhost", () => {
    const r = run(["--dry-run", "--local", "--dir", path.join(tmp, "local")]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /enable proxy/);
    assert.match(r.stdout, /http:\/\/localhost:3000\/setup/);
  });
});
