import { z } from "zod";
import { Id, IsoDateTime, RelativePath } from "./common";
import { DiffFileStatus } from "./device-link";
import { PermissionMode, RuntimeId, WorkSessionStatus } from "./session-events";
import { ContextWindow, EffortLevel } from "./session-settings";
import { PromptStatus } from "./work-session";

/**
 * Bot Work Zone orchestration (Phase 07.16, D-05, D-07, BWZ-01…BWZ-05): the vocabulary a bot with a Work Zone profile
 * uses to start, prompt, read and stop sessions, and what the settings and the live card share with the API.
 *
 * Principle 7: ids and bounded data only. No schema here carries an absolute host path, a device token, a URL outside
 * the app's own routes or a prompt written by a person other than the bot. The bot never names a device, a user, an
 * audience or a worktree: the device, the runtime and the sponsor come from the stored profile, the audience is
 * decided server-side (PD-09, PD-11). Imports only leaf contracts: `bot-capabilities` and `agent-channel` import this
 * file, never the other way round.
 */

// ---------------------------------------------------------------- limits (A-06 defaults, PD-22)

export const BOT_WORK_ZONE_LIMITS = {
  /** Projects one profile may list. */
  projectsMax: 50,
  /** Projects one turn's offer lists (the rest are counted in `projectsMore`). */
  turnProjects: 20,
  /** Allowed models, efforts or context windows per profile. */
  allowedValuesMax: 20,
  maxConcurrentDefault: 2,
  maxConcurrentMax: 10,
  promptsPerHourDefault: 30,
  promptsPerHourMax: 120,
  wakesPerSessionDayDefault: 20,
  wakesPerSessionDayMax: 100,
  /** Active bot sessions per organization (0 = bots never start sessions). */
  orgSessionsDefault: 10,
  orgSessionsMax: 1000,
  /** The same bound as a person's prompt (`WORK_ZONE_PROPOSAL_LIMITS.promptChars`). */
  promptChars: 50_000,
  /** Characters of runtime output one read returns, the tail kept. */
  readOutputChars: 6_000,
  readTools: 10,
  readFiles: 50,
  readApprovals: 10,
  readApprovalPaths: 10,
  /** The bot's own prompts listed in a read. */
  readMine: 20,
  /** People named as able to decide a session's approvals (D-10). */
  deciders: 3,
  summaryChars: 500,
  errorChars: 500,
  toolSummaryChars: 200,
  /** The bot's sessions listed on one turn. */
  turnSessions: 10,
} as const;

/** `off`: never; `allowed`: the bot may turn fast mode on; `on`: on by default. */
export const BotFastMode = z.enum(["off", "allowed", "on"]);
export type BotFastMode = z.infer<typeof BotFastMode>;

const Name = z.string().max(200);

// ---------------------------------------------------------------- the turn's offer (PD-17)

/**
 * `TurnContext.workZone`: what this bot may do in the Work Zone on this turn, computed by the API from the bot's active
 * profile and the sponsor's live controls. Names and ids only; the device is the profile's, shown so the bot can tell
 * the person when it is offline.
 */
export const TurnWorkZone = z.object({
  runtime: RuntimeId,
  device: z.object({ id: Id, name: z.string().max(120), online: z.boolean() }),
  projects: z.array(z.object({ id: Id, name: Name })).max(BOT_WORK_ZONE_LIMITS.turnProjects),
  /** Startable profile projects not listed because of the cap. */
  projectsMore: z.number().int().nonnegative(),
  models: z.array(Name).max(BOT_WORK_ZONE_LIMITS.allowedValuesMax),
  defaultModel: Name.nullable(),
  efforts: z.array(EffortLevel).max(10),
  fastMode: BotFastMode,
  defaultMode: PermissionMode,
  /** The highest mode the bot may ask for here (already lowered after outside content off an isolated server). */
  maxMode: PermissionMode,
  /** The profile lets the bot start and prompt after outside content (D-08). */
  outsideContent: z.boolean(),
  /** The bot's own active sessions, newest first. */
  sessions: z
    .array(z.object({ id: Id, status: WorkSessionStatus, projectName: Name }))
    .max(BOT_WORK_ZONE_LIMITS.turnSessions),
});
export type TurnWorkZone = z.infer<typeof TurnWorkZone>;

