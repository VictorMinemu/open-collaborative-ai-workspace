import { describe, expect, it } from "vitest";
import {
  AI_QUEUE_MAX,
  AiChatListQuery,
  AiChatPolicy,
  AiChatShare,
  AiChatSnapshot,
  AiChatSummary,
  type AiDeltaEvent,
  AiGrantSubject,
  AiModelList,
  AiMyUsageReportQuery,
  AiPostedMessageResponse,
  AiQueueState,
  AiUsageReport,
  AiUsageReportQuery,
  AiUsageToday,
  applyAiDelta,
  CHATGPT_MANAGE_USAGE_URL,
  ChatgptPlanStatus,
  CreateAiChatGrantRequest,
  CreateAiChatRequest,
  DEFAULT_AI_CHAT_POLICY,
  ModelUnavailableReason,
  SendAiMessageRequest,
  stitchAiSnapshot,
  UpdateAiChatPolicyRequest,
  UpdateAiChatRequest,
  UpdateAiUserPreferencesRequest,
} from "./ai-chat";
import { AiAddressingStatus, AiGeneration, AiSkipReason, ModelRef, modelRefKey } from "./ai-generation";
import { Message } from "./chat";

const id = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const msgA = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
const msgB = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e61";
const now = "2026-10-06T10:00:00.000Z";

const planRef = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const orgRef = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
const mockRef = { backend: "mock", provider: "mock", modelId: "mock-1" } as const;

const generation = {
  id,
  status: "completed",
  backend: "org_key",
  provider: "anthropic",
  modelId: "claude-sonnet-5-5",
  modelLabel: "Claude Sonnet 5.5",
  metered: true,
  attempt: 1,
  errorCode: null,
  errorParam: null,
  usage: {
    inputTokens: 120,
    outputTokens: 80,
    cachedInputTokens: null,
    reasoningTokens: null,
    estimated: false,
    costMicrosUsd: 1_040,
    priceRef: "2026-10-06:anthropic/claude-sonnet-5-5",
  },
  webUsed: false,
  sourceDomains: [],
  startedAt: now,
  finishedAt: now,
} as const;

const message = {
  id: msgA,
  organizationId: id,
  conversationId: id,
  seq: 3,
  authorKind: "agent",
  authorId: null,
  author: { kind: "agent", id: null, displayName: "Claude Sonnet 5.5" },
  body: "Hello",
  mentions: [],
  status: "completed",
  threadId: null,
  replyCount: 0,
  lastReplyAt: null,
  clientKind: null,
  createdAt: now,
  editedAt: null,
};

const delta = (messageId: string, offset: number, text: string): AiDeltaEvent => ({
  conversationId: id,
  messageId,
  generationId: id,
  offset,
  text,
});

describe("ModelRef", () => {
  it("accepts the plan, org-key and mock backends with their providers", () => {
    for (const ref of [planRef, orgRef, mockRef, { ...orgRef, provider: "openrouter" }]) {
      expect(ModelRef.safeParse(ref).success, JSON.stringify(ref)).toBe(true);
    }
  });

  it("rejects a backend paired with the wrong provider", () => {
    for (const ref of [
      { ...planRef, provider: "anthropic" },
      { ...planRef, provider: "openai-codex" },
      { ...orgRef, provider: "mock" },
      { ...orgRef, provider: "openai-codex" },
      { ...mockRef, provider: "openai" },
      { ...orgRef, backend: "pooled" },
      { ...orgRef, modelId: "" },
    ]) {
      expect(ModelRef.safeParse(ref).success, JSON.stringify(ref)).toBe(false);
    }
  });

  it("modelRefKey is stable", () => {
    expect(modelRefKey(planRef)).toBe("chatgpt_plan:openai/gpt-6-astra");
    expect(modelRefKey(orgRef)).toBe("org_key:anthropic/claude-sonnet-5-5");
    expect(modelRefKey(ModelRef.parse({ ...mockRef }))).toBe(modelRefKey(mockRef));
  });
});

