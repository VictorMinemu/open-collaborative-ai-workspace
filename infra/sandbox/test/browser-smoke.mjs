// Drives the brw agent over its stdio from the host (`docker run -i`), as sandboxd will (07.8-07). Started by
// run-browser-smoke.sh, which builds the image and the fake sites and cleans up by label.
//   node browser-smoke.mjs --image <img> --network <net> --ns <ns> --fake <container> --seccomp <file> [--only <step>]
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { LOGIN_LAYOUT } from "./fake-site.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const IMAGE = opt("--image");
const NET = opt("--network");
const NS = opt("--ns");
const FAKE = opt("--fake");
const SECCOMP = opt("--seccomp");
const ONLY = opt("--only");
const STEPS = ["open", "masking", "state", "downloads", "resize", "lock", "errors", "fixtures"];
if (!IMAGE || !NET || !NS || !FAKE || !SECCOMP)
  throw new Error("missing arguments (run run-browser-smoke.sh)");
if (ONLY && !STEPS.includes(ONLY)) throw new Error(`--only ${ONLY}: one of ${STEPS.join("|")}`);

const PANEL = "panel.fake.test:8080";
const EVIL = "evil.fake.test:8080";
/** The E1 secrets: none may ever appear in anything the agent writes. */
const SECRETS = {
  username: "ana@example.test",
  password: "S3cr3t-Hunter2-OCW",
  otp: "735190",
  revealed: "Visible-Secret-99",
};

const FIXTURES_DIR = join(HERE, "..", "..", "fake-model", "fixtures", "sandbox", "frames");

const log = (line) => process.stderr.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const res = spawnSync("docker", a, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`docker ${a[0]} failed: ${res.stderr.trim()}`);
  return res.stdout;
};
const fakeStats = () =>
  JSON.parse(
    docker(
      "exec",
      FAKE,
      "node",
      "-e",
      'fetch("http://127.0.0.1:8080/__stats").then((r) => r.text()).then((t) => process.stdout.write(t))',
    ),
  );

// ---------------------------------------------------------------- the agent over stdio

/** The hardened run of sandboxd's spec (07.8-RESEARCH.md §3, spike i): never a published port, never host IPC. */
const HARDENED = [
  "--user",
  "10001:10001",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--init",
  "--pids-limit",
  "512",
  "--memory",
  "2g",
  "--memory-swap",
  "2g",
  "--cpus",
  "1",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev,size=256m",
  "--shm-size",
  "512m",
];

