// The browser child process (07.13-09, D-02, D-03, PD-19): the agent runs in `ocw-runtime browser-agent`, a child of
// the daemon speaking JSON lines in and frames out, with a throwaway 0700 run dir as its temp dir (Playwright's profile
// lands there) and a minimal env. A Chromium or child crash is an event for the parent, never the parent's end.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserChild, BrowserChildError, childEnv, sessionRunDir, sweepRunDirs } from "./child.js";
import { TEST_BROWSER_HINT, testBrowser, testSandbox } from "./test-browser.js";
import { DOWNLOAD_MARKER, startTestSite, type TestSite } from "./test-site.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "..", "..", "bin", "ocw-runtime");
const PROFILE_PREFIX = "playwright_chromiumdev_profile-";

const executable = await testBrowser();
if (!executable) console.warn(TEST_BROWSER_HINT);

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocw-browser-child-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Every file under `dir`, recursively (absent dir: none). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

/** Processes whose command line names `needle` (the run dir: Chromium's profile lives there). */
function processesNaming(needle: string): string[] {
  const out = execFileSync("ps", ["-ww", "-eo", "args"], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(needle) && !l.includes("ps -eo"));
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe("sessionRunDir and sweepRunDirs (PD-19)", () => {
  it("names <root>/run/<sessionId> and refuses anything but a uuid", () => {
    const id = randomUUID();
    expect(sessionRunDir("/x/browsers", id)).toBe(join("/x/browsers", "run", id));
    expect(() => sessionRunDir("/x/browsers", "../../etc")).toThrow();
    expect(() => sessionRunDir("/x/browsers", "")).toThrow();
  });

  it("removes every run dir but the live sessions'", async () => {
    const root = newRoot();
    const live = randomUUID();
    const dead = [randomUUID(), randomUUID()];
    for (const id of [live, ...dead]) {
      mkdirSync(join(root, "run", id, "sub"), { recursive: true });
      writeFileSync(join(root, "run", id, "sub", "f"), "x");
    }
    await sweepRunDirs(root, new Set([live]));
    expect(readdirSync(join(root, "run")).sort()).toEqual([live]);
    await sweepRunDirs(join(root, "missing"), new Set());
  });
});

describe("childEnv (D-03, T-07.13-09-04)", () => {
  it("passes only the path, the home, the temp dirs and the browser settings", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        OCW_DEVICE_TOKEN: "device-secret",
        OCW_HOME: "/home/u/.ocw",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        OPENAI_API_KEY: "sk-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      },
      { runDir: "/r/run/x", executablePath: "/b/chrome-headless-shell", sandbox: true },
    );
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "OCW_BROWSER_EXECUTABLE", "OCW_BROWSER_SANDBOX", "PATH", "TEMP", "TMP", "TMPDIR"].sort(),
    );
    expect(env).toMatchObject({
      TMPDIR: "/r/run/x",
      TMP: "/r/run/x",
      TEMP: "/r/run/x",
      OCW_BROWSER_SANDBOX: "on",
    });
    expect(JSON.stringify(env)).not.toMatch(/secret/);
  });

  it("keeps ELECTRON_RUN_AS_NODE when the parent runs under Electron, and says off for container mode", () => {
    const env = childEnv(
      { PATH: "/usr/bin", HOME: "/h", ELECTRON_RUN_AS_NODE: "1" },
      { runDir: "/r", executablePath: "/b", sandbox: false },
    );
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.OCW_BROWSER_SANDBOX).toBe("off");
  });
});

