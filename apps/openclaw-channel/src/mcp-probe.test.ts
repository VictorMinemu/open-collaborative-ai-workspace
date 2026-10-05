/**
 * The cell's MCP probe (D-13, 03.1-10) against the repo's fake MCP server, run in-process: the official SDK client
 * over streamable HTTP and SSE, bearer credentials from the snapshot, errors that never carry a header value.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeMcp } from "../../../infra/fake-model/fake-mcp.mjs";
import type { CellMcpServer } from "./agent-channel-protocol.js";
import { probeErrorMessage, probeMcpServer, toProbeTools } from "./mcp-probe.js";

const TOKEN = "fake-mcp-probe-token-1234";
let server: Server;
let base: string;
/** Accepts connections and never answers (a black-holed endpoint). */
let silent: Server;
let silentBase: string;

const listen = (s: Server) =>
  new Promise<string>((resolve) =>
    s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
  );

function entry(over: Partial<CellMcpServer> = {}): CellMcpServer {
  return {
    id: "srv-1",
    safeName: "m0a1b2c3d",
    transport: "streamable-http",
    url: `${base}/mcp`,
    headers: [{ name: "Authorization", envName: "OCW_MCP_M0A1B2C3D_0", value: `Bearer ${TOKEN}` }],
    tools: [],
    ...over,
  };
}

beforeAll(async () => {
  const mcp = createFakeMcp({ token: TOKEN });
  server = createServer((req, res) => {
    if (!mcp(req, res, new URL(req.url ?? "/", "http://localhost"))) {
      res.writeHead(404);
      res.end();
    }
  });
  base = await listen(server);
  silent = createServer(() => {
    /* never answers */
  });
  silentBase = await listen(silent);
});

afterAll(async () => {
  server.closeAllConnections();
  silent.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => silent.close(r))]);
});

describe("probeMcpServer (official SDK client)", () => {
  it("streamable HTTP: lists echo (read-only) and write_note (destructive)", async () => {
    const r = await probeMcpServer(entry());
    expect(r).toEqual({
      ok: true,
      tools: [
        {
          name: "echo",
          title: "Echo",
          description: "Echo the given text back. Read-only.",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: "write_note",
          title: "Write note",
          description: "Store a note on the server. Has side effects.",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    });
  });

  it("SSE (transport sse): the same two tools", async () => {
    const r = await probeMcpServer(entry({ transport: "sse", url: `${base}/sse` }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.tools.map((t) => [t.name, t.annotations])).toEqual([
      ["echo", { readOnlyHint: true, destructiveHint: false }],
      ["write_note", { readOnlyHint: false, destructiveHint: true }],
    ]);
  });

  it("a wrong bearer token fails with a short message that carries no header value", async () => {
    for (const transport of ["streamable-http", "sse"] as const) {
      const r = await probeMcpServer(
        entry({
          transport,
          url: `${base}/${transport === "sse" ? "sse" : "mcp"}`,
          headers: [
            { name: "Authorization", envName: "OCW_MCP_M0A1B2C3D_0", value: "Bearer wrong-token-value-999" },
          ],
        }),
      );
      expect(r.ok, transport).toBe(false);
      if (r.ok) continue;
      expect(r.error).toMatch(/401|unauthori[sz]ed/i);
      expect(r.error).not.toContain("wrong-token-value-999");
      expect(r.error).not.toContain(TOKEN);
      expect(r.error.length).toBeLessThanOrEqual(300);
    }
  });

  it("an unreachable host fails fast; a black-holed endpoint fails within the timeout", async () => {
    // A port reserved, then released: nothing listens there any more.
    const released = createServer();
    const closedBase = await listen(released);
    await new Promise((r) => released.close(r));
    const refused = await probeMcpServer(entry({ url: `${closedBase}/mcp` }), { timeoutMs: 5_000 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/could not reach/i);

    const started = Date.now();
    const r = await probeMcpServer(entry({ url: `${silentBase}/mcp` }), { timeoutMs: 400 });
    expect(r).toEqual({ ok: false, error: "The MCP server did not answer within 0.4 s." });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("untrusted metadata and error text", () => {
  it("toProbeTools caps the list, drops invalid names, strips control characters and truncates text", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" } }));
    expect(toProbeTools(many)).toHaveLength(200);
    const [t] = toProbeTools([
      { name: "", inputSchema: {} },
      { name: "x".repeat(129), inputSchema: {} },
      {
        name: "ok_tool",
        title: "T\u0000itle",
        description: `${"d".repeat(1_200)}\u0007`,
        annotations: { readOnlyHint: "yes", destructiveHint: true },
        inputSchema: {},
      },
    ] as never);
    expect(t).toEqual({
      name: "ok_tool",
      title: "T itle",
      description: "d".repeat(1_000),
      annotations: { destructiveHint: true },
    });
  });

  it("probeErrorMessage never echoes a header value, even when the error text contains it", () => {
    const secrets = ["Bearer s3cr3t-token-abc", "plain-api-key-123456"];
    const msg = probeErrorMessage(
      new Error("Error POSTing to endpoint (HTTP 403): bad Bearer s3cr3t-token-abc and plain-api-key-123456"),
      secrets,
      20_000,
    );
    expect(msg).not.toContain("s3cr3t-token-abc");
    expect(msg).not.toContain("plain-api-key-123456");
    expect(msg).toMatch(/403/);
  });
});