describe("send and create requests", () => {
  const base = { clientMessageId: "client-0001", body: "Hi", model: orgRef };

  it("accepts a body, or attachments without a body", () => {
    expect(SendAiMessageRequest.parse(base).body).toBe("Hi");
    expect(SendAiMessageRequest.safeParse({ ...base, body: "", attachmentIds: [id] }).success).toBe(true);
    expect(SendAiMessageRequest.safeParse({ ...base, body: undefined, attachmentIds: [id] }).success).toBe(
      true,
    );
    expect(CreateAiChatRequest.parse({ ...base, settings: { instructions: "Be brief" } }).settings).toEqual({
      instructions: "Be brief",
    });
  });

  it("rejects an empty message, oversize body, too many attachments and a short client id", () => {
    const empty = SendAiMessageRequest.safeParse({ ...base, body: "   " });
    expect(empty.success).toBe(false);
    expect(JSON.stringify(empty.error?.issues)).toContain("Write a message or attach a file");
    expect(SendAiMessageRequest.safeParse({ ...base, body: "", attachmentIds: [] }).success).toBe(false);
    expect(SendAiMessageRequest.safeParse({ ...base, body: "x".repeat(20_001) }).success).toBe(false);
    expect(SendAiMessageRequest.safeParse({ ...base, attachmentIds: Array(11).fill(id) }).success).toBe(
      false,
    );
    expect(SendAiMessageRequest.safeParse({ ...base, clientMessageId: "1234567" }).success).toBe(false);
    expect(CreateAiChatRequest.safeParse({ ...base, body: "" }).success).toBe(false);
    expect(
      SendAiMessageRequest.safeParse({ ...base, model: { ...planRef, provider: "anthropic" } }).success,
    ).toBe(false);
  });

  it("update requests reject an empty patch", () => {
    expect(UpdateAiChatRequest.safeParse({}).success).toBe(false);
    expect(UpdateAiChatRequest.safeParse({ title: "Trip plan" }).success).toBe(true);
    expect(UpdateAiChatRequest.safeParse({ title: "x".repeat(81) }).success).toBe(false);
    expect(UpdateAiUserPreferencesRequest.safeParse({}).success).toBe(false);
    expect(UpdateAiUserPreferencesRequest.safeParse({ webDefault: true }).success).toBe(true);
    expect(UpdateAiChatPolicyRequest.safeParse({}).success).toBe(false);
    expect(UpdateAiChatPolicyRequest.safeParse({ webEnabled: false }).success).toBe(true);
  });
});

describe("AI chat policy", () => {
  it("the default policy parses", () => {
    expect(AiChatPolicy.parse(DEFAULT_AI_CHAT_POLICY)).toEqual(DEFAULT_AI_CHAT_POLICY);
    expect(DEFAULT_AI_CHAT_POLICY).toMatchObject({
      chatgptPlanEnabled: true,
      orgKeysEnabled: true,
      planAllowedModels: [],
      orgKeyDailyGenerations: 200,
      orgKeyDailyCostMicros: null,
      planDailyGenerations: null,
      concurrentGenerationsPerUser: 3,
      maxContextTokens: 64_000,
      webEnabled: true,
      titleModels: {},
    });
  });

  it("rejects out-of-range limits", () => {
    expect(
      AiChatPolicy.safeParse({ ...DEFAULT_AI_CHAT_POLICY, concurrentGenerationsPerUser: 0 }).success,
    ).toBe(false);
    expect(AiChatPolicy.safeParse({ ...DEFAULT_AI_CHAT_POLICY, maxContextTokens: 1000 }).success).toBe(false);
    expect(AiChatPolicy.safeParse({ ...DEFAULT_AI_CHAT_POLICY, orgKeyDailyGenerations: 0 }).success).toBe(
      false,
    );
  });
});

