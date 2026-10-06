import { describe, expect, it } from "vitest";
import {
  AgentUsername,
  ATTACHMENT_DEFAULT_MAX_BYTES,
  AttachmentsConfig,
  badgeStyle,
  ConversationNotifyLevel,
  CreateDmRequest,
  DEFAULT_NOTIFICATION_PREFS,
  DmCounterpart,
  decideNotify,
  dmKeyOf,
  EditMessageRequest,
  Emoji,
  EphemeralTypes,
  INLINE_IMAGE_TYPES,
  isReservedHandle,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_GROUP_PARTICIPANTS,
  MarkNotificationsReadRequest,
  Message,
  MessageDeletedEvent,
  MessageNotifyEvent,
  MessageUpdatedEvent,
  mentionAllOf,
  NOTIFICATION_KIND_RANK,
  NotificationKind,
  PostMessageRequest,
  PresignUploadRequest,
  RESERVED_HANDLES,
  SearchOverview,
  SearchQuery,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  sanitizeFilename,
  splitSnippet,
  UNREAD_CAP,
  UpdateChannelRequest,
  UpdateNotificationPrefsRequest,
  userHandle,
} from "./index";

const id = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const A = "0190d5e2-7c3a-7cc2-9d2e-00000000000a";
const B = "0190d5e2-7c3a-7cc2-9d2e-00000000000b";
const C = "0190d5e2-7c3a-7cc2-9d2e-00000000000c";
const now = "2026-10-06T10:00:00.000Z";

const baseMessage = {
  id,
  organizationId: id,
  conversationId: id,
  seq: 3,
  authorKind: "user",
  authorId: id,
  body: "hello",
  mentions: [],
  status: "sent",
  threadId: null,
  replyCount: 0,
  lastReplyAt: null,
  clientKind: "web",
  createdAt: now,
  editedAt: null,
} as const;

const attachment = {
  id,
  conversationId: id,
  messageId: id,
  filename: "plan.pdf",
  contentType: "application/pdf",
  size: 1234,
  status: "ready",
  isImage: false,
  width: null,
  height: null,
  previewUrl: null,
  largeUrl: null,
  downloadUrl: `/api/v1/attachments/${id}/download`,
  createdAt: now,
} as const;

describe("message edit and delete (04-01)", () => {
  it("EditMessageRequest rejects empty, blank and oversize bodies", () => {
    expect(EditMessageRequest.safeParse({ body: "" }).success).toBe(false);
    expect(EditMessageRequest.safeParse({ body: "   " }).success).toBe(false);
    expect(EditMessageRequest.safeParse({ body: "x".repeat(20_001) }).success).toBe(false);
    expect(EditMessageRequest.parse({ body: "  fixed  " })).toEqual({ body: "fixed" });
  });

  it("Message parses with and without every Phase 4 optional field", () => {
    expect(Message.parse(baseMessage).deletedAt).toBeUndefined();
    const full = Message.parse({
      ...baseMessage,
      deletedAt: now,
      reactions: [{ emoji: "👍", count: 2, mine: true, members: [{ kind: "user", id }] }],
      attachments: [attachment],
      pinned: true,
      saved: false,
    });
    expect(full).toMatchObject({ deletedAt: now, pinned: true, saved: false });
    expect(Message.parse({ ...baseMessage, deletedAt: null }).deletedAt).toBeNull();
  });

  it("message.updated and message.deleted payloads", () => {
    expect(MessageUpdatedEvent.parse({ message: baseMessage }).message.id).toBe(id);
    expect(
      MessageDeletedEvent.parse({
        messageId: id,
        conversationId: id,
        threadId: null,
        deletedAt: now,
        replyCount: 2,
      }).replyCount,
    ).toBe(2);
  });
});

describe("posting with attachments (04-01)", () => {
  it("accepts a body only, attachments only, and refuses neither or too many", () => {
    expect(PostMessageRequest.parse({ body: "hi" }).body).toBe("hi");
    expect(PostMessageRequest.parse({ attachmentIds: [id] })).toMatchObject({
      body: "",
      attachmentIds: [id],
    });
    expect(PostMessageRequest.safeParse({ body: "   " }).success).toBe(false);
    expect(PostMessageRequest.safeParse({}).success).toBe(false);
    expect(PostMessageRequest.safeParse({ body: "", attachmentIds: [] }).success).toBe(false);
    expect(
      PostMessageRequest.safeParse({ attachmentIds: Array.from({ length: 11 }, () => id) }).success,
    ).toBe(false);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(10);
  });
});

