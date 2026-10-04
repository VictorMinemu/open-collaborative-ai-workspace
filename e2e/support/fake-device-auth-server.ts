/**
 * Fake OAuth device-authorization server: the same three endpoints OpenClaw's OpenAI Codex device-code
 * login uses (auth.openai.com in production), so tests exercise the real protocol shape without a real
 * account and without any metered call.
 *
 *   POST /api/accounts/deviceauth/usercode  {client_id}                  → {device_auth_id, user_code, interval}
 *   POST /api/accounts/deviceauth/token     {device_auth_id, user_code}  → 403 until approved,
 *                                                                          200 {authorization_code, code_verifier}
 *   POST /oauth/token                       (form, grant_type=authorization_code) → {access_token, refresh_token, expires_in}
 *   GET  /codex/device                      the "verification page": type the code, Approve / Deny
 * Test controls: POST /__approve|/__deny {user_code}.
 *
 * Dependency-free (node:http) so API integration tests, Playwright and the fake cell plugin can share it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeDeviceAuthOptions {
  /** Account the issued ID token describes. */
  email?: string;
  planType?: string;
  /** Code lifetime (OpenAI: 15 minutes). */
  codeTtlMs?: number;
  port?: number;
}

interface PendingCode {
  deviceAuthId: string;
  userCode: string;
  createdAt: number;
  state: "pending" | "approved" | "denied";
  authorizationCode: string | null;
}

export interface FakeDeviceAuthServer {
  url: string;
  server: Server;
  codes: PendingCode[];
  /** Every token exchange (authorization codes are single-use). */
  exchanges: number;
  approve(userCode: string): boolean;
  deny(userCode: string): boolean;
  close(): Promise<void>;
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** Unsigned JWT with the claims OpenClaw reads (email, ChatGPT plan, account id). Test-only. */
export function fakeIdToken(email: string, planType: string): string {
  const payload = {
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_plan_type: planType, chatgpt_account_id: randomUUID() },
    "https://api.openai.com/profile": { email },
  };
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.`;
}

/** Decodes the claims of a (fake or real) JWT payload; never verifies. */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  if ((req.headers["content-type"] ?? "").includes("json")) return JSON.parse(text) as Record<string, string>;
  return Object.fromEntries(new URLSearchParams(text));
}

function send(res: ServerResponse, status: number, data: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(data) : String(data));
}

const page = (
  message = "",
) => `<!doctype html><html><head><meta charset="utf-8"><title>Fake device sign-in</title>
<style>body{font:16px system-ui;max-width:420px;margin:60px auto;padding:0 16px}input,button{font:inherit;padding:8px 12px;margin:4px 0}</style>
</head><body><h1>Fake device sign-in</h1><p>${message}</p>
<form method="post" action="/codex/device"><label>Code <input name="user_code" data-testid="fake-device-code" autocomplete="off"></label><br>
<button name="decision" value="approve" data-testid="fake-device-approve">Approve</button>
<button name="decision" value="deny" data-testid="fake-device-deny">Deny</button></form></body></html>`;

export async function startFakeDeviceAuthServer(
  opts: FakeDeviceAuthOptions = {},
): Promise<FakeDeviceAuthServer> {
  const email = opts.email ?? "owner@example.test";
  const planType = opts.planType ?? "plus";
  const ttl = opts.codeTtlMs ?? 15 * 60_000;
  const codes: PendingCode[] = [];
  let exchanges = 0;

  const find = (userCode: string) =>
    codes.find((c) => c.userCode.toUpperCase() === userCode.trim().toUpperCase());
  const decide = (userCode: string, decision: "approved" | "denied") => {
    const c = find(userCode);
    if (c?.state !== "pending" || Date.now() - c.createdAt > ttl) return false;
    c.state = decision;
    if (decision === "approved") c.authorizationCode = randomBytes(12).toString("hex");
    return true;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/api/accounts/deviceauth/usercode") {
        const code: PendingCode = {
          deviceAuthId: randomUUID(),
          // Same shape as OpenAI's codes (e.g. E18P-OYM9T).
          userCode: `${randomBytes(2).toString("hex")}-${randomBytes(3).toString("hex")}`.toUpperCase(),
          createdAt: Date.now(),
          state: "pending",
          authorizationCode: null,
        };
        codes.push(code);
        return send(res, 200, { device_auth_id: code.deviceAuthId, user_code: code.userCode, interval: 1 });
      }
      if (req.method === "POST" && url.pathname === "/api/accounts/deviceauth/token") {
        const b = await body(req);
        const c = codes.find((x) => x.deviceAuthId === b.device_auth_id && x.userCode === b.user_code);
        if (!c) return send(res, 400, { error: "invalid_request" });
        if (Date.now() - c.createdAt > ttl) return send(res, 400, { error: "expired_token" });
        if (c.state === "denied") return send(res, 400, { error: "access_denied" });
        if (c.state === "pending") return send(res, 403, { error: "authorization_pending" });
        return send(res, 200, { authorization_code: c.authorizationCode, code_verifier: "fake-verifier" });
      }
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const b = await body(req);
        const c = codes.find((x) => x.authorizationCode && x.authorizationCode === b.code);
        if (!c) return send(res, 400, { error: "invalid_grant" });
        c.authorizationCode = null; // single use
        exchanges++;
        return send(res, 200, {
          access_token: fakeIdToken(email, planType),
          id_token: fakeIdToken(email, planType),
          refresh_token: `fake-refresh-${randomBytes(8).toString("hex")}`,
          expires_in: 3600,
        });
      }
      if (url.pathname === "/codex/device") {
        if (req.method === "GET") return send(res, 200, page(), "text/html; charset=utf-8");
        const b = await body(req);
        const ok = decide(b.user_code ?? "", b.decision === "deny" ? "denied" : "approved");
        return send(
          res,
          ok ? 200 : 400,
          page(
            ok
              ? b.decision === "deny"
                ? "Denied."
                : "Approved. You can close this tab."
              : "Unknown or expired code.",
          ),
          "text/html; charset=utf-8",
        );
      }
      if (req.method === "POST" && (url.pathname === "/__approve" || url.pathname === "/__deny")) {
        const b = await body(req);
        const ok = decide(b.user_code ?? "", url.pathname === "/__approve" ? "approved" : "denied");
        return send(res, ok ? 200 : 404, { ok });
      }
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      return send(res, 500, { error: String(err) });
    }
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    codes,
    get exchanges() {
      return exchanges;
    },
    approve: (userCode) => decide(userCode, "approved"),
    deny: (userCode) => decide(userCode, "denied"),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
