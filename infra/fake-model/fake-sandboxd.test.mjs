// node --test infra/fake-model/fake-sandboxd.test.mjs
// The in-memory sandboxd (07.8-05): the bearer token, the tiny exec interpreter over a per-bot workspace, bot
// isolation, the organization kill, the down switch and the call counters (never bodies). The API's integration tests
// run against this fake; the real broker is proven by the sandbox smokes (P-13).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakeSandboxd } from "./fake-sandboxd.mjs";

const TOKEN = "fake-sandboxd-token-0123456789abcdef0123";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const A = { orgId: ORG, agentId: randomUUID() };
const B = { orgId: ORG, agentId: randomUUID() };
const C = { orgId: OTHER_ORG, agentId: randomUUID() };

let fake;
let server;
let base;

before(async () => {
  fake = createFakeSandboxd({ token: TOKEN });
  server = createServer((req, res) => fake.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
const policy = (orgId, killed = false, version = 1) => ({
  orgId,
  sandboxEgress: "off",
  browserEgress: "off",
  allowHosts: [],
  privateHosts: [],
  limits: {
    nanoCpus: 1e9,
    memoryBytes: 1073741824,
    pids: 256,
    diskQuotaBytes: 2147483648,
    idleStopMs: 900000,
  },
  browserLimits: {
    nanoCpus: 1e9,
    memoryBytes: 2147483648,
    pids: 512,
    diskQuotaBytes: 2147483648,
    idleStopMs: 300000,
  },
  killed,
  version,
});

beforeEach(async () => {
  assert.equal((await fetch(`${base}/__control/reset`, { method: "POST" })).status, 200);
  // Like sandboxd, the fake has no default policy: the API pushes one before anything runs.
  for (const orgId of [ORG, OTHER_ORG]) assert.equal((await op("/v1/policy", policy(orgId))).status, 200);
});

async function op(path, body, token = TOKEN, method = "POST") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ensure = (target) => op("/v1/sandboxes/ensure", { target });
const exec = (target, argv, extra = {}) =>
  op("/v1/sandboxes/exec", { target, argv, cwd: "", timeoutMs: 60_000, yieldMs: 25_000, ...extra });
const stats = async () => (await fetch(`${base}/__control/stats`)).json();

describe("fake sandboxd", () => {
  it("refuses every op without the bearer token (401, no body echo)", async () => {
    const none = await op("/v1/sandboxes/exec", { target: A, argv: ["echo", "secret-argv"] }, null);
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, "unauthorized");
    assert.ok(!JSON.stringify(none.body).includes("secret-argv"));
    assert.equal((await op("/v1/info", undefined, "wrong-token", "GET")).status, 401);
  });

  it("info answers the contract shape", async () => {
    const r = await op("/v1/info", undefined, TOKEN, "GET");
    assert.equal(r.status, 200);
    assert.equal(r.body.dockerOk, true);
    assert.equal(r.body.runtime, "gvisor");
    assert.equal(typeof r.body.namespace, "string");
  });

  it("ensure, then a shell writes and reads a file in bot A's workspace", async () => {
    const e = await ensure(A);
    assert.equal(e.status, 200);
    assert.equal(e.body.state, "running");
    assert.deepEqual(e.body.target, A);
    const r = await exec(A, ["sh", "-c", "echo hi > note.txt && cat note.txt"]);
    assert.equal(r.status, 200);
    assert.deepEqual(
      { status: r.body.status, exitCode: r.body.exitCode, stdout: r.body.stdout, stderr: r.body.stderr },
      { status: "exited", exitCode: 0, stdout: "hi\n", stderr: "" },
    );
    assert.equal(r.body.truncated, false);
    assert.equal(typeof r.body.durationMs, "number");
  });

  it("bot B never sees bot A's file", async () => {
    await ensure(A);
    await exec(A, ["sh", "-c", "echo hi > note.txt"]);
    await ensure(B);
    const r = await exec(B, ["cat", "note.txt"]);
    assert.equal(r.status, 200);
    assert.equal(r.body.exitCode, 1);
    assert.match(r.body.stderr, /No such file/);
  });

  it("interprets id -u, env (no OCW_ variable), ls, append, exit N and an unknown program", async () => {
    await ensure(A);
    assert.equal((await exec(A, ["id", "-u"])).body.stdout, "10001\n");
    const env = (await exec(A, ["env"])).body.stdout;
    assert.match(env, /HOME=\/workspace/);
    assert.ok(!env.includes("OCW_"));
    await exec(A, ["sh", "-c", "echo a > f.txt; echo b >> f.txt"]);
    assert.equal((await exec(A, ["cat", "f.txt"])).body.stdout, "a\nb\n");
    assert.equal((await exec(A, ["ls"])).body.stdout, "f.txt\n");
    assert.equal((await exec(A, ["sh", "-c", "exit 3"])).body.exitCode, 3);
    const missing = await exec(A, ["nope"]);
    assert.equal(missing.body.exitCode, 127);
    // `&&` stops at the first failure.
    assert.equal((await exec(A, ["sh", "-c", "cat gone.txt && echo never"])).body.stdout, "");
  });

  it("a sleep longer than the yield returns a process id that a later poll finishes", async () => {
    await ensure(A);
    const r = await exec(A, ["sleep", "1"], { yieldMs: 0 });
    assert.equal(r.body.status, "running");
    assert.match(r.body.processId, /^[A-Za-z0-9_-]{1,64}$/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const polled = await op("/v1/sandboxes/process", {
      target: A,
      processId: r.body.processId,
      action: "poll",
    });
    assert.equal(polled.body.status, "exited");
    assert.equal(polled.body.exitCode, 0);
  });

  it("killOrg stops every sandbox of that organization only; exec then answers 409 killed until ensure", async () => {
    await ensure(A);
    await ensure(B);
    await ensure(C);
    const killed = await op("/v1/orgs/kill", { orgId: ORG });
    assert.equal(killed.status, 200);
    assert.equal(killed.body.removed, 2);
    const r = await exec(A, ["echo", "hi"]);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "killed");
    assert.equal((await exec(C, ["echo", "still"])).body.stdout, "still\n");
    await ensure(A);
    assert.equal((await exec(A, ["echo", "back"])).body.stdout, "back\n");
  });

  it("exec before any ensure answers 404 not_found", async () => {
    const r = await exec(A, ["echo", "hi"]);
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "not_found");
  });

  it("down: every op answers 503 docker_unavailable until up", async () => {
    await fetch(`${base}/__control/down`, { method: "POST" });
    assert.equal((await ensure(A)).status, 503);
    const info = await op("/v1/info", undefined, TOKEN, "GET");
    assert.equal(info.status, 503);
    assert.equal(info.body.error.code, "docker_unavailable");
    await fetch(`${base}/__control/up`, { method: "POST" });
    assert.equal((await ensure(A)).status, 200);
  });

  it("an unknown op is 404; a body failing the shape is 400", async () => {
    assert.equal((await op("/v1/nothing", {})).status, 404);
    const bad = await op("/v1/sandboxes/exec", { target: A, argv: "echo hi" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "invalid_request");
  });

  it("no policy → ensure, exec and writes answer 409 policy_missing; killed → killed; a stale push is ignored", async () => {
    await ensure(A);
    assert.equal((await fetch(`${base}/__control/reboot`, { method: "POST" })).status, 200);
    for (const r of [
      await ensure(A),
      await exec(A, ["echo", "hi"]),
      await op("/v1/files/write", {
        target: A,
        path: "a.txt",
        content: "x",
        encoding: "utf8",
        mode: "create",
      }),
    ]) {
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "policy_missing");
    }
    assert.equal((await op("/v1/files/list", { target: A, path: "" })).status, 200);
    assert.equal((await op("/v1/policy", policy(ORG, true, 2))).status, 200);
    assert.equal((await op("/v1/policy", policy(ORG, false, 1))).status, 200);
    assert.deepEqual(fake.policyOf(ORG), { killed: true });
    const refused = await ensure(A);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "killed");
    assert.equal((await op("/v1/policy", policy(ORG, false, 3))).status, 200);
    assert.equal((await ensure(A)).status, 200);
  });

  it("reboot: a new boot id and an empty feed; the sandboxes stay", async () => {
    await ensure(A);
    const first = (await op("/v1/events?after=0&waitMs=0", undefined, TOKEN, "GET")).body;
    assert.ok(first.events.length > 0);
    await fetch(`${base}/__control/reboot`, { method: "POST" });
    const next = (await op("/v1/events?after=0&waitMs=0", undefined, TOKEN, "GET")).body;
    assert.notEqual(next.bootId, first.bootId);
    assert.equal(next.events.length, 0);
    assert.equal(fake.stateOf(A), "running");
    assert.equal(fake.policyOf(ORG), null);
  });

  it("stats count calls per op and per organization, never bodies", async () => {
    await ensure(A);
    await exec(A, ["echo", "OCW-SENTINEL-FAKE-1234"]);
    const s = await stats();
    assert.equal(s.calls.ensure, 1);
    assert.equal(s.calls.exec, 1);
    assert.equal(s.orgs[ORG].exec, 1);
    assert.ok(!JSON.stringify(s).includes("OCW-SENTINEL-FAKE-1234"));
  });

  it("files: write, list, read, delete over the same workspace the shell sees", async () => {
    await ensure(A);
    const w = await op("/v1/files/write", {
      target: A,
      path: "docs/a.txt",
      content: "hello",
      encoding: "utf8",
      mode: "create",
    });
    assert.deepEqual(w.body, { path: "docs/a.txt", size: 5 });
    assert.equal((await exec(A, ["cat", "docs/a.txt"])).body.stdout, "hello");
    const list = await op("/v1/files/list", { target: A, path: "" });
    assert.deepEqual(
      list.body.entries.map((e) => [e.name, e.kind]),
      [["docs", "dir"]],
    );
    const read = await op("/v1/files/read", { target: A, path: "docs/a.txt" });
    assert.equal(read.body.content, "hello");
    const del = await op("/v1/files/delete", { target: A, path: "docs", recursive: true });
    assert.equal(del.body.deleted, 2);
  });

  it("events: an emitted event is returned after its seq", async () => {
    const ev = { type: "state", target: A, kind: "sbx", state: "stopped", reason: "idle" };
    assert.equal(
      (
        await fetch(`${base}/__control/emit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ev),
        })
      ).status,
      200,
    );
    const r = await op("/v1/events?after=0&waitMs=0", undefined, TOKEN, "GET");
    assert.equal(r.status, 200);
    assert.equal(r.body.events.length, 1);
    assert.equal(r.body.events[0].seq, 1);
    assert.equal(r.body.nextSeq, 1);
  });
});

// ---------------------------------------------------------------- browser ops (07.8-08, P-10, P-13, D-13)

const SENTINEL = "OCW-SENTINEL-PW-5521";
const VIEWPORT = { width: 960, height: 600 };
const control = async (path, body) => {
  const res = await fetch(`${base}/__control/browser/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};
const events = async () => (await op("/v1/events?after=0&waitMs=0", undefined, TOKEN, "GET")).body.events;

/** Required keys of each browser op's response (the contract's `SANDBOXD_ROUTES` outputs). */
const REQUIRED = {
  browserEnsure: ["target", "state", "runtime", "browserSandbox"],
  contextOpen: ["contextId"],
  contextNavigate: ["host", "secure", "title", "blockedNavigation"],
  contextSnapshot: ["host", "title", "nodes", "text", "truncated"],
  contextAct: ["navigated", "blockedNavigation", "download"],
  contextScreenshot: ["mimeType", "data", "width", "height", "masked"],
  contextWait: ["ok", "host"],
  contextExportState: ["storageState"],
  contextClose: ["closed"],
  contextHold: ["held"],
  contextLock: ["locked"],
  contextTakeover: ["active"],
  contextResize: ["ok"],
  contextInput: ["accepted"],
  contextDownload: ["name", "size", "mimeType", "data"],
};
const NODE_KEYS = ["ref", "role", "name", "value", "redacted", "depth"];
function shaped(opName, body) {
  for (const key of REQUIRED[opName]) assert.ok(key in body, `${opName} answers ${key}`);
  if (opName === "contextSnapshot") {
    for (const n of body.nodes) for (const key of NODE_KEYS) assert.ok(key in n, `node ${n.ref} has ${key}`);
  }
  return body;
}

async function browser(target, contextId = randomUUID(), extra = {}) {
  shaped("browserEnsure", (await op("/v1/browsers/ensure", { target })).body);
  const opened = await op("/v1/browsers/contexts/open", { target, contextId, viewport: VIEWPORT, ...extra });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  shaped("contextOpen", opened.body);
  return contextId;
}
const ctxOp = (name, target, contextId, body = {}) =>
  op(`/v1/browsers/contexts/${name}`, { target, contextId, ...body });

/** Reads `ms` of a frame stream: [{ type, payload }] in the contract's framing (4-byte BE length, 1-byte type). */
async function readFrames(target, contextId, ms) {
  const q = new URLSearchParams({ orgId: target.orgId, agentId: target.agentId, contextId });
  const ac = new AbortController();
  const res = await fetch(`${base}/v1/browsers/contexts/frames?${q}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  const chunks = [];
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
  } catch {
    /* aborted after `ms` */
  } finally {
    clearTimeout(timer);
  }
  const all = Buffer.concat(chunks);
  const frames = [];
  let at = 0;
  while (at + 5 <= all.length) {
    const length = all.readUInt32BE(at);
    if (at + 5 + length > all.length) break;
    frames.push({ type: all[at + 4], payload: all.subarray(at + 5, at + 5 + length) });
    at += 5 + length;
  }
  return frames;
}

describe("fake sandboxd: browser ops", () => {
  it("ensure + open + navigate panel.fake.test/app: a navigated event with the host, every answer shaped", async () => {
    const ctx = await browser(A);
    const nav = await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    assert.equal(nav.status, 200);
    shaped("contextNavigate", nav.body);
    assert.deepEqual(
      { host: nav.body.host, secure: nav.body.secure, blocked: nav.body.blockedNavigation },
      { host: "panel.fake.test", secure: true, blocked: null },
    );
    const navigated = (await events()).filter((e) => e.type === "browser" && e.event === "navigated");
    assert.deepEqual(
      navigated.map((e) => [e.contextId, e.host, e.target.agentId]),
      [[ctx, "panel.fake.test", A.agentId]],
    );
  });

  it("the snapshot redacts the password field; the leak control puts the sentinel on a redacted node once", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    const snap = shaped("contextSnapshot", (await ctxOp("snapshot", A, ctx)).body);
    const pw = snap.nodes.find((n) => n.name === "Password");
    assert.deepEqual({ value: pw.value, redacted: pw.redacted }, { value: "[redacted]", redacted: true });
    assert.ok(!JSON.stringify(snap).includes(SENTINEL));
    assert.equal((await control("leak")).status, 200);
    const leaked = (await ctxOp("snapshot", A, ctx)).body;
    const bad = leaked.nodes.filter((n) => n.redacted && n.value !== "[redacted]");
    assert.deepEqual(
      bad.map((n) => n.value),
      [SENTINEL],
    );
    const again = (await ctxOp("snapshot", A, ctx)).body;
    assert.ok(!JSON.stringify(again).includes(SENTINEL), "the leak control is one-shot");
  });

  it("frames: the fixture JPEGs at ≤ 8 fps per subscriber, a size control first, contract framing", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    const frames = await readFrames(A, ctx, 1100);
    assert.equal(frames[0]?.type, 1);
    assert.deepEqual(JSON.parse(frames[0].payload.toString("utf8")), { kind: "size", ...VIEWPORT });
    const jpegs = frames.filter((f) => f.type === 0);
    assert.ok(jpegs.length >= 2, `some frames (${jpegs.length})`);
    assert.ok(jpegs.length <= 9, `at most 8 fps (${jpegs.length} in 1.1 s)`);
    for (const f of jpegs) assert.deepEqual([...f.payload.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  });

  it("input counts frames by type, never payloads; it needs a takeover; acts answer paused meanwhile", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    const before = await ctxOp("input", A, ctx, { events: [{ type: "text", text: "nope" }] });
    assert.equal(before.status, 400);
    shaped("contextTakeover", (await ctxOp("takeover", A, ctx, { active: true })).body);
    const paused = await ctxOp("act", A, ctx, { action: "click", ref: "r4" });
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error.code, "paused");
    assert.equal((await ctxOp("snapshot", A, ctx)).body.error.code, "paused");
    const input = await ctxOp("input", A, ctx, {
      events: [
        { type: "text", text: SENTINEL },
        { type: "key", key: "Enter" },
        { type: "text", text: "again" },
      ],
    });
    assert.equal(input.status, 200);
    shaped("contextInput", input.body);
    assert.equal(input.body.accepted, 3);
    const s = await stats();
    const counted = s.browser.contexts.find((c) => c.contextId === ctx);
    assert.deepEqual(counted.inputs, { text: 2, key: 1 });
    assert.ok(!JSON.stringify(s).includes(SENTINEL), "stats never hold a payload");
    await ctxOp("takeover", A, ctx, { active: false });
    assert.equal((await ctxOp("act", A, ctx, { action: "click", ref: "r4" })).status, 200);
  });

  it("storage state: exported after the signed-in control, a context opened with it is signed in", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    const outBefore = (await ctxOp("export-state", A, ctx)).body;
    assert.deepEqual(JSON.parse(outBefore.storageState).cookies, []);
    assert.equal((await control("signed-in", { contextId: ctx })).status, 200);
    const exported = shaped("contextExportState", (await ctxOp("export-state", A, ctx)).body);
    const again = (await ctxOp("export-state", A, ctx)).body;
    assert.equal(exported.storageState, again.storageState, "deterministic");
    const blob = JSON.parse(exported.storageState);
    assert.deepEqual(
      blob.cookies.map((c) => c.domain),
      ["panel.fake.test"],
    );
    const fresh = await browser(A, randomUUID(), {
      storageState: exported.storageState,
      siteLock: "panel.fake.test",
      memberId: randomUUID(),
    });
    await ctxOp("navigate", A, fresh, { url: "https://panel.fake.test/app" });
    assert.equal((await stats()).browser.contexts.find((c) => c.contextId === fresh).signedIn, true);
    assert.match((await ctxOp("snapshot", A, fresh)).body.title, /signed in/i);
  });

  it("07.8-21: the signed-in cookie's value and expiry round-trip through a loaded state; lock pins the host", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    await control("signed-in", { contextId: ctx, cookieValue: "rolled-1", expires: 2_000_000_000 });
    const blob = JSON.parse((await ctxOp("export-state", A, ctx)).body.storageState);
    assert.deepEqual(
      blob.cookies.map((c) => [c.value, c.expires]),
      [["rolled-1", 2_000_000_000]],
    );
    const member = randomUUID();
    const locked = shaped(
      "contextLock",
      (await ctxOp("lock", A, ctx, { memberId: member, siteLock: "panel.fake.test" })).body,
    );
    assert.equal(locked.locked, true);
    assert.equal(
      (await stats()).browser.contexts.find((c) => c.contextId === ctx).siteLock,
      "panel.fake.test",
    );
    assert.equal(
      (await ctxOp("lock", A, ctx, { memberId: member, siteLock: "other.fake.test" })).status,
      400,
    );
    const nav = (await ctxOp("navigate", A, ctx, { url: "https://other.fake.test/" })).body;
    assert.deepEqual(nav.blockedNavigation, { host: "other.fake.test" });
    const fresh = await browser(A, randomUUID(), {
      storageState: JSON.stringify(blob),
      siteLock: "panel.fake.test",
      memberId: member,
    });
    const row = (await stats()).browser.contexts.find((c) => c.contextId === fresh);
    assert.equal(row.loadedState, true);
    await ctxOp("navigate", A, fresh, { url: "https://panel.fake.test/app" });
    const again = JSON.parse((await ctxOp("export-state", A, fresh)).body.storageState);
    assert.equal(again.cookies[0].value, "rolled-1");
    await ctxOp("hold", A, fresh, { hold: true, reason: "signin" });
    assert.equal((await stats()).browser.contexts.find((c) => c.contextId === fresh).holdReason, "signin");
  });

  it("downloads: a download control emits the event; the token returns fixed bytes once", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    const r = await control("event", { target: A, contextId: ctx, event: "download" });
    assert.equal(r.status, 200);
    const ev = (await events()).find((e) => e.type === "browser" && e.event === "download");
    assert.equal(ev.download.name, "report.csv");
    const got = shaped(
      "contextDownload",
      (await ctxOp("download", A, ctx, { token: ev.download.token })).body,
    );
    assert.equal(Buffer.from(got.data, "base64").toString("utf8"), "id,amount\n1,1250\n");
    assert.equal(got.size, ev.download.size);
    const unknown = await ctxOp("download", A, ctx, { token: "x".repeat(32) });
    assert.equal(unknown.status, 404);
  });

  it("controls emit crashed, closed and focus_sensitive events for the context", async () => {
    const ctx = await browser(A);
    for (const event of ["crashed", "focus_sensitive", "closed"]) {
      assert.equal((await control("event", { target: A, contextId: ctx, event })).status, 200);
    }
    const got = (await events())
      .filter((e) => e.type === "browser" && e.contextId === ctx)
      .map((e) => e.event);
    assert.deepEqual(got, ["crashed", "focus_sensitive", "closed"]);
    assert.equal((await ctxOp("snapshot", A, ctx)).body.error.code, "no_context", "closed ends the context");
  });

  it("07.8-26: focus_sensitive also tells the open frame streams (control {kind: focus, sensitive: true})", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/login" });
    const reading = readFrames(A, ctx, 900);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      (await control("event", { target: A, contextId: ctx, event: "focus_sensitive" })).status,
      200,
    );
    const controls = (await reading)
      .filter((f) => f.type === 1)
      .map((f) => JSON.parse(f.payload.toString("utf8")));
    assert.deepEqual(
      controls.filter((c) => c.kind === "focus"),
      [{ kind: "focus", sensitive: true }],
    );
  });

  it("an act on ref `gone` answers element_gone; an unknown context answers no_context", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    const gone = await ctxOp("act", A, ctx, { action: "click", ref: "gone" });
    assert.equal(gone.status, 409);
    assert.equal(gone.body.error.code, "element_gone");
    const none = await ctxOp("snapshot", A, randomUUID());
    assert.equal(none.status, 404);
    assert.equal(none.body.error.code, "no_context");
    // Another bot never reaches this bot's context.
    assert.equal((await ctxOp("snapshot", B, ctx)).body.error.code, "no_context");
  });

  it("site lock (D-13): the export link to evil.fake.test is blocked and reported; allowCrossSite passes once", async () => {
    const ctx = await browser(A, randomUUID(), { siteLock: "panel.fake.test" });
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    const blocked = shaped(
      "contextAct",
      (await ctxOp("act", A, ctx, { action: "click", ref: "export-link" })).body,
    );
    assert.deepEqual(blocked, {
      navigated: false,
      blockedNavigation: { host: "evil.fake.test" },
      download: null,
    });
    assert.equal((await ctxOp("snapshot", A, ctx)).body.host, "panel.fake.test", "did not navigate");
    const nav = (await ctxOp("navigate", A, ctx, { url: "https://evil.fake.test/collect" })).body;
    assert.deepEqual(nav.blockedNavigation, { host: "evil.fake.test" });
    assert.equal(nav.host, "panel.fake.test");
    const allowed = (
      await ctxOp("navigate", A, ctx, { url: "https://evil.fake.test/collect", allowCrossSite: true })
    ).body;
    assert.deepEqual(
      { host: allowed.host, blocked: allowed.blockedNavigation },
      { host: "evil.fake.test", blocked: null },
    );
    // Once: back on the site, the next cross-site navigation is blocked again.
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app", allowCrossSite: true });
    const again = (await ctxOp("navigate", A, ctx, { url: "https://evil.fake.test/collect" })).body;
    assert.deepEqual(again.blockedNavigation, { host: "evil.fake.test" });
    // Without a site lock the same link navigates.
    const free = await browser(A);
    await ctxOp("navigate", A, free, { url: "https://panel.fake.test/app" });
    const went = (await ctxOp("act", A, free, { action: "click", ref: "export-link" })).body;
    assert.deepEqual(went, { navigated: true, blockedNavigation: null, download: null });
  });

  it("screenshot, wait, hold, resize and close answer their contract shapes", async () => {
    const ctx = await browser(A);
    await ctxOp("navigate", A, ctx, { url: "https://panel.fake.test/app" });
    const shot = shaped("contextScreenshot", (await ctxOp("screenshot", A, ctx)).body);
    assert.equal(shot.mimeType, "image/jpeg");
    assert.ok(shot.masked >= 1, "the password box is masked");
    assert.deepEqual([...Buffer.from(shot.data, "base64").subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.equal(
      shaped("contextWait", (await ctxOp("wait", A, ctx, { for: "text", text: "Sign in" })).body).ok,
      true,
    );
    assert.equal((await ctxOp("wait", A, ctx, { for: "text", text: "[redacted]x" })).body.ok, false);
    assert.equal(
      shaped("contextHold", (await ctxOp("hold", A, ctx, { hold: true, reason: "signin" })).body).held,
      true,
    );
    shaped("contextResize", (await ctxOp("resize", A, ctx, { width: 390, height: 844 })).body);
    shaped("contextClose", (await ctxOp("close", A, ctx)).body);
    assert.equal((await ctxOp("snapshot", A, ctx)).body.error.code, "no_context");
  });

  it("killOrg closes the organization's browsers too", async () => {
    const ctx = await browser(A);
    await op("/v1/orgs/kill", { orgId: ORG });
    assert.equal((await ctxOp("snapshot", A, ctx)).body.error.code, "no_context");
  });
});

// ---------------------------------------------------------------- sandbox packages (07.8-18, P-12)

/** The contract's `packageTreeCanonical`, restated (the fake and its test stay dependency-free). */
function canonicalTree(entries) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...entries].sort(
    (x, y) => cmp(x.name, y.name) || cmp(x.version, y.version) || cmp(x.integrity, y.integrity),
  );
  return JSON.stringify(sorted.map((e) => ({ name: e.name, version: e.version, integrity: e.integrity })));
}
const sha256 = async (text) => (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
const pkgControl = async (path, body) =>
  (
    await fetch(`${base}/__control/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).status;

const LEFT_PAD = { source: "npm", name: "left-pad", version: "1.3.0" };
const review = (spec = LEFT_PAD, orgId = ORG) => op("/v1/packages/review", { orgId, ...spec });
const installOf = (r, id = randomUUID()) => ({
  id,
  source: r.source,
  name: r.name,
  version: r.version,
  sha256: r.sha256,
  treeSha256: r.treeSha256,
  lockfile: r.lockfile,
});

describe("fake sandboxd: sandbox packages (07.8-18)", () => {
  it("review: a deterministic pinned tree (the package and one dependency) with its lockfile and tree hash", async () => {
    const r = await review();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    for (const key of [
      "source",
      "name",
      "version",
      "sha256",
      "sizeBytes",
      "license",
      "publisher",
      "hasInstallScript",
      "dependencyCount",
      "treeSha256",
      "entries",
      "lockfile",
    ]) {
      assert.ok(key in b, `packageReview answers ${key}`);
    }
    assert.deepEqual([b.source, b.name, b.version], ["npm", "left-pad", "1.3.0"]);
    assert.match(b.sha256, /^[0-9a-f]{64}$/);
    assert.equal(b.license, "MIT");
    assert.equal(b.hasInstallScript, false);
    assert.equal(b.entries.length, 2);
    assert.equal(b.dependencyCount, 1);
    for (const e of b.entries) assert.match(e.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.equal(b.treeSha256, await sha256(canonicalTree(b.entries)));
    assert.equal(JSON.parse(b.lockfile).name, "left-pad");
    // Deterministic: the same coordinates give the same tree, in any organization.
    assert.deepEqual((await review(LEFT_PAD, OTHER_ORG)).body, b);
    // PyPI, Debian and ClawHub pin sha256 files; ClawHub is a single tarball.
    const py = (await review({ source: "pypi", name: "requests", version: "2.32.3" })).body;
    for (const e of py.entries) assert.match(e.integrity, /^sha256:[0-9a-f]{64}$/);
    const hub = (await review({ source: "clawhub", name: "notes-skill", version: "1.0.0" })).body;
    assert.equal(hub.entries.length, 1);
    assert.equal(hub.dependencyCount, 0);
  });

  it("controls: the top digest, one dependency's integrity, sha1-only integrity and a lying tree hash", async () => {
    const before = (await review()).body;
    assert.equal(await pkgControl("packages/set", { ...LEFT_PAD, depChanged: true }), 200);
    const dep = (await review()).body;
    assert.equal(dep.sha256, before.sha256, "only a dependency moved");
    assert.notEqual(dep.treeSha256, before.treeSha256);
    assert.equal(dep.treeSha256, await sha256(canonicalTree(dep.entries)));
    assert.equal(await pkgControl("packages/set", { ...LEFT_PAD, topChanged: true }), 200);
    assert.notEqual((await review()).body.sha256, before.sha256);
    assert.equal(await pkgControl("packages/set", { ...LEFT_PAD, sha1: true, topChanged: false }), 200);
    const weak = (await review()).body;
    assert.ok(weak.entries.some((e) => /^sha1-[A-Za-z0-9+/]{27}=$/.test(e.integrity)));
    assert.equal(await pkgControl("packages/set", { ...LEFT_PAD, badTreeHash: true }), 200);
    const lying = (await review()).body;
    assert.notEqual(lying.treeSha256, await sha256(canonicalTree(lying.entries)));
    assert.equal(
      await pkgControl("packages/set", { ...LEFT_PAD, license: "GPL-2.0-only", hasInstallScript: true }),
      200,
    );
    const meta = (await review()).body;
    assert.deepEqual([meta.license, meta.hasInstallScript], ["GPL-2.0-only", true]);
    // An unknown package answers not_found.
    const missing = await review({ source: "npm", name: "ocw-missing-package", version: "1.0.0" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "not_found");
  });

  it("install: the recorded tree installs per bot; a moved dependency answers tree_changed, a moved top digest_mismatch", async () => {
    const r = (await review()).body;
    const pkg = installOf(r);
    const ok = await op("/v1/packages/install", { target: A, packages: [pkg] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.results, [{ id: pkg.id, status: "installed", detail: "installed" }]);
    assert.deepEqual(fake.packagesOf(A), [pkg.id]);
    assert.deepEqual(fake.packagesOf(B), [], "another bot does not get it");
    assert.equal((await stats()).calls.packageInstall, 1);

    // A lockfile that is not the recorded one (its tree hash differs from the request's) is refused too.
    const forged = await op("/v1/packages/install", {
      target: B,
      packages: [{ ...installOf(r), lockfile: JSON.stringify({ name: "left-pad", packages: {} }) }],
    });
    assert.equal(forged.body.results[0].code, "tree_changed");

    await pkgControl("packages/set", { ...LEFT_PAD, depChanged: true });
    const moved = await op("/v1/packages/install", { target: B, packages: [installOf(r)] });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.results[0].status, "failed");
    assert.equal(moved.body.results[0].code, "tree_changed");
    assert.deepEqual(fake.packagesOf(B), []);

    await pkgControl("packages/set", { ...LEFT_PAD, depChanged: false, topChanged: true });
    const top = await op("/v1/packages/install", { target: B, packages: [installOf(r)] });
    assert.equal(top.body.results[0].code, "digest_mismatch");

    const removed = await op("/v1/packages/remove", { target: A, ids: [pkg.id] });
    assert.deepEqual(removed.body, { removed: 1 });
    assert.deepEqual(fake.packagesOf(A), []);
    assert.deepEqual((await op("/v1/packages/remove", { target: A, ids: [pkg.id] })).body, { removed: 0 });
  });

  it("package review, install and removal follow ensure's gate: policy_missing, then killed (07.8-17)", async () => {
    const r = (await review()).body;
    const pkg = installOf(r);
    assert.equal((await fetch(`${base}/__control/reboot`, { method: "POST" })).status, 200);
    for (const res of [
      await review(),
      await op("/v1/packages/install", { target: A, packages: [pkg] }),
      await op("/v1/packages/remove", { target: A, ids: [pkg.id] }),
    ]) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "policy_missing");
    }
    assert.equal((await op("/v1/policy", policy(ORG, true, 2))).status, 200);
    const killed = await op("/v1/packages/install", { target: A, packages: [pkg] });
    assert.equal(killed.status, 409);
    assert.equal(killed.body.error.code, "killed");
    assert.deepEqual(fake.packagesOf(A), [], "the volume stays untouched");
    assert.equal((await op("/v1/policy", policy(ORG, false, 3))).status, 200);
    assert.equal((await op("/v1/packages/install", { target: A, packages: [pkg] })).status, 200);
    assert.deepEqual(fake.packagesOf(A), [pkg.id]);
  });

  it("install never takes a sha1-pinned entry, and is idempotent per package id (07.8-17)", async () => {
    await pkgControl("packages/set", { ...LEFT_PAD, sha1: true });
    const weak = (await review()).body;
    const refused = await op("/v1/packages/install", { target: A, packages: [installOf(weak)] });
    assert.equal(refused.body.results[0].status, "failed");
    assert.match(refused.body.results[0].detail, /sha1/);
    assert.deepEqual(fake.packagesOf(A), []);
    await pkgControl("packages/set", { ...LEFT_PAD, sha1: false });
    const pkg = installOf((await review()).body);
    const [x, y] = await Promise.all([
      op("/v1/packages/install", { target: A, packages: [pkg] }),
      op("/v1/packages/install", { target: A, packages: [pkg] }),
    ]);
    assert.equal(x.body.results[0].status, "installed");
    assert.equal(y.body.results[0].status, "installed");
    assert.deepEqual(fake.packagesOf(A), [pkg.id]);
  });

  it("package ops need the token and never echo a lockfile in the stats", async () => {
    const r = (await review()).body;
    const denied = await op("/v1/packages/install", { target: A, packages: [installOf(r)] }, null);
    assert.equal(denied.status, 401);
    assert.ok(!JSON.stringify(await stats()).includes("lockfileVersion"));
  });
});