class Agent {
  /** `seccomp`: the profile file, or null for Docker's default; `runtime`: the OCW_BROWSER_RUNTIME the agent gets. */
  constructor({ name = "brw", seccomp = SECCOMP, runtime = "runc" } = {}) {
    this.name = `${NS}-${name}`;
    this.out = [];
    this.err = "";
    this.frames = [];
    this.events = [];
    this.pending = new Map();
    this.waiters = [];
    this.nextId = 1;
    this.buf = Buffer.alloc(0);
    this.proc = spawn(
      "docker",
      [
        "run",
        "-i",
        "--rm",
        "--name",
        this.name,
        "--label",
        `ocw.namespace=${NS}`,
        ...HARDENED,
        ...(seccomp ? ["--security-opt", `seccomp=${seccomp}`] : []),
        "--network",
        NET,
        "-e",
        `OCW_BROWSER_RUNTIME=${runtime}`,
        IMAGE,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.proc.stdout.on("data", (c) => this.onData(c));
    this.proc.stderr.on("data", (c) => {
      this.err += c.toString("utf8");
    });
    this.exited = new Promise((r) => this.proc.on("exit", (code) => r(code)));
  }

  onData(chunk) {
    this.out.push(chunk);
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(0);
      const type = this.buf[4];
      if (this.buf.length < 5 + len) break;
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (type === 0) {
        const n = payload[0];
        this.frames.push({
          contextId: payload.subarray(1, 1 + n).toString("ascii"),
          jpeg: Buffer.from(payload.subarray(1 + n)),
          at: Date.now(),
        });
      } else if (type === 1) {
        const msg = JSON.parse(payload.toString("utf8"));
        if (msg.event) {
          this.events.push({ ...msg, at: Date.now() });
          this.waiters = this.waiters.filter((w) => {
            if (!w.pred(msg)) return true;
            w.resolve(msg);
            return false;
          });
        } else {
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        }
      } else {
        throw new Error(`unknown frame type ${type}`);
      }
    }
  }

  event(pred, timeoutMs = 60_000) {
    const seen = this.events.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => reject(new Error("timed out waiting for an agent event")), timeoutMs).unref();
    });
  }

  /** `{ ok, result, error }` of one op. */
  call(op, input = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timed out waiting for ${op}`)), timeoutMs).unref();
      this.proc.stdin.write(
        `${JSON.stringify({ id, op, target: { orgId: randomUUID(), agentId: randomUUID() }, ...input })}\n`,
      );
    });
  }

  async ok(op, input) {
    const res = await this.call(op, input);
    assert.equal(res.ok, true, `${op} failed: ${JSON.stringify(res.error)}`);
    return res.result;
  }

  framesOf(contextId, since = 0) {
    return this.frames.filter((f) => f.contextId === contextId && f.at >= since);
  }

  async frame(contextId, since, timeoutMs = 2_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const f = this.framesOf(contextId, since);
      if (f.length > 0) return f[0];
      await sleep(25);
    }
    throw new Error(`no frame for ${contextId} within ${timeoutMs} ms`);
  }

  /** The newest frame once the page has been still for `settleMs`. */
  async latestFrame(contextId, since, settleMs = 800) {
    await sleep(settleMs);
    const f = this.framesOf(contextId, since);
    if (f.length === 0) throw new Error("no frame");
    return f.at(-1);
  }

  async stop() {
    this.proc.stdin.end();
    const code = await Promise.race([this.exited, sleep(15_000).then(() => "timeout")]);
    if (code === "timeout") spawnSync("docker", ["rm", "-f", this.name]);
  }

  /** Everything the agent wrote: stdout bytes (responses, events, frames) and stderr. */
  transcript() {
    return { stdout: Buffer.concat(this.out), stderr: this.err };
  }
}

// ---------------------------------------------------------------- image helpers

export function jpegSize(buf) {
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

/** A minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what Chromium writes) → { width, height, rgba }. */
export function decodePng(buf) {
  assert.equal(buf.subarray(1, 4).toString("ascii"), "PNG");
  let i = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("ascii");
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8-bit PNG");
      colorType = data[9];
      assert.equal(data[12], 0, "non-interlaced PNG");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    i += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(bpp > 0, `PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = (line[x] + add) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      out[(y * width + x) * 4] = line[x * bpp];
      out[(y * width + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

// ---------------------------------------------------------------- snapshot helpers

const findNode = (snap, role, name) => snap.nodes.find((n) => n.role === role && n.name === name);

const refOf = (snap, role, name) => {
  const n = findNode(snap, role, name);
  assert.ok(n, `snapshot has ${role} "${name}"`);
  return n.ref;
};

async function open(agent, extra = {}) {
  const contextId = randomUUID();
  await agent.ok("contextOpen", { contextId, viewport: { width: 960, height: 600 }, ...extra });
  return contextId;
}

// ---------------------------------------------------------------- steps

const steps = {};

steps.open = async (agent) => {
  const ready = await agent.event((e) => e.event === "ready");
  assert.ok(["chromium", "container-only", "chromium+gvisor"].includes(ready.browserSandbox));
  const info = await agent.ok("info");
  assert.equal(info.browserVersion, "156.0.8078.47");
  log(`   runtime ${info.runtime}, browserSandbox ${info.browserSandbox}, Chromium ${info.browserVersion}`);

  const ctx = await open(agent);
  const nav = await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/app` });
  assert.equal(nav.host, PANEL);
  assert.equal(nav.blockedNavigation, null);
  const navigated = await agent.event((e) => e.event === "navigated" && e.contextId === ctx);
  assert.deepEqual(Object.keys(navigated).sort(), ["at", "contextId", "event", "host", "secure"]);
  assert.equal(navigated.host, PANEL, "the navigated event names the host only");

  // The app's HTML has no text: "Sign in" exists only after its JavaScript ran (a real engine, unlike web_fetch).
  await agent.ok("contextWait", { contextId: ctx, for: "text", text: "Sign in", ms: 10_000 }).catch(() => {});
  const snap = await agent.ok("contextSnapshot", { contextId: ctx });
  assert.equal(snap.host, PANEL);
  assert.ok(findNode(snap, "heading", "Sign in"), "the JS-rendered Sign in state");

  const since = Date.now();
  await agent.ok("contextFrames", { contextId: ctx, on: true });
  const f = await agent.frame(ctx, since, 2_000);
  const size = jpegSize(f.jpeg);
  assert.ok(size && size.width <= 960 && size.height <= 600, `frame ${JSON.stringify(size)} within 960x600`);
  await agent.ok("contextFrames", { contextId: ctx, on: false });

  // No listening TCP socket in the container (Chromium is driven over a pipe). The one exception is Docker's own
  // embedded DNS resolver of a user-defined network, which dockerd binds on 127.0.0.11 inside the namespace.
  const listening = docker(
    "exec",
    agent.name,
    "node",
    "-e",
    `const fs = require("fs"); let n = 0;
     for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
       try {
         for (const l of fs.readFileSync(f, "utf8").split("\\n").slice(1)) {
           const [, local, , state] = l.trim().split(/\\s+/);
           if (state === "0A" && !local.startsWith("0B00007F:")) n++;
         }
       } catch {}
     }
     process.stdout.write(String(n));`,
  );
  assert.equal(listening, "0", "no listening TCP port");
  const cmdlines = docker(
    "exec",
    agent.name,
    "sh",
    "-c",
    "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done",
  );
  assert.match(cmdlines, /--remote-debugging-pipe/);
  assert.doesNotMatch(cmdlines, /--remote-debugging-port/);

  const [inspect] = JSON.parse(docker("inspect", agent.name));
  assert.equal(inspect.Config.User, "10001:10001");
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspect.HostConfig.CapDrop, ["ALL"]);
  assert.ok(inspect.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(inspect.HostConfig.ShmSize, 512 * 1024 * 1024);
  assert.equal(inspect.HostConfig.Init, true);
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.notEqual(inspect.HostConfig.IpcMode, "host");
  assert.deepEqual(inspect.HostConfig.PortBindings ?? {}, {});
  assert.equal(inspect.HostConfig.PublishAllPorts, false);

  await agent.ok("contextClose", { contextId: ctx });

  // D-14: with Docker's default seccomp profile Chromium has no usable sandbox. On runc the agent falls back and says
  // so (`container-only`); told it runs under gVisor, it refuses to start rather than fall back silently.
  const runc = new Agent({ name: "brw-default-seccomp", seccomp: null, runtime: "runc" });
  try {
    const r = await runc.event((e) => e.event === "ready" || e.event === "fatal", 90_000);
    assert.equal(r.event, "ready");
    assert.equal(r.browserSandbox, "container-only");
    // The structured diagnostics sandboxd forwards (07.8 hardening): the fallback is said, never silent.
    assert.match(runc.err, /\{"brw":1,"ev":"sandbox_fallback","t":\d+\}/);
    assert.match(runc.err, /"ev":"launched","t":\d+,"ms":\d+,"posture":"container-only","runtime":"runc"/);
  } finally {
    await runc.stop();
  }
  const runsc = new Agent({ name: "brw-runsc-claim", seccomp: null, runtime: "runsc" });
  try {
    const r = await runsc.event((e) => e.event === "ready" || e.event === "fatal", 90_000);
    assert.equal(r.event, "fatal", "no silent fallback under gVisor");
    assert.equal(await runsc.exited, 1);
    assert.match(
      runsc.err,
      /"ev":"launch_failed","t":\d+,"code":"launch_failed","reason":"no_usable_sandbox"/,
    );
  } finally {
    await runsc.stop();
  }
  log("   D-14: default seccomp on runc → container-only (reported); claimed runsc → refuses to start");
};

// ---------------------------------------------------------------- takeover input helpers

const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const clickAt = ({ x, y }) => [
  { type: "mouse", event: "move", x, y, button: "none" },
  { type: "mouse", event: "down", x, y, button: "left" },
  { type: "mouse", event: "up", x, y, button: "left" },
];
const PUNCT = { "@": "Digit2", "-": "Minus", ".": "Period", _: "Minus", " ": "Space" };
const codeOf = (ch) =>
  /[a-z]/i.test(ch)
    ? `Key${ch.toUpperCase()}`
    : /[0-9]/.test(ch)
      ? `Digit${ch}`
      : (PUNCT[ch] ?? "Unidentified");
const keyFrames = (s) =>
  [...s].flatMap((ch) => {
    const modifiers = /[A-Z@_]/.test(ch) ? 8 : 0;
    const code = codeOf(ch);
    return [
      { type: "key", event: "down", key: ch, code, modifiers },
      { type: "key", event: "up", key: ch, code, modifiers },
    ];
  });
const press = (key) => [
  { type: "key", event: "down", key, code: key, modifiers: 0 },
  { type: "key", event: "up", key, code: key, modifiers: 0 },
];

async function input(agent, contextId, events) {
  for (let i = 0; i < events.length; i += 64) {
    await agent.ok("contextInput", { contextId, events: events.slice(i, i + 64) });
  }
}

async function waitText(agent, contextId, text) {
  const r = await agent.ok("contextWait", { contextId, for: "text", text, ms: 15_000 });
  assert.equal(r.ok, true, `the page shows "${text}"`);
}

async function expectCode(agent, op, payload, code) {
  const res = await agent.call(op, payload);
  assert.equal(res.ok, false, `${op} must fail with ${code}`);
  assert.equal(res.error.code, code, `${op}: ${JSON.stringify(res.error)}`);
  return res.error;
}

/** Every pixel of `box` (CSS = image pixels at scale 1) is the mask colour. */
function assertMasked(png, box, label) {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const o = (y * png.width + x) * 4;
      const px = [png.rgba[o], png.rgba[o + 1], png.rgba[o + 2], png.rgba[o + 3]];
      if (px.join() !== "0,0,0,255")
        assert.fail(`${label}: pixel (${x},${y}) is ${px.join()}, not the mask colour`);
    }
  }
}

function assertNotMasked(png, box) {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const o = (y * png.width + x) * 4;
      if (png.rgba[o] + png.rgba[o + 1] + png.rgba[o + 2] < 600)
        assert.fail(`pixel (${x},${y}) is not background`);
    }
  }
}

// ---------------------------------------------------------------- E1: takeover typing never reaches the bot

steps.masking = async (agent) => {
  const ctx = await open(agent);
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/login` });
  await agent.ok("contextFrames", { contextId: ctx, on: true });
  const before = await agent.ok("contextSnapshot", { contextId: ctx });
  assert.equal(
    findNode(before, "textbox", "Email").redacted,
    false,
    "an untouched email field is not redacted",
  );

  await agent.ok("contextTakeover", { contextId: ctx, active: true });
  // While a person holds the page, the bot's operations answer `paused`.
  await expectCode(agent, "contextSnapshot", { contextId: ctx }, "paused");
  await expectCode(agent, "contextScreenshot", { contextId: ctx }, "paused");
  await expectCode(agent, "contextAct", { contextId: ctx, action: "press", key: "Tab" }, "paused");
  await expectCode(agent, "contextNavigate", { contextId: ctx, url: `http://${PANEL}/app` }, "paused");

  const L = LOGIN_LAYOUT;
  await input(agent, ctx, [...clickAt(center(L.email)), ...keyFrames(SECRETS.username)]);
  await input(agent, ctx, [...clickAt(center(L.password)), ...keyFrames(SECRETS.password)]);
  await input(agent, ctx, [...clickAt(center(L.otp)), { type: "text", text: SECRETS.otp }]);
  // Show the password, then append to the now-plain-text field.
  await input(agent, ctx, clickAt(center(L.toggle)));
  await input(agent, ctx, [
    ...clickAt({ x: L.password.x + L.password.width - 12, y: center(L.password).y }),
    ...press("End"),
    ...keyFrames(SECRETS.revealed),
  ]);
  await agent.ok("contextTakeover", { contextId: ctx, active: false });
  const focus = agent.events.filter((e) => e.event === "focus" && e.contextId === ctx);
  assert.ok(
    focus.some((e) => e.sensitive === true),
    "a focus event flags the password field",
  );
  assert.ok(focus.every((e) => Object.keys(e).sort().join() === "at,contextId,event,sensitive"));

  const snap = await agent.ok("contextSnapshot", { contextId: ctx });
  for (const name of ["Email", "Password", "One-time code"]) {
    const node = findNode(snap, "textbox", name);
    assert.ok(node, `the ${name} field is in the snapshot`);
    assert.equal(node.redacted, true, `${name} is redacted`);
    assert.equal(node.value, "[redacted]");
  }
  assert.ok(
    findNode(snap, "button", "Hide password"),
    "the toggle was pressed (the field is plain text now)",
  );
  const snapJson = JSON.stringify(snap);
  for (const [label, secret] of Object.entries(SECRETS)) {
    assert.equal(snapJson.includes(secret), false, `the snapshot carries no ${label}`);
  }

  // A text wait is matched against the redacted snapshot, so it is no oracle for typed values either.
  for (const [label, secret] of Object.entries(SECRETS)) {
    const w = await agent.ok("contextWait", { contextId: ctx, for: "text", text: secret, ms: 300 });
    assert.equal(w.ok, false, `waiting for the ${label} finds nothing`);
  }
  assert.equal(
    (await agent.ok("contextWait", { contextId: ctx, for: "text", text: "Sign in to Panel" })).ok,
    true,
  );

  const shot = await agent.ok("contextScreenshot", { contextId: ctx, format: "png" });
  assert.equal(shot.mimeType, "image/png");
  assert.ok(shot.masked >= 3, `masked ${shot.masked}`);
  const png = decodePng(Buffer.from(shot.data, "base64"));
  assert.equal(png.width, 960);
  for (const field of ["email", "password", "otp"]) {
    const b = L[field];
    assert.ok(
      shot.maskRects.some(
        (r) => r.x <= b.x && r.y <= b.y && r.x + r.width >= b.x + b.width && r.y + r.height >= b.y + b.height,
      ),
      `a mask rect covers the ${field} field`,
    );
    assertMasked(png, b, field);
  }
  // The rest of the page is still there: the unmasked strip right of the fields is the page's white background.
  assertNotMasked(png, { x: 600, y: 120, width: 300, height: 200 });
  const jpeg = await agent.ok("contextScreenshot", { contextId: ctx });
  assert.equal(jpeg.mimeType, "image/jpeg");
  assert.ok(jpeg.masked >= 3);

  // The person's input reached the page: the form posts and the app signs in.
  await agent.ok("contextTakeover", { contextId: ctx, active: true });
  await input(agent, ctx, clickAt(center(L.submit)));
  await sleep(1_500);
  await agent.ok("contextTakeover", { contextId: ctx, active: false });
  await waitText(agent, ctx, "Welcome");
  const after = await agent.ok("contextSnapshot", { contextId: ctx });
  assert.ok(findNode(after, "heading", "Welcome"));
  const stats = fakeStats();
  assert.equal(stats.logins, 1, "the fake site received the login");
  assert.equal(stats.failedLogins, 0);
  await agent.ok("contextFrames", { contextId: ctx, on: false });
  await agent.ok("contextClose", { contextId: ctx });
};

