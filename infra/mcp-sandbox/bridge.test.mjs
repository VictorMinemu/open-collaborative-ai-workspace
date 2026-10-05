// npm ci --prefix infra/mcp-sandbox --ignore-scripts && node --test infra/mcp-sandbox/bridge.test.mjs
//
// The stdio MCP sandbox bridge (03.1-14, D-13), in process, with the dependency-free test/stdio-echo.mjs as the only
// allowlisted server. The bridge tests need the sidecar's own dependencies (`npm ci` above); without them they are
// skipped with that hint, while the lock and compose checks below still run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => JSON.parse(readFileSync(here(rel), "utf8"));
const SDK_INSTALLED = existsSync(here("./node_modules/@modelcontextprotocol/sdk/package.json"));
const NEEDS_SDK = SDK_INSTALLED ? false : "run `npm ci --prefix infra/mcp-sandbox --ignore-scripts` first";

const ECHO = {
  id: "echo",
  command: process.execPath,
  args: [here("./test/stdio-echo.mjs")],
  env: ["ECHO_GREETING"],
};
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
}

describe("stdio MCP sandbox bridge", { skip: NEEDS_SDK }, () => {
  let mod;
  let Client;
  let StreamableHTTPClientTransport;
  before(async () => {
    mod = await import("./bridge.mjs");
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
  });

  /** A bridge on an ephemeral loopback port; `env` is the sidecar's own environment. */
  async function start(opts = {}) {
    const lines = [];
    const bridge = mod.createBridge({
      servers: [ECHO],
      appDir: here("."),
      env: { PATH: process.env.PATH, ...opts.env },
      log: (line) => lines.push(line),
      ...opts,
    });
    const { port } = await bridge.listen(0, "127.0.0.1");
    return { bridge, base: `http://127.0.0.1:${port}`, lines };
  }
  async function connect(base, id = "echo") {
    const client = new Client({ name: "bridge-test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/${id}/mcp`));
    await client.connect(transport);
    return { client, transport };
  }
  const textOf = (result) => result.content.map((c) => c.text).join("");

  it("GET /healthz answers 200", async () => {
    const { bridge, base } = await start();
    try {
      const r = await fetch(`${base}/healthz`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, sessions: 0, maxSessions: 16 });
    } finally {
      await bridge.close();
    }
  });

  it("initialize + tools/list + tools/call over POST /echo/mcp, one child per MCP session", async () => {
    const { bridge, base, lines } = await start();
    try {
      const a = await connect(base);
      assert.equal(bridge.stats.spawned, 1);
      const { tools } = await a.client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["echo", "env", "pid"],
      );
      const res = await a.client.callTool({ name: "echo", arguments: { message: "from stdio" } });
      assert.equal(textOf(res), "echo: from stdio");
      await a.client.callTool({ name: "echo", arguments: { message: "again" } });
      assert.equal(bridge.stats.spawned, 1, "list and calls reuse the session's child");
      assert.equal(bridge.sessions.size, 1);

      const b = await connect(base);
      assert.equal(bridge.stats.spawned, 2, "a second MCP session gets its own child");
      const pidA = Number(textOf(await a.client.callTool({ name: "pid", arguments: {} })));
      const pidB = Number(textOf(await b.client.callTool({ name: "pid", arguments: {} })));
      assert.notEqual(pidA, pidB);
      await a.client.close();
      await b.client.close();
      // One line per session start, no payloads.
      assert.ok(lines.some((l) => /session [0-9a-f]{8} started server=echo/u.test(l)));
      assert.ok(!lines.some((l) => l.includes("from stdio")), "payloads never reach the log");
    } finally {
      await bridge.close();
    }
  });

  it("DELETE ends the session and its child exits", async () => {
    const { bridge, base, lines } = await start();
    try {
      const { client, transport } = await connect(base);
      const pid = Number(textOf(await client.callTool({ name: "pid", arguments: {} })));
      const sessionId = transport.sessionId;
      assert.ok(alive(pid));
      await transport.terminateSession();
      assert.ok(await until(() => !alive(pid)), "child exited");
      assert.equal(bridge.sessions.size, 0);
      const r = await fetch(`${base}/echo/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      assert.equal(r.status, 404, "a terminated session is gone");
      assert.ok(lines.some((l) => /ended reason=delete/u.test(l)));
      await client.close();
    } finally {
      await bridge.close();
    }
  });

  it("an unknown server id → 404 and nothing spawned", async () => {
    const { bridge, base } = await start();
    try {
      for (const path of ["/shell/mcp", "/everything/mcp", "/echo/other", "/echo%2Fx/mcp", "/ECHO/mcp"]) {
        const r = await fetch(`${base}${path}`, {
          method: "POST",
          headers: MCP_HEADERS,
          body: JSON.stringify(INIT),
        });
        assert.equal(r.status, 404, path);
      }
      assert.equal(bridge.stats.spawned, 0);
    } finally {
      await bridge.close();
    }
  });

  it("refuses what is not an MCP session start before spawning anything", async () => {
    const { bridge, base } = await start({ maxBodyBytes: 1024 });
    try {
      const post = (body, headers = {}) =>
        fetch(`${base}/echo/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body });
      assert.equal((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).status, 400);
      assert.equal((await post("{not json")).status, 400);
      assert.equal((await post(JSON.stringify({ ...INIT, pad: "x".repeat(2048) }))).status, 413);
      assert.equal((await post(JSON.stringify(INIT), { origin: "http://evil.example" })).status, 403);
      assert.equal((await fetch(`${base}/echo/mcp`, { method: "PUT" })).status, 405);
      const unknownSession = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {
        "mcp-session-id": "00000000-0000-4000-8000-000000000000",
      });
      assert.equal(unknownSession.status, 404);
      assert.equal(bridge.stats.spawned, 0);
    } finally {
      await bridge.close();
    }
  });

  it("the 17th concurrent session → 503", async () => {
    assert.equal(mod.MAX_SESSIONS, 16);
    const { bridge, base } = await start();
    const clients = [];
    try {
      for (let i = 0; i < 16; i++) clients.push(await connect(base));
      assert.equal(bridge.sessions.size, 16);
      const r = await fetch(`${base}/echo/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(INIT),
      });
      assert.equal(r.status, 503);
      assert.equal(bridge.stats.spawned, 16, "nothing spawned for the refused session");
      // A freed slot is usable again.
      await clients.shift().transport.terminateSession();
      assert.ok(await until(() => bridge.sessions.size === 15));
      clients.push(await connect(base));
      assert.equal(bridge.sessions.size, 16);
    } finally {
      await Promise.all(clients.map((c) => c.client.close()));
      await bridge.close();
    }
  });

  it("an idle session is reaped after SESSION_IDLE_MS and its child exits", async () => {
    assert.equal(mod.SESSION_IDLE_MS, 600_000);
    const { bridge, base, lines } = await start({ idleMs: 250 });
    try {
      const { client, transport } = await connect(base);
      const pid = Number(textOf(await client.callTool({ name: "pid", arguments: {} })));
      // Requests keep it alive, and so does the client's open GET stream (a connected client is not idle).
      for (let i = 0; i < 4; i++) {
        await sleep(100);
        await client.listTools();
      }
      await sleep(400);
      assert.equal(bridge.sessions.size, 1, "a connected client keeps its session");
      // The client goes away without DELETE (its streams close): reaped SESSION_IDLE_MS later.
      await client.close();
      assert.ok(await until(() => bridge.sessions.size === 0 && !alive(pid)), "reaped");
      assert.ok(lines.some((l) => /ended reason=idle/u.test(l)));
      const r = await fetch(`${base}/echo/mcp`, {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          "mcp-session-id": transport.sessionId,
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
      });
      assert.equal(r.status, 404);
    } finally {
      await bridge.close();
    }
  });

  it("a child that dies ends its session", async () => {
    const { bridge, base, lines } = await start();
    try {
      const { client } = await connect(base);
      const pid = Number(textOf(await client.callTool({ name: "pid", arguments: {} })));
      process.kill(pid, "SIGKILL");
      assert.ok(await until(() => bridge.sessions.size === 0));
      assert.ok(lines.some((l) => /ended reason=exit/u.test(l)));
      await client.close();
    } finally {
      await bridge.close();
    }
  });

  it("the child's environment holds only PATH, HOME=/tmp and the variables its allowlist entry names", async () => {
    const env = {
      ECHO_GREETING: "hello",
      OCW_CELL_TOKEN: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      NODE_OPTIONS: "--require /tmp/evil.js",
      HOME: "/home/node",
    };
    const { bridge, base } = await start({ env: { PATH: process.env.PATH, ...env } });
    // The SDK merges its default inherited variables (HOME, LOGNAME, PATH, SHELL, TERM, USER) from the bridge's
    // process.env: the bridge must strip those too.
    const saved = { USER: process.env.USER, SHELL: process.env.SHELL, TERM: process.env.TERM };
    Object.assign(process.env, { USER: "u", SHELL: "/bin/sh", TERM: "xterm", LOGNAME: "u" });
    try {
      const { client } = await connect(base);
      const seen = JSON.parse(textOf(await client.callTool({ name: "env", arguments: {} })));
      // macOS's CoreFoundation adds __CF_USER_TEXT_ENCODING inside any process that loads it; not inherited.
      const names = seen.names.filter((n) => !n.startsWith("__CF_"));
      assert.deepEqual(names, ["ECHO_GREETING", "HOME", "PATH"]);
      assert.equal(seen.home, "/tmp");
      await client.close();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete process.env.LOGNAME;
      await bridge.close();
    }
  });

  it("close() ends every session and kills every child", async () => {
    const { bridge, base } = await start();
    const a = await connect(base);
    const b = await connect(base);
    const pids = [];
    for (const c of [a, b])
      pids.push(Number(textOf(await c.client.callTool({ name: "pid", arguments: {} }))));
    await bridge.close();
    assert.ok(await until(() => pids.every((p) => !alive(p))));
    await a.client.close().catch(() => {});
    await b.client.close().catch(() => {});
  });

  describe("allowlist validation", () => {
    const appDir = here(".");
    const ok = (s) => mod.validateServers([s], { appDir });
    const bad = (s, re) => assert.throws(() => ok(s), re);
    it("accepts the test entry and the shipped servers.json", () => {
      assert.equal(ok(ECHO)[0].id, "echo");
      const shipped = mod.validateServers(read("./servers.json"), { appDir });
      assert.deepEqual(
        shipped.map((s) => s.id),
        ["everything"],
      );
    });
    it("refuses runtime installers, unsafe ids, loader-hijack env names, missing entry files and duplicates", () => {
      bad({ ...ECHO, command: "npx", args: ["-y", "pkg"] }, /runtime install/u);
      bad({ ...ECHO, command: "/usr/bin/npm" }, /runtime install/u);
      bad({ ...ECHO, args: ["-y", "x"] }, /runtime install/u);
      bad({ ...ECHO, id: "../x" }, /id/u);
      bad({ ...ECHO, id: "Echo" }, /id/u);
      for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "HOME", "lower"]) {
        bad({ ...ECHO, env: [name] }, /env/u);
      }
      bad({ ...ECHO, args: ["node_modules/missing/index.js"] }, /missing/u);
      assert.throws(() => mod.validateServers([ECHO, ECHO], { appDir }), /duplicate/u);
    });
  });
});

describe("sandbox image inputs (pinned, locked, allowlisted)", () => {
  const manifest = read("./package.json");
  const lock = read("./package-lock.json");
  const servers = read("./servers.json");

  it("pins the SDK and every baked server exactly", () => {
    assert.equal(manifest.dependencies["@modelcontextprotocol/sdk"], "1.30.0");
    assert.equal(manifest.dependencies["@modelcontextprotocol/server-everything"], "2026.8.31");
    assert.equal(lock.packages[""].dependencies["@modelcontextprotocol/sdk"], "1.30.0");
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/u, `${name} must be an exact version`);
      assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} locked at ${version}`);
    }
    // The sidecar's SDK stays the version the cell and OpenClaw ship (one copy, no nested second SDK).
    const sdks = Object.entries(lock.packages).filter(([k]) =>
      k.endsWith("node_modules/@modelcontextprotocol/sdk"),
    );
    assert.deepEqual(
      sdks.map(([, v]) => v.version),
      ["1.30.0"],
    );
  });

  it("every locked tarball comes from the npm registry with a sha512 integrity", () => {
    const entries = Object.entries(lock.packages).filter(([key]) => key !== "");
    assert.ok(entries.length > 0);
    for (const [key, entry] of entries) {
      assert.match(
        entry.resolved ?? "",
        /^https:\/\/registry\.npmjs\.org\//u,
        `${key} resolved from the registry`,
      );
      assert.match(entry.integrity ?? "", /^sha512-/u, `${key} has a sha512 integrity`);
    }
  });

  it("every allowlisted server is a baked, locked package run with node from the image", () => {
    assert.ok(servers.length > 0);
    for (const s of servers) {
      assert.equal(
        manifest.dependencies[s.package],
        s.version,
        `${s.id}: ${s.package} pinned in package.json`,
      );
      assert.equal(lock.packages[`node_modules/${s.package}`]?.version, s.version, `${s.id} locked`);
      assert.equal(s.command, "node", `${s.id} runs with the image's node`);
      assert.ok(s.args[0].startsWith(`node_modules/${s.package}/`), `${s.id} runs its baked entry file`);
      assert.deepEqual(s.env, [], `${s.id} needs no secrets`);
    }
  });
});

