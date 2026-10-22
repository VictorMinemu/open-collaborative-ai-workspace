import type { ActivityStep, LiveStateFrame } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActivityStepRow, watchable } from "./activity-step";
import { LiveActivityLine } from "./live-activity-line";
import { LiveFrame, placeholderOf } from "./live-frame";
import { LargeHeader, SmallHeader } from "./live-header";
import {
  compositionFrame,
  isComposingKey,
  isModifierKey,
  type KeyLike,
  keyFrame,
  mouseFrame,
  moveGate,
  pasteFrame,
  SMALL_PAGE,
  toPage,
  wheelFrame,
} from "./live-input";
import { connectLive } from "./live-socket";
import {
  CHIP,
  cornerAfterKey,
  cornerPosition,
  LEASE_MS,
  type LiveUiState,
  type LiveView,
  leaseWarning,
  nearestCorner,
  nextLeaseDeadline,
  refusalSentence,
  uiStateOf,
} from "./live-store";
import { TakeoverBar } from "./takeover-bar";

/**
 * The desktop live view (07.8-22; D-07, BRW-02, BRW-03, UI-SPEC §1.1–1.4): the pure input mappers (nothing typed is
 * kept), the state renderer for every row of §1.4 (chip, placeholder, activity line, controls), the lease warning, the
 * corners, the socket's protocol handling and the Watch link. Static markup in node, like the other web tests.
 */

const ID = "0199f1c2-7a4b-7c3d-9e8f-123456789abc";
const BOT = { id: "0199f1c2-7a4b-7c3d-9e8f-000000000001", name: "Scout", avatarUrl: null };

function key(over: Partial<KeyLike> = {}): KeyLike {
  return { key: "a", code: "KeyA", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over };
}

function state(over: Partial<LiveStateFrame> = {}): LiveStateFrame {
  return {
    type: "state",
    state: "live",
    pausedFor: null,
    activity: null,
    host: "panel.fake.test",
    secure: true,
    controller: null,
    requesterName: "Sam Lee",
    ...over,
  } as LiveStateFrame;
}

