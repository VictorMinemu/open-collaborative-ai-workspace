// The bot browser agent (07.8-07, D-05, D-06, D-07, D-08, D-11, D-13, D-14, P-07, P-09, P-10, P-18).
//
// One process per `brw` container, spoken to only by sandboxd over stdio:
//   stdin   JSON lines `{ id, op, ...input }` (the sandboxd browser op input; `target` is ignored).
//   stdout  frames: 4-byte big-endian payload length, 1-byte type, payload.
//             type 0  one screencast JPEG: 1-byte context-id length, the context id (ASCII), the JPEG bytes;
//             type 1  one JSON message: a response `{ id, ok: true, result }` / `{ id, ok: false, error: { code,
//                     message } }`, or an event `{ event, contextId?, ... }` (ready, navigated host, download,
//                     blockedNavigation, focus, size, crashed, closed).
//   stderr  fixed diagnostic lines only: never a URL, page text, typed text or frame bytes.
//
// Chromium is launched by playwright-core over a pipe (Playwright's `--remote-debugging-pipe`): there is no debugging
// port, no listening socket and no host IPC. The caller never gets page script, DOM, HTML, cookies, storage, HAR or
// any evaluated value: a page is seen only through `serializeSnapshot` (redact.mjs) over the accessibility tree, and
// through screenshots with masked fields (capture.mjs). Facts the redaction needs (input type, autocomplete,
// -webkit-text-security, labels; never a value) and the human-typed marks are read in an isolated world
// (`WORLD`) that page scripts cannot see.
//
// Env: OCW_BROWSER_EXECUTABLE (Chromium path), OCW_BROWSER_PROXY (empty = no proxy), OCW_BROWSER_CHROMIUM_SANDBOX
// (on | off; off is refused under gVisor), OCW_BROWSER_RUNTIME (runsc | runc, from sandboxd; gVisor is also detected).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";
import { startScreencast } from "./capture.mjs";
import { serializeSnapshot } from "./redact.mjs";

// ---------------------------------------------------------------- limits (mirror BROWSER_LIMITS / SANDBOX_LIMITS)

const LIMITS = {
  fps: 8,
  small: { width: 960, height: 600 },
  expanded: { width: 1280, height: 800 },
  jpegQuality: 55,
  idleStopMs: 5 * 60_000,
  holdMs: 15 * 60_000,
  opTimeoutMs: 45_000,
  navigationTimeoutMs: 30_000,
  downloadMaxBytes: 52_428_800,
  stdinLineMaxBytes: 8 * 1024 * 1024,
  stdoutHighWaterBytes: 4 * 1024 * 1024,
  titleMax: 200,
  hostMax: 260,
  maxContexts: 8,
};
const DOWNLOAD_DIR = "/tmp/downloads";
const WORLD = "__ocw_agent_world";
const FRAME_JPEG = 0;
const FRAME_JSON = 1;

// ---------------------------------------------------------------- output framing

function writeFrame(type, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt8(type, 4);
  process.stdout.write(Buffer.concat([header, payload]));
}
const sendJson = (msg) => writeFrame(FRAME_JSON, Buffer.from(JSON.stringify(msg), "utf8"));
const emit = (event, fields = {}) => sendJson({ event, ...fields });
const diag = (line) => process.stderr.write(`ocw-brw: ${line}\n`);

function sendJpeg(contextId, jpeg) {
  // Drop on slow: a frame is never queued behind a reader that does not keep up.
  if (process.stdout.writableLength > LIMITS.stdoutHighWaterBytes) return;
  const id = Buffer.from(contextId, "ascii");
  writeFrame(FRAME_JPEG, Buffer.concat([Buffer.from([id.length]), id, jpeg]));
}

class OpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new OpError(code, message);
};

// ---------------------------------------------------------------- the isolated world

/*
 * Installed in every document of a context's page, in `WORLD` only. It marks the editable elements that receive a
 * trusted input event while a takeover is active (window capture listeners, registered before any page script), and
 * reads the DOM facts the redaction needs. It never reads an element's value.
 */
