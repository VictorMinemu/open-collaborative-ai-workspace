// Gate harness (Phase 7, D-11, D-18): boots the self-hosted compose stack from freshly built images in an isolated
// project beside the owner's running demo, runs checks against it and tears it down. Node builtins only (macOS ships
// bash 3.2, which is why this is not a shell script).
//
// Safety model: the demo shares this Docker daemon. Every Docker call goes through `composeCmd`/`docker`, which run
// `assertSafe` first: the project must be `ocw-gate-*` / `ocw-cleanroom-*`, no port may be a demo port, the image tag
// may never be `local` and the env file must live in the temp dir (so a checkout's .env, .env.demo and ~/.ocw-demo
// are refused by path, without reading them). Docker runs with a minimal environment, so a shell that exported
// OCW_API_PORT=4000 (or any COMPOSE_* variable) cannot redirect a gate stack onto the demo. Nothing is removed unless
// its name carries the run id. Secret values are never printed: `ctx.env` is not enumerable and setup output is
// swallowed.
//
// Gate step convention (07-06 … 07-10): scripts/gate/<step>.mjs exports `async run(ctx) → { name, ok, details }`;
// its CLI takes --up (own stack via withGateStack with the profiles it needs) or --attach <envFile> (a stack left by
// --keep). Steps must also pass on a shared, already-used stack: call ensureAdmin, use unique names for their data.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** What the owner's running demo uses on this machine. A gate stack may never touch any of it. */
export const DEMO = Object.freeze({
  project: "t3code-81d72154",
  // web, api, garage s3, demo postgres/redis, e2e-isolated web/api/fake/garage, plus the stock postgres/redis ports.
  ports: Object.freeze([3000, 4000, 3900, 54329, 63799, 3290, 4290, 4291, 4292, 5432, 6379]),
  imageTag: "local",
});

/** Admin used by every gate step and by the compose Playwright run (same defaults as e2e/tests/env.ts). */
export const ADMIN = Object.freeze({
  name: process.env.OCW_E2E_ADMIN_NAME ?? "Víctor Ruiz",
  email: process.env.OCW_E2E_ADMIN_EMAIL ?? "admin@ocw.test",
  password: process.env.OCW_E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
  orgName: process.env.OCW_E2E_ORG ?? "Autofy Labs",
});

export const DEFAULT_LOCK = "/tmp/ocw-gate.lock";
/** Build-cache snapshot a --keep run leaves next to its env file, for teardownGateStack. */
const CACHE_SNAPSHOT = "build-cache-before.json";
const PROJECT_RE = /^ocw-(gate|cleanroom)-[a-z0-9][a-z0-9_-]*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Ports of a block: block 34 → web 3400, api 3401, postgres 3402, redis 3403, s3 3404, grafana 3405, proxy 3443/3480. */
export function gatePorts(block = 34) {
  if (!Number.isInteger(block) || block < 10 || block > 650)
    throw new Error(`gatePorts: invalid block ${block}`);
  const base = block * 100;
  return {
    web: base,
    api: base + 1,
    postgres: base + 2,
    redis: base + 3,
    s3: base + 4,
    grafana: base + 5,
    proxyHttps: base + 43,
    proxyHttp: base + 80,
  };
}

/** Env keys of each port (compose.yaml and the profile files read these). */
const PORT_KEYS = {
  web: "OCW_WEB_PORT",
  api: "OCW_API_PORT",
  postgres: "OCW_POSTGRES_PORT",
  redis: "OCW_REDIS_PORT",
  s3: "OCW_S3_PORT",
  grafana: "OCW_GRAFANA_PORT",
  proxyHttps: "OCW_PROXY_HTTPS_PORT",
  proxyHttp: "OCW_PROXY_HTTP_PORT",
};
/** compose.yaml's defaults: an env file missing one of these keys would publish on the demo's port. */
const COMPOSE_DEFAULT_PORTS = { web: 3000, api: 4000, postgres: 54329, redis: 63799, s3: 3900 };