// ---------------------------------------------------------------- storage state (D-08, P-09)

steps.state = async (agent) => {
  const ctx = await open(agent);
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/app` });
  await waitText(agent, ctx, "Sign in");
  const snap = await agent.ok("contextSnapshot", { contextId: ctx });
  const res = await agent.ok("contextAct", {
    contextId: ctx,
    action: "click",
    ref: refOf(snap, "link", "Sign in with IdP"),
  });
  assert.equal(res.navigated, true);
  await waitText(agent, ctx, "Welcome");
  assert.ok(fakeStats().idp >= 1, "the IdP round trip happened");

  const { storageState } = await agent.ok("contextExportState", { contextId: ctx });
  const state = JSON.parse(storageState);
  const names = state.cookies.map((c) => c.name);
  assert.ok(names.includes("panel_session"), "the site's session cookie is kept");
  assert.equal(names.includes("idp_session"), false, "the identity provider's cookie is dropped");
  assert.ok(state.cookies.every((c) => c.domain.replace(/^\./, "") === "panel.fake.test"));
  assert.deepEqual(
    state.origins.map((o) => o.origin),
    [`http://${PANEL}`],
  );
  assert.ok(state.origins[0].localStorage.some((i) => i.name === "panel_pref"));
  // 07.8-21 (D-13): the page a person signed in to by hand is site-locked in place before the bot continues on it.
  await agent.ok("contextLock", {
    contextId: ctx,
    memberId: "33333333-3333-4333-8333-333333333333",
    siteLock: PANEL,
  });
  const locked = await agent.ok("contextNavigate", { contextId: ctx, url: `http://${EVIL}/landing` });
  assert.deepEqual(locked.blockedNavigation, { host: EVIL }, "a locked sign-in page cannot leave its site");
  assert.equal(locked.host, PANEL);
  assert.equal(
    (
      await agent.call("contextLock", {
        contextId: ctx,
        memberId: "33333333-3333-4333-8333-333333333333",
        siteLock: EVIL,
      })
    ).ok,
    false,
  );
  await agent.ok("contextClose", { contextId: ctx });

  const again = await open(agent, { storageState, siteLock: PANEL });
  await agent.ok("contextNavigate", { contextId: again, url: `http://${PANEL}/app` });
  await waitText(agent, again, "Welcome");
  assert.ok(findNode(await agent.ok("contextSnapshot", { contextId: again }), "heading", "Welcome"));
  await agent.ok("contextClose", { contextId: again });
};