const worldScript = (active) => `(() => {
  if (globalThis.__ocw) { globalThis.__ocw.setActive(${active ? "true" : "false"}); return; }
  const marked = new Set();
  let active = ${active ? "true" : "false"};
  const editable = (el) => !!el && el.nodeType === 1 &&
    (el.localName === "input" || el.localName === "textarea" || el.localName === "select" || el.isContentEditable);
  const mark = (e) => {
    if (!active || !e.isTrusted) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (const el of [path[0], e.target]) if (editable(el)) marked.add(el);
  };
  for (const t of ["keydown", "beforeinput", "input", "change", "paste", "drop", "compositionend"]) {
    window.addEventListener(t, mark, true);
  }
  const collect = (root, out) => {
    for (const el of root.querySelectorAll("*")) {
      if (editable(el)) out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
    return out;
  };
  const text = (s) => (typeof s === "string" ? s.replace(/\\s+/g, " ").trim().slice(0, 200) : null);
  const facts = (el) => {
    const cs = getComputedStyle(el);
    const tag = el.localName;
    return {
      tag,
      type: tag === "input" ? String(el.type || "text").toLowerCase() : tag === "textarea" || tag === "select" ? tag : "contenteditable",
      autocomplete: el.getAttribute("autocomplete"),
      textSecurity: cs.getPropertyValue("-webkit-text-security") || "none",
      label: text(Array.from(el.labels || []).map((l) => l.textContent).join(" ")),
      attrName: el.getAttribute("name"),
      attrId: el.id || null,
      placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
    };
  };
  const focused = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return editable(el) ? el : null;
  };
  globalThis.__ocw = {
    setActive(v) { active = !!v; },
    fields() { return collect(document, []); },
    marked() { return Array.from(marked).filter((el) => el.isConnected); },
    factsOf(list) { return list.map(facts); },
    focusFacts() { const el = focused(); return el ? facts(el) : null; },
    anyMarked() { return marked.size > 0; },
  };
})();`;

async function worldContextId(ctx) {
  const { frameTree } = await ctx.cdp.send("Page.getFrameTree");
  const { executionContextId } = await ctx.cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: WORLD,
    grantUniveralAccess: false,
  });
  // The current document may predate the new-document script (or the world): install idempotently.
  await ctx.cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: worldScript(ctx.takeover),
  });
  return executionContextId;
}

async function setWorldScript(ctx) {
  if (ctx.worldScriptId) {
    await ctx.cdp
      .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: ctx.worldScriptId })
      .catch(() => {});
  }
  const { identifier } = await ctx.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: worldScript(ctx.takeover),
    worldName: WORLD,
  });
  ctx.worldScriptId = identifier;
}

/** backendNodeIds of the elements of an array object, then release the object group. */
async function backendIds(cdp, arrayObjectId) {
  const { result } = await cdp.send("Runtime.getProperties", {
    objectId: arrayObjectId,
    ownProperties: true,
  });
  const items = result
    .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
    .sort((a, b) => Number(a.name) - Number(b.name));
  const ids = [];
  for (const p of items) {
    const { node } = await cdp.send("DOM.describeNode", { objectId: p.value.objectId });
    ids.push(node.backendNodeId);
  }
  return ids;
}

/** `{ facts: Map<backendId, facts>, marks: Set<backendId> }` of the main frame's current document. */
async function readFieldState(ctx) {
  const contextId = await worldContextId(ctx);
  const cdp = ctx.cdp;
  const group = `ocw-${randomBytes(6).toString("hex")}`;
  try {
    const fields = await cdp.send("Runtime.evaluate", {
      contextId,
      expression: "__ocw.fields()",
      objectGroup: group,
    });
    const facts = new Map();
    if (fields.result?.objectId) {
      const ids = await backendIds(cdp, fields.result.objectId);
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId: fields.result.objectId,
        functionDeclaration: "function () { return __ocw.factsOf(this); }",
        returnByValue: true,
      });
      const list = Array.isArray(result?.value) ? result.value : [];
      ids.forEach((id, i) => {
        if (list[i]) facts.set(id, list[i]);
      });
    }
    const marked = await cdp.send("Runtime.evaluate", {
      contextId,
      expression: "__ocw.marked()",
      objectGroup: group,
    });
    const marks = new Set(marked.result?.objectId ? await backendIds(cdp, marked.result.objectId) : []);
    return { facts, marks, contextId };
  } finally {
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
  }
}

