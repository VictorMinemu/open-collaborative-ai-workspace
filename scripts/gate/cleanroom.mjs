#!/usr/bin/env node
// Clean-room install gate (`pnpm gate:cleanroom`; Phase 7: SELF-01, D-10, D-11). Proves that a fresh clone installs
// with exactly the commands docs/INSTALL.md documents and that the result passes the compose gate:
//
//   git clone --no-local <this repo> <tmp>/ocw-cleanroom-<id>-*/ocw && git checkout --detach <HEAD>
//   (in the clone) pnpm ocw setup --ports NN --project ocw-cleanroom-<id> --image-tag cleanroom-<sha12>-<id>
//   (in the clone) pnpm ocw enable proxy --site-address localhost --no-up
//   gate-only keys in the clone's .env: compose.e2e.yaml (mock model), Caddy on loopback, sign-in limit
//   (in the clone) docker compose up -d --build --wait            ← the documented command, unchanged
//   (in the clone) pnpm install --frozen-lockfile                  ← gate tooling only (Playwright), after the install
//   (in the clone) node scripts/gate/compose-gate.mjs --attach <clone>/.env   ← the clone's own gate, under our lock
//   always: down -v --remove-orphans, rm the run's ocw-*:<tag> images and build cache, rm the temp directory
//
//   pnpm gate:cleanroom [--block NN] [--run-id ID] [--keep]
//   pnpm gate:cleanroom --down <clone>/.env                         tears down a stack left by --keep
//
// It refuses a dirty working tree (the clone tests commits, not edits) and never reads this checkout's .env. Every
// Docker call is checked by lib.mjs's assertSafe (ocw-cleanroom-* project, NN-block ports, never the `local` tag, env
// file under the temp dir), and `docker compose config` of the clone is checked before the documented `up` runs
// without -p. Secret values are never printed (ocw prints key names; the env is never echoed).
//
// stdout: one JSON summary { ok, runId, sha, project, imageTag, urls, totalMs, steps: [{ name, ok, ms, details }],
// gate: <compose-gate summary> }. Progress, install and build output go to stderr. Exit 0 = every step ok.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  acquireLock,
  assertSafe,
  buildCacheRecords,
  DEFAULT_LOCK,
  demoSnapshot,
  diffDemo,
  dockerFreeBytes,
  GATE_COMPOSE_FILE,
  GATE_SIGNIN_RATE_LIMIT,
  gateContext,
  gatePorts,
  newRunId,
  parseEnvFile,
  portFree,
  pruneRunBuildCache,
  REPO_ROOT,
  runImages,
  setEnvKeys,
} from "./lib.mjs";

const PROJECT_PREFIX = "ocw-cleanroom-";
const CACHE_SNAPSHOT = "build-cache-before.json";

/** Project, image tag and temp-dir prefix of one clean-room run. */
export function cleanroomNames(sha, runId) {
  if (!/^[0-9a-f]{12,40}$/.test(sha)) throw new Error(`cleanroom: invalid sha ${sha}`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(runId)) throw new Error(`cleanroom: invalid run id ${runId}`);
  return {
    project: `${PROJECT_PREFIX}${runId}`,
    // The run id is in the tag so teardown only ever removes this run's images (07-03's rule).
    imageTag: `cleanroom-${sha.slice(0, 12)}-${runId}`,
    dirPrefix: `${PROJECT_PREFIX}${runId}-`,
  };
}

/** The keys the gate adds to the clone's .env after the operator commands (never secrets, never ports). */
export function gateKeys() {
  return {
    COMPOSE_FILE: GATE_COMPOSE_FILE,
    OCW_MODEL_PROVIDER: "mock",
    OCW_SIGNIN_RATE_LIMIT_PER_MINUTE: String(GATE_SIGNIN_RATE_LIMIT),
    OCW_PUBLISH_ADDRESS: "127.0.0.1",
  };
}

/**
 * Checks `docker compose config --format json` of the clone before the documented `up` (which runs without -p and
 * reads the clone's .env): the project, every published port and every locally built image must be the run's.
 * Returns { ports, images }; throws naming the first violation.
 */
