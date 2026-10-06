import { z } from "zod";
import { ModelId } from "./agent";
import { AiBackend, AiGeneration, ModelRef } from "./ai-generation";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments";
import { CursorQuery, Message, MessageAuthor } from "./chat";
import { Id, IsoDateTime } from "./common";
import { Permission } from "./permissions";
import { TitleSource } from "./session-title";

/**
 * Phase 5 Direct AI Chat contracts (P-01). An AI chat is a private `ai_chat` conversation with exactly one
 * member (its owner); each assistant answer is one generation on the member's ChatGPT plan, an organization key
 * or the E2E mock. Later plans import these names verbatim and only add.
 */

/** Where a member manages their ChatGPT plan usage (OpenAI UI rule: shown near the composer, P-11). */
export const CHATGPT_MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

export const AI_INSTRUCTIONS_MAX = 8_000;
export const AI_CHAT_TITLE_MAX = 80;
/** Ephemeral `ai.delta` frames are coalesced at this interval (P-06). */
export const AI_DELTA_COALESCE_MS = 50;
/** Partial text is flushed to `ai_generations.partial_text` at this interval, never to `messages.body`. */
export const AI_PARTIAL_FLUSH_MS = 1_000;
export const AI_HEARTBEAT_MS = 10_000;
/** A running generation without a heartbeat for this long is marked `interrupted` by the sweeper. */
export const AI_STALE_AFTER_MS = 60_000;
export const AI_SNAPSHOT_MESSAGES = 100;
export const AI_MAX_SEARCHES_PER_TURN = 5;
export const AI_MAX_FETCHES_PER_TURN = 3;
export const AI_MAX_STEPS = 6;
export const AI_TEXT_INLINE_MAX_BYTES = 100 * 1024;

// ---------------------------------------------------------------- models

export const ModelCaps = z.object({
  vision: z.boolean(),
  pdf: z.boolean(),
  webSearch: z.enum(["hosted", "function", "none"]),
});
export type ModelCaps = z.infer<typeof ModelCaps>;

export const ModelUnavailableReason = z.enum([
  "not_connected",
  "needs_reconnect",
  "not_eligible",
  "plan_usage_disabled",
  "plan_disabled_by_org",
  "org_keys_disabled",
  "no_key",
  "not_allowed",
  "not_in_catalog",
]);
export type ModelUnavailableReason = z.infer<typeof ModelUnavailableReason>;

export const AiModelGroup = z.enum(["chatgpt_plan", "organization", "mock"]);
export type AiModelGroup = z.infer<typeof AiModelGroup>;

export const AiModelOption = z.object({
  ref: ModelRef,
  label: z.string(),
  providerLabel: z.string(),
  group: AiModelGroup,
  /** Billed to the organization (the METERED label, P-11). */
  metered: z.boolean(),
  caps: ModelCaps,
  available: z.boolean(),
  reason: ModelUnavailableReason.nullable(),
  isDefault: z.boolean(),
});
export type AiModelOption = z.infer<typeof AiModelOption>;

// ---------------------------------------------------------------- ChatGPT plan (per member, never pooled: D-01)

export const ChatgptPlanState = z.enum([
  "not_connected",
  "connected",
  "needs_reconnect",
  "not_eligible",
  "plan_usage_disabled",
  "disabled_by_org",
]);
export type ChatgptPlanState = z.infer<typeof ChatgptPlanState>;

export const ChatgptPlanStatus = z.object({
  state: ChatgptPlanState,
  email: z.string().nullable(),
  planType: z.string().nullable(),
  connectedAt: IsoDateTime.nullable(),
  welcomeSeen: z.boolean(),
  manageUsageUrl: z.literal(CHATGPT_MANAGE_USAGE_URL),
});
export type ChatgptPlanStatus = z.infer<typeof ChatgptPlanStatus>;

export const AiModelList = z.object({
  models: z.array(AiModelOption),
  chatgptPlan: ChatgptPlanStatus,
  defaultRef: ModelRef.nullable(),
});
export type AiModelList = z.infer<typeof AiModelList>;

export const ChatgptSignInStartRequest = z.object({
  redirectPort: z.number().int().min(1024).max(65535).default(1455),
});
export type ChatgptSignInStartRequest = z.infer<typeof ChatgptSignInStartRequest>;

export const ChatgptSignInStartResponse = z.object({
  flowId: Id,
  authorizeUrl: z.url(),
  expiresAt: IsoDateTime,
});
export type ChatgptSignInStartResponse = z.infer<typeof ChatgptSignInStartResponse>;