// ---------------------------------------------------------------- browser

const runtime =
  process.env.OCW_BROWSER_RUNTIME === "runsc" || /gvisor/i.test(os.release()) ? "runsc" : "runc";
let browser = null;
let browserSandbox = null;
const contexts = new Map();

function launchOptions(sandbox) {
  const proxy = (process.env.OCW_BROWSER_PROXY ?? "").trim();
  return {
    executablePath: process.env.OCW_BROWSER_EXECUTABLE || undefined,
    headless: true,
    chromiumSandbox: sandbox,
    timeout: 60_000,
    // Playwright's defaults already add --password-store=basic, --use-mock-keychain and --disable-sync; the headless
    // shell has no password manager or autofill component, and every context is an ephemeral in-memory profile.
    args: [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-crash-reporter",
      "--no-pings",
    ],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  };
}

async function launch() {
  const want = (process.env.OCW_BROWSER_CHROMIUM_SANDBOX ?? "on").trim().toLowerCase() !== "off";
  if (!want && runtime === "runsc") fail("sandbox_required", "Chromium's sandbox stays on under gVisor");
  try {
    browser = await chromium.launch(launchOptions(want));
    browserSandbox = want ? (runtime === "runsc" ? "chromium+gvisor" : "chromium") : "container-only";
  } catch (err) {
    // D-14: only on hardened runc, only when Chromium itself says it has no usable sandbox (a host that restricts
    // unprivileged user namespaces). Never under gVisor, never silently: the posture is reported as container-only.
    const noSandbox = /No usable sandbox/.test(String(err?.message ?? ""));
    if (!want || runtime === "runsc" || !noSandbox) throw err;
    diag("chromium sandbox unavailable on runc; running container-only");
    browser = await chromium.launch(launchOptions(false));
    browserSandbox = "container-only";
  }
  browser.on("disconnected", () => {
    emit("crashed", { scope: "browser" });
    process.exit(3);
  });
}

// ---------------------------------------------------------------- contexts

const hostOf = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:") return new URL(u.pathname).host || null;
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
};
const clip = (s, max) => String(s ?? "").slice(0, max);

function getContext(input) {
  const ctx = contexts.get(input.contextId);
  if (!ctx) fail("no_context", "no such browser context");
  ctx.lastUsed = Date.now();
  return ctx;
}

const notPaused = (ctx) => {
  if (ctx.takeover) fail("paused", "a person is in control of this browser");
};

/** Run `fn` after every earlier op of the same context (ops on one page never interleave). */
function serialize(ctx, fn) {
  const run = ctx.queue.then(fn, fn);
  ctx.queue = run.catch(() => {});
  return run;
}

async function pageState(ctx) {
  const url = ctx.page.url();
  const title = clip(await ctx.page.title().catch(() => ""), LIMITS.titleMax);
  return {
    host: clip(hostOf(url) ?? "about:blank", LIMITS.hostMax),
    secure: url.startsWith("https:"),
    title,
  };
}

function attachPage(ctx) {
  const page = ctx.page;
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    ctx.navCount += 1;
    const url = frame.url();
    const host = hostOf(url);
    if (host)
      emit("navigated", {
        contextId: ctx.id,
        host: clip(host, LIMITS.hostMax),
        secure: url.startsWith("https:"),
      });
  });
  page.on("crash", () => emit("crashed", { contextId: ctx.id }));
  page.on("download", (download) => onDownload(ctx, download));
  ctx.context.on("request", (req) => {
    if (isMainNavigation(req, page)) ctx.pendingNav += 1;
  });
  const done = (req) => {
    if (isMainNavigation(req, page)) ctx.pendingNav = Math.max(0, ctx.pendingNav - 1);
  };
  ctx.context.on("requestfinished", done);
  ctx.context.on("requestfailed", done);
}

function isMainNavigation(req, page) {
  try {
    return req.isNavigationRequest() && req.frame() === page.mainFrame();
  } catch {
    return false;
  }
}