// ---------------------------------------------------------------- downloads

steps.downloads = async (agent) => {
  const ctx = await open(agent);
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/files` });
  const snap = await agent.ok("contextSnapshot", { contextId: ctx });
  const res = await agent.ok("contextAct", {
    contextId: ctx,
    action: "click",
    ref: refOf(snap, "link", "Download report"),
  });
  assert.ok(res.download, "the click downloaded a file");
  assert.equal(res.download.name, "report.csv");
  assert.match(res.download.token, /^[A-Za-z0-9_-]{16,128}$/);
  const ev = await agent.event((e) => e.event === "download" && e.contextId === ctx);
  assert.deepEqual({ name: ev.name, size: ev.size, token: ev.token }, res.download);
  const onDisk = docker(
    "exec",
    agent.name,
    "stat",
    "-c",
    "%s",
    `/tmp/downloads/${res.download.token}`,
  ).trim();
  assert.equal(Number(onDisk), res.download.size);
  const file = await agent.ok("contextDownload", { contextId: ctx, token: res.download.token });
  const data = Buffer.from(file.data, "base64");
  assert.equal(data.length, res.download.size);
  assert.ok(data.toString("utf8").startsWith("row-000,"));
  assert.equal(file.mimeType, "text/csv");
  await agent.ok("contextClose", { contextId: ctx });
  const gone = spawnSync("docker", [
    "exec",
    agent.name,
    "test",
    "-e",
    `/tmp/downloads/${res.download.token}`,
  ]);
  assert.notEqual(gone.status, 0, "closing the context removes its downloads");
};

// ---------------------------------------------------------------- resize (R10)

async function frameOfSize(agent, ctx, since, w, h) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const f = agent.framesOf(ctx, since).find((x) => {
      const s = jpegSize(x.jpeg);
      return s && s.width === w && s.height === h;
    });
    if (f) return f;
    await sleep(50);
  }
  throw new Error(`no ${w}x${h} frame`);
}

steps.resize = async (agent) => {
  const ctx = await open(agent);
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/app` });
  await waitText(agent, ctx, "Layout: desktop");
  await agent.ok("contextFrames", { contextId: ctx, on: true });
  let since = Date.now();
  await agent.ok("contextResize", { contextId: ctx, mode: "phone", width: 390, height: 640 });
  await frameOfSize(agent, ctx, since, 390, 640);
  await waitText(agent, ctx, "Layout: phone");
  assert.match((await agent.ok("contextSnapshot", { contextId: ctx })).text, /Layout: phone/);
  since = Date.now();
  await agent.ok("contextResize", { contextId: ctx, mode: "small" });
  await frameOfSize(agent, ctx, since, 960, 600);
  await waitText(agent, ctx, "Layout: desktop");
  await agent.ok("contextFrames", { contextId: ctx, on: false });
  await agent.ok("contextClose", { contextId: ctx });
};

