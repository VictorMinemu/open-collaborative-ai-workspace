// The real-Docker stack smoke's driver (07.8-13), started by run-stack-smoke.sh after it built the images and the fake
// sites. It runs sandboxd as its own child process (a host process on 127.0.0.1 and a free port, so it can restart it)
// and drives it only through its HTTP API, as the API does; `docker` is used only to look at what sandboxd built.
//
//   node stack-smoke.mjs --ns <ns> --work <dir> --fixtures <net> --fake <container> --sbx <img> --brw <img>
//                        --egress <img> --seccomp <file> [--only open|all|coldstart]
//   coldstart  STACK_COLDSTARTS (default 8) fresh browsers, each in its own organization: ensure, then the first
//              contextOpen at once (as the API does), timed; each first open must answer within 15 s (07.8 hardening)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGIN_LAYOUT } from "./fake-site.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const NS = opt("--ns");
const WORK = opt("--work");
const NET_FIX = opt("--fixtures");
const FAKE = opt("--fake");
const IMAGES = { sbx: opt("--sbx"), brw: opt("--brw"), egress: opt("--egress") };
const SECCOMP = opt("--seccomp");
const ONLY = opt("--only") ?? "all";
const REAL_EGRESS = process.env.STACK_REAL_EGRESS !== "0";

const PANEL = "panel.fake.test:8080";
const IDP = "idp.fake.test:8080";
const EVIL = "evil.fake.test:8080";
const PROXY = "http://sandbox-egress:3128";
const SECRETS = { username: "ana@example.test", password: "S3cr3t-Hunter2-OCW", otp: "735190" };
const TOKEN = randomBytes(32).toString("hex");
const MiB = 1024 * 1024;