/** D-13 site lock: a top-level or pop-up navigation to another host is aborted (the page stays) and reported. */
async function onRoute(ctx, route) {
  const req = route.request();
  let topLevel = false;
  try {
    topLevel = req.isNavigationRequest() && req.frame().parentFrame() === null;
  } catch {
    topLevel = false;
  }
  if (!topLevel) return route.fallback();
  const host = hostOf(req.url());
  if (host === ctx.siteLock) return route.fallback();
  if (ctx.allowCrossSite && host) return route.fallback();
  const blocked = clip(host ?? "unknown", LIMITS.hostMax);
  ctx.opBlocked = { host: blocked };
  emit("blockedNavigation", { contextId: ctx.id, host: blocked });
  // net::ERR_ABORTED commits no error page: the current document stays.
  return route.abort("aborted");
}

/** Single-tab policy: a pop-up is never kept. An allowed one is opened in the context's page instead. */
async function onPopup(ctx, popup) {
  if (popup === ctx.page) return;
  await popup.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  const url = popup.url();
  await popup.close().catch(() => {});
  const host = hostOf(url);
  if (host && (!ctx.siteLock || host === ctx.siteLock)) {
    await ctx.page.goto(url, { timeout: LIMITS.navigationTimeoutMs }).catch(() => {});
  }
}

function parseStorageState(blob) {
  if (blob === undefined) return undefined;
  let state;
  try {
    state = JSON.parse(blob);
  } catch {
    fail("invalid_request", "storage state is not JSON");
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    fail("invalid_request", "storage state is not an object");
  }
  return {
    cookies: Array.isArray(state.cookies) ? state.cookies : [],
    origins: Array.isArray(state.origins) ? state.origins : [],
  };
}

