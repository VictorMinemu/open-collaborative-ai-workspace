import { z } from "zod";
import { ModelRef } from "./ai-generation";
import { BoardColumnCategory } from "./board";
import { Id, IsoDateTime } from "./common";

/**
 * Automations (Phase 07.6, AUTO-01 … AUTO-03, PRD §73-75, D-01, D-02, D-07). An automation is a standing order: a bot,
 * instructions, a trigger (a schedule in an IANA zone, a signed webhook or a mailbox), a delivery target named by
 * stable ids, the person it runs as (always its creator, P-04), a daily budget and its runs. Leaf module: it imports
 * `common`, `board` (column categories) and `ai-generation` (the digest model) only, so `agent-channel.ts` can reuse its schedule and run
 * kinds without a cycle.
 *
 * Validation here is shape only: the cron's meaning, the minimum interval, caps and every permission are the API's.
 */

export const AUTOMATION_LIMITS = {
  nameMax: 120,
  instructionsMax: 4000,
  maxRunsPerDayDefault: 24,
  /** The schema's ceiling (one every 5 minutes); the organization cap (`bot_policies`, default 96) is the API's. */
  maxRunsPerDayCeiling: 288,
  runsPage: 30,
  webhookBodyMaxBytes: 65_536,
  webhookToleranceSeconds: 300,
  webhookPerMinute: 60,
  mailSourceMaxBytes: 262_144,
  mailTextMaxChars: 32_768,
  inboundCardChars: 500,
  inboundFullTextChars: 16_000,
  noReplyMinutes: 15,
  missedMaxHours: 6,
  breakerFailures: 3,
  secretGraceHours: 24,
  eventRetentionDays: 30,
  /** Characters of an RFC 6901 pointer and of a cron expression. */
  pointerMax: 200,
  cronMax: 100,
} as const;

// ---------------------------------------------------------------- closed vocabularies

export const AutomationTriggerKind = z.enum(["schedule", "webhook", "mail"]);
export type AutomationTriggerKind = z.infer<typeof AutomationTriggerKind>;

/** `digest` automations are created only by the digest module (one per user, P-14), never through this API. */
export const AutomationActionKind = z.enum(["agent_turn", "digest"]);
export type AutomationActionKind = z.infer<typeof AutomationActionKind>;

export const AutomationTargetKind = z.enum(["channel", "thread", "dm", "board"]);
export type AutomationTargetKind = z.infer<typeof AutomationTargetKind>;

export const AutomationStatus = z.enum(["active", "paused", "needs_attention"]);
export type AutomationStatus = z.infer<typeof AutomationStatus>;