function realDir(p) {
  // The file may not exist yet: resolve the nearest existing ancestor.
  let dir = path.resolve(p);
  const rest = [];
  while (!existsSync(dir)) {
    rest.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(realpathSync(dir), ...rest);
}

/**
 * Throws naming the violation unless the target is a gate/clean-room stack that cannot collide with the demo.
 * `ports` are the host ports the stack will publish.
 */
export function assertSafe({ project, envFile, imageTag, ports = [] } = {}) {
  if (typeof project !== "string" || !PROJECT_RE.test(project) || project === DEMO.project) {
    throw new Error(`assertSafe: refusing compose project "${project}" (must match ${PROJECT_RE})`);
  }
  if (typeof imageTag !== "string" || imageTag === "") {
    throw new Error("assertSafe: refusing an empty image tag (set OCW_IMAGE_TAG)");
  }
  if (imageTag === DEMO.imageTag) {
    throw new Error(`assertSafe: refusing image tag "${DEMO.imageTag}" (the demo's images)`);
  }
  if (!TAG_RE.test(imageTag)) throw new Error(`assertSafe: refusing invalid image tag "${imageTag}"`);
  for (const p of ports) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`assertSafe: refusing invalid port ${p}`);
    if (DEMO.ports.includes(n)) throw new Error(`assertSafe: refusing port ${n} (used by the demo)`);
  }
  if (typeof envFile !== "string" || envFile === "") {
    throw new Error("assertSafe: an explicit env file is required");
  }
  const resolved = path.resolve(envFile);
  const parts = resolved.split(path.sep);
  if (path.basename(resolved) === ".env.demo" || parts.includes(".ocw-demo")) {
    throw new Error(`assertSafe: refusing env file ${resolved} (the demo's)`);
  }
  const tmp = realpathSync(tmpdir());
  const real = realDir(resolved);
  if (!(real.startsWith(`${tmp}${path.sep}`) || real === tmp)) {
    throw new Error(`assertSafe: refusing env file ${resolved} (outside the temp dir ${tmp})`);
  }
}

