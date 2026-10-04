import { z } from "zod";
import { AgentStatus, ModelProviderKind, ProviderAuthErrorCode, SubscriptionProviderKind } from "./agent";
import { ConversationKind, Mention, MessageBody } from "./chat";
import { Id, IsoDateTime, MemberKind, PrincipalKind } from "./common";
import { ServerFrame } from "./realtime";

/**
 * Agent Channel API v1 — the ONLY surface the OpenClaw channel plugin talks to (AGENTS principle 9).
 * Mounted at `/agent-channel/v1` (never under /api/v1, never cookies). Every request carries
 * `Authorization: Bearer <cell token>`. Full contract with examples:
 * `.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md`.
 *
 * Shapes follow 01-RESEARCH.md Addendum A §A2 exactly; fields beyond the addendum are additive.
 */

export const AGENT_CHANNEL_PROTOCOL_VERSION = 1;
export const AGENT_CHANNEL_BASE_PATH = "/agent-channel/v1";

/** Durable event types on the cell stream `cell:<cellId>`. */
export const AgentChannelEventTypes = {
  mention: "agent.mention.v1",
  configChanged: "cell.config.changed",
  /** Admin clicked "Connect": run the provider's device-code sign-in inside the cell. */
  providerAuthStart: "provider.auth.start",
  /** Admin cancelled a pending sign-in. */
  providerAuthCancel: "provider.auth.cancel",
  /** Admin disconnected the subscription: delete the cell's stored credentials for it. */
  providerAuthRevoke: "provider.auth.revoke",
} as const;

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const CellTopic = z.string().regex(new RegExp(`^cell:${UUID_RE}$`), "invalid cell topic");
export const cellTopic = (cellId: string) => `cell:${cellId}`;

// ---------------------------------------------------------------- inbound: agent.mention.v1 (A2.2)

/** Server-resolved identity. Never derived from message text. */
export const AgentChannelAuthor = z.object({
  kind: PrincipalKind,
  id: Id,
  displayName: z.string(),
});
export type AgentChannelAuthor = z.infer<typeof AgentChannelAuthor>;

export const AgentChannelRosterEntry = z.object({
  kind: MemberKind,
  id: Id,
  displayName: z.string(),
  /** Org role for users (`owner` | `admin` | `member`). */
  role: z.string().optional(),
  /** @handle for agents. */
  handle: z.string().optional(),
});
export type AgentChannelRosterEntry = z.infer<typeof AgentChannelRosterEntry>;

export const AgentChannelHistoryEntry = z.object({
  id: Id,
  author: AgentChannelAuthor,
  text: z.string(),
  createdAt: IsoDateTime,
});
export type AgentChannelHistoryEntry = z.infer<typeof AgentChannelHistoryEntry>;

export const AgentMentionEvent = z.object({
  eventId: Id,
  /** Seq of this event on `cell:<cellId>` (the plugin's resume cursor). */
  seq: z.number().int().positive(),
  type: z.literal(AgentChannelEventTypes.mention),
  organizationId: Id,
  cellId: Id,
  agent: z.object({ id: Id, handle: z.string(), displayName: z.string() }),
  conversation: z.object({ id: Id, kind: ConversationKind, name: z.string().nullable() }),
  /** Root = the mention itself when it was posted at channel level. Reply goes into this thread. */
  thread: z.object({ rootMessageId: Id }),
  message: z.object({
    id: Id,
    text: z.string(),
    createdAt: IsoDateTime,
    author: AgentChannelAuthor,
    mentions: z.array(Mention),
  }),
  /** Oldest first, newest last, max 50, EXCLUDES the current message. */
  threadHistory: z.array(AgentChannelHistoryEntry),
  roster: z.array(AgentChannelRosterEntry),
});
export type AgentMentionEvent = z.infer<typeof AgentMentionEvent>;

