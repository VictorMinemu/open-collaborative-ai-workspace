import { z } from "zod";
import { Id } from "./common";

/**
 * Agent-to-agent consultations (Phase 07.7, ADR-0027; A2A-01 … A2A-03). A bot asks another bot of the organization a
 * question through the platform (`ocw_consult_agent` → `POST /agent-channel/v1/consultations`); the question and the
 * answer are ordinary, attributed messages in the asking turn's thread, and the answer returns to the asker as a new
 * turn. Every hop belongs to a chain rooted in one human-triggered turn and runs for that human (the asker pays,
 * ADR-0019).
 *
 * This module imports only `common.ts`: `agent-channel.ts`, `bot-capabilities.ts`, `chat.ts` and `organization.ts`
 * import from it, never the reverse.
 */

// ---------------------------------------------------------------- limits (D-03, D-04)

/** D-03: a chain is at most two hops deep (root → B → C); the tool is offered only to turns below this depth. */
export const A2A_MAX_DEPTH = 2;
/** D-04: consults per chain, refused ones included (a conditional budget update in the DB, never a read). */
export const A2A_HOP_BUDGET = 3;
/**
 * D-04: an unanswered hop times out after 5 minutes. The timeout runs on 07.6's one-minute `consult.tick` job (D-11),
 * so a hop times out between 5 and 6 minutes after it opened; there is no sweep-interval constant.
 */
export const A2A_HOP_TIMEOUT_MS = 300_000;
/** P-10: opening a child hop moves its parent's deadline to at least the child's deadline plus this grace. */
export const A2A_PARENT_GRACE_MS = 120_000;
/** D-04: the question a bot may send, in characters (after trimming). */
export const A2A_QUESTION_MAX = 4000;
/** D-04: consult targets offered on one turn (the channel's bot members the decision allows). */
export const A2A_MAX_TARGETS = 20;

// ---------------------------------------------------------------- enums

/** `consult`: ask and get the answer back as a new turn. `handoff`: pass the request on; the target answers the thread. */
export const ConsultMode = z.enum(["consult", "handoff"]);
export type ConsultMode = z.infer<typeof ConsultMode>;

/** One hop's state. `refused` = the question was posted but the target could not take it (its daily limit). */
export const ConsultHopStatus = z.enum([
  "pending",
  "answered",
  "failed",
  "timed_out",
  "cancelled",
  "refused",
]);
export type ConsultHopStatus = z.infer<typeof ConsultHopStatus>;

export const AgentChainStatus = z.enum(["active", "completed", "cancelled"]);
export type AgentChainStatus = z.infer<typeof AgentChainStatus>;

/**
 * Consult-specific refusal codes of `POST /consultations` (the route's answer table: 403 for decisions, 409 for guards
 * and state, `limit_reached` 200 with the posted hop). The codes shared with other turn-scoped tool routes
 * (`unknown_turn`, `no_trigger`, `not_in_turn`, `tainted`, `cap_reached`) belong to the claim and are not repeated here.
 */
