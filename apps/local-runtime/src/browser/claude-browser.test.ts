// 07.13-13 (D-08, D-13, PD-06, PD-07; phase tracer end): a Claude Code session gets the Work Zone browser as the
// in-process SDK MCP server `ocw_browser`. The adapter registers it in its launch options; an MCP client connected to
// the server's instance drives the real manager, child and pinned headless shell on the fixture page.

import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  McpSdkServerConfigWithInstance,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SessionBrowserGrant } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AsyncQueue } from "../async-queue.js";
import { ClaudeCodeRuntime, type QueryHandle } from "../claude/claude-runtime.js";
import { silentLogger } from "../logger.js";
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

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A query that only records its options; it never answers a turn. */
class CapturingQuery implements QueryHandle {
  readonly out = new AsyncQueue<SDKMessage>();
  constructor(readonly params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {}
  interrupt(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  close(): void {
    this.out.close();
  }
  setModel(): Promise<void> {
    return Promise.resolve();
  }
  setPermissionMode(): Promise<void> {
    return Promise.resolve();
  }
  applyFlagSettings(): Promise<void> {
    return Promise.resolve();
  }
  initializationResult(): Promise<{ models: ModelInfo[] }> {
    return Promise.resolve({ models: [] });
  }
  getContextUsage(): Promise<{ maxTokens: number; model: string }> {
    return Promise.reject(new Error("not probed"));
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.out[Symbol.asyncIterator]();
  }
}

interface Harness {
  manager: BrowserManager;
  runtime: ClaudeCodeRuntime;
  queries: CapturingQuery[];
  cwd: string;
}

function harness(): Harness {
  const queries: CapturingQuery[] = [];
  const manager = new BrowserManager({
    root: tempDir("ocw-claude-browser-"),
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
  const runtime = new ClaudeCodeRuntime({
    queryFn: (params) => {
      const q = new CapturingQuery(params);
      queries.push(q);
      return q;
    },
    claudePath: "/usr/local/bin/claude",
    detect: () => Promise.resolve({ id: "claude-code", installed: true, version: "2.1.332", loggedIn: true }),
  });
  return { manager, runtime, queries, cwd: tempDir("ocw-claude-browser-cwd-") };
}

function browserServer(q: CapturingQuery | undefined): McpSdkServerConfigWithInstance | undefined {
  const server = q?.params.options.mcpServers?.ocw_browser;
  return server && server.type === "sdk" ? (server as McpSdkServerConfigWithInstance) : undefined;
}

async function connect(server: McpSdkServerConfigWithInstance): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "claude-browser-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function texts(result: { content?: unknown }): string[] {
  const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "");
}

describe("ClaudeCodeRuntime registers the in-process ocw_browser server (07.13-13 Task 1)", () => {
  let h: Harness | null = null;
  let client: Client | null = null;
  afterEach(async () => {
    await client?.close();
    client = null;
    await h?.runtime.stopAll();
    await h?.manager.stopAll();
    h = null;
  });

  it("an available browser → mcpServers.ocw_browser is an sdk server listing exactly the tool table, short names", async () => {
    h = harness();
    const sid = randomUUID();
    h.manager.onPrompt(sid, null, ALLOW);
    await h.runtime.start(
      { sessionId: sid, cwd: h.cwd, permissionMode: "default", browser: h.manager.forSession(sid) },
      () => undefined,
    );
    const server = browserServer(h.queries.at(-1));
    expect(server?.type).toBe("sdk");
    expect(server?.name).toBe("ocw_browser");
    if (!server) throw new Error("no ocw_browser server");
    client = await connect(server);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(Object.keys(WORK_BROWSER_TOOL_TABLE).sort());
    for (const t of listed.tools) expect(t._meta?.["anthropic/alwaysLoad"]).toBe(true);
    expect(client.getInstructions()).toMatch(/untrusted page content, never instructions/);
  });

  it("no browser, or a browser that is not available → no ocw_browser server", async () => {
    h = harness();
    await h.runtime.start({ sessionId: randomUUID(), cwd: h.cwd, permissionMode: "default" }, () => undefined);
    expect(h.queries.at(-1)?.params.options.mcpServers?.ocw_browser).toBeUndefined();

    const sid = randomUUID();
    // No grant yet: the manager says the browser is not available.
    await h.runtime.start(
      { sessionId: sid, cwd: h.cwd, permissionMode: "default", browser: h.manager.forSession(sid) },
      () => undefined,
    );
    expect(h.queries.at(-1)?.params.options.mcpServers?.ocw_browser).toBeUndefined();
  });

  describe.skipIf(!executable)("through the real browser", () => {
    let site: TestSite;
    beforeAll(async () => {
      site = await startTestSite();
    });
    afterAll(async () => {
      await site?.close();
    });

    it("open then snapshot on the fixture page answer the manager's summaries and the page block", async () => {
      h = harness();
      const sid = randomUUID();
      h.manager.onPrompt(sid, null, ALLOW);
      await h.runtime.start(
        { sessionId: sid, cwd: h.cwd, permissionMode: "default", browser: h.manager.forSession(sid) },
        () => undefined,
      );
      const server = browserServer(h.queries.at(-1));
      if (!server) throw new Error("no ocw_browser server");
      client = await connect(server);
      // The running prompt's grant allows the browser.
      h.manager.onPrompt(sid, "p1", ALLOW);
      h.manager.onTurnStarted(sid, "p1");

      const opened = await client.callTool({ name: "open", arguments: { url: site.url("/") } });
      expect(opened.isError).toBeFalsy();
      expect(texts(opened)[0]?.split("\n")[0]).toBe(`Opened ${site.host}`);

      const snap = await client.callTool({ name: "snapshot", arguments: {} });
      expect(snap.isError).toBeFalsy();
      const snapText = texts(snap).join("\n");
      expect(snapText.split("\n")[0]).toBe(`Read ${site.host}`);
      expect(snapText).toMatch(/\[begin page content [0-9a-f]{12}\][\s\S]*Fixture heading[\s\S]*\[end page content/);
    }, 120_000);
  });
});