export const AutomationRunStatus = z.enum([
  "queued",
  "delivered",
  "answered",
  "skipped",
  "failed",
  "no_reply",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;

/** What started a run: its trigger, or the owner's "Run now". */
export const AutomationRunTrigger = z.enum(["schedule", "webhook", "mail", "manual"]);
export type AutomationRunTrigger = z.infer<typeof AutomationRunTrigger>;

/** Why a run was skipped or failed (codes only; the UI words them). */
export const AutomationRunReason = z.enum([
  "agent_not_member",
  "target_not_postable",
  "agent_daily_limit",
  "runs_per_day",
  "hourly_cap",
  "agent_disabled",
  "run_as_not_allowed",
  "bot_not_readable",
  "missed",
  "paused",
  "no_reply",
  "delivery_failed",
]);
export type AutomationRunReason = z.infer<typeof AutomationRunReason>;

/** What the platform (never the model) does with an inbound item: a thread, a DM message or a board card (P-11). */
export const InboundAction = z.enum(["post", "board_card"]);
export type InboundAction = z.infer<typeof InboundAction>;

export const AutomationErrorCode = z.enum([
  "automation_cap",
  "schedule_too_frequent",
  "invalid_cron",
  "invalid_time_zone",
  "agent_not_member",
  "target_not_postable",
  "personal_bot_target",
  "agent_unavailable",
  "not_allowed",
  "webhook_not_allowed",
  "mailbox_host_not_allowed",
  "mailbox_key_not_usable",
  "version",
  "automation_inactive",
  "trigger_unavailable",
  "approval_not_found",
  "not_found",
]);
export type AutomationErrorCode = z.infer<typeof AutomationErrorCode>;

// ---------------------------------------------------------------- JSON pointers (RFC 6901)

const JSON_POINTER_RE = /^(?:\/(?:[^~/]|~[01])*)*$/;

/**
 * An RFC 6901 JSON pointer: `""` (the whole document) or `/a/b`, with only the `~0` and `~1` escapes. The only way an
 * inbound mapping or a watched field names a value: there is no template language (research anti-patterns).
 */
export const JsonPointer = z
  .string()
  .max(AUTOMATION_LIMITS.pointerMax)
  .regex(JSON_POINTER_RE, "must be an RFC 6901 JSON pointer");
export type JsonPointer = z.infer<typeof JsonPointer>;

const ARRAY_INDEX_RE = /^(?:0|[1-9][0-9]*)$/;

/**
 * The value `pointer` names in `value`, or `undefined` when it names nothing (or is not a pointer). Only own members
 * count (an inherited `constructor` or `__proto__` is not part of a JSON document); array tokens are canonical
 * indexes (`-` and leading zeros name nothing).
 */
export function resolveJsonPointer(value: unknown, pointer: string): unknown | undefined {
  if (pointer === "") return value;
  if (!JSON_POINTER_RE.test(pointer)) return undefined;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_RE.test(token)) return undefined;
      const index = Number(token);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, token)) return undefined;
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

// ---------------------------------------------------------------- schedules (P-07)

const CRON_FIELD_RE = /^(?:[0-9*,/-]|[A-Za-z]{3})+$/;

/**
 * Five whitespace-separated cron fields of the characters cron allows (digits, `*`, `,`, `-`, `/`, three-letter month
 * and day names). Its meaning and the minimum interval are decided by the API with the same code path as the preview.
 */
export const CronExpression = z
  .string()
  .max(AUTOMATION_LIMITS.cronMax)
  .trim()
  .refine(
    (cron) => {
      const fields = cron.split(/\s+/);
      return fields.length === 5 && fields.every((f) => CRON_FIELD_RE.test(f));
    },
    { message: "must be five cron fields" },
  );
export type CronExpression = z.infer<typeof CronExpression>;

let supportedZones: ReadonlySet<string> | null = null;

function knownZones(): ReadonlySet<string> {
  if (!supportedZones) {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    supportedZones = new Set([...list, "UTC"]);
  }
  return supportedZones;
}

/**
 * Whether `zone` is an IANA zone this runtime knows: in `Intl.supportedValuesOf("timeZone")` (plus `UTC`), or an alias
 * the engine resolves to one of them. The alias step matters: engines list one spelling of a renamed zone
 * (Node 24 lists `Asia/Calcutta`, not `Asia/Kolkata`) while browsers report the other, and both must save.
 */
export function isKnownTimeZone(zone: string): boolean {
  const zones = knownZones();
  if (zones.has(zone)) return true;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    // Without the list (older engines), accepting what the engine accepts is the best available check.
    return zones.size === 1 || zones.has(resolved);
  } catch {
    return false;
  }
}

/** An IANA zone name (never an offset): the automation's schedule is computed in it, DST included. */
export const AutomationTimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/, "must be an IANA time zone")
  .refine(isKnownTimeZone, { message: "unknown time zone" });
export type AutomationTimeZone = z.infer<typeof AutomationTimeZone>;

export const AutomationSchedule = z.object({ cron: CronExpression, timeZone: AutomationTimeZone });
export type AutomationSchedule = z.infer<typeof AutomationSchedule>;

