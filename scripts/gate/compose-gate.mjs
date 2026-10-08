#!/usr/bin/env node
// Compose gate (`pnpm gate:compose`; Phase 7: SELF-07, SELF-05, SELF-04, SELF-03, FOUND-05, FOUND-06, D-09, D-11,
// D-18): builds the api, web, openclaw and fake-model images under a per-run tag, boots the whole stack in project
// ocw-gate-<id> on loopback ports of one block (default 34xx) behind Caddy (https://localhost:<NN43>), runs every
// compose-level check of the phase on that one stack and tears everything down. The env file comes from the operator
// commands: `ocw setup --ports NN --project … --image-tag …` and `ocw enable proxy --site-address localhost --no-up`.
// The demo's `:local` images, its project and ports 3000/4000 are fingerprinted before and after; any difference
// fails the run.
//
//   pnpm gate:compose [--steps a,b] [--with-observability] [--with-vault] [--block NN] [--run-id ID] [--keep]
//   pnpm gate:compose --attach <envFile> [--steps …]   checks against a stack left by --keep (no build/up/teardown)
//   pnpm gate:compose --down <envFile>                 tears down a stack left by --keep
//
// Stages, always in this order (default: compose … backup; the flags add the profile stages at the end):
//   compose         migrate exited 0, api /health, web /login, cell healthy, admin setup/sign-in (loopback)
//   playwright      e2e/playwright.compose.config.ts from the host through Caddy: setup, Scenario B at 1440 and 390,
//                   the attachments API flow; fails if any test is skipped, failed or flaky, or if none ran
//   proxy           scripts/gate/proxy-check.mjs (WebSocket, presigned URLs, forwarded headers, cookies)
//   schema-refusal  scripts/gate/schema-refusal.mjs (unknown applied migration keeps the api down, then recovers)
//   backup          scripts/gate/backup-roundtrip.mjs (backup → restore, fresh volumes, --consistent, --force-recreate)
//   observability   --with-observability: scripts/gate/observability-smoke.mjs (`ocw enable observability` on this
//                   stack; traces, metrics, logs, Grafana, leak canaries)
//   vault           --with-vault: scripts/gate/vault-check.mjs (`ocw enable vault`; api boots on openbao:// refs)
//   vault-backup    --with-vault: backup-roundtrip.mjs runVault (OpenBao data + secrets/ restored on a new machine)
//
// stdout: one JSON summary { ok, runId, project, imageTag, urls, totalMs, stages: [{ name, ok, ms }],
// playwright: { expected, skipped, unexpected, flaky, durationMs, projects }, steps: [{ name, ok, ms, details }] }.
// Progress, build and Playwright output go to stderr. Exit 0 = every stage ok. Env: OCW_GATE_MIN_FREE_GB (default
// 6), OCW_GATE_KEEP_BUILD_CACHE=1, OCW_E2E_SCREENSHOT_DIR (review screenshots of the Playwright stage).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as backupStep from "./backup-roundtrip.mjs";
import {
  assertPlaywrightStats,
  demoSnapshot,
  diffDemo,
  ensureAdmin,
  newRunId,
  playwrightSummary,
  REPO_ROOT,
  teardownGateStack,
  withGateStack,
} from "./lib.mjs";
import * as observabilityStep from "./observability-smoke.mjs";
import * as proxyStep from "./proxy-check.mjs";
import * as schemaRefusalStep from "./schema-refusal.mjs";
import * as vaultStep from "./vault-check.mjs";

export const STAGES = [
  "compose",
  "playwright",
  "proxy",
  "schema-refusal",
  "backup",
  "observability",
  "vault",
  "vault-backup",
];
export const DEFAULT_STAGES = ["compose", "playwright", "proxy", "schema-refusal", "backup"];
const PLAYWRIGHT_CONFIG = "e2e/playwright.compose.config.ts";
const PLAYWRIGHT_CLI = path.join(REPO_ROOT, "node_modules", "@playwright", "test", "cli.js");

/** The stages to run, in canonical order, from --steps and the profile flags. */
export function selectStages({ steps, withObservability = false, withVault = false } = {}) {
  const wanted = new Set(
    steps
      ? steps
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_STAGES,
  );
  if (withObservability) wanted.add("observability");
  if (withVault) {
    wanted.add("vault");
    wanted.add("vault-backup");
  }
  const unknown = [...wanted].filter((s) => !STAGES.includes(s));
  if (unknown.length)
    throw new Error(`unknown stage(s): ${unknown.join(", ")} (known: ${STAGES.join(", ")})`);
  return STAGES.filter((s) => wanted.has(s));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last.ok) return last;
    } catch (err) {
      last = { ok: false, error: String(err.message ?? err) };
    }
    if (Date.now() >= deadline) return last;
    await sleep(intervalMs);
  }
}