async function contextOpen(input) {
  const id = String(input.contextId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail("invalid_request", "contextId is not a uuid");
  if (contexts.has(id)) fail("exists", "the browser context exists");
  if (contexts.size >= LIMITS.maxContexts) fail("limit_reached", "too many browser contexts");
  const siteLock = input.siteLock ? String(input.siteLock).toLowerCase() : null;
  const viewport = viewportOf(input.viewport);
  const storageState = parseStorageState(input.storageState);
  const context = await browser.newContext({
    viewport,
    storageState,
    acceptDownloads: true,
    // A service worker could answer a navigation outside request routing (and so outside the site lock).
    serviceWorkers: "block",
  });
  const ctx = {
    id,
    context,
    page: null,
    cdp: null,
    siteLock,
    signInHost: siteLock,
    memberId: input.memberId ?? null,
    viewport,
    mode: "small",
    takeover: false,
    allowCrossSite: false,
    opBlocked: null,
    opDownload: null,
    navCount: 0,
    pendingNav: 0,
    pendingDownloads: 0,
    downloads: new Map(),
    frames: null,
    worldScriptId: null,
    lastFocusSensitive: null,
    humanInput: false,
    holdUntil: 0,
    lastUsed: Date.now(),
    queue: Promise.resolve(),
  };
  try {
    if (siteLock) await context.route("**/*", (route) => onRoute(ctx, route));
    ctx.page = await context.newPage();
    ctx.cdp = await context.newCDPSession(ctx.page);
    await ctx.cdp.send("Page.enable");
    await setWorldScript(ctx);
    attachPage(ctx);
    context.on("page", (p) => onPopup(ctx, p));
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
  contexts.set(id, ctx);
  return { contextId: id, host: "about:blank" };
}

function viewportOf(v) {
  const width = Number(v?.width ?? LIMITS.small.width);
  const height = Number(v?.height ?? LIMITS.small.height);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 200 ||
    height < 200 ||
    width > 4096 ||
    height > 4096
  ) {
    fail("invalid_request", "viewport out of range");
  }
  return { width, height };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withCrossSite(ctx, allow, fn) {
  ctx.allowCrossSite = allow === true;
  ctx.opBlocked = null;
  ctx.opDownload = null;
  try {
    return await fn();
  } finally {
    ctx.allowCrossSite = false;
  }
}

async function contextNavigate(input) {
  const ctx = getContext(input);
  return serialize(ctx, async () => {
    notPaused(ctx);
    const url = String(input.url ?? "");
    const host = hostOf(url);
    if (!host || !/^https?:/i.test(url) || url.length > 2000) fail("invalid_request", "an http(s) URL");
    return withCrossSite(ctx, input.allowCrossSite, async () => {
      try {
        await ctx.page.goto(url, { waitUntil: "load", timeout: LIMITS.navigationTimeoutMs });
      } catch (err) {
        if (!ctx.opBlocked) {
          if (err?.name === "TimeoutError") fail("timeout", "the page did not load in time");
          fail("navigation_refused", "the page could not be loaded");
        }
      }
      ctx.signInHost ??= hostOf(ctx.page.url());
      const state = await pageState(ctx);
      return { ...state, blockedNavigation: ctx.opBlocked };
    });
  });
}

async function contextSnapshot(input) {
  const ctx = getContext(input);
  return serialize(ctx, async () => {
    notPaused(ctx);
    const { facts, marks } = await readFieldState(ctx);
    const { nodes } = await ctx.cdp.send("Accessibility.getFullAXTree");
    const snap = serializeSnapshot(nodes, marks, facts);
    const state = await pageState(ctx);
    ctx.refs = new Set(snap.nodes.map((n) => n.ref));
    return { host: state.host, title: state.title, ...snap };
  });
}

async function contextWait(input) {
  const ctx = getContext(input);
  return serialize(ctx, async () => {
    notPaused(ctx);
    const ms = Math.min(Math.max(Number(input.ms ?? 10_000) || 0, 0), 30_000);
    let ok = true;
    if (input.for === "time") await sleep(ms);
    else if (input.for === "load") {
      ok = await ctx.page.waitForLoadState("load", { timeout: ms || 1 }).then(
        () => true,
        () => false,
      );
    } else if (input.for === "text") {
      const text = String(input.text ?? "");
      if (text === "" || text.length > 200) fail("invalid_request", "a text of 1 to 200 characters");
      ok = await ctx.page
        .getByText(text)
        .first()
        .waitFor({ state: "visible", timeout: ms || 1 })
        .then(
          () => true,
          () => false,
        );
    } else fail("invalid_request", "wait for load, text or time");
    return { ok, host: (await pageState(ctx)).host };
  });
}

async function contextFrames(input) {
  const ctx = getContext(input);
  return serialize(ctx, async () => {
    const on = input.on !== false;
    if (on && !ctx.frames) await startFrames(ctx);
    if (!on && ctx.frames) await stopFrames(ctx);
    return { on: !!ctx.frames };
  });
}

async function startFrames(ctx) {
  const size = ctx.mode === "phone" ? ctx.viewport : ctx.mode === "expanded" ? LIMITS.expanded : LIMITS.small;
  let lastSize = "";
  ctx.frames = await startScreencast(
    ctx.cdp,
    { maxWidth: size.width, maxHeight: size.height, quality: LIMITS.jpegQuality, fps: LIMITS.fps },
    (jpeg, dims) => {
      const key = `${dims.width}x${dims.height}`;
      if (key !== lastSize) {
        lastSize = key;
        emit("size", { contextId: ctx.id, width: dims.width, height: dims.height });
      }
      sendJpeg(ctx.id, jpeg);
    },
  );
}

async function stopFrames(ctx) {
  const stop = ctx.frames;
  ctx.frames = null;
  await stop?.();
}

async function closeContext(ctx, reason) {
  contexts.delete(ctx.id);
  await stopFrames(ctx).catch(() => {});
  await ctx.context.close().catch(() => {});
  for (const d of ctx.downloads.values()) rmSync(d.path, { force: true });
  emit("closed", { contextId: ctx.id, reason });
}

async function contextClose(input) {
  const ctx = contexts.get(input.contextId);
  if (!ctx) return { closed: false };
  await serialize(ctx, () => closeContext(ctx, "closed"));
  return { closed: true };
}

// ---------------------------------------------------------------- downloads (Task 3)

async function onDownload(ctx, download) {
  ctx.pendingDownloads += 1;
  try {
    const token = randomBytes(24).toString("base64url");
    const path = join(DOWNLOAD_DIR, token);
    await download.saveAs(path);
    const size = statSync(path).size;
    if (size > LIMITS.downloadMaxBytes) {
      rmSync(path, { force: true });
      emit("downloadRefused", { contextId: ctx.id, reason: "too_large" });
      return;
    }
    const name =
      clip(basename(download.suggestedFilename() || "download").replace(/\p{Cc}/gu, ""), 255) || "download";
    const ref = { name, size, token };
    ctx.downloads.set(token, { ...ref, path });
    ctx.opDownload = ref;
    emit("download", { contextId: ctx.id, ...ref });
  } catch {
    emit("downloadRefused", { contextId: ctx.id, reason: "failed" });
  } finally {
    ctx.pendingDownloads -= 1;
  }
}

// ---------------------------------------------------------------- dispatch

async function info() {
  return {
    browserSandbox,
    runtime,
    browserVersion: browser?.version() ?? null,
    contexts: contexts.size,
  };
}

const OPS = {
  info,
  contextOpen,
  contextNavigate,
  contextSnapshot,
  contextWait,
  contextFrames,
  contextClose,
};

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    sendJson({ id: null, ok: false, error: { code: "invalid_request", message: "not JSON" } });
    return;
  }
  const id = typeof msg?.id === "string" || typeof msg?.id === "number" ? msg.id : null;
  const fn = Object.hasOwn(OPS, msg?.op) ? OPS[msg.op] : null;
  if (!fn) {
    sendJson({ id, ok: false, error: { code: "invalid_request", message: "unknown op" } });
    return;
  }
  let timer;
  try {
    const result = await Promise.race([
      fn(msg),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new OpError("timeout", "the browser did not answer in time")),
          LIMITS.opTimeoutMs,
        );
      }),
    ]);
    sendJson({ id, ok: true, result });
  } catch (err) {
    if (err instanceof OpError) {
      sendJson({ id, ok: false, error: { code: err.code, message: err.message } });
    } else {
      // Never the error's message: it can quote a URL or page text.
      diag(`op ${msg.op} failed (${err?.name ?? "Error"})`);
      sendJson({ id, ok: false, error: { code: "internal", message: "the browser operation failed" } });
    }
  } finally {
    clearTimeout(timer);
  }
}

