// The in-memory sandboxd (Phase 07.8-05, P-13): every non-browser operation of `SANDBOXD_ROUTES`
// (packages/contracts/src/sandboxd-protocol.ts) over a per-bot workspace kept in memory, so the API's integration tests
// and the e2e harness (08) never need Docker. Dependency-free; every answer has the contract's shape (the API's client
// parses each one with the contract). It never logs or stores request bodies beyond the workspace itself, and its
// counters hold call counts per op and per organization only.
//
// The exec interpreter is deliberately tiny: `sh -c "<a> && <b>; <c>"`, `echo`, `cat`, `ls`, `id -u`, `env`,
// `sleep N`, `exit N`, `true`, `false`, and `>` / `>>` into the workspace. Anything else exits 127.
//
// Test controls (no token): POST /__control/down | /__control/up | /__control/reset | /__control/emit (an event body),
// GET /__control/stats.
import { randomUUID, timingSafeEqual } from "node:crypto";

const SANDBOX_USER_ID = 10001;
const OUTPUT_TAIL_BYTES = 16_384;
const MAX_BODY_BYTES = 80 * 1024 * 1024;
const ENV_LINES = ["HOME=/workspace", "PATH=/usr/local/bin:/usr/bin:/bin", "USER=sandbox", "PWD=/workspace"];

const BROWSER_OPS = new Set([
  "/v1/browsers/ensure",
  "/v1/browsers/contexts/open",
  "/v1/browsers/contexts/navigate",
  "/v1/browsers/contexts/snapshot",
  "/v1/browsers/contexts/act",
  "/v1/browsers/contexts/screenshot",
  "/v1/browsers/contexts/wait",
  "/v1/browsers/contexts/export-state",
  "/v1/browsers/contexts/close",
  "/v1/browsers/contexts/hold",
  "/v1/browsers/contexts/takeover",
  "/v1/browsers/contexts/resize",
  "/v1/browsers/contexts/frames",
  "/v1/browsers/contexts/input",
  "/v1/browsers/contexts/download",
]);

/** Route path → op name (the counters' keys); browser and package ops are not served yet (08, 18). */
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
};

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
          running: { sandboxes: items.filter((i) => i.state === "running").length, browsers: 0 },
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
      if (!op || BROWSER_OPS.has(url.pathname)) {
        req.resume();
        return send(res, 404, { error: { code: "not_found", message: "unknown op" } });
      }
      const body = req.method === "POST" ? await readJson(req) : {};
      if (down) return send(res, 503, { error: { code: "docker_unavailable", message: "docker is down" } });
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
      return { calls: { ...calls }, orgs: structuredClone(orgCalls), down };
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