export function checkComposeConfig(config, { project, imageTag, ports }) {
  if (config?.name !== project)
    throw new Error(`compose config: project "${config?.name}" is not "${project}"`);
  const published = [];
  const images = [];
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    for (const p of svc.ports ?? []) {
      const n = Number(p.published);
      if (!Number.isInteger(n)) throw new Error(`compose config: ${name} publishes an unpinned port`);
      if (!ports.includes(n))
        throw new Error(`compose config: ${name} publishes ${n}, outside the run's block`);
      published.push(n);
    }
    const image = String(svc.image ?? "");
    if (image.startsWith("ocw-")) {
      if (!image.endsWith(`:${imageTag}`)) throw new Error(`compose config: ${name} uses image ${image}`);
      images.push(image);
    }
  }
  if (images.length === 0) throw new Error("compose config: no ocw-* image to build");
  return { ports: [...new Set(published)].sort((a, b) => a - b), images: [...new Set(images)].sort() };
}

/** Only what git, pnpm and docker need: inherited OCW_* / COMPOSE_* variables would override the clone's .env. */
function minimalEnv(extra = {}) {
  const env = {};
  for (const k of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "SHELL",
    "PNPM_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "COREPACK_HOME",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "PLAYWRIGHT_BROWSERS_PATH",
  ]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return { ...env, ...extra };
}