let checks = 0;
let failures = 0;
const log = (s) => process.stderr.write(`${s}\n`);
function ok(cond, what, detail = "") {
  checks += 1;
  if (cond) log(`ok   ${what}`);
  else {
    failures += 1;
    log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- names (mirror apps/sandboxd/src/spec.ts)

const agentKey = (id) => createHash("sha256").update(id).digest("hex").slice(0, 12);
const nameFor = (kind, id) => `ocw-${kind}-${NS}-${agentKey(id)}`;
const EGRESS = `ocw-egress-${NS}`;
const EGRESS_OUT = `ocw-egress-out-${NS}`;

// ---------------------------------------------------------------- docker (observation only)

function docker(...a) {
  const r = spawnSync("docker", a, { encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const inspect = (name) => {
  const r = docker("inspect", name);
  return r.status === 0 ? JSON.parse(r.out)[0] : null;
};
const ipOn = (container, network) =>
  inspect(container)?.NetworkSettings?.Networks?.[network]?.IPAddress ?? "";
const fakeStats = () =>
  JSON.parse(
    docker(
      "exec",
      FAKE,
      "node",
      "-e",
      'fetch("http://127.0.0.1:8080/__stats").then((r) => r.text()).then((t) => process.stdout.write(t))',
    ).out,
  );

// ---------------------------------------------------------------- sandboxd as a child process

let sandboxd = null;
let PORT = 0;
const LOG = join(WORK, "sandboxd.log");

async function startSandboxd() {
  const before = (() => {
    try {
      return readFileSync(LOG, "utf8").length;
    } catch {
      return 0;
    }
  })();
  const fd = openSync(LOG, "a");
  sandboxd = spawn("node", ["--import", "tsx", "apps/sandboxd/src/main.ts"], {
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      OCW_SANDBOX_TOKEN: TOKEN,
      OCW_SANDBOX_NAMESPACE: NS,
      OCW_SANDBOXD_HOST: "127.0.0.1",
      OCW_SANDBOXD_PORT: "0",
      OCW_SANDBOX_RUNTIME: "auto",
      OCW_SANDBOX_SBX_IMAGE: IMAGES.sbx,
      OCW_SANDBOX_BRW_IMAGE: IMAGES.brw,
      OCW_SANDBOX_EGRESS_IMAGE: IMAGES.egress,
      OCW_SANDBOX_BRW_SECCOMP: SECCOMP,
      OCW_SANDBOXD_SWEEP_MS: "3000",
    },
  });
  writeFileSync(join(WORK, "sandboxd.pid"), String(sandboxd.pid));
  for (let i = 0; i < 150; i++) {
    const text = readFileSync(LOG, "utf8").slice(before);
    for (const line of text.split("\n")) {
      try {
        const j = JSON.parse(line);
        if (j.msg === "listening") PORT = j.port;
      } catch {}
    }
    if (PORT && text.includes('"listening"')) return;
    if (sandboxd.exitCode !== null) throw new Error("sandboxd exited");
    await sleep(200);
  }
  throw new Error("sandboxd did not listen");
}

async function stopSandboxd() {
  const p = sandboxd;
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.on("exit", r));
  p.kill("SIGTERM");
  await Promise.race([done, sleep(8000)]);
  PORT = 0;
}

// ---------------------------------------------------------------- the API's view of sandboxd

async function api(method, path, body, timeoutMs = 120_000) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json };
}
const post = (path, body) => api("POST", path, body);
async function okPost(path, body, what) {
  const r = await post(path, body);
  assert.equal(r.status, 200, `${what ?? path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const codeOf = (r) => r.body?.error?.code ?? `status ${r.status}`;

// The event feed the API long-polls: every event this run saw.
const seen = [];
let cursor = 0;
let bootId = null;
async function pollEvents() {
  const r = await api("GET", `/v1/events?after=${cursor}&waitMs=0`);
  if (r.status !== 200) return;
  if (bootId !== r.body.bootId) {
    bootId = r.body.bootId;
    cursor = 0;
    const again = await api("GET", "/v1/events?after=0&waitMs=0");
    seen.push(...again.body.events);
    cursor = again.body.nextSeq;
    return;
  }
  seen.push(...r.body.events);
  cursor = r.body.nextSeq;
}
async function waitEvent(pred, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    await pollEvents();
    const e = seen.find(pred);
    if (e) return e;
    if (Date.now() > until) return null;
    await sleep(200);
  }
}

// ---------------------------------------------------------------- policies (as the API pushes them, 07.8-11)

function policy(orgId, over = {}) {
  return {
    orgId,
    sandboxEgress: "allowlist",
    browserEgress: "public",
    allowHosts: [],
    privateHosts: [PANEL, IDP],
    limits: {
      nanoCpus: 1e9,
      memoryBytes: 1024 * MiB,
      pids: 256,
      diskQuotaBytes: 2048 * MiB,
      idleStopMs: 900_000,
    },
    browserLimits: {
      nanoCpus: 1e9,
      memoryBytes: 2048 * MiB,
      pids: 512,
      diskQuotaBytes: 2048 * MiB,
      idleStopMs: 300_000,
    },
    killed: false,
    version: 1,
    ...over,
  };
}

// ---------------------------------------------------------------- frames

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Opens the frame stream of a context; collects JPEGs and controls until `stop()`. */
async function watch(target, contextId) {
  const ac = new AbortController();
  const q = new URLSearchParams({ orgId: target.orgId, agentId: target.agentId, contextId });
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/browsers/contexts/frames?${q}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: ac.signal,
  });
  const out = {
    status: res.status,
    type: res.headers.get("content-type"),
    jpegs: [],
    controls: [],
    ended: false,
  };
  if (res.status !== 200) return { ...out, stop: async () => out };
  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);
        while (buf.length >= 5) {
          const len = buf.readUInt32BE(0);
          const type = buf[4];
          if (buf.length < 5 + len) break;
          const payload = Buffer.from(buf.subarray(5, 5 + len));
          buf = buf.subarray(5 + len);
          if (type === 0) out.jpegs.push({ at: Date.now(), jpeg: payload });
          else if (type === 1) out.controls.push(JSON.parse(payload.toString("utf8")));
          else throw new Error(`unknown frame type ${type}`);
        }
      }
      out.ended = true;
    } catch {}
  })();
  return {
    out,
    async stop() {
      ac.abort();
      await reading;
      return out;
    },
  };
}

// ---------------------------------------------------------------- takeover input frames (as the live view sends)

const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const clickAt = ({ x, y }) => [
  { type: "mouse", event: "move", x, y, button: "none" },
  { type: "mouse", event: "down", x, y, button: "left" },
  { type: "mouse", event: "up", x, y, button: "left" },
];
const PUNCT = { "@": "Digit2", "-": "Minus", ".": "Period", _: "Minus", " ": "Space" };
const keyCode = (ch) =>
  /[a-z]/i.test(ch)
    ? `Key${ch.toUpperCase()}`
    : /[0-9]/.test(ch)
      ? `Digit${ch}`
      : (PUNCT[ch] ?? "Unidentified");
const keyFrames = (s) =>
  [...s].flatMap((ch) => {
    const modifiers = /[A-Z@_]/.test(ch) ? 8 : 0;
    return [
      { type: "key", event: "down", key: ch, code: keyCode(ch), modifiers },
      { type: "key", event: "up", key: ch, code: keyCode(ch), modifiers },
    ];
  });

const findNode = (snap, role, name) => snap.nodes.find((n) => n.role === role && n.name === name);

// ---------------------------------------------------------------- the run

const ORG = randomUUID();
const ORG_B = randomUUID();
const A = randomUUID();
const B = randomUUID();
const tA = { orgId: ORG, agentId: A };
const tB = { orgId: ORG_B, agentId: B };
const viewport = { width: 960, height: 600 };
let orgVersion = 1;
let orgPolicy = {};

async function exec(target, argv, timeoutMs = 30_000) {
  return okPost("/v1/sandboxes/exec", { target, argv, cwd: "", timeoutMs, yieldMs: 25_000 }, "exec");
}
/** curl through the proxy from a bot's shell: `{ code, reason }` (the proxy's X-OCW-Egress refusal reason). */
async function viaProxy(target, url) {
  const r = await exec(target, [
    "sh",
    "-c",
    `curl -s -D - -o /dev/null -m 10 -x ${PROXY} '${url}' | tr -d '\\r'`,
  ]);
  const head = r.stdout;
  const code = /^HTTP\/[\d.]+ (\d{3})/m.exec(head)?.[1] ?? "000";
  const reason = /^x-ocw-egress: (\S+)/im.exec(head)?.[1] ?? "";
  return { code, reason };
}
async function openContext(target, extra = {}) {
  const contextId = randomUUID();
  await okPost("/v1/browsers/contexts/open", { target, contextId, viewport, ...extra }, "contextOpen");
  return contextId;
}
const navigate = (target, contextId, url, extra = {}) =>
  post("/v1/browsers/contexts/navigate", { target, contextId, url, ...extra });
const snapshot = (target, contextId) =>
  okPost("/v1/browsers/contexts/snapshot", { target, contextId }, "snapshot");
async function waitText(target, contextId, text) {
  const r = await okPost(
    "/v1/browsers/contexts/wait",
    { target, contextId, for: "text", text, ms: 15_000 },
    "contextWait",
  );
  return r.ok === true;
}
async function input(target, contextId, events) {
  for (let i = 0; i < events.length; i += 64) {
    await okPost(
      "/v1/browsers/contexts/input",
      { target, contextId, events: events.slice(i, i + 64) },
      "contextInput",
    );
  }
}

async function setup() {
  await startSandboxd();
  await pollEvents();
  orgPolicy = policy(ORG);
  await okPost("/v1/policy", orgPolicy, "policy A");
  await okPost("/v1/policy", policy(ORG_B, { browserEgress: "off" }), "policy B");
  const sbx = await okPost("/v1/sandboxes/ensure", { target: tA }, "ensure sbx A");
  ok(sbx.state === "running", "A's sbx is running");
  ok(inspect(EGRESS)?.State?.Running === true, "sandboxd created and started the namespace's egress proxy");
  // The fixtures network stands in for the outside world: only the proxy joins it.
  assert.equal(docker("network", "connect", NET_FIX, EGRESS).status, 0, "connect the fixtures to the proxy");
}

let posture = null;

async function stepOpen() {
  log("== open: a bot's browser renders a page through the proxy and streams its frames");
  const status = await okPost("/v1/browsers/ensure", { target: tA }, "browserEnsure A");
  posture = status.browserSandbox;
  ok(status.state === "running", "browserEnsure A → running");
  ok(
    ["chromium", "container-only", "chromium+gvisor"].includes(posture),
    `D-14: browserSandbox reported (${posture})`,
  );
  ok(
    (status.runtime === "gvisor") === (posture === "chromium+gvisor"),
    `D-14: the posture matches the runtime (${status.runtime}, ${posture})`,
  );
  const info = await api("GET", "/v1/info");
  ok(
    info.body?.browserSandbox === posture,
    `GET /v1/info reports the started browser's posture (${info.body?.browserSandbox})`,
  );

  // What sandboxd built.
  const brw = inspect(nameFor("brw", A));
  const sbx = inspect(nameFor("sbx", A));
  const egress = inspect(EGRESS);
  const bnet = nameFor("bnet", A);
  const net = nameFor("net", A);
  ok(Object.keys(brw.NetworkSettings.Networks).join() === bnet, "brw A is on A's browser network only");
  ok(Object.keys(sbx.NetworkSettings.Networks).join() === net, "sbx A is on A's shell network only");
  ok(
    brw.HostConfig.ShmSize === 512 * MiB &&
      brw.HostConfig.ReadonlyRootfs === true &&
      brw.HostConfig.Privileged === false &&
      brw.Config.User === "10001:10001" &&
      (brw.HostConfig.CapDrop ?? []).includes("ALL") &&
      !brw.HostConfig.PortBindings?.length &&
      (brw.HostConfig.Binds ?? []).length === 0 &&
      brw.HostConfig.IpcMode === "private",
    "brw A: hardened, 512 MiB shm, no port, no bind, private IPC",
  );
  ok(Object.keys(brw.Config.ExposedPorts ?? {}).length === 0, "brw A exposes no port");
  const egressNets = Object.keys(egress.NetworkSettings.Networks).sort();
  ok(
    egressNets.join() === [EGRESS_OUT, NET_FIX, bnet, net].sort().join(),
    `the proxy is on its outbound network, A's two networks and the fixtures only (${egressNets.join(", ")})`,
  );
  ok(
    inspect(EGRESS_OUT) && JSON.parse(docker("network", "inspect", EGRESS_OUT).out)[0].Internal === false,
    "the proxy's outbound network is the only non-internal one",
  );
  for (const n of [bnet, net]) {
    ok(JSON.parse(docker("network", "inspect", n).out)[0].Internal === true, `${n} is internal`);
  }
  ok(
    egress.Config.User === "10002:10002" && egress.HostConfig.ReadonlyRootfs === true,
    "the proxy runs as 10002, read-only",
  );
  ok(
    egress.Config.Labels["ocw.org"] === undefined && egress.Config.Labels["ocw.sandbox"] === "1",
    "the proxy carries the namespace's labels, no organization's",
  );

  // Open → navigate → snapshot.
  const ctx = await openContext(tA);
  const nav = await navigate(tA, ctx, `http://${PANEL}/app`);
  ok(
    nav.status === 200 && nav.body.host === PANEL,
    `navigate → host ${nav.body?.host}`,
    JSON.stringify(nav.body),
  );
  const navigated = await waitEvent(
    (e) => e.type === "browser" && e.event === "navigated" && e.contextId === ctx && e.host === PANEL,
  );
  ok(Boolean(navigated), "a browser navigated event with the host only");
  ok(await waitText(tA, ctx, "Sign in"), "the JS-rendered page reached its sign-in state");
  const snap = await snapshot(tA, ctx);
  ok(Boolean(findNode(snap, "heading", "Sign in")), "the snapshot shows the JS-rendered Sign in heading");

  // Frames: one chunked response, the contract framing, bare JPEGs.
  const w = await watch(tA, ctx);
  ok(w.out.status === 200 && w.out.type === "application/octet-stream", "GET …/frames → 200 octet-stream");
  const started = Date.now();
  // The screencast sends a frame when the page paints (one when idle): change the page a few times in the window.
  for (const path of ["/login", "/app", "/login", "/app"]) {
    await navigate(tA, ctx, `http://${PANEL}${path}`);
    await sleep(500);
  }
  await sleep(Math.max(0, 3000 - (Date.now() - started)));
  const got = await w.stop();
  const inWindow = got.jpegs.filter((f) => f.at - started <= 3200);
  ok(inWindow.length >= 3, `≥ 3 framed JPEGs in 3 s (${inWindow.length})`);
  ok(
    got.jpegs.every((f) => f.jpeg[0] === 0xff && f.jpeg[1] === 0xd8),
    "every frame is a bare JPEG (context tag stripped)",
  );
  const size = got.controls.find((c) => c.kind === "size");
  ok(size?.width === 960 && size?.height === 600, `a size control 960x600 (${JSON.stringify(size)})`);
  ok(
    got.controls.some((c) => c.kind === "navigated" && c.host === PANEL),
    "a navigated control on the stream",
  );

  const egressEvent = await waitEvent(
    (e) => e.type === "egress" && e.target.agentId === A && e.kind === "brw" && e.host === "panel.fake.test",
  );
  ok(egressEvent?.allowed === true, "an egress event: panel.fake.test allowed for A's browser");

  // Containment.
  const tcp = docker("exec", nameFor("brw", A), "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6");
  const listening = tcp.out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[3] === "0A" && !/^0B00007F:/i.test(f[1] ?? ""));
  ok(tcp.status === 0 && listening.length === 0, `brw listens on no TCP port (${listening.length})`);
  ok(
    docker("exec", nameFor("brw", A), "getent", "hosts", "example.com").status !== 0,
    "brw has no external DNS",
  );

  // The shell's own mode: allowlist.
  const before = await viaProxy(tA, `http://${PANEL}/__stats`);
  ok(
    before.code === "403" && before.reason === "not_allowlisted",
    `sbx A → panel before the allowlist (${before.code} ${before.reason})`,
  );
  orgPolicy = policy(ORG, { allowHosts: [PANEL], version: ++orgVersion });
  await okPost("/v1/policy", orgPolicy, "policy A v2");
  const after = await viaProxy(tA, `http://${PANEL}/__stats`);
  ok(after.code === "200", `sbx A → panel once the host is allowlisted (${after.code} ${after.reason})`);
  const sbxEvent = await waitEvent(
    (e) =>
      e.type === "egress" &&
      e.target.agentId === A &&
      e.kind === "sbx" &&
      e.host === "panel.fake.test" &&
      e.allowed,
  );
  ok(Boolean(sbxEvent), "an egress event for A's shell, kind sbx");

  // Public mode with real egress (07.8-12 proved it in unit tests only).
  if (REAL_EGRESS) {
    const real = await navigate(tA, ctx, "https://example.com/");
    if (real.status === 200 && real.body.host === "example.com") {
      ok(true, "public mode: A's browser reached https://example.com through the proxy (real egress)");
      const ev = await waitEvent(
        (e) => e.type === "egress" && e.host === "example.com" && e.target.agentId === A,
      );
      ok(ev?.allowed === true, "an egress event: example.com allowed");
    } else {
      const probe = docker(
        "exec",
        EGRESS,
        "node",
        "-e",
        'fetch("https://example.com/",{signal:AbortSignal.timeout(10000)}).then(()=>process.exit(0),()=>process.exit(1))',
      );
      if (probe.status !== 0) {
        log(
          `skip public-mode real egress: the proxy's outbound network has no internet here (${codeOf(real)})`,
        );
      } else {
        ok(
          false,
          "public mode real egress",
          `the proxy can reach example.com but the browser got ${codeOf(real)}`,
        );
      }
    }
  } else log("skip public-mode real egress (STACK_REAL_EGRESS=0)");
  await okPost("/v1/browsers/contexts/close", { target: tA, contextId: ctx }, "contextClose");
}

