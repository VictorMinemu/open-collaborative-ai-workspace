#!/usr/bin/env node
// Proxy gate step (SELF-05, D-07, D-18): the instance behind Caddy on one HTTPS origin, checked from outside the
// compose network (this host, through the published Caddy port) with TLS verification on (Caddy's local root is
// trusted for the run, never `rejectUnauthorized: false`).
//
//   node scripts/gate/proxy-check.mjs --up [--run-id <id>] [--keep] [--block NN]   # own gate stack (ports NN00-NN99,
//                                                                                  # default 34), then `ocw enable proxy`
//   node scripts/gate/proxy-check.mjs --attach <envFile>              # a stack left by --keep (proxy enabled if not)
//
// Enabling: `node -- scripts/ocw.mjs enable proxy --site-address localhost --env-file <gate env>` (what an operator
// runs), with infra/caddy/compose.loopback.yaml added to the gate's COMPOSE_FILE first, so Caddy publishes on
// 127.0.0.1 only like every other gate port. Checks (one step each in the JSON summary on stdout; exit 0 = all ok):
//   proxy-enabled, ports-loopback, tls-trust, web-login, api-health, docs, ws-upgrade (Task 1)
//   presign-put-get, presign-tampered-403, presign-unsigned-403, xff-ignored, secure-cookie, agent-channel-404 (Task 2)
// The forged client IP is 203.0.113.77 (SPOOFED_IP); presigned URLs are never printed, only their origin.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import https from "node:https";
import net from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ADMIN,
  demoSnapshot,
  diffDemo,
  ensureAdmin,
  newRunId,
  REPO_ROOT,
  setEnvKeys,
  withGateStack,
} from "./lib.mjs";

const OCW = path.join(REPO_ROOT, "scripts", "ocw.mjs");
const LOOPBACK_OVERRIDE = "infra/caddy/compose.loopback.yaml";
const CADDY_ROOT = "/data/caddy/pki/authorities/local/root.crt";
/** Documentation range (RFC 5737): what a client forges in X-Forwarded-For. */
export const SPOOFED_IP = "203.0.113.77";
/** A 1×1 PNG (same bytes as e2e/tests/attachments-api.spec.ts). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, { timeoutMs, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last.ok) return last;
    } catch (err) {
      last = { ok: false, error: String(err.cause?.code ?? err.message ?? err) };
    }
    if (Date.now() >= deadline) return last;
    await sleep(intervalMs);
  }
}

/** Only what docker needs (same rule as lib.mjs): inherited OCW_* / COMPOSE_* would override the env file. */
function minimalEnv() {
  const env = {};
  for (const k of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
  ]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

/**
 * `ocw enable proxy --site-address localhost` on the gate env (after adding the loopback override to COMPOSE_FILE),
 * unless the env already has the proxy profile. Reloads ctx. Returns what it did.
 */
export function enableProxy(ctx, { log = (m) => process.stderr.write(`[proxy] ${m}\n`) } = {}) {
  const profiles = (ctx.env.COMPOSE_PROFILES ?? "").split(",").filter(Boolean);
  if (profiles.includes("proxy") && ctx.env.OCW_PUBLIC_WEB_URL?.startsWith("https://")) {
    // Gate stacks get the proxy from `ocw enable proxy --no-up` at env creation (lib.mjs createGateEnv): check
    // what it wrote and that Caddy runs published on loopback only.
    const env = ctx.env;
    const origin = env.OCW_PUBLIC_WEB_URL;
    const files = (env.COMPOSE_FILE || "").split(":");
    return {
      ok:
        origin === `https://localhost:${ctx.ports.proxyHttps}` &&
        env.OCW_PUBLIC_API_URL === origin &&
        env.OCW_S3_PUBLIC_URL === origin &&
        env.OCW_TRUST_PROXY === "1" &&
        env.OCW_PUBLISH_ADDRESS === "127.0.0.1" &&
        files.includes(LOOPBACK_OVERRIDE) &&
        ctx.compose(["port", "caddy", "443"]).stdout.trim() === `127.0.0.1:${ctx.ports.proxyHttps}`,
      alreadyEnabled: true,
      origin,
    };
  }
  const files = (ctx.env.COMPOSE_FILE || "compose.yaml").split(":").filter(Boolean);
  if (!files.includes(LOOPBACK_OVERRIDE)) {
    setEnvKeys(ctx.envFile, { COMPOSE_FILE: [...files, LOOPBACK_OVERRIDE].join(":") });
    ctx.reload(); // runs assertSafe on the updated env
  }
  log(`ocw enable proxy --site-address localhost (${ctx.project})`);
  const res = spawnSync(
    process.execPath,
    ["--", OCW, "enable", "proxy", "--site-address", "localhost", "--env-file", ctx.envFile],
    {
      cwd: REPO_ROOT,
      env: minimalEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20 * 60_000,
    },
  );
  process.stderr.write(res.stderr ?? "");
  ctx.reload();
  const env = ctx.env;
  const origin = env.OCW_PUBLIC_WEB_URL;
  const ok =
    res.status === 0 &&
    origin === `https://localhost:${ctx.ports.proxyHttps}` &&
    env.OCW_PUBLIC_API_URL === origin &&
    env.OCW_S3_PUBLIC_URL === origin &&
    env.OCW_TRUST_PROXY === "1" &&
    env.OCW_PUBLISH_ADDRESS === "127.0.0.1";
  return { ok, exit: res.status, origin, stdout: (res.stdout ?? "").trim().split("\n") };
}

/** Caddy's local root certificate (PEM), read from its container. */
function caddyRoot(ctx) {
  const res = ctx.compose(["exec", "-T", "caddy", "cat", CADDY_ROOT]);
  const pem = res.status === 0 ? res.stdout.trim() : "";
  return pem.startsWith("-----BEGIN CERTIFICATE-----") ? pem : null;
}

/** Non-loopback IPv4 addresses of this host (where a LAN client would connect). */
function hostAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

/** True when a TCP connection to host:port is refused (or times out). */
function refused(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(true);
    });
  });
}

