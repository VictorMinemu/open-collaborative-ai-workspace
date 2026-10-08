// node --test scripts/gate/lib.test.mjs
//
// The gate harness's safety guard (D-11): every gate stack runs beside the owner's demo on the same Docker daemon,
// so the guard must refuse the demo's project, ports, image tag and env files before anything runs. No Docker here.
// The repository's .env, .env.demo and ~/.ocw-demo are refused by path only: this test never creates or reads them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireLock, assertSafe, createGateEnv, DEMO, gatePorts, parseEnvFile } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let tmp;
let goodEnv;
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ocw-gate-lib-test-"));
  goodEnv = path.join(tmp, "gate.env");
  writeFileSync(goodEnv, "", { mode: 0o600 });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const SAFE = () => ({
  project: "ocw-gate-abc",
  envFile: goodEnv,
  imageTag: "gate-123",
  ports: [3400, 3401, 3402, 3403, 3404],
});

describe("assertSafe", () => {
  it("passes for an ocw-gate project on 34xx ports with a gate tag and a temp env file", () => {
    assert.doesNotThrow(() => assertSafe(SAFE()));
    assert.doesNotThrow(() => assertSafe({ ...SAFE(), project: "ocw-cleanroom-7f3a" }));
  });

  it("refuses the demo project and any project outside ocw-gate-* / ocw-cleanroom-*", () => {
    for (const project of [DEMO.project, "t3code-81d72154", "ocw-7", "ocw", "ocw-gate-", "OCW-GATE-X", ""]) {
      assert.throws(() => assertSafe({ ...SAFE(), project }), /project/i, project);
    }
  });

  it("refuses every demo port", () => {
    for (const port of DEMO.ports) {
      assert.throws(() => assertSafe({ ...SAFE(), ports: [3400, port] }), new RegExp(String(port)));
    }
    for (const port of [3000, 4000, 3900, 54329, 63799, 3290, 4290, 4291, 4292]) {
      assert.ok(DEMO.ports.includes(port), `DEMO.ports lists ${port}`);
    }
  });

  it("refuses the local image tag and an empty tag", () => {
    assert.equal(DEMO.imageTag, "local");
    assert.throws(() => assertSafe({ ...SAFE(), imageTag: "local" }), /local/);
    assert.throws(() => assertSafe({ ...SAFE(), imageTag: "" }), /tag/i);
    assert.throws(() => assertSafe({ ...SAFE(), imageTag: undefined }), /tag/i);
  });

  it("refuses the repository's env files and ~/.ocw-demo by path, and any env file outside the temp dir", () => {
    const refused = [
      path.join(ROOT, ".env"),
      path.join(ROOT, ".env.demo"),
      path.join(homedir(), ".ocw-demo", ".env"),
      path.join(homedir(), ".ocw-demo", "anything.env"),
      path.join(tmp, ".env.demo"),
      path.join(tmp, ".ocw-demo", ".env"),
      undefined,
    ];
    for (const envFile of refused) {
      assert.throws(() => assertSafe({ ...SAFE(), envFile }), /env file/i, String(envFile));
    }
  });
});

describe("gatePorts", () => {
  it("maps the 34 block to the documented ports", () => {
    assert.deepEqual(gatePorts(34), {
      web: 3400,
      api: 3401,
      postgres: 3402,
      redis: 3403,
      s3: 3404,
      grafana: 3405,
      proxyHttps: 3443,
      proxyHttp: 3480,
    });
    assert.deepEqual(gatePorts(), gatePorts(34));
  });

  it("never yields a demo port for the default block", () => {
    for (const p of Object.values(gatePorts())) assert.ok(!DEMO.ports.includes(p), String(p));
  });
});

describe("acquireLock", () => {
  it("a second acquire times out while the first holds the lock, then succeeds after release", async () => {
    const file = path.join(tmp, "held.lock");
    const release = await acquireLock(file, { timeoutMs: 1000 });
    assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
    await assert.rejects(acquireLock(file, { timeoutMs: 300, pollMs: 50 }), /lock/i);
    release();
    assert.equal(existsSync(file), false);
    const again = await acquireLock(file, { timeoutMs: 300 });
    again();
  });

  it("reclaims a lock file left by a dead process", async () => {
    const file = path.join(tmp, "stale.lock");
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    });
    const deadPid = Number(child.stdout);
    assert.ok(deadPid > 0);
    writeFileSync(file, `${deadPid}\n`);
    const release = await acquireLock(file, { timeoutMs: 500, pollMs: 50 });
    assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
    release();
  });
});