// ---------------------------------------------------------------- tool bodies (PD-09)

const BotPrompt = z.string().trim().min(1).max(BOT_WORK_ZONE_LIMITS.promptChars);

/**
 * `POST /agent-channel/v1/work-sessions/start` (`ocw_work_session_start`). Strict: no device, user, visibility,
 * worktree or audience key can be expressed. Absent options = the profile's defaults; a value asked must be in the
 * profile's set and in the device's catalog.
 */
export const AgentChannelWorkSessionStart = z.strictObject({
  eventId: Id,
  agentId: Id,
  projectId: Id,
  prompt: BotPrompt,
  model: z.string().trim().min(1).max(200).optional(),
  effort: EffortLevel.optional(),
  fastMode: z.boolean().optional(),
  contextWindow: ContextWindow.optional(),
  permissionMode: PermissionMode.optional(),
});
export type AgentChannelWorkSessionStart = z.infer<typeof AgentChannelWorkSessionStart>;

/**
 * `POST /work-sessions/prompt` (`ocw_work_session_prompt`): one more prompt to a session this bot started (PD-13), with
 * the start's bounds. The queue position and the executor are the session's (one executor, the existing arbiter).
 */
export const AgentChannelWorkSessionPrompt = z.strictObject({
  eventId: Id,
  agentId: Id,
  workSessionId: Id,
  prompt: BotPrompt,
});
export type AgentChannelWorkSessionPrompt = z.infer<typeof AgentChannelWorkSessionPrompt>;

/** `POST /work-sessions/read` (`ocw_work_session_read`): output after `cursor` (a stream seq; absent = from the start). */
export const AgentChannelWorkSessionRead = z.strictObject({
  eventId: Id,
  agentId: Id,
  workSessionId: Id,
  cursor: z.number().int().nonnegative().optional(),
});
export type AgentChannelWorkSessionRead = z.infer<typeof AgentChannelWorkSessionRead>;

/** `POST /work-sessions/stop` (`ocw_work_session_stop`): archives a session this bot started (PD-13). */
export const AgentChannelWorkSessionStop = z.strictObject({
  eventId: Id,
  agentId: Id,
  workSessionId: Id,
});
export type AgentChannelWorkSessionStop = z.infer<typeof AgentChannelWorkSessionStop>;

// ---------------------------------------------------------------- refusals (D-05, D-08)

/** Why a Work Zone tool call was refused. A closed set; each code has one fixed sentence. */
export const BotWorkSessionRefusal = z.enum([
  "not_in_turn",
  "cap_reached",
  "profile_inactive",
  "project_not_allowed",
  "setting_not_allowed",
  "mode_not_allowed",
  "prompt_not_allowed",
  "too_many_sessions",
  "org_limit",
  "prompt_rate",
  "tree_busy",
  "device_offline",
  "runtime_unavailable",
  "outside_content",
  "outside_content_bypass",
  "session_output",
  "not_your_session",
  "session_ended",
  "not_allowed",
]);
export type BotWorkSessionRefusal = z.infer<typeof BotWorkSessionRefusal>;

