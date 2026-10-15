// The in-memory sandboxd (Phase 07.8-05, P-13): every shell, file and browser operation of `SANDBOXD_ROUTES`
// (packages/contracts/src/sandboxd-protocol.ts) over a per-bot workspace and per-bot browser contexts kept in memory, so
// the API's integration tests and the e2e harness (08) never need Docker. Package ops arrive with 07.8-18. Dependency-free; every answer has the contract's shape (the API's client
// parses each one with the contract). It never logs or stores request bodies beyond the workspace itself, and its
// counters hold call counts per op and per organization only.
//
// The exec interpreter is deliberately tiny: `sh -c "<a> && <b>; <c>"`, `echo`, `cat`, `ls`, `id -u`, `env`,
// `sleep N`, `exit N`, `true`, `false`, and `>` / `>>` into the workspace. Anything else exits 127.
//
// The browser (07.8-08) mirrors infra/sandbox/browser/agent.mjs over a two-page fake site: `https://<host>/…` shows a
// sign-in form (Email, a redacted Password, Sign in, an Export link to evil.fake.test, a Download link) or, once signed
// in, a dashboard. Snapshots carry only redacted values; frames are the JPEG fixtures of 07
// (fixtures/sandbox/frames, read lazily) at ≤ 8 fps per subscriber in the contract framing; takeover input is counted
// by event type and dropped at once; a site-locked context blocks and reports navigations to another host unless the op
// carries `allowCrossSite` (D-13). Nothing a page or a person types is stored, logged or counted beyond its type.
//
// Test controls (no token): POST /__control/down | /__control/up | /__control/reset | /__control/emit (an event body),
// GET /__control/stats; browser: POST /__control/browser/leak (the next snapshot carries OCW-SENTINEL-PW-5521 on a
// redacted node, to prove the API's second pass), /__control/browser/signed-in {contextId} (the context's site is
// signed in), /__control/browser/event {target, contextId, event: crashed|closed|focus_sensitive|download}.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const SANDBOX_USER_ID = 10001;
const OUTPUT_TAIL_BYTES = 16_384;
const MAX_BODY_BYTES = 80 * 1024 * 1024;
const ENV_LINES = ["HOME=/workspace", "PATH=/usr/local/bin:/usr/bin:/bin", "USER=sandbox", "PWD=/workspace"];

const LEAK_SENTINEL = "OCW-SENTINEL-PW-5521";
const REDACTED = "[redacted]";
const FRAME_INTERVAL_MS = 125; // 8 fps
const FRAME_FILES = ["logged-out", "login-form", "typing", "signed-in"];
const FRAMES_DIR = new URL("./fixtures/sandbox/frames/", import.meta.url);
const DOWNLOAD_BYTES = Buffer.from("id,amount\n1,1250\n", "utf8");
const EXPORT_HOST = "evil.fake.test";
const BROWSER_EVENTS = new Set(["crashed", "closed", "focus_sensitive", "download"]);

/** Route path → op name (the counters' keys); package ops are not served yet (18). */
const OPS = {
  "GET /v1/info": "info",
  "POST /v1/sandboxes/ensure": "ensure",
  "POST /v1/sandboxes/exec": "exec",
  "POST /v1/sandboxes/process": "process",
  "POST /v1/sandboxes/stop": "stop",
  "POST /v1/sandboxes/restart": "restart",
  "POST /v1/sandboxes/kill": "kill",
  "POST /v1/orgs/kill": "killOrg",
  "POST /v1/sandboxes/purge": "purge",
  "POST /v1/usage": "usage",
  "POST /v1/policy": "policy",
  "POST /v1/files/list": "filesList",
  "POST /v1/files/stat": "filesStat",
  "POST /v1/files/read": "filesRead",
  "POST /v1/files/write": "filesWrite",
  "POST /v1/files/delete": "filesDelete",
  "POST /v1/files/upload": "filesUpload",
  "POST /v1/files/download": "filesDownload",
  "POST /v1/files/import": "filesImport",
  "GET /v1/events": "events",
  "POST /v1/browsers/ensure": "browserEnsure",
  "POST /v1/browsers/contexts/open": "contextOpen",
  "POST /v1/browsers/contexts/navigate": "contextNavigate",
  "POST /v1/browsers/contexts/snapshot": "contextSnapshot",
  "POST /v1/browsers/contexts/act": "contextAct",
  "POST /v1/browsers/contexts/screenshot": "contextScreenshot",
  "POST /v1/browsers/contexts/wait": "contextWait",
  "POST /v1/browsers/contexts/export-state": "contextExportState",
  "POST /v1/browsers/contexts/close": "contextClose",
  "POST /v1/browsers/contexts/hold": "contextHold",
  "POST /v1/browsers/contexts/takeover": "contextTakeover",
  "POST /v1/browsers/contexts/resize": "contextResize",
  "GET /v1/browsers/contexts/frames": "contextFrames",
  "POST /v1/browsers/contexts/input": "contextInput",
  "POST /v1/browsers/contexts/download": "contextDownload",
};