export const CellConfigChangedEvent = z.object({
  type: z.literal(AgentChannelEventTypes.configChanged),
  organizationId: Id,
  cellId: Id,
  reason: z.enum([
    "agent.created",
    "agent.updated",
    "agent.disabled",
    "agent.enabled",
    "agent.deleted",
    "providers.updated",
  ]),
  agentId: Id.nullable(),
  /** Seq of this event on `cell:<cellId>`. */
  seq: z.number().int().positive(),
});
export type CellConfigChangedEvent = z.infer<typeof CellConfigChangedEvent>;

// ---------------------------------------------------------------- subscription sign-in (additive, v1)
//
// Older plugins ignore these event types (unknown types are skipped), so the additions are backward
// compatible. The device code itself never travels on the stream: the cell reports it over
// `POST /provider-auth` and only admins can read it back from `/api/v1`.

export const ProviderAuthStartEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthStart),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  flowId: Id,
  provider: SubscriptionProviderKind,
  method: z.literal("device-code"),
  /** A cell that sees this event after this instant (e.g. replay after downtime) must ignore it. */
  startBefore: IsoDateTime,
});
export type ProviderAuthStartEvent = z.infer<typeof ProviderAuthStartEvent>;

export const ProviderAuthCancelEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthCancel),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  flowId: Id,
  provider: SubscriptionProviderKind,
});
export type ProviderAuthCancelEvent = z.infer<typeof ProviderAuthCancelEvent>;

export const ProviderAuthRevokeEvent = z.object({
  type: z.literal(AgentChannelEventTypes.providerAuthRevoke),
  organizationId: Id,
  cellId: Id,
  seq: z.number().int().positive(),
  provider: SubscriptionProviderKind,
});
export type ProviderAuthRevokeEvent = z.infer<typeof ProviderAuthRevokeEvent>;

/**
 * `POST /agent-channel/v1/provider-auth` — the cell reports progress of a sign-in flow, or (flowId null)
 * the state of the credentials it holds. Never tokens: only the code the admin must type, and identity.
 */
export const AgentChannelProviderAuthReport = z.object({
  provider: SubscriptionProviderKind,
  /** The flow being reported; null for an out-of-band credential state report. */
  flowId: Id.nullable(),
  /**
   * Random id of the reporting plugin instance. The first instance that reports on a flow owns it;
   * other instances (HA, plugin swap) get 409 `flow_claimed` and must abort their attempt.
   */
  reporterId: z.string().min(8).max(64),
  state: z.enum(["pending", "connected", "error", "disconnected"]),
  /** `pending` only. */
  verificationUrl: z.url().max(500).optional(),
  /** `pending` only. */
  userCode: z.string().min(4).max(32).optional(),
  /** `pending` only: when the code stops working. */
  expiresAt: IsoDateTime.optional(),
  /** `connected` only. */
  account: z
    .object({ email: z.string().max(320).nullable(), planType: z.string().max(64).nullable() })
    .optional(),
  /** `error` only. */
  error: z.object({ code: ProviderAuthErrorCode, message: z.string().max(300) }).optional(),
});
export type AgentChannelProviderAuthReport = z.infer<typeof AgentChannelProviderAuthReport>;

// ---------------------------------------------------------------- WebSocket frames (GET /ws)

/**
 * Plugin → server. `sub` without `afterSeq` starts LIVE (no replay) so a fresh plugin never re-answers old
 * mentions; pass the last processed seq to resume exactly once.
 */
export const AgentChannelClientFrame = z.discriminatedUnion("op", [
  z.object({ op: z.literal("sub"), topic: CellTopic, afterSeq: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal("ping") }),
]);
export type AgentChannelClientFrame = z.infer<typeof AgentChannelClientFrame>;

/** Server → plugin: the browser envelope (research Pattern 5). `ev.data` is an event object above. */
export const AgentChannelServerFrame = ServerFrame;
export type AgentChannelServerFrame = z.infer<typeof AgentChannelServerFrame>;

// ---------------------------------------------------------------- GET /cell

export const CellModelApi = z.enum(["anthropic-messages", "openai-completions"]);

/**
 * Model provider credentials for the cell. `apiKey` is decrypted on demand and sent ONLY over this
 * authenticated channel (documented trade-off in 01-AGENT-CHANNEL-API.md); it is never logged.
 */
