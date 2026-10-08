#!/usr/bin/env node
// Vault gate step (SELF-01 "enable later", SELF-02, D-13, D-16; plan 07-06): on a running gate stack without the
// vault profile, first-run setup creates the admin, `ocw enable vault` moves the API-only secrets into OpenBao, and
// then: the api is healthy on openbao:// references only, the admin's session from before still works (same
// BETTER_AUTH_SECRET) and a fresh sign-in works, OpenBao publishes no port, `restart openbao` comes back unsealed with
// no human, the api survives its own restart, the secrets/ files are private and no secret value is in any log.
//
//   node scripts/gate/vault-check.mjs --up [--run-id <id>] [--keep]   # own stack (gate lock, 34xx ports, own tag)
//   node scripts/gate/vault-check.mjs --attach <envFile>              # a stack left by --keep (no build/up/teardown)
//   node scripts/gate/vault-check.mjs --down <envFile>                # tear down a --keep stack
//
// stdout: one JSON summary with per-check timings; progress on stderr. Exit 0 = every check ok. The demo is
// fingerprinted before and after (demo-untouched). Secret values are only held in memory to prove their absence.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ADMIN,
  ApiClient,
  demoSnapshot,
  diffDemo,
  ensureAdmin,
  newRunId,
  REPO_ROOT,
  setEnvKeys,
  teardownGateStack,
  withGateStack,
} from "./lib.mjs";

const MOVABLE = ["BETTER_AUTH_SECRET", "OCW_SETUP_TOKEN", "OCW_ENCRYPTION_KEY", "OCW_SMTP_URL"];
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

function serviceState(ctx, service) {
  const res = ctx.compose(["ps", "-a", "--format", "json", service], { check: true });
  return res.stdout
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      const v = JSON.parse(l);
      return Array.isArray(v) ? v : [v];
    })
    .find((r) => r.Service === service);
}

const healthy = (ctx, service, timeoutMs = 180_000) =>
  poll(
    async () => {
      const s = serviceState(ctx, service);
      return { ok: s?.State === "running" && s?.Health === "healthy", state: s?.State, health: s?.Health };
    },
    { timeoutMs },
  );

async function apiHealth(ctx) {
  const res = await fetch(`${ctx.urls.api}/health`, { signal: AbortSignal.timeout(10_000) });
  await res.arrayBuffer();
  return { ok: res.status === 200, status: res.status };
}

