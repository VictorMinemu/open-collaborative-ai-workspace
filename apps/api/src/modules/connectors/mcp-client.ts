import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CONNECTOR_TOOL_LIMITS, jsonBytes, MCP_INPUT_SCHEMA_MAX_BYTES } from "@ocw/contracts";
import { type Egress, EgressRefusedError, hostPortOf } from "../../lib/egress";

/**
 * The API's MCP tool client for connectors (CONN-03, D-06, D-07).
 *
 * - One SDK `Client` per call over streamable HTTP or SSE; every byte goes through the egress guard (the transport's
 *   `fetch` is `egress.bound(policy)`: without it the SDK would use the global fetch). The MCP URL's own `host:port`
 *   is the only private / plain-http target admitted; the transport is capped at 4 MiB and the call at its timeout.
 * - The member's credential travels in one header and the client is closed on every path.
 * - Results are untrusted text for a model: text parts concatenated (structured content JSON-stringified when there
 *   is no text), images / audio / resources replaced by a note, control characters stripped, every known credential
 *   string (and its base64 forms) redacted, then capped at 32 KB.
 * - Errors are `McpUpstreamError(code)`: the message is the code only and the SDK error is dropped (its text can
 *   carry response bodies); the server's `WWW-Authenticate` challenge is kept, cleaned and redacted.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const TRANSPORT_MAX_BYTES = 4 * 1024 * 1024;
const CONTENT_MAX_BYTES = CONNECTOR_TOOL_LIMITS.contentBytes;
const DESCRIPTION_MAX_CHARS = CONNECTOR_TOOL_LIMITS.descriptionChars;
const CHALLENGE_MAX_CHARS = 1024;
const MAX_PAGES = 10;
const MAX_TOOLS = 256;
const CLOSE_WITHIN_MS = 2_000;
const CLIENT_INFO = { name: "ocw-connectors", version: "1.0.0" };
const REDACTED = "[redacted]";
/** A whitespace-separated part of a credential this long is redacted on its own (the token after `Bearer `). */
const MIN_PART_LENGTH = 6;
/** Shorter credential strings are not searched for: they would shred ordinary text. */
const MIN_SECRET_LENGTH = 4;

/** Guard refusals that are a policy decision (the rest are network trouble). */
const POLICY_REFUSALS = new Set([
  "bad_url",
  "scheme",
  "userinfo",
  "https_required",
  "private_address",
  "platform_host",
]);

export type McpUpstreamCode =
  | "unauthorized"
  | "insufficient_scope"
  | "upstream_error"
  | "timeout"
  | "egress_refused";

export class McpUpstreamError extends Error {
  readonly code: McpUpstreamCode;
  /** The server's challenge on 401 / 403 (cleaned, capped, credentials redacted), for re-discovery and step-up. */
  readonly wwwAuthenticate?: string;

  constructor(code: McpUpstreamCode, wwwAuthenticate?: string) {
    super(`mcp upstream: ${code}`);
    this.name = "McpUpstreamError";
    this.code = code;
    if (wwwAuthenticate) this.wwwAuthenticate = wwwAuthenticate;
  }
}

export interface McpTarget {
  url: string;
  transport: "streamable-http" | "sse";
}

export interface McpAuth {
  headerName: string;
  headerValue: string;
}

export interface McpToolInfo {
  name: string;
  description: string | null;
  inputSchema: object | null;
  readOnly: boolean;
  destructive: boolean;
}

// ---------------------------------------------------------------- shaping (exported for the unit tests)

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** Removes C0 (but newline and tab), DEL and C1 control characters. */
export function stripControl(text: string): string {
  return text.replace(CONTROL, "");
}

