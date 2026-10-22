#!/usr/bin/env node
// Sandbox gate step (07.8-24; D-01, D-09, D-11, principle 10, C-03): on a gate stack running the `sandbox` profile
// (`pnpm gate:compose --with-sandbox`), proves the self-hosted broker end to end:
//   sandboxd-healthy    the sandboxd service is healthy (its own /v1/info probe with its token)
//   sandboxd-confined   no published port (`docker port` empty, no PortBindings), only the `sandbox-control` network,
//                       read-only root, every capability dropped, no-new-privileges; the only container of the project
//                       that mounts the Docker socket
//   cell-cannot-reach   the openclaw cell is not on `sandbox-control` and cannot resolve or reach sandboxd
//   isolation           GET /api/v1/sandbox/settings as the first admin: isolation `ok` with a runtime and the Docker
//                       version sandboxd reports
//   kill                POST /api/v1/sandbox/kill: the settings say killed, and the broker itself refuses to start a
//                       sandbox of that organization (`killed`), asked with the API's own credentials from inside the
//                       api container (the only place they exist)
//   resume              POST /api/v1/sandbox/resume: not killed, and the broker starts a real hardened sandbox for a
//                       throwaway bot id, then purges it; nothing of that bot is left
//
//   node scripts/gate/sandbox-check.mjs --attach <envFile>   # a stack left by `pnpm gate:compose --with-sandbox --keep`
//
// Never prints a secret: the broker token is read inside the api container and never leaves it.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ensureAdmin, gateContext } from "./lib.mjs";

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

function serviceContainer(ctx, service) {
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

function inspect(ctx, id) {
  const res = ctx.docker(["inspect", id], { check: true });
  return JSON.parse(res.stdout)[0];
}

/**
 * One sandboxd op from inside the api container, with the API's own URL and token (never printed, never on argv).
 * Prints `{ status, code, state }` only.
 */
const BROKER_CALL = `
const [path, body] = process.argv.slice(1);
fetch(process.env.OCW_SANDBOX_URL + path, {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.OCW_SANDBOX_TOKEN, "content-type": "application/json" },
  body,
  signal: AbortSignal.timeout(120000),
}).then(async (r) => {
  const j = await r.json().catch(() => null);
  console.log(JSON.stringify({ status: r.status, code: j?.error?.code ?? null, state: j?.state ?? null, runtime: j?.runtime ?? null }));
}, (e) => console.log(JSON.stringify({ status: 0, code: e?.name ?? "error" })));
`;

function broker(ctx, path, body) {
  const res = ctx.compose(["exec", "-T", "api", "node", "-e", BROKER_CALL, path, JSON.stringify(body)], {
    timeoutMs: 180_000,
  });
  const line = (res.stdout ?? "").trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { status: -1, code: `exec exited ${res.status}` };
  }
}

function agentObjects(ctx, agentId) {
  const label = `label=ocw.agent=${agentId}`;
  const count = (args) => (ctx.docker(args).stdout ?? "").split("\n").filter((l) => l.trim()).length;
  return (
    count(["ps", "-aq", "--filter", label]) +
    count(["volume", "ls", "-q", "--filter", label]) +
    count(["network", "ls", "-q", "--filter", label])
  );
}