/** The checks (gate step convention). `opts.setSmtp`: give the stack an OCW_SMTP_URL first so all four move. */
export async function run(ctx, opts = {}) {
  const checks = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    let res;
    try {
      res = await fn();
    } catch (err) {
      res = { ok: false, error: String(err.message ?? err).slice(0, 500) };
    }
    const { ok, ...details } = res;
    const step = { name, ok: ok === true, ms: Date.now() - t0, details };
    checks.push(step);
    ctx.steps.push(step);
    return step.ok;
  };

  if (opts.setSmtp && !ctx.env.OCW_SMTP_URL) {
    // A syntactically valid SMTP URL with a credential: nothing connects to it at boot (the mailer is lazy).
    setEnvKeys(ctx.envFile, { OCW_SMTP_URL: "smtp://ocw-gate:gate-smtp-canary-7c1d@127.0.0.1:2525" });
    ctx.reload();
    ctx.compose(["up", "-d", "--wait", "api"], { stdio: ["ignore", 2, 2], check: true, timeoutMs: 600_000 });
  }
  // In memory only, to prove the values never reach output or logs.
  const values = MOVABLE.map((k) => ctx.env[k]).filter((v) => v && !v.startsWith("openbao://"));

  let session;
  await check("admin-before", async () => {
    // On a shared gate stack the api may just have been recreated: Docker Desktop's port forward can refuse the first
    // connections after `up --wait` returns (07-09), so wait for /health before signing in.
    const http = await poll(() => apiHealth(ctx), { timeoutMs: 120_000 });
    if (!http.ok) return { ok: false, health: http.status ?? http.error };
    const { client, created, me } = await ensureAdmin(ctx);
    session = client;
    return { ok: Boolean(me?.user?.email), created };
  });

  await check("enable-vault", async () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    for (const k of ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "TMPDIR"]) {
      if (process.env[k]) env[k] = process.env[k];
    }
    const res = spawnSync(
      process.execPath,
      ["--", path.join(REPO_ROOT, "scripts", "ocw.mjs"), "enable", "vault", "--env-file", ctx.envFile],
      { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    const leaked = values.filter((v) => out.includes(v)).length;
    ctx.reload();
    return {
      ok: res.status === 0 && leaked === 0,
      exitCode: res.status,
      leakedValues: leaked,
      ...(res.status === 0 ? {} : { stderrTail: (res.stderr ?? "").trim().split("\n").slice(-5) }),
    };
  });
  for (const v of [ctx.env.OCW_OPENBAO_SECRET_ID]) if (v) values.push(v);

  await check("env-references-only", async () => {
    const refs = MOVABLE.filter((k) => ctx.env[k]?.startsWith("openbao://"));
    const plain = MOVABLE.filter((k) => ctx.env[k] && !ctx.env[k].startsWith("openbao://"));
    return {
      ok: plain.length === 0 && refs.length >= 3 && Boolean(ctx.env.OCW_OPENBAO_ROLE_ID),
      references: refs,
      plain,
      profiles: ctx.env.COMPOSE_PROFILES,
    };
  });

  await check("api-healthy-on-references", async () => {
    const svc = await healthy(ctx, "api");
    const http = await poll(() => apiHealth(ctx), { timeoutMs: 120_000 });
    return { ok: svc.ok && http.ok, api: svc, http: http.status };
  });

  await check("admin-signs-in", async () => {
    // The pre-enable session is still valid: the API signs with the same BETTER_AUTH_SECRET, now from OpenBao.
    const old = await session.request("GET", "/api/v1/me");
    const fresh = new ApiClient(ctx.urls.api, ctx.env.OCW_PUBLIC_WEB_URL || ctx.urls.web);
    const signIn = await fresh.request("POST", "/api/auth/sign-in/email", {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const me = await fresh.request("GET", "/api/v1/me");
    return {
      ok: old.status === 200 && signIn.status === 200 && me.status === 200,
      oldSession: old.status,
      signIn: signIn.status,
      me: me.status,
    };
  });

  await check("openbao-unpublished", async () => {
    // Compose 5 prints "<ip>:0" (exit 0) for a port that is not published; anything with a real port is a leak.
    const port = ctx.compose(["port", "openbao", "8200"]);
    const out = `${port.stdout ?? ""}`.trim();
    const hostPort = Number(/:(\d+)\s*$/.exec(out)?.[1] ?? 0);
    const s = serviceState(ctx, "openbao");
    const published = (s?.Publishers ?? []).filter((p) => p.PublishedPort);
    return {
      ok: Boolean(s) && published.length === 0 && hostPort === 0,
      publishers: published.length,
      composePort: { exit: port.status, hostPort },
    };
  });

  await check("restart-auto-unseal", async () => {
    ctx.compose(["restart", "openbao"], { check: true, timeoutMs: 120_000 });
    const bao = await healthy(ctx, "openbao", 120_000);
    ctx.compose(["restart", "api"], { check: true, timeoutMs: 120_000 });
    const api = await healthy(ctx, "api");
    const http = await poll(() => apiHealth(ctx), { timeoutMs: 120_000 });
    const me = await session.request("GET", "/api/v1/me");
    return { ok: bao.ok && api.ok && http.ok && me.status === 200, openbao: bao, api, me: me.status };
  });

  await check("secrets-files-private", async () => {
    const dir = path.join(ctx.dir, "secrets");
    const mode = (f) => (existsSync(f) ? (statSync(f).mode & 0o777).toString(8) : "missing");
    const modes = {
      dir: mode(dir),
      seal: mode(path.join(dir, "openbao-seal.key")),
      init: mode(path.join(dir, "openbao-init.json")),
      env: mode(ctx.envFile),
    };
    return {
      ok: modes.dir === "700" && modes.seal === "600" && modes.init === "600" && modes.env === "600",
      ...modes,
    };
  });

  await check("logs-clean", async () => {
    const res = ctx.compose(["logs", "--no-color", "api", "openbao"], { timeoutMs: 120_000 });
    const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const leaked = values.filter((v) => text.includes(v)).length;
    return { ok: res.status === 0 && leaked === 0, checkedValues: values.length, leaked, bytes: text.length };
  });

  return { name: "vault", ok: checks.every((c) => c.ok), details: { checks: checks.map((c) => c.name) } };
}

async function main() {
  const { values } = parseArgs({
    options: {
      up: { type: "boolean", default: false },
      "run-id": { type: "string" },
      keep: { type: "boolean", default: false },
      attach: { type: "string" },
      down: { type: "string" },
    },
  });
  if (values.down) {
    const steps = [];
    await teardownGateStack(values.down, { steps });
    process.stdout.write(`${JSON.stringify({ ok: steps.every((s) => s.ok), steps }, null, 2)}\n`);
    process.exitCode = steps.every((s) => s.ok) ? 0 : 1;
    return;
  }
  if (!values.up && !values.attach) {
    process.stderr.write(
      "Usage: vault-check.mjs --up [--keep] [--run-id <id>] | --attach <envFile> | --down <envFile>\n",
    );
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
    await withGateStack({ runId, keep: values.keep, attachEnvFile: values.attach, steps }, async (ctx) => {
      target = { project: ctx.project, imageTag: ctx.imageTag, urls: ctx.urls };
      await run(ctx, { setSmtp: Boolean(values.up) });
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
