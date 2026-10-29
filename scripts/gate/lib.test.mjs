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
import {
  acquireLock,
  assertPlaywrightStats,
  assertSafe,
  createGateEnv,
  DEMO,
  gatePorts,
  parseEnvFile,
  playwrightSummary,
} from "./lib.mjs";

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

  // gate:cleanroom holds the lock and runs the clone's compose gate (--attach) as its child: the child inherits the
  // lock only with OCW_GATE_LOCK_INHERIT=1 and only when the holder is its own parent; its release leaves the lock.
  const childAcquire = (file, env) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { acquireLock } = await import(${JSON.stringify(path.join(ROOT, "scripts/gate/lib.mjs"))});
         try { const r = await acquireLock(${JSON.stringify(file)}, { timeoutMs: 400, pollMs: 50 }); r(); console.log("acquired"); }
         catch { console.log("timed out"); }`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    ).stdout.trim();

  it("a child inherits the lock its parent holds only with OCW_GATE_LOCK_INHERIT=1, and leaves it held", async () => {
    const file = path.join(tmp, "inherit.lock");
    const release = await acquireLock(file, { timeoutMs: 500 });
    assert.equal(childAcquire(file, {}), "timed out");
    assert.equal(childAcquire(file, { OCW_GATE_LOCK_INHERIT: "1" }), "acquired");
    assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
    release();
  });

  it("OCW_GATE_LOCK_INHERIT=1 never takes a lock held by a process other than the parent", () => {
    const file = path.join(tmp, "other.lock");
    writeFileSync(file, "1\n"); // pid 1 is alive and is not the child's parent
    assert.equal(childAcquire(file, { OCW_GATE_LOCK_INHERIT: "1" }), "timed out");
    assert.equal(readFileSync(file, "utf8").trim(), "1");
  });
});

describe("createGateEnv", () => {
  it("runs the operator commands (ocw setup --ports, ocw enable proxy --no-up) and adds only gate keys, printing nothing", () => {
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
      envFile = createGateEnv({ dir, runId: "t1", block: 34, imageTag: "gate-abc", profiles: ["vault"] });
    } finally {
      process.stdout.write = write;
      process.stderr.write = ewrite;
    }
    assert.equal(envFile, path.join(dir, ".env"));
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    const env = parseEnvFile(envFile);
    // ocw setup --ports 34 --project … --image-tag …
    assert.equal(env.COMPOSE_PROJECT_NAME, "ocw-gate-t1");
    assert.equal(env.OCW_IMAGE_TAG, "gate-abc");
    assert.equal(env.OCW_WEB_PORT, "3400");
    assert.equal(env.OCW_API_PORT, "3401");
    assert.equal(env.OCW_POSTGRES_PORT, "3402");
    assert.equal(env.OCW_REDIS_PORT, "3403");
    assert.equal(env.OCW_S3_PORT, "3404");
    assert.equal(env.OCW_GRAFANA_PORT, "3405");
    assert.equal(env.OCW_PROXY_HTTPS_PORT, "3443");
    assert.equal(env.OCW_PROXY_HTTP_PORT, "3480");
    // ocw enable proxy --site-address localhost --no-up: one HTTPS origin, one trusted hop, loopback publishing.
    assert.equal(env.OCW_SITE_ADDRESS, "localhost");
    assert.equal(env.OCW_PUBLIC_WEB_URL, "https://localhost:3443");
    assert.equal(env.OCW_PUBLIC_API_URL, "https://localhost:3443");
    assert.equal(env.OCW_S3_PUBLIC_URL, "https://localhost:3443");
    assert.equal(env.OCW_TRUST_PROXY, "1");
    assert.equal(env.OCW_PUBLISH_ADDRESS, "127.0.0.1");
    // Gate-only keys: the e2e override and Caddy on loopback, the mock model, the shared sign-in bucket raised
    // (Docker Desktop shows every browser as the gateway IP behind Caddy; the product default stays 30).
    assert.equal(env.COMPOSE_FILE, "compose.yaml:compose.e2e.yaml:infra/caddy/compose.loopback.yaml");
    assert.equal(env.COMPOSE_PROFILES, "proxy,vault");
    assert.equal(env.OCW_MODEL_PROVIDER, "mock");
    assert.equal(env.OCW_SIGNIN_RATE_LIMIT_PER_MINUTE, "600");
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
    // A second gate run gets different secrets; without extra profiles only the proxy is on.
    const dir2 = mkdtempSync(path.join(tmp, "env-"));
    const env2 = parseEnvFile(createGateEnv({ dir: dir2, runId: "t2", imageTag: "gate-abc", block: 36 }));
    assert.notEqual(env2.POSTGRES_PASSWORD, env.POSTGRES_PASSWORD);
    assert.equal(env2.COMPOSE_PROFILES, "proxy");
    assert.equal(env2.COMPOSE_PROJECT_NAME, "ocw-gate-t2");
    assert.equal(env2.OCW_PUBLIC_WEB_URL, "https://localhost:3643");
    assert.equal(env2.OCW_SOURCE_COMMIT, undefined, "no commit given: none written");
  });

  it("writes OCW_SOURCE_COMMIT for the api build when the gate builds a clean commit (07.12-11)", () => {
    const dir = mkdtempSync(path.join(tmp, "env-"));
    const commit = "c".repeat(40);
    const env = parseEnvFile(
      createGateEnv({ dir, runId: "t3", imageTag: "gate-abc", block: 37, sourceCommit: commit }),
    );
    assert.equal(env.OCW_SOURCE_COMMIT, commit);
    assert.throws(
      () =>
        createGateEnv({
          dir: mkdtempSync(path.join(tmp, "env-")),
          runId: "t4",
          imageTag: "gate-abc",
          sourceCommit: "HEAD",
        }),
      /sourceCommit/,
    );
  });

  it("refuses a run id that would not make an ocw-gate project, and a directory outside the temp dir", () => {
    assert.throws(
      () => createGateEnv({ dir: tmp, runId: "Bad Id", imageTag: "gate-abc" }),
      /project|run id/i,
    );
    assert.throws(() => createGateEnv({ dir: ROOT, runId: "x1", imageTag: "gate-abc" }), /env file/i);
  });
});

/** A Playwright JSON report (the fields the gate reads): nested suites, one test per project. */
function report(tests, stats) {
  return {
    stats,
    suites: [
      {
        title: "compose/scenario-b.spec.ts",
        specs: [],
        suites: [
          {
            title: "inner",
            specs: [
              { title: "spec", tests: tests.map(([projectName, status]) => ({ projectName, status })) },
            ],
          },
        ],
      },
    ],
  };
}

describe("assertPlaywrightStats", () => {
  it("passes a run where every test ran and passed", () => {
    assert.doesNotThrow(() => assertPlaywrightStats({ expected: 5, skipped: 0, unexpected: 0, flaky: 0 }));
  });

  it("refuses an empty run, any skipped test, any failure and any flaky test", () => {
    const ok = { expected: 5, skipped: 0, unexpected: 0, flaky: 0 };
    assert.throws(() => assertPlaywrightStats({ ...ok, expected: 0 }), /no test ran|expected/i);
    assert.throws(() => assertPlaywrightStats({ ...ok, skipped: 1 }), /skipped/);
    assert.throws(() => assertPlaywrightStats({ ...ok, unexpected: 1 }), /unexpected|failed/);
    assert.throws(() => assertPlaywrightStats({ ...ok, flaky: 1 }), /flaky/);
    assert.throws(() => assertPlaywrightStats(undefined), /no test ran|stats/i);
    assert.throws(() => assertPlaywrightStats({}), /no test ran|expected/i);
  });
});

describe("playwrightSummary", () => {
  it("returns the run's stats and the counts per project from nested suites", () => {
    const s = playwrightSummary(
      report(
        [
          ["setup", "expected"],
          ["desktop", "expected"],
          ["desktop", "expected"],
          ["mobile", "expected"],
          ["mobile", "skipped"],
        ],
        { expected: 4, skipped: 1, unexpected: 0, flaky: 0, duration: 1234.5 },
      ),
    );
    assert.deepEqual(s.stats, { expected: 4, skipped: 1, unexpected: 0, flaky: 0, durationMs: 1235 });
    assert.deepEqual(s.projects, {
      setup: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
      desktop: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
      mobile: { expected: 1, skipped: 1, unexpected: 0, flaky: 0 },
    });
  });
});