/** KEY=VALUE lines; surrounding quotes stripped; comments and blank lines ignored. */
export function parseEnvFile(file) {
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

/** Sets each key (replacing its line, or appending) and keeps the file 0600. */
export function setEnvKeys(file, values) {
  const lines = readFileSync(file, "utf8").replace(/\n+$/, "").split("\n");
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
    if (key && Object.hasOwn(values, key)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${key}=${values[key]}`);
    } else out.push(line);
  }
  const added = Object.keys(values).filter((k) => !seen.has(k));
  if (added.length)
    out.push("", "# Gate harness (scripts/gate/lib.mjs)", ...added.map((k) => `${k}=${values[k]}`));
  writeFileSync(file, `${out.join("\n")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Machine-wide gate lock (`fs.openSync(…, "wx")` + PID). Waits while another live process holds it (bounded by
 * `timeoutMs`), reclaims a lock left by a dead PID, and resolves to `release()`.
 */
export async function acquireLock(
  file = DEFAULT_LOCK,
  { timeoutMs = 60 * 60_000, pollMs = 2000, onWait } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: "wx", mode: 0o644 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    } catch {
      continue; // released between our open and read
    }
    // gate:cleanroom runs the clone's compose gate as its child while it holds the lock: the child may run under its
    // parent's lock (and leaves it held), never under anyone else's.
    if (process.env.OCW_GATE_LOCK_INHERIT === "1" && holder === process.ppid) return () => {};
    if (!Number.isNaN(holder) && !pidAlive(holder)) {
      try {
        unlinkSync(file);
      } catch {
        // someone else reclaimed it first
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `acquireLock: ${file} is held by pid ${Number.isNaN(holder) ? "?" : holder} (timed out)`,
      );
    }
    if (!announced && onWait) {
      onWait(`waiting for ${file} (held by pid ${holder})`);
      announced = true;
    }
    await sleep(pollMs);
  }
}

/** Compose files of every gate stack: the e2e override (fake model) and Caddy published on loopback only. */
export const GATE_COMPOSE_FILE = "compose.yaml:compose.e2e.yaml:infra/caddy/compose.loopback.yaml";
/**
 * Sign-in attempts per minute in gate stacks. Behind Caddy on Docker Desktop every client reaches the API as the
 * Docker gateway's address, so all browsers and gate steps share one bucket; the product default stays 30.
 */
export const GATE_SIGNIN_RATE_LIMIT = 600;
const OCW_CLI = path.join(REPO_ROOT, "scripts", "ocw.mjs");

/** `node -- scripts/ocw.mjs <args>` with a minimal environment; output swallowed (it names keys, never values). */
function ocwQuiet(args, label) {
  const res = spawnSync(process.execPath, ["--", OCW_CLI, ...args], {
    cwd: REPO_ROOT,
    env: dockerEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60_000,
  });
  if (res.status !== 0) {
    // stderr carries usage/refusal messages only (ocw never prints a value); keep the last line for the summary.
    const tail = (res.stderr ?? "").trim().split("\n").at(-1) ?? "";
    throw new Error(`createGateEnv: ${label} exited ${res.status}${tail ? `: ${tail}` : ""}`);
  }
}

/**
 * Writes `<dir>/.env` (0600) with the commands operators run (SELF-01, D-03): `ocw setup --ports <block> --project
 * ocw-gate-<runId> --image-tag <tag>` (fresh secrets) and, unless `proxy: false`, `ocw enable proxy --site-address
 * localhost --no-up` (one HTTPS origin https://localhost:<block>43, OCW_TRUST_PROXY=1, loopback publishing). Then only
 * gate keys: GATE_COMPOSE_FILE, COMPOSE_PROFILES (proxy + `profiles`), the mock model, GATE_SIGNIN_RATE_LIMIT and
 * `extra`. Returns the file's path. Prints nothing (command output, which never holds a value, is swallowed).
 */
export function createGateEnv({
  dir,
  runId,
  block = 34,
  imageTag,
  profiles = [],
  proxy = true,
  extra = {},
  sourceCommit = "",
}) {
  if (sourceCommit && !/^[0-9a-f]{40}$/.test(sourceCommit))
    throw new Error("createGateEnv: sourceCommit must be a 40-hex commit or empty");
  const project = `ocw-gate-${runId}`;
  const envFile = path.join(path.resolve(dir), ".env");
  const ports = gatePorts(block);
  assertSafe({ project, envFile, imageTag, ports: Object.values(ports) });
  if (existsSync(envFile)) throw new Error(`createGateEnv: ${envFile} already exists`);
  ocwQuiet(
    ["setup", "--dir", dir, "--ports", String(block), "--project", project, "--image-tag", imageTag],
    "ocw setup",
  );
  if (proxy) {
    ocwQuiet(
      ["enable", "proxy", "--site-address", "localhost", "--no-up", "--env-file", envFile],
      "ocw enable proxy",
    );
  }
  const loop = (p) => `http://127.0.0.1:${p}`;
  const extraProfiles = String(extra.COMPOSE_PROFILES ?? "")
    .split(",")
    .filter(Boolean);
  const allProfiles = [...new Set([...(proxy ? ["proxy"] : []), ...profiles, ...extraProfiles])];
  const values = {
    COMPOSE_FILE: proxy ? GATE_COMPOSE_FILE : "compose.yaml:compose.e2e.yaml",
    OCW_MODEL_PROVIDER: "mock",
    OCW_SIGNIN_RATE_LIMIT_PER_MINUTE: String(GATE_SIGNIN_RATE_LIMIT),
    // api and web publish on loopback only: a gate stack is never reachable from the network.
    OCW_PUBLISH_ADDRESS: "127.0.0.1",
    ...(proxy
      ? {}
      : {
          OCW_PUBLIC_WEB_URL: loop(ports.web),
          OCW_PUBLIC_API_URL: loop(ports.api),
          OCW_S3_PUBLIC_URL: loop(ports.s3),
        }),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
    COMPOSE_PROFILES: allProfiles.join(","),
    // The api image build stamps it into the runtime manifest's source.commit (compose.yaml, ADR-0033).
    ...(sourceCommit ? { OCW_SOURCE_COMMIT: sourceCommit } : {}),
  };
  setEnvKeys(envFile, values);
  const env = parseEnvFile(envFile);
  // What ocw setup wrote must be what the guard checked (project, tag, every port of the block).
  if (env.COMPOSE_PROJECT_NAME !== project || env.OCW_IMAGE_TAG !== imageTag)
    throw new Error("createGateEnv: ocw setup did not write the gate project and image tag");
  for (const [k, key] of Object.entries(PORT_KEYS)) {
    if (env[key] !== String(ports[k])) throw new Error(`createGateEnv: ${key} is not ${ports[k]}`);
  }
  return envFile;
}

/** Playwright JSON report stats must prove that tests ran and that none was skipped, failed or flaky (D-09). */
export function assertPlaywrightStats(stats) {
  const n = (k) => Number(stats?.[k] ?? 0);
  if (!(n("expected") > 0)) throw new Error("Playwright: no test ran (expected 0)");
  const bad = ["skipped", "unexpected", "flaky"].filter((k) => n(k) !== 0);
  if (bad.length) {
    throw new Error(
      `Playwright: ${bad.map((k) => `${n(k)} ${k === "unexpected" ? "unexpected (failed)" : k}`).join(", ")}`,
    );
  }
}

/** `{ stats, projects }` of a Playwright JSON report: the run's totals and the test outcomes per project. */
export function playwrightSummary(json) {
  const s = json?.stats ?? {};
  const stats = {
    expected: s.expected ?? 0,
    skipped: s.skipped ?? 0,
    unexpected: s.unexpected ?? 0,
    flaky: s.flaky ?? 0,
    durationMs: Math.round(s.duration ?? 0),
  };
  const projects = {};
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        projects[t.projectName] ??= { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
        const p = projects[t.projectName];
        if (t.status in p) p[t.status] += 1;
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of json?.suites ?? []) walk(suite);
  return { stats, projects };
}

/**
 * Trusts the proxy stack's Caddy local root for this process (fetch / https), read from the caddy container. Caddy
 * makes a new root whenever its data volume is new (`down -v`, a restore onto fresh volumes), so steps call this
 * after such a change. TLS verification stays on. Returns a short fingerprint of the root.
 */
export async function trustCaddyRoot(ctx, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = ctx.compose(["exec", "-T", "caddy", "cat", "/data/caddy/pki/authorities/local/root.crt"]);
    const pem = res.status === 0 ? (res.stdout ?? "").trim() : "";
    if (pem.startsWith("-----BEGIN CERTIFICATE-----")) {
      tls.setDefaultCACertificates([...tls.getCACertificates("default"), pem]);
      return createHash("sha256").update(pem).digest("hex").slice(0, 16);
    }
    if (Date.now() >= deadline) throw new Error("trustCaddyRoot: no local root in the caddy container");
    await sleep(1000);
  }
}

/** True when the stack runs behind the `proxy` profile on an https origin. */
export function behindProxy(ctx) {
  return (
    (ctx.env.COMPOSE_PROFILES ?? "").split(",").includes("proxy") &&
    (ctx.env.OCW_PUBLIC_WEB_URL ?? "").startsWith("https://")
  );
}

/** Host ports an env file makes compose publish (missing core keys fall back to compose's defaults = the demo's). */
export function portsFromEnv(env) {
  const ports = {};
  for (const [k, key] of Object.entries(PORT_KEYS)) {
    const v = env[key];
    if (v !== undefined && v !== "") ports[k] = Number(v);
    else if (COMPOSE_DEFAULT_PORTS[k] !== undefined) ports[k] = COMPOSE_DEFAULT_PORTS[k];
  }
  return ports;
}

/** Only what docker needs: inherited OCW_* / COMPOSE_* variables would override the env file. */
function dockerEnv() {
  const env = {};
  for (const k of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
  ]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

function run(cmd, args, { cwd = REPO_ROOT, stdio = "pipe", input, timeoutMs, check = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env: dockerEnv(),
    encoding: "utf8",
    stdio: input !== undefined && stdio === "pipe" ? ["pipe", "pipe", "pipe"] : stdio,
    input,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (check && res.status !== 0) {
    const tail = (res.stderr ?? "").trim().split("\n").slice(-20).join("\n");
    const err = new Error(
      `${cmd} ${args.slice(0, 8).join(" ")} … exited ${res.status}${tail ? `\n${tail}` : ""}`,
    );
    err.result = res;
    throw err;
  }
  return res;
}

function ctxSafety(ctx) {
  assertSafe({
    project: ctx.project,
    envFile: ctx.envFile,
    imageTag: ctx.imageTag,
    ports: Object.values(ctx.ports),
  });
}

/**
 * `docker compose --project-directory <dir> --env-file <ctx.envFile> -p <ctx.project> -f … <args>` after
 * `assertSafe`. opts: { stdio, input, timeoutMs, check }.
 */
export function composeCmd(ctx, args, opts = {}) {
  ctxSafety(ctx);
  const files = (ctx.env?.COMPOSE_FILE || "compose.yaml").split(":").filter(Boolean);
  const full = [
    "compose",
    "--project-directory",
    ctx.projectDir,
    "--env-file",
    ctx.envFile,
    "-p",
    ctx.project,
    ...files.flatMap((f) => ["-f", path.resolve(ctx.projectDir, f)]),
    ...args,
  ];
  return run("docker", full, { cwd: ctx.projectDir, ...opts });
}

/** A plain `docker …` call scoped to this ctx (assertSafe first). */
export function dockerCmd(ctx, args, opts = {}) {
  ctxSafety(ctx);
  return run("docker", args, opts);
}

/**
 * The context every gate step receives. `env` (secrets) is not enumerable so it never ends up in a JSON summary.
 * projectDir: the env file's directory when it holds a compose.yaml (a clean-room clone), else this repository.
 */
export function gateContext(envFile, { projectDir, steps = [] } = {}) {
  const dir = path.dirname(path.resolve(envFile));
  const ctx = {
    envFile: path.resolve(envFile),
    dir,
    projectDir: projectDir ?? (existsSync(path.join(dir, "compose.yaml")) ? dir : REPO_ROOT),
    steps,
  };
  ctx.reload = () => {
    const env = parseEnvFile(ctx.envFile);
    Object.defineProperty(ctx, "env", { value: env, enumerable: false, configurable: true, writable: true });
    ctx.project = env.COMPOSE_PROJECT_NAME;
    ctx.imageTag = env.OCW_IMAGE_TAG;
    ctx.ports = portsFromEnv(env);
    const loop = (p) => `http://127.0.0.1:${p}`;
    ctx.urls = {
      web: loop(ctx.ports.web),
      api: loop(ctx.ports.api),
      s3: loop(ctx.ports.s3),
      public: env.OCW_PUBLIC_WEB_URL || loop(ctx.ports.web),
    };
    ctxSafety(ctx);
    return ctx;
  };
  ctx.compose = (args, opts) => composeCmd(ctx, args, opts);
  ctx.docker = (args, opts) => dockerCmd(ctx, args, opts);
  /** Runs SQL as the postgres superuser in this project's postgres; returns stdout (-At). */
  ctx.psql = (sql) =>
    composeCmd(
      ctx,
      [
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "ocw",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        sql,
      ],
      { check: true },
    ).stdout;
  return ctx.reload();
}

/** gate-<sha12>[-dirty]-<runId>: unique per run, so teardown only ever removes this run's images. */
export function gateImageTag(runId) {
  const sha = run("git", ["rev-parse", "--short=12", "HEAD"], { check: true }).stdout.trim();
  const dirty = run("git", ["status", "--porcelain"], { check: true }).stdout.trim() !== "";
  return `gate-${sha}${dirty ? "-dirty" : ""}-${runId}`;
}

/** The full HEAD commit when the tree is clean, else "" (a dirty tree has no commit that is its source). */
export function gateSourceCommit() {
  const dirty = run("git", ["status", "--porcelain"], { check: true }).stdout.trim() !== "";
  return dirty ? "" : run("git", ["rev-parse", "HEAD"], { check: true }).stdout.trim();
}

export function newRunId() {
  return `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

/** Resolves true when nothing accepts connections on 127.0.0.1:<port>. */
export function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
    s.setTimeout(1500, () => {
      s.destroy();
      resolve(true);
    });
  });
}

/** Images of this run only: ocw-*:<imageTag>, and only when the tag carries the run id. */
export function runImages(ctx, runId) {
  if (!runId || !ctx.imageTag.endsWith(`-${runId}`)) return [];
  const res = dockerCmd(
    ctx,
    ["images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", "reference=ocw-*"],
    {
      check: true,
    },
  );
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((ref) => ref.endsWith(`:${ctx.imageTag}`) && ref.startsWith("ocw-"));
}

/**
 * Free bytes on the Docker host's disk (the Desktop VM on macOS), read with `df` in a throwaway postgres:18 container
 * named after the run (the stack pulls that image anyway). Docker filled its disk before; a full disk takes the demo
 * down with it, so gate runs refuse to start below a floor.
 */
export function dockerFreeBytes(ctx, runId) {
  const res = dockerCmd(
    ctx,
    ["run", "--rm", "--name", `ocw-gate-${runId}-df`, "--entrypoint", "df", "postgres:18", "-Pk", "/"],
    { check: true, timeoutMs: 5 * 60_000 },
  );
  const line = res.stdout.trim().split("\n").at(-1) ?? "";
  const avail = Number(line.trim().split(/\s+/)[3]);
  if (!Number.isFinite(avail)) throw new Error("dockerFreeBytes: unreadable df output");
  return avail * 1024;
}

/** BuildKit cache records (default builder): id → { shared, inUse, createdAt }. */
export function buildCacheRecords(ctx) {
  const res = dockerCmd(ctx, ["buildx", "du", "--format", "json"], { check: true });
  const records = new Map();
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      records.set(r.ID, {
        shared: r.Shared === true,
        inUse: r.InUse === true,
        createdAt: Date.parse(r.CreatedAt),
      });
    } catch {
      // not a record line
    }
  }
  return records;
}

/**
 * Removes the build-cache records this run created (absent from `before`, created after `sinceMs`, not shared with
 * an image, not in use). Never touches older cache. Records form parent chains and a parent is only removable once
 * its children are gone, so it repeats until a pass removes nothing. Returns how many records were removed.
 */
export function pruneRunBuildCache(ctx, before, sinceMs) {
  const fresh = () =>
    [...buildCacheRecords(ctx)].filter(
      ([id, r]) => !before.has(id) && !r.shared && !r.inUse && !(r.createdAt < sinceMs - 60_000),
    );
  let left = fresh();
  const initial = left.length;
  for (let pass = 0; pass < 50 && left.length > 0; pass++) {
    for (const [id] of left) dockerCmd(ctx, ["buildx", "prune", "-f", "--filter", `id=${id}`]);
    const next = fresh();
    if (next.length >= left.length) break;
    left = next;
  }
  return initial - left.length;
}

async function timed(steps, name, fn) {
  const t0 = Date.now();
  try {
    const details = await fn();
    steps.push({ name, ok: true, ms: Date.now() - t0, ...(details ? { details } : {}) });
    return details;
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - t0, details: String(err.message ?? err).slice(0, 2000) });
    throw err;
  }
}

/** Diagnostics on a failed boot: container states and the last log lines of every service (stderr). */
function dumpDiagnostics(ctx) {
  const ps = ctx.compose(["ps", "-a", "--format", "table {{.Service}}\t{{.State}}\t{{.Status}}"]);
  process.stderr.write(`${ps.stdout ?? ""}\n`);
  const logs = ctx.compose(["logs", "--no-color", "--tail", "60"]);
  process.stderr.write(`${(logs.stdout ?? "").slice(-20000)}\n`);
}

/**
 * Bot sandbox objects of this stack (07.8-24): sandboxd creates each bot's containers, networks and volumes, and the
 * namespace's egress proxy, outside compose, labelled `ocw.namespace=<project>` (compose.yaml's default namespace).
 * `compose down` never sees them; they are removed by that label only, never a prune and never another namespace.
 * Returns how many objects were left after removal (0 = clean).
 */
export function removeSandboxObjects(ctx) {
  const label = `label=ocw.namespace=${ctx.project}`;
  const list = (args) =>
    (ctx.docker(args).stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const containers = () => list(["ps", "-aq", "--filter", label]);
  const volumes = () => list(["volume", "ls", "-q", "--filter", label]);
  const networks = () => list(["network", "ls", "-q", "--filter", label]);
  const c = containers();
  if (c.length) ctx.docker(["rm", "-fv", ...c], { timeoutMs: 5 * 60_000 });
  const n = networks();
  if (n.length) ctx.docker(["network", "rm", ...n]);
  const v = volumes();
  if (v.length) ctx.docker(["volume", "rm", "-f", ...v]);
  return containers().length + volumes().length + networks().length;
}

function teardown(ctx, runId, steps, { removeDir = true } = {}) {
  const t0 = Date.now();
  // Sandboxes first: an egress proxy or a bot container holds no compose network, but its own networks must go.
  const sandboxLeft = removeSandboxObjects(ctx);
  const down = ctx.compose(["down", "-v", "--remove-orphans", "--timeout", "30"], { timeoutMs: 10 * 60_000 });
  const images = runImages(ctx, runId);
  const failed = [];
  for (const ref of images) {
    const r = ctx.docker(["image", "rm", ref]);
    if (r.status !== 0) failed.push(ref);
  }
  if (removeDir) rmSync(ctx.dir, { recursive: true, force: true });
  const ok = down.status === 0 && failed.length === 0 && sandboxLeft === 0;
  steps.push({
    name: "teardown",
    ok,
    ms: Date.now() - t0,
    details: {
      removedImages: images.length - failed.length,
      ...(failed.length ? { failed } : {}),
      ...(sandboxLeft ? { sandboxObjectsLeft: sandboxLeft } : {}),
    },
  });
  return ok;
}

/**
 * Tears down a gate stack left by --keep: down -v --remove-orphans, its ocw-*:<tag> images (only when the tag carries
 * the run id) and the env file's temp directory. Only ocw-gate-* projects (clean-room clones clean up themselves).
 */
export async function teardownGateStack(envFile, { steps = [], lockFile = DEFAULT_LOCK, log } = {}) {
  const ctx = gateContext(envFile, { steps });
  const m = /^ocw-gate-(.+)$/.exec(ctx.project);
  if (!m) throw new Error(`teardownGateStack: ${ctx.project} is not an ocw-gate project`);
  const snapshotFile = path.join(ctx.dir, CACHE_SNAPSHOT);
  const snapshot = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, "utf8")) : null;
  const release = await acquireLock(lockFile, { onWait: log });
  try {
    const ok = teardown(ctx, m[1], steps);
    if (snapshot) {
      const t0 = Date.now();
      const pruned = pruneRunBuildCache(ctx, new Set(snapshot.ids), snapshot.since);
      steps.push({ name: "build-cache", ok: true, ms: Date.now() - t0, details: { prunedRecords: pruned } });
    }
    return ok;
  } finally {
    release();
  }
}

/**
 * lock → env → build (OCW_IMAGE_TAG=gate-<sha>[-dirty]-<runId>) → up -d --wait → fn(ctx) → down -v --remove-orphans
 * + image rm ocw-*:<tag> (unless keep) → release lock. With `attachEnvFile`, runs fn against that stack only (no
 * build, up or teardown). Harness steps are pushed to `steps` (also ctx.steps); returns fn's result.
 */
export async function withGateStack(
  {
    runId = newRunId(),
    profiles = [],
    extra = {},
    keep = false,
    attachEnvFile,
    build = true,
    block = 34,
    steps = [],
    lockFile = DEFAULT_LOCK,
    waitTimeoutS = 1200,
    minFreeGb = Number(process.env.OCW_GATE_MIN_FREE_GB ?? 6),
    pruneBuildCache = process.env.OCW_GATE_KEEP_BUILD_CACHE !== "1",
    log = (m) => process.stderr.write(`[gate] ${m}\n`),
  } = {},
  fn,
) {
  if (attachEnvFile) {
    const ctx = gateContext(attachEnvFile, { steps });
    const release = await acquireLock(lockFile, { onWait: log });
    try {
      return await fn(ctx);
    } finally {
      release();
    }
  }

  const imageTag = gateImageTag(runId);
  // Validate before taking the lock or writing anything.
  assertSafe({
    project: `ocw-gate-${runId}`,
    envFile: path.join(tmpdir(), "x.env"),
    imageTag,
    ports: Object.values(gatePorts(block)),
  });
  const release = await acquireLock(lockFile, { onWait: log });
  const dir = mkdtempSync(path.join(tmpdir(), `ocw-gate-${runId}-`));
  let ctx;
  let tornDown = false;
  let cacheBefore;
  let cacheSince = 0;
  const onSignal = (sig) => {
    log(`${sig}: tearing down ocw-gate-${runId}`);
    if (ctx && !keep && !tornDown) {
      tornDown = true;
      teardown(ctx, runId, steps);
    }
    release();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const envFile = createGateEnv({
      dir,
      runId,
      block,
      imageTag,
      profiles,
      extra,
      sourceCommit: gateSourceCommit(),
    });
    ctx = gateContext(envFile, { steps });
    log(`project ${ctx.project}, tag ${ctx.imageTag}, web ${ctx.urls.web}, api ${ctx.urls.api}`);
    await timed(steps, "ports-free", async () => {
      const busy = [];
      for (const p of Object.values(ctx.ports)) if (!(await portFree(p))) busy.push(p);
      if (busy.length) throw new Error(`ports already in use: ${busy.join(", ")}`);
    });
    await timed(steps, "disk-free", async () => {
      const free = dockerFreeBytes(ctx, runId);
      const gb = Math.round((free / 1024 ** 3) * 10) / 10;
      if (gb < minFreeGb) throw new Error(`Docker disk has ${gb} GB free; the gate needs ${minFreeGb} GB`);
      return { freeGb: gb };
    });
    if (build && pruneBuildCache) {
      cacheBefore = buildCacheRecords(ctx);
      cacheSince = Date.now();
      // A --keep stack is torn down later by teardownGateStack, which prunes this run's cache from this snapshot.
      if (keep) {
        writeFileSync(
          path.join(ctx.dir, CACHE_SNAPSHOT),
          JSON.stringify({ since: cacheSince, ids: [...cacheBefore.keys()] }),
          { mode: 0o600 },
        );
      }
    }
    if (build) {
      await timed(steps, "build", async () => {
        log("building images (the openclaw cell is ~5 GB on a cold cache)");
        // Build output goes to stderr so stdout stays a clean JSON summary.
        ctx.compose(["build"], { stdio: ["ignore", 2, 2], check: true, timeoutMs: 90 * 60_000 });
        const images = {};
        for (const ref of runImages(ctx, runId)) {
          const size = Number(ctx.docker(["image", "inspect", "--format", "{{.Size}}", ref]).stdout);
          images[ref] = `${Math.round(size / 1024 ** 2)} MB`;
        }
        return { images };
      });
    }
    await timed(steps, "up", async () => {
      log("starting the stack (up -d --wait)");
      const res = ctx.compose(["up", "-d", "--wait", "--wait-timeout", String(waitTimeoutS)], {
        stdio: ["ignore", 2, 2],
        timeoutMs: (waitTimeoutS + 300) * 1000,
      });
      if (res.status !== 0) {
        dumpDiagnostics(ctx);
        throw new Error(`docker compose up --wait exited ${res.status}`);
      }
    });
    return await fn(ctx);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (keep && ctx) {
      log(`--keep: stack ${ctx.project} left running; attach with --attach ${ctx.envFile}`);
    } else if (ctx && !tornDown) {
      tornDown = true;
      log(`tearing down ${ctx.project}`);
      teardown(ctx, runId, steps);
      if (cacheBefore) {
        const t0 = Date.now();
        try {
          const pruned = pruneRunBuildCache(ctx, cacheBefore, cacheSince);
          steps.push({
            name: "build-cache",
            ok: true,
            ms: Date.now() - t0,
            details: { prunedRecords: pruned },
          });
        } catch (err) {
          steps.push({
            name: "build-cache",
            ok: false,
            ms: Date.now() - t0,
            details: String(err.message ?? err),
          });
        }
      }
    } else if (!ctx) {
      rmSync(dir, { recursive: true, force: true });
    }
    release();
  }
}

/**
 * Read-only fingerprint of the demo: every `<repo>:local` image id, the demo project's and `ocw-demo-*` containers
 * (id + state) and whether its web/api ports answer. Equal before and after = the gate left the demo alone.
 */
export async function demoSnapshot() {
  const images = run("docker", ["images", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"], {
    check: true,
  })
    .stdout.split("\n")
    .filter((l) => /:local /.test(l))
    .sort();
  const containers = [];
  for (const filter of [`label=com.docker.compose.project=${DEMO.project}`, "name=ocw-demo-"]) {
    const res = run(
      "docker",
      ["ps", "-a", "--no-trunc", "--filter", filter, "--format", "{{.Names}} {{.ID}} {{.State}}"],
      {
        check: true,
      },
    );
    containers.push(...res.stdout.split("\n").filter(Boolean));
  }
  const ports = {};
  for (const p of [3000, 4000]) ports[p] = !(await portFree(p));
  return { images, containers: [...new Set(containers)].sort(), ports };
}

/** Differences between two demo snapshots (empty = untouched). */
export function diffDemo(before, after) {
  const diff = [];
  const cmp = (label, a, b) => {
    for (const x of a) if (!b.includes(x)) diff.push(`${label} gone or changed: ${x}`);
    for (const x of b) if (!a.includes(x)) diff.push(`${label} new: ${x}`);
  };
  cmp("image", before.images, after.images);
  cmp("container", before.containers, after.containers);
  for (const p of Object.keys(before.ports)) {
    if (before.ports[p] !== after.ports[p])
      diff.push(`port ${p} listening ${before.ports[p]} → ${after.ports[p]}`);
  }
  return diff;
}

/** A tiny cookie-jar client for the API (Origin = the public web origin, as better-auth requires). */
export class ApiClient {
  constructor(baseUrl, origin) {
    this.baseUrl = baseUrl;
    this.origin = origin;
    this.cookies = new Map();
  }

  async request(method, pathname, body, headers = {}) {
    const h = { origin: this.origin, ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v === "" || /max-age=0/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }
}

/**
 * First-run setup through the API with the env's setup token if not done yet, else sign in. Returns
 * { client, created, me }: a signed-in ApiClient for the shared admin (ADMIN, the Playwright setup spec's user).
 */
export async function ensureAdmin(ctx, admin = ADMIN) {
  const client = new ApiClient(ctx.urls.api, ctx.env.OCW_PUBLIC_WEB_URL || ctx.urls.web);
  const status = await client.request("GET", "/api/v1/setup/status");
  if (status.status !== 200) throw new Error(`ensureAdmin: setup/status returned ${status.status}`);
  let created = false;
  if (!status.body?.setupComplete) {
    const res = await client.request("POST", "/api/v1/setup", { token: ctx.env.OCW_SETUP_TOKEN, ...admin });
    if (res.status === 200) created = true;
    else if (res.status !== 409) throw new Error(`ensureAdmin: setup returned ${res.status}`);
  }
  if (!created) {
    const res = await client.request("POST", "/api/auth/sign-in/email", {
      email: admin.email,
      password: admin.password,
    });
    if (res.status !== 200) throw new Error(`ensureAdmin: sign-in returned ${res.status}`);
  }
  const me = await client.request("GET", "/api/v1/me");
  if (me.status !== 200) throw new Error(`ensureAdmin: /api/v1/me returned ${me.status}`);
  return { client, created, me: me.body };
}
