import { describe, expect, it } from "vitest";
import {
  A2A_HOP_BUDGET,
  A2A_HOP_TIMEOUT_MS,
  A2A_MAX_DEPTH,
  A2A_MAX_TARGETS,
  A2A_PARENT_GRACE_MS,
  A2A_QUESTION_MAX,
  AgentChainStatus,
  AgentChannelConsultRequest,
  AgentChannelConsultResponse,
  AgentChannelEventTypes,
  AgentChannelTurnDone,
  AgentConsultReplyEvent,
  AgentMentionEvent,
  AgentTurnOrigin,
  ConsultHopStatus,
  ConsultMode,
  ConsultRefusal,
  ConsultTarget,
  Message,
  MessageConsult,
  TurnConsult,
} from "./index";

const EVENT = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50";
const ORG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51";
const CELL = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52";
const AGENT_A = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a53";
const AGENT_B = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a54";
const VICTOR = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a55";
const CONV = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a56";
const ROOT_MSG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a57";
const QUESTION_MSG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a58";
const ANSWER_MSG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a59";
const CHAIN = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5a";
const HOP = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = "2026-11-02T10:00:00.000Z";

const victor = { kind: "user", id: VICTOR, displayName: "Víctor" } as const;
const agentA = { id: AGENT_A, handle: "ops", displayName: "Ops" };
const agentB = { id: AGENT_B, handle: "purchasing", displayName: "Purchasing" };

/** B's delivery, as 07.7-04 builds it: structural author H, then `message.author` set to the asking bot. */
const mentionOfB = {
  eventId: EVENT,
  seq: 7,
  type: "agent.mention.v1",
  organizationId: ORG,
  cellId: CELL,
  agent: agentB,
  conversation: { id: CONV, kind: "channel", name: "ops" },
  thread: { rootMessageId: ROOT_MSG },
  message: {
    id: QUESTION_MSG,
    text: "@purchasing Is the pump order confirmed?",
    createdAt: NOW,
    author: { kind: "agent", id: AGENT_A, displayName: "Ops" },
    mentions: [{ kind: "agent", id: AGENT_B }],
  },
  threadHistory: [],
  roster: [],
};

const origin = {
  agent: agentA,
  chainId: CHAIN,
  hopId: HOP,
  depth: 1,
  mode: "consult",
  onBehalfOf: victor,
} as const;

const consult = {
  chainId: CHAIN,
  hopId: HOP,
  role: "question",
  sourceAgentId: AGENT_A,
  targetAgentId: AGENT_B,
  onBehalfOfUserId: VICTOR,
  depth: 1,
  mode: "consult",
  status: "pending",
} as const;

const message = {
  id: QUESTION_MSG,
  organizationId: ORG,
  conversationId: CONV,
  seq: 12,
  authorKind: "agent",
  authorId: AGENT_A,
  body: "@purchasing Is the pump order confirmed?",
  mentions: [{ kind: "agent", id: AGENT_B }],
  status: "completed",
  threadId: ROOT_MSG,
  replyCount: 0,
  lastReplyAt: null,
  clientKind: "agent",
  createdAt: NOW,
  editedAt: null,
};

const request = {
  eventId: EVENT,
  agentId: AGENT_A,
  target: AGENT_B,
  question: "Is the pump order confirmed?",
  idempotencyKey: `${EVENT}:consult:0`,
};