/** Every string a credential can appear as: itself, its long parts, and their base64 / base64url forms. */
function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    const parts = [secret, ...secret.split(/\s+/u).filter((p) => p.length >= MIN_PART_LENGTH)];
    for (const p of parts) {
      forms.add(p);
      const b64 = Buffer.from(p).toString("base64");
      forms.add(b64);
      forms.add(b64.replace(/=+$/u, ""));
      forms.add(Buffer.from(p).toString("base64url"));
    }
  }
  return [...forms].filter((f) => f.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/** Replaces every form of every credential string with `[redacted]`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const form of secretForms(secrets)) out = out.split(form).join(REDACTED);
  return out;
}

/** At most `maxBytes` of UTF-8, cut on a character boundary. */
function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) so no character is split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function partText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const p = part as { type?: unknown; text?: unknown };
  switch (p.type) {
    case "text":
      return typeof p.text === "string" ? p.text : "";
    case "image":
      return "[image omitted]";
    case "audio":
      return "[audio omitted]";
    case "resource":
    case "resource_link":
      return "[resource omitted]";
    default:
      return "[content omitted]";
  }
}

/** A tool result as bounded, control-character-free, credential-free text. */
export function shapeToolResult(
  result: unknown,
  redact: readonly string[],
): { content: string; truncated: boolean; isError: boolean } {
  const r = (result && typeof result === "object" ? result : {}) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  const parts = Array.isArray(r.content) ? r.content : [];
  const hasText = parts.some((p) => (p as { type?: unknown } | null)?.type === "text");
  const pieces = parts.map(partText);
  if (!hasText && r.structuredContent !== undefined && r.structuredContent !== null) {
    let json = "";
    try {
      json = JSON.stringify(r.structuredContent) ?? "";
    } catch {
      json = "[structured content omitted]";
    }
    pieces.push(json);
  }
  const clean = redactSecrets(stripControl(pieces.join("\n")), redact);
  const capped = capUtf8(clean, CONTENT_MAX_BYTES);
  return { content: capped.text, truncated: capped.truncated, isError: r.isError === true };
}

/** A tool's input schema, or null when it is not an object or is over 16 KB serialized. */
export function capSchema(schema: unknown): object | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  return jsonBytes(schema) <= MCP_INPUT_SCHEMA_MAX_BYTES ? schema : null;
}

/** One `tools/list` entry; null without a name. Destructive unless read-only or explicitly not (MCP defaults). */
export function shapeTool(tool: unknown): McpToolInfo | null {
  if (!tool || typeof tool !== "object") return null;
  const t = tool as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown };
  if (typeof t.name !== "string" || !t.name) return null;
  const annotations = (t.annotations && typeof t.annotations === "object" ? t.annotations : {}) as {
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
  };
  const readOnly = annotations.readOnlyHint === true;
  const description =
    typeof t.description === "string" ? stripControl(t.description).slice(0, DESCRIPTION_MAX_CHARS) : "";
  return {
    name: t.name,
    description: description || null,
    inputSchema: capSchema(t.inputSchema),
    readOnly,
    destructive: !readOnly && annotations.destructiveHint !== false,
  };
}

// ---------------------------------------------------------------- the client