/** `docker compose ps -a --format json <service>` → the service's container record (or undefined). */
function serviceState(ctx, service) {
  const res = ctx.compose(["ps", "-a", "--format", "json", service], { check: true });
  const rows = res.stdout
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      const v = JSON.parse(l);
      return Array.isArray(v) ? v : [v];
    });
  return rows.find((r) => r.Service === service);
}

async function httpOk(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  await res.arrayBuffer();
  return { ok: res.status === 200, status: res.status };
}

/**
 * The stack checks (gate step convention): pushes one step per check to ctx.steps. `admin: false` skips the admin
 * check, which would redeem the setup token: when Playwright follows, its `setup` project does the first-run setup in
 * the browser (and must not find it done).
 */
export async function run(ctx, { admin = true } = {}) {
  const checks = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    let res;
    try {
      res = await fn();
    } catch (err) {
      res = { ok: false, error: String(err.message ?? err) };
    }
    const { ok, ...details } = res;
    const step = { name, ok: ok === true, ms: Date.now() - t0, details };
    checks.push(step);
    ctx.steps.push(step);
  };

  await check("migrate-exit-0", async () => {
    const s = serviceState(ctx, "migrate");
    return { ok: s?.State === "exited" && s?.ExitCode === 0, state: s?.State, exitCode: s?.ExitCode };
  });
  await check("api-health", () => poll(() => httpOk(`${ctx.urls.api}/health`), { timeoutMs: 120_000 }));
  await check("web-login", () => poll(() => httpOk(`${ctx.urls.web}/login`), { timeoutMs: 120_000 }));
  // The cell image is ~5 GB and its gateway takes a while on first boot (Pitfall 11).
  await check("cell-healthy", () =>
    poll(
      async () => {
        const s = serviceState(ctx, "openclaw");
        return { ok: s?.Health === "healthy", state: s?.State, health: s?.Health };
      },
      { timeoutMs: 10 * 60_000, intervalMs: 5000 },
    ),
  );
  if (admin)
    await check("admin", async () => {
      // First call redeems the setup token (or signs in on a used stack); the second must sign in.
      const first = await ensureAdmin(ctx);
      const second = await ensureAdmin(ctx);
      return {
        ok: second.created === false && first.me?.user?.email === second.me?.user?.email,
        created: first.created,
      };
    });
  return { name: "compose", ok: checks.every((c) => c.ok), details: { checks: checks.map((c) => c.name) } };
}

/** Only what Playwright needs from this shell; inherited OCW_* never reach it (the gate sets its own). */
function playwrightEnv() {
  const env = {};
  for (const k of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "PLAYWRIGHT_BROWSERS_PATH",
    "DISPLAY",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

/**
 * Playwright from this checkout against the stack's public HTTPS origin. The setup token goes into the child's
 * environment only (never argv, never printed), so e2e/tests/env.ts never falls back to the repository's .env.
 * Must run on a fresh stack: the setup project redeems the setup token (it skips once setup is done, and the gate
 * accepts no skipped test). Returns the step result; `summary.playwright` gets the counts.
 */
export async function runPlaywright(ctx, summary) {
  const t0 = Date.now();
  const step = (ok, details) => {
    const s = { name: "playwright", ok, ms: Date.now() - t0, details };
    ctx.steps.push(s);
    return { name: "playwright", ok, details };
  };
  const token = ctx.env.OCW_SETUP_TOKEN ?? "";
  if (!token || token.startsWith("openbao://")) {
    return step(false, {
      error: "the gate env has no plain OCW_SETUP_TOKEN (run Playwright before the vault)",
    });
  }
  const origin = ctx.urls.public;
  if (!origin.startsWith("https://")) return step(false, { error: `not behind the proxy: ${origin}` });
  const install = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "install", "chromium"], {
    cwd: REPO_ROOT,
    env: playwrightEnv(),
    stdio: ["ignore", 2, 2],
    timeout: 20 * 60_000,
  });
  if (install.status !== 0)
    return step(false, { error: `playwright install chromium exited ${install.status}` });
  const reportFile = path.join(ctx.dir, "playwright-report.json");
  const screenshots = process.env.OCW_E2E_SCREENSHOT_DIR
    ? path.resolve(process.env.OCW_E2E_SCREENSHOT_DIR)
    : "";
  if (screenshots) mkdirSync(screenshots, { recursive: true });
  const env = {
    ...playwrightEnv(),
    OCW_E2E_BASE_URL: origin,
    OCW_E2E_API_URL: origin,
    OCW_SETUP_TOKEN: token,
    OCW_S3_PUBLIC_URL: ctx.env.OCW_S3_PUBLIC_URL ?? "",
    OCW_E2E_JSON_REPORT: reportFile,
    OCW_E2E_OUTPUT_DIR: path.join(ctx.dir, "playwright-results"),
    ...(screenshots ? { OCW_E2E_SCREENSHOT_DIR: screenshots } : {}),
  };
  const res = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "test", "-c", PLAYWRIGHT_CONFIG], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", 2, 2],
    timeout: 60 * 60_000,
  });
  if (!existsSync(reportFile)) return step(false, { exit: res.status, error: "no JSON report" });
  const result = playwrightSummary(JSON.parse(readFileSync(reportFile, "utf8")));
  summary.playwright = { ...result.stats, projects: result.projects };
  let statsError = null;
  try {
    assertPlaywrightStats(result.stats);
  } catch (err) {
    statsError = err.message;
  }
  return step(res.status === 0 && statsError === null, {
    exit: res.status,
    ...result.stats,
    projects: result.projects,
    ...(statsError ? { error: statsError } : {}),
    ...(screenshots ? { screenshots } : {}),
  });
}

