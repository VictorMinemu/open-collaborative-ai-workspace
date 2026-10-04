import { describe, expect, it } from "vitest";
import { clientFromRequest, clientFromUserAgent } from "./client-kind";

const UA = {
  electronMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ocw-desktop/0.1.0 Chrome/140.0.7339.80 Electron/38.1.0 Safari/537.36",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
};

describe("clientFromUserAgent", () => {
  it.each([
    [UA.electronMac, "desktop", "Desktop app on macOS"],
    [UA.chromeMac, "web", "Chrome on macOS"],
    [UA.edgeWindows, "web", "Edge on Windows"],
    [UA.firefoxLinux, "web", "Firefox on Linux"],
    [UA.safariIphone, "web", "Safari on iOS"],
    [UA.chromeAndroid, "web", "Chrome on Android"],
  ])("%s → %s / %s", (ua, kind, label) => {
    expect(clientFromUserAgent(ua)).toEqual({ kind, label });
  });

  it("a missing user agent is a web client without a label", () => {
    expect(clientFromUserAgent(undefined)).toEqual({ kind: "web", label: null });
    expect(clientFromUserAgent("")).toEqual({ kind: "web", label: null });
  });

  it("an unrecognised user agent gets no label", () => {
    expect(clientFromUserAgent("curl/8.7.1")).toEqual({ kind: "web", label: null });
  });
});

describe("clientFromRequest", () => {
  it("x-ocw-client wins over the user agent", () => {
    expect(clientFromRequest(new Headers({ "x-ocw-client": "mobile", "user-agent": UA.chromeMac }))).toEqual({
      kind: "mobile",
      label: "Chrome on macOS",
    });
    expect(clientFromRequest({ "x-ocw-client": "desktop", "user-agent": UA.firefoxLinux })).toEqual({
      kind: "desktop",
      label: "Firefox on Linux",
    });
  });

  it("an unknown x-ocw-client value is ignored", () => {
    expect(clientFromRequest({ "x-ocw-client": "system", "user-agent": UA.electronMac })).toEqual({
      kind: "desktop",
      label: "Desktop app on macOS",
    });
    expect(clientFromRequest(new Headers({ "x-ocw-client": "agent" }))).toEqual({ kind: "web", label: null });
  });

  it("reads node header records and missing headers", () => {
    expect(clientFromRequest({ "user-agent": UA.edgeWindows })).toEqual({
      kind: "web",
      label: "Edge on Windows",
    });
    expect(clientFromRequest(null)).toEqual({ kind: "web", label: null });
    expect(clientFromRequest(undefined)).toEqual({ kind: "web", label: null });
  });
});