// ---------------------------------------------------------------- site lock (D-13, P-18)

steps.lock = async (agent) => {
  const ctx = await open(agent, { siteLock: PANEL });
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/lock` });
  for (const [role, name] of [
    ["link", "Export"],
    ["button", "Send"],
    ["button", "Redirect"],
    ["button", "Pop-up"],
  ]) {
    const snap = await agent.ok("contextSnapshot", { contextId: ctx });
    const res = await agent.ok("contextAct", {
      contextId: ctx,
      action: "click",
      ref: refOf(snap, role, name),
    });
    assert.deepEqual(res.blockedNavigation, { host: EVIL }, `${name} is blocked`);
    const after = await agent.ok("contextSnapshot", { contextId: ctx });
    assert.equal(after.host, PANEL, `${name}: the page stays on the site`);
    assert.equal(after.title, "Lock test");
  }
  const blockedEvents = agent.events.filter((e) => e.event === "blockedNavigation" && e.contextId === ctx);
  assert.ok(blockedEvents.length >= 4);
  assert.ok(
    blockedEvents.every((e) => e.host === EVIL && Object.keys(e).sort().join() === "at,contextId,event,host"),
  );
  assert.equal(fakeStats().collect, 0, "nothing reached evil.fake.test/collect");

  const refused = await agent.ok("contextNavigate", { contextId: ctx, url: `http://${EVIL}/landing` });
  assert.deepEqual(refused.blockedNavigation, { host: EVIL });
  assert.equal(refused.host, PANEL);
  const allowed = await agent.ok("contextNavigate", {
    contextId: ctx,
    url: `http://${EVIL}/landing`,
    allowCrossSite: true,
  });
  assert.equal(allowed.host, EVIL);
  assert.equal(allowed.blockedNavigation, null);
  assert.equal(allowed.title, "Evil landing");
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/lock` });
  const snap = await agent.ok("contextSnapshot", { contextId: ctx });
  const again = await agent.ok("contextAct", {
    contextId: ctx,
    action: "click",
    ref: refOf(snap, "link", "Export"),
  });
  assert.deepEqual(again.blockedNavigation, { host: EVIL }, "the approval passed exactly once");
  assert.equal(fakeStats().collect, 0);
  await agent.ok("contextClose", { contextId: ctx });
};

// ---------------------------------------------------------------- error codes carry no page text

steps.errors = async (agent) => {
  const ctx = await open(agent);
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/lock` });
  const snap = await agent.ok("contextSnapshot", { contextId: ctx });
  await expectCode(agent, "contextAct", { contextId: ctx, action: "click", ref: "e999999" }, "element_gone");
  const err = await expectCode(
    agent,
    "contextAct",
    { contextId: ctx, action: "type", ref: refOf(snap, "heading", "Lock test"), text: "x" },
    "invalid_request",
  );
  assert.equal(err.message.includes("Lock"), false, "no page text in an error");
  await expectCode(agent, "contextSnapshot", { contextId: randomUUID() }, "no_context");
  await expectCode(agent, "contextDownload", { contextId: ctx, token: "a".repeat(32) }, "not_found");
  await expectCode(agent, "contextInput", { contextId: ctx, events: press("a") }, "invalid_request");
  await expectCode(agent, "evaluate", { contextId: ctx, expression: "document.cookie" }, "invalid_request");
  await agent.ok("contextClose", { contextId: ctx });
};

