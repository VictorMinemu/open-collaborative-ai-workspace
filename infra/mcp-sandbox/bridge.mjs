#!/usr/bin/env node
// OCW stdio MCP sandbox bridge (03.1-14, D-13; research B1).
//
// Runs ONLY inside the hardened `ocw-mcp-sandbox` sidecar, never inside the OpenClaw gateway container. Each vetted,
// pinned stdio MCP server baked into the image (servers.json) is exposed to the cell as a remote streamable-HTTP
// server at `/<id>/mcp`; the cell renders it like any registered remote server, so every call still goes through the
// cell's tool gate and the API's audit (OCW_MCP_SANDBOX_URL, apps/api/src/modules/mcp/service.ts cellMcpServers).
//
// One MCP session = one child process: an `initialize` POST spawns the allowlisted command (official SDK
// StdioClientTransport) and JSON-RPC messages are pumped both ways unchanged. The session ends on DELETE, child exit,
// idle timeout or shutdown, and the child is killed with it. Sessions are capped (MAX_SESSIONS). The child gets a
// minimal environment: PATH, HOME=/tmp and only the variables its allowlist entry names. Nothing is installed at
// runtime (no npx/npm/uvx). The log has one line per session start/end and never a payload.
//
//   node bridge.mjs           serve on MCP_SANDBOX_PORT (8080) / MCP_SANDBOX_HOST (0.0.0.0)
//   node bridge.mjs --check   validate servers.json against the installed packages and exit (image build step)
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export const MAX_SESSIONS = 16;
export const SESSION_IDLE_MS = 600_000;
/** Largest JSON-RPC request body accepted from the cell, and largest single message accepted from a child. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

/** Same shape as the API's OCW_MCP_SANDBOX_SERVERS names. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/u;
/** Variables the bridge sets itself, or that hijack an interpreter/loader in the child. */
const RESERVED_ENV_RE =
  /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|IFS|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|JAVA_TOOL_OPTIONS|LD_\w*|DYLD_\w*|BASH_FUNC_\w*)$/u;
/** Package runners that install at runtime (supply chain, mutable latest): never allowed. */
const RUNTIME_INSTALLERS = new Set([
  "npx",
  "npm",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "uv",
  "uvx",
  "pip",
  "pip3",
  "pipx",
]);

/**
 * Validates the allowlist: unique safe ids; command `node` or an absolute file; no runtime installer; the entry file
 * (first argument) exists inside appDir when relative; only plain, non-reserved env names. Throws on the first issue.
 */
export function validateServers(list, { appDir }) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("servers.json must list at least one server");
  const seen = new Set();
  return list.map((s) => {
    const where = `server ${JSON.stringify(s?.id)}`;
    if (typeof s?.id !== "string" || !ID_RE.test(s.id)) throw new Error(`${where}: id must match ${ID_RE}`);
    if (seen.has(s.id)) throw new Error(`${where}: duplicate id`);
    seen.add(s.id);
    const args = s.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new Error(`${where}: args must be strings`);
    }
    if (typeof s.command !== "string" || !s.command) throw new Error(`${where}: command is required`);
    if (RUNTIME_INSTALLERS.has(basename(s.command)) || args.some((a) => a === "-y" || a === "--yes")) {
      throw new Error(`${where}: runtime installs are forbidden; bake the package into the image`);
    }
    if (s.command !== "node" && !(isAbsolute(s.command) && existsSync(s.command))) {
      throw new Error(`${where}: command must be "node" or an absolute path to a baked executable`);
    }
    const entry = args[0];
    if (!entry) throw new Error(`${where}: the first argument must be the server's entry file (missing)`);
    const entryPath = isAbsolute(entry) ? entry : resolve(appDir, entry);
    const rel = relative(appDir, entryPath);
    if (!isAbsolute(entry) && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(`${where}: entry file must stay inside the app directory`);
    }
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
      throw new Error(`${where}: entry file ${entry} is missing (is the package baked into the image?)`);
    }
    const env = s.env ?? [];
    if (!Array.isArray(env)) throw new Error(`${where}: env must be a list of variable names`);
    for (const name of env) {
      if (typeof name !== "string" || !ENV_NAME_RE.test(name) || RESERVED_ENV_RE.test(name)) {
        throw new Error(`${where}: env name ${JSON.stringify(name)} is not allowed`);
      }
    }
    return Object.freeze({ id: s.id, command: s.command, args: [...args], env: [...env] });
  });
}