async function stepFull() {
  log("== takeover: a person signs in through input frames; bot ops wait");
  const ctx = await openContext(tA);
  await navigate(tA, ctx, `http://${PANEL}/login`);
  await okPost("/v1/browsers/contexts/takeover", { target: tA, contextId: ctx, active: true }, "takeover on");
  const paused = await post("/v1/browsers/contexts/snapshot", { target: tA, contextId: ctx });
  ok(paused.status === 409 && codeOf(paused) === "paused", `a bot op during takeover → ${codeOf(paused)}`);
  const L = LOGIN_LAYOUT;
  await input(tA, ctx, [...clickAt(center(L.email)), ...keyFrames(SECRETS.username)]);
  await input(tA, ctx, [...clickAt(center(L.password)), ...keyFrames(SECRETS.password)]);
  await input(tA, ctx, [...clickAt(center(L.otp)), { type: "text", text: SECRETS.otp }]);
  await input(tA, ctx, clickAt(center(L.submit)));
  await okPost(
    "/v1/browsers/contexts/takeover",
    { target: tA, contextId: ctx, active: false },
    "takeover off",
  );
  ok(await waitText(tA, ctx, "Welcome"), "the person's input signed in on the fake site");
  ok(fakeStats().logins >= 1, "the fake site counted the login");
  const focus = await waitEvent(
    (e) => e.type === "browser" && e.event === "focus_sensitive" && e.contextId === ctx,
  );
  ok(Boolean(focus), "a focus_sensitive event when the password field took focus");

  const state = await okPost(
    "/v1/browsers/contexts/export-state",
    { target: tA, contextId: ctx },
    "exportState",
  );
  const cookies = JSON.parse(state.storageState).cookies.map((c) => c.name);
  ok(
    cookies.includes("panel_session") && !cookies.includes("idp_session"),
    `export keeps the site's cookie only (${cookies})`,
  );

  log("== downloads: by token, then into the workspace as 10001");
  await navigate(tA, ctx, `http://${PANEL}/files`);
  const files = await snapshot(tA, ctx);
  const link = findNode(files, "link", "Download report");
  const act = await okPost(
    "/v1/browsers/contexts/act",
    { target: tA, contextId: ctx, action: "click", ref: link?.ref },
    "act",
  );
  ok(
    act.download?.name === "report.csv",
    `the click downloaded report.csv (${JSON.stringify(act.download)})`,
  );
  const dl = await waitEvent((e) => e.type === "browser" && e.event === "download" && e.contextId === ctx);
  ok(dl?.download?.token === act.download?.token, "a download event carries the same token");
  const content = await okPost(
    "/v1/browsers/contexts/download",
    { target: tA, contextId: ctx, token: act.download.token },
    "contextDownload",
  );
  const bytes = Buffer.from(content.data, "base64");
  ok(
    bytes.toString("utf8").startsWith("row-000,") && bytes.length === content.size,
    `contextDownload streams the file (${bytes.length} bytes)`,
  );
  await okPost(
    "/v1/files/import",
    { target: tA, path: "downloads/report.csv", data: content.data, overwrite: true },
    "filesImport",
  );
  const st = docker("exec", nameFor("sbx", A), "stat", "-c", "%u %s", "/workspace/downloads/report.csv");
  ok(
    st.out === `10001 ${bytes.length}`,
    `filesImport wrote /workspace/downloads/report.csv as 10001 (${st.out})`,
  );

  log("== resize: phone frames at the phone size");
  await navigate(tA, ctx, `http://${PANEL}/app`);
  const w = await watch(tA, ctx);
  await sleep(500);
  const since = Date.now();
  await okPost(
    "/v1/browsers/contexts/resize",
    { target: tA, contextId: ctx, width: 390, height: 640, mode: "phone" },
    "resize phone",
  );
  let phone = null;
  for (let i = 0; i < 50 && !phone; i++) {
    await sleep(100);
    phone = w.out.jpegs.find((f) => {
      const s = f.at >= since ? jpegSize(f.jpeg) : null;
      return s?.width === 390 && s?.height === 640;
    });
  }
  ok(Boolean(phone), "frames at 390x640 after a phone resize");
  ok(await waitText(tA, ctx, "Layout: phone"), "the page laid out for a phone");
  await okPost(
    "/v1/browsers/contexts/resize",
    { target: tA, contextId: ctx, width: 960, height: 600 },
    "resize small",
  );
  await w.stop();

  log("== two bots: B's browser egress is off; A reaches nothing of B's");
  const statusB = await okPost("/v1/browsers/ensure", { target: tB }, "browserEnsure B");
  ok(statusB.state === "running", "B's browser is running");
  await okPost("/v1/sandboxes/ensure", { target: tB }, "ensure sbx B");
  const ctxB = await openContext(tB);
  const navB = await navigate(tB, ctxB, `http://${PANEL}/app`);
  ok(
    navB.status === 422 && codeOf(navB) === "navigation_refused",
    `B (browser egress off) cannot navigate (${codeOf(navB)})`,
  );
  const refusedB = await waitEvent(
    (e) => e.type === "egress" && e.target.agentId === B && e.kind === "brw" && e.host === "panel.fake.test",
  );
  ok(refusedB?.allowed === false, "an egress event: refused for B's browser");

  const bSbxIp = ipOn(nameFor("sbx", B), nameFor("net", B));
  const bBrwIp = ipOn(nameFor("brw", B), nameFor("bnet", B));
  const proxyOnB = ipOn(EGRESS, nameFor("net", B));
  const aSbxIp = ipOn(nameFor("sbx", A), nameFor("net", A));
  const reach = (from, ip, port) =>
    docker(
      "exec",
      from,
      "node",
      "-e",
      `const s=require("net").connect(${port},"${ip}");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),3000);`,
    ).status === 0;
  ok(!reach(nameFor("brw", A), bSbxIp, 8080), `A's brw cannot connect to B's sbx (${bSbxIp})`);
  ok(!reach(nameFor("brw", A), bBrwIp, 9), `A's brw cannot connect to B's brw (${bBrwIp})`);
  ok(!reach(nameFor("brw", A), aSbxIp, 8080), "A's brw cannot connect to A's own sbx (separate networks)");

  // The single shared hop: listed private hosts that are B's container or the proxy itself stay refused.
  orgPolicy = policy(ORG, {
    allowHosts: [PANEL, `${bSbxIp}:8080`, `${proxyOnB}:3128`],
    privateHosts: [PANEL, IDP, `${bSbxIp}:8080`, `${proxyOnB}:3128`],
    version: ++orgVersion,
  });
  await okPost("/v1/policy", orgPolicy, "policy A v3");
  const toB = await viaProxy(tA, `http://${bSbxIp}:8080/`);
  ok(
    toB.code === "403" && toB.reason === "bot_network",
    `A's sbx → B's sbx through the proxy (${toB.code} ${toB.reason})`,
  );
  const toProxy = await viaProxy(tA, `http://${proxyOnB}:3128/`);
  ok(
    toProxy.code === "403" && toProxy.reason === "proxy_self",
    `A's sbx → the proxy on B's network (${toProxy.code} ${toProxy.reason})`,
  );
  const refusedA = await waitEvent((e) => e.type === "egress" && e.target.agentId === A && e.host === bSbxIp);
  ok(refusedA?.allowed === false, "an egress event: refused for A's shell");

  log("== site lock (D-13): blocked, then one approved navigation passes");
  orgPolicy = policy(ORG, { allowHosts: [PANEL], privateHosts: [PANEL, IDP, EVIL], version: ++orgVersion });
  await okPost("/v1/policy", orgPolicy, "policy A v4");
  const locked = await openContext(tA, { siteLock: PANEL });
  await navigate(tA, locked, `http://${PANEL}/lock`);
  const lockSnap = await snapshot(tA, locked);
  const exportRef = findNode(lockSnap, "link", "Export")?.ref;
  const collectBefore = fakeStats().collect;
  const blocked = await okPost(
    "/v1/browsers/contexts/act",
    { target: tA, contextId: locked, action: "click", ref: exportRef },
    "act blocked",
  );
  ok(
    blocked.blockedNavigation?.host === EVIL,
    `the lock blocked ${JSON.stringify(blocked.blockedNavigation)}`,
  );
  ok(fakeStats().collect === collectBefore, "the blocked host was never reached");
  const passed = await okPost(
    "/v1/browsers/contexts/act",
    { target: tA, contextId: locked, action: "click", ref: exportRef, allowCrossSite: true },
    "act allowCrossSite",
  );
  ok(
    passed.navigated === true && passed.blockedNavigation === null,
    "allowCrossSite lets that one navigation through",
  );
  ok(fakeStats().collect === collectBefore + 1, "the approved navigation reached the other host once");

  log("== restart: a new sandboxd re-attaches to the running browser");
  const startedAt = inspect(nameFor("brw", A)).State.StartedAt;
  await stopSandboxd();
  await startSandboxd();
  const info0 = await api("GET", "/v1/info");
  ok(info0.body?.browserSandbox === null, "a new sandboxd reports no posture before a browser is seen");
  const missing = await post("/v1/browsers/ensure", { target: tA });
  ok(
    missing.status === 409 && codeOf(missing) === "policy_missing",
    `no policy after the restart → ${codeOf(missing)}`,
  );
  await okPost("/v1/policy", orgPolicy, "policy A again");
  await okPost("/v1/policy", policy(ORG_B, { browserEgress: "off" }), "policy B again");
  const again = await okPost("/v1/browsers/ensure", { target: tA }, "browserEnsure A after restart");
  ok(
    again.browserSandbox === posture,
    `the re-attached browser reports the same posture (${again.browserSandbox})`,
  );
  ok(
    inspect(nameFor("brw", A)).State.StartedAt === startedAt,
    "the running brw was re-attached, not restarted",
  );
  const ctx2 = await openContext(tA);
  const nav2 = await navigate(tA, ctx2, `http://${PANEL}/app`);
  ok(
    nav2.status === 200 && nav2.body.host === PANEL,
    "a new context works after the restart (the proxy policy too)",
  );
  ok((await api("GET", "/v1/info")).body?.browserSandbox === posture, "info reports the posture again");

  log("== kill switch: killOrg stops every sbx and brw of the organization");
  const killed = await okPost("/v1/orgs/kill", { orgId: ORG }, "killOrg");
  ok(killed.removed >= 2, `killOrg removed ${killed.removed}`);
  ok(inspect(nameFor("sbx", A)).State.Running === false, "A's sbx is stopped");
  ok(inspect(nameFor("brw", A)).State.Running === false, "A's brw is stopped");
  ok(inspect(nameFor("brw", B)).State.Running === true, "the other organization's browser still runs");
  ok(inspect(EGRESS).State.Running === true, "the namespace's proxy is untouched by an organization's kill");
  const killedEv = await waitEvent(
    (e) => e.type === "state" && e.kind === "brw" && e.target.agentId === A && e.state === "killed",
  );
  ok(Boolean(killedEv), "a killed state event for A's browser");
  orgPolicy = policy(ORG, { killed: true, version: ++orgVersion });
  await okPost("/v1/policy", orgPolicy, "policy A killed");
  const refused = await post("/v1/browsers/ensure", { target: tA });
  ok(
    refused.status === 409 && codeOf(refused) === "killed",
    `a killed organization's browser does not start (${codeOf(refused)})`,
  );
}