describe.skipIf(!executable)("BrowserChild with a real Chromium", () => {
  let site: TestSite;

  beforeAll(async () => {
    site = await startTestSite();
  });
  afterAll(async () => {
    await site?.close();
  });

  const start = (root: string, sessionId = randomUUID()) => {
    const events: Array<Record<string, unknown>> = [];
    const child = new BrowserChild({
      sessionId,
      root,
      executablePath: executable as string,
      sandbox: testSandbox(),
      entry: [ENTRY],
      onEvent: (e) => events.push(e),
    });
    return { child, events, runDir: sessionRunDir(root, sessionId) };
  };

  it("answers ops through the child, with Playwright's profile in a 0700 run dir that close removes", async () => {
    const root = newRoot();
    const { child, events, runDir } = start(root);
    try {
      const opened = (await child.call("open", { url: site.url("/") })) as Record<string, unknown>;
      expect(opened).toMatchObject({ host: site.host, title: "Fixture app", signedIn: false });
      const snap = (await child.call("snapshot", {})) as { text: string };
      expect(snap.text).toContain("Fixture heading");
      expect(events).toContainEqual({ event: "navigated", origin: site.origin });

      expect(statSync(runDir).mode & 0o777).toBe(0o700);
      const profiles = readdirSync(runDir).filter((n) => n.startsWith(PROFILE_PREFIX));
      expect(profiles).toHaveLength(1);
      // This child's Chromium runs on that profile, so none of its own is in the OS temp dir (other test files may
      // run an in-process agent there at the same time: the check is by this Chromium's command line).
      const chromium = processesNaming(runDir);
      expect(chromium.length).toBeGreaterThan(0);
      expect(chromium.some((l) => l.includes(join(runDir, profiles[0] as string)))).toBe(true);
      const elsewhere = new RegExp(`${PROFILE_PREFIX}`, "g");
      for (const l of chromium) {
        const all = l.match(elsewhere)?.length ?? 0;
        const inRun = l.split(join(runDir, PROFILE_PREFIX)).length - 1;
        expect(all).toBe(inRun);
      }
      expect(readdirSync(tmpdir())).not.toContain(profiles[0]);

      // An op the agent does not have is refused by name.
      await expect(child.call("evaluate" as "open", {})).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      await child.close();
    }
    expect(existsSync(runDir)).toBe(false);
    expect(child.state).toBe("closed");
  }, 120_000);

  it("keeps only the named files (the session's shim token) when it removes its run dir (07.13-12)", async () => {
    const root = newRoot();
    const sessionId = randomUUID();
    const runDir = sessionRunDir(root, sessionId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(runDir, "shim-token"), "t", { mode: 0o600 });
    const child = new BrowserChild({
      sessionId,
      root,
      executablePath: executable as string,
      sandbox: testSandbox(),
      entry: [ENTRY],
      keepFiles: ["shim-token"],
    });
    try {
      await child.call("open", { url: site.url("/") });
      expect(readdirSync(runDir).some((n) => n.startsWith(PROFILE_PREFIX))).toBe(true);
    } finally {
      await child.close();
    }
    expect(readdirSync(runDir)).toEqual(["shim-token"]);
    expect(readFileSync(join(runDir, "shim-token"), "utf8")).toBe("t");
  }, 120_000);

  it("refuses a download and writes nothing of it under the run dir", async () => {
    const root = newRoot();
    const { child, runDir } = start(root);
    try {
      await child.call("open", { url: site.url("/download-page") });
      const snap = (await child.call("snapshot", {})) as { text: string };
      const ref = snap.text
        .split("\n")
        .find((l) => l.includes('link "Get the file"'))
        ?.match(/\[(e\d+)\]/)?.[1];
      expect(ref).toBeDefined();
      const res = await child.call("act", { action: "click", ref });
      expect(res).toMatchObject({ download: null });
      const leaked = filesUnder(runDir).filter((f) => {
        try {
          return readFileSync(f).includes(DOWNLOAD_MARKER);
        } catch {
          return false;
        }
      });
      expect(leaked).toEqual([]);
    } finally {
      await child.close();
    }
  }, 120_000);

  it("reports a SIGKILLed child as crashed, rejects its pending call and removes its run dir", async () => {
    const root = newRoot();
    const { child, events, runDir } = start(root);
    await child.call("open", { url: site.url("/") });
    const pending = child.call("wait", { for: "time", ms: 20_000 });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid as number, "SIGKILL");
    await expect(pending).rejects.toBeInstanceOf(BrowserChildError);
    await expect(pending).rejects.toMatchObject({ code: "browser_unavailable" });
    await child.closed;
    expect(events).toContainEqual({ event: "crashed", scope: "process" });
    expect(child.state).toBe("crashed");
    expect(await until(() => !existsSync(runDir), 10_000)).toBe(true);
    // Chromium follows its pipe: nothing keeps running on the dead session's profile.
    expect(await until(() => processesNaming(runDir).length === 0, 15_000)).toBe(true);
    expect(process.pid).toBeGreaterThan(0);
    await expect(child.call("snapshot", {})).rejects.toMatchObject({ code: "browser_unavailable" });
  }, 120_000);
});