// ---------------------------------------------------------------- targets (P-08, R2; stable ids only)

const ChannelTarget = z.object({ kind: z.literal("channel"), conversationId: Id });
const ThreadTarget = z.object({ kind: z.literal("thread"), conversationId: Id, threadRootMessageId: Id });
/** The run-as person's own DM with the bot (`ensureAgentDm`); the only target of a personal bot. */
const DmTarget = z.object({ kind: z.literal("dm") });
/** Each run creates a 07.1 board card "{name} · {date}" in this column and posts the run card as its first reply. */
const BoardTarget = z.object({ kind: z.literal("board"), conversationId: Id, columnId: Id });

export const AutomationTarget = z.discriminatedUnion("kind", [
  ChannelTarget,
  ThreadTarget,
  DmTarget,
  BoardTarget,
]);
export type AutomationTarget = z.infer<typeof AutomationTarget>;

const TargetLabel = { label: z.string().max(200) };

/** The response form of a target: the same ids plus a server-composed label ("#sales", "Your DM with Scout"). */
export const AutomationTargetView = z.discriminatedUnion("kind", [
  ChannelTarget.extend(TargetLabel),
  ThreadTarget.extend(TargetLabel),
  DmTarget.extend(TargetLabel),
  BoardTarget.extend(TargetLabel),
]);
export type AutomationTargetView = z.infer<typeof AutomationTargetView>;

// ---------------------------------------------------------------- inbound (P-11)

export const InboundConfig = z.object({
  titlePointer: JsonPointer.optional(),
  bodyPointer: JsonPointer.optional(),
  /** Follow-ups with the same key go to the same thread or card. */
  threadKeyPointer: JsonPointer.optional(),
});
export type InboundConfig = z.infer<typeof InboundConfig>;

export const AutomationInbound = z.object({
  action: InboundAction,
  /** "Ask {bot} to read it": a read-only, tainted turn after the platform posted the item (default on). */
  askBot: z.boolean().default(true),
  config: InboundConfig,
});
export type AutomationInbound = z.infer<typeof AutomationInbound>;

// ---------------------------------------------------------------- mailboxes (D-02, R8)

const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    "must be a host name",
  );

export const MailboxPollMinutes = z.union([
  z.literal(5),
  z.literal(10),
  z.literal(15),
  z.literal(30),
  z.literal(60),
]);
export type MailboxPollMinutes = z.infer<typeof MailboxPollMinutes>;

const mailboxConfigShape = {
  /** A Keychain `Username & password` item: the only credential a mailbox has (R8). */
  vaultItemId: Id,
  host: Hostname,
  port: z.number().int().min(1).max(65_535).default(993),
  folder: z.string().trim().min(1).max(200).default("INBOX"),
  pollIntervalMinutes: MailboxPollMinutes,
};

/**
 * A mailbox to poll (read-only). Strict: there is no username, password or token field, and a body that sends one is
 * refused rather than silently stripped (R8, T-07.6-01-04).
 */
export const MailboxConfigInput = z.strictObject(mailboxConfigShape);
export type MailboxConfigInput = z.infer<typeof MailboxConfigInput>;

export const MailboxStatus = z.enum(["active", "auth_failed", "unreachable", "paused"]);
export type MailboxStatus = z.infer<typeof MailboxStatus>;

export const Mailbox = z.object({
  ...mailboxConfigShape,
  /** The Keychain item's display name (never its username or secret). */
  vaultItemName: z.string().max(200),
  status: MailboxStatus,
  lastPolledAt: IsoDateTime.nullable(),
  lastNewCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().max(64).nullable(),
});
export type Mailbox = z.infer<typeof Mailbox>;

// ---------------------------------------------------------------- create / update (D-01, R3, R5)

