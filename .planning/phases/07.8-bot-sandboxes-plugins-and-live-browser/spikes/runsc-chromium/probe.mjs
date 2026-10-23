// Spike (i), 07.8-03: does Playwright 1.63's Chromium launch and screencast in this container, with or without its own
// sandbox? Throwaway. Prints one JSON line. Env: SPIKE_MODE (label only), CHROMIUM_SANDBOX=1|0.
// Chromium is launched over a pipe (Playwright's default for Chromium: --remote-debugging-pipe), never a port; the page
// is inline (page.setContent), no network. The password is typed through CDP Input.dispatchKeyEvent, as a takeover
// would; only its length is ever reported.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import os from "node:os";
import { chromium } from "playwright-core";

const mode = process.env.SPIKE_MODE ?? "?";
const sandbox = process.env.CHROMIUM_SANDBOX === "1";
const report = { mode, chromiumSandbox: sandbox, kernelRelease: os.release(), uid: process.getuid() };

const LOGIN = `<!doctype html><html><body style="font-family:sans-serif">
<h1>Sign in</h1><form><label>Email <input id="u" type="email" autocomplete="username"></label>
<label>Password <input id="p" type="password" autocomplete="current-password"></label><button>Go</button></form>
<div id="tick" style="width:40px;height:40px;background:#c40;animation:spin 0.5s linear infinite"></div>
<style>@keyframes spin{to{transform:rotate(360deg)}}</style></body></html>`;

function readProc(pid, file) {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch (e) {
    return `ERR:${e.code}`;
  }
}

// What the kernel (or gVisor's sentry) says about each Chromium process: type, seccomp mode, nested pid namespaces.
function chromiumProcesses() {
  const out = [];
  let rss = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    // Chromium rewrites its children's argv into one space-joined string (setproctitle): split on NUL and space.
    const cmd = readProc(pid, "cmdline").split(/[\0 ]/);
    if (!/chrom|headless_shell/.test(cmd[0] ?? "")) continue;
    const status = readProc(pid, "status");
    const field = (k) => (status.match(new RegExp(`^${k}:\\s*(.+)$`, "m")) ?? [])[1]?.trim() ?? null;
    const kb = Number.parseInt(field("VmRSS") ?? "0", 10);
    rss += Number.isFinite(kb) ? kb : 0;
    out.push({
      type: (cmd.find((a) => a.startsWith("--type=")) ?? "--type=browser").slice(7),
      seccomp: field("Seccomp"),
      nspid: field("NSpid"),
      noNewPrivs: field("NoNewPrivs"),
      // Same user / pid namespace as the probe? (renderers are non-dumpable, so EACCES is possible)
      userNs: nsLink(pid, "user"),
      pidNs: nsLink(pid, "pid"),
    });
  }
  return { processes: out, rssKiB: rss };
}

let selfNs;
function nsLink(pid, ns) {
  selfNs ??= { user: readlinkSafe("self", "user"), pid: readlinkSafe("self", "pid") };
  const v = readlinkSafe(pid, ns);
  return v.startsWith("ERR:") ? v : v === selfNs[ns] ? "same" : "other";
}
function readlinkSafe(pid, ns) {
  try {
    return readlinkSync(`/proc/${pid}/ns/${ns}`);
  } catch (e) {
    return `ERR:${e.code}`;
  }
}

// Inside gVisor, /proc/meminfo is the sentry's view of this sandbox; on runc it is the host's.
function meminfoUsedMiB() {
  const m = readFileSync("/proc/meminfo", "utf8");
  const kb = (k) => Number((m.match(new RegExp(`^${k}:\\s*(\\d+)`, "m")) ?? [])[1] ?? 0);
  return Math.round((kb("MemTotal") - kb("MemAvailable")) / 1024);
}

function cgroupMemory() {
  for (const f of ["/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory.max_usage_in_bytes"]) {
    try {
      return { file: f, bytes: Number(readFileSync(f, "utf8").trim()) };
    } catch {}
  }
  return null;
}

let browser;
try {
  const t0 = performance.now();
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: sandbox,
    timeout: 60_000,
    args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  });
  report.launchMs = Math.round(performance.now() - t0);
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const page = await context.newPage();
  await page.setContent(LOGIN);
  const cdp = await context.newCDPSession(page);

  // Type into the password field through CDP key events (a takeover's path).
  await page.focus("#p");
  const secret = "S3cr3t-Spike-078";
  for (const ch of secret) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
  report.typedLength = await page.$eval("#p", (el) => el.value.length);
  report.typedOk = report.typedLength === secret.length;

  // Screencast for 3 s, ack-paced, and count frames.
  let frames = 0;
  let bytes = 0;
  let size = null;
  cdp.on("Page.screencastFrame", async (f) => {
    frames += 1;
    bytes += Buffer.byteLength(f.data, "base64");
    size = { w: f.metadata.deviceWidth, h: f.metadata.deviceHeight };
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 960, maxHeight: 600 });
  const procsDuring = chromiumProcesses();
  await new Promise((r) => setTimeout(r, 3000));
  await cdp.send("Page.stopScreencast");
  report.screencast = { frames, fps: Math.round((frames / 3) * 10) / 10, avgFrameBytes: frames ? Math.round(bytes / frames) : 0, size };
  report.chromium = procsDuring;
  report.cgroupMemory = cgroupMemory();
  if (report.kernelRelease.includes("gvisor")) report.sandboxMemUsedMiB = meminfoUsedMiB();
  report.ok = report.typedOk && frames > 0;
} catch (err) {
  report.ok = false;
  report.error = String(err?.message ?? err)
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 25)
    .join("\n");
} finally {
  await browser?.close().catch(() => {});
}
console.log(JSON.stringify(report));
