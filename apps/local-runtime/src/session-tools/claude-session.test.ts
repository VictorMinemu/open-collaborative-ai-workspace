// 07.13.1.1 (D-07, PD-08, Pitfalls 7 and 8): a Claude Code session gets `ocw_session` as an in-process SDK MCP server
// beside `ocw_browser`. The adapter registers both of ours together, lets our own `rename` run without an approval,
// denies a foreign server of the same name in every mode and turns the tool off when a project server shadows it; the
// mapper shows the call as `ocw_session_rename` with a summary only.

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HookCallback,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  McpServerStatus,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type PermissionMode,
  SESSION_RENAME_REFUSAL_TEXT,
  type SessionEvent,
  type SessionToolsGrant,
} from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncQueue } from "../async-queue.js";
import type { SessionBrowserTools } from "../browser/manager.js";
import type { WorkBrowserToolResult } from "../browser/tools.js";
import { ClaudeCodeRuntime, type QueryHandle } from "../claude/claude-runtime.js";
import { ClaudeEventMapper } from "../claude/mapper.js";
import type { StartSessionOptions } from "../runtime.js";
import { sanitizeEvent } from "../sanitize.js";
import { SessionToolRelay } from "./relay.js";
import { renameDescription } from "./tools.js";

const ALLOW: SessionToolsGrant = { rename: true, namingRules: null };

class FakeQuery implements QueryHandle {
  readonly out = new AsyncQueue<SDKMessage>();
  readonly log: string[] = [];
  readonly calls: Array<{ method: string; arg: unknown }> = [];
  mcpStatus: McpServerStatus[] = [];
  constructor(readonly params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    void (async () => {
      for await (const m of params.prompt) this.log.push(`prompt:${String(m.message.content)}`);
      this.out.close();
    })();
  }
  emit(m: Record<string, unknown>): void {
    this.out.push(m as unknown as SDKMessage);
  }
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
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<unknown> {
    this.calls.push({ method: "setMcpServers", arg: servers });
    this.log.push(`setMcpServers:${Object.keys(servers).sort().join(",")}`);
    return Promise.resolve({ added: Object.keys(servers), removed: [], errors: {} });
  }
  mcpServerStatus(): Promise<McpServerStatus[]> {
    this.calls.push({ method: "mcpServerStatus", arg: undefined });
    return Promise.resolve(this.mcpStatus);
  }
  methodCalls(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.arg);
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.out[Symbol.asyncIterator]();
  }
}

/** A browser the test switches on and off (the manager's rules are not under test here). */
class StubBrowser implements SessionBrowserTools {
  available = false;
  unavailable: string | null = null;
  private readonly cbs = new Set<(a: boolean) => void>();
  async call(): Promise<WorkBrowserToolResult> {
    return { content: [{ type: "text", text: "x" }], isError: false, summary: "x", origin: null };
  }
  markUnavailable(reason: "shadowed" | "runtime"): void {
    this.unavailable = reason;
    this.set(false);
  }
  onAvailableChange(cb: (a: boolean) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  setImageInput(): void {}
  async shimTokenFile(): Promise<string> {
    return "/nowhere";
  }
  set(on: boolean): void {
    this.available = on;
    for (const cb of this.cbs) cb(on);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick();
};
const signal = () => new AbortController().signal;

const dirs: string[] = [];
let stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops) await s();
  stops = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(extra: { prepare?: (q: FakeQuery) => void; allowFullAccess?: boolean } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-claude-session-")));
  dirs.push(cwd);
  const queries: FakeQuery[] = [];
  const events: SessionEvent[] = [];
  const relay = new SessionToolRelay({
    send: () => false,
    rootsFor: () => [cwd],
    ocwHome: cwd,
  });
  const runtime = new ClaudeCodeRuntime({
    queryFn: (params) => {
      const q = new FakeQuery(params);
      extra.prepare?.(q);
      queries.push(q);
      return q;
    },
    claudePath: "/usr/local/bin/claude",
    catalogCwd: cwd,
    detect: () => Promise.resolve({ id: "claude-code", installed: true, version: "2.1.332", loggedIn: true }),
    ...(extra.allowFullAccess ? { allowFullAccess: () => true } : {}),
  });
  stops.push(async () => {
    await runtime.stopAll();
    await relay.stop();
  });
  const start = async (
    more: Partial<Omit<StartSessionOptions, "sessionId" | "cwd">> & { sessionId?: string } = {},
  ) => {
    const sid = more.sessionId ?? randomUUID();
    await runtime.start({ sessionId: sid, cwd, permissionMode: "default", ...more }, (e) => events.push(e));
    const q = queries.at(-1);
    if (!q) throw new Error("query not created");
    return { q, sid };
  };
  return { cwd, runtime, relay, queries, events, start };
}

const sdkServer = (servers: Record<string, unknown> | undefined, name: string) => {
  const s = servers?.[name] as McpSdkServerConfigWithInstance | undefined;
  return s?.type === "sdk" ? s : undefined;
};

async function mcpClient(server: McpSdkServerConfigWithInstance): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "claude-session-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("ClaudeCodeRuntime registers the in-process ocw_session server (07.13.1.1 Task 3)", () => {
  it("an offered handle → ocw_session (sdk) at launch beside ocw_browser; no handle → none", async () => {
    const h = harness();
    const sid = randomUUID();
    h.relay.onPrompt(sid, null, ALLOW);
    const browser = new StubBrowser();
    browser.available = true;
    const { q } = await h.start({ sessionId: sid, sessionTools: h.relay.forSession(sid), browser });
    const session = sdkServer(q.params.options.mcpServers, "ocw_session");
    expect(session?.name).toBe("ocw_session");
    expect(sdkServer(q.params.options.mcpServers, "ocw_browser")).toBeDefined();
    if (!session) throw new Error("no ocw_session server");
    const client = await mcpClient(session);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["rename"]);
      expect(listed.tools[0]?.description).toBe(renameDescription(null));
      expect(listed.tools[0]?._meta?.["anthropic/alwaysLoad"]).toBe(true);
      // Outside a turn the relay answers, through the server, its fixed sentence.
      const answer = await client.callTool({ name: "rename", arguments: { title: "Fix login redirect" } });
      expect(answer).toMatchObject({
        isError: true,
        content: [{ type: "text", text: SESSION_RENAME_REFUSAL_TEXT.no_turn }],
      });
    } finally {
      await client.close();
    }

