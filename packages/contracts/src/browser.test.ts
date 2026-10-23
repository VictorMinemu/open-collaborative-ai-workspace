import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { modelAcceptsImages } from "./agent";
import * as browser from "./browser";
import {
  AgentChannelBrowserAct,
  AgentChannelBrowserActResponse,
  AgentChannelBrowserClose,
  AgentChannelBrowserCloseResponse,
  AgentChannelBrowserOpen,
  AgentChannelBrowserOpenResponse,
  AgentChannelBrowserScreenshot,
  AgentChannelBrowserScreenshotResponse,
  AgentChannelBrowserSignIn,
  AgentChannelBrowserSignInResponse,
  AgentChannelBrowserSnapshot,
  AgentChannelBrowserSnapshotResponse,
  AgentChannelBrowserWait,
  AgentChannelBrowserWaitResponse,
  BROWSER_LIMITS,
  BROWSER_REFUSAL_STATUS,
  BrowserActivityItem,
  BrowserContextRow,
  BrowserContextState,
  BrowserEndReason,
  BrowserPrivateReason,
  BrowserRefusal,
  BrowserSessionItem,
  BrowserSessionList,
  BrowserSignInStatus,
  BrowserTabView,
  ConversationBrowserItem,
  ConversationBrowserList,
  LiveClientFrame,
  LiveInputFrame,
  LiveServerFrame,
} from "./browser";
// Published through `agent-cards.ts` (07.8-30): `index.ts` stays 07.8-01's alone during the parallel wave.
import * as index from "./index";
import { BrowserSandboxMode } from "./sandbox";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = "2026-10-15T10:00:00.000Z";
const turn = { eventId: ID, agentId: ID2 };

/** Every object key reachable in a Zod schema (same walker as connectors.test.ts). */
function schemaKeys(schema: z.ZodType, seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  const walk = (s: unknown) => schemaKeys(s as z.ZodType, seen);
  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, z.ZodType>;
      return Object.entries(shape).flatMap(([k, v]) => [k, ...walk(v)]);
    }
    case "array":
      return walk(def.element);
    case "record":
      return walk(def.valueType);
    case "union":
      return (def.options as z.ZodType[]).flatMap(walk);
    case "intersection":
      return [...walk(def.left), ...walk(def.right)];
    case "pipe":
      return [...walk(def.in), ...walk(def.out)];
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
    case "catch":
      return walk(def.innerType);
    case "lazy":
      return walk((def.getter as () => unknown)());
    default:
      return [];
  }
}

const isSchema = (v: unknown): v is z.ZodType =>
  typeof v === "object" && v !== null && "_zod" in v && "safeParse" in v;

