import { describe, expect, it } from "vitest";
import {
  deriveApiUrl,
  isAllowedNavigation,
  isLocalHost,
  isSafeExternalUrl,
  normalizeServerUrl,
  redactRemote,
  UrlError,
} from "./urls";

describe("normalizeServerUrl", () => {
  it("adds http:// to bare local hosts and strips paths", () => {
    expect(normalizeServerUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeServerUrl(" http://192.168.1.20:3000/chat?x=1 ")).toBe("http://192.168.1.20:3000");
    expect(normalizeServerUrl("https://ocw.example.com/")).toBe("https://ocw.example.com");
  });

  it("requires https for public hosts", () => {
    expect(() => normalizeServerUrl("http://ocw.example.com")).toThrow(UrlError);
  });

  it("rejects other schemes, credentials and garbage", () => {
    expect(() => normalizeServerUrl("file:///etc/passwd")).toThrow(UrlError);
    expect(() => normalizeServerUrl("javascript:alert(1)")).toThrow(UrlError);
    expect(() => normalizeServerUrl("https://user:pw@ocw.example.com")).toThrow(UrlError);
    expect(() => normalizeServerUrl("")).toThrow(UrlError);
    expect(() => normalizeServerUrl("http://")).toThrow(UrlError);
  });
});

describe("isLocalHost", () => {
  it("recognises loopback, private ranges and .local", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "172.20.1.1",
      "192.168.0.2",
      "mac.local",
      "[::1]",
    ]) {
      expect(isLocalHost(h)).toBe(true);
    }
    for (const h of ["example.com", "172.32.0.1", "8.8.8.8"]) expect(isLocalHost(h)).toBe(false);
  });
});

describe("deriveApiUrl", () => {
  it("maps the Stage A web port 3000 to API port 4000", () => {
    expect(deriveApiUrl("http://localhost:3000")).toBe("http://localhost:4000");
  });
  it("keeps the same origin otherwise (reverse proxy)", () => {
    expect(deriveApiUrl("https://ocw.example.com")).toBe("https://ocw.example.com");
  });
});

describe("isAllowedNavigation", () => {
  const origin = "http://localhost:3000";
  it("allows same-origin navigation", () => {
    expect(isAllowedNavigation("http://localhost:3000/chat/abc", origin)).toBe(true);
  });
  it("blocks other origins, ports, schemes and invalid URLs", () => {
    expect(isAllowedNavigation("http://localhost:4000/docs", origin)).toBe(false);
    expect(isAllowedNavigation("https://localhost:3000/", origin)).toBe(false);
    expect(isAllowedNavigation("https://evil.example.com/", origin)).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd", origin)).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", origin)).toBe(false);
    expect(isAllowedNavigation("not a url", origin)).toBe(false);
  });
});

describe("isSafeExternalUrl", () => {
  it("allows only http(s) without credentials", () => {
    expect(isSafeExternalUrl("https://github.com/x")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("file:///Applications/Calculator.app")).toBe(false);
    expect(isSafeExternalUrl("smb://server/share")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("https://a:b@example.com")).toBe(false);
  });
});

describe("redactRemote", () => {
  it("strips credentials from https remotes and leaves ssh remotes alone", () => {
    expect(redactRemote("https://user:ghp_secret@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(redactRemote("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(redactRemote(null)).toBeNull();
  });
});
