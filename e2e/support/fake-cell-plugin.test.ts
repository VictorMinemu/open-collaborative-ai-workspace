import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin, type MentionPayload } from "./fake-cell-plugin";

/**
 * 07.8-08: the fake cell's confined tool calls, against a stub Agent Channel. A success renders the result; a refusal
 * renders `refused (<code>)` only for a code of the contract's `SandboxRefusal` / `BrowserRefusal` enums.
 */

const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
let server: Server;
let plugin: FakeCellPlugin;

const answers: Record<string, [number, unknown]> = {
  "/agent-channel/v1/sandbox/exec": [
    200,
    { status: "exited", exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, durationMs: 3 },
  ],
  "/agent-channel/v1/sandbox/read": [409, { error: { code: "arguments_invalid", message: "x" } }],
  "/agent-channel/v1/sandbox/list": [403, { error: { code: "killed", message: "x" } }],
  "/agent-channel/v1/browser/open": [403, { error: { code: "sandbox_off", message: "x" } }],
  "/agent-channel/v1/browser/snapshot": [409, { error: { code: "paused", message: "x" } }],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body: text ? JSON.parse(text) : {} });
      const [status, body] = answers[req.url ?? ""] ?? [404, { error: { code: "route_not_found" } }];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  plugin = new FakeCellPlugin({ apiUrl: `http://127.0.0.1:${port}`, token: "cell-token" });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const mention = {
  eventId: "00000000-0000-4000-8000-0000000000e1",
  agent: { id: "00000000-0000-4000-8000-0000000000a1", handle: "scout", displayName: "Scout" },
  message: { id: "m1", text: "", author: { kind: "user", id: "u1", displayName: "Sam" } },
  turn: { tools: ["ocw_sandbox_exec", "ocw_browser_open"] },
} as unknown as MentionPayload;

describe("FakeCellPlugin confined calls", () => {
  it("a sandbox success posts the turn's ids and the arguments to /sandbox/exec and renders the result", async () => {
    expect(await plugin.sandbox(mention, "ocw_sandbox_exec", { argv: ["echo", "hi"] })).toBe("exit 0: hi");
    expect(seen.at(-1)).toEqual({
      path: "/agent-channel/v1/sandbox/exec",
      body: { argv: ["echo", "hi"], eventId: mention.eventId, agentId: mention.agent.id },
    });
    expect(plugin.confinedRequests.at(-1)).toMatchObject({
      keys: ["agentId", "argv", "eventId"],
      status: 200,
    });
  });

  it("a refusal with a contract code reads `refused (<code>)`; another code reads `failed (<status>)`", async () => {
    expect(await plugin.sandbox(mention, "ocw_sandbox_list", { path: "" })).toBe("refused (killed)");
    expect(await plugin.sandbox(mention, "ocw_sandbox_read", { path: "a.txt" })).toBe("failed (409)");
    expect(await plugin.browser(mention, "ocw_browser_open", { url: "https://a.test/" })).toBe(
      "refused (sandbox_off)",
    );
    expect(await plugin.browser(mention, "ocw_browser_snapshot", {})).toBe("refused (paused)");
  });

  it("[[call …]] directives for confined tools go through the same calls (never /tool-calls)", async () => {
    const lines = await plugin.simulateToolCalls(mention, [
      { tool: "ocw_sandbox_exec", args: { argv: ["echo", "hi"] } },
      { tool: "ocw_browser_open", args: { url: "https://a.test/" } },
      { tool: "ocw_sandbox_write", args: { path: "a", content: "b" } },
    ]);
    expect(lines).toEqual([
      "Tool ocw_sandbox_exec: exit 0: hi",
      "Tool ocw_browser_open: refused (sandbox_off)",
      "Tool ocw_sandbox_write: not offered",
    ]);
    expect(seen.some((r) => r.path.endsWith("/tool-calls"))).toBe(false);
  });
});
