// The Codex stdio shim (07.13-14, D-08, PD-08): `ocw-runtime browser-mcp` is the `ocw_browser` MCP server a Codex
// app-server starts for a browser-enabled session. Every call is one `browserCall` on the daemon's control socket, so
// the daemon's manager decides it exactly as it decides a Claude call. These tests run the real CLI entry against a real
// `ControlSocketServer` + `BrowserManager` (the fixture site and the pinned shell when cached), never a TCP port.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type SessionBrowserGrant, WORK_BROWSER_REFUSAL_TEXT } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ControlSocketServer, controlSocketPath } from "../control-socket.js";
import { silentLogger } from "../logger.js";
import { browsersRoot } from "./install.js";
import { BrowserManager } from "./manager.js";
import { TEST_BROWSER_HINT, testBrowser, testSandbox } from "./test-browser.js";
import { startTestSite, type TestSite } from "./test-site.js";
import { WORK_BROWSER_TOOL_TABLE } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "..", "..", "bin", "ocw-runtime");

const executable = await testBrowser();
if (!executable) console.warn(TEST_BROWSER_HINT);

const ALLOW: SessionBrowserGrant = {
  allowed: true,
  reason: "ok",
  askerId: "00000000-0000-4000-8000-000000000001",
  askerIsBot: false,
  alwaysAsk: [],
  whenTainted: [],
  signinAllowed: false,
};

interface Daemonish {
  home: string;
  manager: BrowserManager;
  control: ControlSocketServer;
  /** A session with an allowed running turn; answers its token file. */
  session(): Promise<{ sid: string; tokenFile: string }>;
  close(): Promise<void>;
}

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

/** A daemon's browser half: the manager under `<home>/browsers` and the control socket at `<home>/runtime.sock`. */
async function daemonish(): Promise<Daemonish> {
  const home = mkdtempSync(join(tmpdir(), "ocw-shim-"));
  homes.push(home);
  const manager = new BrowserManager({
    root: browsersRoot({ OCW_HOME: home }),
    link: { send: () => undefined, sendBinary: () => false },
    api: { put: async () => 404 },
    optIn: () => true,
    sandbox: () => testSandbox(),
    emit: () => undefined,
    browsers: {
      installed: async () => (executable ? { executable, version: "156.0.8078.47" } : null),
      install: async () => {
        throw new Error("no install in tests");
      },
    },
    childEntry: [ENTRY],
    log: silentLogger,
  });
  const control = new ControlSocketServer(controlSocketPath(home), async (req) => {
    if (req.cmd !== "browserCall") throw new Error("unsupported");
    return manager.shimCall(req);
  });
  await control.listen();
  return {
    home,
    manager,
    control,
    session: async () => {
      const sid = randomUUID();
      manager.onPrompt(sid, null, ALLOW);
      manager.onPrompt(sid, "p1", ALLOW);
      manager.onTurnStarted(sid, "p1");
      return { sid, tokenFile: await manager.forSession(sid).shimTokenFile() };
    },
    close: async () => {
      await manager.stopAll();
      await control.close();
    },
  };
}

function shimEnv(home: string, sid: string, tokenFile: string): Record<string, string> {
  return { OCW_HOME: home, OCW_BROWSER_SESSION: sid, OCW_BROWSER_TOKEN_FILE: tokenFile };
}

async function connect(env: Record<string, string>): Promise<{ client: Client; errors: Error[] }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "browser-mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "ocw-shim-test", version: "0.0.0" });
  const errors: Error[] = [];
  client.onerror = (err) => errors.push(err);
  await client.connect(transport);
  return { client, errors };
}