// ---------------------------------------------------------------- minimal WebSocket client (RFC 6455, client side)

/** Encodes one masked client text frame. */
function wsFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(payload.length, 2);
  } else throw new Error("frame too large for this client");
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([head, mask, body]);
}

/** Masked control frame (pong/close). */
function wsControl(opcode, payload = Buffer.alloc(0)) {
  const mask = randomBytes(4);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, body]);
}

/**
 * Opens `wss://<origin>/ws` with the access JWT as a subprotocol entry (as the browser does). Resolves to
 * `{ status, protocol, send(obj), next(pred, ms), close() }` after a 101, or `{ status }` for any other answer.
 */
export function openWs(origin, token, { timeoutMs = 15_000 } = {}) {
  const url = new URL("/ws", origin);
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: "GET",
      servername: url.hostname,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Protocol": `ocw.v1, ocw.auth.${token}`,
        Origin: origin,
      },
      timeout: timeoutMs,
    });
    req.once("timeout", () => req.destroy(new Error("WebSocket handshake timed out")));
    req.once("error", reject);
    req.once("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.once("upgrade", (res, socket, head) => {
      const accept = createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");
      const frames = [];
      const waiters = [];
      let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
      let fragments = [];
      const deliver = (text) => {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          frame = { op: "?", raw: text };
        }
        frames.push(frame);
        for (const w of [...waiters]) {
          if (w.pred(frame)) {
            waiters.splice(waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.resolve(frame);
          }
        }
      };
      const parse = () => {
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0] & 0x80) !== 0;
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (opcode === 0x9) socket.write(wsControl(0xa, payload));
          else if (opcode === 0x8) socket.end();
          else if (opcode === 0x1 || opcode === 0x0) {
            fragments.push(Buffer.from(payload));
            if (fin) {
              deliver(Buffer.concat(fragments).toString("utf8"));
              fragments = [];
            }
          }
        }
      };
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        parse();
      });
      socket.on("error", () => {});
      parse();
      resolve({
        status: res.statusCode,
        protocol: res.headers["sec-websocket-protocol"],
        acceptOk: res.headers["sec-websocket-accept"] === accept,
        send: (obj) => socket.write(wsFrame(JSON.stringify(obj))),
        next: (pred, ms = 15_000) => {
          const seen = frames.find(pred);
          if (seen) return Promise.resolve(seen);
          return new Promise((res2, rej2) => {
            const w = { pred, resolve: res2 };
            w.timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej2(
                new Error(
                  `no matching frame within ${ms} ms (got ops: ${frames.map((f) => f.op).join(",")})`,
                ),
              );
            }, ms);
            waiters.push(w);
          });
        },
        close: () => {
          try {
            socket.write(wsControl(0x8, Buffer.from([0x03, 0xe8])));
          } catch {
            // already closed
          }
          socket.destroy();
        },
      });
    });
    req.end();
  });
}

// ---------------------------------------------------------------- checks