const AutomationName = z.string().trim().min(1).max(AUTOMATION_LIMITS.nameMax);
/** The standing order of an `agent_turn` automation (plain text, never rendered as Markdown). */
const AutomationInstructions = z.string().trim().min(1).max(AUTOMATION_LIMITS.instructionsMax);
const MaxRunsPerDay = z.number().int().min(1).max(AUTOMATION_LIMITS.maxRunsPerDayCeiling);

export const AutomationTriggerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), schedule: AutomationSchedule }),
  /** The endpoint (URL + signing secret) is created by the save; the secret is in the create response once. */
  z.object({ kind: z.literal("webhook") }),
  z.object({ kind: z.literal("mail"), mailbox: MailboxConfigInput }),
]);
export type AutomationTriggerInput = z.infer<typeof AutomationTriggerInput>;

/** Webhook and mail triggers need an inbound rule; a schedule refuses one (`null` clears it on update). */
function checkInbound(
  trigger: AutomationTriggerInput | undefined,
  inbound: AutomationInbound | null | undefined,
  ctx: z.RefinementCtx,
  creating: boolean,
): void {
  if (!trigger) return;
  if (trigger.kind === "schedule" && inbound) {
    ctx.addIssue({ code: "custom", path: ["inbound"], message: "a schedule has no inbound rule" });
  }
  if (trigger.kind !== "schedule" && (inbound === null || (creating && inbound === undefined))) {
    ctx.addIssue({
      code: "custom",
      path: ["inbound"],
      message: "a webhook or mail trigger needs an inbound rule",
    });
  }
}

export const CreateAutomationRequest = z
  .object({
    name: AutomationName,
    agentId: Id,
    instructions: AutomationInstructions,
    trigger: AutomationTriggerInput,
    target: AutomationTarget,
    inbound: AutomationInbound.optional(),
    maxRunsPerDay: MaxRunsPerDay.default(AUTOMATION_LIMITS.maxRunsPerDayDefault),
    /** "Created with changes": the natural-language proposal this form was opened from (R5). */
    fromApprovalId: Id.optional(),
  })
  .superRefine((body, ctx) => checkInbound(body.trigger, body.inbound, ctx, true));
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequest>;