/** The sentence the model reads for each refusal: fixed text, never runtime or provider text. */
export const BOT_WORK_SESSION_SENTENCES: Readonly<Record<BotWorkSessionRefusal, string>> = {
  not_in_turn: "Work Zone sessions are not available on this turn.",
  cap_reached: "This turn has used all its tool calls. Ask the person to send the request again.",
  profile_inactive:
    "This bot can't run Work Zone sessions right now. Ask whoever manages it to check its Work Zone profile.",
  project_not_allowed:
    "That project is not in this bot's Work Zone profile. Use one of the projects listed for this turn.",
  setting_not_allowed:
    "That model or option is not allowed by this bot's Work Zone profile. Use the defaults or one of the listed values.",
  mode_not_allowed: "That permission mode is above what this bot's Work Zone profile allows here.",
  prompt_not_allowed: "Slash commands can't be sent as prompts. Describe the work in words.",
  too_many_sessions:
    "This bot already runs as many Work Zone sessions as its profile allows. Stop one or wait for one to finish.",
  org_limit: "The organization's limit of bot Work Zone sessions is reached. Try again when one finishes.",
  prompt_rate: "This bot has sent as many prompts this hour as its profile allows. Try again later.",
  tree_busy: "Another session is already working on that project's files. Wait for it to finish.",
  device_offline:
    "The bot's Work Zone device is offline. Tell the person; the session can start when the device is back.",
  runtime_unavailable: "The runtime this bot uses is not available on its device right now.",
  outside_content:
    "This turn read outside content, so the bot can't start or prompt a session on its own. A person must review it.",
  outside_content_bypass:
    "After outside content, Full access runs only on an isolated server. Use a lower mode.",
  session_output:
    "This turn read a session's output, so it can't start another session. Ask the person to send the request again.",
  not_your_session: "This bot can only control Work Zone sessions it started.",
  session_ended: "That session has ended.",
  not_allowed: "The bot's sponsor is not allowed to do this in the Work Zone any more.",
};

/** The sentence of a `proposed` start answer (D-08, PD-15). */
export const BOT_WORK_SESSION_PROPOSED_SENTENCE =
  "The bot proposed the session instead: a person must review the prompt and press Start.";

/** Why a bot's profile is inactive (PD-05, in the order `profileStatus` decides). */
export const BotProfileInactiveReason = z.enum([
  "bot_disabled",
  "no_consent",
  "device_revoked",
  "sponsor_inactive",
  "sponsor_not_allowed",
  "sponsor_device_access",
  "no_projects",
  "org_disabled",
]);
export type BotProfileInactiveReason = z.infer<typeof BotProfileInactiveReason>;

/** A refused Work Zone call: the code, its fixed sentence, and the inactive reason or the setting at fault. */
export const BotWorkSessionRefused = z.object({
  kind: z.literal("refused"),
  code: BotWorkSessionRefusal,
  sentence: z.string().max(300),
  reason: BotProfileInactiveReason.optional(),
  field: z.enum(["model", "effort", "contextWindow", "fastMode", "permissionMode"]).optional(),
});
export type BotWorkSessionRefused = z.infer<typeof BotWorkSessionRefused>;

// ---------------------------------------------------------------- answers

/**
 * The start answer: `started` (the session exists, its live card was posted; `model` and `mode` are the effective
 * values), `proposed` (outside content without the profile's flag: a proposal card a person starts, D-08) or refused.
 */
export const AgentChannelWorkSessionStartResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    workSessionId: Id,
    status: WorkSessionStatus,
    cardMessageId: Id.nullable(),
    model: Name.nullable(),
    mode: PermissionMode,
    projectName: Name,
  }),
  z.object({
    kind: z.literal("proposed"),
    approvalId: Id,
    reason: z.literal("outside_content"),
    sentence: z.string().max(300),
  }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionStartResponse = z.infer<typeof AgentChannelWorkSessionStartResponse>;

export const AgentChannelWorkSessionPromptResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("queued"),
    workSessionId: Id,
    promptId: Id,
    position: z.number().int(),
    status: PromptStatus,
  }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionPromptResponse = z.infer<typeof AgentChannelWorkSessionPromptResponse>;

export const AgentChannelWorkSessionStopResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stopped"), workSessionId: Id }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionStopResponse = z.infer<typeof AgentChannelWorkSessionStopResponse>;