/** `redirectUrl` carries the one-time authorization code: never logged, never audited. */
export const ChatgptSignInCompleteRequest = z.object({
  flowId: Id,
  redirectUrl: z.string().trim().min(1).max(4_000),
});
export type ChatgptSignInCompleteRequest = z.infer<typeof ChatgptSignInCompleteRequest>;

// ---------------------------------------------------------------- tools and settings

export const AiToolKey = z.enum(["web", "companyKnowledge", "mcp", "skills"]);
export type AiToolKey = z.infer<typeof AiToolKey>;

/** The toggles a member can switch per chat (Company Knowledge, MCP and Skills stay visible but disabled). */
export const AiChatTools = z.object({ web: z.boolean() });
export type AiChatTools = z.infer<typeof AiChatTools>;

export const AiToolUnavailableReason = z.enum([
  "not_available_yet",
  "search_not_configured",
  "disabled_by_org",
  "not_supported_by_model",
  "denied",
]);
export type AiToolUnavailableReason = z.infer<typeof AiToolUnavailableReason>;

export const AiToolState = z.object({
  key: AiToolKey,
  label: z.string(),
  enabled: z.boolean(),
  available: z.boolean(),
  reason: AiToolUnavailableReason.nullable(),
});
export type AiToolState = z.infer<typeof AiToolState>;

export const AiChatSettings = z.object({
  instructions: z.string().max(AI_INSTRUCTIONS_MAX),
  usePersonalInstructions: z.boolean(),
  tools: AiChatTools,
});
export type AiChatSettings = z.infer<typeof AiChatSettings>;

// ---------------------------------------------------------------- chats

export const AiChatSummary = z.object({
  id: Id,
  title: z.string(),
  titleSource: TitleSource,
  lastModel: ModelRef.nullable(),
  lastModelLabel: z.string().nullable(),
  archived: z.boolean(),
  /** A generation is running right now. */
  generating: z.boolean(),
  createdAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
});
export type AiChatSummary = z.infer<typeof AiChatSummary>;

export const AiChatDetail = AiChatSummary.extend({
  settings: AiChatSettings,
  tools: z.array(AiToolState),
  viewerCan: z.array(Permission),
});
export type AiChatDetail = z.infer<typeof AiChatDetail>;

/** The running generation of a snapshot: the client stitches buffered `ai.delta` frames onto `partialText`. */
export const AiRunning = z.object({ generationId: Id, messageId: Id, partialText: z.string() });
export type AiRunning = z.infer<typeof AiRunning>;

export const AiChatSnapshot = z.object({
  chat: AiChatDetail,
  messages: z.array(Message),
  hasMore: z.boolean(),
  running: AiRunning.nullable(),
  lastSeq: z.number().int().nonnegative(),
});
export type AiChatSnapshot = z.infer<typeof AiChatSnapshot>;

export const AiChatListQuery = CursorQuery.extend({
  archived: z
    .enum(["false", "true"])
    .default("false")
    .transform((v) => v === "true"),
});
export type AiChatListQuery = z.infer<typeof AiChatListQuery>;

export const AiChatList = z.object({ chats: z.array(AiChatSummary), nextCursor: z.string().nullable() });
export type AiChatList = z.infer<typeof AiChatList>;

const EMPTY_MESSAGE = "Write a message or attach a file";

function hasContent(r: { body: string; attachmentIds?: readonly string[] | undefined }): boolean {
  return r.body.length > 0 || (r.attachmentIds?.length ?? 0) > 0;
}

/** Fields of a send; kept unrefined so `CreateAiChatRequest` can extend them (zod refuses to extend a refine). */
const SendAiMessageFields = z.object({
  clientMessageId: z.string().trim().min(8).max(64),
  body: z.string().trim().max(20_000).default(""),
  model: ModelRef,
  attachmentIds: z.array(Id).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  tools: AiChatTools.optional(),
});

export const SendAiMessageRequest = SendAiMessageFields.refine(hasContent, {
  message: EMPTY_MESSAGE,
  path: ["body"],
});
export type SendAiMessageRequest = z.infer<typeof SendAiMessageRequest>;

export const CreateAiChatRequest = SendAiMessageFields.extend({
  settings: AiChatSettings.partial().optional(),
}).refine(hasContent, { message: EMPTY_MESSAGE, path: ["body"] });
export type CreateAiChatRequest = z.infer<typeof CreateAiChatRequest>;

