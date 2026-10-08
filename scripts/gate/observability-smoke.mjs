#!/usr/bin/env node
// Observability smoke (gate step; FOUND-05, SELF-01 "enable later", D-05, D-13, D-18): a running stack WITHOUT the
// `observability` profile gets data, then `pnpm ocw enable observability` turns the profile on. Checks: the api alone
// is recreated and is healthy, the data is intact, and a traced API request carrying a query-string canary shows up
// in Tempo with fastify, http and pg spans, without the canary or a host path.
//
//   node scripts/gate/observability-smoke.mjs --up               # own gate stack (built, booted, torn down)
//   node scripts/gate/observability-smoke.mjs --attach <envFile> # a stack left by compose-gate.mjs --keep
//
// stdout: one JSON summary; exit 0 = every check ok. Backends are queried from inside the compose network (node in
// the api container); none of them is published. Secret values are never printed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  demoSnapshot,
  diffDemo,
  ensureAdmin,
  newRunId,
  REPO_ROOT,
  setEnvKeys,
  withGateStack,
} from "./lib.mjs";

export const PROFILE = "observability";
/** Services of the profile that must be running once it is enabled. */
export const PROFILE_SERVICES = ["otel-collector", "tempo"];
const CANARY = "OBS-CANARY";
/** Levels at which the api emits no request logs (info); the smoke lowers them for the api only. */
const QUIET_LEVELS = new Set(["fatal", "error", "warn", "silent"]);
const LOG_OVERRIDE = "observability-smoke.api-log-level.yaml";

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

/** Service → { id, state, health } for every container of the project. */
function containers(ctx) {
  const res = ctx.compose(["ps", "-a", "--format", "json"], { check: true });
  const out = {};
  for (const line of res.stdout.split("\n").filter((l) => l.trim())) {
    const v = JSON.parse(line);
    for (const r of Array.isArray(v) ? v : [v])
      out[r.Service] = { id: r.ID, state: r.State, health: r.Health };
  }
  return out;
}

const NODE_GET = [
  "const [u, h] = process.argv.slice(1);",
  "fetch(u, { headers: JSON.parse(h), signal: AbortSignal.timeout(15000) })",
  "  .then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, body: await r.text() })))",
  "  .catch((e) => process.stdout.write(JSON.stringify({ status: 0, body: String(e) })));",
].join("\n");

/** GET `url` from inside the compose network (node in the api container): `{ status, body }`. */
export function inNetworkGet(ctx, url, headers = {}) {
  const res = ctx.compose(["exec", "-T", "api", "node", "-e", NODE_GET, url, JSON.stringify(headers)], {
    timeoutMs: 60_000,
  });
  if (res.status !== 0) return { status: 0, body: (res.stderr ?? "").slice(-500) };
  return JSON.parse(res.stdout);
}

/** Strings no stored telemetry may contain: the canary, this checkout's absolute path, process attributes. */
export function leaks(text) {
  const found = [];
  for (const needle of [CANARY, REPO_ROOT, "process.executable.path", "process.command_args"]) {
    if (text.includes(needle)) found.push(needle === REPO_ROOT ? "<repository path>" : needle);
  }
  return found;
}

/** OTLP JSON → flat span list `{ name, kind, attrs }` (Tempo's /api/v2/traces answer). */
export function flattenSpans(otlp) {
  const resourceSpans = otlp?.trace?.resourceSpans ?? otlp?.resourceSpans ?? otlp?.batches ?? [];
  const spans = [];
  for (const rs of resourceSpans) {
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      for (const s of ss.spans ?? []) {
        const attrs = {};
        for (const a of s.attributes ?? []) attrs[a.key] = Object.values(a.value ?? {})[0];
        spans.push({ name: s.name, kind: s.kind, scope: ss.scope?.name, attrs });
      }
    }
  }
  return spans;
}

const stepper = (ctx, checks) => async (name, fn) => {
  const t0 = Date.now();
  let res;
  try {
    res = await fn();
  } catch (err) {
    res = { ok: false, error: String(err.message ?? err).slice(0, 2000) };
  }
  const { ok, ...details } = res;
  const step = { name, ok: ok === true, ms: Date.now() - t0, details };
  checks.push(step);
  ctx.steps.push(step);
  return res;
};

