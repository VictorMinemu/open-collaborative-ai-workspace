// Taking control of a session's page on the device (07.13-15 Task 2: D-20, PD-14). While a person holds the lease every
// agent browser call answers `paused` at once; that person's input reaches the page only through the agent's CDP input
// ops, is never logged, and what they typed is redacted from the agent's snapshots and screenshots. Input for another
// lease or session is ignored. The focus hint carries a boolean only.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserInputFrame,
  type DeviceToServerFrame,
  originOf,
  type SessionBrowserGrant,
  WORK_BROWSER_REFUSAL_TEXT,
} from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  BrowserManager,
  type BrowserManagerOptions,
  type ChildFactoryOptions,
  type ManagedChild,
} from "./manager.js";
import { Takeover } from "./takeover.js";
import { TEST_BROWSER_HINT, testBrowser, testSandbox } from "./test-browser.js";
import { PASSWORD_CANARY, startTestSite, TAKEOVER_LAYOUT, type TestSite } from "./test-site.js";
import { pageContentOf } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "..", "..", "bin", "ocw-runtime");

const executable = await testBrowser();
if (!executable) console.warn(TEST_BROWSER_HINT);

const ALLOW: SessionBrowserGrant = {
  allowed: true,
  reason: "ok",
  askerId: "00000000-0000-4000-8000-000000000001",
  askerIsBot: false,
  alwaysAsk: [],
  whenTainted: [],
  signinAllowed: false,
};

const PAUSED = `Refused: ${WORK_BROWSER_REFUSAL_TEXT.paused}`;
const TYPED = "fixture-user";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A logger whose every call is recorded (the typed text must never reach one). */
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

/** A child that answers like the agent without a browser; records every op it is sent. */
class ScriptedChild implements ManagedChild {
  state: ManagedChild["state"] = "running";
  readonly closed: Promise<void>;
  readonly calls: Array<{ op: string; input: Record<string, unknown> }> = [];
  private done: () => void = () => {};

  constructor(readonly o: ChildFactoryOptions) {
    this.closed = new Promise((r) => {
      this.done = r;
    });
  }

  async call(op: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.calls.push({ op, input: { ...input } });
    if (op === "open") {
      const origin = originOf(String(input.url));
      if (origin) this.o.onEvent({ event: "navigated", origin });
      return { host: "h", secure: false, title: "Scripted", signedIn: false };
    }
    if (op === "snapshot") return { host: "h", secure: false, title: "Scripted", text: "", truncated: false };
    if (op === "takeover") return { active: input.on === true };
    if (op === "input") return { applied: Array.isArray(input.events) ? input.events.length : 0 };
    if (op === "frames") return { on: input.on === true };
    return { closed: true };
  }

  ops(name: string) {
    return this.calls.filter((c) => c.op === name);
  }

  async close(): Promise<void> {
    this.state = "closed";
    this.done();
  }
}

function scripted(over: Partial<BrowserManagerOptions> = {}) {
  const frames: DeviceToServerFrame[] = [];
  const children: ScriptedChild[] = [];
  const spy = spyLogger();
  const root = mkdtempSync(join(tmpdir(), "ocw-browser-takeover-"));
  roots.push(root);
  const manager = new BrowserManager({
    root,
    link: { send: (f) => frames.push(f), sendBinary: () => false },
    api: { put: async () => 404 },
    optIn: () => true,
    sandbox: () => true,
    emit: () => {},
    browsers: {
      installed: async () => ({ executable: "/scripted/chrome", version: "pinned" }),
      install: async () => ({ executable: "/scripted/chrome", version: "pinned" }),
    },
    createChild: (o) => {
      const c = new ScriptedChild(o);
      children.push(c);
      return c;
    },
    log: spy.log,
    ...over,
  });
  const sid = randomUUID();
  const tools = manager.forSession(sid);
  manager.onPrompt(sid, "p1", ALLOW);
  manager.onTurnStarted(sid, "p1");
  const child = () => children.at(-1) as ScriptedChild;
  return { manager, frames, children, child, sid, tools, logs: spy.calls };
}

const input = (sessionId: string, leaseId: string, text = TYPED): BrowserInputFrame => ({
  type: "browser.input",
  sessionId,
  leaseId,
  events: [
    { type: "mouse", event: "down", x: 10, y: 10, button: "left" },
    { type: "mouse", event: "up", x: 10, y: 10, button: "left" },
    { type: "text", text },
    { type: "key", event: "down", key: "Tab", code: "Tab", modifiers: 0 },
  ],
});

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

