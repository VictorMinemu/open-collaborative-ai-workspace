// The real-Docker stack smoke's driver (07.8-13), started by run-stack-smoke.sh after it built the images and the fake
// sites. It runs sandboxd as its own child process (a host process on 127.0.0.1 and a free port, so it can restart it)
// and drives it only through its HTTP API, as the API does; `docker` is used only to look at what sandboxd built.
//
//   node stack-smoke.mjs --ns <ns> --work <dir> --fixtures <net> --fake <container> --sbx <img> --brw <img>
//                        --egress <img> --seccomp <file> [--only open|all]
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
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
  await stepOpen();
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