/** The step (gate convention): pushes one entry per check to ctx.steps. */
export async function run(ctx) {
  const checks = [];
  const check = stepper(ctx, checks);
  const enabledBefore = (ctx.env.COMPOSE_PROFILES ?? "").split(",").includes(PROFILE);
  const state = {};

  await check("obs-seed", async () => {
    const { client } = await ensureAdmin(ctx);
    state.client = client;
    const name = `obs-smoke-${randomBytes(4).toString("hex")}`;
    const channel = await client.request("POST", "/api/v1/channels", { name });
    if (channel.status !== 200) return { ok: false, channel: channel.status };
    const posted = await client.request("POST", `/api/v1/conversations/${channel.body.id}/messages`, {
      body: "observability smoke: this message must survive enabling the profile",
    });
    state.messages = Number(ctx.psql("select count(*) from app.messages"));
    state.before = containers(ctx);
    return { ok: posted.status === 200 && state.messages > 0, messages: state.messages };
  });

  // Request logs are info-level; a stack run with compose.e2e.yaml (LOG_LEVEL=warn) would export none to Loki.
  await check("obs-api-log-level", async () => {
    const res = ctx.compose(["exec", "-T", "api", "printenv", "LOG_LEVEL"]);
    const level = (res.stdout ?? "").trim() || "info";
    if (!QUIET_LEVELS.has(level)) return { ok: true, level, override: false };
    const file = path.join(ctx.dir, LOG_OVERRIDE);
    writeFileSync(file, "services:\n  api:\n    environment:\n      LOG_LEVEL: info\n", { mode: 0o600 });
    const files = (ctx.env.COMPOSE_FILE || "compose.yaml").split(":").filter(Boolean);
    if (!files.includes(file)) setEnvKeys(ctx.envFile, { COMPOSE_FILE: [...files, file].join(":") });
    ctx.reload();
    return { ok: true, level, override: true };
  });

  await check("obs-enable", async () => {
    if (enabledBefore) {
      // Already on: apply the log-level override (if any) the same way, recreating the api only.
      const res = ctx.compose(["up", "-d", "--wait", "--wait-timeout", "600"], {
        stdio: ["ignore", 2, 2],
        timeoutMs: 15 * 60_000,
      });
      return { ok: res.status === 0, alreadyEnabled: true };
    }
    const cli = existsSync(path.join(ctx.projectDir, "scripts", "ocw.mjs"))
      ? path.join(ctx.projectDir, "scripts", "ocw.mjs")
      : path.join(REPO_ROOT, "scripts", "ocw.mjs");
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
    const res = spawnSync(
      process.execPath,
      ["--", cli, "enable", "observability", "--env-file", ctx.envFile],
      { cwd: ctx.projectDir, env, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    ctx.reload();
    const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    const password = ctx.env.OCW_GRAFANA_ADMIN_PASSWORD ?? "";
    const printedPassword = password.length > 0 && output.includes(password);
    return {
      ok:
        res.status === 0 &&
        !printedPassword &&
        (ctx.env.COMPOSE_PROFILES ?? "").split(",").includes(PROFILE) &&
        ctx.env.OCW_OTEL_ENDPOINT === "http://otel-collector:4318",
      exit: res.status,
      printedPassword,
      ...(res.status === 0 ? {} : { tail: output.trim().split("\n").slice(-15) }),
    };
  });

  await check("obs-only-api-recreated", async () => {
    const health = await poll(
      async () => {
        const r = await fetch(`${ctx.urls.api}/health`, { signal: AbortSignal.timeout(10_000) });
        await r.arrayBuffer();
        return { ok: r.status === 200, status: r.status };
      },
      { timeoutMs: 120_000 },
    );
    const after = containers(ctx);
    const recreated = Object.keys(state.before ?? {}).filter((s) => after[s]?.id !== state.before[s].id);
    const notRunning = PROFILE_SERVICES.filter((s) => after[s]?.state !== "running");
    const messages = Number(ctx.psql("select count(*) from app.messages"));
    return {
      ok:
        health.ok &&
        recreated.length === 1 &&
        recreated[0] === "api" &&
        notRunning.length === 0 &&
        messages === state.messages,
      recreated,
      notRunning,
      messagesBefore: state.messages,
      messagesAfter: messages,
    };
  });

  await check("obs-trace-in-tempo", async () => {
    const traceId = randomBytes(16).toString("hex");
    const parent = randomBytes(8).toString("hex");
    const me = await state.client.request("GET", `/api/v1/me?token=${CANARY}`, undefined, {
      traceparent: `00-${traceId}-${parent}-01`,
    });
    state.traceId = traceId;
    if (me.status !== 200) return { ok: false, me: me.status };
    const found = await poll(
      async () => {
        const r = inNetworkGet(ctx, `http://tempo:3200/api/v2/traces/${traceId}`, {
          accept: "application/json",
        });
        if (r.status !== 200) return { ok: false, status: r.status };
        const spans = flattenSpans(JSON.parse(r.body));
        const fastify = spans.find(
          (s) => s.scope?.includes("fastify") && s.attrs["http.route"] === "/api/v1/me",
        );
        const server = spans.find(
          (s) => /SERVER/.test(String(s.kind)) && s.scope?.includes("instrumentation-http"),
        );
        const pg = spans.find((s) => s.scope?.includes("instrumentation-pg"));
        return {
          ok: Boolean(fastify && server && pg),
          spans: spans.length,
          fastify: fastify?.name,
          server: server?.name,
          pg: pg?.name,
          leaks: leaks(r.body),
        };
      },
      { timeoutMs: 120_000, intervalMs: 3000 },
    );
    return { ...found, ok: found.ok && found.leaks?.length === 0 };
  });

  return {
    name: "observability",
    ok: checks.every((c) => c.ok),
    details: { checks: checks.map((c) => c.name) },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      up: { type: "boolean", default: false },
      attach: { type: "string" },
      "run-id": { type: "string" },
    },
  });
  if (!values.up && !values.attach) {
    process.stderr.write("usage: observability-smoke.mjs --up | --attach <envFile>\n");
    process.exitCode = 2;
    return;
  }
  const runId = values["run-id"] ?? newRunId();
  const steps = [];
  const started = Date.now();
  const before = await demoSnapshot();
  let error;
  let target = {};
  try {
    // --up: the stack starts WITHOUT the profile; run() enables it later, as an operator would.
    await withGateStack({ runId, attachEnvFile: values.attach, steps }, async (ctx) => {
      target = { project: ctx.project, imageTag: ctx.imageTag };
      await run(ctx);
    });
  } catch (err) {
    error = String(err.message ?? err).slice(0, 2000);
  }
  const diff = diffDemo(before, await demoSnapshot());
  steps.push({ name: "demo-untouched", ok: diff.length === 0, details: diff.length ? { diff } : {} });
  const ok = !error && steps.every((s) => s.ok);
  const summary = { ok, runId, ...target, totalMs: Date.now() - started, steps, ...(error ? { error } : {}) };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
