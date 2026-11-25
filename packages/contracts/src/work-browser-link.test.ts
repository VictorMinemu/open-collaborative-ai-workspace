import { describe, expect, it } from "vitest";
import {
  BrowserEventFrame,
  BrowserServerFrame,
  CapabilitiesFrame,
  DEVICE_BROWSER_VERSION,
  DEVICE_LINK_MAX_DEVICE_FRAME_BYTES,
  DeviceToServerFrame,
  HelloFrame,
  PromptPayload,
  ServerToDeviceFrame,
  SessionStartPayload,
} from "./device-link";
import {
  decodeWorkBrowserFrame,
  encodeWorkBrowserFrame,
  SessionBrowserGrant,
  WORK_BROWSER_FRAME_HEADER_BYTES,
  WORK_BROWSER_FRAME_KIND,
  WORK_BROWSER_FRAME_MAX_BYTES,
  WORK_BROWSER_LIMITS,
} from "./work-browser";

const SESSION_ID = "0199f0a0-0000-7000-8000-0000000000c3";
const ASKER_ID = "0199f0a0-0000-7000-8000-0000000000a1";
const REQUEST_ID = "0199f0a0-0000-4000-8000-0000000000d4";
const LEASE_ID = "0199f0a0-0000-4000-8000-0000000000e5";
const SIGNIN_ID = "0199f0a0-0000-7000-8000-0000000000f6";
const AT = "2026-11-25T10:00:00.000Z";

const hello0718 = {
  type: "hello",
  protocolVersion: 1,
  device: { name: "Mac", platform: "darwin" },
  runtimes: [{ id: "claude-code", installed: true, version: "2.1.332", loggedIn: true }],
  accountPool: 1,
} as const;

const grant = {
  allowed: true,
  reason: "ok",
  askerId: ASKER_ID,
  askerIsBot: false,
  alwaysAsk: [],
  whenTainted: ["act"],
  signinAllowed: true,
} as const;

const prompt0718 = { promptId: "p-1", text: "open the app", permissionMode: "default" } as const;
const start0718 = { projectLocalId: "p1", runtime: "codex", permissionMode: "default" } as const;

describe("hello and capabilities carry the device's browser report (D-19, PD-20)", () => {
  it("parses a 07.18 hello unchanged and one with the browser report", () => {
    expect(HelloFrame.safeParse(hello0718).success).toBe(true);
    expect(HelloFrame.parse(hello0718).browser).toBeUndefined();
    const withBrowser = HelloFrame.parse({ ...hello0718, browser: { version: 1, optIn: true } });
    expect(withBrowser.browser).toEqual({ version: DEVICE_BROWSER_VERSION, optIn: true });
  });

  it("refuses an unknown browser version or an extra key", () => {
    expect(HelloFrame.safeParse({ ...hello0718, browser: { version: 2, optIn: true } }).success).toBe(false);
    expect(
      HelloFrame.safeParse({ ...hello0718, browser: { version: 1, optIn: true, profile: "x" } }).success,
    ).toBe(false);
  });

  it("MD-01: hello may list the open pages (session id and a signed-in flag only)", () => {
    const sessionId = "0193a1b2-0000-7000-8000-000000000001";
    const pages = [{ sessionId, signedIn: true }];
    expect(HelloFrame.parse({ ...hello0718, browserPages: pages }).browserPages).toEqual(pages);
    expect(HelloFrame.parse(hello0718).browserPages).toBeUndefined();
    expect(
      HelloFrame.safeParse({ ...hello0718, browserPages: [{ sessionId: "nope", signedIn: true }] }).success,
    ).toBe(false);
    expect(
      HelloFrame.safeParse({
        ...hello0718,
        browserPages: [{ sessionId, signedIn: true, origin: "https://a.example" }],
      }).success,
    ).toBe(false);
  });

  it("re-sends the opt-in on capabilities", () => {
    const caps = { type: "capabilities", catalogs: [], fullAccessOptIn: false } as const;
    expect(CapabilitiesFrame.safeParse(caps).success).toBe(true);
    expect(CapabilitiesFrame.parse({ ...caps, browser: { version: 1, optIn: false } }).browser?.optIn).toBe(
      false,
    );
    expect(DeviceToServerFrame.safeParse({ ...caps, browser: { version: 1, optIn: true } }).success).toBe(
      true,
    );
  });
});

