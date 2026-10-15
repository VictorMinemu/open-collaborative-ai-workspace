// Drives the brw agent over its stdio from the host (`docker run -i`), as sandboxd will (07.8-07). Started by
// run-browser-smoke.sh, which builds the image and the fake sites and cleans up by label.
//   node browser-smoke.mjs --image <img> --network <net> --ns <ns> --fake <container> --seccomp <file> [--only <step>]
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";

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
/** The E1 secrets: none may ever appear in anything the agent writes. */
const SECRETS = {
  username: "ana@example.test",
  password: "S3cr3t-Hunter2-OCW",
  otp: "735190",
  revealed: "Visible-Secret-99",
};

const log = (line) => process.stderr.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => {
  const res = spawnSync("docker", a, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`docker ${a[0]} failed: ${res.stderr.trim()}`);
  return res.stdout;
};
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
  assert.equal(info.browserVersion, "153.0.8010.12");
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
    assert.match(runc.err, /chromium sandbox unavailable on runc; running container-only/);
  } finally {
    await runc.stop();
  }
  const runsc = new Agent({ name: "brw-runsc-claim", seccomp: null, runtime: "runsc" });
  try {
    const r = await runsc.event((e) => e.event === "ready" || e.event === "fatal", 90_000);
    assert.equal(r.event, "fatal", "no silent fallback under gVisor");
    assert.equal(await runsc.exited, 1);
  } finally {
    await runsc.stop();
  }
  log("   D-14: default seccomp on runc → container-only (reported); claimed runsc → refuses to start");
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