    const none = await h.start();
    expect(none.q.params.options.mcpServers?.ocw_session).toBeUndefined();
    // A handle without a grant is not offered: no server either.
    const other = randomUUID();
    const notOffered = await h.start({ sessionId: other, sessionTools: h.relay.forSession(other) });
    expect(notOffered.q.params.options.mcpServers?.ocw_session).toBeUndefined();
  });

  it("a browser toggle re-registers with ocw_session still present; a rules change re-registers between turns only", async () => {
    const h = harness();
    const sid = randomUUID();
    h.relay.onPrompt(sid, null, ALLOW);
    const browser = new StubBrowser();
    const { q } = await h.start({ sessionId: sid, sessionTools: h.relay.forSession(sid), browser });
    expect(Object.keys(q.params.options.mcpServers ?? {})).toEqual(["ocw_session"]);

    browser.set(true);
    await settle();
    expect(q.log.at(-1)).toBe("setMcpServers:ocw_browser,ocw_session");
    browser.set(false);
    await settle();
    expect(q.log.at(-1)).toBe("setMcpServers:ocw_session");

    // A turn runs: the new rules wait for the next turn.
    h.relay.onPrompt(sid, "p1", ALLOW);
    await h.runtime.prompt(sid, { promptId: "p1", text: "one" });
    await settle();
    const before = q.methodCalls("setMcpServers").length;
    h.relay.onPrompt(sid, "p2", { rename: true, namingRules: "Start with the ticket id." });
    await h.runtime.prompt(sid, { promptId: "p2", text: "two" });
    await settle();
    expect(q.methodCalls("setMcpServers")).toHaveLength(before);
    q.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await settle();
    const calls = q.methodCalls("setMcpServers") as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(before + 1);
    expect(q.log.lastIndexOf("setMcpServers:ocw_session")).toBeLessThan(q.log.indexOf("prompt:two"));
    const server = sdkServer(calls.at(-1), "ocw_session");
    if (!server) throw new Error("no ocw_session server");
    const client = await mcpClient(server);
    try {
      const listed = await client.listTools();
      expect(listed.tools[0]?.description).toBe(renameDescription("Start with the ticket id."));
    } finally {
      await client.close();
    }
    expect(h.queries).toHaveLength(1);
  });

  it("canUseTool allows our sdk rename without an approval; another source is denied with a fixed reason", async () => {
    const h = harness();
    const sid = randomUUID();
    h.relay.onPrompt(sid, null, ALLOW);
    const { q } = await h.start({ sessionId: sid, sessionTools: h.relay.forSession(sid) });
    const canUseTool = q.params.options.canUseTool;
    await expect(
      canUseTool?.("mcp__ocw_session__rename", { title: "Fix login" }, {
        signal: signal(),
        mcpServer: { name: "ocw_session", source: "sdk" },
      } as never),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { title: "Fix login" } });
    for (const mcpServer of [{ name: "ocw_session", source: "project" }, undefined]) {
      await expect(
        canUseTool?.("mcp__ocw_session__rename", { title: "Fix login" }, {
          signal: signal(),
          ...(mcpServer ? { mcpServer } : {}),
        } as never),
      ).resolves.toEqual({ behavior: "deny", message: SESSION_RENAME_REFUSAL_TEXT.not_available });
    }
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
  });

  it.each<PermissionMode>(["default", "acceptEdits", "plan", "fullAccess"])(
    "the PreToolUse hook denies a foreign ocw_session in %s and lets ours through",
    async (mode) => {
      const h = harness({ allowFullAccess: true });
      const sid = randomUUID();
      h.relay.onPrompt(sid, null, ALLOW);
      const { q } = await h.start({
        sessionId: sid,
        permissionMode: mode,
        sessionTools: h.relay.forSession(sid),
      });
      const hook = q.params.options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
      const pre = (server?: { name: string; source: string }) =>
        hook(
          {
            hook_event_name: "PreToolUse",
            tool_name: "mcp__ocw_session__rename",
            tool_input: { title: "Fix login" },
            ...(server ? { mcp_server: server } : {}),
          } as never,
          undefined,
          { signal: signal() },
        );
      await expect(pre({ name: "ocw_session", source: "project" })).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      await expect(pre()).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      await expect(pre({ name: "ocw_session", source: "sdk" })).resolves.toEqual({});
    },
  );

  it("a project server named ocw_session turns the tool off and drops ours; the browser is unaffected", async () => {
    const h = harness({
      prepare: (q) => {
        q.mcpStatus = [
          { name: "ocw_session", status: "connected", config: { type: "stdio", command: "node" } },
          {
            name: "ocw_browser",
            status: "connected",
            source: "sdk",
            config: { type: "sdk", name: "ocw_browser" },
          },
        ];
      },
    });
    const sid = randomUUID();
    h.relay.onPrompt(sid, null, ALLOW);
    const browser = new StubBrowser();
    browser.available = true;
    const handle = h.relay.forSession(sid);
    const { q } = await h.start({ sessionId: sid, sessionTools: handle, browser });
    q.emit({ type: "system", subtype: "init", permissionMode: "default", session_id: "x" });
    await settle();
    expect(q.methodCalls("mcpServerStatus")).toHaveLength(1);
    expect(handle.offered).toBe(false);
    expect(browser.unavailable).toBeNull();
    expect(q.log.at(-1)).toBe("setMcpServers:ocw_browser");
    await expect(
      q.params.options.canUseTool?.("mcp__ocw_session__rename", {}, {
        signal: signal(),
        mcpServer: { name: "ocw_session", source: "sdk" },
      } as never),
    ).resolves.toMatchObject({ behavior: "deny" });
    // A later grant does not bring it back for this session.
    h.relay.onPrompt(sid, "p1", { rename: true, namingRules: "New rules." });
    await settle();
    expect(q.log.at(-1)).toBe("setMcpServers:ocw_browser");
  });
});

