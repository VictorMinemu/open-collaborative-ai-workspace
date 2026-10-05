import type {
  AgentChannelMcpProbeResult,
  CellMcpServer,
  CellSnapshot,
  McpProbeEvent,
  McpProbeTool,
} from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";

/**
 * MCP tool discovery inside the cell (D-13). An admin registers a server in the API; the API asks the cell
 * (`mcp.probe`) because only the cell has the network position the bots will use. The probe connects with the
 * official MCP SDK client (pinned to 1.30.0, the version OpenClaw 2026.9.7 bundles) over streamable HTTP or SSE,
 * with the header credentials of the `/cell` snapshot, lists the tools (paginated), closes, and reports
 * `POST /agent-channel/v1/mcp/probe-results`.
 *
 * Everything the server returns is untrusted: names are length-checked, text is stripped of control characters
 * and truncated, annotations keep only explicit booleans. Error text never carries a header value (classified
 * messages, then every header value and its long parts are redacted). Redirects are refused, so credentials are
 * never replayed to another endpoint. The SDK is loaded lazily: the plugin's other registrations never depend
 * on it.
 */

export type ProbeTool = McpProbeTool;
export type ProbeResult = { ok: true; tools: ProbeTool[] } | { ok: false; error: string };

export const PROBE_TIMEOUT_MS = 20_000;
const MAX_TOOLS = 200;
const MAX_PAGES = 20;
const MAX_NAME = 128;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1_000;
const MAX_ERROR = 300;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from untrusted server text
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects tool names carrying control characters
const HAS_CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(CONTROL_CHARS, " ").trim().slice(0, max).trim();
  return text || undefined;
}

/** The report's view of an SDK tool list (untrusted input → bounded, typed output). */
export function toProbeTools(raw: readonly unknown[]): ProbeTool[] {
  const out: ProbeTool[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_TOOLS) break;
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name || name.length > MAX_NAME || HAS_CONTROL_CHAR.test(name) || seen.has(name)) continue;
    seen.add(name);
    const tool: ProbeTool = { name };
    const title = cleanText(t.title, MAX_TITLE);
    if (title) tool.title = title;
    const description = cleanText(t.description, MAX_DESCRIPTION);
    if (description) tool.description = description;
    const a =
      t.annotations && typeof t.annotations === "object" ? (t.annotations as Record<string, unknown>) : {};
    const annotations: NonNullable<ProbeTool["annotations"]> = {};
    if (typeof a.readOnlyHint === "boolean") annotations.readOnlyHint = a.readOnlyHint;
    if (typeof a.destructiveHint === "boolean") annotations.destructiveHint = a.destructiveHint;
    if (Object.keys(annotations).length > 0) tool.annotations = annotations;
    out.push(tool);
  }
  return out;
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("probe timeout");
    this.name = "ProbeTimeoutError";
  }
}

/** Every header value and its long parts (e.g. the token after `Bearer `), longest first. */
function secretParts(secrets: readonly string[]): string[] {
  const parts = new Set<string>();
  for (const s of secrets) {
    if (s.length >= 4) parts.add(s);
    for (const p of s.split(/\s+/)) if (p.length >= 6) parts.add(p);
  }
  return [...parts].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const p of secretParts(secrets)) out = out.split(p).join("[redacted]");
  return out;
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let e: unknown = error;
  for (let i = 0; e && i < 5; i++) {
    chain.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return chain;
}

function httpStatusOf(chain: readonly unknown[]): number | null {
  for (const e of chain) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number" && code >= 100 && code <= 599) return code;
    const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    const m = /\b(?:HTTP|status code|status)\s*\(?(\d{3})\b/i.exec(message);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function networkCodeOf(chain: readonly unknown[]): string | null {
  for (const e of chain) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return code;
    const message = e instanceof Error ? e.message : "";
    for (const c of NETWORK_CODES) if (message.includes(c)) return c;
  }
  return null;
}

/**
 * A short, classified reason for an admin (Settings › MCP servers). Never a header value: the classified texts
 * contain none, and the fallback is redacted and capped.
 */
export function probeErrorMessage(error: unknown, secrets: readonly string[], timeoutMs: number): string {
  if (error instanceof ProbeTimeoutError) {
    return `The MCP server did not answer within ${Math.round(timeoutMs / 100) / 10} s.`;
  }
  const chain = causeChain(error);
  const all = chain.map((e) => (e instanceof Error ? `${e.name} ${e.message}` : String(e))).join(" | ");
  if (/redirect/i.test(all)) return "The MCP server redirected the request; redirects are not followed.";
  const status = httpStatusOf(chain);
  if (status === 401 || status === 403) {
    return `The MCP server refused the credentials (HTTP ${status}). Check the header values.`;
  }
  if (status === 404 || status === 405) {
    return `The MCP endpoint was not found (HTTP ${status}). Check the URL and the transport.`;
  }
  if (status !== null) return `The MCP server answered HTTP ${status}.`;
  const network = networkCodeOf(chain);
  if (network) return `Could not reach the MCP server (${network}).`;
  if (/fetch failed|connect|socket/i.test(all)) return "Could not reach the MCP server.";
  const mcp = /MCP error (-?\d+)/.exec(all);
  if (mcp?.[1]) return `The MCP server returned a protocol error (code ${mcp[1]}).`;
  const detail = redact(all.replace(CONTROL_CHARS, " "), secrets).slice(0, 200).trim();
  return redact(`The probe failed: ${detail || "unknown error"}`, secrets).slice(0, MAX_ERROR);
}

type Sdk = {
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
  SSEClientTransport: typeof import("@modelcontextprotocol/sdk/client/sse.js").SSEClientTransport;
};

let sdk: Promise<Sdk> | null = null;
function loadSdk(): Promise<Sdk> {
  sdk ??= Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
  ]).then(([client, http, sse]) => ({
    Client: client.Client,
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
    SSEClientTransport: sse.SSEClientTransport,
  }));
  return sdk;
}

