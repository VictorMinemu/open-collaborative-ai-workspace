// node --test scripts/ocw/enable-observability.test.mjs
//
// `pnpm ocw enable observability --no-up` (SELF-01 "enable later", D-05, D-13) on temp env files, through the
// dispatcher: it points the API at the profile's collector, generates the Grafana admin password once, adds the
// profile to COMPOSE_PROFILES, keeps every other byte, prints key names and never the password, and a second run
// changes nothing. Starting the profile on a running stack (no --no-up) is proven by scripts/gate/observability-smoke.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseEnvText, REPO_ROOT } from "./env-file.mjs";

const OCW = path.join(REPO_ROOT, "scripts", "ocw.mjs");
const ENDPOINT = "http://otel-collector:4318";
const KEYS = ["OCW_OTEL_ENDPOINT", "OCW_GRAFANA_ADMIN_PASSWORD", "COMPOSE_PROFILES"];

let dir;
let file;
const enable = (...args) =>
  spawnSync(process.execPath, ["--", OCW, "enable", "observability", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
const run = (...args) => enable("--env-file", file, "--no-up", ...args);
const read = () => readFileSync(file, "utf8");
const values = () => parseEnvText(read());
const out = (res) => `${res.stdout}\n${res.stderr}`;

/** The lines of `text` that do not set (or template) one of the keys this command owns. */
const untouched = (text) =>
  text.split("\n").filter((l) => !KEYS.some((k) => new RegExp(`^#?\\s*${k}=`).test(l)));

/** Shaped like a real install's .env: comments, blank lines, template lines for the keys, other settings. */
const INSTALL = [
  "# Open Collaborative AI Workspace",
  "POSTGRES_PASSWORD=pg-secret-value-123",
  "",
  "# Optional compose profiles (comma list).",
  "# COMPOSE_PROFILES=",
  "OCW_PUBLIC_WEB_URL=http://localhost:3000",
  "",
  "# Telemetry",
  "# OCW_OTEL_ENDPOINT=",
  "# Grafana",
  "# OCW_GRAFANA_PORT=",
  "# OCW_GRAFANA_ADMIN_PASSWORD=",
  "OCW_TRUST_PROXY=false",
  "",
].join("\n");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ocw-enable-obs-"));
  file = path.join(dir, ".env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ocw enable observability --no-up", () => {
  it("writes the collector endpoint, a generated password and the profile, keeping every other byte", () => {
    writeFileSync(file, INSTALL, { mode: 0o600 });
    const res = run();
    assert.equal(res.status, 0, out(res));
    const v = values();
    assert.equal(v.get("OCW_OTEL_ENDPOINT"), ENDPOINT);
    assert.match(v.get("OCW_GRAFANA_ADMIN_PASSWORD"), /^[0-9a-f]{48}$/);
    assert.equal(v.get("COMPOSE_PROFILES"), "observability");
    const text = read();
    for (const key of KEYS) assert.equal(text.match(new RegExp(`^${key}=`, "gm"))?.length, 1, key);
    // Template lines are filled in place: no commented copy is left, nothing is appended.
    assert.doesNotMatch(text, /^#\s*(OCW_OTEL_ENDPOINT|OCW_GRAFANA_ADMIN_PASSWORD|COMPOSE_PROFILES)=/m);
    assert.equal(text.split("\n").length, INSTALL.split("\n").length);
    assert.deepEqual(untouched(text), untouched(INSTALL));
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("prints the key names, the Grafana URL and how to read the password, never the password", () => {
    writeFileSync(file, INSTALL, { mode: 0o600 });
    const res = run();
    assert.equal(res.status, 0, out(res));
    const password = values().get("OCW_GRAFANA_ADMIN_PASSWORD");
    assert.ok(!out(res).includes(password), "the Grafana password appears in the output");
    for (const key of KEYS) assert.match(res.stdout, new RegExp(`\\b${key}\\b`));
    assert.match(res.stdout, /http:\/\/127\.0\.0\.1:3301\b/);
    assert.ok(res.stdout.includes(`grep '^OCW_GRAFANA_ADMIN_PASSWORD=' ${file}`), res.stdout);
    assert.match(res.stdout, /docker compose .*up -d --wait/);
  });

  it("a second run changes nothing and says so", () => {
    writeFileSync(file, INSTALL, { mode: 0o600 });
    assert.equal(run().status, 0);
    const first = read();
    const res = run();
    assert.equal(res.status, 0, out(res));
    assert.equal(read(), first);
    assert.match(res.stdout, /already enabled/i);
    assert.match(res.stdout, /nothing changed/i);
    assert.ok(!out(res).includes(values().get("OCW_GRAFANA_ADMIN_PASSWORD")));
  });

  it("appends the profile to an existing list once, keeps an existing password and uses OCW_GRAFANA_PORT", () => {
    const existing = "keep-this-grafana-password-0123456789";
    writeFileSync(
      file,
      `COMPOSE_PROFILES=proxy,vault\nOCW_GRAFANA_PORT=3405\nOCW_GRAFANA_ADMIN_PASSWORD=${existing}\n`,
      { mode: 0o600 },
    );
    const res = run();
    assert.equal(res.status, 0, out(res));
    const v = values();
    assert.equal(v.get("COMPOSE_PROFILES"), "proxy,vault,observability");
    assert.equal(v.get("OCW_GRAFANA_ADMIN_PASSWORD"), existing, "an existing password is never rotated");
    assert.equal(v.get("OCW_OTEL_ENDPOINT"), ENDPOINT);
    assert.match(res.stdout, /http:\/\/127\.0\.0\.1:3405\b/);
    assert.ok(!out(res).includes(existing));
    // A key line that was missing is appended under a header; the existing lines stay first, unchanged.
    assert.match(read(), /^COMPOSE_PROFILES=proxy,vault,observability\nOCW_GRAFANA_PORT=3405\n/);
  });

  it("points the API at the collector when another endpoint was configured, without printing it", () => {
    const other = "https://user:otlp-credential@collector.example.com:4318";
    writeFileSync(file, `OCW_OTEL_ENDPOINT=${other}\n`, { mode: 0o600 });
    const res = run();
    assert.equal(res.status, 0, out(res));
    assert.equal(values().get("OCW_OTEL_ENDPOINT"), ENDPOINT);
    assert.ok(!out(res).includes("otlp-credential"), "the previous endpoint appears in the output");
    assert.match(res.stdout, /OCW_OTEL_ENDPOINT .*replaced/i);
  });

  it("fails without changing anything when the env file does not exist", () => {
    const res = run();
    assert.notEqual(res.status, 0);
    assert.match(out(res), /ocw setup/);
  });

  it("refuses the demo's env files by path, without reading them", () => {
    for (const target of [path.join(homedir(), ".ocw-demo", ".env"), path.join(dir, ".env.demo")]) {
      const res = enable("--env-file", target, "--no-up");
      assert.notEqual(res.status, 0, target);
      assert.match(out(res), /demo/);
    }
  });

  it("rejects unknown options with exit 2 and prints its help on --help", () => {
    writeFileSync(file, INSTALL, { mode: 0o600 });
    assert.equal(run("--bogus").status, 2);
    assert.equal(read(), INSTALL);
    const help = enable("--help");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--no-up/);
  });
});
