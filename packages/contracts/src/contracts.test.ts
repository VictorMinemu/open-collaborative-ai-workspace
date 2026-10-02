import { describe, expect, it } from "vitest";
import {
  ClientFrame,
  ConversationKind,
  DeviceToServerFrame,
  onlyRelativePaths,
  PostMessageRequest,
  parseTopic,
  RelativePath,
  ServerFrame,
  SessionEvent,
} from "./index";

const id = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";

describe("contracts", () => {
  it("conversation kinds are the exact unified set", () => {
    expect(ConversationKind.options).toEqual(["channel", "dm", "group", "ai_chat", "thread", "work_session"]);
  });

  it("parses realtime frames and rejects bad topics", () => {
    expect(ClientFrame.parse({ op: "sub", topic: `conv:${id}`, afterSeq: 3 })).toMatchObject({ op: "sub" });
    expect(ClientFrame.safeParse({ op: "sub", topic: "conv:nope" }).success).toBe(false);
    expect(
      ServerFrame.parse({ op: "ev", topic: `conv:${id}`, seq: 1, type: "message.created", data: {} }).op,
    ).toBe("ev");
    expect(parseTopic(`ws:${id}`)).toEqual({ prefix: "ws", id });
    expect(parseTopic("bad:1")).toBeNull();
  });

  it("rejects absolute host paths", () => {
    expect(RelativePath.safeParse("src/index.ts").success).toBe(true);
    for (const p of ["/Users/me/repo/a.ts", "C:\\repo\\a.ts", "~/x", "../etc/passwd", "a/../../b"]) {
      expect(RelativePath.safeParse(p).success, p).toBe(false);
    }
    expect(onlyRelativePaths(["src/a.ts", "/etc/hosts", "~/x", "../y"])).toEqual(["src/a.ts"]);
  });

  it("defaults mentions and validates device frames", () => {
    expect(PostMessageRequest.parse({ body: "hi" }).mentions).toEqual([]);
    expect(
      DeviceToServerFrame.parse({
        type: "event",
        sessionId: id,
        localSeq: 3,
        event: { type: "session.state", status: "running" },
      }).type,
    ).toBe("event");
    expect(
      SessionEvent.safeParse({ type: "approval.resolved", approvalId: id, decision: "expired" }).success,
    ).toBe(true);
    expect(
      DeviceToServerFrame.safeParse({
        type: "command",
        id: "c1",
        kind: "session.start",
        sessionId: id,
      }).success,
    ).toBe(false);
  });
});
