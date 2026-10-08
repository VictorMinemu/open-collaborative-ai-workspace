// node --test scripts/ocw/enable-proxy.test.mjs
//
// `pnpm ocw enable proxy` (SELF-05, D-07, D-18) through the dispatcher with --no-up, on env files written by
// `ocw setup` in temporary directories: one HTTPS origin for the three public URLs, one trusted proxy hop, api and
// web bound to loopback, the `proxy` profile added once, bad site addresses refused without touching the file, and
// every other byte kept. Nothing starts; the repository's .env and .env.demo are never read or written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { REPO_ROOT, readEnv } from "./env-file.mjs";

const OCW = path.join(REPO_ROOT, "scripts", "ocw.mjs");
const TOUCHED = [
  "OCW_SITE_ADDRESS",
  "OCW_PUBLIC_WEB_URL",
  "OCW_PUBLIC_API_URL",
  "OCW_S3_PUBLIC_URL",
  "OCW_TRUST_PROXY",
  "OCW_PUBLISH_ADDRESS",
  "OCW_PROXY_TLS",
  "COMPOSE_PROFILES",
];

let dir;
const envFile = () => path.join(dir, ".env");
const ocw = (...args) => spawnSync(process.execPath, ["--", OCW, ...args], { encoding: "utf8" });
const enable = (...args) => ocw("enable", "proxy", "--env-file", envFile(), "--no-up", ...args);
const values = () => readEnv(envFile()).values;
const text = () => readFileSync(envFile(), "utf8");

/** A real install's env file: `ocw setup` (optionally with a port block), then the given keys set by hand. */
function install({ ports, set = {} } = {}) {
  const res = ocw("setup", "--dir", dir, ...(ports ? ["--ports", String(ports)] : []));
  assert.equal(res.status, 0, res.stderr);
  if (Object.keys(set).length) {
    writeFileSync(
      envFile(),
      `${text()}${Object.entries(set)
        .map(([k, v]) => `${k}=${v}\n`)
        .join("")}`,
      { mode: 0o600 },
    );
  }
}

/** The file's lines without the keys enable-proxy owns (set or commented) and without its header. */
function untouchedLines(t) {
  const owned = new RegExp(`^#?\\s*(${TOUCHED.join("|")})=`);
  return t.split("\n").filter((l) => !owned.test(l) && !/^# Written by pnpm ocw enable proxy$/.test(l));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ocw-enable-proxy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ocw enable proxy", () => {
  it("a public domain on the default ports gets one https origin, one trusted hop and loopback ports", () => {
    install();
    const res = enable("--site-address", "ocw.example.com");
    assert.equal(res.status, 0, res.stderr);
    const v = values();
    assert.equal(v.get("OCW_SITE_ADDRESS"), "ocw.example.com");
    for (const key of ["OCW_PUBLIC_WEB_URL", "OCW_PUBLIC_API_URL", "OCW_S3_PUBLIC_URL"]) {
      assert.equal(v.get(key), "https://ocw.example.com", key);
    }
    assert.equal(v.get("OCW_TRUST_PROXY"), "1");
    assert.equal(v.get("OCW_PUBLISH_ADDRESS"), "127.0.0.1");
    assert.deepEqual(v.get("COMPOSE_PROFILES").split(","), ["proxy"]);
    assert.equal(statSync(envFile()).mode & 0o777, 0o600);
    // Key names and the public URL only.
    assert.match(res.stdout, /OCW_TRUST_PROXY/);
    assert.match(res.stdout, /https:\/\/ocw\.example\.com/);
  });

  it("a non-default https port (gate block 34) is part of the origin", () => {
    install({ ports: 34 });
    assert.equal(values().get("OCW_PROXY_HTTPS_PORT"), "3443");
    const res = enable("--site-address", "localhost");
    assert.equal(res.status, 0, res.stderr);
    for (const key of ["OCW_PUBLIC_WEB_URL", "OCW_PUBLIC_API_URL", "OCW_S3_PUBLIC_URL"]) {
      assert.equal(values().get(key), "https://localhost:3443", key);
    }
  });

  it("port 443 set explicitly is left out of the origin", () => {
    install({ set: { OCW_PROXY_HTTPS_PORT: "443" } });
    assert.equal(enable("--site-address", "ocw.example.com").status, 0);
    assert.equal(values().get("OCW_PUBLIC_API_URL"), "https://ocw.example.com");
  });

  it("adds the profile once, after the ones already enabled, and a second run changes nothing", () => {
    install({ set: { COMPOSE_PROFILES: "vault" } });
    assert.equal(enable("--site-address", "ocw.example.com").status, 0);
    const first = text();
    assert.equal(values().get("COMPOSE_PROFILES"), "vault,proxy");
    assert.equal(enable("--site-address", "ocw.example.com").status, 0);
    assert.equal(text(), first);
  });

  it("keeps every other byte of the file", () => {
    install({ set: { OCW_CUSTOM_SETTING: "kept as is", OCW_TRUSTED_ORIGINS: "https://other.example.com" } });
    const before = text();
    assert.equal(enable("--site-address", "ocw.example.com").status, 0);
    assert.deepEqual(untouchedLines(text()), untouchedLines(before));
  });

  it("--tls internal selects Caddy's own CA for an internal name; anything else is refused", () => {
    install();
    assert.equal(enable("--site-address", "ocw.corp.internal", "--tls", "internal").status, 0);
    assert.equal(values().get("OCW_PROXY_TLS"), "internal");
    const before = text();
    const res = enable("--site-address", "ocw.corp.internal", "--tls", "self-signed");
    assert.equal(res.status, 2);
    assert.equal(text(), before);
  });

  for (const [label, args] of [
    ["a missing site address", []],
    ["a URL", ["--site-address", "https://ocw.example.com"]],
    ["a host with a port", ["--site-address", "ocw.example.com:8443"]],
    ["a host with a path", ["--site-address", "ocw.example.com/ocw"]],
    ["a wildcard", ["--site-address", "*.example.com"]],
    ["whitespace", ["--site-address", "ocw example.com"]],
  ]) {
    it(`refuses ${label} and leaves the file untouched`, () => {
      install();
      const before = text();
      const res = enable(...args);
      assert.equal(res.status, 2, res.stdout);
      assert.match(res.stderr, /site-address/);
      assert.equal(text(), before);
    });
  }

  it("refuses an env file that does not exist (run ocw setup first)", () => {
    const res = enable("--site-address", "ocw.example.com");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /ocw setup/);
  });

  it("refuses the demo's env file by path, without reading it", () => {
    const res = ocw(
      "enable",
      "proxy",
      "--env-file",
      path.join(dir, ".env.demo"),
      "--no-up",
      "--site-address",
      "localhost",
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /demo/);
  });

  it("prints no secret value", () => {
    install();
    const res = enable("--site-address", "ocw.example.com");
    assert.equal(res.status, 0, res.stderr);
    const out = `${res.stdout}\n${res.stderr}`;
    for (const [key, value] of values()) {
      // The site address and the URLs built from it are what the command reports on purpose.
      if (TOUCHED.includes(key) || value.length < 8 || /^https?:\/\/[^@]*$/.test(value)) continue;
      assert.ok(!out.includes(value), `${key}'s value appears in the output`);
    }
  });
});