export const UpdateAutomationRequest = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: AutomationName.optional(),
    agentId: Id.optional(),
    instructions: AutomationInstructions.optional(),
    trigger: AutomationTriggerInput.optional(),
    target: AutomationTarget.optional(),
    inbound: AutomationInbound.nullable().optional(),
    maxRunsPerDay: MaxRunsPerDay.optional(),
  })
  .superRefine((body, ctx) => {
    const { expectedVersion: _version, ...changes } = body;
    if (Object.values(changes).every((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", message: "nothing to update" });
    }
    checkInbound(body.trigger, body.inbound, ctx, false);
  });
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequest>;

// ---------------------------------------------------------------- responses (D-01, R12, R13)

const PersonRef = z.object({ id: Id, displayName: z.string() });

/** Unguessable public id of a webhook URL (26 random base32 characters, 07.6-10). */
export const WebhookPublicId = z.string().regex(/^[0-9A-Za-z]{26}$/, "invalid webhook id");
export type WebhookPublicId = z.infer<typeof WebhookPublicId>;

/** A Standard Webhooks signing secret (`whsec_` + base64). Appears in a response once: on create and on rotate. */
export const WebhookSecret = z.string().regex(/^whsec_[A-Za-z0-9+/=]{32,120}$/, "invalid webhook secret");
export type WebhookSecret = z.infer<typeof WebhookSecret>;

export const AutomationViewerAction = z.enum(["edit", "run", "pause", "delete"]);
export type AutomationViewerAction = z.infer<typeof AutomationViewerAction>;

export const Automation = z.object({
  id: Id,
  name: z.string().max(AUTOMATION_LIMITS.nameMax),
  actionKind: AutomationActionKind,
  agent: z.object({ id: Id, displayName: z.string(), personal: z.boolean() }),
  /** Always the creator (P-04): the person whose permissions and budget every run uses. */
  runAs: PersonRef,
  /** Empty for a digest. */
  instructions: z.string().max(AUTOMATION_LIMITS.instructionsMax),
  trigger: z.object({
    kind: AutomationTriggerKind,
    schedule: AutomationSchedule.nullable(),
    webhook: z.object({ publicId: WebhookPublicId, url: z.string().max(2048) }).nullable(),
    mailbox: Mailbox.nullable(),
  }),
  target: AutomationTargetView,
  inbound: AutomationInbound.nullable(),
  maxRunsPerDay: z.number().int().positive(),
  status: AutomationStatus,
  pausedBy: PersonRef.nullable(),
  pausedAt: IsoDateTime.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  nextRunAt: IsoDateTime.nullable(),
  lastRun: z
    .object({ status: AutomationRunStatus, reason: AutomationRunReason.nullable(), at: IsoDateTime })
    .nullable(),
  inboundToday: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Decided by the API per viewer: a manager pauses and deletes, never edits, resumes or runs (P-04). */
  viewerCan: z.array(AutomationViewerAction),
});
export type Automation = z.infer<typeof Automation>;

export const CreateAutomationResponse = z.object({
  automation: Automation,
  /** A webhook trigger's signing secret, shown once (R3); never readable again. */
  webhookSecret: WebhookSecret.optional(),
});
export type CreateAutomationResponse = z.infer<typeof CreateAutomationResponse>;

/** `GET /automations?scope=`: `all` (everyone's) needs `automation.manage` (R12). */
export const AutomationListQuery = z.object({ scope: z.enum(["mine", "all"]).default("mine") });
export type AutomationListQuery = z.infer<typeof AutomationListQuery>;

export const AutomationList = z.object({
  automations: z.array(Automation),
  /** The caller's own automations against the organization cap. */
  usage: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  canManage: z.boolean(),
});
export type AutomationList = z.infer<typeof AutomationList>;

export const AutomationRun = z.object({
  id: Id,
  trigger: AutomationRunTrigger,
  status: AutomationRunStatus,
  reason: AutomationRunReason.nullable(),
  scheduledFor: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  answeredAt: IsoDateTime.nullable(),
  /** The turn started tainted (inbound content, D-02). */
  tainted: z.boolean(),
  /** The message the run was delivered under; null when it never posted. */
  anchor: z.object({ conversationId: Id, messageId: Id, threadRootId: Id }).nullable(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

export const AutomationRunListQuery = z.object({ before: Id.optional() });
export type AutomationRunListQuery = z.infer<typeof AutomationRunListQuery>;

export const AutomationRunList = z.object({
  runs: z.array(AutomationRun).max(AUTOMATION_LIMITS.runsPage),
  nextCursor: Id.nullable(),
});
export type AutomationRunList = z.infer<typeof AutomationRunList>;

/** `POST /automations/schedule-preview` (R13): the same code path as save. */
export const SchedulePreviewRequest = AutomationSchedule;
export type SchedulePreviewRequest = z.infer<typeof SchedulePreviewRequest>;

export const SchedulePreviewResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), next: z.array(IsoDateTime).min(1).max(3) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(["invalid_cron", "invalid_time_zone", "schedule_too_frequent"]),
    minMinutes: z.number().int().positive().optional(),
  }),
]);
export type SchedulePreviewResponse = z.infer<typeof SchedulePreviewResponse>;

// ---------------------------------------------------------------- digest schedule (P-14)

export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof Weekday>;

const CRON_DAY: Record<Weekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** `HH:MM`, 24-hour. */
export const ClockTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/, "must be HH:MM");
export type ClockTime = z.infer<typeof ClockTime>;

/**
 * The digest's cron, derived from its days and time (never typed by the person): `["mon","fri"], "08:30"` →
 * `"30 8 * * 1,5"`. Days are de-duplicated and listed in ascending cron order (Sunday is 0).
 */