export const ConsultRefusal = z.enum([
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
export type ConsultRefusal = z.infer<typeof ConsultRefusal>;

// ---------------------------------------------------------------- the turn (API → cell)

/** A bot this turn may consult: a member of the conversation the `agent.message` decision allows. */
export const ConsultTarget = z.object({
  id: Id,
  handle: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  description: z.string().max(200).nullable(),
});
export type ConsultTarget = z.infer<typeof ConsultTarget>;

/**
 * `TurnContext.consult`: present only when the turn is offered `ocw_consult_agent`. `depth` is this turn's depth in
 * its chain (0 = a root turn, 1 = a consulted bot's turn); the tool is offered only below `A2A_MAX_DEPTH`.
 */
export const TurnConsult = z.object({
  chainId: Id.nullable(),
  depth: z
    .number()
    .int()
    .min(0)
    .max(A2A_MAX_DEPTH - 1),
  targets: z.array(ConsultTarget).min(1).max(A2A_MAX_TARGETS),
});
export type TurnConsult = z.infer<typeof TurnConsult>;

// ---------------------------------------------------------------- the tool route (cell → API)

/**
 * `POST /agent-channel/v1/consultations` (D-08, the 07.6 self-validated tool route). Strict like
 * `AgentChannelAutomationPropose`: the cell names only its turn, itself, the target and the intent; the API derives the
 * conversation, the thread, the human and the chain from `agent_turns`, so an invented key is refused, never dropped.
 * The cell's key is `<eventId>:consult:<n>`; a retry of the same key answers the stored hop.
 */
export const AgentChannelConsultRequest = z.strictObject({
  eventId: Id,
  agentId: Id,
  target: Id,
  question: z.string().trim().min(1).max(A2A_QUESTION_MAX),
  mode: ConsultMode.default("consult"),
  idempotencyKey: z.string().min(1).max(120),
});
export type AgentChannelConsultRequest = z.infer<typeof AgentChannelConsultRequest>;

/**
 * The answer of `POST /consultations`; the model reads `sentence`. Status codes follow the 07.7 answer table: 200
 * `{ok: true, …}` (sent, or the stored hop on a retry) and 200 `{ok: false, code: "limit_reached", hopId,
 * questionMessageId}` (the question was posted, the target is at its daily limit); 403 for the claim (`not_in_turn`,
 * `tainted`) and the decisions (`not_channel`, `not_allowed`, `target_personal`, `target_unavailable`,
 * `target_not_member`); 409 for the cap and the guards (`cap_reached`, `chain_closed`, `depth_exceeded`,
 * `target_is_self`, `target_in_chain`, `budget_exhausted`, `consult_pending`). Nothing is posted on a refusal.
 */
export const AgentChannelConsultResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    chainId: Id,
    hopId: Id,
    questionMessageId: Id,
    sentence: z.string().max(500),
  }),
  z
    .object({
      ok: z.literal(false),
      code: z.string().max(64),
      sentence: z.string().max(500),
      hopId: Id.optional(),
      questionMessageId: Id.optional(),
    })
    .refine(
      (r) =>
        r.code === "limit_reached"
          ? r.hopId !== undefined && r.questionMessageId !== undefined
          : r.hopId === undefined && r.questionMessageId === undefined,
      { message: "hopId and questionMessageId travel only (and always) with limit_reached" },
    ),
]);
export type AgentChannelConsultResponse = z.infer<typeof AgentChannelConsultResponse>;

/**
 * `POST /agent-channel/v1/turns/:eventId/done` (P-09): the bridge's `finally` for a turn that can belong to a chain.
 * `replied` = the turn posted at least one message, `failed` = it did not. Idempotent on the server.
 */
export const AgentChannelTurnDone = z.strictObject({
  agentId: Id,
  outcome: z.enum(["replied", "failed"]),
});
export type AgentChannelTurnDone = z.infer<typeof AgentChannelTurnDone>;

/**
 * `POST /api/v1/agent-chains/:id/cancel` (P-14, Stop): the chain's state after the call. Idempotent: a chain that was
 * already stopped or completed answers its state unchanged.
 */
export const AgentChainCancelResponse = z.object({
  chainId: Id,
  status: AgentChainStatus,
});
export type AgentChainCancelResponse = z.infer<typeof AgentChainCancelResponse>;

// ---------------------------------------------------------------- the thread (API → web)

/**
 * `Message.consult` (D-15): a hop's question or answer message. Viewer-agnostic side data added by chat; every status
 * change is announced as `message.updated`.
 */
export const MessageConsult = z.object({
  chainId: Id,
  hopId: Id,
  role: z.enum(["question", "answer"]),
  sourceAgentId: Id,
  targetAgentId: Id,
  onBehalfOfUserId: Id,
  /** 1 = asked by the root turn's bot, 2 = asked by a consulted bot. */
  depth: z.number().int().min(1).max(A2A_MAX_DEPTH),
  mode: ConsultMode,
  status: ConsultHopStatus,
});
export type MessageConsult = z.infer<typeof MessageConsult>;

// ---------------------------------------------------------------- who may consult whom (D-02, D-04, P-03, P-04)

/**
 * A per-target `agent.message` rule names the target bot in the rule's existing `tool` column (D-04). Lowercase uuid
 * only, so one bot has exactly one spelling; 42 characters, inside `RuleTool`'s 64.
 */
export const AGENT_TOOL_PATTERN = /^agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The rule tool that names `agentId` as a consult target (`agent:<uuid>`). */
export function agentMessageTool(agentId: string): string {
  return `agent:${agentId.toLowerCase()}`;
}

