// One-shot loopback listener for "Sign in with ChatGPT" in the desktop app (05-07, D-02, ADR-0017).
//
// OpenAI sends the member's browser to http://127.0.0.1:<port>/auth/callback?code=…&state=… after they approve.
// In a plain browser nothing listens there and the member pastes that address; in the desktop app this listener
// catches it instead, so no paste is needed. It is a SCOPED exception to "no listening TCP port" (AGENTS.md: that rule
// is about the Local Runtime daemon, which stays socket-only): it lives in the desktop MAIN process, only while a
// sign-in is pending, and:
//   - binds 127.0.0.1 only (never 0.0.0.0 or ::), preferring 1455 (the registered loopback port);
//   - serves exactly one GET /auth/callback (a request whose Host is not the loopback address is refused), then
//     closes; anything else is 404;
//   - closes after 5 minutes, on cancel, or when a newer sign-in starts (one pending flow at a time);
//   - never reads, keeps or forwards a header or cookie the browser sends (when the workspace itself is served from
//     127.0.0.1, the browser attaches its session cookie here: it is ignored); only the OAuth parameters are copied
//     into a fresh loopback URL that the web app POSTs to the API, which checks state + PKCE (T-05-07-02);
//   - never logs the callback URL or its query.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const CHATGPT_LOOPBACK_HOST = "127.0.0.1";
export const CHATGPT_LOOPBACK_PORT = 1455;
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
export const CHATGPT_LOOPBACK_TIMEOUT_MS = 5 * 60_000;

/** The only query parameters handed to the API (the ones `parseRedirect` reads), in this order. */
const OAUTH_PARAMS = ["code", "state", "client_id", "error"] as const;
const PARAM_MAX = 4_096;

export type ChatgptCallbackResult =
  | { ok: true; redirectUrl: string }
  | { ok: false; reason: "timeout" | "cancelled" | "invalid_url" };

interface PendingFlow {
  token: string;
  server: Server;
  port: number;
  timer: NodeJS.Timeout;
  allowLoopbackAuthorize: boolean;
  /** Set once the flow ended; later awaits get it at once. */
  result: ChatgptCallbackResult | null;
  waiters: Array<(r: ChatgptCallbackResult) => void>;
  awaited: boolean;
}

let pending: PendingFlow | null = null;