// ---------------------------------------------------------------- UI frame fixtures (CAPTURE_FIXTURES=1)

steps.fixtures = async (agent) => {
  const ctx = await open(agent);
  await agent.ok("contextFrames", { contextId: ctx, on: true });
  const shots = {};
  let since = Date.now();
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/app` });
  await waitText(agent, ctx, "Sign in");
  shots["logged-out"] = await agent.latestFrame(ctx, since);
  since = Date.now();
  await agent.ok("contextNavigate", { contextId: ctx, url: `http://${PANEL}/login` });
  shots["login-form"] = await agent.latestFrame(ctx, since);
  await agent.ok("contextTakeover", { contextId: ctx, active: true });
  const L = LOGIN_LAYOUT;
  await input(agent, ctx, [...clickAt(center(L.email)), ...keyFrames(SECRETS.username)]);
  since = Date.now();
  await input(agent, ctx, [...clickAt(center(L.password)), ...keyFrames(SECRETS.password.slice(0, 9))]);
  shots.typing = await agent.latestFrame(ctx, since);
  await input(agent, ctx, [
    ...keyFrames(SECRETS.password.slice(9)),
    ...clickAt(center(L.otp)),
    { type: "text", text: SECRETS.otp },
    ...clickAt(center(L.submit)),
  ]);
  await sleep(1_500);
  await agent.ok("contextTakeover", { contextId: ctx, active: false });
  since = Date.now();
  await waitText(agent, ctx, "Welcome");
  shots["signed-in"] = agent.framesOf(ctx, since).at(-1) ?? (await agent.latestFrame(ctx, since - 2_000));
  await agent.ok("contextFrames", { contextId: ctx, on: false });
  await agent.ok("contextClose", { contextId: ctx });

  for (const [name, f] of Object.entries(shots)) {
    assert.ok(f.jpeg.length < 120 * 1024, `${name} is under 120 KB`);
    const size = jpegSize(f.jpeg);
    assert.deepEqual(size, { width: 960, height: 600 });
  }
  if (process.env.CAPTURE_FIXTURES === "1") {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    for (const [name, f] of Object.entries(shots)) writeFileSync(join(FIXTURES_DIR, `${name}.jpg`), f.jpeg);
    log(`   wrote ${Object.keys(shots).length} frames to ${FIXTURES_DIR}`);
  }
};