export function digestCron(days: readonly Weekday[], time: string): string {
  if (!ClockTime.safeParse(time).success) throw new Error("digestCron: time must be HH:MM");
  if (days.length === 0) throw new Error("digestCron: at least one day");
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const dow = [...new Set(days.map((d) => CRON_DAY[Weekday.parse(d)]))].sort((a, b) => a - b);
  return `${minute} ${hour} * * ${dow.join(",")}`;
}

export const DigestSection = z.enum(["decisions", "follows", "mentions", "work_zone"]);
export type DigestSection = z.infer<typeof DigestSection>;

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/**
 * The person's digest (R6). The server derives the cron from `days` + `time` (`digestCron`) and computes it in
 * `timeZone` (the browser's, sent on save); sections are re-checked against the reader's access at send time.
 */
export const DigestSettings = z.object({
  enabled: z.boolean(),
  days: z.array(Weekday).min(1).max(7).refine(unique, { message: "days must be unique" }),
  time: ClockTime,
  timeZone: AutomationTimeZone,
  sections: z
    .array(DigestSection)
    .min(1)
    .max(DigestSection.options.length)
    .refine(unique, { message: "sections must be unique" }),
  skipEmpty: z.boolean().default(true),
  /** A bot the person can DM; their personal bot is preselected. */
  agentId: Id,
  /** The AI summary is opt-in and metered (usage kind `digest`); null model = the organization's default. */
  summary: z
    .object({ enabled: z.boolean().default(false), modelRef: ModelRef.nullable().default(null) })
    .default({ enabled: false, modelRef: null }),
});
export type DigestSettings = z.infer<typeof DigestSettings>;

const DigestBot = z.object({
  id: Id,
  displayName: z.string(),
  personal: z.boolean(),
  unitName: z.string().nullable(),
});

/** `GET /digest`: the caller's own digest (none yet = `settings: null`). */
export const DigestView = z.object({
  settings: DigestSettings.nullable(),
  automationId: Id.nullable(),
  nextRunAt: IsoDateTime.nullable(),
  lastSentAt: IsoDateTime.nullable(),
  bots: z.array(DigestBot),
});
export type DigestView = z.infer<typeof DigestView>;

/** `POST /digest/preview`: unsaved settings in, the exact Markdown the bot would send now out. */
export const DigestPreviewRequest = DigestSettings;
export type DigestPreviewRequest = z.infer<typeof DigestPreviewRequest>;

export const DigestPreview = z.object({
  markdown: z.string().max(AUTOMATION_LIMITS.mailTextMaxChars),
  empty: z.boolean(),
});
export type DigestPreview = z.infer<typeof DigestPreview>;

/** `POST /digest/test`: where the test digest was posted (the person's DM with the chosen bot). */
export const DigestTestResponse = z.object({ conversationId: Id, messageId: Id });
export type DigestTestResponse = z.infer<typeof DigestTestResponse>;

// ---------------------------------------------------------------- webhook endpoints (D-02, R3, R4)

export const WebhookRejectReason = z.enum(["signature", "timestamp", "too_large", "rate_limited"]);
export type WebhookRejectReason = z.infer<typeof WebhookRejectReason>;

