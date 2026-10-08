// node --test 'scripts/**/*.test.mjs'
//
// `pnpm ocw setup` end to end, through the dispatcher, in temporary directories: a fresh .env with every secret in
// its format, nothing secret on stdout/stderr, port blocks for second instances and gate stacks, and (when Docker is
// installed) the result accepted by `docker compose config` under a throwaway project. The repository's .env and
// .env.demo are never read or written; `docker compose config` only reads files and starts nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { composeArgs, DEMO, REPO_ROOT, readEnv } from "./env-file.mjs";

const OCW = path.join(REPO_ROOT, "scripts", "ocw.mjs");
let dir;
const envFile = () => path.join(dir, ".env");
const setup = (...args) =>
  spawnSync(process.execPath, [OCW, "setup", "--dir", dir, ...args], { encoding: "utf8" });
const values = () => readEnv(envFile()).values;
const templateKeys = () =>
  readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8")
    .split("\n")
    .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter(Boolean);

/** Every value in the written file that could be a secret: anything long enough, except plain http(s) URLs. */
function assertNoValuePrinted(res) {
  const out = `${res.stdout}\n${res.stderr}`;
  for (const [key, value] of values()) {
    if (value.length < 8 || /^https?:\/\/[^@]*$/.test(value)) continue;
    assert.ok(!out.includes(value), `${key}'s value appears in the output`);
  }
}

const hasDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
/** `docker compose config` with only PATH/HOME from the shell (no inherited COMPOSE_* or OCW_* overrides). */
function composeConfig(file) {
  return spawnSync("docker", ["compose", ...composeArgs(file), "config", "--quiet"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ocw-setup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ocw setup", () => {
  it("a fresh run writes every template key and every generated secret in its format, at 0600", () => {
    const res = setup();
    assert.equal(res.status, 0, res.stderr);
    assert.equal(statSync(envFile()).mode & 0o777, 0o600);
    const text = readFileSync(envFile(), "utf8");
    for (const key of templateKeys()) {
      assert.equal(text.match(new RegExp(`^${key}=`, "gm"))?.length, 1, `${key} appears once`);
    }
    const v = values();
    for (const key of [
      "POSTGRES_PASSWORD",
      "OCW_DB_MIGRATOR_PASSWORD",
      "OCW_DB_APP_PASSWORD",
      "OCW_DB_AUTH_PASSWORD",
    ]) {
      assert.match(v.get(key), /^[0-9a-f]{48}$/, key);
    }
    assert.match(v.get("BETTER_AUTH_SECRET"), /^[0-9a-f]{64}$/);
    assert.match(v.get("OCW_SETUP_TOKEN"), /^[0-9a-f]{32}$/);
    assert.equal(Buffer.from(v.get("OCW_ENCRYPTION_KEY"), "base64").length, 32);
    assert.match(v.get("OCW_CELL_TOKEN"), /^ocw_cell_[A-Za-z0-9_-]{43}$/);
    assert.match(v.get("GARAGE_RPC_SECRET"), /^[0-9a-f]{64}$/);
    assert.match(v.get("OCW_S3_ACCESS_KEY_ID"), /^GK[0-9a-f]{24}$/);
    assert.match(v.get("OCW_S3_SECRET_ACCESS_KEY"), /^[0-9a-f]{64}$/);
    // Local-dev URLs embed the generated role passwords; no placeholder is left behind.
    assert.equal(
      v.get("DATABASE_URL"),
      `postgres://ocw_app:${v.get("OCW_DB_APP_PASSWORD")}@localhost:54329/ocw`,
    );
    assert.doesNotMatch(text, /\$\{|change-me/);
    // Defaults stay Compose's defaults: no project, tag or web/api port is pinned.
    for (const key of ["COMPOSE_PROJECT_NAME", "OCW_IMAGE_TAG", "OCW_WEB_PORT", "OCW_API_PORT"]) {
      assert.equal(v.has(key), false, key);
    }
  });

  it("prints key names, the file and the next steps, and no value from the written file", () => {
    const res = setup();
    assert.equal(res.status, 0, res.stderr);
    assertNoValuePrinted(res);
    assert.match(
      res.stdout,
      new RegExp(`Wrote ${envFile().replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(mode 0600\\)`),
    );
    for (const key of [
      "POSTGRES_PASSWORD",
      "BETTER_AUTH_SECRET",
      "OCW_SETUP_TOKEN",
      "OCW_S3_SECRET_ACCESS_KEY",
    ]) {
      assert.match(res.stdout, new RegExp(`\\b${key}\\b`));
    }
    assert.match(res.stdout, /docker compose .*up -d --build --wait/);
    assert.match(res.stdout, /http:\/\/localhost:3000/);
    assert.ok(res.stdout.includes(`grep '^OCW_SETUP_TOKEN=' ${envFile()}`), res.stdout);
  });

  it("--ports 34 puts every published port in the 34xx block with matching URLs", () => {
    const res = setup("--ports", "34");
    assert.equal(res.status, 0, res.stderr);
    assertNoValuePrinted(res);
    const v = values();
    const expected = {
      OCW_WEB_PORT: "3400",
      OCW_API_PORT: "3401",
      OCW_POSTGRES_PORT: "3402",
      OCW_REDIS_PORT: "3403",
      OCW_S3_PORT: "3404",
      OCW_GRAFANA_PORT: "3405",
      OCW_PROXY_HTTPS_PORT: "3443",
      OCW_PROXY_HTTP_PORT: "3480",
      OCW_PUBLIC_WEB_URL: "http://localhost:3400",
      OCW_PUBLIC_API_URL: "http://localhost:3401",
      OCW_S3_PUBLIC_URL: "http://localhost:3404",
      OCW_S3_ENDPOINT: "http://127.0.0.1:3404",
      DATABASE_URL: `postgres://ocw_app:${v.get("OCW_DB_APP_PASSWORD")}@localhost:3402/ocw`,
      AUTH_DATABASE_URL: `postgres://ocw_auth:${v.get("OCW_DB_AUTH_PASSWORD")}@localhost:3402/ocw`,
      MIGRATOR_DATABASE_URL: `postgres://ocw_migrator:${v.get("OCW_DB_MIGRATOR_PASSWORD")}@localhost:3402/ocw`,
      MIGRATE_SUPERUSER_URL: `postgres://postgres:${v.get("POSTGRES_PASSWORD")}@localhost:3402/ocw`,
      REDIS_URL: "redis://localhost:3403",
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(v.get(key), value, key);
    const text = readFileSync(envFile(), "utf8");
    for (const key of Object.keys(expected)) {
      assert.equal(text.match(new RegExp(`^${key}=`, "gm")).length, 1, `${key} appears once`);
    }
    assert.match(res.stdout, /http:\/\/localhost:3400/);
  });

  it("--project and --image-tag write COMPOSE_PROJECT_NAME and OCW_IMAGE_TAG; the demo project is refused", () => {
    const res = setup("--project", "ocw-x", "--image-tag", "t1");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(values().get("COMPOSE_PROJECT_NAME"), "ocw-x");
    assert.equal(values().get("OCW_IMAGE_TAG"), "t1");

    rmSync(envFile());
    const demo = setup("--project", DEMO.project);
    assert.equal(demo.status, 2);
    assert.match(demo.stderr, /demo/);
    for (const bad of [
      ["--project", "Bad Name"],
      ["--image-tag", "a b"],
      ["--ports", "7"],
      ["--ports", "655"],
    ]) {
      assert.equal(setup(...bad).status, 2, bad.join(" "));
    }
  });

  it("--env-file writes exactly that file", () => {
    const target = path.join(dir, "gate.env");
    // `node --`: Node 24 checks a path after `--env-file` exists even after the script name (exit 9 for a new file).
    const res = spawnSync(process.execPath, ["--", OCW, "setup", "--env-file", target], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(readFileSync(target, "utf8"), /^OCW_SETUP_TOKEN=[0-9a-f]{32}$/m);
    assert.ok(res.stdout.includes(`--env-file ${target}`), "the next step names the env file");
  });

  it("an existing .env without flags is refused and untouched", () => {
    writeFileSync(envFile(), "POSTGRES_PASSWORD=keep\n");
    const res = setup("--ports", "34");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--add-missing/);
    assert.equal(readFileSync(envFile(), "utf8"), "POSTGRES_PASSWORD=keep\n");
  });

  it("--force rotates every secret and warns by key name only", () => {
    assert.equal(setup().status, 0);
    const before = values();
    const res = setup("--force");
    assert.equal(res.status, 0, res.stderr);
    assertNoValuePrinted(res);
    const after = values();
    for (const key of [
      "BETTER_AUTH_SECRET",
      "OCW_SETUP_TOKEN",
      "POSTGRES_PASSWORD",
      "OCW_S3_SECRET_ACCESS_KEY",
    ]) {
      assert.notEqual(after.get(key), before.get(key), key);
      assert.ok(!res.stdout.includes(before.get(key)), `old ${key} not printed`);
    }
    assert.match(res.stdout, /BETTER_AUTH_SECRET was rotated/);
    assert.match(res.stdout, /OCW_S3_\* keys were rotated/);
  });

  it("the written .env is accepted by `docker compose config` (default ports and a 34xx block)", {
    skip: hasDocker ? false : "docker compose is not installed",
  }, () => {
    const project = `ocw-gate-setup-${process.pid}`;
    assert.equal(setup("--project", project).status, 0);
    const plain = composeConfig(envFile());
    assert.equal(plain.status, 0, plain.stderr);

    rmSync(envFile());
    assert.equal(setup("--ports", "34", "--project", project, "--image-tag", "gate-setup").status, 0);
    assert.deepEqual(composeArgs(envFile()).slice(-2), ["-p", project]);
    const block = composeConfig(envFile());
    assert.equal(block.status, 0, block.stderr);
  });
});
