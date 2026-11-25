// "Done, save my sign-in" on the device (07.13-19 Task 1: D-22, PD-15). On a hand back with save the device exports only
// the page's site state (cookies that domain-match its host, that host's origin storage), tells whether it changed since
// the person took control, and PUTs it once to the upload route; a state over the cap is never sent. Nothing of it is
// written to the run dir, logged or put into a frame.

import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserInputFrame,
  type DeviceToServerFrame,
  type SessionBrowserGrant,
  WorkBrowserSignInUpload,
} from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { BrowserManager, type ManagedChild } from "./manager.js";
import { resealPath, SignInLoads, saveHandback, uploadPath } from "./signin.js";
import { TEST_BROWSER_HINT, testBrowser, testSandbox } from "./test-browser.js";
import { OTHER_SITE_COOKIE, startTestSite, TAKEOVER_LAYOUT, type TestSite } from "./test-site.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "..", "..", "bin", "ocw-runtime");

const executable = await testBrowser();
if (!executable) console.warn(TEST_BROWSER_HINT);

const MEMBER = "00000000-0000-4000-8000-000000000001";
const ALLOW: SessionBrowserGrant = {
  allowed: true,
  reason: "ok",
  askerId: MEMBER,
  askerIsBot: false,
  alwaysAsk: [],
  whenTainted: [],
  signinAllowed: false,
};

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function spyLogger() {
  const calls: unknown[][] = [];
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push([level, ...args]);
    };
  const log: Logger = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") };
  return { log, calls };
}