export const SendAiMessageResponse = z.object({
  chat: AiChatSummary,
  userMessage: Message,
  assistantMessage: Message,
  generation: AiGeneration,
});
export type SendAiMessageResponse = z.infer<typeof SendAiMessageResponse>;

const atLeastOneKey = (v: Record<string, unknown>) => Object.values(v).some((x) => x !== undefined);
const NOTHING_TO_UPDATE = { message: "nothing to update" } as const;

export const UpdateAiChatRequest = z
  .object({
    title: z.string().trim().min(1).max(AI_CHAT_TITLE_MAX).optional(),
    archived: z.boolean().optional(),
    settings: AiChatSettings.partial().optional(),
  })
  .refine(atLeastOneKey, NOTHING_TO_UPDATE);
export type UpdateAiChatRequest = z.infer<typeof UpdateAiChatRequest>;

/**
 * Regenerate the last answer, optionally on another model. `messageId` names the answer the client shows: when it
 * is no longer the chat's last answer (a stale tab) the API refuses with 409 `not_last_answer` (05-06).
 */
export const RegenerateRequest = z.object({ messageId: Id.optional(), model: ModelRef.optional() });
export type RegenerateRequest = z.infer<typeof RegenerateRequest>;

/** `POST /ai-chats/:id/generations/:gid/stop` path parameters (05-06). */
export const AiGenerationParams = z.object({ id: Id, gid: Id });
export type AiGenerationParams = z.infer<typeof AiGenerationParams>;

/** Stop is idempotent: 202 with the generation's status when the request was handled (`running` until it lands). */
export const StopAiGenerationResponse = z.object({ status: AiGeneration.shape.status });
export type StopAiGenerationResponse = z.infer<typeof StopAiGenerationResponse>;

// ---------------------------------------------------------------- streaming (P-06)

/** Ephemeral `ai.delta` on `conv:<id>`: `offset` = UTF-16 length of the answer already emitted before `text`. */
export const AiDeltaEvent = z.object({
  conversationId: Id,
  messageId: Id,
  generationId: Id,
  offset: z.number().int().nonnegative(),
  text: z.string().min(1).max(16_000),
});
export type AiDeltaEvent = z.infer<typeof AiDeltaEvent>;

/** Durable `ai_chat.updated` on `user:<owner>`. */
export const AiChatUpdatedEvent = z.object({ chat: AiChatSummary });
export type AiChatUpdatedEvent = z.infer<typeof AiChatUpdatedEvent>;

export type AiDeltaResult = { kind: "applied"; text: string } | { kind: "duplicate" } | { kind: "gap" };

/**
 * Apply one delta to the text known so far (pure; shared by the API tests and the web). A delta of another
 * message, or one already fully seen, is a duplicate; an overlapping delta contributes only its unseen suffix;
 * a delta that starts past the known text is a gap (the client refetches the snapshot).
 */
export function applyAiDelta(state: { messageId: string; text: string }, d: AiDeltaEvent): AiDeltaResult {
  if (d.messageId !== state.messageId) return { kind: "duplicate" };
  const known = state.text.length;
  if (d.offset > known) return { kind: "gap" };
  if (d.offset + d.text.length <= known) return { kind: "duplicate" };
  return { kind: "applied", text: state.text + d.text.slice(known - d.offset) };
}

/**
 * Stitch deltas buffered while the snapshot was loading onto its `running.partialText`, in offset order.
 * `complete` is false while a hole remains (the final `message.updated` always repairs it).
 */
export function stitchAiSnapshot(
  partialText: string,
  buffered: readonly AiDeltaEvent[],
): { text: string; complete: boolean } {
  const ordered = [...buffered].sort((a, b) => a.offset - b.offset);
  const messageId = ordered[0]?.messageId ?? "";
  let text = partialText;
  for (const d of ordered) {
    const r = applyAiDelta({ messageId, text }, d);
    if (r.kind === "gap") return { text, complete: false };
    if (r.kind === "applied") text = r.text;
  }
  return { text, complete: true };
}

// ---------------------------------------------------------------- member preferences

export const AiUserPreferences = z.object({
  instructions: z.string().max(AI_INSTRUCTIONS_MAX),
  defaultModel: ModelRef.nullable(),
  webDefault: z.boolean(),
});
export type AiUserPreferences = z.infer<typeof AiUserPreferences>;

