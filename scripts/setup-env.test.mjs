// node --test 'scripts/**/*.test.mjs'
//
// `pnpm setup:env` (scripts/setup-env.mjs, an alias of `pnpm ocw setup`) in a temporary directory (`--dir`): a fresh
// .env gets the Garage / S3 keys (ADR-0015), `--add-missing` upgrades an existing .env without touching any existing
// value, a plain run still refuses to overwrite, and no value is ever printed (D-13). The repository's own .env is
// never read or written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "setup-env.mjs");
let dir;
const envFile = () => path.join(dir, ".env");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, "--dir", dir, ...args], { encoding: "utf8" });
const lines = (text, key) => text.split("\n").filter((l) => l.startsWith(`${key}=`));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ocw-setup-env-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("setup-env", () => {
  it("a fresh run writes the Garage RPC secret and the S3 key pair in Garage's formats", () => {
    const res = run();
    assert.equal(res.status, 0, res.stderr);
    const text = readFileSync(envFile(), "utf8");
    assert.match(text, /^GARAGE_RPC_SECRET=[0-9a-f]{64}$/m);
    assert.match(text, /^OCW_S3_ACCESS_KEY_ID=GK[0-9a-f]{24}$/m);
    assert.match(text, /^OCW_S3_SECRET_ACCESS_KEY=[0-9a-f]{64}$/m);
    assert.match(text, /^OCW_S3_ENDPOINT=\S+$/m);
    assert.match(text, /^OCW_S3_PUBLIC_URL=\S+$/m);
    for (const key of ["GARAGE_RPC_SECRET", "OCW_S3_ACCESS_KEY_ID", "OCW_S3_SECRET_ACCESS_KEY"]) {
      assert.equal(lines(text, key).length, 1, `${key} appears once`);
    }
    // Two runs never share a secret.
    rmSync(envFile());
    assert.equal(run().status, 0);
    const again = readFileSync(envFile(), "utf8");
    assert.notEqual(lines(again, "OCW_S3_SECRET_ACCESS_KEY")[0], lines(text, "OCW_S3_SECRET_ACCESS_KEY")[0]);
  });

  it("without flags an existing .env is refused and left untouched", () => {
    writeFileSync(envFile(), "POSTGRES_PASSWORD=keep\n");
    const res = run();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--add-missing/);
    assert.equal(readFileSync(envFile(), "utf8"), "POSTGRES_PASSWORD=keep\n");
  });

  it("--add-missing appends only missing keys and keeps every existing byte", () => {
    const before =
      "POSTGRES_PASSWORD=keep-me\n# a comment\nOCW_S3_ACCESS_KEY_ID=GKexisting\nBETTER_AUTH_SECRET=old-but-mine";
    writeFileSync(envFile(), before);
    const res = run("--add-missing");
    assert.equal(res.status, 0, res.stderr);
    const after = readFileSync(envFile(), "utf8");
    assert.ok(after.startsWith(before), "existing content is byte-identical");
    const added = after.slice(before.length);
    assert.match(added, /^GARAGE_RPC_SECRET=[0-9a-f]{64}$/m);
    assert.match(added, /^OCW_S3_SECRET_ACCESS_KEY=[0-9a-f]{64}$/m);
    assert.match(added, /^OCW_S3_ENDPOINT=\S+$/m);
    for (const key of ["OCW_S3_ACCESS_KEY_ID", "BETTER_AUTH_SECRET", "POSTGRES_PASSWORD"]) {
      assert.equal(lines(after, key).length, 1, `${key} is not added again`);
    }
    // Database passwords and the URLs that embed them are never invented for an existing installation.
    for (const key of ["OCW_DB_APP_PASSWORD", "OCW_DB_AUTH_PASSWORD", "OCW_DB_MIGRATOR_PASSWORD"]) {
      assert.equal(lines(added, key).length, 0, `${key} is not appended`);
    }
    assert.doesNotMatch(added, /postgres:\/\//);

    // Idempotent: a second run appends nothing.
    assert.equal(run("--add-missing").status, 0);
    assert.equal(readFileSync(envFile(), "utf8"), after);
  });

  it("--add-missing without a .env asks for a fresh run", () => {
    const res = run("--add-missing");
    assert.equal(res.status, 1);
  });

  it("prints key names and where, never a value from the written file (D-13)", () => {
    for (const args of [[], ["--force"]]) {
      const res = run(...args);
      assert.equal(res.status, 0, res.stderr);
      const out = `${res.stdout}\n${res.stderr}`;
      const text = readFileSync(envFile(), "utf8");
      for (const line of text.split("\n")) {
        const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        // Long values except plain http(s) URLs (the next steps print the web URL on purpose).
        if (!m || m[2].length < 8 || /^https?:\/\/[^@]*$/.test(m[2])) continue;
        assert.ok(!out.includes(m[2]), `${m[1]}'s value appears in the output`);
      }
      assert.match(res.stdout, /\bOCW_SETUP_TOKEN\b/);
      assert.ok(res.stdout.includes(`grep '^OCW_SETUP_TOKEN=' ${envFile()}`), "how to read the token");
    }
    // --add-missing reports appended keys by name too.
    writeFileSync(envFile(), "POSTGRES_PASSWORD=keep-me\n");
    const res = run("--add-missing");
    assert.equal(res.status, 0, res.stderr);
    const added = readFileSync(envFile(), "utf8");
    const token = /^OCW_SETUP_TOKEN=(.+)$/m.exec(added)[1];
    assert.ok(!res.stdout.includes(token));
    assert.match(res.stdout, /\bOCW_SETUP_TOKEN\b/);
  });
});