/**
 * The child's whole environment. The SDK merges its default inherited variables (HOME, LOGNAME, PATH, SHELL, TERM,
 * USER) from this process's env; `undefined` removes them (child_process skips undefined values).
 */
export function childEnv(server, env) {
  const out = {};
  for (const name of DEFAULT_INHERITED_ENV_VARS) out[name] = undefined;
  out.PATH = env.PATH || DEFAULT_PATH;
  out.HOME = "/tmp";
  for (const name of server.env) if (typeof env[name] === "string") out[name] = env[name];
  return out;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendError(res, status, message, code = -32000, headers = {}) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readJson(req, maxBytes) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > maxBytes) throw new HttpError(413, "Request body too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Parse error: the body is not JSON");
  }
}

/**
 * The bridge's HTTP server. `servers` is the raw allowlist (validated here), `env` the sidecar's own environment
 * (source of PATH and of the variables an entry names).
 */
export function createBridge({
  servers,
  appDir,
  env = process.env,
  maxSessions = MAX_SESSIONS,
  idleMs = SESSION_IDLE_MS,
  maxBodyBytes = MAX_BODY_BYTES,
  log = (line) => console.log(line),
}) {
  const byId = new Map(validateServers(servers, { appDir }).map((s) => [s.id, s]));
  /** Routable sessions by MCP session id. */
  const sessions = new Map();
  /** Every session holding (or starting) a child, including ones not yet initialized: the cap counts these. */
  const live = new Set();
  const stats = { spawned: 0 };

  function touch(s) {
    clearTimeout(s.idleTimer);
    if (s.closed) return;
    s.idleTimer = setTimeout(() => {
      if (s.active > 0) touch(s);
      else void closeSession(s, "idle");
    }, idleMs);
    s.idleTimer.unref();
  }

  async function closeSession(s, reason) {
    if (s.closed) return;
    s.closed = true;
    clearTimeout(s.idleTimer);
    live.delete(s);
    if (s.id) sessions.delete(s.id);
    if (s.id) log(`[mcp-sandbox] session ${s.id.slice(0, 8)} ended reason=${reason} server=${s.server.id}`);
    await Promise.allSettled([s.child.close(), s.http.close()]);
  }

  async function openSession(server) {
    const child = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: appDir,
      env: childEnv(server, env),
      // A third-party server's stderr may echo payloads: not forwarded to the sidecar log.
      stderr: "ignore",
      maxBufferSize: maxBodyBytes,
    });
    const s = { id: null, server, child, http: null, active: 0, closed: false, idleTimer: undefined };
    s.http = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        s.id = id;
        sessions.set(id, s);
        log(
          `[mcp-sandbox] session ${id.slice(0, 8)} started server=${server.id} pid=${child.pid} (${live.size}/${maxSessions})`,
        );
      },
      onsessionclosed: () => void closeSession(s, "delete"),
    });
    // Pump JSON-RPC both ways, unchanged. Responses find their HTTP stream by id; server-initiated messages go to the
    // client's GET stream.
    s.http.onmessage = (message) => {
      child.send(message).catch(() => void closeSession(s, "child-write-failed"));
    };
    child.onmessage = (message) => {
      s.http.send(message).catch(() => {});
    };
    child.onclose = () => void closeSession(s, "exit");
    s.http.onclose = () => void closeSession(s, "closed");
    child.onerror = () => {};
    s.http.onerror = () => {};
    live.add(s);
    try {
      await child.start();
    } catch (error) {
      live.delete(s);
      s.closed = true;
      throw error;
    }
    stats.spawned++;
    touch(s);
    return s;
  }

  /** Counts an in-flight request (including an open SSE stream) as activity until its response closes. */
  async function serve(s, req, res, body) {
    s.active++;
    touch(s);
    res.once("close", () => {
      s.active--;
      touch(s);
    });
    await s.http.handleRequest(req, res, body);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://mcp-sandbox");
    if (url.pathname === "/healthz") {
      if (req.method !== "GET") return sendError(res, 405, "Method not allowed", -32000, { allow: "GET" });
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, sessions: sessions.size, maxSessions }));
    }
    const match = /^\/([^/]+)\/mcp$/u.exec(url.pathname);
    const server = match && ID_RE.test(match[1]) ? byId.get(match[1]) : undefined;
    if (!server) return sendError(res, 404, "Not found");
    // Only the cell calls the sidecar, never a browser (DNS-rebinding guard).
    if (req.headers.origin !== undefined) return sendError(res, 403, "Browser origins are not accepted");
    if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) {
      return sendError(res, 405, "Method not allowed", -32000, { allow: "GET, POST, DELETE" });
    }

    const sessionId = req.headers["mcp-session-id"];
    if (sessionId !== undefined) {
      const s = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!s || s.closed || s.server.id !== server.id)
        return sendError(res, 404, "Session not found", -32001);
      const body = req.method === "POST" ? await readJson(req, maxBodyBytes) : undefined;
      return serve(s, req, res, body);
    }

    if (req.method !== "POST") return sendError(res, 400, "Bad Request: Mcp-Session-Id header is required");
    const body = await readJson(req, maxBodyBytes);
    if (!isInitializeRequest(body)) {
      return sendError(res, 400, "Bad Request: no valid session ID provided");
    }
    if (live.size >= maxSessions) {
      log(`[mcp-sandbox] session refused server=${server.id}: ${maxSessions} sessions open`);
      return sendError(res, 503, "Too many MCP sessions; retry later", -32000, { "retry-after": "30" });
    }
    let s;
    try {
      s = await openSession(server);
    } catch (error) {
      log(`[mcp-sandbox] server=${server.id} could not start: ${error?.code ?? "spawn failed"}`);
      return sendError(res, 502, "The MCP server could not be started");
    }
    await serve(s, req, res, body);
    // The transport refused the initialize (e.g. a bad protocol header): no session came out of it.
    if (!s.id) await closeSession(s, "initialize-failed");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof HttpError) return sendError(res, error.status, error.message);
      log(`[mcp-sandbox] request failed: ${error?.name ?? "Error"}`);
      sendError(res, 500, "Internal error");
    });
  });
  // A slow client cannot hold a socket forever while sending its request.
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;

  return {
    server,
    sessions,
    stats,
    listen(port, host) {
      return new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(port, host, () => ok(server.address()));
      });
    },
    async close() {
      await Promise.allSettled([...live].map((s) => closeSession(s, "shutdown")));
      server.closeAllConnections();
      await new Promise((ok) => server.close(() => ok()));
    },
  };
}

