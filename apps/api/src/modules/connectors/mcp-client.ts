import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Egress, hostPortOf } from "../../lib/egress";

/**
 * The API's MCP tool client for connectors (CONN-03, D-06, D-07): one SDK `Client` per call over streamable HTTP or
 * SSE, every byte through the egress guard (the transport's `fetch` is `egress.bound(policy)`; without it the SDK
 * would use the global fetch), the member's credential in one header, closed on every path.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const TRANSPORT_MAX_BYTES = 4 * 1024 * 1024;
const CLIENT_INFO = { name: "ocw-connectors", version: "1.0.0" };

export interface McpTarget {
  url: string;
  transport: "streamable-http" | "sse";
}

export interface McpAuth {
  headerName: string;
  headerValue: string;
}

async function withClient<T>(
  egress: Egress,
  target: McpTarget,
  auth: McpAuth,
  timeoutMs: number,
  run: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>,
): Promise<T> {
  const url = new URL(target.url);
  const fetchFn = egress.bound({ privateAllow: [hostPortOf(url)], maxBytes: TRANSPORT_MAX_BYTES, timeoutMs });
  const requestInit = { headers: { [auth.headerName]: auth.headerValue } };
  const transport =
    target.transport === "sse"
      ? new SSEClientTransport(url, { requestInit, fetch: fetchFn })
      : new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchFn });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const controller = new AbortController();
  const options = { signal: controller.signal, timeout: timeoutMs };
  try {
    await client.connect(transport, options);
    return await run(client, options);
  } finally {
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
      await transport.terminateSession().catch(() => {});
    }
    await client.close().catch(() => {});
  }
}

/** Calls one tool and returns its text content. */
export async function callTool(
  egress: Egress,
  target: McpTarget,
  auth: McpAuth,
  call: { name: string; arguments: Record<string, unknown> },
  opts: { timeoutMs?: number; redact: readonly string[]; signal?: AbortSignal },
): Promise<{ content: string; truncated: boolean; isError: boolean }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withClient(egress, target, auth, timeoutMs, async (client, options) => {
    const result = await client.callTool({ name: call.name, arguments: call.arguments }, undefined, options);
    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts
      .map((p) => (p && typeof p === "object" && p.type === "text" ? String(p.text) : ""))
      .join("\n");
    return { content: text, truncated: false, isError: result.isError === true };
  });
}