/** Runs the selected stages on one stack; a stage failure is recorded and the next stages still run. */
async function runStages(ctx, stages, summary, log) {
  const results = [];
  for (const name of stages) {
    const t0 = Date.now();
    log(`stage ${name}`);
    let res;
    try {
      if (name === "compose") res = await run(ctx, { admin: !stages.includes("playwright") });
      else if (name === "playwright") res = await runPlaywright(ctx, summary);
      else if (name === "proxy") res = await proxyStep.run(ctx);
      else if (name === "schema-refusal") res = await schemaRefusalStep.run(ctx);
      else if (name === "backup") res = await backupStep.run(ctx);
      else if (name === "observability") res = await observabilityStep.run(ctx);
      else if (name === "vault") res = await vaultStep.run(ctx, { setSmtp: true });
      else if (name === "vault-backup") res = await backupStep.runVault(ctx);
    } catch (err) {
      res = { name, ok: false, details: { error: String(err.message ?? err).slice(0, 2000) } };
      ctx.steps.push({ name, ok: false, ms: Date.now() - t0, details: res.details });
    }
    results.push({ name, ok: res?.ok === true, ms: Date.now() - t0 });
    log(`stage ${name}: ${res?.ok === true ? "ok" : "FAILED"} (${Math.round((Date.now() - t0) / 1000)} s)`);
    // Without a healthy stack nothing after it means anything.
    if (name === "compose" && res?.ok !== true) break;
  }
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "run-id": { type: "string" },
      keep: { type: "boolean", default: false },
      attach: { type: "string" },
      down: { type: "string" },
      steps: { type: "string" },
      block: { type: "string", default: "34" },
      "with-observability": { type: "boolean", default: false },
      "with-vault": { type: "boolean", default: false },
    },
  });
  const log = (m) => process.stderr.write(`[gate] ${m}\n`);
  if (values.down) {
    const steps = [];
    await teardownGateStack(values.down, { steps });
    process.stdout.write(`${JSON.stringify({ ok: steps.every((s) => s.ok), steps }, null, 2)}\n`);
    process.exitCode = steps.every((s) => s.ok) ? 0 : 1;
    return;
  }
  const stages = selectStages({
    steps: values.steps,
    withObservability: values["with-observability"],
    withVault: values["with-vault"],
  });
  const runId = values["run-id"] ?? newRunId();
  const steps = [];
  const summary = {};
  const started = Date.now();
  const before = await demoSnapshot();
  let error;
  let target = {};
  let stageResults = [];
  try {
    await withGateStack(
      { runId, keep: values.keep, attachEnvFile: values.attach, block: Number(values.block), steps },
      async (ctx) => {
        target = { project: ctx.project, imageTag: ctx.imageTag, urls: ctx.urls };
        log(`stages: ${stages.join(", ")}`);
        stageResults = await runStages(ctx, stages, summary, log);
      },
    );
  } catch (err) {
    error = String(err.message ?? err).slice(0, 2000);
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
  const ok =
    !error &&
    stageResults.length === stages.length &&
    stageResults.every((s) => s.ok) &&
    steps.every((s) => s.ok);
  const out = {
    ok,
    runId,
    ...target,
    totalMs: Date.now() - started,
    stages: stageResults,
    ...(summary.playwright ? { playwright: summary.playwright } : {}),
    steps,
    ...(error ? { error } : {}),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