/** The JPEG fixtures, read once on first use. */
let frameCache = null;
async function frameFixtures() {
  frameCache ??= Object.fromEntries(
    await Promise.all(FRAME_FILES.map(async (n) => [n, await readFile(new URL(`${n}.jpg`, FRAMES_DIR))])),
  );
  return frameCache;
}

/** One frame in the contract framing: 4-byte big-endian payload length, 1-byte type (0 JPEG, 1 JSON control). */
function encodeFrame(type, payload) {
  const out = Buffer.alloc(5 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out[4] = type;
  payload.copy(out, 5);
  return out;
}

/** `host` or `host:port` of an http(s) URL, lower case; null when it is not one. */
function hostOfUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

class OpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (what) => new OpError(400, "invalid_request", `invalid ${what}`);

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new OpError(413, "too_large", "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(invalid("json"));
      }
    });
    req.on("error", reject);
  });
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function targetOf(body) {
  const t = body?.target;
  if (!isObject(t) || !UUID.test(String(t.orgId)) || !UUID.test(String(t.agentId))) throw invalid("target");
  return { orgId: t.orgId, agentId: t.agentId };
}

/** A workspace-relative path (the contract's `SandboxRelativePath`); "" is the root unless `file` is set. */
function pathOf(value, { file = false } = {}) {
  if (typeof value !== "string" || value.length > 1024) throw invalid("path");
  if (value === "") {
    if (file) throw new OpError(422, "invalid_path", "a file path is required");
    return "";
  }
  if (value.startsWith("/") || value.includes("\\") || value.includes("\u0000")) {
    throw new OpError(422, "invalid_path", "invalid path");
  }
  for (const seg of value.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new OpError(422, "invalid_path", "invalid path");
  }
  return value;
}

const utf8Len = (s) => Buffer.byteLength(s, "utf8");

/** The last `max` bytes of `text`, cut on a character boundary. */
function tail(text, max = OUTPUT_TAIL_BYTES) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, cut: false };
  let start = bytes.length - max;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), cut: true };
}

/** Splits a shell line into commands joined by `&&` or `;` (quotes respected), each with its operator. */
function splitScript(script) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "&" && script[i + 1] === "&") {
      out.push({ text: cur, next: "&&" });
      cur = "";
      i += 1;
      continue;
    }
    if (ch === ";") {
      out.push({ text: cur, next: ";" });
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push({ text: cur, next: null });
  return out.filter((c) => c.text.trim().length > 0);
}

/** Words of one command (single and double quotes, no expansion). */
function words(text) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

