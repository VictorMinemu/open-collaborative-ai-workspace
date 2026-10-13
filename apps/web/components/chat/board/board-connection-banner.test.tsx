import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BOARD_BANNER_DELAY_MS,
  BOARD_CONNECTION_COPY,
  ConnectionBannerRow,
  connectionBannerKind,
} from "./board-connection-banner";

/**
 * The board's connection banner (07.1-09, D-03, 07.1-UI-SPEC Offline and reconnecting): which copy a live-connection
 * status shows, and the 32 px status row under the toolbar.
 */

describe("connectionBannerKind", () => {
  it("open and connecting show nothing", () => {
    expect(connectionBannerKind("open", true)).toBeNull();
    expect(connectionBannerKind("connecting", true)).toBeNull();
    expect(connectionBannerKind("connecting", false)).toBeNull();
  });

  it("reconnecting says reconnecting while the browser is online, offline when it is not", () => {
    expect(connectionBannerKind("reconnecting", true)).toBe("reconnecting");
    expect(connectionBannerKind("reconnecting", false)).toBe("offline");
  });

  it("closed and idle say offline", () => {
    expect(connectionBannerKind("closed", true)).toBe("offline");
    expect(connectionBannerKind("idle", true)).toBe("offline");
    expect(connectionBannerKind("idle", false)).toBe("offline");
  });

  it("waits 3 s before showing", () => {
    expect(BOARD_BANNER_DELAY_MS).toBe(3000);
  });
});

describe("ConnectionBannerRow", () => {
  it("has the UI-SPEC copy", () => {
    expect(BOARD_CONNECTION_COPY).toEqual({
      reconnecting: "Reconnecting… Changes from others will show up when you're back.",
      offline: "You're offline. Changes from others will show up when you reconnect.",
    });
  });

  it("is a status row (not an alert) with the WifiOff icon, muted and padded like the toolbar", () => {
    const html = renderToStaticMarkup(<ConnectionBannerRow kind="offline" />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('data-testid="board-connection-banner"');
    expect(html).toContain('data-kind="offline"');
    expect(html).toContain("lucide-wifi-off");
    expect(html).toContain('aria-hidden="true"');
    for (const cls of ["min-h-8", "bg-muted/60", "text-muted-foreground", "text-xs", "px-4", "md:px-6"]) {
      expect(html).toContain(cls);
    }
    expect(html).toContain("You&#x27;re offline. Changes from others will show up when you reconnect.");
  });

  it("reconnecting copy", () => {
    const html = renderToStaticMarkup(<ConnectionBannerRow kind="reconnecting" />);
    expect(html).toContain("Reconnecting… Changes from others will show up when you&#x27;re back.");
  });
});