describe("browser limits and refusals (07.8-30, D-05…D-08, D-11)", () => {
  it("names every limit once", () => {
    expect(BROWSER_LIMITS).toEqual({
      fps: 8,
      frameWidth: 960,
      frameHeight: 600,
      expandedWidth: 1280,
      expandedHeight: 800,
      jpegQuality: 55,
      idleStopMinutes: 5,
      holdMinutes: 15,
      approvalPendingMinutes: 15,
      takeoverWarnMinutes: 9,
      takeoverMinutes: 10,
      pasteMaxChars: 1000,
      reasonMaxChars: 200,
      sessionMaxDaysDefault: 30,
      mouseMoveHz: 30,
      urlMaxChars: 2000,
      typeMaxChars: 2000,
    });
  });

  it("BROWSER_REFUSAL_STATUS covers every BrowserRefusal value with an HTTP status", () => {
    expect(Object.keys(BROWSER_REFUSAL_STATUS).sort()).toEqual([...BrowserRefusal.options].sort());
    for (const code of BrowserRefusal.options) {
      expect([403, 404, 409, 413, 422, 503], code).toContain(BROWSER_REFUSAL_STATUS[code]);
    }
    // The existing Agent Channel convention: a post that answers no live turn is 403 `no_trigger`.
    expect(BROWSER_REFUSAL_STATUS.no_trigger).toBe(403);
    expect(BROWSER_REFUSAL_STATUS.not_found).toBe(404);
    expect(BROWSER_REFUSAL_STATUS.no_context).toBe(404);
    expect(BROWSER_REFUSAL_STATUS.screenshot_unavailable).toBe(404);
    expect(BROWSER_REFUSAL_STATUS.approval_required).toBe(409);
    expect(BROWSER_REFUSAL_STATUS.element_gone).toBe(409);
    expect(BROWSER_REFUSAL_STATUS.too_large).toBe(413);
    expect(BROWSER_REFUSAL_STATUS.service_unavailable).toBe(503);
    expect(BrowserRefusal.options).toHaveLength(28);
  });

  it("the enums are exactly the agreed values", () => {
    expect(BrowserContextState.options).toEqual([
      "connecting",
      "live",
      "idle",
      "paused",
      "private",
      "controlling",
      "reconnecting",
      "ended",
      "no_permission",
    ]);
    expect(BrowserEndReason.options).toEqual([
      "closed_by_bot",
      "idle",
      "kill_switch",
      "module_off",
      "crashed",
      "access_lost",
      "takeover_abandoned",
    ]);
    expect(BrowserPrivateReason.options).toEqual(["takeover", "member_session"]);
    expect(BrowserSignInStatus.options).toEqual([
      "waiting",
      "signing_in",
      "signed_in",
      "skipped",
      "expired",
      "stopped",
    ]);
    // D-14: Chromium's own sandbox state, reported honestly (never a silent `--no-sandbox` under runsc).
    expect(BrowserSandboxMode.options).toEqual(["chromium+gvisor", "chromium", "container-only"]);
  });
});