/** Bounded wait: a server that hangs on close must not hold the probe. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/** Connects to one snapshot server with the official SDK client, lists its tools (paginated) and closes. */
export async function probeMcpServer(
  s: CellMcpServer,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const secrets = s.headers.map((h) => h.value);
  const controller = new AbortController();
  const timeout = new ProbeTimeoutError();
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  const onAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let close: (() => Promise<void>) | undefined;
  try {
    const run = async (): Promise<ProbeTool[]> => {
      const { Client, StreamableHTTPClientTransport, SSEClientTransport } = await loadSdk();
      const headers = Object.fromEntries(s.headers.map((h) => [h.name, h.value]));
      // No redirects (credentials stay on the registered endpoint) and every request dies with the probe.
      const guardedFetch: typeof fetch = (input, init) =>
        fetch(input, {
          ...init,
          redirect: "error",
          signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
        });
      const url = new URL(s.url);
      const transport =
        s.transport === "sse"
          ? new SSEClientTransport(url, { requestInit: { headers }, fetch: guardedFetch })
          : new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: guardedFetch });
      const client = new Client({ name: "ocw-cell-probe", version: "1.0.0" }, { capabilities: {} });
      close = async () => {
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
          await settleWithin(transport.terminateSession(), 2_000);
        }
        await client.close();
      };
      const requestOptions = { signal: controller.signal, timeout: timeoutMs };
      await client.connect(transport, requestOptions);
      const tools: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
        tools.push(...res.tools);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return toProbeTools(tools);
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(controller.signal.reason);
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    const tools = await Promise.race([run(), aborted]);
    return { ok: true, tools };
  } catch (error) {
    const cause = controller.signal.reason === timeout ? timeout : error;
    return { ok: false, error: probeErrorMessage(cause, secrets, timeoutMs) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (close) await settleWithin(close(), 2_000);
  }
}

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };

export const UNKNOWN_SERVER_ERROR =
  "The cell does not know this MCP server (it is not in the cell snapshot).";

/**
 * One `mcp.probe`: find the server in the snapshot (refreshing once when it is unknown, e.g. the probe raced the
 * `cell.config.changed` that announced it), probe it, report. Logs ids, outcome and counts only.
 */
export async function handleMcpProbe(
  ev: McpProbeEvent,
  deps: {
    client: Pick<AgentChannelClient, "reportMcpProbe">;
    snapshot: () => CellSnapshot | undefined;
    refresh?: () => Promise<CellSnapshot>;
    probe?: typeof probeMcpServer;
    signal?: AbortSignal;
    log?: Logger;
  },
): Promise<void> {
  const find = (cell: CellSnapshot | undefined) => cell?.mcpServers?.find((s) => s.id === ev.serverId);
  let server = find(deps.snapshot());
  if (!server && deps.refresh) server = find(await deps.refresh());
  let report: AgentChannelMcpProbeResult;
  if (!server) {
    report = { probeId: ev.probeId, serverId: ev.serverId, ok: false, error: UNKNOWN_SERVER_ERROR };
  } else {
    const r = await (deps.probe ?? probeMcpServer)(server, deps.signal ? { signal: deps.signal } : {});
    report = r.ok
      ? { probeId: ev.probeId, serverId: ev.serverId, ok: true, tools: r.tools }
      : { probeId: ev.probeId, serverId: ev.serverId, ok: false, error: r.error };
  }
  deps.log?.info?.(
    `mcp probe ${ev.probeId} (server ${ev.serverId}): ${report.ok ? `${report.tools?.length ?? 0} tool(s)` : "failed"}`,
  );
  await deps.client.reportMcpProbe(report, deps.signal);
}