describe("takeover on the device (07.13-15 Task 2, a scripted child)", () => {
  it("a held lease answers paused in under 50 ms, even while an earlier call waits on a person; released works", async () => {
    const t = scripted();
    await t.tools.call("open", { url: "http://localhost:3000/" });
    // An earlier call that waits for a person's host approval (minutes) holds the session's chain.
    const waiting = t.tools.call("open", { url: "https://example.org/" });
    await flush();
    const leaseId = randomUUID();
    await t.manager.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId, state: "held" });
    const started = performance.now();
    const paused = await t.tools.call("snapshot", {});
    expect(performance.now() - started).toBeLessThan(50);
    expect(paused.summary).toBe(PAUSED);
    expect(paused.isError).toBe(true);

    await t.manager.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId, state: "released" });
    await t.manager.endSession(t.sid);
    expect((await waiting).isError).toBe(true);
  });

  it("tells the child when a takeover starts and ends", async () => {
    const t = scripted();
    await t.tools.call("open", { url: "http://localhost:3000/" });
    const leaseId = randomUUID();
    await t.manager.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId, state: "held" });
    await t.manager.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId, state: "released" });
    expect(
      t
        .child()
        .ops("takeover")
        .map((c) => c.input),
    ).toEqual([{ on: true }, { on: false }]);
    expect((await t.tools.call("snapshot", {})).isError).toBe(false);
  });

  it("forwards input only for the session's current held lease, and never logs it", async () => {
    const t = scripted();
    await t.tools.call("open", { url: "http://localhost:3000/" });
    const leaseId = randomUUID();
    // Before any lease: ignored.
    await t.manager.onServerFrame(input(t.sid, leaseId));
    expect(t.child().ops("input")).toHaveLength(0);

    await t.manager.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId, state: "held" });
    await t.manager.onServerFrame(input(t.sid, leaseId));
    expect(t.child().ops("input")).toHaveLength(1);
    expect(t.child().ops("input")[0]?.input.events).toHaveLength(4);

    // A stale lease id, another session, an unknown session: ignored.
    await t.manager.onServerFrame(input(t.sid, randomUUID(), PASSWORD_CANARY));
    const other = randomUUID();
    t.manager.forSession(other);
    await t.manager.onServerFrame(input(other, leaseId, PASSWORD_CANARY));
    await t.manager.onServerFrame(input(randomUUID(), leaseId, PASSWORD_CANARY));
    expect(t.child().ops("input")).toHaveLength(1);

    // A new holder: the old lease's input is ignored from now on.
    const next = randomUUID();
    await t.manager.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId: next, state: "held" });
    await t.manager.onServerFrame(input(t.sid, leaseId, PASSWORD_CANARY));
    expect(t.child().ops("input")).toHaveLength(1);

    // Released: ignored again.
    await t.manager.onServerFrame({
      type: "browser.lease",
      sessionId: t.sid,
      leaseId: next,
      state: "released",
    });
    await t.manager.onServerFrame(input(t.sid, next, PASSWORD_CANARY));
    expect(t.child().ops("input")).toHaveLength(1);

    const logged = JSON.stringify(t.logs);
    expect(logged).not.toContain(TYPED);
    expect(logged).not.toContain(PASSWORD_CANARY);
    expect(JSON.stringify(t.frames)).not.toContain(TYPED);
  });

  it("a held lease's focus hint is a browser.focus frame with the lease and a boolean only", async () => {
    const t = scripted();
    await t.tools.call("open", { url: "http://localhost:3000/" });
    // No lease: no hint.
    t.child().o.onEvent({ event: "focus", sensitive: true });
    expect(t.frames.filter((f) => f.type === "browser.focus")).toHaveLength(0);

    const leaseId = randomUUID();
    await t.manager.onServerFrame({ type: "browser.lease", sessionId: t.sid, leaseId, state: "held" });
    t.child().o.onEvent({ event: "focus", sensitive: true });
    t.child().o.onEvent({ event: "focus", sensitive: false });
    expect(t.frames.filter((f) => f.type === "browser.focus")).toEqual([
      { type: "browser.focus", sessionId: t.sid, leaseId, sensitive: true },
      { type: "browser.focus", sessionId: t.sid, leaseId, sensitive: false },
    ]);
  });
});

// ---------------------------------------------------------------------------- a real child