describe("session.start and prompt carry the per-turn grant (D-10, PD-09)", () => {
  it("parses with and without the grant", () => {
    expect(PromptPayload.parse(prompt0718).browser).toBeUndefined();
    expect(PromptPayload.parse({ ...prompt0718, browser: grant }).browser?.allowed).toBe(true);
    expect(SessionStartPayload.parse(start0718).browser).toBeUndefined();
    expect(SessionStartPayload.parse({ ...start0718, browser: grant }).browser?.whenTainted).toEqual(["act"]);
  });

  it("refuses a grant with an extra key, 8 alwaysAsk entries or an unknown tool", () => {
    expect(PromptPayload.safeParse({ ...prompt0718, browser: { ...grant, cookie: "x" } }).success).toBe(
      false,
    );
    const eight = ["open", "snapshot", "act", "screenshot", "wait", "close", "signin", "open"];
    expect(PromptPayload.safeParse({ ...prompt0718, browser: { ...grant, alwaysAsk: eight } }).success).toBe(
      false,
    );
    expect(SessionBrowserGrant.safeParse({ ...grant, alwaysAsk: ["eval"] }).success).toBe(false);
  });

  it("names why a grant is off", () => {
    const off = { ...grant, allowed: false, reason: "update_device", askerId: null, signinAllowed: false };
    expect(SessionBrowserGrant.parse(off).reason).toBe("update_device");
    expect(SessionBrowserGrant.safeParse({ ...off, reason: "maybe" }).success).toBe(false);
  });
});