// ---------------------------------------------------------------- main

const selected = ONLY
  ? [ONLY]
  : STEPS.filter((s) => s !== "fixtures" || process.env.CAPTURE_FIXTURES === "1");
const agent = new Agent();
let failed = false;
try {
  await agent.event((e) => e.event === "ready" || e.event === "fatal", 90_000);
  const fatal = agent.events.find((e) => e.event === "fatal");
  if (fatal) throw new Error(`agent did not start: ${JSON.stringify(fatal)}\n${agent.err}`);
  for (const step of selected) {
    if (!steps[step]) throw new Error(`step ${step} is not implemented`);
    log(`== ${step}`);
    await steps[step](agent);
    log(`   ok`);
  }
} catch (err) {
  failed = true;
  log(`FAIL: ${err?.stack ?? err}`);
  log(`agent stderr:\n${agent.err}`);
} finally {
  await agent.stop();
}
// The E1 transcript check runs on every run: nothing the agent wrote may carry a typed secret.
const { stdout, stderr } = agent.transcript();
const text = `${stdout.toString("latin1")}\n${stdout.toString("utf8")}\n${stderr}`;
for (const [label, secret] of Object.entries(SECRETS)) {
  if (text.includes(secret)) {
    failed = true;
    log(`FAIL: the agent's output contains the ${label} secret`);
  }
}
log(failed ? "browser smoke FAILED" : `browser smoke passed (${selected.join(", ")})`);
process.exit(failed ? 1 : 0);