function view(over: Partial<LiveView> = {}): LiveView {
  return {
    contextId: ID,
    bot: BOT,
    expanded: false,
    wantControl: false,
    pending: null,
    closeAfterRelease: false,
    conn: "open",
    server: state(),
    viewerCan: { watch: true, control: true },
    leaseDeadline: null,
    sensitive: false,
    hasFrame: true,
    attempt: 0,
    ...over,
  };
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const noop = () => {};

function small(v: LiveView) {
  const s = uiStateOf(v);
  return renderToStaticMarkup(
    <div data-testid="live-view" data-state={s}>
      <SmallHeader view={v} state={s} onDragStart={noop} onMoveKey={noop} />
      <LiveFrame view={v} state={s} large={false} />
      <LiveActivityLine view={v} state={s} />
    </div>,
  );
}

function large(v: LiveView) {
  const s = uiStateOf(v);
  return renderToStaticMarkup(
    <div data-testid="live-view" data-state={s}>
      <LargeHeader view={v} state={s} titleId="t" primaryRef={{ current: null }} />
      {s === "controlling" ? <TakeoverBar view={v} frameFocused hintId="h" /> : null}
      <LiveFrame view={{ ...v, expanded: true }} state={s} large hintId="h" />
      <LiveActivityLine view={v} state={s} large />
    </div>,
  );
}

const has = (markup: string, testId: string) => markup.includes(`data-testid="${testId}"`);

describe("live-input: DOM input → LiveInputFrame (never kept)", () => {
  it("keys carry their modifiers; Shift+Esc, the paste chord and composing keys never reach the page", () => {
    expect(keyFrame(key(), "down")).toEqual({
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      modifiers: 0,
    });
    expect(keyFrame(key({ key: "Enter", code: "Enter", shiftKey: true }), "up")).toEqual({
      type: "key",
      event: "up",
      key: "Enter",
      code: "Enter",
      modifiers: 8,
    });
    expect(keyFrame(key({ key: "a", ctrlKey: true, altKey: true, metaKey: true }), "down")).toMatchObject({
      modifiers: 7,
    });
    expect(keyFrame(key({ key: "Tab", code: "Tab" }), "down")).toMatchObject({ key: "Tab" });
    expect(keyFrame(key({ key: "Escape", code: "Escape", shiftKey: true }), "down")).toBeNull();
    expect(keyFrame(key({ key: "Escape", code: "Escape", shiftKey: true }), "up")).toBeNull();
    expect(keyFrame(key({ key: "Escape", code: "Escape" }), "down")).toMatchObject({ key: "Escape" });
    expect(keyFrame(key({ key: "v", code: "KeyV", metaKey: true }), "down")).toBeNull();
    expect(keyFrame(key({ key: "v", code: "KeyV", ctrlKey: true }), "down")).toBeNull();
    expect(keyFrame(key({ key: "Process", code: "KeyA" }), "down")).toBeNull();
    expect(keyFrame(key({ isComposing: true }), "down")).toBeNull();
    expect(keyFrame(key({ code: "" }), "down")).toMatchObject({ code: "Unidentified" });
    expect(keyFrame(key({ key: "x".repeat(33) }), "down")).toBeNull();
    // Only modifiers are remembered to release them when the keyboard leaves the page; never a character.
    expect(["Shift", "Control", "Alt", "Meta"].every(isModifierKey)).toBe(true);
    expect(isModifierKey("a")).toBe(false);
  });

  it("a mouse at (160, 100) on a 320×200 frame of a 960×600 page maps to (480, 300); letterbox bars map to nothing", () => {
    const box = { left: 0, top: 0, width: 320, height: 200 };
    expect(toPage(160, 100, box, SMALL_PAGE)).toEqual({ x: 480, y: 300 });
    expect(mouseFrame("down", { clientX: 160, clientY: 100, button: 0 }, box, SMALL_PAGE)).toEqual({
      type: "mouse",
      event: "down",
      x: 480,
      y: 300,
      button: "left",
    });
    expect(mouseFrame("move", { clientX: 10, clientY: 10, button: 2 }, box, SMALL_PAGE)).toMatchObject({
      button: "none",
    });
    expect(mouseFrame("up", { clientX: 10, clientY: 10, button: 2 }, box, SMALL_PAGE)).toMatchObject({
      button: "right",
    });
    // Offset box, scaled: the window's frame sits at (1100, 600).
    expect(
      toPage(1100 + 320, 600 + 200, { left: 1100, top: 600, width: 320, height: 200 }, SMALL_PAGE),
    ).toEqual({
      x: 960,
      y: 600,
    });
    // A box wider than 16:10 is letterboxed left and right (object-contain).
    const wide = { left: 0, top: 0, width: 400, height: 200 };
    expect(toPage(20, 100, wide, SMALL_PAGE)).toBeNull();
    expect(toPage(200, 100, wide, SMALL_PAGE)).toEqual({ x: 480, y: 300 });
  });

  it("paste is cut to 1,000 characters (never half an emoji); composition sends only its final text", () => {
    expect(pasteFrame("x".repeat(1500))).toEqual({ type: "text", text: "x".repeat(1000) });
    const emoji = `${"x".repeat(999)}😀tail`;
    expect(pasteFrame(emoji)).toEqual({ type: "text", text: "x".repeat(999) });
    expect(pasteFrame("")).toBeNull();
    expect(pasteFrame(null)).toBeNull();
    expect(compositionFrame("日本語")).toEqual({ type: "text", text: "日本語" });
    expect(compositionFrame("")).toBeNull();
    expect(isComposingKey({ isComposing: false, key: "a", keyCode: 229 })).toBe(true);
  });

  it("wheel deltas pass through (lines scaled to pixels); mouse moves are gated at 30 Hz", () => {
    const box = { left: 0, top: 0, width: 320, height: 200 };
    expect(
      wheelFrame({ clientX: 160, clientY: 100, deltaX: 0, deltaY: -120, deltaMode: 0 }, box, SMALL_PAGE),
    ).toEqual({
      type: "wheel",
      x: 480,
      y: 300,
      dx: 0,
      dy: -120,
    });
    expect(
      wheelFrame({ clientX: 160, clientY: 100, deltaX: 0, deltaY: 3, deltaMode: 1 }, box, SMALL_PAGE),
    ).toMatchObject({ dy: 48 });
    expect(
      wheelFrame({ clientX: 160, clientY: 100, deltaX: 0, deltaY: 0, deltaMode: 0 }, box, SMALL_PAGE),
    ).toBeNull();
    const gate = moveGate(30);
    expect(gate(0)).toBe(true);
    expect(gate(10)).toBe(false);
    expect(gate(34)).toBe(true);
  });
});

describe("every state of UI-SPEC §1.4: chip, frame area, activity line and controls", () => {
  type Row = {
    name: string;
    v: LiveView;
    state: LiveUiState;
    lines: string[];
    controls: string[];
    absent?: string[];
    image: boolean;
  };
  const rows: Row[] = [
    {
      name: "connecting",
      v: view({ conn: "connecting", server: null, viewerCan: null, hasFrame: false }),
      state: "connecting",
      lines: ["Connecting", "Connecting to Scout's browser…"],
      controls: ["live-expand", "live-close"],
      absent: ["live-take-control"],
      image: false,
    },
    {
      name: "live",
      v: view({ server: state({ activity: "clicking “Orders”" }) }),
      state: "live",
      lines: ["Live", "Scout is clicking “Orders”"],
      controls: ["live-take-control", "live-expand", "live-close"],
      image: true,
    },
    {
      name: "idle",
      v: view({ server: state({ state: "idle" }) }),
      state: "idle",
      lines: ["Idle", "Scout isn't doing anything right now."],
      controls: ["live-take-control", "live-expand", "live-close"],
      image: true,
    },
    {
      name: "paused for an approval",
      v: view({
        server: state({
          state: "paused",
          pausedFor: "approval",
          activity: "clicking “Pay”",
          approvalRoute: `/chat/dm/${ID}?m=${ID}`,
        }),
      }),
      state: "paused",
      lines: ["Paused", "Waiting for approval: clicking “Pay”", "Review"],
      controls: ["live-take-control", "live-expand", "live-close", "live-review"],
      image: true,
    },
    {
      name: "paused for a sign-in, the requester",
      v: view({ server: state({ state: "paused", pausedFor: "signin" }) }),
      state: "paused",
      lines: ["Paused", "Waiting for you to sign in"],
      controls: ["live-take-control", "live-close"],
      image: true,
    },
    {
      name: "paused for a sign-in, someone else",
      v: view({
        server: state({ state: "paused", pausedFor: "signin" }),
        viewerCan: { watch: true, control: false },
      }),
      state: "paused",
      lines: ["Paused", "Waiting for Sam Lee to sign in"],
      controls: ["live-expand", "live-close"],
      absent: ["live-take-control"],
      image: true,
    },
    {
      name: "private, someone else's takeover",
      v: view({
        server: state({
          state: "private",
          privateReason: "takeover",
          controller: "other",
          memberName: "Sam Lee",
          host: null,
          secure: null,
          requesterName: undefined,
        }),
        viewerCan: { watch: true, control: false },
        hasFrame: false,
      }),
      state: "private",
      lines: [
        "Private",
        "Private sign-in in progress",
        "Sam Lee is signing in. The view comes back when they hand control back.",
        "Scout is paused.",
      ],
      controls: ["live-expand", "live-close"],
      absent: ["live-take-control"],
      image: false,
    },
    {
      name: "private, the same person on another device",
      v: view({
        server: state({
          state: "private",
          privateReason: "takeover",
          controller: "other_device",
          host: null,
        }),
        hasFrame: false,
      }),
      state: "private",
      lines: ["Private sign-in in progress", "You're signing in on another device."],
      controls: ["live-expand", "live-close"],
      absent: ["live-take-control"],
      image: false,
    },
    {
      name: "private, a member session (U-2)",
      v: view({
        server: state({
          state: "private",
          privateReason: "member_session",
          memberName: "Sam",
          host: null,
          secure: null,
          requesterName: undefined,
        }),
        viewerCan: { watch: false, control: false },
        hasFrame: false,
      }),
      state: "private",
      lines: ["Private browsing for Sam", "Only Sam can watch while Scout uses their sign-in."],
      controls: ["live-close"],
      absent: ["live-take-control"],
      image: false,
    },
    {
      name: "reconnecting",
      v: view({ conn: "reconnecting" }),
      state: "reconnecting",
      lines: ["Reconnecting", "Connection lost. Reconnecting…"],
      controls: ["live-close"],
      absent: ["live-take-control", "live-expand"],
      image: true,
    },
    {
      name: "error",
      v: view({ conn: "error", server: null, hasFrame: false }),
      state: "error",
      lines: ["Error", "Couldn't connect to the live view.", "Try again"],
      controls: ["live-retry", "live-close"],
      absent: ["live-take-control", "live-expand"],
      image: false,
    },
    {
      name: "no permission",
      v: view({
        conn: "closed",
        server: state({ state: "no_permission", host: null, secure: null, requesterName: undefined }),
        viewerCan: { watch: false, control: false },
        hasFrame: false,
      }),
      state: "no_permission",
      lines: [
        "Unavailable",
        "You can't watch this browser",
        "Only people who can read the conversation where Scout works can watch it.",
      ],
      controls: ["live-close"],
      absent: ["live-take-control", "live-expand"],
      image: false,
    },
  ];
  for (const row of rows) {
    it(`${row.name}: ${row.lines.join(" · ")}`, () => {
      expect(uiStateOf(row.v)).toBe(row.state);
      const markup = small(row.v);
      expect(markup).toContain(`data-state="${row.state}"`);
      const words = text(markup);
      for (const line of row.lines) expect(words).toContain(line);
      expect(words).toContain(CHIP[row.state]);
      for (const id of row.controls) expect(has(markup, id), id).toBe(true);
      for (const id of row.absent ?? []) expect(has(markup, id), id).toBe(false);
      expect(markup.includes("<img"), "frame image").toBe(row.image);
    });
  }

  it("every ended reason has its one sentence; access_lost renders the no-permission placeholder", () => {
    const reasons: Array<[string, string]> = [
      ["closed_by_bot", "Scout closed the browser."],
      ["idle", "The browser closed after 5 minutes without activity."],
      ["kill_switch", "An admin stopped all bot browsers."],
      ["module_off", "Browser was turned off for you."],
      ["crashed", "The browser stopped unexpectedly. Scout can open it again."],
    ];
    for (const [endReason, sentence] of reasons) {
      const v = view({
        conn: "closed",
        server: state({ state: "ended", endReason: endReason as never }),
        hasFrame: false,
      });
      expect(uiStateOf(v)).toBe("ended");
      const markup = small(v);
      expect(text(markup)).toContain(sentence);
      expect(text(markup)).toContain("Ended");
      expect(has(markup, "live-take-control")).toBe(false);
      expect(has(markup, "live-expand")).toBe(false);
      expect(markup.includes("<img")).toBe(false);
    }
    const lost = view({ conn: "closed", server: state({ state: "ended", endReason: "access_lost" }) });
    expect(uiStateOf(lost)).toBe("no_permission");
    expect(placeholderOf(lost, "no_permission")?.title).toBe("You can't watch this browser");
  });

  it("controlling (large view): In control, the takeover bar, the amber ring and Hand back; no Minimize", () => {
    const v = view({ server: state({ state: "controlling", controller: "self" }), expanded: true });
    const markup = large(v);
    const words = text(markup);
    expect(words).toContain("In control");
    expect(words).toContain("You're in control. Scout is paused.");
    expect(words).toContain("Typing goes to the page · Shift+Esc gives your keyboard back");
    expect(has(markup, "live-hand-back")).toBe(true);
    expect(has(markup, "live-minimize")).toBe(false);
    expect(markup).toContain('role="application"');
    expect(markup).toContain('aria-roledescription="remote browser"');
    expect(markup).toContain('aria-label="panel.fake.test, controlled by you"');
    expect(markup).toContain("ring-amber-500");
    const handingBack = text(large({ ...v, pending: "release" }));
    expect(handingBack).toContain("Handing back…");
  });

  it("watching in the large view: the requester's Take control; others read who can take control", () => {
    const mine = large(view({ expanded: true }));
    expect(has(mine, "live-take-control")).toBe(true);
    expect(text(mine)).toContain("Take control");
    expect(has(mine, "live-minimize")).toBe(true);
    expect(mine).not.toContain('role="application"');
    const taking = text(large(view({ expanded: true, pending: "take" })));
    expect(taking).toContain("Taking control…");
    const theirs = large(view({ expanded: true, viewerCan: { watch: true, control: false } }));
    expect(has(theirs, "live-take-control")).toBe(false);
    expect(text(theirs)).toContain("Only Sam Lee can take control here.");
  });

  it("refusals read the fixed sentences", () => {
    const v = view();
    expect(refusalSentence("someone_else", v)).toBe("Someone else is in control right now.");
    expect(refusalSentence("not_allowed", v)).toBe("Only Sam Lee can take control here.");
    expect(refusalSentence("expired", v)).toBe("This sign-in expired. Ask Scout again.");
  });
});

describe("the idle lease (UI-SPEC §1.3)", () => {
  it("a changed expiresAt renews the deadline 10 minutes from now; the same one (the 9-minute warning) keeps it", () => {
    const first = nextLeaseDeadline({ expiresAt: null, deadline: null }, "2026-10-21T10:10:00.000Z", 1_000);
    expect(first).toBe(1_000 + LEASE_MS);
    expect(
      nextLeaseDeadline(
        { expiresAt: "2026-10-21T10:10:00.000Z", deadline: first },
        "2026-10-21T10:10:00.000Z",
        9e5,
      ),
    ).toBe(first);
    expect(
      nextLeaseDeadline(
        { expiresAt: "2026-10-21T10:10:00.000Z", deadline: first },
        "2026-10-21T10:11:00.000Z",
        60_000,
      ),
    ).toBe(60_000 + LEASE_MS);
  });

  it("the warning shows in the last minute with Keep control", () => {
    expect(leaseWarning(null, 0)).toBeNull();
    expect(leaseWarning(LEASE_MS, 0)).toBeNull();
    expect(leaseWarning(LEASE_MS, 9 * 60_000 + 1_000)).toBe(59);
    const v = view({
      server: state({ state: "controlling", controller: "self" }),
      leaseDeadline: Date.now() + 30_000,
    });
    const markup = renderToStaticMarkup(<TakeoverBar view={v} frameFocused={false} hintId="h" />);
    expect(text(markup)).toMatch(/Still there\? Control goes back to Scout in (29|30) s\./);
    expect(has(markup, "live-keep-control")).toBe(true);
    const calm = renderToStaticMarkup(
      <TakeoverBar view={{ ...v, leaseDeadline: Date.now() + LEASE_MS }} frameFocused={false} hintId="h" />,
    );
    expect(text(calm)).toContain("Click the page to type");
  });
});

describe("the small window's corners (UI-SPEC §1.1)", () => {
  const vp = { width: 1440, height: 900, rail: 240 };
  it("bottom-right by default is 16 from the right and 96 from the bottom; the left inset clears the rail", () => {
    expect(cornerPosition("bottom-right", vp)).toEqual({ left: 1440 - 16 - 320, top: 900 - 96 - 272 });
    expect(cornerPosition("top-left", vp)).toEqual({ left: 256, top: 72 });
  });
  it("a drop snaps to the nearest corner; arrows move to the adjacent one", () => {
    expect(nearestCorner(300, 500, vp)).toBe("bottom-left");
    expect(nearestCorner(1000, 80, vp)).toBe("top-right");
    expect(cornerAfterKey("bottom-right", "ArrowLeft")).toBe("bottom-left");
    expect(cornerAfterKey("bottom-left", "ArrowUp")).toBe("top-left");
    expect(cornerAfterKey("bottom-left", "ArrowLeft")).toBeNull();
    expect(cornerAfterKey("bottom-left", "Enter")).toBeNull();
  });
});

describe("Watch on a browser step (Surface 1b)", () => {
  const step: ActivityStep = {
    id: "s1",
    tool: "ocw_browser_open",
    verb: "opened",
    target: "panel.fake.test",
    outcome: { kind: "ok", code: null, exitCode: null, durationMs: 300 },
    signedIn: false,
    contextId: ID,
    contextOpen: true,
    approvalMessageRoute: null,
    details: null,
  };
  it("only a browser step whose page is open, with the bot known", () => {
    expect(watchable(step, BOT)).toBe(true);
    expect(watchable({ ...step, contextOpen: false }, BOT)).toBe(false);
    expect(watchable({ ...step, contextOpen: undefined }, BOT)).toBe(false);
    expect(watchable(step, undefined)).toBe(false);
    expect(watchable({ ...step, tool: "ocw_sandbox_write" }, BOT)).toBe(false);
    const viewer = { meId: null, requester: null };
    expect(
      has(renderToStaticMarkup(<ActivityStepRow step={step} viewer={viewer} bot={BOT} />), "activity-watch"),
    ).toBe(true);
    expect(
      has(
        renderToStaticMarkup(
          <ActivityStepRow step={{ ...step, contextOpen: false }} viewer={viewer} bot={BOT} />,
        ),
        "activity-watch",
      ),
    ).toBe(false);
  });
});

describe("the live-view socket (P-08)", () => {
  class FakeSocket {
    static all: FakeSocket[] = [];
    binaryType = "";
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    sent: string[] = [];
    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      FakeSocket.all.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("authenticates with the subprotocol, parses control frames, hands binary frames on, and stops after no_permission", async () => {
    FakeSocket.all = [];
    const servers: unknown[] = [];
    const frames: Blob[] = [];
    const statuses: string[] = [];
    connectLive(
      ID,
      { onServer: (f) => servers.push(f), onFrame: (b) => frames.push(b), onStatus: (s) => statuses.push(s) },
      {
        url: "ws://api.test/api/v1/live/browser/x",
        getToken: async () => "jwt",
        WebSocketCtor: FakeSocket as never,
      },
    );
    await flush();
    const ws = FakeSocket.all[0] as FakeSocket;
    expect(ws.protocols).toEqual(["ocw.v1", "ocw.auth.jwt"]);
    expect(ws.url).not.toContain("jwt");
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ type: "viewerCan", watch: false, control: false }) });
    ws.onmessage?.({ data: '{"type":"eval"}' });
    ws.onmessage?.({ data: "not json" });
    ws.onmessage?.({ data: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]) });
    ws.onmessage?.({
      data: JSON.stringify(state({ state: "no_permission", host: null, requesterName: undefined })),
    });
    ws.onclose?.({ code: 4403 });
    await flush();
    expect(servers).toHaveLength(2);
    expect(frames).toHaveLength(1);
    expect(statuses).toEqual(["connecting", "open", "closed"]);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("four silent checks close a socket the browser never reported dead, and it reconnects", async () => {
    vi.useFakeTimers();
    try {
      FakeSocket.all = [];
      const statuses: string[] = [];
      connectLive(
        ID,
        { onServer: noop, onFrame: noop, onStatus: (s) => statuses.push(s) },
        {
          url: "ws://api.test/x",
          getToken: async () => "jwt",
          WebSocketCtor: FakeSocket as never,
          random: () => 0,
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      (FakeSocket.all[0] as FakeSocket).open();
      // The heartbeat arrives: no reconnect.
      for (let i = 0; i < 6; i++) {
        (FakeSocket.all[0] as FakeSocket).onmessage?.({ data: JSON.stringify(state()) });
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(FakeSocket.all).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(statuses).toContain("reconnecting");
      await vi.advanceTimersByTimeAsync(10);
      expect(FakeSocket.all).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("send() writes JSON only while open", async () => {
    FakeSocket.all = [];
    const conn = connectLive(
      ID,
      { onServer: noop, onFrame: noop, onStatus: noop },
      { url: "ws://api.test/x", getToken: async () => "jwt", WebSocketCtor: FakeSocket as never },
    );
    expect(conn.send({ type: "take" })).toBe(false);
    await flush();
    (FakeSocket.all[0] as FakeSocket).open();
    expect(conn.send({ type: "take" })).toBe(true);
    expect((FakeSocket.all[0] as FakeSocket).sent).toEqual(['{"type":"take"}']);
    conn.close();
  });
});