const DONE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;color:#18181b;background:#fafafa}
main{max-width:22rem;padding:1.5rem;text-align:center}h1{font-size:1.125rem;margin:0 0 .25rem}p{margin:0;color:#52525b}
@media (prefers-color-scheme:dark){body{color:#fafafa;background:#0f0f12}p{color:#a1a1aa}}</style></head>
<body><main><h1>Signed in</h1><p>You can close this tab and go back to the OCW app.</p></main></body></html>
`;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

function finish(flow: PendingFlow, result: ChatgptCallbackResult): void {
  if (flow.result) return;
  flow.result = result;
  clearTimeout(flow.timer);
  flow.server.close();
  flow.server.closeAllConnections();
  if (pending === flow) pending = null;
  for (const w of flow.waiters.splice(0)) w(result);
}

/** The loopback URL handed to the API: only the OAuth parameters, nothing else the request carried. */
function cleanRedirect(port: number, query: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const name of OAUTH_PARAMS) {
    const v = query.get(name);
    if (v !== null) out.set(name, v.slice(0, PARAM_MAX));
  }
  const qs = out.toString();
  return `http://${CHATGPT_LOOPBACK_HOST}:${port}${CHATGPT_CALLBACK_PATH}${qs ? `?${qs}` : ""}`;
}

function handler(flow: PendingFlow) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const notFound = () => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("Not found");
    };
    // Only the Host header is read (DNS-rebinding guard); cookies and every other header are ignored.
    const expectedHost = `${CHATGPT_LOOPBACK_HOST}:${flow.port}`;
    if (flow.result || req.method !== "GET" || req.headers.host !== expectedHost) return notFound();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${expectedHost}`);
    } catch {
      return notFound();
    }
    if (url.pathname !== CHATGPT_CALLBACK_PATH) return notFound();
    const redirectUrl = cleanRedirect(flow.port, url.searchParams);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      connection: "close",
      ...SECURITY_HEADERS,
    });
    res.end(DONE_PAGE, () => finish(flow, { ok: true, redirectUrl }));
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: CHATGPT_LOOPBACK_HOST, port, exclusive: true });
  });
}

/**
 * Starts listening for one sign-in callback on 127.0.0.1 (1455 when free, else an ephemeral port) and returns the
 * flow token the other calls take plus the port the API must put in the redirect URI. A previous pending flow is
 * cancelled first. `allowLoopbackAuthorize` lets dev/test builds open an http://127.0.0.1 authorize page (the fake).
 */
export async function prepareChatgptLoopback(
  opts: { preferredPort?: number; timeoutMs?: number; allowLoopbackAuthorize?: boolean } = {},
): Promise<{ flowToken: string; port: number }> {
  if (pending) finish(pending, { ok: false, reason: "cancelled" });
  const server = createServer();
  server.maxHeadersCount = 50;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  let port: number;
  try {
    port = await listen(server, opts.preferredPort ?? CHATGPT_LOOPBACK_PORT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    port = await listen(server, 0);
  }
  const flow: PendingFlow = {
    token: randomBytes(32).toString("base64url"),
    server,
    port,
    timer: setTimeout(
      () => finish(flow, { ok: false, reason: "timeout" }),
      opts.timeoutMs ?? CHATGPT_LOOPBACK_TIMEOUT_MS,
    ),
    allowLoopbackAuthorize: opts.allowLoopbackAuthorize === true,
    result: null,
    waiters: [],
    awaited: false,
  };
  flow.timer.unref?.();
  server.on("request", handler(flow));
  // A late `prepare` from another sign-in may already have replaced us while we were binding.
  if (pending) finish(pending, { ok: false, reason: "cancelled" });
  pending = flow;
  return { flowToken: flow.token, port };
}

function authorizeUrlOk(raw: string, allowLoopback: boolean): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return allowLoopback && url.protocol === "http:" && url.hostname === CHATGPT_LOOPBACK_HOST;
}

/**
 * Opens the authorize page in the system browser and resolves once the browser comes back to the listener (with a
 * clean loopback URL), on timeout or on cancel. Only https authorize URLs are opened (or http://127.0.0.1 when the
 * flow allows it); anything else ends the flow as `invalid_url` without opening anything.
 */
export async function awaitChatgptCallback(
  flowToken: string,
  authorizeUrl: string,
  openExternal: (url: string) => Promise<void>,
): Promise<ChatgptCallbackResult> {
  const flow = pending;
  if (!flow || flow.token !== flowToken || flow.awaited) return { ok: false, reason: "cancelled" };
  if (!authorizeUrlOk(authorizeUrl, flow.allowLoopbackAuthorize)) {
    finish(flow, { ok: false, reason: "invalid_url" });
    return { ok: false, reason: "invalid_url" };
  }
  flow.awaited = true;
  const settled = new Promise<ChatgptCallbackResult>((resolve) => {
    if (flow.result) resolve(flow.result);
    else flow.waiters.push(resolve);
  });
  try {
    await openExternal(authorizeUrl);
  } catch {
    finish(flow, { ok: false, reason: "cancelled" });
  }
  return settled;
}

/** Ends the pending flow with that token (`cancelled`) and frees its port; unknown tokens are ignored. */
export function cancelChatgptLoopback(flowToken: string): void {
  if (pending && pending.token === flowToken) finish(pending, { ok: false, reason: "cancelled" });
}

/** Ends whatever flow is pending (app quit). */
export function cancelAllChatgptLoopbacks(): void {
  if (pending) finish(pending, { ok: false, reason: "cancelled" });
}

/** The bound address of the pending flow, for diagnostics and tests (never a non-loopback host). */
export function activeChatgptLoopbackAddress(): { address: string; family: string; port: number } | null {
  const addr = pending?.server.address();
  if (!addr || typeof addr === "string") return null;
  return { address: addr.address, family: addr.family, port: addr.port };
}