/** One accepted or duplicate event (`automation_events`); rejected requests leave no row, only the endpoint's line. */
export const WebhookDelivery = z.object({
  id: Id,
  receivedAt: IsoDateTime,
  result: z.enum(["accepted", "duplicate", "not_run"]),
  /** Why an accepted event did not run (an `AutomationRunReason` or an inbound code). */
  reason: z.string().max(64).nullable(),
  duplicateCount: z.number().int().nonnegative(),
  link: z
    .object({
      conversationId: Id,
      messageId: Id,
      threadRootId: Id.nullable(),
      cardNumber: z.string().max(32).nullable(),
    })
    .nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

/** `GET /automations/:id/webhook`: never the secret (it is shown once, on create and on rotate). */
export const WebhookEndpoint = z.object({
  publicId: WebhookPublicId,
  url: z.string().max(2048),
  secretSetAt: IsoDateTime,
  /** The previous secret still verifies until then (24 h after a rotation). */
  previousValidUntil: IsoDateTime.nullable(),
  lastRejectedAt: IsoDateTime.nullable(),
  lastRejectedReason: WebhookRejectReason.nullable(),
  deliveries: z.array(WebhookDelivery).max(10),
  /** The latest accepted payload (parsed JSON), to pick pointers from; untrusted, rendered as text only. */
  lastPayload: z.unknown().nullable(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

export const RotateWebhookSecretResponse = z.object({
  secret: WebhookSecret,
  previousValidUntil: IsoDateTime,
});
export type RotateWebhookSecretResponse = z.infer<typeof RotateWebhookSecretResponse>;

// ---------------------------------------------------------------- mailbox test (R8)

/** `POST /mailboxes/test`: try the connection without saving (strict like the config: no credential field). */
export const MailboxTestRequest = MailboxConfigInput.omit({ pollIntervalMinutes: true });
export type MailboxTestRequest = z.infer<typeof MailboxTestRequest>;

export const MailboxTestResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), messages: z.number().int().nonnegative() }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      "auth_failed",
      "unreachable",
      "host_not_allowed",
      "folder_missing",
      "certificate",
      "unknown",
    ]),
  }),
]);
export type MailboxTestResult = z.infer<typeof MailboxTestResult>;

// ---------------------------------------------------------------- editor options (R12, R13)

/** `GET /automations/options`: what the caller may create, with which bots, within which caps. */
export const AutomationOptions = z.object({
  canCreate: z.boolean(),
  canWebhook: z.boolean(),
  bots: z.array(
    z.object({
      id: Id,
      displayName: z.string(),
      personal: z.boolean(),
      unitName: z.string().nullable(),
      /** The bot's cell is configured and running (a run would be delivered). */
      ready: z.boolean(),
    }),
  ),
  caps: z.object({
    maxAutomationsPerUser: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    minScheduleMinutes: z.number().int().positive(),
    maxInboundPerHour: z.number().int().nonnegative(),
    maxRunsPerDayCap: z.number().int().positive(),
  }),
  /** Per bot id: its daily turn limit, null when unlimited. */
  botDailyLimit: z.record(Id, z.number().int().nonnegative().nullable()),
});
export type AutomationOptions = z.infer<typeof AutomationOptions>;

export const AutomationTargetOptionsQuery = z.object({ agentId: Id });
export type AutomationTargetOptionsQuery = z.infer<typeof AutomationTargetOptionsQuery>;

export const AutomationTargetOptions = z.object({
  conversations: z.array(
    z.object({
      conversationId: Id,
      name: z.string(),
      layout: z.enum(["text", "board"]),
      disabledReason: z.enum(["agent_not_member", "target_not_postable"]).nullable(),
      columns: z.array(z.object({ id: Id, name: z.string(), category: BoardColumnCategory })),
    }),
  ),
});
export type AutomationTargetOptions = z.infer<typeof AutomationTargetOptions>;

// ---------------------------------------------------------------- realtime (ids only, on `user:<runAs>`)

/** `automation.updated` on `user:<runAs>` (and managers' lists refetch). */
export const AutomationUpdatedEvent = z.strictObject({ automationId: Id });
export type AutomationUpdatedEvent = z.infer<typeof AutomationUpdatedEvent>;

/** `automation_run.updated` on `user:<runAs>` for every run status change. */
export const AutomationRunUpdatedEvent = z.strictObject({ automationId: Id, runId: Id });
export type AutomationRunUpdatedEvent = z.infer<typeof AutomationRunUpdatedEvent>;