function sh(cmd, args, { cwd, stdio = "pipe", timeoutMs, env = minimalEnv() } = {}) {
  // pnpm through /bin/sh: some pnpm installs are shell stubs without a shebang (a direct spawn fails with ENOEXEC).
  // Arguments are passed as "$@", never interpolated into the command string.
  const [file, argv] = cmd === "pnpm" ? ["/bin/sh", ["-c", 'exec pnpm "$@"', "pnpm", ...args]] : [cmd, args];
  return spawnSync(file, argv, {
    cwd,
    env,
    encoding: "utf8",
    stdio,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
}

function must(res, label) {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  if (res.status !== 0) {
    const tail = String(res.stderr ?? "")
      .trim()
      .split("\n")
      .slice(-5)
      .join("\n");
    throw new Error(`${label} exited ${res.status ?? res.signal}${tail ? `: ${tail}` : ""}`);
  }
  return res;
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

/** The run's temp root (parent of the clone), only when it is ours: under the temp dir, named ocw-cleanroom-<id>-*. */
function runRoot(clone, runId) {
  const root = path.dirname(path.resolve(clone));
  const tmp = realpathSync(tmpdir());
  const ok =
    path.basename(root).startsWith(`${PROJECT_PREFIX}${runId}-`) &&
    realpathSync(root).startsWith(`${tmp}${path.sep}`);
  if (!ok) throw new Error(`cleanroom: refusing to remove ${root}`);
  return root;
}

/** down -v --remove-orphans, the run's images, its build cache (from the snapshot) and the temp root. */
function teardown(ctx, runId, steps, cache) {
  const t0 = Date.now();
  const down = ctx.compose(["down", "-v", "--remove-orphans", "--timeout", "30"], { timeoutMs: 10 * 60_000 });
  const images = runImages(ctx, runId);
  const failed = images.filter((ref) => ctx.docker(["image", "rm", ref]).status !== 0);
  let pruned = 0;
  if (cache) pruned = pruneRunBuildCache(ctx, cache.before, cache.since);
  rmSync(runRoot(ctx.dir, runId), { recursive: true, force: true });
  const ok = down.status === 0 && failed.length === 0;
  steps.push({
    name: "teardown",
    ok,
    ms: Date.now() - t0,
    details: {
      removedImages: images.length - failed.length,
      prunedCacheRecords: pruned,
      ...(failed.length ? { failed } : {}),
    },
  });
  return ok;
}

async function down(envFile) {
  const steps = [];
  const ctx = gateContext(envFile, { steps });
  const m = /^ocw-cleanroom-(.+)$/.exec(ctx.project);
  if (!m) throw new Error(`cleanroom --down: ${ctx.project} is not an ocw-cleanroom project`);
  const snapFile = path.join(path.dirname(ctx.dir), CACHE_SNAPSHOT);
  const snap = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, "utf8")) : null;
  const release = await acquireLock(DEFAULT_LOCK);
  try {
    teardown(ctx, m[1], steps, snap ? { before: new Set(snap.ids), since: snap.since } : null);
  } finally {
    release();
  }
  return { ok: steps.every((s) => s.ok), steps };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "run-id": { type: "string" },
      block: { type: "string", default: "34" },
      keep: { type: "boolean", default: false },
      down: { type: "string" },
    },
  });
  const log = (m) => process.stderr.write(`[cleanroom] ${m}\n`);
  if (values.down) {
    const out = await down(values.down);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exitCode = out.ok ? 0 : 1;
    return;
  }

  const dirty = must(sh("git", ["status", "--porcelain"], { cwd: REPO_ROOT }), "git status").stdout.trim();
  if (dirty) {
    process.stderr.write(
      "cleanroom: the working tree is dirty; commit first (the clone tests commits, not edits)\n",
    );
    process.exitCode = 2;
    return;
  }
  const sha = must(sh("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }), "git rev-parse").stdout.trim();
  const runId = values["run-id"] ?? newRunId();
  const block = Number(values.block);
  const { project, imageTag, dirPrefix } = cleanroomNames(sha, runId);
  const ports = gatePorts(block);
  // Validate before taking the lock or writing anything.
  assertSafe({ project, envFile: path.join(tmpdir(), "x.env"), imageTag, ports: Object.values(ports) });

  const started = Date.now();
  const steps = [];
  const before = await demoSnapshot();
  const release = await acquireLock(DEFAULT_LOCK, { onWait: log });
  const root = mkdtempSync(path.join(tmpdir(), dirPrefix));
  const clone = path.join(root, "ocw");
  const envFile = path.join(clone, ".env");
  let ctx;
  let cache;
  let gate;
  let error;
  let tornDown = false;
  const onSignal = (sig) => {
    log(`${sig}: tearing down ${project}`);
    if (ctx && !values.keep && !tornDown) {
      tornDown = true;
      teardown(ctx, runId, steps, cache);
    }
    release();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await timed(steps, "clone", async () => {
      must(
        sh("git", ["clone", "--quiet", "--no-local", REPO_ROOT, clone], { timeoutMs: 10 * 60_000 }),
        "git clone",
      );
      must(sh("git", ["checkout", "--quiet", "--detach", sha], { cwd: clone }), "git checkout");
      return { sha: sha.slice(0, 12), envFileExisted: existsSync(envFile) };
    });
    if (existsSync(envFile)) throw new Error("cleanroom: the clone already has a .env");
    await timed(steps, "ports-free", async () => {
      const busy = [];
      for (const p of Object.values(ports)) if (!(await portFree(p))) busy.push(p);
      if (busy.length) throw new Error(`ports already in use: ${busy.join(", ")}`);
    });
    // The documented install, step 1: pnpm ocw setup (pnpm may install the workspace first in a fresh clone).
    await timed(steps, "ocw-setup", async () => {
      log(`pnpm ocw setup --ports ${block} --project ${project} --image-tag ${imageTag}`);
      const args = ["ocw", "setup", "--ports", String(block), "--project", project, "--image-tag", imageTag];
      must(
        sh("pnpm", args, { cwd: clone, stdio: ["ignore", 2, "pipe"], timeoutMs: 30 * 60_000 }),
        "pnpm ocw setup",
      );
      return { nodeModules: existsSync(path.join(clone, "node_modules")) };
    });
    await timed(steps, "ocw-enable-proxy", async () => {
      const args = ["ocw", "enable", "proxy", "--site-address", "localhost", "--no-up"];
      must(
        sh("pnpm", args, { cwd: clone, stdio: ["ignore", 2, "pipe"], timeoutMs: 10 * 60_000 }),
        "pnpm ocw enable proxy",
      );
    });
    await timed(steps, "gate-keys", async () => {
      setEnvKeys(envFile, gateKeys());
      const env = parseEnvFile(envFile);
      if (env.COMPOSE_PROJECT_NAME !== project || env.OCW_IMAGE_TAG !== imageTag)
        throw new Error("ocw setup did not write the run's project and image tag");
      if (!(env.COMPOSE_PROFILES ?? "").split(",").includes("proxy"))
        throw new Error("ocw enable proxy did not add the proxy profile");
      return { keys: Object.keys(gateKeys()) };
    });
    ctx = gateContext(envFile, { steps });
    if (ctx.projectDir !== clone)
      throw new Error(`cleanroom: project dir ${ctx.projectDir} is not the clone`);
    await timed(steps, "disk-free", async () => {
      const gb = Math.round((dockerFreeBytes(ctx, runId) / 1024 ** 3) * 10) / 10;
      const min = Number(process.env.OCW_GATE_MIN_FREE_GB ?? 6);
      if (gb < min) throw new Error(`Docker disk has ${gb} GB free; the gate needs ${min} GB`);
      return { freeGb: gb };
    });
    await timed(steps, "compose-config", async () => {
      const res = must(
        sh("docker", ["compose", "config", "--format", "json"], { cwd: clone }),
        "docker compose config",
      );
      return checkComposeConfig(JSON.parse(res.stdout), {
        project,
        imageTag,
        ports: Object.values(ctx.ports),
      });
    });
    if (process.env.OCW_GATE_KEEP_BUILD_CACHE !== "1") {
      cache = { before: buildCacheRecords(ctx), since: Date.now() };
      if (values.keep)
        writeFileSync(
          path.join(root, CACHE_SNAPSHOT),
          JSON.stringify({ since: cache.since, ids: [...cache.before.keys()] }),
          { mode: 0o600 },
        );
    }
    // The documented install, step 2, exactly as written (project, ports and tag come from the clone's .env).
    await timed(steps, "compose-up", async () => {
      log("docker compose up -d --build --wait (the openclaw cell is ~1.2 GB; first builds are slow)");
      const res = sh("docker", ["compose", "up", "-d", "--build", "--wait"], {
        cwd: clone,
        stdio: ["ignore", 2, 2],
        timeoutMs: 90 * 60_000,
      });
      if (res.status !== 0) {
        const ps = ctx.compose(["ps", "-a", "--format", "table {{.Service}}\t{{.State}}\t{{.Status}}"]);
        const logs = ctx.compose(["logs", "--no-color", "--tail", "60"]);
        process.stderr.write(`${ps.stdout ?? ""}\n${String(logs.stdout ?? "").slice(-20000)}\n`);
        throw new Error(`docker compose up -d --build --wait exited ${res.status ?? res.signal}`);
      }
      return { images: runImages(ctx, runId) };
    });
    await timed(steps, "gate-tooling", async () => {
      must(
        sh("pnpm", ["install", "--frozen-lockfile"], {
          cwd: clone,
          stdio: ["ignore", 2, "pipe"],
          timeoutMs: 30 * 60_000,
        }),
        "pnpm install --frozen-lockfile",
      );
    });
    // The clone's own compose gate against the installed stack; it runs under this process's lock.
    await timed(steps, "compose-gate", async () => {
      log("node scripts/gate/compose-gate.mjs --attach <clone>/.env");
      const extra = { OCW_GATE_LOCK_INHERIT: "1" };
      if (process.env.OCW_E2E_SCREENSHOT_DIR)
        extra.OCW_E2E_SCREENSHOT_DIR = path.resolve(process.env.OCW_E2E_SCREENSHOT_DIR);
      const res = sh(
        process.execPath,
        [path.join(clone, "scripts/gate/compose-gate.mjs"), "--attach", envFile],
        {
          cwd: clone,
          env: minimalEnv(extra),
          stdio: ["ignore", "pipe", 2],
          timeoutMs: 90 * 60_000,
        },
      );
      try {
        gate = JSON.parse(res.stdout);
      } catch {
        throw new Error(`compose gate exited ${res.status ?? res.signal} without a JSON summary`);
      }
      if (res.status !== 0 || gate.ok !== true) {
        const failed = (gate.steps ?? []).filter((s) => !s.ok).map((s) => s.name);
        throw new Error(`compose gate failed: ${failed.join(", ") || `exit ${res.status}`}`);
      }
      return {
        stages: gate.stages,
        playwright: gate.playwright
          ? {
              expected: gate.playwright.expected,
              skipped: gate.playwright.skipped,
              unexpected: gate.playwright.unexpected,
              flaky: gate.playwright.flaky,
            }
          : null,
      };
    });
  } catch (err) {
    error = String(err.message ?? err).slice(0, 2000);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (values.keep && ctx) {
      log(`--keep: ${project} left running; tear down with pnpm gate:cleanroom --down ${envFile}`);
    } else if (ctx && !tornDown) {
      tornDown = true;
      log(`tearing down ${project}`);
      try {
        teardown(ctx, runId, steps, cache);
      } catch (err) {
        steps.push({ name: "teardown", ok: false, details: String(err.message ?? err).slice(0, 2000) });
      }
    } else if (!ctx && !values.keep) {
      rmSync(root, { recursive: true, force: true });
    }
    release();
  }
  const after = await demoSnapshot();
  const diff = diffDemo(before, after);
  steps.push({
    name: "demo-untouched",
    ok: diff.length === 0,
    details: diff.length
      ? { diff }
      : { localImages: after.images.length, demoContainers: after.containers.length },
  });
  const ok = !error && steps.every((s) => s.ok);
  const out = {
    ok,
    runId,
    sha: sha.slice(0, 12),
    project,
    imageTag,
    ...(ctx ? { urls: ctx.urls } : {}),
    totalMs: Date.now() - started,
    steps,
    ...(gate ? { gate } : {}),
    ...(error ? { error } : {}),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