describe("ClaudeEventMapper: ocw_session calls (07.13.1.1, the synthetic fixture)", () => {
  it("maps the fixture to ocw_session_rename with the result's first line and never the arguments", () => {
    const lines = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "claude",
        "__fixtures__",
        "claude-code-2.1.332.session-mcp.synthetic.sdk.jsonl",
      ),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const [head, ...messages] = lines;
    expect(head).toMatchObject({ synthetic: true, derivedFrom: expect.stringContaining("0.3.282") });
    const mapper = new ClaudeEventMapper();
    mapper.currentPromptId = "p1";
    const events = messages
      .flatMap((m) => mapper.map(m as unknown as SDKMessage))
      .map((e) => sanitizeEvent(e, ["/tmp/ocw-fixture-repo"]));
    const tools = events.filter((e) => e.type === "tool.started" || e.type === "tool.completed");
    expect(tools).toEqual([
      {
        type: "tool.started",
        toolUseId: "toolu_synthetic_rename",
        name: "ocw_session_rename",
        summary: "Renaming the session",
      },
      {
        type: "tool.completed",
        toolUseId: "toolu_synthetic_rename",
        ok: true,
        summary: 'Renamed the session to "Fix LOGIN redirect loop".',
      },
      {
        type: "tool.started",
        toolUseId: "toolu_synthetic_rename_again",
        name: "ocw_session_rename",
        summary: "Renaming the session",
      },
      {
        type: "tool.completed",
        toolUseId: "toolu_synthetic_rename_again",
        ok: false,
        summary: SESSION_RENAME_REFUSAL_TEXT.already_renamed,
      },
    ]);
    const json = JSON.stringify(events);
    expect(json).not.toContain("fix LOGIN redirect loop.");
    expect(json).not.toContain("fix the redirect, again");
    expect(json).not.toContain('"input"');
  });

  it("an unexpected result text is not forwarded: a fixed summary instead", () => {
    const mapper = new ClaudeEventMapper();
    mapper.map({
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "tool_use", id: "t1", name: "mcp__ocw_session__rename", input: {} }],
      },
    } as unknown as SDKMessage);
    const [done] = mapper.map({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "see /etc/passwd\nmore" }],
          },
        ],
      },
    } as unknown as SDKMessage);
    expect(done).toEqual({
      type: "tool.completed",
      toolUseId: "t1",
      ok: true,
      summary: "ocw_session_rename completed",
    });
  });
});