describe("device → server browser frames carry ids and origins only (D-14, D-24, P1, P3)", () => {
  const event = {
    type: "browser.event",
    sessionId: SESSION_ID,
    promptId: "p-1",
    kind: "opened",
    origin: "http://localhost:3000",
    action: "open",
  } as const;

  it("parses browser.event and refuses an origin with a path, a query or a non-http scheme", () => {
    expect(DeviceToServerFrame.parse(event).type).toBe("browser.event");
    expect(DeviceToServerFrame.safeParse({ ...event, origin: "http://localhost:3000/admin" }).success).toBe(
      false,
    );
    expect(DeviceToServerFrame.safeParse({ ...event, origin: "http://localhost:3000?x=1" }).success).toBe(
      false,
    );
    expect(DeviceToServerFrame.safeParse({ ...event, origin: "file://localhost:0" }).success).toBe(false);
    expect(DeviceToServerFrame.safeParse({ ...event, origin: null, promptId: null }).success).toBe(true);
  });

  it("has no field for a cookie, a typed text, a page text or a path", () => {
    for (const extra of [
      { cookie: "sid=1" },
      { text: "hunter2" },
      { title: "Inbox" },
      { path: "/Users/me" },
    ]) {
      expect(BrowserEventFrame.safeParse({ ...event, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("parses refusals and launch failures by code", () => {
    expect(
      DeviceToServerFrame.safeParse({ ...event, kind: "refused", refusal: "metadata_refused", origin: null })
        .success,
    ).toBe(true);
    expect(
      DeviceToServerFrame.safeParse({ ...event, kind: "crashed", failure: "missing_library", origin: null })
        .success,
    ).toBe(true);
    expect(DeviceToServerFrame.safeParse({ ...event, refusal: "because" }).success).toBe(false);
  });

  it("parses browser.signin.load and browser.focus", () => {
    const load = {
      type: "browser.signin.load",
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      promptId: "p-1",
      origin: "https://github.com:443",
    };
    expect(DeviceToServerFrame.parse(load).type).toBe("browser.signin.load");
    expect(DeviceToServerFrame.safeParse({ ...load, state: { cookies: [] } }).success).toBe(false);
    const focus = { type: "browser.focus", sessionId: SESSION_ID, leaseId: LEASE_ID, sensitive: true };
    expect(DeviceToServerFrame.parse(focus).type).toBe("browser.focus");
    expect(DeviceToServerFrame.safeParse({ ...focus, value: "hunter2" }).success).toBe(false);
  });
});

describe("server → device browser control frames (PD-12, PD-14 … PD-17)", () => {
  const frames = [
    { type: "browser.frames", sessionId: SESSION_ID, on: true },
    { type: "browser.lease", sessionId: SESSION_ID, leaseId: LEASE_ID, state: "held" },
    {
      type: "browser.input",
      sessionId: SESSION_ID,
      leaseId: LEASE_ID,
      events: [{ type: "mouse", event: "down", x: 10, y: 20, button: "left" }],
    },
    { type: "browser.handback", sessionId: SESSION_ID, leaseId: LEASE_ID, save: true, uploadId: REQUEST_ID },
    { type: "browser.close", sessionId: SESSION_ID, reason: "takeover_abandoned" },
    {
      type: "browser.signin.state",
      requestId: REQUEST_ID,
      result: {
        ok: true,
        signinId: SIGNIN_ID,
        state: {
          cookies: [
            {
              name: "sid",
              value: "v",
              domain: ".github.com",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [],
        },
        expiresAt: AT,
      },
    },
    {
      type: "browser.signin.state",
      requestId: REQUEST_ID,
      result: { ok: false, reason: "signin_not_allowed" },
    },
  ];

  it("parses each of the six frames on ServerToDeviceFrame and BrowserServerFrame", () => {
    for (const f of frames) {
      expect(ServerToDeviceFrame.safeParse(f).success, f.type).toBe(true);
      expect(BrowserServerFrame.safeParse(f).success, f.type).toBe(true);
    }
    expect(new Set(frames.map((f) => f.type)).size).toBe(6);
  });

  it("bounds input to 64 events and refuses unknown states and reasons", () => {
    const one = { type: "key", event: "down", key: "a", code: "KeyA", modifiers: 0 };
    const input = { type: "browser.input", sessionId: SESSION_ID, leaseId: LEASE_ID };
    expect(ServerToDeviceFrame.safeParse({ ...input, events: Array(64).fill(one) }).success).toBe(true);
    expect(ServerToDeviceFrame.safeParse({ ...input, events: Array(65).fill(one) }).success).toBe(false);
    expect(
      ServerToDeviceFrame.safeParse({
        type: "browser.lease",
        sessionId: SESSION_ID,
        leaseId: LEASE_ID,
        state: "x",
      }).success,
    ).toBe(false);
    expect(
      ServerToDeviceFrame.safeParse({ type: "browser.close", sessionId: SESSION_ID, reason: "x" }).success,
    ).toBe(false);
  });

  it("keeps every older server frame", () => {
    expect(
      ServerToDeviceFrame.safeParse({ type: "welcome", deviceId: SESSION_ID, organizationId: ASKER_ID })
        .success,
    ).toBe(true);
  });
});

describe("binary live frames (D-15)", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

  it("round-trips the session id, the size and the JPEG", () => {
    const bytes = encodeWorkBrowserFrame({ sessionId: SESSION_ID, width: 960, height: 600, jpeg });
    expect(bytes).not.toBeNull();
    if (!bytes) return;
    expect(bytes.length).toBe(WORK_BROWSER_FRAME_HEADER_BYTES + jpeg.length);
    expect(bytes[0]).toBe(WORK_BROWSER_FRAME_KIND);
    const back = decodeWorkBrowserFrame(bytes);
    expect(back).not.toBeNull();
    expect(back?.sessionId).toBe(SESSION_ID);
    expect(back?.width).toBe(WORK_BROWSER_LIMITS.frameWidth);
    expect(back?.height).toBe(WORK_BROWSER_LIMITS.frameHeight);
    expect(Array.from(back?.jpeg ?? [])).toEqual(Array.from(jpeg));
  });

  it("refuses a frame over the device frame limit instead of splitting it", () => {
    expect(WORK_BROWSER_FRAME_MAX_BYTES).toBe(DEVICE_LINK_MAX_DEVICE_FRAME_BYTES);
    const fits = new Uint8Array(DEVICE_LINK_MAX_DEVICE_FRAME_BYTES - WORK_BROWSER_FRAME_HEADER_BYTES);
    expect(
      encodeWorkBrowserFrame({ sessionId: SESSION_ID, width: 960, height: 600, jpeg: fits }),
    ).not.toBeNull();
    const big = new Uint8Array(DEVICE_LINK_MAX_DEVICE_FRAME_BYTES - WORK_BROWSER_FRAME_HEADER_BYTES + 1);
    expect(encodeWorkBrowserFrame({ sessionId: SESSION_ID, width: 960, height: 600, jpeg: big })).toBeNull();
  });

  it("refuses a bad session id or size on encode", () => {
    expect(encodeWorkBrowserFrame({ sessionId: "nope", width: 960, height: 600, jpeg })).toBeNull();
    expect(encodeWorkBrowserFrame({ sessionId: SESSION_ID, width: 0, height: 600, jpeg })).toBeNull();
    expect(encodeWorkBrowserFrame({ sessionId: SESSION_ID, width: 960, height: 70_000, jpeg })).toBeNull();
    expect(
      encodeWorkBrowserFrame({ sessionId: SESSION_ID, width: 960, height: 600, jpeg: new Uint8Array() }),
    ).toBeNull();
  });

  it("decodes nothing from another kind, a short buffer or an empty image", () => {
    const bytes = encodeWorkBrowserFrame({ sessionId: SESSION_ID, width: 960, height: 600, jpeg });
    if (!bytes) throw new Error("encode failed");
    const other = bytes.slice();
    other[0] = 2;
    expect(decodeWorkBrowserFrame(other)).toBeNull();
    expect(decodeWorkBrowserFrame(bytes.slice(0, 20))).toBeNull();
    expect(decodeWorkBrowserFrame(bytes.slice(0, WORK_BROWSER_FRAME_HEADER_BYTES))).toBeNull();
  });
});