export const UpdateAiUserPreferencesRequest = AiUserPreferences.partial().refine(
  atLeastOneKey,
  NOTHING_TO_UPDATE,
);
export type UpdateAiUserPreferencesRequest = z.infer<typeof UpdateAiUserPreferencesRequest>;

// ---------------------------------------------------------------- organization policy

export const AiChatPolicy = z.object({
  chatgptPlanEnabled: z.boolean(),
  orgKeysEnabled: z.boolean(),
  /** Plan models members may pick; empty = every model the plan offers. */
  planAllowedModels: z.array(ModelId).max(50),
  orgKeyDailyGenerations: z.number().int().min(1).max(100_000).nullable(),
  orgKeyDailyCostMicros: z.number().int().min(1).max(10_000_000_000).nullable(),
  planDailyGenerations: z.number().int().min(1).max(100_000).nullable(),
  concurrentGenerationsPerUser: z.number().int().min(1).max(10),
  maxContextTokens: z.number().int().min(4_000).max(1_000_000),
  webEnabled: z.boolean(),
  /** Small model used for titles, per provider. */
  titleModels: z.record(z.string().max(40), ModelId),
});
export type AiChatPolicy = z.infer<typeof AiChatPolicy>;

export const DEFAULT_AI_CHAT_POLICY: AiChatPolicy = Object.freeze({
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

export const UpdateAiChatPolicyRequest = AiChatPolicy.partial().refine(atLeastOneKey, NOTHING_TO_UPDATE);
export type UpdateAiChatPolicyRequest = z.infer<typeof UpdateAiChatPolicyRequest>;

// ---------------------------------------------------------------- usage (D-06, AICHAT-07)

const BackendTotals = z.object({
  generations: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const AiUsageToday = z.object({
  day: z.iso.date(),
  orgKey: BackendTotals.extend({ costMicrosUsd: z.number().int().nonnegative() }),
  chatgptPlan: BackendTotals,
  limits: z.object({
    orgKeyGenerations: z.number().int().nullable(),
    orgKeyCostMicros: z.number().int().nullable(),
    planGenerations: z.number().int().nullable(),
  }),
  resetsAt: IsoDateTime,
});
export type AiUsageToday = z.infer<typeof AiUsageToday>;

export const AiUsageReportQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  groupBy: z.enum(["user", "model"]).default("user"),
});
export type AiUsageReportQuery = z.infer<typeof AiUsageReportQuery>;

export const AiUsageReportRow = BackendTotals.extend({
  key: z.string(),
  label: z.string(),
  backend: AiBackend.nullable(),
  costMicrosUsd: z.number().int().nonnegative().nullable(),
  estimatedGenerations: z.number().int().nonnegative(),
});
export type AiUsageReportRow = z.infer<typeof AiUsageReportRow>;

export const AiUsageReport = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  groupBy: z.enum(["user", "model"]),
  rows: z.array(AiUsageReportRow),
  totals: AiUsageReportRow.omit({ key: true, label: true, backend: true }),
});
export type AiUsageReport = z.infer<typeof AiUsageReport>;

// ---------------------------------------------------------------- read-only share links (AICHAT-09)

/** URLs are API-relative and share-scoped: /api/v1/ai-shares/<shareId>/attachments/<attachmentId>/{preview,download}. */
export const AiShareAttachment = z.object({
  id: Id,
  filename: z.string(),
  contentType: z.string(),
  isImage: z.boolean(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  previewUrl: z.string().nullable(),
  downloadUrl: z.string(),
});
export type AiShareAttachment = z.infer<typeof AiShareAttachment>;

export const AiShareMessage = z.object({
  role: z.enum(["user", "assistant"]),
  body: z.string(),
  modelLabel: z.string().nullable(),
  createdAt: IsoDateTime,
  attachments: z.array(AiShareAttachment),
});
export type AiShareMessage = z.infer<typeof AiShareMessage>;

/** `path` is the web route `/share/ai/<id>` (sign-in required). */
export const AiChatShare = z.object({
  id: Id,
  chatId: Id,
  path: z.string(),
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
  revokedAt: IsoDateTime.nullable(),
});
export type AiChatShare = z.infer<typeof AiChatShare>;

export const AiChatShareList = z.object({ shares: z.array(AiChatShare) });
export type AiChatShareList = z.infer<typeof AiChatShareList>;

export const AiShareView = z.object({
  id: Id,
  title: z.string(),
  createdAt: IsoDateTime,
  createdBy: MessageAuthor,
  messages: z.array(AiShareMessage),
});
export type AiShareView = z.infer<typeof AiShareView>;