// `docker compose config` interpolates every service, so the required variables get dummy values here.
const COMPOSE_ENV = Object.fromEntries(
  [
    "POSTGRES_PASSWORD",
    "OCW_DB_APP_PASSWORD",
    "OCW_DB_AUTH_PASSWORD",
    "OCW_DB_MIGRATOR_PASSWORD",
    "BETTER_AUTH_SECRET",
    "OCW_SETUP_TOKEN",
    "OCW_ENCRYPTION_KEY",
    "OCW_CELL_TOKEN",
  ].map((k) => [k, "config-check"]),
);
const compose = (...args) =>
  spawnSync("docker", ["compose", "-p", "ocw-config-check", "-f", here("../../compose.yaml"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...COMPOSE_ENV },
  });
const NO_COMPOSE = compose("version").status === 0 ? false : "docker compose is not available";

describe("compose profile mcp-sandbox", { skip: NO_COMPOSE }, () => {
  let cfg;
  before(() => {
    const r = compose("--profile", "mcp-sandbox", "config", "--format", "json");
    assert.equal(r.status, 0, r.stderr);
    cfg = JSON.parse(r.stdout);
  });

  it("`docker compose --profile mcp-sandbox config -q` passes", () => {
    const r = compose("--profile", "mcp-sandbox", "config", "-q");
    assert.equal(r.status, 0, r.stderr);
  });

  it("the sidecar is locked down: read-only, no capabilities, no new privileges, limits, tmpfs /tmp", () => {
    const s = cfg.services["mcp-sandbox"];
    assert.ok(s, "service mcp-sandbox");
    assert.deepEqual(s.profiles, ["mcp-sandbox"]);
    assert.equal(s.read_only, true);
    assert.deepEqual(s.cap_drop, ["ALL"]);
    assert.equal(s.cap_add, undefined);
    assert.deepEqual(s.security_opt, ["no-new-privileges:true"]);
    assert.equal(s.user, "node");
    assert.equal(s.privileged ?? false, false);
    assert.ok(s.pids_limit > 0 && s.pids_limit <= 256, "pids_limit");
    assert.ok(Number(s.mem_limit) > 0, "mem_limit");
    assert.ok(Number(s.cpus) > 0, "cpus");
    assert.ok(
      (s.tmpfs ?? []).some((t) => t.startsWith("/tmp")),
      "tmpfs /tmp",
    );
  });

  it("no published ports, no volumes, no secrets, no environment beyond the bridge's own knobs", () => {
    const s = cfg.services["mcp-sandbox"];
    assert.equal(s.ports, undefined);
    assert.equal(s.volumes, undefined);
    assert.equal(s.secrets, undefined);
    assert.equal(s.env_file, undefined);
    const names = Object.keys(s.environment ?? {});
    for (const n of names) assert.match(n, /^MCP_SANDBOX_/u, `${n} is not a bridge setting`);
  });

  it("only an internal network, shared with openclaw and nothing else", () => {
    const s = cfg.services["mcp-sandbox"];
    assert.deepEqual(Object.keys(s.networks), ["mcp-sandbox"]);
    assert.equal(cfg.networks["mcp-sandbox"].internal, true);
    const members = Object.entries(cfg.services)
      .filter(([, svc]) => Object.keys(svc.networks ?? {}).includes("mcp-sandbox"))
      .map(([name]) => name)
      .sort();
    assert.deepEqual(members, ["mcp-sandbox", "openclaw"]);
    // The cell keeps its default network (it must still reach the API).
    assert.ok(Object.keys(cfg.services.openclaw.networks).includes("default"));
  });

  it("the API learns the sidecar URL and vetted servers from the environment", () => {
    const api = cfg.services.api.environment;
    assert.ok("OCW_MCP_SANDBOX_URL" in api);
    assert.ok("OCW_MCP_SANDBOX_SERVERS" in api);
  });

  it("the default stack (no profile) does not run the sidecar", () => {
    const r = compose("config", "--services");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.split("\n").includes("mcp-sandbox"));
  });
});
