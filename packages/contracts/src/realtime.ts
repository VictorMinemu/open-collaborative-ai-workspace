import { z } from "zod";

/**
 * Realtime envelope for `GET /ws` (browser, cookie auth) — research Pattern 5.
 * Topics: `conv:<id>` (conversation incl. thread/work-session conversations), `user:<id>` (personal),
 * `org:<id>` (org-wide lists: channels, agents, devices, sessions), `ws:<id>` (work session events),
 * `cell:<orgId>` (OpenClaw cell stream; Agent Channel API only, never authorized for browsers).
 */

export const TopicPrefix = z.enum(["conv", "user", "org", "ws", "cell"]);
export type TopicPrefix = z.infer<typeof TopicPrefix>;

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const Topic = z.string().regex(new RegExp(`^(conv|user|org|ws|cell):${UUID_RE}$`), "invalid topic");
export type Topic = z.infer<typeof Topic>;

export function topic(prefix: TopicPrefix, id: string): Topic {
  return `${prefix}:${id}`;
}

export function parseTopic(t: string): { prefix: TopicPrefix; id: string } | null {
  if (!Topic.safeParse(t).success) return null;
  const idx = t.indexOf(":");
  return { prefix: t.slice(0, idx) as TopicPrefix, id: t.slice(idx + 1) };
}

// ---- client → server ----
export const ClientFrame = z.discriminatedUnion("op", [
  z.object({ op: z.literal("sub"), topic: Topic, afterSeq: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal("unsub"), topic: Topic }),
  z.object({ op: z.literal("ping") }),
  /** Client-originated ephemeral signal (e.g. user.typing); the server re-authorizes and relays. */
  z.object({ op: z.literal("eph"), topic: Topic, type: z.string().max(64), data: z.unknown() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---- server → client ----
export const ServerFrame = z.discriminatedUnion("op", [
  /** Durable event: persisted in stream_events with a per-topic monotonic seq. */
  z.object({
    op: z.literal("ev"),
    topic: z.string(),
    seq: z.number().int().positive(),
    type: z.string(),
    data: z.unknown(),
  }),
  /** Ephemeral event: never persisted, no seq (typing, deltas, presence). */
  z.object({ op: z.literal("eph"), topic: z.string(), type: z.string(), data: z.unknown() }),
  z.object({ op: z.literal("subscribed"), topic: z.string(), lastSeq: z.number().int().nonnegative() }),
  /** Gap too large to replay: refetch the HTTP snapshot then resubscribe with its lastSeq. */
  z.object({ op: z.literal("resync"), topic: z.string() }),
  z.object({
    op: z.literal("err"),
    code: z.string(),
    topic: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ op: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
export type DurableFrame = Extract<ServerFrame, { op: "ev" }>;
export type EphemeralFrame = Extract<ServerFrame, { op: "eph" }>;

/** Max events replayed per `sub`; beyond this the server sends `resync`. */
export const REPLAY_LIMIT = 500;

/** Well-known durable event types (payload shapes live next to their domain schemas). */
export const EventTypes = {
  messageCreated: "message.created",
  messageUpdated: "message.updated",
  threadUpdated: "thread.updated",
  conversationCreated: "conversation.created",
  conversationUpdated: "conversation.updated",
  conversationMemberAdded: "conversation.member_added",
  conversationMemberRemoved: "conversation.member_removed",
  memberJoined: "member.joined",
  agentCreated: "agent.created",
  agentUpdated: "agent.updated",
  agentDeleted: "agent.deleted",
  modelProvidersUpdated: "model_providers.updated",
  deviceUpdated: "device.updated",
  projectUpdated: "project.updated",
  workSessionUpdated: "work_session.updated",
  workSessionEvent: "work_session.event",
  workSessionChanges: "work_session.changes",
  promptUpdated: "prompt.updated",
  approvalUpdated: "approval.updated",
} as const;

/** Well-known ephemeral event types. */
export const EphemeralTypes = {
  userTyping: "user.typing",
  agentTyping: "agent.typing",
  /** On `org:<id>`: the OpenClaw cell connected/disconnected (AgentCellStatus payload). */
  cellPresence: "cell.presence",
  /**
   * On `org:<id>`: a subscription sign-in flow changed state. Payload `{provider, state}` only (never the
   * code): admins refetch `GET /api/v1/model-providers/:provider/auth`.
   */
  providerAuth: "provider.auth.updated",
  assistantDelta: "assistant.delta",
} as const;
