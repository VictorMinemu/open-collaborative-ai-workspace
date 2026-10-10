import { z } from "zod";

/**
 * Realtime envelope for `GET /ws` (browser, cookie auth) — research Pattern 5.
 * Topics: `conv:<id>` (conversation incl. thread/work-session conversations), `user:<id>` (personal),
 * `org:<id>` (org-wide lists: channels, agents, devices, sessions), `ws:<id>` (work session events),
 * `cell:<orgId>` (OpenClaw cell stream; Agent Channel API only, never authorized for browsers).
 * Server ops: `ev` (durable), `eph` (ephemeral), `subscribed`, `resync`, `err`, `pong`, `presence` (who is
 * here now in a `conv`/`ws` topic: a `full` snapshot right after `subscribed`, then per-connection deltas) and
 * `revoked` (a live subscription lost its access and was dropped by the server).
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

/**
 * Presence (RT-04, 03-01 D-01/D-03): per conversation, per connection. `conn` is an opaque random id per socket
 * (never a session id); `userId` comes from the verified JWT. `offline` only appears in deltas and removes the
 * connection. Clients aggregate per user (online beats away).
 */
export const PresenceEntryState = z.enum(["online", "away", "offline"]);
export type PresenceEntryState = z.infer<typeof PresenceEntryState>;
export const PresenceEntry = z.object({ conn: z.uuid(), userId: z.uuid(), state: PresenceEntryState });
export type PresenceEntry = z.infer<typeof PresenceEntry>;
/** Topic prefixes that carry presence: conversations (channels, threads) and Work Zone sessions. */
export const PRESENCE_TOPIC_PREFIXES: readonly TopicPrefix[] = ["conv", "ws"];
/** Max entries in one presence frame (snapshots are capped server-side). */
export const PRESENCE_SNAPSHOT_LIMIT = 500;

export function isPresenceTopic(t: string): boolean {
  const parsed = parseTopic(t);
  return !!parsed && PRESENCE_TOPIC_PREFIXES.includes(parsed.prefix);
}

/**
 * The state a client reports for its own connection (RT-04, 03-02 D-04): `away` while its tab is hidden or after
 * AWAY_AFTER_IDLE_MS without input, `online` otherwise. `offline` is never reported: closing the socket is.
 */
export const PresenceState = z.enum(["online", "away"]);
export type PresenceState = z.infer<typeof PresenceState>;
/** A visible tab with no input for this long reports `away`. */
export const AWAY_AFTER_IDLE_MS = 5 * 60_000;
/** Client-side leading + trailing throttle of `presence` frames. */
export const PRESENCE_CLIENT_THROTTLE_MS = 500;