/** Every file under `dir` (recursively) whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        try {
          if (readFileSync(p).includes(needle)) hits.push(p);
        } catch {
          // A file Chromium removed meanwhile.
        }
      }
    }
  };
  walk(dir);
  return hits;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sign-in paths and loads (07.13-19)", () => {
  it("builds only the sign-in routes with uuid ids", () => {
    const id = randomUUID();
    expect(uploadPath(id)).toBe(`/api/v1/runtime/browser-signins/uploads/${id}`);
    expect(resealPath(id)).toBe(`/api/v1/runtime/browser-signins/${id}/state`);
    expect(uploadPath("../../devices")).toBeNull();
    expect(resealPath("x")).toBeNull();
  });

  it("a load answers the matching state only, and nothing after its timeout", async () => {
    const sent: DeviceToServerFrame[] = [];
    const loads = new SignInLoads({ send: (f) => sent.push(f), timeoutMs: 50 });
    const sid = randomUUID();
    const pending = loads.request(sid, "p1", "http://127.0.0.1:3000");
    const frame = sent[0];
    expect(frame).toMatchObject({
      type: "browser.signin.load",
      sessionId: sid,
      promptId: "p1",
      origin: "http://127.0.0.1:3000",
    });
    if (frame?.type !== "browser.signin.load") throw new Error("no load frame");
    expect(
      loads.onState({
        type: "browser.signin.state",
        requestId: randomUUID(),
        result: { ok: false, reason: "no_context" },
      }),
    ).toBe(false);
    expect(
      loads.onState({
        type: "browser.signin.state",
        requestId: frame.requestId,
        result: { ok: false, reason: "no_context" },
      }),
    ).toBe(true);
    expect(await pending).toEqual({ ok: false, reason: "no_context" });
    expect(await loads.request(sid, "p1", "http://127.0.0.1:3000")).toBeNull();
  });

  it("a state the child refuses as too large is never PUT", async () => {
    const put = vi.fn(async () => 201);
    const child: ManagedChild = {
      state: "running",
      closed: new Promise(() => {}),
      call: async () => {
        throw Object.assign(new Error("The result was too large."), { code: "too_large" });
      },
      close: async () => {},
    };
    const out = await saveHandback({
      child,
      api: { put },
      sessionId: randomUUID(),
      uploadId: randomUUID(),
      origin: "http://127.0.0.1:3000",
      fingerprintAtHeld: null,
    });
    expect(out).toEqual({ kind: "refused", refusal: "too_large" });
    expect(put).not.toHaveBeenCalled();
  });
});

describe.skipIf(!executable)("save my sign-in on a real Chromium (07.13-19 Task 1)", () => {
  let site: TestSite;
  let manager: BrowserManager | null = null;

  beforeAll(async () => {
    site = await startTestSite();
  });
  afterEach(async () => {
    await manager?.stopAll();
    manager = null;
  });
  afterAll(async () => {
    await site?.close();
  });

  function setup(status: { value: number }) {
    const frames: DeviceToServerFrame[] = [];
    const puts: Array<{ path: string; body: unknown }> = [];
    const spy = spyLogger();
    const root = mkdtempSync(join(tmpdir(), "ocw-browser-signin-"));
    roots.push(root);
    const m = new BrowserManager({
      root,
      link: { send: (f) => frames.push(f), sendBinary: () => false },
      api: {
        put: async (path, body) => {
          puts.push({ path, body });
          return status.value;
        },
      },
      optIn: () => true,
      sandbox: () => testSandbox(),
      emit: () => {},
      browsers: {
        installed: async () => ({ executable: executable as string, version: "pinned" }),
        install: async () => {
          throw new Error("no install in tests");
        },
      },
      childEntry: [ENTRY],
      log: spy.log,
    });
    manager = m;
    const sid = randomUUID();
    const tools = m.forSession(sid);
    m.onPrompt(sid, "p1", ALLOW);
    m.onTurnStarted(sid, "p1");
    return { m, sid, tools, frames, puts, logs: spy.calls, root };
  }

  it("uploads only the signed-in site's state, says whether it changed, and keeps none of it", async () => {
    const status = { value: 200 };
    const t = setup(status);
    // Another host of the same server sets its own cookie and storage in this context first.
    const other = `http://localhost:${new URL(site.origin).port}`;
    expect((await t.tools.call("open", { url: `${other}/other-site` })).isError).toBe(false);
    expect((await t.tools.call("open", { url: site.url("/takeover") })).isError).toBe(false);

    // A takeover handed back with save and nothing changed: `changed: false`.
    const first = randomUUID();
    const firstUpload = randomUUID();
    await t.m.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId: first, state: "held" });
    await t.m.onServerFrame({
      type: "browser.handback",
      sessionId: t.sid,
      leaseId: first,
      save: true,
      uploadId: firstUpload,
    });
    expect(t.puts).toHaveLength(1);
    expect(t.puts[0]?.path).toBe(`/api/v1/runtime/browser-signins/uploads/${firstUpload}`);
    expect(t.puts[0]?.body).toMatchObject({ sessionId: t.sid, origin: site.origin, changed: false });

    // The member signs in by hand.
    const leaseId = randomUUID();
    await t.m.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId, state: "held" });
    const u = TAKEOVER_LAYOUT.username;
    const p = TAKEOVER_LAYOUT.password;
    const typed: BrowserInputFrame = {
      type: "browser.input",
      sessionId: t.sid,
      leaseId,
      events: [
        { type: "mouse", event: "down", x: u.x, y: u.y, button: "left" },
        { type: "mouse", event: "up", x: u.x, y: u.y, button: "left" },
        { type: "text", text: "fixture-user" },
        { type: "mouse", event: "down", x: p.x, y: p.y, button: "left" },
        { type: "mouse", event: "up", x: p.x, y: p.y, button: "left" },
        { type: "text", text: "fixture-password" },
        { type: "key", event: "down", key: "Enter", code: "Enter", modifiers: 0 },
      ],
    };
    await t.m.onServerFrame(typed);
    for (let i = 0; i < 100 && !site.lastLogin(); i++) await wait(100);
    expect(site.lastLogin()).toMatchObject({ username: "fixture-user" });
    await wait(1_000);
    // The signed-in page is open: its cookie is in memory only.
    expect(filesContaining(t.m.runDir(t.sid), site.sessionCookie)).toEqual([]);

    status.value = 201;
    const uploadId = randomUUID();
    await t.m.onServerFrame({ type: "browser.handback", sessionId: t.sid, leaseId, save: true, uploadId });
    expect(t.puts).toHaveLength(2);
    const sent = t.puts[1];
    expect(sent?.path).toBe(`/api/v1/runtime/browser-signins/uploads/${uploadId}`);
    const body = WorkBrowserSignInUpload.parse(sent?.body);
    expect(body).toMatchObject({ sessionId: t.sid, origin: site.origin, changed: true });
    expect(body.state.cookies.map((c) => c.domain)).toEqual(["127.0.0.1"]);
    expect(body.state.cookies.map((c) => c.value)).toEqual([site.sessionCookie]);
    expect(JSON.stringify(body.state)).not.toContain(OTHER_SITE_COOKIE);
    expect(body.state.origins.every((o) => new URL(o.origin).hostname === "127.0.0.1")).toBe(true);

    // Nothing of the state anywhere else: the run dir, the logs, the frames.
    expect(filesContaining(t.root, site.sessionCookie)).toEqual([]);
    expect(JSON.stringify(t.logs)).not.toContain(site.sessionCookie);
    expect(JSON.stringify(t.frames)).not.toContain(site.sessionCookie);
    // The sealed page was not locked to its site: it is closed, so the next open in a member's turn loads it.
    expect(t.m.openPages).toBe(0);
  }, 120_000);

  it("a state over 2 MiB is never sent: refused too_large", async () => {
    const t = setup({ value: 201 });
    expect((await t.tools.call("open", { url: site.url("/big-storage") })).isError).toBe(false);
    const leaseId = randomUUID();
    await t.m.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId, state: "held" });
    await t.m.onServerFrame({
      type: "browser.handback",
      sessionId: t.sid,
      leaseId,
      save: true,
      uploadId: randomUUID(),
    });
    expect(t.puts).toEqual([]);
    expect(t.frames).toContainEqual(
      expect.objectContaining({ type: "browser.event", kind: "refused", refusal: "too_large" }),
    );
    // The pause ended; the page stays.
    expect((await t.tools.call("snapshot", {})).isError).toBe(false);
  }, 120_000);
});
