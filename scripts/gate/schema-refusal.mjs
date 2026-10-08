#!/usr/bin/env node
// Gate step: an image rollback over a newer schema is refused at the compose level (SELF-03, D-06, T-07-10-05).
// As the gate's postgres superuser, an applied-migration row this build does not ship is added (what a newer release
// leaves behind); the api alone is force-recreated: it must stay unhealthy, keep /health down and log the guard's
// "Database was migrated by a newer release" message (restart: unless-stopped retries it). Then the row is removed,
// as restoring the matching backup would, and the api comes back healthy. The row is always removed, even on failure.
//
//   node scripts/gate/schema-refusal.mjs --up [--run-id <id>] [--keep]   own gate stack (lib.mjs withGateStack)
//   node scripts/gate/schema-refusal.mjs --attach <envFile>              a stack left by --keep
//
// stdout: one JSON summary; exit 0 = both halves ok. Part of `pnpm gate:compose` (compose-gate.mjs).
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { demoSnapshot, diffDemo, newRunId, withGateStack } from "./lib.mjs";

/** The guard's message for an "ahead" database (packages/db/src/schema-check.ts describeSchemaMismatch). */
export const NEWER_RELEASE = "Database was migrated by a newer release";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiState(ctx) {
  const res = ctx.compose(["ps", "-a", "--format", "json", "api"], { check: true });
  return res.stdout
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      const v = JSON.parse(l);
      return Array.isArray(v) ? v : [v];
    })
    .find((r) => r.Service === "api");
}

async function health(ctx) {
  try {
    const res = await fetch(`${ctx.urls.api}/health`, { signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

/** The step (gate convention): pushes one entry per half to ctx.steps. */
export async function run(ctx, { refusalWindowMs = 60_000, recoverTimeoutS = 300 } = {}) {
  const checks = [];
  const record = (name, t0, res) => {
    const { ok, ...details } = res;
    const step = { name, ok: ok === true, ms: Date.now() - t0, details };
    checks.push(step);
    ctx.steps.push(step);
  };
  // A name sorting after every real migration, unique per run; the hash is not any real migration's.
  const name = `29991231235959_gate_refusal_${randomBytes(3).toString("hex")}`;
  const literal = `'${name}'`;
  let inserted = false;
  let t0 = Date.now();
  try {
    ctx.psql(
      `insert into drizzle.__drizzle_migrations (hash, created_at, name) values ('gate-refusal', 0, ${literal})`,
    );
    inserted = true;
    const recreate = ctx.compose(["up", "-d", "--no-deps", "--force-recreate", "api"], {
      stdio: ["ignore", 2, 2],
      timeoutMs: 5 * 60_000,
    });
    // Watch the recreated api for the whole window: it must never become healthy or answer /health.
    const deadline = Date.now() + refusalWindowMs;
    let healthy = false;
    let healthAnswered = false;
    let message = "";
    let state;
    while (Date.now() < deadline) {
      state = apiState(ctx);
      if (state?.Health === "healthy") healthy = true;
      if ((await health(ctx)) === 200) healthAnswered = true;
      if (!message) {
        const logs = ctx.compose(["logs", "--no-color", "api"]).stdout ?? "";
        message = logs.split("\n").find((l) => l.includes(NEWER_RELEASE)) ?? "";
      }
      await sleep(3000);
    }
    record("schema-refusal-api-down", t0, {
      ok: recreate.status === 0 && !healthy && !healthAnswered && message.includes(name),
      recreateExit: recreate.status,
      everHealthy: healthy,
      healthAnswered200: healthAnswered,
      state: state?.State,
      // The guard's line, without the container prefix.
      message: message.replace(/^[^|]*\|\s*/, "").slice(0, 300),
    });
  } catch (err) {
    record("schema-refusal-api-down", t0, { ok: false, error: String(err.message ?? err).slice(0, 1000) });
  } finally {
    if (inserted) ctx.psql(`delete from drizzle.__drizzle_migrations where name = ${literal}`);
  }

  t0 = Date.now();
  try {
    const left = Number(
      ctx.psql(`select count(*) from drizzle.__drizzle_migrations where name = ${literal}`),
    );
    // What an operator does once the database matches the image again: start the api afresh. (`up --wait` on the
    // old container races Docker's restart backoff and can exit 1 although the api comes up.)
    const up = ctx.compose(
      [
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        String(recoverTimeoutS),
        "api",
      ],
      { stdio: ["ignore", 2, 2], timeoutMs: (recoverTimeoutS + 120) * 1000 },
    );
    let status = 0;
    for (let i = 0; i < 60 && status !== 200; i++) {
      status = await health(ctx);
      if (status !== 200) await sleep(2000);
    }
    record("schema-refusal-api-recovers", t0, {
      ok: left === 0 && up.status === 0 && status === 200 && apiState(ctx)?.Health === "healthy",
      rowRemoved: left === 0,
      upExit: up.status,
      health: status,
    });
  } catch (err) {
    record("schema-refusal-api-recovers", t0, {
      ok: false,
      error: String(err.message ?? err).slice(0, 1000),
    });
  }
  return {
    name: "schema-refusal",
    ok: checks.length === 2 && checks.every((c) => c.ok),
    details: { checks: checks.map((c) => c.name) },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      up: { type: "boolean", default: false },
      attach: { type: "string" },
      keep: { type: "boolean", default: false },
      "run-id": { type: "string" },
    },
  });
  if (!values.up && !values.attach) {
    process.stderr.write("usage: schema-refusal.mjs --up [--keep] [--run-id ID] | --attach <envFile>\n");
    process.exitCode = 2;
    return;
  }
  const runId = values["run-id"] ?? newRunId();
  const steps = [];
  const started = Date.now();
  const before = await demoSnapshot();
  let error;
  let target = {};
  let result;
  try {
    await withGateStack({ runId, keep: values.keep, attachEnvFile: values.attach, steps }, async (ctx) => {
      target = { project: ctx.project, imageTag: ctx.imageTag };
      result = await run(ctx);
    });
  } catch (err) {
    error = String(err.message ?? err).slice(0, 2000);
  }
  const diff = diffDemo(before, await demoSnapshot());
  steps.push({
    name: "demo-untouched",
    ok: diff.length === 0,
    ...(diff.length ? { details: { diff } } : {}),
  });
  const ok = !error && result?.ok === true && steps.every((s) => s.ok);
  const out = { ok, runId, ...target, totalMs: Date.now() - started, steps, ...(error ? { error } : {}) };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