describe("direct conversation keys and counterparts (04-01)", () => {
  it("dmKeyOf keeps the 3.1 bot form, sorts humans and de-duplicates", () => {
    expect(
      dmKeyOf([
        { kind: "user", id: B },
        { kind: "agent", id: A },
      ]),
    ).toBe(`agent:${A}|user:${B}`);
    expect(
      dmKeyOf([
        { kind: "user", id: C },
        { kind: "user", id: A },
      ]),
    ).toBe(`user:${A}|user:${C}`);
    expect(
      dmKeyOf([
        { kind: "user", id: B },
        { kind: "user", id: A },
        { kind: "user", id: B },
      ]),
    ).toBe(`user:${A}|user:${B}`);
  });

  it("DmCounterpart is a union and still parses the 3.1 agent shape", () => {
    const agent = DmCounterpart.parse({
      kind: "agent",
      id,
      name: "Archie",
      username: "archie",
      avatarUrl: null,
      status: "ready",
      scope: "team",
    });
    expect(agent.kind).toBe("agent");
    expect(
      DmCounterpart.parse({
        kind: "user",
        id,
        name: "Sam",
        handle: "sam",
        avatarUrl: null,
        deactivated: false,
      }).kind,
    ).toBe("user");
    expect(
      DmCounterpart.parse({
        kind: "group",
        name: "Ada, Sam and Claude",
        members: [
          { kind: "user", id: A, name: "Ada", avatarUrl: null },
          { kind: "agent", id: B, name: "Claude", avatarUrl: null },
        ],
      }).kind,
    ).toBe("group");
  });

  it("CreateDmRequest allows at most MAX_GROUP_PARTICIPANTS - 1 others", () => {
    expect(MAX_GROUP_PARTICIPANTS).toBe(9);
    const others = (n: number) => Array.from({ length: n }, () => ({ kind: "user", id }));
    expect(CreateDmRequest.safeParse({ participants: others(8) }).success).toBe(true);
    expect(CreateDmRequest.safeParse({ participants: others(9) }).success).toBe(false);
    expect(CreateDmRequest.safeParse({ participants: [] }).success).toBe(false);
  });
});

describe("reserved handles and @channel/@here (04-01)", () => {
  it("userHandle suffixes a reserved handle", () => {
    expect(RESERVED_HANDLES).toEqual(["channel", "here", "everyone"]);
    expect(userHandle({ displayName: "H", email: "here@x.com" })).toBe("here-1");
    expect(userHandle({ displayName: "C", email: "channel@x.com" })).toBe("channel-1");
    expect(userHandle({ displayName: "E", email: "everyone@x.com" })).toBe("everyone-1");
    expect(userHandle({ displayName: "Here", email: null })).toBe("here-1");
    expect(userHandle({ displayName: "Ada", email: "ada@x.com" })).toBe("ada");
  });

  it("isReservedHandle ignores case", () => {
    expect(isReservedHandle("Here")).toBe(true);
    expect(isReservedHandle("EVERYONE")).toBe(true);
    expect(isReservedHandle("here-1")).toBe(false);
  });

  it("mentionAllOf finds @channel/@here outside code; channel beats here; @everyone is @channel", () => {
    expect(mentionAllOf("hi @here")).toBe("here");
    expect(mentionAllOf("@here and @channel")).toBe("channel");
    expect(mentionAllOf("@everyone look")).toBe("channel");
    expect(mentionAllOf("no mention here")).toBeNull();
    expect(mentionAllOf("run `@here` to page")).toBeNull();
    expect(mentionAllOf("```\nping @channel\n```")).toBeNull();
    expect(mentionAllOf("```\n@channel\n```\nthen @here")).toBe("here");
    expect(mentionAllOf("mail me@here.com")).toBeNull();
  });

  it("AgentUsername refuses reserved handles", () => {
    for (const name of ["here", "channel", "everyone"]) {
      expect(AgentUsername.safeParse(name).success, name).toBe(false);
    }
    expect(AgentUsername.safeParse("Here").success).toBe(false);
    expect(AgentUsername.safeParse("archie").success).toBe(true);
  });
});

describe("emoji reactions (04-01)", () => {
  it("accepts pictographs, skin tones, flags and ZWJ sequences", () => {
    for (const e of ["👍", "👍🏽", "🇪🇸", "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}", "❤️", "1️⃣"]) {
      expect(Emoji.safeParse(e).success, e).toBe(true);
    }
  });

  it("rejects text, markup, mixed and oversize values", () => {
    const long33 = `${"👍".repeat(16)}\u{FE0F}`;
    expect(long33.length).toBe(33);
    for (const e of ["a", "<b>", "👍x", "", "x👍", long33]) {
      expect(Emoji.safeParse(e).success, e).toBe(false);
    }
  });
});

