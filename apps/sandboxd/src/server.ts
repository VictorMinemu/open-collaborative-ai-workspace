import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { SANDBOX_LIMITS, SANDBOXD_ROUTES, type SandboxdErrorCode, type SandboxdOp } from "@ocw/contracts";
import type { z } from "zod";
import { createEvents, EVENTS_MAX_WAIT_MS, type Events } from "./events";
import type { Files } from "./files";
import { SandboxdFailure, type Sandboxes } from "./sandboxes";

/**
 * sandboxd's HTTP server (07.8-04, D-02, P-03): a bearer token compared in constant time, routes taken from
 * `SANDBOXD_ROUTES`, every body parsed with the route's input schema and every result with its output schema. Error
 * bodies are fixed text: a request body is never echoed. Logs carry ids, the op, the status and the duration only
 * (never argv, output, paths or tokens). Listens on the internal `sandbox-control` network only; no published port.
 */

/** The ops this server implements so far; any other path is 404 (later plans add browser and package ops). */
export const IMPLEMENTED_OPS = [
  "info",
  "ensure",
  "exec",
  "process",
  "stop",
  "restart",
  "kill",
  "killOrg",
  "purge",
  "usage",
  "policy",
  "events",
  "filesList",
  "filesStat",
  "filesRead",
  "filesWrite",
  "filesDelete",
  "filesUpload",
  "filesDownload",
  "filesImport",
] as const satisfies readonly SandboxdOp[];
type ImplementedOp = (typeof IMPLEMENTED_OPS)[number];

/** Request bodies above this are refused before parsing (exec argv is at most 64 × 8 KiB). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** JSON overhead allowed over a base64 payload. */
const ENVELOPE_BYTES = 64 * 1024;
const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * The file transfer routes take 72 MiB. The API (07.8-11) accepts a raw upload of up to 50 MiB and forwards it as
 * base64 JSON, about 67 MiB on the wire; the contract's own schema still refuses decoded content over 50 MiB.
 * Download and import get the same limit as upload; a write (at most 1 MiB, about 1.4 MiB as base64) gets its own.
 * Every other route keeps 1 MiB.
 */
export const TRANSFER_BODY_BYTES = 72 * 1024 * 1024;

export const BODY_LIMITS: Partial<Record<ImplementedOp, number>> = {
  filesUpload: TRANSFER_BODY_BYTES,
  filesImport: TRANSFER_BODY_BYTES,
  filesDownload: TRANSFER_BODY_BYTES,
  filesWrite: base64Size(SANDBOX_LIMITS.writeMaxBytes) + ENVELOPE_BYTES,
};

/** Large transfers held in memory at once (each up to ~67 MiB of JSON plus 50 MiB decoded); more answer 409 busy. */
export const MAX_CONCURRENT_TRANSFERS = 2;
const TRANSFER_OPS: ReadonlySet<ImplementedOp> = new Set(["filesUpload", "filesImport", "filesDownload"]);

export interface LogLine {
  level: "info" | "warn" | "error";
  msg: string;
  [key: string]: unknown;
}

export interface ServerOptions {
  token: string;
  sandboxes: Sandboxes;
  files: Files;
  /** The event feed the sandboxes emit into (a fresh, empty one when omitted). */
  events?: Events;
  log?: (line: LogLine) => void;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time bearer check: both sides are hashed to equal-length digests first. */
export function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header) return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(expected), digest(match[1] as string));
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, code: SandboxdErrorCode, message: string) {
  send(res, status, { error: { code, message } });
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > max) {
      reject(new BodyTooLarge());
      req.resume();
      return;
    }
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function findRoute(method: string, path: string): ImplementedOp | null {
  for (const op of IMPLEMENTED_OPS) {
    const route = SANDBOXD_ROUTES[op];
    if (route.method === method && route.path === path) return op;
  }
  return null;
}

/** Ids for the log line only (target or org), when the parsed input carries them. */
function idsOf(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) return {};
  const o = input as { target?: { orgId?: string; agentId?: string }; orgId?: string };
  if (o.target) return { orgId: String(o.target.orgId), agentId: String(o.target.agentId) };
  if (typeof o.orgId === "string") return { orgId: o.orgId };
  return {};
}