/** Rule lists per bot (allow, deny): bounded so a view or a request never grows without limit. */
const AGENT_RULE_LIST_MAX = 100;
/** The bots a "Right now" summary names before it stops listing. */
const AGENT_EFFECTIVE_MAX = 50;

export const AgentRef = z.object({
  id: Id,
  handle: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
});
export type AgentRef = z.infer<typeof AgentRef>;

/**
 * `GET|PUT /api/v1/agent-messaging` (P-03): the organization switch "Bots may consult each other", off by default. On =
 * exactly one organization-scope rule `{everyone, allow, agent.message, tool null}`; off = no such rule.
 */
export const AgentMessagingSettings = z.object({
  enabled: z.boolean(),
  /** The caller holds `rule.manage` (admins in v1). */
  canManage: z.boolean(),
});
export type AgentMessagingSettings = z.infer<typeof AgentMessagingSettings>;

export const UpdateAgentMessagingSettingsRequest = z.object({ enabled: z.boolean() });
export type UpdateAgentMessagingSettingsRequest = z.infer<typeof UpdateAgentMessagingSettingsRequest>;

/**
 * Who one bot may consult (P-04), organization-scope `agent.message` rules with the bot as subject: `default` = no
 * rule of its own (the organization switch decides), `any` = allow every bot, `only` = allow the listed bots, `none` =
 * deny every bot. Deny always wins, so `only` cannot narrow below an organization switch that is on.
 */
export const AgentMessagingOutboundMode = z.enum(["default", "any", "only", "none"]);
export type AgentMessagingOutboundMode = z.infer<typeof AgentMessagingOutboundMode>;

/** `GET /api/v1/agents/:id/messaging`: the bot's rules and the server-computed "Right now" summary. */
export const AgentMessagingView = z.object({
  agentId: Id,
  /** The organization switch is on. */
  orgDefault: z.boolean(),
  outbound: z.object({
    mode: AgentMessagingOutboundMode,
    /** `only`: the bots it may consult. */
    allow: z.array(AgentRef).max(AGENT_RULE_LIST_MAX),
    /** "Never ask": bots it may never consult, whatever the mode. */
    deny: z.array(AgentRef).max(AGENT_RULE_LIST_MAX),
  }),
  /** Off = an `{everyone, deny, tool agent:<this bot>}` rule: no bot may consult it. */
  inbound: z.object({ consultable: z.boolean() }),
  /** What the rules add up to right now, computed by the API's decision (never in the client). */
  effective: z.object({
    kind: z.enum(["any", "none", "some"]),
    targets: z.array(AgentRef).max(AGENT_EFFECTIVE_MAX),
  }),
  /** The caller holds `rule.manage` (admins in v1). */
  canManage: z.boolean(),
});
export type AgentMessagingView = z.infer<typeof AgentMessagingView>;

const AgentIdList = z.array(Id).max(AGENT_RULE_LIST_MAX);

/** `PUT /api/v1/agents/:id/messaging`: replaces the bot's own `agent.message` rules (outbound and inbound). */
export const SetAgentMessagingRequest = z
  .object({
    outbound: z.object({
      mode: AgentMessagingOutboundMode,
      allow: AgentIdList,
      deny: AgentIdList,
    }),
    inbound: z.object({ consultable: z.boolean() }),
  })
  .superRefine((r, ctx) => {
    const { mode } = r.outbound;
    // Ids compare case-insensitively: one bot has one identity whatever the spelling.
    const allow = r.outbound.allow.map((id) => id.toLowerCase());
    const deny = r.outbound.deny.map((id) => id.toLowerCase());
    if ((mode === "only") !== allow.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["outbound", "allow"],
        message: "an allow list is required with mode only, and only with it",
      });
    }
    if (mode === "none" && deny.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["outbound", "deny"],
        message: "mode none already denies every bot",
      });
    }
    if (new Set(allow).size !== allow.length) {
      ctx.addIssue({ code: "custom", path: ["outbound", "allow"], message: "duplicate bot" });
    }
    if (new Set(deny).size !== deny.length) {
      ctx.addIssue({ code: "custom", path: ["outbound", "deny"], message: "duplicate bot" });
    }
    if (allow.some((id) => deny.includes(id))) {
      ctx.addIssue({
        code: "custom",
        path: ["outbound"],
        message: "a bot cannot be both allowed and denied",
      });
    }
  });
export type SetAgentMessagingRequest = z.infer<typeof SetAgentMessagingRequest>;