describe("Agent Channel browser bodies (P-07: no script, selector, DOM or cookie surface)", () => {
  it("open takes an http(s) URL only: no javascript:, file:, data:, chrome:, user info, over 2,000 characters or unknown key", () => {
    const ok = { ...turn, url: "https://panel.autofy.app/orders?x=1" };
    expect(AgentChannelBrowserOpen.parse(ok)).toEqual(ok);
    expect(AgentChannelBrowserOpen.safeParse({ ...turn, url: "http://localhost:8080/" }).success).toBe(true);
    const long = `https://a.example/${"x".repeat(2000 - "https://a.example/".length)}`;
    expect(long).toHaveLength(2000);
    expect(AgentChannelBrowserOpen.safeParse({ ...turn, url: long }).success).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>x</script>",
      "chrome://settings",
      "about:blank",
      "ftp://files.example/x",
      "https://user:pass@panel.autofy.app/",
      "https://user@panel.autofy.app/",
      "https://panel.autofy.app/\nx",
      "panel.autofy.app/orders",
      "",
      `${long}x`,
    ]) {
      expect(AgentChannelBrowserOpen.safeParse({ ...turn, url }).success, url).toBe(false);
    }
    expect(AgentChannelBrowserOpen.safeParse({ ...ok, newTab: true }).success).toBe(false);
    expect(AgentChannelBrowserOpen.safeParse({ ...ok, eventId: "nope" }).success).toBe(false);
  });

  it("act takes a snapshot ref and a closed action; a selector, script, expression or js key is refused", () => {
    expect(AgentChannelBrowserAct.parse({ ...turn, action: "click", ref: "e12" }).action).toBe("click");
    expect(
      AgentChannelBrowserAct.safeParse({ ...turn, action: "type", ref: "e3", text: "x".repeat(2000) })
        .success,
    ).toBe(true);
    expect(
      AgentChannelBrowserAct.safeParse({ ...turn, action: "select", ref: "e4", option: "Spain" }).success,
    ).toBe(true);
    expect(AgentChannelBrowserAct.safeParse({ ...turn, action: "press", key: "Enter" }).success).toBe(true);
    expect(AgentChannelBrowserAct.safeParse({ ...turn, action: "scroll", direction: "down" }).success).toBe(
      true,
    );
    for (const bad of [
      { ...turn, action: "evaluate", ref: "e1" },
      { ...turn, action: "hover", ref: "e1" },
      { ...turn, action: "click", ref: "e1", selector: "#buy" },
      { ...turn, action: "click", ref: "e1", script: "document.cookie" },
      { ...turn, action: "click", ref: "e1", expression: "1+1" },
      { ...turn, action: "click", ref: "e1", js: "x" },
      { ...turn, action: "type", ref: "e3", text: "x".repeat(2001) },
      // A ref is an opaque id from the redacted snapshot, never a CSS or XPath selector.
      { ...turn, action: "click", ref: "button[name=buy]" },
      { ...turn, action: "click", ref: "//button" },
      // Each action carries what it needs.
      { ...turn, action: "click" },
      { ...turn, action: "type", ref: "e3" },
      { ...turn, action: "select", ref: "e4" },
      { ...turn, action: "press" },
      { ...turn, action: "scroll" },
      { ...turn, action: "scroll", direction: "sideways" },
    ]) {
      expect(AgentChannelBrowserAct.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
    }
  });

  it("snapshot, screenshot, wait, sign-in and close are bounded strict bodies", () => {
    expect(AgentChannelBrowserSnapshot.parse(turn)).toEqual(turn);
    expect(AgentChannelBrowserSnapshot.safeParse({ ...turn, html: true }).success).toBe(false);
    expect(AgentChannelBrowserScreenshot.parse(turn)).toEqual(turn);
    expect(AgentChannelBrowserScreenshot.safeParse({ ...turn, fullPage: true }).success).toBe(false);
    expect(AgentChannelBrowserClose.parse(turn)).toEqual(turn);
    expect(AgentChannelBrowserWait.safeParse({ ...turn, for: "load" }).success).toBe(true);
    expect(AgentChannelBrowserWait.safeParse({ ...turn, for: "text", text: "Orders" }).success).toBe(true);
    expect(AgentChannelBrowserWait.safeParse({ ...turn, for: "time", ms: 30_000 }).success).toBe(true);
    for (const bad of [
      { ...turn, for: "time", ms: 30_001 },
      { ...turn, for: "time" },
      { ...turn, for: "text" },
      { ...turn, for: "network" },
      { ...turn, for: "load", script: "x" },
    ]) {
      expect(AgentChannelBrowserWait.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      AgentChannelBrowserSignIn.safeParse({ ...turn, reason: "I need the orders dashboard." }).success,
    ).toBe(true);
    expect(AgentChannelBrowserSignIn.safeParse({ ...turn, reason: "x".repeat(201) }).success).toBe(false);
    expect(AgentChannelBrowserSignIn.safeParse({ ...turn, reason: "  " }).success).toBe(false);
    // The bot supplies only the reason: the host comes from the page (platform-derived), never the model.
    expect(AgentChannelBrowserSignIn.safeParse({ ...turn, reason: "r", host: "evil.example" }).success).toBe(
      false,
    );
  });

  it("responses carry hosts, page text and masked images only", () => {
    const base = { contextId: ID, host: "panel.autofy.app" };
    expect(
      AgentChannelBrowserOpenResponse.parse({ ...base, secure: true, title: "Orders", signedIn: false }).host,
    ).toBe("panel.autofy.app");
    expect(
      AgentChannelBrowserSnapshotResponse.safeParse({
        ...base,
        title: "Orders",
        text: '[e1] button "Place order"',
        truncated: false,
        signedIn: true,
      }).success,
    ).toBe(true);
    const act = { ...base, signedIn: true, navigated: false, download: null };
    expect(AgentChannelBrowserActResponse.parse(act)).toEqual(act);
    expect(
      AgentChannelBrowserActResponse.safeParse({
        ...act,
        download: { name: "orders.csv", size: 120, stored: "workspace", path: "downloads/orders.csv" },
      }).success,
    ).toBe(true);
    expect(
      AgentChannelBrowserActResponse.safeParse({
        ...act,
        download: { name: "orders.csv", size: 120, stored: "conversation", attachmentId: ID },
      }).success,
    ).toBe(true);
    for (const download of [
      { name: "orders.csv", size: 120, stored: "workspace", path: "/workspace/downloads/orders.csv" },
      { name: "orders.csv", size: 120, stored: "workspace" },
      { name: "orders.csv", size: 120, stored: "conversation" },
      { name: "orders.csv", size: 120, stored: "host" },
    ]) {
      expect(
        AgentChannelBrowserActResponse.safeParse({ ...act, download }).success,
        JSON.stringify(download),
      ).toBe(false);
    }
    const image = { mimeType: "image/jpeg", data: "/9j/4AAQ", width: 960, height: 600, masked: 2 };
    expect(AgentChannelBrowserScreenshotResponse.parse({ ...base, image }).image.masked).toBe(2);
    expect(
      AgentChannelBrowserScreenshotResponse.safeParse({
        ...base,
        image: { ...image, mimeType: "image/svg+xml" },
      }).success,
    ).toBe(false);
    expect(AgentChannelBrowserWaitResponse.parse({ ...base, ok: true }).ok).toBe(true);
    expect(AgentChannelBrowserSignInResponse.parse({ posted: true, host: "panel.autofy.app" }).posted).toBe(
      true,
    );
    expect(AgentChannelBrowserCloseResponse.parse({ closed: true })).toEqual({ closed: true });
    expect(AgentChannelBrowserOpenResponse.safeParse({ ...base, host: "https://x/" }).success).toBe(false);
  });

  it("no exported schema of browser.ts has a key for page script, DOM, cookies, storage or HAR", () => {
    const forbidden = new Set([
      "cookies",
      "cookie",
      "storageState",
      "localStorage",
      "html",
      "dom",
      "har",
      "script",
      "evaluate",
      "selector",
      "expression",
    ]);
    const schemas = Object.entries(browser).filter(([, v]) => isSchema(v)) as Array<[string, z.ZodType]>;
    expect(schemas.length).toBeGreaterThan(25);
    for (const [name, schema] of schemas) {
      for (const key of schemaKeys(schema)) expect(forbidden.has(key), `${name}.${key}`).toBe(false);
    }
  });
});

