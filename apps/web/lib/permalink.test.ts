import { describe, expect, it } from "vitest";
import { isPermalinkId, parsePermalink, permalinkPath } from "./permalink";

const conv = "6f1c1a52-2b8e-4a36-9a43-0d2d4f1b7e01";
const msg = "0b7f2f5e-8f3e-4f0a-b0a5-5b8d1d0c9a11";
const root = "c5d0e3a4-1f2b-4c3d-8e9f-0a1b2c3d4e5f";

describe("permalinkPath (P-06: ids only)", () => {
  it("channel message", () => {
    expect(permalinkPath({ id: conv, kind: "channel" }, msg)).toBe(`/chat/${conv}?m=${msg}`);
  });
  it("thread reply keeps the root as thread=", () => {
    expect(permalinkPath({ id: conv, kind: "channel" }, msg, root)).toBe(
      `/chat/${conv}?thread=${root}&m=${msg}`,
    );
  });
  it("DMs and group DMs live under /chat/dm and are flat", () => {
    expect(permalinkPath({ id: conv, kind: "dm" }, msg)).toBe(`/chat/dm/${conv}?m=${msg}`);
    expect(permalinkPath({ id: conv, kind: "group" }, msg, root)).toBe(`/chat/dm/${conv}?m=${msg}`);
  });
  it("never lets a value break out of its parameter", () => {
    expect(permalinkPath({ id: "a/b", kind: "channel" }, "x&thread=y")).toBe("/chat/a%2Fb?m=x%26thread%3Dy");
  });
});

describe("parsePermalink", () => {
  it("round-trips permalinkPath", () => {
    const path = permalinkPath({ id: conv, kind: "channel" }, msg, root);
    expect(parsePermalink(new URL(path, "http://x").searchParams)).toEqual({
      messageId: msg,
      threadRootId: root,
    });
  });
  it("absent or empty values are null", () => {
    expect(parsePermalink(new URLSearchParams(""))).toEqual({ messageId: null, threadRootId: null });
    expect(parsePermalink(new URLSearchParams("m=&thread=%20"))).toEqual({
      messageId: null,
      threadRootId: null,
    });
  });
  it("keeps a malformed id as given (the view reports it unavailable)", () => {
    expect(parsePermalink(new URLSearchParams("m=nope")).messageId).toBe("nope");
    expect(isPermalinkId("nope")).toBe(false);
    expect(isPermalinkId(msg)).toBe(true);
  });
});