function readStdin() {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let nl = buf.indexOf(0x0a);
    while (nl >= 0) {
      const line = buf.subarray(0, nl).toString("utf8").trim();
      buf = buf.subarray(nl + 1);
      if (line) handle(line);
      nl = buf.indexOf(0x0a);
    }
    if (buf.length > LIMITS.stdinLineMaxBytes) {
      diag("input line too long; exiting");
      process.exit(2);
    }
  });
  process.stdin.on("end", () => shutdown(0));
}

function reapIdle() {
  const now = Date.now();
  for (const ctx of contexts.values()) {
    if (ctx.frames || ctx.takeover) continue;
    if (now < ctx.holdUntil) continue;
    if (now - ctx.lastUsed > LIMITS.idleStopMs) serialize(ctx, () => closeContext(ctx, "idle"));
  }
}

async function shutdown(code) {
  for (const ctx of contexts.values()) await closeContext(ctx, "shutdown").catch(() => {});
  await browser?.close().catch(() => {});
  process.exit(code);
}

// ---------------------------------------------------------------- main

if (process.argv.includes("--check")) {
  const exe = process.env.OCW_BROWSER_EXECUTABLE;
  if (!exe || !existsSync(exe) || (statSync(exe).mode & 0o111) === 0) {
    diag("Chromium is missing");
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  if (pkg.dependencies?.["playwright-core"] !== "1.63.0") process.exit(1);
  process.stdout.write("ok\n");
  process.exit(0);
}

mkdirSync(DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
process.on("SIGTERM", () => shutdown(0));
try {
  await launch();
} catch (err) {
  const code = err instanceof OpError ? err.code : "launch_failed";
  diag(`browser launch failed (${code})`);
  // At launch no page exists yet: Chromium's own fatal lines (sandbox, missing libraries) are safe and needed.
  for (const l of String(err?.message ?? "").split("\n")) {
    if (/FATAL|No usable sandbox|error while loading shared libraries/.test(l)) diag(l.trim().slice(0, 300));
  }
  emit("fatal", { code, runtime });
  process.exit(1);
}
emit("ready", { browserSandbox, runtime, browserVersion: browser.version() });
setInterval(reapIdle, 30_000).unref();
readStdin();