describe.skipIf(!executable)("takeover on a real Chromium (07.13-15 Task 2)", () => {
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

  it("the holder's input reaches the page; the agent then reads both fields [redacted]; nothing is logged", async () => {
    const frames: DeviceToServerFrame[] = [];
    const spy = spyLogger();
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const root = mkdtempSync(join(tmpdir(), "ocw-browser-takeover-"));
    roots.push(root);
    manager = new BrowserManager({
      root,
      link: { send: (f) => frames.push(f), sendBinary: () => false },
      api: { put: async () => 404 },
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
    const sid = randomUUID();
    const tools = manager.forSession(sid);
    tools.setImageInput(true);
    manager.onPrompt(sid, "p1", ALLOW);
    manager.onTurnStarted(sid, "p1");
    expect((await tools.call("open", { url: site.url("/takeover") })).isError).toBe(false);

    const leaseId = randomUUID();
    await manager.onServerFrame({ type: "browser.lease", sessionId: sid, leaseId, state: "held" });
    expect((await tools.call("snapshot", {})).summary).toBe(PAUSED);

    const u = TAKEOVER_LAYOUT.username;
    await manager.onServerFrame({
      type: "browser.input",
      sessionId: sid,
      leaseId,
      events: [
        { type: "mouse", event: "down", x: u.x, y: u.y, button: "left" },
        { type: "mouse", event: "up", x: u.x, y: u.y, button: "left" },
        { type: "text", text: TYPED },
        { type: "key", event: "down", key: "Tab", code: "Tab", modifiers: 0 },
        { type: "key", event: "up", key: "Tab", code: "Tab", modifiers: 0 },
        { type: "text", text: PASSWORD_CANARY },
      ],
    });
    const focus = () =>
      frames.flatMap((f) =>
        f.type === "browser.focus" ? [{ leaseId: f.leaseId, sensitive: f.sensitive }] : [],
      );
    for (let i = 0; i < 100 && focus().at(-1)?.sensitive !== true; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(focus().at(-1)).toEqual({ leaseId, sensitive: true });

    await manager.onServerFrame({ type: "browser.lease", sessionId: sid, leaseId, state: "released" });
    const snap = await tools.call("snapshot", {});
    expect(snap.isError).toBe(false);
    const content = pageContentOf(snap) ?? "";
    const line = (name: string) => content.split("\n").find((l) => l.includes(`textbox "${name}"`)) ?? "";
    expect(line("Username")).toContain("[redacted]");
    expect(line("Password")).toContain("[redacted]");
    expect(content).not.toContain(TYPED);
    expect(content).not.toContain(PASSWORD_CANARY);
    const shot = await tools.call("screenshot", {});
    const shotText = shot.content.find((c) => c.type === "text");
    const masked = Number((shotText?.type === "text" ? shotText.text : "").match(/Masked (\d+)/)?.[1]);
    expect(masked).toBeGreaterThanOrEqual(2);

    // The values reached the page: a second takeover submits them, and the site got exactly what was typed.
    const second = randomUUID();
    await manager.onServerFrame({ type: "browser.lease", sessionId: sid, leaseId: second, state: "held" });
    await manager.onServerFrame({
      type: "browser.input",
      sessionId: sid,
      leaseId: second,
      events: [{ type: "key", event: "down", key: "Enter", code: "Enter", modifiers: 0 }],
    });
    for (let i = 0; i < 60 && !site.lastLogin(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(site.lastLogin()).toMatchObject({ username: TYPED, password: PASSWORD_CANARY });

    const logged = JSON.stringify(spy.calls);
    expect(logged).not.toContain(TYPED);
    expect(logged).not.toContain(PASSWORD_CANARY);
    for (const c of consoleSpies) {
      expect(JSON.stringify(c.mock.calls)).not.toContain(PASSWORD_CANARY);
      c.mockRestore();
    }
    expect(JSON.stringify(frames)).not.toContain(TYPED);
    expect(JSON.stringify(frames)).not.toContain(PASSWORD_CANARY);
  }, 120_000);
});

describe("Takeover holder (07.13 review HI-03)", () => {
  const host = { child: () => null, send: () => {}, abandon: async () => {}, touched: () => {} };
  const sessionId = randomUUID();
  const HOLDER = "00000000-0000-4000-8000-000000000002";

  it("holderOf names the person the API granted the held lease to, until it ends; an older API names nobody", async () => {
    const t = new Takeover(host);
    const leaseId = randomUUID();
    await t.onLease({ type: "browser.lease", sessionId, leaseId, state: "held", holderUserId: HOLDER });
    expect(t.holderOf(sessionId)).toBe(HOLDER);
    await t.onLease({ type: "browser.lease", sessionId, leaseId, state: "released" });
    expect(t.holderOf(sessionId)).toBeUndefined();
    await t.onLease({ type: "browser.lease", sessionId, leaseId: randomUUID(), state: "held" });
    expect(t.isPaused(sessionId)).toBe(true);
    expect(t.holderOf(sessionId)).toBeUndefined();
    t.end(sessionId);
    await t.onLease({
      type: "browser.lease",
      sessionId,
      leaseId: randomUUID(),
      state: "held",
      holderUserId: HOLDER,
    });
    t.end(sessionId);
    expect(t.holderOf(sessionId)).toBeUndefined();
  });
});