describe("one consult round-trips at contract level (07.7-01 tracer, D-01, D-08)", () => {
  it("request → ok answer → origin mention → consult reply → thread DTO", () => {
    // 1. The cell's tool request: strict, mode defaults to consult.
    const req = AgentChannelConsultRequest.parse(request);
    expect(req.mode).toBe("consult");
    expect(req.target).toBe(AGENT_B);

    // 2. The API's answers.
    const sent = AgentChannelConsultResponse.parse({
      ok: true,
      chainId: CHAIN,
      hopId: HOP,
      questionMessageId: QUESTION_MSG,
      sentence: "Question sent to @purchasing. Their answer will arrive as a new message.",
    });
    expect(sent.ok).toBe(true);
    expect(
      AgentChannelConsultResponse.parse({
        ok: false,
        code: "limit_reached",
        hopId: HOP,
        questionMessageId: QUESTION_MSG,
        sentence: "@purchasing has reached its daily limit.",
      }).ok,
    ).toBe(false);
    expect(
      AgentChannelConsultResponse.parse({
        ok: false,
        code: "not_allowed",
        sentence: "@purchasing cannot be consulted here.",
      }).ok,
    ).toBe(false);

    // 3. B's turn carries the origin.
    const delivered = AgentMentionEvent.parse({ ...mentionOfB, origin });
    expect(delivered.origin).toEqual(origin);
    expect(AgentMentionEvent.parse(JSON.parse(JSON.stringify(delivered)))).toEqual(delivered);

    // 4. The answer returns to A as a new turn, re-typed.
    const reply = AgentConsultReplyEvent.parse({
      ...mentionOfB,
      agent: agentA,
      type: AgentChannelEventTypes.consultReply,
      message: {
        ...mentionOfB.message,
        id: ANSWER_MSG,
        author: { kind: "agent", id: AGENT_B, displayName: "Purchasing" },
      },
      consultReply: {
        chainId: CHAIN,
        hopId: HOP,
        target: agentB,
        mode: "consult",
        outcome: "answered",
        answerMessageId: ANSWER_MSG,
      },
    });
    expect(reply.type).toBe("agent.consult_reply.v1");
    expect(reply.consultReply.answerMessageId).toBe(ANSWER_MSG);

    // 5. The thread DTO renders the hop.
    const rendered = Message.parse({ ...message, consult });
    expect(rendered.consult).toEqual(consult);
  });

  it("refuses empty, oversized, unknown-mode and widened requests", () => {
    for (const question of ["", "   ", "x".repeat(A2A_QUESTION_MAX + 1)]) {
      expect(AgentChannelConsultRequest.safeParse({ ...request, question }).success, question).toBe(false);
    }
    expect(
      AgentChannelConsultRequest.safeParse({ ...request, question: "x".repeat(A2A_QUESTION_MAX) }).success,
    ).toBe(true);
    expect(AgentChannelConsultRequest.parse({ ...request, question: "  hi  " }).question).toBe("hi");
    expect(AgentChannelConsultRequest.safeParse({ ...request, mode: "delegate" }).success).toBe(false);
    expect(AgentChannelConsultRequest.parse({ ...request, mode: "handoff" }).mode).toBe("handoff");
    // Strict (D-08): the model may not invent a conversation, a person or a chain.
    for (const extra of [{ conversationId: CONV }, { onBehalfOfUserId: VICTOR }, { chainId: CHAIN }]) {
      expect(AgentChannelConsultRequest.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    for (const key of ["", "k".repeat(121)]) {
      expect(AgentChannelConsultRequest.safeParse({ ...request, idempotencyKey: key }).success).toBe(false);
    }
    expect(AgentChannelConsultRequest.safeParse({ ...request, target: "@purchasing" }).success).toBe(false);
  });

  it("bounds the answers; hop ids travel only with limit_reached", () => {
    expect(
      AgentChannelConsultResponse.safeParse({ ok: false, code: "not_allowed", sentence: "x".repeat(501) })
        .success,
    ).toBe(false);
    expect(
      AgentChannelConsultResponse.safeParse({
        ok: true,
        chainId: CHAIN,
        hopId: HOP,
        questionMessageId: QUESTION_MSG,
        sentence: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      AgentChannelConsultResponse.safeParse({ ok: false, code: "x".repeat(65), sentence: "no" }).success,
    ).toBe(false);
    expect(
      AgentChannelConsultResponse.safeParse({ ok: false, code: "not_allowed", hopId: HOP, sentence: "no" })
        .success,
    ).toBe(false);
    expect(
      AgentChannelConsultResponse.safeParse({ ok: false, code: "limit_reached", sentence: "no" }).success,
    ).toBe(false);
    expect(AgentChannelConsultResponse.safeParse({ ok: true, sentence: "sent" }).success).toBe(false);
  });

  it("refuses out-of-range depths, unknown outcomes and invalid turn-done bodies", () => {
    for (const depth of [0, 3, 1.5]) {
      expect(AgentTurnOrigin.safeParse({ ...origin, depth }).success, `origin ${depth}`).toBe(false);
      expect(MessageConsult.safeParse({ ...consult, depth }).success, `consult ${depth}`).toBe(false);
    }
    expect(AgentTurnOrigin.safeParse({ ...origin, depth: 2 }).success).toBe(true);
    expect(
      MessageConsult.safeParse({ ...consult, depth: 2, role: "answer", status: "answered" }).success,
    ).toBe(true);
    // The chain runs for a human: never an agent or the system.
    expect(
      AgentTurnOrigin.safeParse({
        ...origin,
        onBehalfOf: { kind: "agent", id: AGENT_A, displayName: "Ops" },
      }).success,
    ).toBe(false);
    expect(MessageConsult.safeParse({ ...consult, role: "note" }).success).toBe(false);
    expect(MessageConsult.safeParse({ ...consult, status: "running" }).success).toBe(false);

    const replyBase = {
      ...mentionOfB,
      type: "agent.consult_reply.v1",
      consultReply: {
        chainId: CHAIN,
        hopId: HOP,
        target: agentB,
        mode: "consult",
        outcome: "timed_out",
        answerMessageId: null,
      },
    };
    expect(AgentConsultReplyEvent.safeParse(replyBase).success).toBe(true);
    expect(
      AgentConsultReplyEvent.safeParse({
        ...replyBase,
        consultReply: { ...replyBase.consultReply, outcome: "cancelled" },
      }).success,
    ).toBe(false);
    expect(AgentConsultReplyEvent.safeParse({ ...replyBase, type: "agent.mention.v1" }).success).toBe(false);

    expect(AgentChannelTurnDone.parse({ agentId: AGENT_A, outcome: "replied" })).toEqual({
      agentId: AGENT_A,
      outcome: "replied",
    });
    expect(AgentChannelTurnDone.safeParse({ agentId: AGENT_A, outcome: "failed" }).success).toBe(true);
    expect(AgentChannelTurnDone.safeParse({ agentId: AGENT_A, outcome: "silent" }).success).toBe(false);
    expect(
      AgentChannelTurnDone.safeParse({ agentId: AGENT_A, outcome: "replied", eventId: EVENT }).success,
    ).toBe(false);
  });

  it("bounds the consult targets offered on a turn", () => {
    const target = { id: AGENT_B, handle: "purchasing", displayName: "Purchasing", description: null };
    expect(ConsultTarget.parse(target)).toEqual(target);
    expect(ConsultTarget.safeParse({ ...target, description: "x".repeat(201) }).success).toBe(false);
    expect(ConsultTarget.safeParse({ ...target, handle: "" }).success).toBe(false);
    expect(ConsultTarget.safeParse({ ...target, displayName: "x".repeat(121) }).success).toBe(false);
    const turn = { chainId: null, depth: 0, targets: [target] };
    expect(TurnConsult.parse(turn)).toEqual(turn);
    expect(TurnConsult.safeParse({ ...turn, chainId: CHAIN, depth: 1 }).success).toBe(true);
    expect(TurnConsult.safeParse({ ...turn, depth: 2 }).success).toBe(false);
    expect(TurnConsult.safeParse({ ...turn, targets: [] }).success).toBe(false);
    expect(TurnConsult.safeParse({ ...turn, targets: Array(A2A_MAX_TARGETS + 1).fill(target) }).success).toBe(
      false,
    );
    expect(TurnConsult.safeParse({ ...turn, targets: Array(A2A_MAX_TARGETS).fill(target) }).success).toBe(
      true,
    );
  });
});

describe("backward compatibility (C-02)", () => {
  it("older payloads without the 07.7 fields parse unchanged", () => {
    const parsed = AgentMentionEvent.parse(mentionOfB);
    expect(parsed.origin).toBeUndefined();
    expect(Message.parse(message).consult).toBeUndefined();
    expect(Message.parse({ ...message, consult: null }).consult).toBeNull();
    const card = {
      kind: "report",
      title: "Pump order",
      fields: [],
      status: "info",
      actions: [],
      version: 1,
      decision: null,
      updatedAt: NOW,
    };
    expect(Message.safeParse({ ...message, card }).success).toBe(true);
    const activity = { eventId: EVENT, steps: [], more: 0, running: false, current: null };
    expect(Message.safeParse({ ...message, activity }).success).toBe(true);
    expect(Message.safeParse({ ...message, card, activity, consult }).success).toBe(true);
  });

  it("existing event types are unchanged and the reply type is new", () => {
    expect(AgentChannelEventTypes.mention).toBe("agent.mention.v1");
    expect(AgentChannelEventTypes.cardAction).toBe("agent.card_action.v1");
    expect(AgentChannelEventTypes.automationRun).toBe("agent.automation_run.v1");
    expect(AgentChannelEventTypes.consultReply).toBe("agent.consult_reply.v1");
    const values = Object.values(AgentChannelEventTypes);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("limits and enums (D-03, D-04, D-11)", () => {
  it("the phase limits are named constants", () => {
    expect(A2A_MAX_DEPTH).toBe(2);
    expect(A2A_HOP_BUDGET).toBe(3);
    expect(A2A_HOP_TIMEOUT_MS).toBe(300_000);
    expect(A2A_PARENT_GRACE_MS).toBe(120_000);
    expect(A2A_QUESTION_MAX).toBe(4000);
    expect(A2A_MAX_TARGETS).toBe(20);
  });

  it("enums hold exactly the agreed values", () => {
    expect(ConsultMode.options).toEqual(["consult", "handoff"]);
    expect(ConsultHopStatus.options).toEqual([
      "pending",
      "answered",
      "failed",
      "timed_out",
      "cancelled",
      "refused",
    ]);
    expect(AgentChainStatus.options).toEqual(["active", "completed", "cancelled"]);
  });

  it("refusal codes are snake_case, unique and never redefine a shared route code", () => {
    const codes = ConsultRefusal.options;
    expect(codes).toEqual([
      "not_channel",
      "chain_closed",
      "depth_exceeded",
      "target_is_self",
      "target_in_chain",
      "target_personal",
      "target_unavailable",
      "target_not_member",
      "not_allowed",
      "budget_exhausted",
      "consult_pending",
      "limit_reached",
    ]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c, c).toMatch(/^[a-z]+(_[a-z]+)*$/);
    for (const shared of ["unknown_turn", "no_trigger", "not_in_turn", "tainted", "cap_reached"]) {
      expect(codes as readonly string[], shared).not.toContain(shared);
    }
  });
});