// ---- client → server ----
export const ClientFrame = z.discriminatedUnion("op", [
  /**
   * `presence: true` = the subscriber is looking at this conversation (RT-04): it joins the topic's presence and
   * receives its presence frames. Background subscriptions (unread watchers) leave it out and never count as
   * "here". Re-sending `sub` with a different flag switches it.
   */
  z.object({
    op: z.literal("sub"),
    topic: Topic,
    afterSeq: z.number().int().nonnegative().optional(),
    presence: z.boolean().optional(),
  }),
  z.object({ op: z.literal("unsub"), topic: Topic }),
  z.object({ op: z.literal("ping") }),
  /** Client-originated ephemeral signal (e.g. user.typing); the server re-authorizes and relays. */
  z.object({ op: z.literal("eph"), topic: Topic, type: z.string().max(64), data: z.unknown() }),
  /**
   * The sender's own state in every conversation it is present in (RT-04). Carries no user, topic or connection:
   * the server applies it to the sending socket only (unknown fields are stripped).
   */
  z.object({ op: z.literal("presence"), state: PresenceState }),
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
  /** Who is here now: `full` = snapshot sent right after `subscribed`; otherwise a per-connection delta. */
  z.object({
    op: z.literal("presence"),
    topic: z.string(),
    full: z.boolean(),
    entries: z.array(PresenceEntry).max(PRESENCE_SNAPSHOT_LIMIT),
  }),
  /**
   * The server dropped this subscription because access to the topic was lost (RT-01, 03-04 D-05): the resolver
   * re-decided it after a membership or permission change. The client forgets the topic and does not resubscribe.
   */
  z.object({ op: z.literal("revoked"), topic: z.string(), reason: z.enum(["forbidden"]) }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
export type DurableFrame = Extract<ServerFrame, { op: "ev" }>;
export type EphemeralFrame = Extract<ServerFrame, { op: "eph" }>;
export type PresenceFrame = Extract<ServerFrame, { op: "presence" }>;
export type RevokedFrame = Extract<ServerFrame, { op: "revoked" }>;

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
  /** On `org:<id>`: a member's role, status or profile changed. Payload MemberUpdatedPayload. */
  memberUpdated: "member.updated",
  /** On `org:<id>`: the unit hierarchy or a unit's memberships changed. Payload UnitsUpdatedPayload. */
  unitsUpdated: "units.updated",
  /** On `org:<id>`: an explicit allow/deny rule changed. Payload PermissionRulesUpdatedPayload. */
  permissionRulesUpdated: "permission_rules.updated",
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
  // Phase 4 (P-04). On `conv:<id>`:
  messageDeleted: "message.deleted",
  reactionUpdated: "reaction.updated",
  pinUpdated: "pin.updated",
  // On `user:<id>` (personal; ordinary channel messages are never fanned out here):
  saveUpdated: "save.updated",
  notificationCreated: "notification.created",
  notificationRead: "notification.read",
  conversationRead: "conversation.read",
  threadRead: "thread.read",
  notificationPrefsUpdated: "notification_prefs.updated",
  // Phase 5 (P-06). On `user:<owner>`: an AI chat's summary changed (title, last model, generating, archived).
  // Payload AiChatUpdatedEvent.
  aiChatUpdated: "ai_chat.updated",
  // Phase 6 (P-08, P-09). On `conv:<id>` of an AI chat: the one-generation queue changed (AiQueueUpdatedEvent).
  aiQueueUpdated: "ai.queue.updated",
  // On `conv:<id>` and `user:<affected>`; ids only on `org:<id>` for unit/org grants (AiChatAccessChangedEvent).
  aiChatAccessChanged: "ai_chat.access_changed",
  // Phase 07.1 (D-03, P-06). On `conv:<id>` of a board channel only; payloads in board.ts.
  /** One card created, moved or edited (BoardCardUpsertedEvent). Removal rides `message.deleted`. */
  boardCardUpserted: "board.card_upserted",
  /** Board settings and the full column list (BoardUpdatedEvent). */
  boardUpdated: "board.updated",
  /** One column's new ranks after a server re-rank (BoardColumnRerankedEvent). */
  boardColumnReranked: "board.column_reranked",
} as const;

export const MemberUpdatedPayload = z.object({ userId: z.uuid(), changed: z.array(z.string()) });
export type MemberUpdatedPayload = z.infer<typeof MemberUpdatedPayload>;

export const UnitsUpdatedPayload = z.object({ unitId: z.uuid(), action: z.string() });
export type UnitsUpdatedPayload = z.infer<typeof UnitsUpdatedPayload>;

export const PermissionRulesUpdatedPayload = z.object({ ruleId: z.uuid(), action: z.string() });
export type PermissionRulesUpdatedPayload = z.infer<typeof PermissionRulesUpdatedPayload>;

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
  /**
   * On `user:<id>` (CHAT-10, P-04): a plain channel message for a member who chose "all new messages" there
   * (`MessageNotifyEvent`). Ephemeral, so ordinary messages are never stored on personal streams.
   */
  messageNotify: "message.notify",
  /**
   * On `conv:<id>` of an AI chat (Phase 5, P-06): streamed answer text at a UTF-16 `offset` (`AiDeltaEvent`),
   * coalesced every AI_DELTA_COALESCE_MS. The durable `message.updated` at the end carries the final body.
   */
  aiDelta: "ai.delta",
} as const;
