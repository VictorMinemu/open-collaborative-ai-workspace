// TEMP: replace with @ocw/contracts once merged
/**
 * Agent Channel API v1 — mirror of the canonical `packages/contracts/src/agent-channel.ts` and
 * `.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md`. The ONLY surface
 * the OpenClaw cell talks to (AGENTS principle 9).
 *
 * Base `${OCW_API_URL}/agent-channel/v1`, every request `Authorization: Bearer <cell token>`.
 *   GET  /cell                 → CellSnapshot (bots + provider credentials; keys are secrets)
 *   GET  /ws                   → WebSocket; client sends {op:"sub", topic:"cell:<cellId>", afterSeq?}
 *   POST /messages             ← AgentChannelPostMessage → AgentChannelPostMessageResponse
 *   POST /typing               ← AgentChannelTyping → {ok:true}
 *   POST /agents/:id/status    ← AgentChannelStatusReport (ready | error) after provisioning
 *
 * Parsing is deliberately lenient on ids (any non-empty string) and ignores unknown fields, so the
 * API can add fields without breaking deployed cells; required fields are enforced.
 */
import { z } from "zod";

export const AGENT_CHANNEL_PROTOCOL_VERSION = 1;
export const AGENT_CHANNEL_BASE_PATH = "/agent-channel/v1";
export const AgentChannelEventTypes = {
  mention: "agent.mention.v1",
  configChanged: "cell.config.changed",
} as const;
export const cellTopic = (cellId: string) => `cell:${cellId}`;

const Id = z.string().min(1);

export const AgentChannelAuthor = z.object({
  kind: z.enum(["user", "agent", "system"]),
  id: Id,
  displayName: z.string(),
});
export type AgentChannelAuthor = z.infer<typeof AgentChannelAuthor>;

export const AgentChannelRosterEntry = z.object({
  kind: z.enum(["user", "agent"]),
  id: Id,
  displayName: z.string(),
  role: z.string().optional(),
  handle: z.string().optional(),
});
export type AgentChannelRosterEntry = z.infer<typeof AgentChannelRosterEntry>;

export const AgentChannelHistoryEntry = z.object({
  id: Id,
  author: AgentChannelAuthor,
  text: z.string(),
  createdAt: z.string(),
});
export type AgentChannelHistoryEntry = z.infer<typeof AgentChannelHistoryEntry>;

export const AgentMentionEvent = z.object({
  eventId: Id,
  seq: z.number().int().positive(),
  type: z.literal(AgentChannelEventTypes.mention),
  organizationId: Id,
  cellId: Id,
  agent: z.object({ id: Id, handle: z.string(), displayName: z.string() }),
  conversation: z.object({ id: Id, kind: z.string(), name: z.string().nullable() }),
  /** Root = the mention itself when posted at channel level. Reply goes into this thread. */
  thread: z.object({ rootMessageId: Id }),
  message: z.object({
    id: Id,
    text: z.string(),
    createdAt: z.string(),
    author: AgentChannelAuthor,
    mentions: z.array(z.object({ kind: z.enum(["user", "agent"]), id: Id })),
  }),
  /** Oldest first, max 50, EXCLUDES the current message. */
  threadHistory: z.array(AgentChannelHistoryEntry),
  roster: z.array(AgentChannelRosterEntry),
});
export type AgentMentionEvent = z.infer<typeof AgentMentionEvent>;

export const CellConfigChangedEvent = z.object({
  type: z.literal(AgentChannelEventTypes.configChanged),
  organizationId: Id,
  cellId: Id,
  reason: z.string(),
  agentId: Id.nullable(),
  seq: z.number().int().positive(),
});
export type CellConfigChangedEvent = z.infer<typeof CellConfigChangedEvent>;

/** Plugin → server. `sub` without afterSeq starts LIVE (no replay). */
export type AgentChannelClientFrame = { op: "sub"; topic: string; afterSeq?: number } | { op: "ping" };

/** Server → plugin (browser envelope). */
export const AgentChannelServerFrame = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("ev"),
    topic: z.string(),
    seq: z.number().int().positive(),
    type: z.string(),
    data: z.unknown(),
  }),
  z.object({
    op: z.literal("subscribed"),
    topic: z.string(),
    lastSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ op: z.literal("resync"), topic: z.string() }),
  z.object({
    op: z.literal("err"),
    code: z.string(),
    topic: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ op: z.literal("pong") }),
  z.object({ op: z.literal("eph") }).passthrough(),
]);
export type AgentChannelServerFrame = z.infer<typeof AgentChannelServerFrame>;

export const CellProvider = z.object({
  /** OpenClaw provider id used in `modelRef` (`anthropic`, `openai`, `openrouter`, `openai-compatible`, `fake`). */
  id: z.string().min(1),
  kind: z.string(),
  api: z.enum(["anthropic-messages", "openai-completions"]),
  baseUrl: z.string().min(1),
  /** SECRET. Never log; written to OpenClaw only as an env reference. */
  apiKey: z.string().nullable(),
  models: z.array(z.string()),
});
export type CellProvider = z.infer<typeof CellProvider>;

export const CellAgent = z.object({
  id: Id,
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().nullable().default(""),
  status: z.enum(["provisioning", "ready", "error", "disabled"]),
  /** `<provider id>/<model id>`, e.g. `anthropic/claude-sonnet-5-5`, `fake/mock-1`. */
  modelRef: z.string().min(3),
  model: z.object({ provider: z.string(), providerId: z.string(), id: z.string() }),
  updatedAt: z.string().optional(),
});
export type CellAgent = z.infer<typeof CellAgent>;

export const CellSnapshot = z.object({
  protocolVersion: z.number().int(),
  cellId: Id,
  organizationId: Id,
  topic: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
  agents: z.array(CellAgent),
  providers: z.array(CellProvider),
});
export type CellSnapshot = z.infer<typeof CellSnapshot>;

export type AgentChannelPostMessage = {
  agentId: string;
  conversationId: string;
  threadRootMessageId: string | null;
  inReplyToMessageId?: string;
  /** Markdown, 1..20000 chars. */
  text: string;
  /** 1..200 chars; the server dedupes on (agentId, idempotencyKey). */
  idempotencyKey: string;
};

export const AgentChannelPostMessageResponse = z
  .object({
    messageId: Id,
    created: z.boolean().optional(),
    conversationId: Id.optional(),
    threadRootMessageId: Id.nullable().optional(),
  })
  .passthrough();
export type AgentChannelPostMessageResponse = z.infer<typeof AgentChannelPostMessageResponse>;

export type AgentChannelTyping = {
  agentId: string;
  conversationId: string;
  threadRootMessageId?: string | null;
  typing?: boolean;
};

export type AgentChannelStatusReport = { status: "ready" | "error"; detail?: string };