const textOf = (r: { content?: unknown }): string =>
  ((r.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

describe("ocw-runtime browser-mcp: the shim never refuses on its own and never listens", () => {
  let d: Daemonish;
  const clients: Client[] = [];
  beforeAll(async () => {
    d = await daemonish();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  });
  afterAll(async () => {
    await d?.close();
  });

  it("lists exactly the tool table (short names, the table's descriptions, an input schema each)", async () => {
    const { sid, tokenFile } = await d.session();
    const { client, errors } = await connect(shimEnv(d.home, sid, tokenFile));
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(WORK_BROWSER_TOOL_TABLE).sort());
    for (const t of tools) {
      const spec = WORK_BROWSER_TOOL_TABLE[t.name as keyof typeof WORK_BROWSER_TOOL_TABLE];
      expect(t.description).toBe(spec?.description);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(tools.find((t) => t.name === "open")?.inputSchema.properties).toHaveProperty("url");
    expect(client.getServerVersion()?.name).toBe("ocw_browser");
    expect(errors).toEqual([]);
  }, 30_000);

  it("a token that is no longer the session's gets the daemon's refusal as an MCP error result, not a throw", async () => {
    const { sid, tokenFile } = await d.session();
    const { client } = await connect(shimEnv(d.home, sid, tokenFile));
    clients.push(client);
    // Another token in the session's file now: the shim still sends the one it read at start.
    writeFileSync(tokenFile, `${randomBytes(32).toString("hex")}\n`);
    const res = await client.callTool({ name: "open", arguments: { url: "http://127.0.0.1:9/" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(`Refused: ${WORK_BROWSER_REFUSAL_TEXT.not_allowed}`);
  }, 30_000);

  it("a session the daemon does not know is refused the same way", async () => {
    const sid = randomUUID();
    const runDir = join(browsersRoot({ OCW_HOME: d.home }), "run", sid);
    const { ensureShimToken } = await import("./shim-token.js");
    const tokenFile = await ensureShimToken(runDir);
    const { client } = await connect(shimEnv(d.home, sid, tokenFile));
    clients.push(client);
    const res = await client.callTool({ name: "snapshot", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(`Refused: ${WORK_BROWSER_REFUSAL_TEXT.not_allowed}`);
  }, 30_000);

  it("exits non-zero before serving when the token file is missing or outside the session's run dir", async () => {
    const { sid, tokenFile } = await d.session();
    const run = (env: Record<string, string>) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((ok) => {
        const p = spawn(process.execPath, [ENTRY, "browser-mcp"], {
          env: { PATH: process.env.PATH ?? "", HOME: d.home, ...env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (c) => {
          stdout += String(c);
        });
        p.stderr.on("data", (c) => {
          stderr += String(c);
        });
        p.on("exit", (code) => ok({ code, stdout, stderr }));
      });
    const missing = await run(shimEnv(d.home, sid, join(dirname(tokenFile), "nope")));
    expect(missing.code).not.toBe(0);
    expect(missing.stdout).toBe("");
    // The diagnostic names no path and no token.
    expect(missing.stderr).not.toContain(d.home);
    const elsewhere = join(d.home, "shim-token");
    writeFileSync(elsewhere, readFileSync(tokenFile));
    const outside = await run(shimEnv(d.home, sid, elsewhere));
    expect(outside.code).not.toBe(0);
    expect(outside.stdout).toBe("");
    const noSession = await run(shimEnv(d.home, "not-a-uuid", tokenFile));
    expect(noSession.code).not.toBe(0);
  }, 30_000);

  it("writes only JSON-RPC frames to stdout", async () => {
    const { sid, tokenFile } = await d.session();
    const p = spawn(process.execPath, [ENTRY, "browser-mcp"], {
      env: { PATH: process.env.PATH ?? "", HOME: d.home, ...shimEnv(d.home, sid, tokenFile) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    p.stdout.on("data", (c) => {
      stdout += String(c);
    });
    const send = (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "close", arguments: {} } });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && stdout.split("\n").filter(Boolean).length < 3) {
      await new Promise((r) => setTimeout(r, 50));
    }
    p.stdin.end();
    await new Promise((r) => p.once("exit", r));
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  }, 30_000);

  it("opens no TCP port: the module has no server and no listen call", () => {
    const src = readFileSync(join(HERE, "mcp-shim.ts"), "utf8");
    expect(src).not.toMatch(/createServer\(|listen\(/);
  });
});

describe.skipIf(!executable)("ocw-runtime browser-mcp over a real Chromium (07.13-14 Task 1, tracer)", () => {
  let site: TestSite;
  let d: Daemonish;
  beforeAll(async () => {
    site = await startTestSite();
    d = await daemonish();
  });
  afterAll(async () => {
    await d?.close();
    await site?.close();
  });

  it("an MCP client spawning the shim opens the fixture page and gets the manager's result", async () => {
    const { sid, tokenFile } = await d.session();
    const { client, errors } = await connect(shimEnv(d.home, sid, tokenFile));
    try {
      const res = await client.callTool({ name: "open", arguments: { url: site.url("/") } });
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text.split("\n")[0]).toBe(`Opened ${site.host}`);
      expect(text).toContain("Signed in: no");
      expect(d.manager.openPages).toBe(1);
      const bad = await client.callTool({ name: "wait", arguments: { ms: 1, text: "x", extra: true } });
      expect(bad.isError).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  }, 60_000);
});