describe("createGateEnv", () => {
  it("writes a 0600 env file with fresh secrets, the block's ports, URLs, project, tag and files, printing nothing", () => {
    const dir = mkdtempSync(path.join(tmp, "env-"));
    const out = [];
    const write = process.stdout.write.bind(process.stdout);
    const ewrite = process.stderr.write.bind(process.stderr);
    const capture = (chunk) => {
      out.push(String(chunk));
      return true;
    };
    process.stdout.write = capture;
    process.stderr.write = capture;
    let envFile;
    try {
      envFile = createGateEnv({
        dir,
        runId: "t1",
        block: 34,
        imageTag: "gate-abc",
        extra: { COMPOSE_PROFILES: "proxy" },
      });
    } finally {
      process.stdout.write = write;
      process.stderr.write = ewrite;
    }
    assert.equal(envFile, path.join(dir, ".env"));
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    const env = parseEnvFile(envFile);
    assert.equal(env.COMPOSE_PROJECT_NAME, "ocw-gate-t1");
    assert.equal(env.COMPOSE_FILE, "compose.yaml:compose.e2e.yaml");
    assert.equal(env.COMPOSE_PROFILES, "proxy");
    assert.equal(env.OCW_IMAGE_TAG, "gate-abc");
    assert.equal(env.OCW_MODEL_PROVIDER, "mock");
    assert.equal(env.OCW_WEB_PORT, "3400");
    assert.equal(env.OCW_API_PORT, "3401");
    assert.equal(env.OCW_POSTGRES_PORT, "3402");
    assert.equal(env.OCW_REDIS_PORT, "3403");
    assert.equal(env.OCW_S3_PORT, "3404");
    assert.equal(env.OCW_GRAFANA_PORT, "3405");
    assert.equal(env.OCW_PROXY_HTTPS_PORT, "3443");
    assert.equal(env.OCW_PROXY_HTTP_PORT, "3480");
    assert.equal(env.OCW_PUBLIC_WEB_URL, "http://127.0.0.1:3400");
    assert.equal(env.OCW_PUBLIC_API_URL, "http://127.0.0.1:3401");
    assert.equal(env.OCW_S3_PUBLIC_URL, "http://127.0.0.1:3404");
    assert.equal(env.OCW_PUBLISH_ADDRESS, "127.0.0.1");
    for (const k of [
      "POSTGRES_PASSWORD",
      "OCW_DB_MIGRATOR_PASSWORD",
      "OCW_DB_APP_PASSWORD",
      "OCW_DB_AUTH_PASSWORD",
      "BETTER_AUTH_SECRET",
      "OCW_SETUP_TOKEN",
      "OCW_ENCRYPTION_KEY",
      "OCW_CELL_TOKEN",
      "GARAGE_RPC_SECRET",
      "OCW_S3_ACCESS_KEY_ID",
      "OCW_S3_SECRET_ACCESS_KEY",
    ]) {
      assert.ok(env[k] && env[k].length >= 16, `${k} generated`);
      assert.ok(!out.join("").includes(env[k]), `${k} value never printed`);
    }
    // Each key appears once (later overrides replace, never duplicate).
    const keys = readFileSync(envFile, "utf8")
      .split("\n")
      .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter(Boolean);
    assert.equal(new Set(keys).size, keys.length);
    // A second gate run gets different secrets.
    const dir2 = mkdtempSync(path.join(tmp, "env-"));
    const env2 = parseEnvFile(createGateEnv({ dir: dir2, runId: "t2", imageTag: "gate-abc" }));
    assert.notEqual(env2.POSTGRES_PASSWORD, env.POSTGRES_PASSWORD);
    assert.equal(env2.COMPOSE_PROFILES, "");
    assert.equal(env2.COMPOSE_PROJECT_NAME, "ocw-gate-t2");
  });

  it("refuses a run id that would not make an ocw-gate project, and a directory outside the temp dir", () => {
    assert.throws(
      () => createGateEnv({ dir: tmp, runId: "Bad Id", imageTag: "gate-abc" }),
      /project|run id/i,
    );
    assert.throws(() => createGateEnv({ dir: ROOT, runId: "x1", imageTag: "gate-abc" }), /env file/i);
  });
});