async function main() {
  const appDir = fileURLToPath(new URL(".", import.meta.url));
  const servers = JSON.parse(readFileSync(new URL("./servers.json", import.meta.url), "utf8"));
  if (process.argv.includes("--check")) {
    const ok = validateServers(servers, { appDir });
    console.log(`[mcp-sandbox] servers.json OK: ${ok.map((s) => s.id).join(", ")}`);
    return;
  }
  const num = (name, fallback) => {
    const v = Number(process.env[name]);
    return Number.isInteger(v) && v > 0 ? v : fallback;
  };
  const bridge = createBridge({
    servers,
    appDir,
    maxSessions: num("MCP_SANDBOX_MAX_SESSIONS", MAX_SESSIONS),
    idleMs: num("MCP_SANDBOX_SESSION_IDLE_MS", SESSION_IDLE_MS),
  });
  const port = num("MCP_SANDBOX_PORT", 8080);
  const host = process.env.MCP_SANDBOX_HOST || "0.0.0.0";
  await bridge.listen(port, host);
  console.log(
    `[mcp-sandbox] serving ${[...new Set(servers.map((s) => s.id))].join(", ")} on :${port} (/<id>/mcp)`,
  );
  const stop = () => {
    bridge.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[mcp-sandbox] ${error?.message ?? error}`);
    process.exit(1);
  });
}