function findRefusal(err: unknown): EgressRefusedError | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (cur instanceof EgressRefusedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

class CallTimeout extends Error {}

/** What the guarded fetch saw during one call: the last 401 / 403 and the first guard refusal. */
interface Observed {
  upstream: { status: number; challenge: string | null } | null;
  refusal: EgressRefusedError | null;
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

async function withClient<T>(
  egress: Egress,
  target: McpTarget,
  auth: McpAuth,
  opts: { timeoutMs: number; signal?: AbortSignal; redact: readonly string[] },
  run: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>,
): Promise<T> {
  const secrets = [auth.headerValue, ...opts.redact];
  const controller = new AbortController();
  const timeout = new CallTimeout("timeout");
  const timer = setTimeout(() => controller.abort(timeout), opts.timeoutMs);
  const onAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const observed: Observed = { upstream: null, refusal: null };
  let close: (() => Promise<void>) | undefined;
  try {
    const url = new URL(target.url);
    const guarded = egress.bound({
      privateAllow: [hostPortOf(url)],
      maxBytes: TRANSPORT_MAX_BYTES,
      timeoutMs: opts.timeoutMs,
    });
    // Every request dies with the call. A 401 / 403 challenge is kept (the SDK drops it without an auth provider),
    // and so is a guard refusal (the SSE transport's EventSource replaces it with its own error).
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      let res: Response;
      try {
        res = await guarded(input, { ...init, signal });
      } catch (err) {
        observed.refusal ??= findRefusal(err);
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        observed.upstream = { status: res.status, challenge: res.headers.get("www-authenticate") };
      }
      return res;
    }) as typeof fetch;
    const requestInit = { headers: { [auth.headerName]: auth.headerValue } };
    const transport =
      target.transport === "sse"
        ? new SSEClientTransport(url, { requestInit, fetch: fetchFn })
        : new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchFn });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    close = async () => {
      if (
        transport instanceof StreamableHTTPClientTransport &&
        transport.sessionId &&
        !controller.signal.aborted
      ) {
        await settleWithin(transport.terminateSession(), CLOSE_WITHIN_MS);
      }
      await settleWithin(client.close(), CLOSE_WITHIN_MS);
    };
    const options = { signal: controller.signal, timeout: opts.timeoutMs };
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(controller.signal.reason);
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => {});
    return await Promise.race([
      (async () => {
        await client.connect(transport, options);
        return run(client, options);
      })(),
      aborted,
    ]);
  } catch (err) {
    throw toUpstreamError(err, { aborted: controller.signal.aborted, observed, secrets });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    await close?.().catch(() => {});
  }
}

function cleanChallenge(challenge: string | null, secrets: readonly string[]): string | undefined {
  if (!challenge) return undefined;
  const clean = redactSecrets(stripControl(challenge), secrets).slice(0, CHALLENGE_MAX_CHARS);
  return clean || undefined;
}

function toUpstreamError(
  err: unknown,
  ctx: { aborted: boolean; observed: Observed; secrets: readonly string[] },
): McpUpstreamError {
  if (err instanceof McpUpstreamError) return err;
  const refusal = findRefusal(err) ?? ctx.observed.refusal;
  if (refusal) {
    if (refusal.code === "timeout") return new McpUpstreamError("timeout");
    return new McpUpstreamError(POLICY_REFUSALS.has(refusal.code) ? "egress_refused" : "upstream_error");
  }
  if (ctx.aborted || (err instanceof McpError && err.code === ErrorCode.RequestTimeout)) {
    return new McpUpstreamError("timeout");
  }
  const upstream = ctx.observed.upstream;
  if (upstream) {
    const challenge = cleanChallenge(upstream.challenge, ctx.secrets);
    const insufficient = /\berror\s*=\s*"?insufficient_scope"?/iu.test(upstream.challenge ?? "");
    if (upstream.status === 403 && insufficient) return new McpUpstreamError("insufficient_scope", challenge);
    if (upstream.status === 401) return new McpUpstreamError("unauthorized", challenge);
  }
  return new McpUpstreamError("upstream_error");
}

/** The server's tools (paginated, at most 256), with capped schemas and read-only / destructive flags. */
export async function listTools(
  egress: Egress,
  target: McpTarget,
  auth: McpAuth,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<McpToolInfo[]> {
  return withClient(
    egress,
    target,
    auth,
    {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      redact: [],
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    async (client, options) => {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined, options);
        for (const tool of res.tools) {
          const shaped = shapeTool(tool);
          if (shaped && tools.length < MAX_TOOLS) tools.push(shaped);
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
  );
}

/** Calls one tool; the result is shaped by `shapeToolResult` with the credential and `redact` removed. */
export async function callTool(
  egress: Egress,
  target: McpTarget,
  auth: McpAuth,
  call: { name: string; arguments: Record<string, unknown> },
  opts: { timeoutMs?: number; redact: readonly string[]; signal?: AbortSignal },
): Promise<{ content: string; truncated: boolean; isError: boolean }> {
  return withClient(
    egress,
    target,
    auth,
    {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      redact: opts.redact,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    async (client, options) => {
      const result = await client.callTool(
        { name: call.name, arguments: call.arguments },
        undefined,
        options,
      );
      return shapeToolResult(result, [auth.headerValue, ...opts.redact]);
    },
  );
}
