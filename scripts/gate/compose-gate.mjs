#!/usr/bin/env node
// Compose gate (Phase 7 tracer, SELF-01 base, FOUND-06, D-02, D-11, D-18): builds the api, web, openclaw and
// fake-model images under a per-run tag, boots the whole minimal stack (postgres, redis, garage, migrate, api, web,
// openclaw cell) in project ocw-gate-<id> on 34xx loopback ports, checks it and tears everything down. The demo's
// `:local` images, its project and ports 3000/4000 are fingerprinted before and after; any difference fails the run.
//
//   node scripts/gate/compose-gate.mjs [--run-id <id>] [--keep] [--attach <envFile>]
//     --keep            leave the stack running (prints the env file to --attach to); no teardown
//     --attach <file>   run the checks against a stack left by --keep (no build, up or teardown)
//
// stdout: one JSON summary (steps: disk-free, ports-free, build, up, migrate-exit-0, api-health, web-login,
// cell-healthy, admin, teardown, build-cache, demo-untouched). Progress and build output go to stderr. Exit 0 = all ok.
// Env: OCW_GATE_MIN_FREE_GB (default 6), OCW_GATE_KEEP_BUILD_CACHE=1 (keep this run's build cache).
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { demoSnapshot, diffDemo, ensureAdmin, newRunId, withGateStack } from "./lib.mjs";

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

/** The stack checks (gate step convention): pushes one step per check to ctx.steps. */
export async function run(ctx) {
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

async function main() {
  const { values } = parseArgs({
    options: {
      "run-id": { type: "string" },
      keep: { type: "boolean", default: false },
      attach: { type: "string" },
    },
  });
  const runId = values["run-id"] ?? newRunId();
  const steps = [];
  const started = Date.now();
  const before = await demoSnapshot();
  let error;
  let target = {};
  try {
    await withGateStack({ runId, keep: values.keep, attachEnvFile: values.attach, steps }, async (ctx) => {
      target = { project: ctx.project, imageTag: ctx.imageTag, urls: ctx.urls };
      await run(ctx);
    });
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
  const ok = !error && steps.every((s) => s.ok);
  const summary = { ok, runId, ...target, totalMs: Date.now() - started, steps, ...(error ? { error } : {}) };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