export async function run(ctx) {
  const checks = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    let res;
    try {
      res = await fn();
    } catch (err) {
      res = { ok: false, error: String(err.message ?? err).slice(0, 2000) };
    }
    const { ok, ...details } = res;
    const step = { name: `sandbox:${name}`, ok: ok === true, ms: Date.now() - t0, details };
    checks.push(step);
    ctx.steps.push(step);
    return step;
  };

  await check("sandboxd-healthy", () =>
    poll(
      async () => {
        const s = serviceContainer(ctx, "sandboxd");
        return { ok: s?.Health === "healthy", state: s?.State, health: s?.Health };
      },
      { timeoutMs: 180_000, intervalMs: 3000 },
    ),
  );

  await check("sandboxd-confined", async () => {
    const s = serviceContainer(ctx, "sandboxd");
    if (!s) return { ok: false, error: "no sandboxd container" };
    const c = inspect(ctx, s.ID);
    const ports = (ctx.docker(["port", s.ID]).stdout ?? "").trim();
    const networks = Object.keys(c.NetworkSettings?.Networks ?? {});
    const bindings = Object.values(c.HostConfig?.PortBindings ?? {})
      .flat()
      .filter(Boolean);
    const sockets = [];
    for (const id of (ctx.compose(["ps", "-aq"]).stdout ?? "").split("\n").filter((l) => l.trim())) {
      const other = inspect(ctx, id);
      if ((other.Mounts ?? []).some((m) => String(m.Source).endsWith("docker.sock")))
        sockets.push(other.Config?.Labels?.["com.docker.compose.service"]);
    }
    const ok =
      ports === "" &&
      bindings.length === 0 &&
      c.HostConfig?.PublishAllPorts !== true &&
      networks.length === 1 &&
      networks[0] === `${ctx.project}_sandbox-control` &&
      c.HostConfig?.ReadonlyRootfs === true &&
      JSON.stringify(c.HostConfig?.CapDrop) === JSON.stringify(["ALL"]) &&
      (c.HostConfig?.CapAdd ?? []).length === 0 &&
      (c.HostConfig?.SecurityOpt ?? []).includes("no-new-privileges:true") &&
      JSON.stringify(sockets) === JSON.stringify(["sandboxd"]);
    return { ok, ports, networks, readOnly: c.HostConfig?.ReadonlyRootfs, socketHolders: sockets };
  });

  await check("cell-cannot-reach", async () => {
    const s = serviceContainer(ctx, "openclaw");
    if (!s) return { ok: false, error: "no openclaw container" };
    const networks = Object.keys(inspect(ctx, s.ID).NetworkSettings?.Networks ?? {});
    const probe = ctx.compose(
      [
        "exec",
        "-T",
        "openclaw",
        "node",
        "-e",
        "fetch('http://sandboxd:8090/v1/info',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('reached '+r.status),e=>console.log('refused '+(e.cause?.code??e.name)))",
      ],
      { timeoutMs: 60_000 },
    );
    const out = (probe.stdout ?? "").trim();
    return {
      ok: !networks.some((n) => n.endsWith("_sandbox-control")) && out.startsWith("refused"),
      networks,
      probe: out,
    };
  });

  const { client, me } = await ensureAdmin(ctx);
  const orgId = me?.organization?.id;

  await check("isolation", async () => {
    const res = await client.request("GET", "/api/v1/sandbox/settings");
    const iso = res.body?.isolation;
    return {
      ok:
        res.status === 200 &&
        iso?.status === "ok" &&
        ["gvisor", "hardened-runc"].includes(iso?.runtime) &&
        Boolean(iso?.dockerVersion),
      status: res.status,
      isolation: iso,
    };
  });

  await check("kill", async () => {
    const res = await client.request("POST", "/api/v1/sandbox/kill", {});
    const refused = broker(ctx, "/v1/sandboxes/ensure", { target: { orgId, agentId: randomUUID() } });
    return {
      ok:
        res.status === 200 &&
        res.body?.killed !== null &&
        refused.status === 409 &&
        refused.code === "killed",
      status: res.status,
      killed: res.body?.killed !== null,
      broker: refused,
    };
  });

  await check("resume", async () => {
    const res = await client.request("POST", "/api/v1/sandbox/resume", {});
    const agentId = randomUUID();
    const target = { orgId, agentId };
    const started = broker(ctx, "/v1/sandboxes/ensure", { target });
    const purged = broker(ctx, "/v1/sandboxes/purge", { target });
    const left = agentObjects(ctx, agentId);
    return {
      ok:
        res.status === 200 &&
        res.body?.killed === null &&
        started.status === 200 &&
        started.state === "running" &&
        purged.status === 200 &&
        left === 0,
      status: res.status,
      started,
      purged: purged.status,
      leftObjects: left,
    };
  });

  return { name: "sandbox", ok: checks.every((c) => c.ok), details: { checks: checks.map((c) => c.name) } };
}

async function main() {
  const { values } = parseArgs({ options: { attach: { type: "string" } } });
  if (!values.attach) {
    process.stderr.write("usage: node scripts/gate/sandbox-check.mjs --attach <envFile>\n");
    process.exitCode = 2;
    return;
  }
  const ctx = gateContext(values.attach, { steps: [] });
  const res = await run(ctx);
  process.stdout.write(`${JSON.stringify({ ok: res.ok, steps: ctx.steps }, null, 2)}\n`);
  process.exitCode = res.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