describe("applyAiDelta", () => {
  const state = { messageId: msgA, text: "Hello" };

  it("applies a delta that starts at the current length", () => {
    expect(applyAiDelta(state, delta(msgA, 5, " world"))).toEqual({ kind: "applied", text: "Hello world" });
  });

  it("ignores a delta already fully seen", () => {
    expect(applyAiDelta(state, delta(msgA, 0, "Hel"))).toEqual({ kind: "duplicate" });
    expect(applyAiDelta(state, delta(msgA, 2, "llo"))).toEqual({ kind: "duplicate" });
  });

  it("applies only the unseen suffix of an overlapping delta", () => {
    expect(applyAiDelta(state, delta(msgA, 3, "lo there"))).toEqual({ kind: "applied", text: "Hello there" });
  });

  it("reports a gap when the delta starts past the current text", () => {
    expect(applyAiDelta(state, delta(msgA, 6, "x"))).toEqual({ kind: "gap" });
  });

  it("ignores deltas of another message", () => {
    expect(applyAiDelta(state, delta(msgB, 5, " world"))).toEqual({ kind: "duplicate" });
  });
});

describe("stitchAiSnapshot", () => {
  it("joins out-of-order buffered deltas onto the snapshot text", () => {
    expect(
      stitchAiSnapshot("Hello", [delta(msgA, 8, "rld"), delta(msgA, 2, "llo"), delta(msgA, 5, " wo")]),
    ).toEqual({ text: "Hello world", complete: true });
    expect(stitchAiSnapshot("Hello", [])).toEqual({ text: "Hello", complete: true });
  });

  it("reports an incomplete text while a hole remains", () => {
    expect(stitchAiSnapshot("Hello", [delta(msgA, 8, "rld")])).toEqual({ text: "Hello", complete: false });
    expect(stitchAiSnapshot("Hello", [delta(msgA, 5, " wo"), delta(msgA, 9, "d")])).toEqual({
      text: "Hello wo",
      complete: false,
    });
  });
});

describe("AI chat payloads", () => {
  it("ChatgptPlanStatus only accepts the official manage-usage URL", () => {
    const status = {
      state: "connected",
      email: "sam@example.test",
      planType: "plus",
      connectedAt: now,
      welcomeSeen: false,
      manageUsageUrl: CHATGPT_MANAGE_USAGE_URL,
    };
    expect(ChatgptPlanStatus.parse(status).manageUsageUrl).toBe("https://chatgpt.com/settings/usage");
    expect(
      ChatgptPlanStatus.safeParse({ ...status, manageUsageUrl: "https://evil.example/usage" }).success,
    ).toBe(false);
  });

  it("Message parses with and without a generation projection", () => {
    expect(Message.parse(message).generation).toBeUndefined();
    expect(Message.parse({ ...message, generation }).generation).toEqual(generation);
    expect(AiGeneration.safeParse({ ...generation, sourceDomains: Array(21).fill("a.test") }).success).toBe(
      false,
    );
    expect(AiGeneration.safeParse({ ...generation, errorCode: "boom" }).success).toBe(false);
  });

  it("summaries, snapshots, model lists, usage and shares parse", () => {
    const summary = {
      id,
      title: "New chat",
      titleSource: "heuristic",
      lastModel: orgRef,
      lastModelLabel: "Claude Sonnet 5.5",
      archived: false,
      generating: false,
      createdAt: now,
      lastActivityAt: now,
    };
    expect(AiChatSummary.parse(summary)).toEqual(summary);
    const snapshot = AiChatSnapshot.parse({
      chat: {
        ...summary,
        settings: { instructions: "", usePersonalInstructions: true, tools: { web: false } },
        tools: [{ key: "web", label: "Web search", enabled: false, available: true, reason: null }],
        viewerCan: ["ai_chat.use"],
      },
      messages: [{ ...message, generation }],
      hasMore: false,
      running: { generationId: id, messageId: msgA, partialText: "Hel" },
      lastSeq: 3,
    });
    expect(snapshot.running?.partialText).toBe("Hel");
    expect(
      AiModelList.parse({
        models: [
          {
            ref: mockRef,
            label: "Mock model (E2E)",
            providerLabel: "Mock",
            group: "mock",
            metered: false,
            caps: { vision: false, pdf: false, webSearch: "none" },
            available: true,
            reason: null,
            isDefault: true,
          },
        ],
        chatgptPlan: {
          state: "not_connected",
          email: null,
          planType: null,
          connectedAt: null,
          welcomeSeen: false,
          manageUsageUrl: CHATGPT_MANAGE_USAGE_URL,
        },
        defaultRef: mockRef,
      }).models,
    ).toHaveLength(1);
    const totals = { generations: 1, inputTokens: 2, outputTokens: 3 };
    expect(
      AiUsageToday.parse({
        day: "2026-10-06",
        orgKey: { ...totals, costMicrosUsd: 10 },
        chatgptPlan: totals,
        limits: { orgKeyGenerations: 200, orgKeyCostMicros: null, planGenerations: null },
        resetsAt: "2026-10-07T00:00:00.000Z",
      }).day,
    ).toBe("2026-10-06");
    expect(
      AiUsageReport.parse({
        from: "2026-09-07",
        to: "2026-10-06",
        groupBy: "model",
        rows: [
          {
            ...totals,
            key: "org_key:anthropic/claude-sonnet-5-5",
            label: "Claude Sonnet 5.5",
            backend: "org_key",
            costMicrosUsd: 10,
            estimatedGenerations: 0,
          },
        ],
        totals: { ...totals, costMicrosUsd: null, estimatedGenerations: 0 },
      }).rows,
    ).toHaveLength(1);
    expect(
      AiChatShare.parse({
        id,
        chatId: id,
        path: `/share/ai/${id}`,
        title: "Trip plan",
        messageCount: 2,
        createdAt: now,
        revokedAt: null,
      }).path,
    ).toBe(`/share/ai/${id}`);
  });
});