/**
 * 07.8 hardening (07.8-28 candidate 1): a fresh brw's first contextOpen, sent right after browserEnsure answered, as
 * the API sends it. Each round is a new organization and bot (a fresh container), purged afterwards.
 */
async function stepColdstart() {
  const rounds = Number(process.env.STACK_COLDSTARTS ?? 8);
  log(`== coldstart: ${rounds} fresh browsers, the first open right after ensure`);
  const results = [];
  for (let i = 0; i < rounds; i++) {
    const t = { orgId: randomUUID(), agentId: randomUUID() };
    await okPost("/v1/policy", policy(t.orgId), `policy coldstart ${i}`);
    let started = Date.now();
    const ensured = await post("/v1/browsers/ensure", { target: t });
    const ensureMs = Date.now() - started;
    started = Date.now();
    let open = { status: 0, body: null };
    try {
      open = await api(
        "POST",
        "/v1/browsers/contexts/open",
        { target: t, contextId: randomUUID(), viewport },
        15_000,
      );
    } catch (err) {
      open = { status: 0, body: { error: { code: err?.name ?? "error" } } };
    }
    const openMs = Date.now() - started;
    results.push({ ensure: ensured.status, ensureMs, open: open.status, openMs });
    log(
      `   round ${i + 1}: ensure ${ensured.status} in ${ensureMs} ms; first open ${open.status} ${codeOf(open)} in ${openMs} ms`,
    );
    // Purged, so the rounds never run the daemon out of network address pools.
    await okPost("/v1/sandboxes/purge", { target: t }, `purge coldstart ${i}`);
  }
  const bad = results.filter((r) => r.ensure !== 200 || r.open !== 200);
  ok(
    bad.length === 0,
    `every fresh brw answered its first open within 15 s (${rounds - bad.length}/${rounds})`,
  );
  const slowest = Math.max(...results.map((r) => r.openMs));
  ok(slowest < 15_000, `the slowest first open took ${slowest} ms`);
}

function noSecretsLeaked() {
  const text = readFileSync(LOG, "utf8") + JSON.stringify(seen);
  for (const [k, v] of Object.entries(SECRETS))
    ok(!text.includes(v), `the ${k} is in no sandboxd log line or event`);
  ok(
    !/\/login|\/files|__stats|report\.csv/.test(JSON.stringify(seen.filter((e) => e.type === "egress"))),
    "egress events carry hosts only",
  );
}

try {
  await setup();
  if (ONLY === "coldstart") await stepColdstart();
  else {
    await stepOpen();
    if (ONLY === "all") await stepFull();
  }
  noSecretsLeaked();
} catch (err) {
  failures += 1;
  log(`FAIL ${err?.stack ?? err}`);
} finally {
  await stopSandboxd();
}
appendFileSync(join(WORK, "result"), `${checks} ${failures}\n`);
log(`${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