/** SQL string literal (values here are generated or come from the gate env, never from a response). */
const sqlText = (v) => `'${String(v).replaceAll("'", "''")}'`;

/** `cookie` header for an ApiClient's jar, for requests that need the raw response (redirects, Set-Cookie). */
const cookieOf = (client) => [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

/** The proxy checks (gate step convention): pushes one step per check to ctx.steps. */
export async function run(ctx) {
  const checks = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    let res;
    try {
      res = await fn();
    } catch (err) {
      res = { ok: false, error: String(err.message ?? err).slice(0, 2000) };
    }
    const { ok, ...details } = res;
    const step = { name, ok: ok === true, ms: Date.now() - t0, details };
    checks.push(step);
    ctx.steps.push(step);
    return step;
  };
  const shared = {};

  const enabled = await check("proxy-enabled", () => enableProxy(ctx));
  if (!enabled.ok) return { name: "proxy", ok: false, details: { checks: checks.map((c) => c.name) } };
  const origin = ctx.urls.public;

  await check("ports-loopback", async () => {
    const port = (svc, target) => ctx.compose(["port", svc, String(target)]).stdout.trim();
    const api = port("api", 4000);
    const web = port("web", 3000);
    // From the network, api and web cannot be reached at all: a client can only talk to Caddy, which overwrites
    // X-Forwarded-For, so the one hop the API trusts (OCW_TRUST_PROXY=1) is always Caddy's.
    const lan = hostAddresses();
    const reachable = [];
    for (const host of lan) {
      for (const p of [ctx.ports.api, ctx.ports.web])
        if (!(await refused(host, p))) reachable.push(`${host}:${p}`);
    }
    return {
      ok:
        api === `127.0.0.1:${ctx.ports.api}` &&
        web === `127.0.0.1:${ctx.ports.web}` &&
        reachable.length === 0,
      api,
      web,
      lanAddressesTried: lan.length,
      reachableFromNetwork: reachable,
    };
  });

  await check("tls-trust", async () => {
    // Verification is on: before trusting Caddy's local root the origin must be refused.
    let untrusted = "accepted";
    try {
      await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      untrusted = String(err.cause?.code ?? err.message);
    }
    const root = await poll(
      async () => {
        const pem = caddyRoot(ctx);
        return { ok: pem !== null, pem };
      },
      { timeoutMs: 60_000 },
    );
    if (!root.ok) return { ok: false, error: `no ${CADDY_ROOT} in the caddy container`, untrusted };
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), root.pem]);
    return {
      ok: /CERT|SIGNATURE|ISSUER|SELF_SIGNED/i.test(untrusted),
      untrustedRefusedWith: untrusted,
      root: createHash("sha256").update(root.pem).digest("hex").slice(0, 16),
    };
  });

  const status = async (pathname, want = 200) => {
    const res = await fetch(`${origin}${pathname}`, { signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer();
    return { ok: res.status === want, status: res.status, url: res.url.replace(origin, "") };
  };
  await check("web-login", () => poll(() => status("/login"), { timeoutMs: 120_000 }));
  await check("api-health", () => poll(() => status("/health"), { timeoutMs: 60_000 }));
  await check("docs", () => poll(() => status("/docs"), { timeoutMs: 30_000 }));

  // The shared gate admin, created (fresh stack) or signed in through the proxy only, and its #general.
  const viaProxy = Object.defineProperty({ urls: { ...ctx.urls, api: origin } }, "env", { value: ctx.env });
  const adminSession = async () => {
    shared.admin ??= await ensureAdmin(viaProxy);
    return shared.admin;
  };
  const generalChannel = async () => {
    if (shared.general) return shared.general;
    const channels = await (await adminSession()).client.request("GET", "/api/v1/channels");
    const general = channels.body?.channels?.find((c) => c.slug === "general");
    if (!general) throw new Error(`no #general (channels: ${channels.status})`);
    shared.general = general;
    return general;
  };

  await check("ws-upgrade", async () => {
    const admin = await adminSession();
    const tokenRes = await admin.client.request("GET", "/api/auth/token");
    if (tokenRes.status !== 200 || !tokenRes.body?.token) throw new Error(`token: ${tokenRes.status}`);
    const general = await generalChannel();
    const ws = await openWs(origin, tokenRes.body.token);
    if (ws.status !== 101) return { ok: false, status: ws.status };
    try {
      const topic = `conv:${general.id}`;
      ws.send({ op: "sub", topic });
      await ws.next((f) => f.op === "subscribed" && f.topic === topic);
      const body = `proxy ws check ${randomBytes(4).toString("hex")}`;
      const posted = await admin.client.request("POST", `/api/v1/conversations/${general.id}/messages`, {
        body,
      });
      if (posted.status !== 200 && posted.status !== 201) throw new Error(`post message: ${posted.status}`);
      const frame = await ws.next(
        (f) =>
          f.op === "ev" &&
          f.topic === topic &&
          f.type === "message.created" &&
          JSON.stringify(f.data).includes(body),
      );
      return {
        ok: ws.acceptOk && ws.protocol === "ocw.v1",
        status: ws.status,
        protocol: ws.protocol,
        frame: { op: frame.op, type: frame.type, seq: frame.seq },
        adminCreated: admin.created,
      };
    } finally {
      ws.close();
    }
  });

  // ---- Task 2: presigned object URLs reachable from outside the compose network (SigV4 over Host and path)
  const bucketPrefix = `${origin}/${ctx.env.OCW_S3_BUCKET || "ocw-attachments"}/`;
  await check("presign-put-get", async () => {
    const admin = await adminSession();
    const general = await generalChannel();
    const presign = await admin.client.request("POST", `/api/v1/conversations/${general.id}/attachments`, {
      filename: `proxy-${randomBytes(4).toString("hex")}.png`,
      contentType: "image/png",
      size: PNG.length,
    });
    if (presign.status !== 200) return { ok: false, presign: presign.status };
    const { upload, attachment } = presign.body;
    // Presigned URLs are bearer credentials: only their origin is ever reported.
    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: PNG });
    await put.arrayBuffer();
    const complete = await admin.client.request("POST", `/api/v1/attachments/${attachment.id}/complete`);
    const download = await fetch(`${origin}/api/v1/attachments/${attachment.id}/download`, {
      redirect: "manual",
      headers: { origin, cookie: cookieOf(admin.client) },
    });
    await download.arrayBuffer();
    const location = download.headers.get("location") ?? "";
    const get = location.startsWith(bucketPrefix) ? await fetch(location) : null;
    const bytes = get ? Buffer.from(await get.arrayBuffer()) : Buffer.alloc(0);
    shared.objectUrl = get?.status === 200 ? location : undefined;
    return {
      ok:
        upload.url.startsWith(bucketPrefix) &&
        put.status === 200 &&
        complete.status === 200 &&
        complete.body?.status === "ready" &&
        download.status === 302 &&
        get?.status === 200 &&
        bytes.equals(PNG),
      signedFor: new URL(upload.url).origin,
      put: put.status,
      complete: complete.status,
      download: download.status,
      redirectOrigin: location ? new URL(location).origin : null,
      get: get?.status ?? null,
      identicalBytes: bytes.equals(PNG),
    };
  });

  await check("presign-tampered-403", async () => {
    if (!shared.objectUrl) return { ok: false, error: "no presigned GET from presign-put-get" };
    const url = new URL(shared.objectUrl);
    const sig = url.searchParams.get("X-Amz-Signature") ?? "";
    // One character of the signature changed.
    url.searchParams.set("X-Amz-Signature", `${sig.slice(0, -1)}${sig.at(-1) === "0" ? "1" : "0"}`);
    const signature = await fetch(url);
    await signature.arrayBuffer();
    // The original signature on another key (path changed).
    const other = new URL(shared.objectUrl);
    other.pathname = `${other.pathname}-x`;
    const path = await fetch(other);
    await path.arrayBuffer();
    return {
      ok: sig.length > 0 && signature.status === 403 && path.status === 403,
      signature: signature.status,
      path: path.status,
    };
  });

  await check("presign-unsigned-403", async () => {
    if (!shared.objectUrl) return { ok: false, error: "no presigned GET from presign-put-get" };
    const url = new URL(shared.objectUrl);
    const res = await fetch(`${url.origin}${url.pathname}`);
    await res.arrayBuffer();
    return { ok: res.status === 403, status: res.status };
  });

  // ---- Task 2: trusted proxy headers and cookies
  await check("xff-ignored", async () => {
    const email = `proxy-xff-${randomBytes(4).toString("hex")}@ocw.test`;
    const failed = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": SPOOFED_IP },
      body: JSON.stringify({ email, password: "definitely-not-the-password" }),
    });
    await failed.arrayBuffer();
    const auditIp = ctx
      .psql(
        `select metadata->>'ip' from app.audit_events where action = 'user.sign_in_failed' ` +
          `and metadata->>'email' = ${sqlText(email)} order by occurred_at desc limit 1`,
      )
      .trim();
    // A successful sign-in with the same forged header: the IP better-auth stores on the session.
    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": SPOOFED_IP },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    await signIn.arrayBuffer();
    shared.signInCookies = signIn.headers.getSetCookie();
    const sessionIp = ctx
      .psql(
        `select s.ip_address from auth.session s join auth."user" u on u.id = s.user_id ` +
          `where u.email = ${sqlText(ADMIN.email.toLowerCase())} order by s.created_at desc limit 1`,
      )
      .trim();
    // Informational, not part of `ok`: a process on this host that reaches the loopback-published API directly is
    // one hop away like Caddy, so OCW_TRUST_PROXY=1 believes its header (docs/self-hosting/reverse-proxy.md).
    const directEmail = `proxy-xff-direct-${randomBytes(4).toString("hex")}@ocw.test`;
    const direct = await fetch(`${ctx.urls.api}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": SPOOFED_IP },
      body: JSON.stringify({ email: directEmail, password: "definitely-not-the-password" }),
    });
    await direct.arrayBuffer();
    const directAuditIp = ctx
      .psql(
        `select metadata->>'ip' from app.audit_events where action = 'user.sign_in_failed' ` +
          `and metadata->>'email' = ${sqlText(directEmail)} order by occurred_at desc limit 1`,
      )
      .trim();
    return {
      ok:
        failed.status === 401 &&
        auditIp !== "" &&
        auditIp !== SPOOFED_IP &&
        signIn.status === 200 &&
        sessionIp !== "" &&
        sessionIp !== SPOOFED_IP,
      signInFailed: failed.status,
      auditIp,
      signIn: signIn.status,
      sessionIp,
      residualDirectLoopback: { status: direct.status, auditIp: directAuditIp },
    };
  });

  await check("secure-cookie", async () => {
    const session = (shared.signInCookies ?? []).find((c) => /session_token=/.test(c.split(";")[0]));
    if (!session) return { ok: false, error: "no session cookie in the sign-in response" };
    const name = session.slice(0, session.indexOf("="));
    const attributes = session
      .split(";")
      .slice(1)
      .map((a) => a.trim().split("=")[0].toLowerCase());
    return {
      ok: name.startsWith("__Secure-") && attributes.includes("secure") && attributes.includes("httponly"),
      name,
      attributes,
    };
  });

  await check("agent-channel-404", async () => {
    // Caddy answers with an empty 404; the API itself (reached on loopback only) answers differently.
    const via = await fetch(`${origin}/agent-channel/v1/anything`);
    const body = await via.text();
    const bare = await fetch(`${origin}/agent-channel`);
    await bare.arrayBuffer();
    const direct = await fetch(`${ctx.urls.api}/agent-channel/v1/anything`);
    await direct.arrayBuffer();
    return {
      ok: via.status === 404 && body.length === 0 && bare.status === 404,
      viaProxy: via.status,
      bodyBytes: body.length,
      bare: bare.status,
      directOnLoopback: direct.status,
    };
  });

  return { name: "proxy", ok: checks.every((c) => c.ok), details: { checks: checks.map((c) => c.name) } };
}

async function main() {
  const { values } = parseArgs({
    options: {
      up: { type: "boolean", default: false },
      attach: { type: "string" },
      "run-id": { type: "string" },
      keep: { type: "boolean", default: false },
      block: { type: "string", default: "34" },
    },
  });
  if (!values.up && !values.attach) {
    process.stderr.write("Usage: proxy-check.mjs --up [--run-id <id>] [--keep] | --attach <envFile>\n");
    process.exitCode = 2;
    return;
  }
  const runId = values["run-id"] ?? newRunId();
  const steps = [];
  const started = Date.now();
  const before = await demoSnapshot();
  let error;
  let target = {};
  try {
    await withGateStack(
      { runId, keep: values.keep, attachEnvFile: values.attach, block: Number(values.block), steps },
      async (ctx) => {
        target = { project: ctx.project, imageTag: ctx.imageTag };
        await run(ctx);
        target.urls = ctx.urls;
      },
    );
  } catch (err) {
    error = String(err.message ?? err).slice(0, 2000);
  }
  const after = await demoSnapshot();
  const diff = diffDemo(before, after);
  steps.push({
    name: "demo-untouched",
    ok: diff.length === 0,
    details: diff.length
      ? { diff }
      : { localImages: after.images.length, demoContainers: after.containers.length },
  });
  const ok = !error && steps.every((s) => s.ok);
  const summary = { ok, runId, ...target, totalMs: Date.now() - started, steps, ...(error ? { error } : {}) };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