export const CellProvider = z.object({
  /** OpenClaw provider id used in `modelRef` (`anthropic`, `openai`, `openrouter`, `openai-compatible`, `fake`). */
  id: z.string(),
  kind: ModelProviderKind,
  api: CellModelApi,
  baseUrl: z.string(),
  apiKey: z.string().nullable(),
  models: z.array(z.string()),
});
export type CellProvider = z.infer<typeof CellProvider>;

export const CellAgent = z.object({
  id: Id,
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  description: z.string().nullable(),
  instructions: z.string(),
  /** Reconcile only agents whose status is not `disabled`. */
  status: AgentStatus,
  /** `<provider id>/<model id>`, e.g. `anthropic/claude-sonnet-5-5`, `fake/mock-1`. */
  modelRef: z.string(),
  model: z.object({ provider: ModelProviderKind, providerId: z.string(), id: z.string() }),
  updatedAt: IsoDateTime,
});
export type CellAgent = z.infer<typeof CellAgent>;

/**
 * A connected subscription provider (credentials live in the cell's own auth store, never here). The
 * plugin maps `<id>/<model>` model refs to the runtime provider (`openai/<model>` for `openai-codex`)
 * and pins them to OpenClaw's embedded runtime.
 */
export const CellSubscription = z.object({
  /** Prefix of `modelRef` (`openai-codex`). */
  id: SubscriptionProviderKind,
  kind: SubscriptionProviderKind,
  /** OpenClaw provider id that owns the credential and the model catalog (`openai`). */
  runtimeProvider: z.string(),
  models: z.array(z.string()),
  /** Who the API believes is signed in (from the cell's own earlier report). */
  account: z.object({ email: z.string().nullable() }),
});
export type CellSubscription = z.infer<typeof CellSubscription>;

export const CellSnapshot = z.object({
  protocolVersion: z.literal(AGENT_CHANNEL_PROTOCOL_VERSION),
  cellId: Id,
  organizationId: Id,
  topic: CellTopic,
  /** Current last seq of the cell stream; `sub` with this to go live without replay. */
  lastSeq: z.number().int().nonnegative(),
  agents: z.array(CellAgent),
  providers: z.array(CellProvider),
  /** Additive (older plugins ignore it): connected subscription providers. */
  subscriptions: z.array(CellSubscription).default([]),
});
export type CellSnapshot = z.infer<typeof CellSnapshot>;

// ---------------------------------------------------------------- POST /messages, /typing, /agents/:id/status

export const AgentChannelPostMessage = z.object({
  agentId: Id,
  conversationId: Id,
  /** From `event.thread.rootMessageId`. */
  threadRootMessageId: Id.nullable(),
  /** From `event.message.id` (used for attribution: the triggering human). */
  inReplyToMessageId: Id.optional(),
  text: MessageBody,
  /** At-least-once delivery: the same key for the same agent never creates two messages. */
  idempotencyKey: z.string().min(1).max(200),
});
export type AgentChannelPostMessage = z.infer<typeof AgentChannelPostMessage>;

export const AgentChannelPostMessageResponse = z.object({
  messageId: Id,
  /** false when the idempotency key was already used (the original message id is returned). */
  created: z.boolean(),
  conversationId: Id,
  threadRootMessageId: Id.nullable(),
});
export type AgentChannelPostMessageResponse = z.infer<typeof AgentChannelPostMessageResponse>;

export const AgentChannelTyping = z.object({
  agentId: Id,
  conversationId: Id,
  threadRootMessageId: Id.nullable().optional(),
  typing: z.boolean().default(true),
});
export type AgentChannelTyping = z.infer<typeof AgentChannelTyping>;

export const AgentChannelStatusReport = z.object({
  status: z.enum(["ready", "error"]),
  /** Human-readable detail, shown to admins on error (max 500 chars, never secrets). */
  detail: z.string().max(500).optional(),
});
export type AgentChannelStatusReport = z.infer<typeof AgentChannelStatusReport>;