// ---------------------------------------------------------------- the redacted read model (PD-14, D-10)

/** A person the resolver allows to decide the session's approvals (D-10): the bot names them, it never decides. */
export const WorkSessionDecider = z.object({
  id: Id,
  handle: z.string().max(64),
  displayName: Name,
});
export type WorkSessionDecider = z.infer<typeof WorkSessionDecider>;

const Count = z.number().int().nonnegative();
const ToolName = z.string().max(100);
const ToolSummary = z.string().max(BOT_WORK_ZONE_LIMITS.toolSummaryChars);

/**
 * What `ocw_work_session_read` returns: bounded, repo-relative data only. The device's `contain()`/`redact()` ran before
 * upload; the API re-filters every path with `onlyRelativePaths`, passes every text through `redactSecrets`, and cuts
 * the output to its last `readOutputChars` characters (`truncated`). Never a human's prompt text (only the bot's own
 * prompts are listed, by id). The output is the runtime's work product: untrusted data the plugin wraps as such, and a
 * read marks the turn (`session_output_read`, D-20).
 */
export const BotWorkSessionReadModel = z.object({
  session: z.object({
    id: Id,
    status: WorkSessionStatus,
    runtime: RuntimeId,
    model: Name.nullable(),
    mode: PermissionMode,
    worktree: z.boolean(),
    title: Name,
    projectName: Name,
    updatedAt: IsoDateTime,
  }),
  queue: z.object({
    queued: Count,
    running: Count,
    completed: Count,
    failed: Count,
    cancelled: Count,
    /** The bot's own prompts, never a person's. */
    mine: z
      .array(z.object({ id: Id, status: PromptStatus, position: z.number().int() }))
      .max(BOT_WORK_ZONE_LIMITS.readMine),
  }),
  /** The `assistant.message` texts after the cursor, newest last. */
  output: z
    .object({
      texts: z.array(z.object({ seq: Count, text: z.string() })).max(50),
      truncated: z.boolean(),
    })
    .refine((o) => o.texts.reduce((n, t) => n + t.text.length, 0) <= BOT_WORK_ZONE_LIMITS.readOutputChars, {
      message: "output over the read budget",
      path: ["texts"],
    }),
  /** The latest tool uses: names and short summaries, never their output. */
  tools: z
    .array(z.object({ name: ToolName, ok: z.boolean().nullable(), summary: ToolSummary }))
    .max(BOT_WORK_ZONE_LIMITS.readTools),
  changes: z
    .object({
      files: z
        .array(
          z.object({
            path: RelativePath,
            status: DiffFileStatus,
            additions: Count,
            deletions: Count,
          }),
        )
        .max(BOT_WORK_ZONE_LIMITS.readFiles),
      branch: Name.nullable(),
      truncated: z.boolean(),
    })
    .nullable(),
  /** Pending runtime approvals; the bot cannot decide them (P3), it names the deciders. */
  approvals: z
    .array(
      z.object({
        id: Id,
        tool: ToolName,
        paths: z.array(RelativePath).max(BOT_WORK_ZONE_LIMITS.readApprovalPaths),
        summary: ToolSummary,
      }),
    )
    .max(BOT_WORK_ZONE_LIMITS.readApprovals),
  deciders: z.array(WorkSessionDecider).max(BOT_WORK_ZONE_LIMITS.deciders),
  error: z.string().max(BOT_WORK_ZONE_LIMITS.errorChars).nullable(),
  /** The snapshot's last seq: the next read's `cursor`. */
  cursor: Count,
});
export type BotWorkSessionReadModel = z.infer<typeof BotWorkSessionReadModel>;

export const AgentChannelWorkSessionReadResponse = z.discriminatedUnion("kind", [
  BotWorkSessionReadModel.extend({ kind: z.literal("read") }),
  BotWorkSessionRefused,
]);
export type AgentChannelWorkSessionReadResponse = z.infer<typeof AgentChannelWorkSessionReadResponse>;