describe("usage report queries (05-09)", () => {
  it("the organization report defaults to 30 days by member and caps the window at 90", () => {
    expect(AiUsageReportQuery.parse({})).toEqual({ days: 30, groupBy: "user" });
    expect(AiUsageReportQuery.parse({ days: "7", groupBy: "model" })).toEqual({ days: 7, groupBy: "model" });
    expect(AiUsageReportQuery.safeParse({ days: "91" }).success).toBe(false);
  });

  it("a member's own report groups by model only", () => {
    expect(AiMyUsageReportQuery.parse({})).toEqual({ days: 30, groupBy: "model" });
    expect(AiMyUsageReportQuery.safeParse({ groupBy: "user" }).success).toBe(false);
  });
});

describe("Phase 6 multiplayer AI chat contracts (06-01)", () => {
  const other = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e62";
  const phase5Summary = {
    id,
    title: "New chat",
    titleSource: "heuristic",
    lastModel: orgRef,
    lastModelLabel: "Claude Sonnet 5.5",
    archived: false,
    generating: false,
    createdAt: now,
    lastActivityAt: now,
  } as const;

  it("AiGeneration parses with and without requesterUserId", () => {
    expect(AiGeneration.parse(generation).requesterUserId).toBeUndefined();
    expect(AiGeneration.parse({ ...generation, requesterUserId: other }).requesterUserId).toBe(other);
    expect(AiGeneration.safeParse({ ...generation, requesterUserId: "nope" }).success).toBe(false);
  });

  it("AiGrantSubject names a user, a unit or the organization, nothing else", () => {
    expect(AiGrantSubject.parse({ kind: "user", id })).toEqual({ kind: "user", id });
    expect(AiGrantSubject.parse({ kind: "unit", id })).toEqual({ kind: "unit", id });
    expect(AiGrantSubject.parse({ kind: "org" })).toEqual({ kind: "org" });
    for (const bad of [{ kind: "org", id }, { kind: "user" }, { kind: "team", id }]) {
      expect(AiGrantSubject.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("CreateAiChatGrantRequest defaults the level to chat", () => {
    expect(CreateAiChatGrantRequest.parse({ subject: { kind: "user", id } })).toEqual({
      subject: { kind: "user", id },
      level: "chat",
    });
    expect(CreateAiChatGrantRequest.parse({ subject: { kind: "org" }, level: "view" }).level).toBe("view");
    expect(CreateAiChatGrantRequest.safeParse({ subject: { kind: "org" }, level: "owner" }).success).toBe(
      false,
    );
  });

  it("AiChatListQuery defaults the scope to mine and rejects unknown scopes", () => {
    expect(AiChatListQuery.parse({}).scope).toBe("mine");
    expect(AiChatListQuery.parse({ scope: "shared" }).scope).toBe("shared");
    expect(AiChatListQuery.safeParse({ scope: "everyone" }).success).toBe(false);
  });

  it("SendAiMessageRequest accepts askAi and up to 50 mentions", () => {
    const base = { clientMessageId: "client-0001", body: "Hi @sam", model: orgRef };
    const mentions = (n: number) => Array.from({ length: n }, () => ({ kind: "user" as const, id }));
    const ok = SendAiMessageRequest.parse({ ...base, askAi: false, mentions: mentions(50) });
    expect(ok.askAi).toBe(false);
    expect(ok.mentions).toHaveLength(50);
    expect(SendAiMessageRequest.parse(base).askAi).toBeUndefined();
    expect(SendAiMessageRequest.safeParse({ ...base, mentions: mentions(51) }).success).toBe(false);
    expect(CreateAiChatRequest.parse({ ...base, askAi: true }).askAi).toBe(true);
    // The refines are kept: an empty message is still refused.
    expect(SendAiMessageRequest.safeParse({ ...base, body: "", askAi: true }).success).toBe(false);
  });

  it("Phase 5 summaries and snapshots (no new fields) still parse; the new optional fields parse", () => {
    expect(AiChatSummary.parse(phase5Summary)).toEqual(phase5Summary);
    const detail = {
      ...phase5Summary,
      settings: { instructions: "", usePersonalInstructions: true, tools: { web: false } },
      tools: [{ key: "web", label: "Web search", enabled: false, available: true, reason: null }],
      viewerCan: ["ai_chat.use"],
    };
    const snapshot = { chat: detail, messages: [message], hasMore: false, running: null, lastSeq: 3 };
    expect(AiChatSnapshot.parse(snapshot).queue).toBeUndefined();
    const shared = AiChatSummary.parse({
      ...phase5Summary,
      access: "chat",
      owner: { kind: "user", id: other, displayName: "Ana" },
      shared: true,
      unreadCount: 3,
    });
    expect(shared.access).toBe("chat");
    expect(AiChatSummary.safeParse({ ...phase5Summary, unreadCount: 101 }).success).toBe(false);
    const queue = { running: null, pending: [{ messageId: msgA, authorId: other }] };
    expect(AiChatSnapshot.parse({ ...snapshot, queue }).queue).toEqual(queue);
  });

  it("AiQueueState holds at most AI_QUEUE_MAX pending messages", () => {
    const pending = (n: number) => Array.from({ length: n }, () => ({ messageId: msgA, authorId: other }));
    expect(AI_QUEUE_MAX).toBe(10);
    expect(AiQueueState.safeParse({ running: null, pending: pending(10) }).success).toBe(true);
    expect(AiQueueState.safeParse({ running: null, pending: pending(11) }).success).toBe(false);
    expect(
      AiQueueState.parse({
        running: { generationId: id, requesterUserId: other, respondingTo: [msgA, msgB] },
        pending: [],
      }).running?.respondingTo,
    ).toEqual([msgA, msgB]);
  });

  it("AiPostedMessageResponse parses with every addressing status", () => {
    for (const status of AiAddressingStatus.options) {
      const addressing = {
        addressed: status !== "not_addressed",
        status,
        skipReason: status === "skipped" ? "no_key" : null,
        generationId: status === "answering" || status === "answered" ? id : null,
      };
      const r = AiPostedMessageResponse.parse({
        chat: phase5Summary,
        userMessage: { ...message, aiAddressing: addressing },
        addressing,
      });
      expect(r.addressing.status, status).toBe(status);
    }
  });

  it("every ModelUnavailableReason is also an AiSkipReason", () => {
    for (const reason of ModelUnavailableReason.options) {
      expect(AiSkipReason.options, reason).toContain(reason);
    }
    expect(AiSkipReason.options).toEqual(
      expect.arrayContaining(["daily_limit_reached", "usage_unavailable", "concurrent_generations"]),
    );
  });
});