export function createServer(options: ServerOptions): http.Server {
  const { token, sandboxes, files } = options;
  const events = options.events ?? createEvents();
  const log = options.log ?? (() => {});
  let transfers = 0;

  const handlers: {
    [Op in ImplementedOp]: (input: z.output<(typeof SANDBOXD_ROUTES)[Op]["input"]>) => unknown;
  } = {
    info: () => sandboxes.info(),
    ensure: (input) => sandboxes.ensure(input.target),
    exec: (input) => sandboxes.exec(input),
    process: (input) => sandboxes.process(input),
    stop: (input) => sandboxes.stop(input),
    restart: (input) => sandboxes.restart(input.target),
    kill: (input) => sandboxes.kill(input.target),
    killOrg: (input) => sandboxes.killOrg(input.orgId),
    purge: (input) => sandboxes.purge(input.target),
    usage: (input) => sandboxes.usage(input.orgId),
    // The API's long poll (P-04): sandboxd never calls the API. Capped at 25 s whatever the contract allows.
    events: (input) => events.since(input.after, Math.min(input.waitMs, EVENTS_MAX_WAIT_MS)),
    policy: (input) => {
      sandboxes.setPolicy(input);
      return { ok: true };
    },
    filesList: (input) => files.list(input),
    filesStat: (input) => files.stat(input),
    filesRead: (input) => files.read(input),
    filesWrite: (input) => files.write(input),
    filesDelete: (input) => files.remove(input),
    filesUpload: (input) => files.upload(input),
    filesDownload: (input) => files.download(input),
    filesImport: (input) => files.upload(input),
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://sandboxd");
    const method = req.method ?? "GET";

    // The token comes before routing, so an unauthenticated caller learns nothing about the routes.
    if (!tokenMatches(token, req.headers.authorization)) {
      req.resume();
      sendError(res, 401, "unauthorized", "a valid bearer token is required");
      log({ level: "warn", msg: "request", status: 401, ms: Date.now() - started });
      return;
    }

    const op = findRoute(method, url.pathname);
    if (!op) {
      req.resume();
      sendError(res, 404, "not_found", "no such route");
      log({ level: "info", msg: "request", status: 404, ms: Date.now() - started });
      return;
    }
    const route = SANDBOXD_ROUTES[op];

    let raw: unknown;
    try {
      if (route.method === "GET") {
        raw = Object.fromEntries(url.searchParams.entries());
        req.resume();
      } else {
        const text = await readBody(req, BODY_LIMITS[op] ?? MAX_BODY_BYTES);
        raw = text.length === 0 ? {} : JSON.parse(text);
      }
    } catch (err) {
      if (err instanceof BodyTooLarge) sendError(res, 413, "too_large", "the request body is too large");
      else sendError(res, 400, "invalid_request", "the request body is not JSON");
      log({ level: "info", msg: "request", op, status: err instanceof BodyTooLarge ? 413 : 400 });
      return;
    }

    const parsed = route.input.safeParse(raw);
    if (!parsed.success) {
      sendError(res, 400, "invalid_request", "the request does not match the sandboxd contract");
      log({ level: "info", msg: "request", op, status: 400, ms: Date.now() - started });
      return;
    }
    const ids = idsOf(parsed.data);

    const transfer = TRANSFER_OPS.has(op);
    if (transfer && transfers >= MAX_CONCURRENT_TRANSFERS) {
      sendError(res, 409, "busy", "too many file transfers at once");
      log({ level: "info", msg: "request", op, ...ids, status: 409, code: "busy", ms: Date.now() - started });
      return;
    }
    if (transfer) transfers += 1;
    try {
      const handler = handlers[op] as (input: unknown) => unknown;
      const result = await handler(parsed.data);
      const out = route.output.safeParse(result);
      if (!out.success) {
        sendError(res, 500, "docker_unavailable", "sandboxd produced an invalid result");
        log({ level: "error", msg: "invalid result", op, ...ids, status: 500, ms: Date.now() - started });
        return;
      }
      send(res, 200, out.data);
      log({ level: "info", msg: "request", op, ...ids, status: 200, ms: Date.now() - started });
    } catch (err) {
      if (err instanceof SandboxdFailure) {
        sendError(res, err.status, err.code, err.message);
        log({
          level: "info",
          msg: "request",
          op,
          ...ids,
          status: err.status,
          code: err.code,
          ms: Date.now() - started,
        });
        return;
      }
      sendError(res, 500, "docker_unavailable", "internal error");
      log({
        level: "error",
        msg: "request failed",
        op,
        ...ids,
        status: 500,
        error: err instanceof Error ? err.name : "unknown",
        ms: Date.now() - started,
      });
    } finally {
      if (transfer) transfers -= 1;
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, "docker_unavailable", "internal error");
      else res.destroy();
    });
  });
  // Exec yields after at most 25 s and a process kill waits up to 5 s; leave room for both.
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  return server;
}