describe("live-view frames (P-08, UI-SPEC R3)", () => {
  it("client frames: take, release, keep, resize and the closed input union", () => {
    for (const frame of [
      { type: "take" },
      { type: "release" },
      { type: "keep" },
      { type: "resize", mode: "small" },
      { type: "resize", mode: "phone", width: 390, height: 700 },
      { type: "key", event: "down", key: "a", code: "KeyA", modifiers: 0 },
      { type: "key", event: "up", key: "Enter", code: "Enter", modifiers: 8 },
      { type: "text", text: "x".repeat(1000) },
      { type: "mouse", event: "move", x: 10, y: 20, button: "none" },
      { type: "mouse", event: "down", x: 10.5, y: 20, button: "left" },
      { type: "wheel", x: 10, y: 20, dx: 0, dy: -120 },
      { type: "touch", event: "start", x: 100, y: 200 },
    ]) {
      expect(LiveClientFrame.parse(frame), JSON.stringify(frame)).toEqual(frame);
    }
    for (const bad of [
      { type: "text", text: "x".repeat(1001) },
      { type: "text", text: "" },
      { type: "eval", code: "x" },
      { type: "mouse", event: "move", button: "none" },
      { type: "mouse", event: "down", x: -1, y: 0, button: "left" },
      { type: "mouse", event: "down", x: Number.NaN, y: 0, button: "left" },
      { type: "key", event: "down", key: "a", code: "KeyA", modifiers: 16 },
      { type: "key", event: "press", key: "a", code: "KeyA", modifiers: 0 },
      { type: "resize", mode: "phone" },
      { type: "resize", mode: "fullscreen" },
      { type: "take", contextId: ID },
      { type: "touch", event: "start", x: 1, y: 2, script: "x" },
    ]) {
      expect(LiveClientFrame.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
    }
    // The input union alone refuses the control frames.
    expect(LiveInputFrame.safeParse({ type: "take" }).success).toBe(false);
    expect(LiveInputFrame.safeParse({ type: "text", text: "hola" }).success).toBe(true);
  });

  it("07.8-22: a state with the page names the member the bot browses for (requesterName, bounded, optional)", () => {
    const live = {
      type: "state",
      state: "live",
      pausedFor: null,
      activity: "clicking “Orders”",
      host: "panel.autofy.app",
      secure: true,
      controller: null,
      requesterName: "Sam Lee",
    };
    expect(LiveServerFrame.parse(live)).toEqual(live);
    const { requesterName: _omit, ...without } = live;
    expect(LiveServerFrame.parse(without)).toEqual(without);
    expect(LiveServerFrame.safeParse({ ...live, requesterName: "x".repeat(201) }).success).toBe(false);
  });

  it("server frames: state (incl. private for a member session), viewerCan, lease and focus", () => {
    const state = {
      type: "state",
      state: "private",
      pausedFor: null,
      activity: null,
      host: "panel.autofy.app",
      secure: true,
      controller: "other",
      privateReason: "member_session",
      memberName: "Sam Ruiz",
    };
    expect(LiveServerFrame.parse(state)).toEqual(state);
    expect(
      LiveServerFrame.safeParse({
        type: "state",
        state: "paused",
        pausedFor: "approval",
        activity: "Waiting for approval: Click “Place order” on shop.example.com",
        host: "shop.example.com",
        secure: true,
        controller: null,
        approvalRoute: `/approvals/${ID}`,
      }).success,
    ).toBe(true);
    expect(
      LiveServerFrame.safeParse({
        type: "state",
        state: "ended",
        endReason: "kill_switch",
        pausedFor: null,
        activity: null,
        host: "panel.autofy.app",
        secure: true,
        controller: null,
      }).success,
    ).toBe(true);
    // A viewer without access learns nothing about the page: no host.
    expect(
      LiveServerFrame.safeParse({
        type: "state",
        state: "no_permission",
        pausedFor: null,
        activity: null,
        host: null,
        secure: null,
        controller: null,
      }).success,
    ).toBe(true);
    expect(LiveServerFrame.parse({ type: "viewerCan", watch: true, control: false })).toEqual({
      type: "viewerCan",
      watch: true,
      control: false,
    });
    expect(LiveServerFrame.safeParse({ type: "lease", expiresAt: NOW }).success).toBe(true);
    expect(LiveServerFrame.safeParse({ type: "focus", sensitive: true }).success).toBe(true);
    // 07.8-16 (additive): a refused `take` names its reason only.
    expect(LiveServerFrame.safeParse({ type: "refused", op: "take", reason: "someone_else" }).success).toBe(
      true,
    );
    expect(LiveServerFrame.safeParse({ type: "refused", op: "take", reason: "nope" }).success).toBe(false);
    for (const bad of [
      { ...state, privateReason: undefined },
      { ...state, state: "ended" },
      { ...state, activity: "x".repeat(81) },
      { ...state, approvalRoute: "https://evil.example/approve" },
      { ...state, html: "<p>x</p>" },
      { type: "frame", data: "x" },
    ]) {
      expect(LiveServerFrame.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
    }
  });
});

describe("sign-in card link, sessions and the Browser tab (R1, R7, D-08, D-12 U-3)", () => {
  const card = {
    kind: "browser",
    title: "Sign in to panel.autofy.app",
    fields: [{ label: "Site", value: "panel.autofy.app" }],
    status: "pending",
    actions: [],
    version: 1,
    decision: null,
    updatedAt: NOW,
    platformOwned: true,
    viewerCan: ["sign_in"],
    browserSignIn: {
      contextId: ID,
      host: "panel.autofy.app",
      secure: true,
      requesterId: ID2,
      status: "waiting",
      expiresAt: NOW,
      sessionExpiresAt: null,
      stopReason: null,
    },
  };

  it("a browser card with its sign-in link parses through the package index; a 07.5 card without it still parses", () => {
    expect(index.AgentCard.parse(card).browserSignIn?.status).toBe("waiting");
    expect(index.AgentCardKind.options).toContain("browser");
    const { browserSignIn: _link, ...old } = card;
    expect(
      index.AgentCard.parse({ ...old, kind: "approval", viewerCan: ["follow", "decide"] }).browserSignIn,
    ).toBe(undefined);
    expect(
      index.AgentCard.safeParse({ ...card, browserSignIn: { ...card.browserSignIn, status: "done" } })
        .success,
    ).toBe(false);
    expect(
      index.AgentCard.safeParse({
        ...card,
        browserSignIn: { ...card.browserSignIn, status: "stopped", stopReason: "kill_switch" },
      }).success,
    ).toBe(true);
    expect(
      index.AgentCard.safeParse({ ...card, browserSignIn: { ...card.browserSignIn, stopReason: "bored" } })
        .success,
    ).toBe(false);
    // The browser contracts are importable from the package index (through agent-cards.ts).
    expect(index.LiveInputFrame).toBe(LiveInputFrame);
    expect(index.BrowserSessionItem).toBe(BrowserSessionItem);
    expect(index.BROWSER_REFUSAL_STATUS).toBe(BROWSER_REFUSAL_STATUS);
  });

  it("an agent can never post a browser card: not an AgentCardInput kind (platform-owned, R1)", () => {
    const post = {
      agentId: ID2,
      conversationId: ID,
      threadRootId: null,
      eventId: ID,
      idempotencyKey: "card-0001",
      card: { kind: "generic", title: "T", fields: [], status: "info", actions: [], summary: "S" },
    };
    expect(index.AgentChannelPostCard.safeParse(post).success).toBe(true);
    expect(index.AgentCardInput.safeParse({ ...post.card, kind: "browser" }).success).toBe(false);
    expect(
      index.AgentChannelPostCard.safeParse({ ...post, card: { ...post.card, kind: "browser" } }).success,
    ).toBe(false);
  });

  it("a browser session item names the site, the bot and the dates, and nothing that could carry a secret", () => {
    const item = {
      id: ID,
      site: "panel.autofy.app",
      agentId: ID2,
      agentName: "Scout",
      createdAt: NOW,
      lastUsedAt: null,
      expiresAt: NOW,
      status: "active",
    };
    expect(BrowserSessionItem.parse(item)).toEqual(item);
    expect(BrowserSessionList.parse({ items: [item] }).items).toHaveLength(1);
    expect(Object.keys(BrowserSessionItem.shape).sort()).toEqual(
      ["id", "site", "agentId", "agentName", "createdAt", "lastUsedAt", "expiresAt", "status"].sort(),
    );
    expect(BrowserSessionItem.safeParse({ ...item, cookies: [] }).success).toBe(false);
    expect(BrowserSessionItem.safeParse({ ...item, username: "sam" }).success).toBe(false);
    expect(BrowserSessionItem.safeParse({ ...item, status: "revoked" }).success).toBe(false);
  });

  it("the Browser tab: open contexts, recent host activity (≤ 20) and the isolation runtime", () => {
    const row = {
      contextId: ID,
      host: "panel.autofy.app",
      secure: true,
      state: "live",
      conversation: { kind: "dm", name: "DM with you", route: `/chat/${ID}` },
      openedAt: NOW,
      viewerCan: { watch: true, control: true },
      privateFor: null,
    };
    const activity = {
      kind: "signed_in",
      host: "panel.autofy.app",
      conversation: { kind: "dm", name: "DM with you" },
      at: NOW,
      actor: { id: ID2, displayName: "Sam Ruiz" },
    };
    expect(BrowserContextRow.parse(row)).toEqual(row);
    expect(BrowserActivityItem.parse(activity)).toEqual(activity);
    const view = { open: [row], activity: [activity], nextCursor: null, runtime: "gvisor" };
    expect(BrowserTabView.parse(view)).toEqual(view);
    expect(BrowserTabView.parse({ ...view, browserSandbox: "container-only" }).browserSandbox).toBe(
      "container-only",
    );
    expect(BrowserTabView.safeParse({ ...view, activity: Array(21).fill(activity) }).success).toBe(false);
    expect(BrowserTabView.safeParse({ ...view, runtime: "runc" }).success).toBe(false);
    expect(
      BrowserContextRow.safeParse({
        ...row,
        conversation: { ...row.conversation, route: "https://x.example" },
      }).success,
    ).toBe(false);
    expect(BrowserActivityItem.safeParse({ ...activity, kind: "navigated" }).success).toBe(false);
    // 07.8-27: a private row names its reason (a takeover, or a member's saved sign-in on the page).
    const privateRow = { ...row, state: "private", privateFor: "Sam Ruiz", privateReason: "member_session" };
    expect(BrowserContextRow.parse(privateRow)).toEqual(privateRow);
    expect(BrowserContextRow.safeParse({ ...privateRow, privateReason: "cookie" }).success).toBe(false);
    // Hosts only: never a page address.
    expect(BrowserActivityItem.safeParse({ ...activity, url: "https://panel.autofy.app/x" }).success).toBe(
      false,
    );
  });
});

describe("07.8-26: the sign-in card's names and the conversation's open pages (UI-SPEC Surface 1b, Surface 2)", () => {
  const link = {
    contextId: ID,
    host: "panel.autofy.app",
    secure: true,
    requesterId: ID2,
    status: "signed_in",
    expiresAt: NOW,
    sessionExpiresAt: NOW,
    stopReason: null,
  };

  it("the sign-in link may name its requester and when it was decided (additive, bounded)", () => {
    const named = index.AgentCardBrowserSignInLink.parse({
      ...link,
      requesterName: "Sam Lee",
      decidedAt: NOW,
    });
    expect(named.requesterName).toBe("Sam Lee");
    expect(named.decidedAt).toBe(NOW);
    expect(index.AgentCardBrowserSignInLink.parse(link).requesterName).toBe(undefined);
    expect(
      index.AgentCardBrowserSignInLink.safeParse({ ...link, requesterName: "x".repeat(201) }).success,
    ).toBe(false);
    expect(index.AgentCardBrowserSignInLink.safeParse({ ...link, decidedAt: "yesterday" }).success).toBe(
      false,
    );
  });

  it("a conversation's open pages: the page's host, the bot and the thread, nothing about the page itself", () => {
    const item = {
      contextId: ID,
      host: "panel.autofy.app",
      secure: true,
      bot: { id: ID2, displayName: "Scout", avatarUrl: null },
      threadRootId: null,
    };
    expect(ConversationBrowserItem.parse(item)).toEqual(item);
    expect(
      ConversationBrowserList.parse({ items: [item, { ...item, threadRootId: ID }] }).items,
    ).toHaveLength(2);
    expect(ConversationBrowserItem.safeParse({ ...item, url: "https://panel.autofy.app/x" }).success).toBe(
      false,
    );
    expect(ConversationBrowserItem.safeParse({ ...item, host: "https://panel.autofy.app/x" }).success).toBe(
      false,
    );
    expect(ConversationBrowserList.safeParse({ items: Array(51).fill(item) }).success).toBe(false);
    expect(index.ConversationBrowserList).toBe(ConversationBrowserList);
  });
});

describe("modelAcceptsImages (07.8-14, D-14)", () => {
  it("known image families read images; unknown and subscription models fail closed", () => {
    expect(modelAcceptsImages("anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(modelAcceptsImages("openai", "gpt-5-mini")).toBe(true);
    expect(modelAcceptsImages("openai", "gpt-4.1")).toBe(true);
    expect(modelAcceptsImages("openrouter", "anthropic/claude-sonnet-5.5")).toBe(true);
    expect(modelAcceptsImages("mock", "mock-1")).toBe(true);
    expect(modelAcceptsImages("openai", "text-embedding-3-small")).toBe(false);
    expect(modelAcceptsImages("openai-compatible", "llama-3.1-70b")).toBe(false);
    expect(modelAcceptsImages("openai-codex", "gpt-5-codex")).toBe(false);
    expect(modelAcceptsImages("openrouter", "meta-llama/llama-3.1-8b")).toBe(false);
  });
});