describe("notifications (04-01)", () => {
  it("ranks kinds with mention strongest", () => {
    expect(NotificationKind.options).toEqual([
      "mention",
      "channel",
      "here",
      "dm",
      "group_dm",
      "thread_reply",
    ]);
    expect(NOTIFICATION_KIND_RANK).toEqual({
      mention: 6,
      dm: 5,
      group_dm: 4,
      channel: 3,
      here: 2,
      thread_reply: 1,
    });
    expect(UNREAD_CAP).toBe(100);
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      dndUntil: null,
      desktopEnabled: true,
      webEnabled: true,
      defaultLevel: "mentions",
    });
  });

  const base = {
    event: "mention" as const,
    conversationKind: "channel" as const,
    level: "default" as const,
    defaultLevel: "mentions" as const,
    muted: false,
    dndActive: false,
  };

  it("decideNotify: DND and mute silence everything", () => {
    expect(decideNotify({ ...base, dndActive: true })).toEqual({ popup: false });
    expect(decideNotify({ ...base, muted: true })).toEqual({ popup: false });
    expect(decideNotify({ ...base, event: "dm", conversationKind: "dm", muted: true })).toEqual({
      popup: false,
    });
  });

  it("decideNotify: default level follows the conversation kind", () => {
    // Channels: the user's default (mentions) → a plain message does not pop, a mention does.
    expect(decideNotify({ ...base, event: "message" })).toEqual({ popup: false });
    expect(decideNotify(base)).toEqual({ popup: true });
    expect(decideNotify({ ...base, event: "message", defaultLevel: "all" })).toEqual({ popup: true });
    expect(decideNotify({ ...base, defaultLevel: "nothing" })).toEqual({ popup: false });
    // DMs and groups default to "all".
    expect(
      decideNotify({ ...base, event: "message", conversationKind: "dm", defaultLevel: "nothing" }),
    ).toEqual({
      popup: true,
    });
    expect(decideNotify({ ...base, event: "message", conversationKind: "group" })).toEqual({ popup: true });
  });

  it("decideNotify: explicit levels", () => {
    expect(decideNotify({ ...base, event: "message", level: "all" })).toEqual({ popup: true });
    expect(decideNotify({ ...base, event: "message", level: "mentions" })).toEqual({ popup: false });
    expect(decideNotify({ ...base, event: "here", level: "mentions" })).toEqual({ popup: true });
    expect(decideNotify({ ...base, event: "thread_reply", level: "all" })).toEqual({ popup: true });
    expect(decideNotify({ ...base, level: "nothing" })).toEqual({ popup: false });
    expect(decideNotify({ ...base, event: "message", conversationKind: "dm", level: "mentions" })).toEqual({
      popup: false,
    });
  });

  it("decideNotify: a bot's reply in a bot DM pops only when it mentions the member or the DM is set to all", () => {
    const botDm = { ...base, conversationKind: "dm" as const, actorKind: "agent" as const };
    expect(decideNotify({ ...botDm, event: "dm" })).toEqual({ popup: false });
    expect(decideNotify({ ...botDm, event: "mention" })).toEqual({ popup: true });
    expect(decideNotify({ ...botDm, event: "dm", level: "all" })).toEqual({ popup: true });
    expect(decideNotify({ ...botDm, event: "mention", muted: true })).toEqual({ popup: false });
    // A person's DM is unchanged, and so is a bot in a channel.
    expect(decideNotify({ ...botDm, event: "dm", actorKind: "user" })).toEqual({ popup: true });
    expect(decideNotify({ ...base, actorKind: "agent" })).toEqual({ popup: true });
  });

  it("MessageNotifyEvent (ephemeral level-all pop-up) carries ids, the actor and a bounded snippet", () => {
    const ev = {
      conversation: {
        id,
        kind: "channel",
        name: "design",
        label: "#design",
        visibility: "public",
        archived: false,
      },
      messageId: A,
      actor: { kind: "user", id: A, displayName: "Ada" },
      snippet: "ship it",
    };
    expect(MessageNotifyEvent.parse(ev)).toEqual(ev);
    expect(() => MessageNotifyEvent.parse({ ...ev, snippet: "x".repeat(141) })).toThrow();
    expect(EphemeralTypes.messageNotify).toBe("message.notify");
  });

  it("badgeStyle covers every row", () => {
    const b = { level: "default" as const, muted: false, unreadCount: 3, mentionCount: 0 };
    expect(badgeStyle({ ...b, mentionCount: 1 })).toBe("mention");
    expect(badgeStyle({ ...b, mentionCount: 1, muted: true })).toBe("mention");
    expect(badgeStyle({ ...b, muted: true })).toBe("none");
    expect(badgeStyle({ ...b, unreadCount: 0 })).toBe("none");
    expect(badgeStyle({ ...b, level: "mentions" })).toBe("dot");
    expect(badgeStyle({ ...b, level: "nothing" })).toBe("dot");
    expect(badgeStyle(b)).toBe("count");
    expect(badgeStyle({ ...b, level: "all" })).toBe("count");
  });

  it("request refinements need at least one key / exactly one target", () => {
    expect(UpdateNotificationPrefsRequest.safeParse({}).success).toBe(false);
    expect(UpdateNotificationPrefsRequest.safeParse({ webEnabled: false }).success).toBe(true);
    expect(MarkNotificationsReadRequest.safeParse({}).success).toBe(false);
    expect(MarkNotificationsReadRequest.safeParse({ all: true }).success).toBe(true);
    expect(MarkNotificationsReadRequest.safeParse({ ids: [id], all: true }).success).toBe(false);
    expect(UpdateChannelRequest.safeParse({}).success).toBe(false);
    expect(UpdateChannelRequest.safeParse({ unitId: null }).success).toBe(true);
    expect(ConversationNotifyLevel.options).toEqual(["default", "all", "mentions", "nothing"]);
  });
});

