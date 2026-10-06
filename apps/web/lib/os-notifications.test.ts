import { DEFAULT_NOTIFICATION_PREFS } from "@ocw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dndPresetUntil,
  focusedConversationOf,
  formatDndUntil,
  notificationPermission,
  osNotificationTitle,
  requestNotificationPermission,
  shouldPopup,
  showOsNotification,
  titleWithCount,
} from "./os-notifications";

const conv = "6f1c1a52-2b8e-4a36-9a43-0d2d4f1b7e01";
const other = "0b7f2f5e-8f3e-4f0a-b0a5-5b8d1d0c9a11";

const base = {
  popup: true,
  isDesktop: false,
  prefs: DEFAULT_NOTIFICATION_PREFS,
  focusedConversationId: other,
  conversationId: conv,
  visible: true,
};

describe("shouldPopup (the client applies only its own toggle and focus; the server decided popup)", () => {
  it("never pops what the server said not to", () => {
    expect(shouldPopup({ ...base, popup: false })).toBe(false);
    expect(shouldPopup(base)).toBe(true);
  });

  it("the web toggle applies in a browser, the desktop toggle inside the desktop app", () => {
    const webOff = { ...DEFAULT_NOTIFICATION_PREFS, webEnabled: false };
    const desktopOff = { ...DEFAULT_NOTIFICATION_PREFS, desktopEnabled: false };
    expect(shouldPopup({ ...base, prefs: webOff })).toBe(false);
    expect(shouldPopup({ ...base, prefs: webOff, isDesktop: true })).toBe(true);
    expect(shouldPopup({ ...base, prefs: desktopOff, isDesktop: true })).toBe(false);
    expect(shouldPopup({ ...base, prefs: desktopOff })).toBe(true);
  });

  it("no pop-up for the conversation already in front of the member", () => {
    expect(shouldPopup({ ...base, focusedConversationId: conv })).toBe(false);
    // In front but the tab is hidden: it pops.
    expect(shouldPopup({ ...base, focusedConversationId: conv, visible: false })).toBe(true);
    expect(shouldPopup({ ...base, focusedConversationId: null })).toBe(true);
  });
});

describe("focusedConversationOf", () => {
  it("reads channel and DM routes, nothing else", () => {
    expect(focusedConversationOf(`/chat/${conv}`)).toBe(conv);
    expect(focusedConversationOf(`/chat/dm/${conv}`)).toBe(conv);
    expect(focusedConversationOf("/chat/mentions")).toBeNull();
    expect(focusedConversationOf("/settings/notifications")).toBeNull();
  });
});

describe("titleWithCount", () => {
  it("prefixes (N) and replaces an older prefix; 0 clears it", () => {
    expect(titleWithCount("OCW", 2)).toBe("(2) OCW");
    expect(titleWithCount("(2) OCW", 3)).toBe("(3) OCW");
    expect(titleWithCount("(3) OCW", 0)).toBe("OCW");
    expect(titleWithCount("OCW", 250)).toBe("(99+) OCW");
  });
});

describe("osNotificationTitle", () => {
  const actor = { kind: "user" as const, id: other, displayName: "Ada Lovelace" };
  it("names the actor, and the conversation unless it is a DM", () => {
    expect(osNotificationTitle(actor, { kind: "channel", label: "#design" })).toBe("Ada Lovelace in #design");
    expect(osNotificationTitle(actor, { kind: "dm", label: "Ada Lovelace" })).toBe("Ada Lovelace");
    expect(osNotificationTitle(actor, { kind: "group", label: "Ada, Sam and Bo" })).toBe(
      "Ada Lovelace in Ada, Sam and Bo",
    );
  });
});

describe("Web Notifications API (D-02: no service worker, permission on a click only)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unsupported without the API", async () => {
    vi.stubGlobal("window", {});
    expect(notificationPermission()).toBe("unsupported");
    expect(await requestNotificationPermission()).toBe("denied");
    showOsNotification({ id: "x", title: "t", body: "b", onClick: () => {} });
  });

  it("shows with tag = id only when granted; click focuses and navigates", async () => {
    const made: Array<{ title: string; opts: NotificationOptions; self: Record<string, unknown> }> = [];
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string, opts: NotificationOptions) {
        made.push({ title, opts, self: this as unknown as Record<string, unknown> });
      }
    }
    const focus = vi.fn();
    vi.stubGlobal("window", { Notification: FakeNotification, focus });

    expect(notificationPermission()).toBe("default");
    showOsNotification({ id: "n1", title: "t", body: "b", onClick: () => {} });
    expect(made).toHaveLength(0);

    expect(await requestNotificationPermission()).toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    FakeNotification.permission = "granted";
    const onClick = vi.fn();
    showOsNotification({ id: "n1", title: "Ada in #design", body: "hi", onClick });
    expect(made).toHaveLength(1);
    expect(made[0]?.title).toBe("Ada in #design");
    expect(made[0]?.opts).toMatchObject({ body: "hi", tag: "n1" });
    const clicked = made[0]?.self.onclick as () => void;
    clicked();
    expect(focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();
  });

  it("never throws when the platform refuses the constructor (Android Chrome needs a service worker)", () => {
    class Throwing {
      static permission = "granted";
      constructor() {
        throw new TypeError("Illegal constructor");
      }
    }
    vi.stubGlobal("window", { Notification: Throwing, focus: () => {} });
    expect(() => showOsNotification({ id: "n", title: "t", body: "b", onClick: () => {} })).not.toThrow();
  });
});

describe("do-not-disturb presets", () => {
  // Monday 6 October 2026, 15:20 local time.
  const now = new Date(2026, 9, 6, 15, 20, 0);

  it("30 minutes, 1 hour, 2 hours and tomorrow 09:00 (local)", () => {
    expect(new Date(dndPresetUntil("30m", now)).getTime() - now.getTime()).toBe(30 * 60_000);
    expect(new Date(dndPresetUntil("1h", now)).getTime() - now.getTime()).toBe(3_600_000);
    expect(new Date(dndPresetUntil("2h", now)).getTime() - now.getTime()).toBe(7_200_000);
    const t = new Date(dndPresetUntil("tomorrow", now));
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([7, 9, 0]);
  });

  it("describes the end: a time today, tomorrow, or a date", () => {
    expect(formatDndUntil(new Date(2026, 9, 6, 16, 5).toISOString(), now)).toBe("16:05");
    expect(formatDndUntil(new Date(2026, 9, 7, 9, 0).toISOString(), now)).toBe("tomorrow 09:00");
    expect(formatDndUntil(new Date(2026, 9, 12, 9, 0).toISOString(), now)).toMatch(/12.*09:00/);
  });
});
