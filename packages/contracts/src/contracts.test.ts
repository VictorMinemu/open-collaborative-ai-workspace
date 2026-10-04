import { describe, expect, it } from "vitest";
import {
  AddUnitMemberRequest,
  AuthCapabilities,
  AvatarRef,
  ChangePasswordRequest,
  ClientFrame,
  ConversationKind,
  CreatePermissionRuleRequest,
  CreateUnitRequest,
  DeviceToServerFrame,
  extractMentionHandles,
  Invitation,
  MemberDetailList,
  MoveUnitRequest,
  onlyRelativePaths,
  PasswordResetLink,
  PostMessageRequest,
  parseTopic,
  RelativePath,
  RenameUnitRequest,
  RequestPasswordResetRequest,
  ResetPasswordRequest,
  ServerFrame,
  SessionEvent,
  SessionInfo,
  SessionList,
  StatusEmoji,
  StatusText,
  UnitMemberParams,
  UpdateMemberRoleRequest,
  UpdateProfileRequest,
  UserIdParams,
  userHandle,
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

describe("chat mention helpers", () => {
  it("extracts lowercased handles, trimming trailing punctuation", () => {
    expect(extractMentionHandles("@Archie, what about @alex.kim. and a@b.c?")).toEqual([
      "archie",
      "alex.kim",
    ]);
  });

  it("derives user handles from email, falling back to the name", () => {
    expect(userHandle({ displayName: "Víctor Ruiz", email: "Victor.Ruiz@x.com" })).toBe("victor.ruiz");
    expect(userHandle({ displayName: "Víctor Ruiz", email: null })).toBe("victorruiz");
  });
});

describe("wave-3 organization contracts", () => {
  const uid = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
  const rule = (over: Record<string, unknown>) =>
    CreatePermissionRuleRequest.safeParse({
      subjectKind: "everyone",
      subjectId: null,
      permission: "channel.archive",
      effect: "deny",
      ...over,
    }).success;

  it("permission rules: subject shape per kind", () => {
    expect(rule({})).toBe(true);
    expect(rule({ subjectId: uid })).toBe(false); // everyone takes no subject id
    expect(rule({ subjectKind: "role", subjectId: "developer" })).toBe(true);
    expect(rule({ subjectKind: "role", subjectId: "member" })).toBe(false);
    expect(rule({ subjectKind: "role", subjectId: null })).toBe(false);
    expect(rule({ subjectKind: "user", subjectId: uid })).toBe(true);
    expect(rule({ subjectKind: "agent", subjectId: uid })).toBe(true);
    expect(rule({ subjectKind: "user", subjectId: "developer" })).toBe(false);
    expect(rule({ subjectKind: "agent", subjectId: null })).toBe(false);
    expect(rule({ scopeUnitId: uid })).toBe(true);
    expect(rule({ scopeUnitId: "nope" })).toBe(false);
  });

  it("permission rules: non-delegable permissions cannot be allowed, only denied", () => {
    expect(rule({ effect: "allow", permission: "member.manage" })).toBe(false);
    expect(rule({ effect: "allow", permission: "rule.*" })).toBe(false);
    expect(rule({ effect: "deny", permission: "member.manage" })).toBe(true);
    expect(rule({ effect: "deny", permission: "rule.*" })).toBe(true);
    expect(rule({ effect: "allow", permission: "bot.manage" })).toBe(false); // admin surface
    expect(rule({ effect: "allow", permission: "device.link" })).toBe(false); // runtime surface
    expect(rule({ effect: "allow", permission: "work_session.*" })).toBe(true);
    expect(rule({ effect: "allow", permission: "channel.post" })).toBe(true);
  });

  it("permission rules: patterns and the tool layer", () => {
    expect(rule({ permission: "work_session.*" })).toBe(true);
    expect(rule({ permission: "nope.*" })).toBe(false);
    expect(rule({ permission: "work_session.approve", tool: "Bash" })).toBe(true);
    expect(rule({ permission: "work_session.*", tool: "mcp__github:create_pr" })).toBe(true);
    expect(rule({ permission: "channel.post", tool: "Bash" })).toBe(false);
    expect(rule({ permission: "work_session.approve", tool: "rm -rf" })).toBe(false);
    expect(rule({ permission: "work_session.approve", tool: "x".repeat(65) })).toBe(false);
    expect(rule({ permission: "work_session.approve", tool: "" })).toBe(false);
  });

  it("units: names are 1-80 characters; a move to the top level uses parentId null", () => {
    expect(CreateUnitRequest.safeParse({ kind: "department", name: "", parentId: null }).success).toBe(false);
    expect(CreateUnitRequest.safeParse({ kind: "department", name: "   ", parentId: null }).success).toBe(
      false,
    );
    expect(CreateUnitRequest.safeParse({ kind: "team", name: "x".repeat(81), parentId: uid }).success).toBe(
      false,
    );
    expect(CreateUnitRequest.parse({ kind: "team", name: "  Platform ", parentId: uid })).toEqual({
      kind: "team",
      name: "Platform",
      parentId: uid,
    });
    expect(CreateUnitRequest.safeParse({ kind: "squad", name: "A", parentId: null }).success).toBe(false);
    expect(MoveUnitRequest.parse({ parentId: null })).toEqual({ parentId: null });
    expect(RenameUnitRequest.safeParse({ name: "x".repeat(80) }).success).toBe(true);
    expect(AddUnitMemberRequest.parse({ userId: uid })).toEqual({ userId: uid, role: "member" });
    expect(UnitMemberParams.safeParse({ id: uid, userId: uid }).success).toBe(true);
    expect(UserIdParams.safeParse({ userId: "nope" }).success).toBe(false);
    expect(UpdateMemberRoleRequest.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("member detail extends the member projection with unit chips", () => {
    const m = {
      userId: uid,
      displayName: "Alex",
      email: null,
      avatarUrl: null,
      role: "developer",
      status: "active",
      statusEmoji: null,
      statusText: null,
      joinedAt: "2026-10-04T12:00:00.000Z",
      units: [{ unitId: uid, name: "Platform", kind: "team", role: "lead" }],
    };
    expect(MemberDetailList.parse({ members: [m] }).members[0]?.units[0]?.role).toBe("lead");
  });
});

describe("wave-3 identity contracts", () => {
  it("avatars are an https URL or a short emoji string", () => {
    expect(AvatarRef.safeParse("🦊").success).toBe(true);
    expect(AvatarRef.safeParse("👩🏽‍💻").success).toBe(true);
    expect(AvatarRef.safeParse("🇪🇸").success).toBe(true);
    expect(AvatarRef.safeParse("https://example.com/a.png").success).toBe(true);
    expect(AvatarRef.safeParse("http://example.com/a.png").success).toBe(false);
    expect(AvatarRef.safeParse("javascript:alert(1)").success).toBe(false);
    expect(AvatarRef.safeParse("data:image/png;base64,AAAA").success).toBe(false);
    expect(AvatarRef.safeParse("🦊".repeat(16)).success).toBe(true);
    expect(AvatarRef.safeParse("🦊".repeat(17)).success).toBe(false);
    expect(AvatarRef.safeParse("AB").success).toBe(false);
    expect(AvatarRef.safeParse("123").success).toBe(false);
    expect(AvatarRef.safeParse(`https://example.com/${"a".repeat(2048)}`).success).toBe(false);
    expect(StatusEmoji.safeParse("🌴").success).toBe(true);
    expect(StatusEmoji.safeParse("away").success).toBe(false);
    expect(StatusText.safeParse("x".repeat(81)).success).toBe(false);
  });

  it("profile updates need at least one field; nullable fields clear", () => {
    expect(UpdateProfileRequest.safeParse({}).success).toBe(false);
    expect(UpdateProfileRequest.safeParse({ statusEmoji: null, statusText: null }).success).toBe(true);
    expect(UpdateProfileRequest.safeParse({ displayName: "Alex" }).success).toBe(true);
    expect(UpdateProfileRequest.safeParse({ displayName: null }).success).toBe(false);
    expect(UpdateProfileRequest.safeParse({ avatarUrl: "javascript:alert(1)" }).success).toBe(false);
  });

  it("password contracts", () => {
    expect(
      ChangePasswordRequest.parse({ currentPassword: "old", newPassword: "a-new-long-password" })
        .revokeOtherSessions,
    ).toBe(true);
    expect(
      ChangePasswordRequest.parse({
        currentPassword: "old",
        newPassword: "a-new-long-password",
        revokeOtherSessions: false,
      }).revokeOtherSessions,
    ).toBe(false);
    expect(ResetPasswordRequest.safeParse({ token: "t".repeat(16), newPassword: "short" }).success).toBe(
      false,
    );
    expect(
      ResetPasswordRequest.safeParse({ token: "t".repeat(16), newPassword: "twelve-chars" }).success,
    ).toBe(true);
    expect(
      ResetPasswordRequest.safeParse({ token: "short", newPassword: "a-new-long-password" }).success,
    ).toBe(false);
    expect(RequestPasswordResetRequest.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(AuthCapabilities.parse({ passwordResetEmail: false })).toEqual({ passwordResetEmail: false });
  });

  it("session info never has a secret field and invitations expose their inviter", () => {
    expect(Object.keys(SessionInfo.shape).sort()).toEqual([
      "clientKind",
      "clientLabel",
      "createdAt",
      "current",
      "id",
      "ipAddress",
      "lastActiveAt",
    ]);
    expect(Invitation.shape.inviterId.safeParse(null).success).toBe(true);
    expect(SessionList.safeParse({ sessions: [] }).success).toBe(true);
    expect(PasswordResetLink.safeParse({ link: "x", expiresAt: "2026-10-05T12:00:00.000Z" }).success).toBe(
      true,
    );
  });
});