describe("attachments (04-01)", () => {
  it("sanitizeFilename strips traversal, controls and bidi overrides", () => {
    const traversal = sanitizeFilename("../../etc/passwd");
    expect(traversal).not.toContain("/");
    expect(traversal.startsWith(".")).toBe(false);
    expect(sanitizeFilename("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFilename("a\\b\u0000c.txt")).toBe("a_bc.txt");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("  ..  ")).toBe("file");
    expect(sanitizeFilename("my   report \t v2.pdf")).toBe("my report v2.pdf");
    const long = sanitizeFilename(`${"a".repeat(300)}.png`);
    expect(long.length).toBeLessThanOrEqual(255);
    expect(long.endsWith(".png")).toBe(true);
  });

  it("upload contracts and limits", () => {
    expect(ATTACHMENT_DEFAULT_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(INLINE_IMAGE_TYPES).toContain("image/webp");
    expect(
      PresignUploadRequest.parse({ filename: "a.png", contentType: "Image/PNG", size: 10 }).contentType,
    ).toBe("image/png");
    expect(PresignUploadRequest.safeParse({ filename: "a", contentType: "nope", size: 1 }).success).toBe(
      false,
    );
    expect(
      PresignUploadRequest.safeParse({ filename: "a", contentType: "text/plain", size: 0 }).success,
    ).toBe(false);
    expect(
      AttachmentsConfig.parse({ enabled: false, maxBytes: 1, maxPerMessage: 10, reason: "not_configured" }),
    ).toMatchObject({ enabled: false });
  });
});

describe("search (04-01)", () => {
  it("splitSnippet round-trips zero, one and two marks", () => {
    expect(splitSnippet("plain text")).toEqual([{ text: "plain text", mark: false }]);
    const one = `deploy ${SNIPPET_MARK_START}migración${SNIPPET_MARK_END} today`;
    expect(splitSnippet(one)).toEqual([
      { text: "deploy ", mark: false },
      { text: "migración", mark: true },
      { text: " today", mark: false },
    ]);
    const two = `${SNIPPET_MARK_START}a${SNIPPET_MARK_END} and ${SNIPPET_MARK_START}b${SNIPPET_MARK_END}`;
    const parts = splitSnippet(two);
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(["a", "b"]);
    expect(parts.map((p) => p.text).join("")).toBe("a and b");
    expect(SNIPPET_MARK_START).toBe("");
    expect(SNIPPET_MARK_END).toBe("");
  });

  it("SearchOverview parses with and without aiChats (05-10, add-only)", () => {
    const base = { messages: [], people: [], channels: [] };
    expect(SearchOverview.parse(base)).toEqual(base);
    const chat = {
      id: "01a1d2c3-0000-7000-8000-000000000001",
      title: "Quarterly kumquat roadmap",
      titleSource: "auto",
      lastModel: { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" },
      lastModelLabel: "Claude Sonnet 5.5",
      archived: false,
      generating: false,
      createdAt: "2026-10-06T10:00:00.000Z",
      lastActivityAt: "2026-10-06T10:05:00.000Z",
    };
    expect(SearchOverview.parse({ ...base, aiChats: [chat] }).aiChats).toEqual([chat]);
    expect(SearchOverview.safeParse({ ...base, aiChats: Array.from({ length: 9 }, () => chat) }).success).toBe(
      false,
    );
    expect(SearchOverview.safeParse({ ...base, aiChats: [{ ...chat, title: 3 }] }).success).toBe(false);
  });

  it("SearchQuery bounds", () => {
    expect(SearchQuery.parse({ q: " deploy " })).toMatchObject({ q: "deploy", limit: 20 });
    expect(SearchQuery.safeParse({ q: "" }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: "x".repeat(201) }).success).toBe(false);
  });
});