export function createFakeSandboxd(opts = {}) {
  const token = opts.token ?? "fake-sandboxd-token-0123456789abcdef0123";
  const namespace = opts.namespace ?? "ocw-fake";
  let down = false;
  let bootId = randomUUID();
  /** `${org}/${agent}` → { target, state, startedAt, lastActiveAt, files: Map<path, {content, modifiedAt}>, dirs: Set } */
  let sandboxes = new Map();
  /** process id → { key, endsAt, exitCode, stdout, stderr, startedAt } */
  let processes = new Map();
  let events = [];
  let seq = 0;
  let policies = new Map();
  let waiters = [];
  let calls = {};
  let orgCalls = {};
  /** `${org}/${agent}` → the bot's `brw` state ("running" | "killed"). */
  let browsers = new Map();
  /** context id → the context (see `openContext`). */
  let contexts = new Map();
  /** frame subscribers to end on reset or close: Set<() => void>. */
  let streams = new Set();
  let leakNext = false;

  const keyOf = (t) => `${t.orgId}/${t.agentId}`;
  const now = () => new Date().toISOString();

  function count(op, orgId) {
    calls[op] = (calls[op] ?? 0) + 1;
    if (orgId) {
      orgCalls[orgId] ??= {};
      orgCalls[orgId][op] = (orgCalls[orgId][op] ?? 0) + 1;
    }
  }

  function boxOf(target, { create = false } = {}) {
    let box = sandboxes.get(keyOf(target));
    if (!box && create) {
      box = {
        target,
        state: "absent",
        startedAt: null,
        lastActiveAt: null,
        files: new Map(),
        dirs: new Set(),
      };
      sandboxes.set(keyOf(target), box);
    }
    return box ?? null;
  }

  function running(target) {
    const box = boxOf(target);
    if (!box || box.state === "absent") throw new OpError(404, "not_found", "no sandbox for this bot");
    if (box.state !== "running") throw new OpError(409, "killed", "the sandbox is stopped");
    return box;
  }

  const statusOf = (box) => ({
    target: box.target,
    state: box.state,
    runtime: box.state === "absent" ? null : "gvisor",
    diskBytes: diskOf(box),
    startedAt: box.startedAt,
    lastActiveAt: box.lastActiveAt,
  });

  function diskOf(box) {
    let n = 0;
    for (const f of box.files.values()) n += utf8Len(f.content);
    return n;
  }

  function pushEvent(ev) {
    seq += 1;
    events.push({ ...ev, seq, at: now() });
    if (events.length > 500) events = events.slice(-500);
    const ready = waiters;
    waiters = [];
    for (const w of ready) w();
  }

  // ---------------------------------------------------------------- workspace helpers

  function parentsOf(path) {
    const parts = path.split("/");
    const out = [];
    for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join("/"));
    return out;
  }

  function writeFile(box, path, content, mode) {
    if (box.dirs.has(path)) throw new OpError(422, "invalid_path", "a folder is there");
    const existing = box.files.get(path);
    if (mode === "create" && existing) throw new OpError(409, "exists", "the file exists");
    for (const dir of parentsOf(path)) {
      if (box.files.has(dir)) throw new OpError(422, "invalid_path", "a file is in the way");
      box.dirs.add(dir);
    }
    const next = mode === "append" && existing ? existing.content + content : content;
    box.files.set(path, { content: next, modifiedAt: now() });
    return utf8Len(next);
  }

  function entriesOf(box, dir) {
    const prefix = dir === "" ? "" : `${dir}/`;
    const names = new Map();
    for (const [p, f] of box.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes("/")) continue;
      names.set(rest, { kind: "file", size: utf8Len(f.content), modifiedAt: f.modifiedAt });
    }
    for (const d of box.dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest === "" || rest.includes("/")) continue;
      names.set(rest, { kind: "dir", size: null, modifiedAt: box.startedAt ?? now() });
    }
    return [...names]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, e]) => ({
        path: `${prefix}${name}`,
        name,
        kind: e.kind,
        size: e.size,
        modifiedAt: e.modifiedAt,
        hidden: name.startsWith("."),
      }));
  }

  function removePath(box, path, recursive) {
    if (box.files.delete(path)) return 1;
    if (!box.dirs.has(path)) throw new OpError(404, "not_found", "no such file or folder");
    const prefix = `${path}/`;
    const inside = [...box.files.keys()].filter((p) => p.startsWith(prefix));
    const dirs = [...box.dirs].filter((d) => d.startsWith(prefix));
    if (!recursive && inside.length + dirs.length > 0)
      throw new OpError(409, "busy", "the folder is not empty");
    for (const p of inside) box.files.delete(p);
    for (const d of dirs) box.dirs.delete(d);
    box.dirs.delete(path);
    return inside.length + dirs.length + 1;
  }

  // ---------------------------------------------------------------- the interpreter

  /** One command's words → { code, out, err, sleepMs }. */
  function runCommand(box, argv) {
    let redirect = null;
    const args = [];
    for (let i = 0; i < argv.length; i += 1) {
      const w = argv[i];
      if ((w === ">" || w === ">>") && i + 1 < argv.length) {
        redirect = { path: argv[i + 1], append: w === ">>" };
        i += 1;
        continue;
      }
      args.push(w);
    }
    const [prog, ...rest] = args;
    let result;
    switch (prog) {
      case "echo":
        result = { code: 0, out: `${rest.join(" ")}\n`, err: "" };
        break;
      case "true":
        result = { code: 0, out: "", err: "" };
        break;
      case "false":
        result = { code: 1, out: "", err: "" };
        break;
      case "cat": {
        let out = "";
        let err = "";
        let code = 0;
        for (const p of rest) {
          const f = box.files.get(p);
          if (f) out += f.content;
          else {
            err += `cat: ${p}: No such file or directory\n`;
            code = 1;
          }
        }
        result = { code, out, err };
        break;
      }
      case "ls": {
        const dir = rest.find((r) => !r.startsWith("-")) ?? "";
        if (dir !== "" && !box.dirs.has(dir)) {
          result = { code: 2, out: "", err: `ls: cannot access '${dir}': No such file or directory\n` };
          break;
        }
        const names = entriesOf(box, dir)
          .filter((e) => !e.hidden || rest.includes("-a"))
          .map((e) => e.name);
        result = { code: 0, out: names.length > 0 ? `${names.join("\n")}\n` : "", err: "" };
        break;
      }
      case "id":
        result =
          rest[0] === "-u"
            ? { code: 0, out: `${SANDBOX_USER_ID}\n`, err: "" }
            : { code: 0, out: `uid=${SANDBOX_USER_ID}(sandbox) gid=${SANDBOX_USER_ID}(sandbox)\n`, err: "" };
        break;
      case "env":
        result = { code: 0, out: `${ENV_LINES.join("\n")}\n`, err: "" };
        break;
      case "sleep": {
        const s = Number(rest[0] ?? "0");
        result = { code: 0, out: "", err: "", sleepMs: Number.isFinite(s) && s > 0 ? s * 1000 : 0 };
        break;
      }
      case "exit": {
        const n = Number.parseInt(rest[0] ?? "0", 10);
        result = { code: Number.isFinite(n) ? n & 255 : 2, out: "", err: "", exit: true };
        break;
      }
      default:
        result = { code: 127, out: "", err: `sh: ${prog}: not found\n` };
    }
    if (redirect) {
      try {
        const path = pathOf(redirect.path, { file: true });
        writeFile(box, path, result.out, redirect.append ? "append" : "overwrite");
        result.out = "";
      } catch {
        result = { code: 1, out: "", err: `sh: cannot create ${redirect.path}\n` };
      }
    }
    return result;
  }

  function interpret(box, argv) {
    const lines =
      argv[0] === "sh" && argv[1] === "-c"
        ? splitScript(argv[2] ?? "").map((c) => ({ argv: words(c.text), next: c.next }))
        : [{ argv, next: null }];
    let out = "";
    let err = "";
    let code = 0;
    let sleepMs = 0;
    for (const line of lines) {
      if (line.argv.length === 0) continue;
      const r = runCommand(box, line.argv);
      out += r.out;
      err += r.err;
      code = r.code;
      sleepMs += r.sleepMs ?? 0;
      if (r.exit) break;
      if (line.next === "&&" && code !== 0) break;
    }
    return { code, out, err, sleepMs };
  }

  // ---------------------------------------------------------------- browser (07.8-08)

  function contextOf(body) {
    const target = targetOf(body);
    if (!UUID.test(String(body.contextId))) throw invalid("contextId");
    const ctx = contexts.get(body.contextId);
    // Another bot's context is no context: the owner labels must match, as in the real broker.
    if (!ctx || keyOf(ctx.target) !== keyOf(target)) {
      throw new OpError(404, "no_context", "no such browser context");
    }
    return ctx;
  }

  /** A bot operation on the page (not the person's takeover input). */
  function botContext(body) {
    const ctx = contextOf(body);
    if (ctx.takeover) throw new OpError(409, "paused", "a person is in control of this browser");
    return ctx;
  }

  const browserEvent = (ctx, event, extra = {}) =>
    pushEvent({ type: "browser", target: ctx.target, contextId: ctx.id, event, ...extra });

  /** The page the fake site shows at the context's location. */
  function pageOf(ctx) {
    if (!ctx.host) return { title: "", nodes: [], text: "" };
    if (ctx.host === EXPORT_HOST) {
      return {
        title: "Collected",
        nodes: [{ ref: "r1", role: "heading", name: "Collected", value: null, redacted: false, depth: 0 }],
        text: "Collected",
      };
    }
    if (ctx.signedIn) {
      return {
        title: `Dashboard — signed in at ${ctx.host}`,
        nodes: [
          { ref: "r1", role: "heading", name: "Dashboard", value: null, redacted: false, depth: 0 },
          { ref: "r2", role: "button", name: "Sign out", value: null, redacted: false, depth: 1 },
          { ref: "export-link", role: "link", name: "Export", value: null, redacted: false, depth: 1 },
          {
            ref: "download-link",
            role: "link",
            name: "Download report",
            value: null,
            redacted: false,
            depth: 1,
          },
        ],
        text: "Dashboard\nSign out\nExport\nDownload report",
      };
    }
    return {
      title: `Sign in — ${ctx.host}`,
      nodes: [
        { ref: "r1", role: "heading", name: "Sign in", value: null, redacted: false, depth: 0 },
        { ref: "r2", role: "textbox", name: "Email", value: "", redacted: false, depth: 1 },
        { ref: "r3", role: "textbox", name: "Password", value: REDACTED, redacted: true, depth: 1 },
        { ref: "r4", role: "button", name: "Sign in", value: null, redacted: false, depth: 1 },
        { ref: "export-link", role: "link", name: "Export", value: null, redacted: false, depth: 1 },
        {
          ref: "download-link",
          role: "link",
          name: "Download report",
          value: null,
          redacted: false,
          depth: 1,
        },
      ],
      text: "Sign in\nEmail\nPassword [redacted]\nSign in\nExport\nDownload report",
    };
  }

  /**
   * Moves the context to `host` unless its site lock forbids it: a navigation to another host is blocked (the page
   * stays) and reported, except for the one op that carries `allowCrossSite` (D-13, P-18).
   */
  function go(ctx, host, allowCrossSite) {
    if (ctx.siteLock && host !== ctx.siteLock && allowCrossSite !== true) return { host };
    ctx.host = host;
    ctx.navigations += 1;
    browserEvent(ctx, "navigated", { host });
    return null;
  }

  function addDownload(ctx) {
    const token = randomBytes(18).toString("base64url");
    const ref = { name: "report.csv", size: DOWNLOAD_BYTES.length, token };
    ctx.downloads.set(token, ref);
    browserEvent(ctx, "download", { download: ref });
    return ref;
  }

  function closeContext(ctx, emit = true) {
    contexts.delete(ctx.id);
    for (const end of ctx.subscribers) end();
    if (emit) browserEvent(ctx, "closed");
  }

  function storageStateOf(ctx) {
    const host = ctx.siteLock ?? ctx.host;
    const cookies =
      ctx.signedIn && host
        ? [
            {
              name: "fake_session",
              value: "fake-signed-in",
              domain: host.split(":")[0],
              path: "/",
              expires: -1,
            },
          ]
        : [];
    return JSON.stringify({ cookies, origins: [] });
  }

  async function frames(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    const ctx = contextOf({ target: { orgId: q.orgId, agentId: q.agentId }, contextId: q.contextId });
    const fixtures = await frameFixtures();
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    const control = (msg) => res.write(encodeFrame(1, Buffer.from(JSON.stringify(msg), "utf8")));
    control({ kind: "size", width: ctx.viewport.width, height: ctx.viewport.height });
    const fixture = () =>
      ctx.signedIn
        ? fixtures["signed-in"]
        : ctx.takeover && Object.keys(ctx.inputs).length > 0
          ? fixtures.typing
          : ctx.host
            ? fixtures["login-form"]
            : fixtures["logged-out"];
    let ended = false;
    const timer = setInterval(() => {
      // Drop-on-slow, like the real screencast: skip a frame while the socket is still busy.
      if (!res.writableNeedDrain) res.write(encodeFrame(0, fixture()));
    }, FRAME_INTERVAL_MS);
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      ctx.subscribers.delete(end);
      streams.delete(end);
      if (!res.writableEnded) {
        if (!contexts.has(ctx.id)) control({ kind: "closed" });
        res.end();
      }
    };
    ctx.subscribers.add(end);
    streams.add(end);
    req.on("close", end);
    res.on("close", end);
    res.write(encodeFrame(0, fixture()));
  }

  // ---------------------------------------------------------------- ops

  const execResult = (r, started, extra) => {
    const o = tail(r.out);
    const e = tail(r.err);
    return {
      ...extra,
      stdout: o.text,
      stderr: e.text,
      truncated: o.cut || e.cut,
      durationMs: Math.max(0, Date.now() - started),
    };
  };

  function exec(body) {
    const target = targetOf(body);
    if (!Array.isArray(body.argv) || body.argv.length === 0 || body.argv.length > 64) throw invalid("argv");
    if (!body.argv.every((a) => typeof a === "string" && a.length <= 8192) || body.argv[0] === "") {
      throw invalid("argv");
    }
    if ("env" in body) throw invalid("env");
    if (body.cwd !== undefined) pathOf(body.cwd);
    const yieldMs = Number.isInteger(body.yieldMs) ? body.yieldMs : 25_000;
    const box = running(target);
    const started = Date.now();
    box.lastActiveAt = now();
    const r = interpret(box, body.argv);
    if (r.sleepMs > yieldMs) {
      const processId = randomUUID().replaceAll("-", "").slice(0, 24);
      processes.set(processId, { key: keyOf(target), endsAt: started + r.sleepMs, result: r, started });
      return execResult({ code: 0, out: "", err: "" }, started, { status: "running", processId });
    }
    return execResult(r, started, { status: "exited", exitCode: r.code });
  }

  function processOp(body) {
    const target = targetOf(body);
    const p = processes.get(body.processId);
    if (!p || p.key !== keyOf(target)) throw new OpError(404, "not_found", "no such process");
    if (body.action === "kill") {
      processes.delete(body.processId);
      return execResult({ code: 137, out: "", err: "" }, p.started, { status: "exited", exitCode: 137 });
    }
    if (Date.now() < p.endsAt) {
      return execResult({ code: 0, out: "", err: "" }, p.started, {
        status: "running",
        processId: body.processId,
      });
    }
    processes.delete(body.processId);
    return execResult(p.result, p.started, { status: "exited", exitCode: p.result.code });
  }

  function setState(target, state, reason) {
    const box = boxOf(target);
    if (!box) return null;
    box.state = state;
    pushEvent({ type: "state", target, kind: "sbx", state, reason: reason ?? null });
    return box;
  }

  async function dispatch(op, body, url) {
    switch (op) {
      case "info":
        return {
          version: "fake-0.1.0",
          namespace,
          dockerVersion: "29.8.2",
          dockerOk: true,
          runtimes: ["runc", "runsc"],
          runtime: "gvisor",
          browserSandbox: null,
        };
      case "ensure": {
        const target = targetOf(body);
        const box = boxOf(target, { create: true });
        if (box.state !== "running") {
          box.state = "running";
          box.startedAt = now();
          pushEvent({ type: "state", target, kind: "sbx", state: "running", reason: null });
        }
        box.lastActiveAt = now();
        return statusOf(box);
      }
      case "exec":
        return exec(body);
      case "process":
        return processOp(body);
      case "stop": {
        const target = targetOf(body);
        const box = running(target);
        setState(target, "stopped", body.reason ?? "user");
        return statusOf(box);
      }
      case "restart": {
        const target = targetOf(body);
        const box = boxOf(target, { create: true });
        box.state = "running";
        box.startedAt = now();
        return statusOf(box);
      }
      case "kill": {
        const target = targetOf(body);
        const box = boxOf(target);
        if (box?.state !== "running") return { removed: 0 };
        setState(target, "killed", "kill_switch");
        return { removed: 1 };
      }
      case "killOrg": {
        if (!UUID.test(String(body.orgId))) throw invalid("orgId");
        let removed = 0;
        for (const box of sandboxes.values()) {
          if (box.target.orgId !== body.orgId || box.state !== "running") continue;
          setState(box.target, "killed", "kill_switch");
          removed += 1;
        }
        // The organization's browsers stop too: every context closes.
        for (const [key, state] of browsers) {
          if (!key.startsWith(`${body.orgId}/`) || state !== "running") continue;
          browsers.set(key, "killed");
          removed += 1;
        }
        for (const ctx of [...contexts.values()]) if (ctx.target.orgId === body.orgId) closeContext(ctx);
        return { removed };
      }
      case "purge": {
        const target = targetOf(body);
        const existed = sandboxes.delete(keyOf(target));
        return { removed: existed ? 1 : 0 };
      }
      case "usage": {
        if (!UUID.test(String(body.orgId))) throw invalid("orgId");
        const items = [...sandboxes.values()]
          .filter((b) => b.target.orgId === body.orgId)
          .map((b) => ({
            agentId: b.target.agentId,
            kind: "sbx",
            state: b.state,
            diskBytes: diskOf(b),
            cpuMs: 0,
          }));
        return {
          orgId: body.orgId,
          running: {
            sandboxes: items.filter((i) => i.state === "running").length,
            browsers: [...browsers].filter(([k, st]) => k.startsWith(`${body.orgId}/`) && st === "running")
              .length,
          },
          items,
        };
      }
      case "policy": {
        if (!UUID.test(String(body.orgId))) throw invalid("orgId");
        policies.set(body.orgId, { killed: body.killed === true });
        return { ok: true };
      }
      case "filesList": {
        const box = boxOf(targetOf(body)) ?? null;
        const path = pathOf(body.path ?? "");
        if (!box) throw new OpError(404, "not_found", "no sandbox for this bot");
        if (path !== "" && !box.dirs.has(path)) throw new OpError(404, "not_found", "no such folder");
        const all = entriesOf(box, path).filter((e) => body.hidden !== false || !e.hidden);
        return { path, entries: all.slice(0, 500), more: Math.max(0, all.length - 500) };
      }
      case "filesStat": {
        const box = boxOf(targetOf(body));
        const path = pathOf(body.path, { file: true });
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const entry = box ? entriesOf(box, dir).find((e) => e.path === path) : undefined;
        if (!entry) throw new OpError(404, "not_found", "no such file");
        return entry;
      }
      case "filesRead": {
        const box = boxOf(targetOf(body));
        const path = pathOf(body.path, { file: true });
        const f = box?.files.get(path);
        if (!f) throw new OpError(404, "not_found", "no such file");
        const bytes = Buffer.from(f.content, "utf8");
        const offset = Number.isInteger(body.offset) ? body.offset : 0;
        const limit = Number.isInteger(body.limit) ? body.limit : 262_144;
        const slice = bytes.subarray(offset, offset + limit);
        return {
          path,
          content: slice.toString("utf8"),
          encoding: "utf8",
          size: bytes.length,
          truncated: offset + limit < bytes.length,
        };
      }
      case "filesWrite": {
        const box = boxOf(targetOf(body), { create: true });
        const path = pathOf(body.path, { file: true });
        if (typeof body.content !== "string") throw invalid("content");
        const content =
          body.encoding === "base64" ? Buffer.from(body.content, "base64").toString("utf8") : body.content;
        const size = writeFile(box, path, content, body.mode ?? "overwrite");
        return { path, size };
      }
      case "filesDelete": {
        const box = boxOf(targetOf(body));
        const path = pathOf(body.path, { file: true });
        if (!box) throw new OpError(404, "not_found", "no such file or folder");
        return { path, deleted: removePath(box, path, body.recursive === true) };
      }
      case "filesUpload":
      case "filesImport": {
        const box = boxOf(targetOf(body), { create: true });
        const path = pathOf(body.path, { file: true });
        if (typeof body.data !== "string") throw invalid("data");
        if (box.files.has(path) && body.overwrite !== true)
          throw new OpError(409, "exists", "the file exists");
        const size = writeFile(box, path, Buffer.from(body.data, "base64").toString("utf8"), "overwrite");
        return { path, size };
      }
      case "filesDownload": {
        const box = boxOf(targetOf(body));
        const path = pathOf(body.path, { file: true });
        const f = box?.files.get(path);
        if (!f) throw new OpError(404, "not_found", "no such file");
        return {
          path,
          name: path.split("/").at(-1),
          size: utf8Len(f.content),
          data: Buffer.from(f.content, "utf8").toString("base64"),
        };
      }
      case "browserEnsure": {
        const target = targetOf(body);
        browsers.set(keyOf(target), "running");
        return { target, state: "running", runtime: "gvisor", browserSandbox: "chromium+gvisor" };
      }
      case "contextOpen": {
        const target = targetOf(body);
        if (browsers.get(keyOf(target)) !== "running")
          throw new OpError(404, "not_found", "no browser for this bot");
        if (!UUID.test(String(body.contextId))) throw invalid("contextId");
        if (contexts.has(body.contextId)) throw new OpError(409, "exists", "the browser context exists");
        const v = body.viewport;
        if (!isObject(v) || !Number.isInteger(v.width) || !Number.isInteger(v.height))
          throw invalid("viewport");
        if (body.siteLock !== undefined && hostOfUrl(`https://${body.siteLock}/`) !== body.siteLock) {
          throw invalid("siteLock");
        }
        let signedIn = false;
        if (body.storageState !== undefined) {
          let state;
          try {
            state = JSON.parse(String(body.storageState));
          } catch {
            throw invalid("storageState");
          }
          if (!isObject(state)) throw invalid("storageState");
          signedIn = Array.isArray(state.cookies) && state.cookies.some((c) => c?.name === "fake_session");
        }
        contexts.set(body.contextId, {
          id: body.contextId,
          target,
          host: null,
          signedIn,
          siteLock: body.siteLock ?? null,
          memberId: body.memberId ?? null,
          viewport: { width: v.width, height: v.height },
          takeover: false,
          held: false,
          navigations: 0,
          inputs: {},
          downloads: new Map(),
          subscribers: new Set(),
        });
        return { contextId: body.contextId };
      }
      case "contextNavigate": {
        const ctx = botContext(body);
        const host = hostOfUrl(body.url);
        if (!host) throw invalid("url");
        const blocked = go(ctx, host, body.allowCrossSite);
        const page = pageOf(ctx);
        return { host: ctx.host ?? host, secure: true, title: page.title, blockedNavigation: blocked };
      }
      case "contextSnapshot": {
        const ctx = botContext(body);
        const page = pageOf(ctx);
        let nodes = page.nodes.map((n) => ({ ...n }));
        if (leakNext) {
          // The leak control (one shot): a redacted node that carries a value, which the API's second pass must refuse.
          leakNext = false;
          nodes = nodes.map((n) => (n.redacted ? { ...n, value: LEAK_SENTINEL } : n));
          if (!nodes.some((n) => n.redacted)) {
            nodes.push({
              ref: "leak",
              role: "textbox",
              name: "Password",
              value: LEAK_SENTINEL,
              redacted: true,
              depth: 1,
            });
          }
        }
        return {
          host: ctx.host ?? "about:blank",
          title: page.title,
          nodes,
          text: page.text,
          truncated: false,
        };
      }
      case "contextAct": {
        const ctx = botContext(body);
        if (!["click", "type", "select", "press", "scroll"].includes(body.action)) throw invalid("action");
        const needsRef = body.action !== "press" && body.action !== "scroll";
        if (needsRef || body.ref !== undefined) {
          if (!pageOf(ctx).nodes.some((n) => n.ref === body.ref)) {
            throw new OpError(409, "element_gone", "the element is gone; take a new snapshot");
          }
        }
        if (body.action === "click" && body.ref === "export-link") {
          const blocked = go(ctx, EXPORT_HOST, body.allowCrossSite);
          return { navigated: blocked === null, blockedNavigation: blocked, download: null };
        }
        if (body.action === "click" && body.ref === "download-link") {
          return { navigated: false, blockedNavigation: null, download: addDownload(ctx) };
        }
        // Typed text is never kept: an action changes nothing the fake reports.
        return { navigated: false, blockedNavigation: null, download: null };
      }
      case "contextScreenshot": {
        const ctx = botContext(body);
        const fixtures = await frameFixtures();
        const jpeg = ctx.signedIn
          ? fixtures["signed-in"]
          : ctx.host
            ? fixtures["login-form"]
            : fixtures["logged-out"];
        return {
          mimeType: "image/jpeg",
          data: jpeg.toString("base64"),
          width: ctx.viewport.width,
          height: ctx.viewport.height,
          masked: pageOf(ctx).nodes.filter((n) => n.redacted).length,
        };
      }
      case "contextWait": {
        const ctx = botContext(body);
        // Text waits match the redacted page text only, so they are no oracle for a typed value (as the agent).
        const ok =
          body.for === "text" ? typeof body.text === "string" && pageOf(ctx).text.includes(body.text) : true;
        return { ok, host: ctx.host ?? "about:blank" };
      }
      case "contextExportState":
        return { storageState: storageStateOf(contextOf(body)) };
      case "contextClose":
        closeContext(contextOf(body));
        return { closed: true };
      case "contextHold": {
        const ctx = contextOf(body);
        ctx.held = body.hold === true;
        return { held: ctx.held };
      }
      case "contextTakeover": {
        const ctx = contextOf(body);
        ctx.takeover = body.active === true;
        return { active: ctx.takeover };
      }
      case "contextResize": {
        const ctx = contextOf(body);
        if (!Number.isInteger(body.width) || !Number.isInteger(body.height)) throw invalid("size");
        ctx.viewport = { width: body.width, height: body.height };
        return { ok: true };
      }
      case "contextInput": {
        const ctx = contextOf(body);
        if (!ctx.takeover) throw invalid("input: no takeover is active");
        const list = body.events;
        if (!Array.isArray(list) || list.length < 1 || list.length > 64) throw invalid("events");
        // Counted by type and dropped at once: the payload is never kept, logged or counted.
        for (const ev of list) {
          const type = isObject(ev) && typeof ev.type === "string" ? ev.type.slice(0, 32) : "unknown";
          ctx.inputs[type] = (ctx.inputs[type] ?? 0) + 1;
        }
        return { accepted: list.length };
      }
      case "contextDownload": {
        const ctx = contextOf(body);
        const ref = ctx.downloads.get(body.token);
        if (!ref) throw new OpError(404, "not_found", "no such download");
        ctx.downloads.delete(body.token);
        return {
          name: ref.name,
          size: ref.size,
          mimeType: "text/csv",
          data: DOWNLOAD_BYTES.toString("base64"),
        };
      }
      case "events": {
        const after = Number(url.searchParams.get("after") ?? "0");
        const waitMs = Math.min(30_000, Math.max(0, Number(url.searchParams.get("waitMs") ?? "25000")));
        const pending = () => events.filter((e) => e.seq > after);
        if (pending().length === 0 && waitMs > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            waiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        const list = pending().slice(0, 500);
        return { bootId, events: list, nextSeq: list.at(-1)?.seq ?? after };
      }
      default:
        throw new OpError(404, "not_found", "unknown op");
    }
  }

  function authorized(req) {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "", "utf8");
    const want = Buffer.from(token, "utf8");
    return given.length === want.length && timingSafeEqual(given, want);
  }

  async function control(req, res, url) {
    switch (`${req.method} ${url.pathname}`) {
      case "POST /__control/down":
        down = true;
        return send(res, 200, { ok: true });
      case "POST /__control/up":
        down = false;
        return send(res, 200, { ok: true });
      case "POST /__control/reset":
        api.reset();
        return send(res, 200, { ok: true });
      case "POST /__control/emit": {
        const body = await readJson(req);
        if (!isObject(body) || typeof body.type !== "string") return send(res, 400, { error: "event" });
        pushEvent(body);
        return send(res, 200, { ok: true, seq });
      }
      case "GET /__control/stats":
        return send(res, 200, api.stats());
      case "POST /__control/browser/leak":
        leakNext = true;
        return send(res, 200, { ok: true });
      case "POST /__control/browser/signed-in": {
        const body = await readJson(req);
        const ctx = contexts.get(body?.contextId);
        if (!ctx) return send(res, 404, { error: "no such context" });
        ctx.signedIn = true;
        return send(res, 200, { ok: true });
      }
      case "POST /__control/browser/event": {
        const body = await readJson(req);
        const ctx = contexts.get(body?.contextId);
        if (!ctx || !BROWSER_EVENTS.has(body.event)) return send(res, 400, { error: "event" });
        if (body.event === "download") {
          addDownload(ctx);
        } else if (body.event === "closed") {
          closeContext(ctx);
        } else {
          browserEvent(ctx, body.event, body.event === "crashed" ? {} : { host: ctx.host ?? undefined });
        }
        return send(res, 200, { ok: true, seq });
      }
      default:
        return send(res, 404, { error: "unknown control" });
    }
  }

  /** The node:http handler; answers every request (404 for anything it does not serve). */
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://sandboxd");
    try {
      if (url.pathname.startsWith("/__control/")) return await control(req, res, url);
      const op = OPS[`${req.method} ${url.pathname}`];
      if (!authorized(req)) {
        req.resume();
        return send(res, 401, { error: { code: "unauthorized", message: "missing or invalid token" } });
      }
      if (!op) {
        req.resume();
        return send(res, 404, { error: { code: "not_found", message: "unknown op" } });
      }
      const body = req.method === "POST" ? await readJson(req) : {};
      if (down) return send(res, 503, { error: { code: "docker_unavailable", message: "docker is down" } });
      if (op === "contextFrames") {
        count(op, url.searchParams.get("orgId"));
        return await frames(req, res, url);
      }
      const orgId = isObject(body?.target)
        ? body.target.orgId
        : typeof body?.orgId === "string"
          ? body.orgId
          : null;
      count(op, orgId);
      if (req.method === "POST" && !isObject(body)) throw invalid("body");
      return send(res, 200, await dispatch(op, body, url));
    } catch (err) {
      if (err instanceof OpError) {
        return send(res, err.status, { error: { code: err.code, message: err.message } });
      }
      return send(res, 500, { error: { code: "docker_unavailable", message: "fake failure" } });
    }
  }

  const api = {
    handle,
    token,
    /** Call counts per op and per organization (never bodies). */
    stats() {
      return {
        calls: { ...calls },
        orgs: structuredClone(orgCalls),
        down,
        // Per context: ids, host, flags and input counts by event type; never a value, a URL path or a payload.
        browser: {
          contexts: [...contexts.values()].map((c) => ({
            contextId: c.id,
            agentId: c.target.agentId,
            host: c.host,
            signedIn: c.signedIn,
            siteLock: c.siteLock,
            takeover: c.takeover,
            held: c.held,
            viewers: c.subscribers.size,
            inputs: { ...c.inputs },
          })),
        },
      };
    },
    setDown(value) {
      down = value === true;
    },
    reset() {
      down = false;
      bootId = randomUUID();
      sandboxes = new Map();
      processes = new Map();
      events = [];
      seq = 0;
      policies = new Map();
      calls = {};
      orgCalls = {};
      for (const end of [...streams]) end();
      browsers = new Map();
      contexts = new Map();
      streams = new Set();
      leakNext = false;
      const ready = waiters;
      waiters = [];
      for (const w of ready) w();
    },
    emit(event) {
      pushEvent(event);
      return seq;
    },
    /** A bot's sandbox state as the fake holds it ("absent" when never ensured). */
    stateOf(target) {
      return boxOf(target)?.state ?? "absent";
    },
    /** The organization policy last pushed (`killed` only). */
    policyOf(orgId) {
      return policies.get(orgId) ?? null;
    },
  };
  return api;
}
