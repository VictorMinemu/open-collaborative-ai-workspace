import {
  type AgentChannelWorkSessionPromptResponse,
  type AgentChannelWorkSessionStart,
  type AgentChannelWorkSessionStartResponse,
  type AgentChannelWorkSessionStopResponse,
  BOT_PROFILE_STATUS_SENTENCES,
  BOT_WORK_SESSION_SENTENCES,
  BOT_WORK_ZONE_LIMITS,
  type BotProfileInactiveReason,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  BUILTIN_TOOLS,
  type ContextWindow,
  PERMISSION_MODE_RANK,
  PermissionMode,
  type SessionAudienceInput,
  WORK_PROJECT_LIMITS,
} from "@ocw/contracts";
import {
  type agentTurns,
  botWorkSessions,
  messages,
  orgMembers,
  projects,
  type Tx,
  workSessions,
} from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
import { composeWorkSessionCard } from "./bot-card";
import type { BotProfileRow, BotProfileStatus } from "./bot-profile";
import { archiveWorkSession, submitWorkPrompt, type WorkSessionControllerDeps } from "./controller";
import { sessionFacts } from "./facts";
import { loadWorkZonePolicy } from "./policy";
import type { WorkSessionStartFn } from "./proposals";
import { ACTIVE_STATES, type SessionRow } from "./service";
import type { WorkSessionStartFailure, WorkSessionStartInput } from "./start";
import { audienceTarget, checkAudience } from "./visibility";

/**
 * Phase 07.16 (D-05 … D-07, D-12, D-14, D-15; PD-03, PD-09 … PD-12, PD-21): a bot starts a Work Zone session itself, in
 * its sponsor's name. The ONLY server path of a bot's start, and it always goes through `createWorkSession` (no second
 * start path, no copied check): the sponsor is the actor, the bot's caps are the agent layer of the one controls
 * context, and the start options come from the profile. Called inside the sponsor's tenant transaction (PD-03), after
 * the Agent Channel route found the live turn, checked the tool on it, decided the profile's status and claimed the
 * call. What it adds around the start:
 *
 * - The device, runtime and worktree are the profile's (the worktree only where the device did not say the project is
 *   outside git, quick 261113-hu7); model and options absent = the profile's defaults (PD-09).
 * - The audience is decided here from existing kinds only (PD-11, `botSessionAudience`), never by the bot.
 * - One `bot_work_sessions` row (origin, requester, card) and one platform-owned `work_zone` card in the asker's thread
 *   (PD-12), then `bot.work_session_started` with ids, the mode, the model and the prompt's length only (PD-21).
 *
 * `ownBotSession` is the one ownership rule (PD-13) the prompt, stop and read routes use.
 *
 * 07.16-16 (D-05 … D-07, PD-13): `prompt` and `stop` keep the bot orchestrating the session it started, through the
 * bodies people use (`submitWorkPrompt`, `archiveWorkSession`; no copied check). A prompt is queued in the sponsor's
 * name with the bot as its agent author, so every reader, the arbiter (the bot's caps per turn) and the audit keep
 * working; a stop archives the session and marks `bot_work_sessions.stopped_by_agent` (no wake for the bot's own stop).
 * `interrupt` is not exposed to bots (PD-13), and nothing here resolves a runtime approval (P3).
 */

type AgentTurnRow = typeof agentTurns.$inferSelect;
export type BotWorkSessionRow = typeof botWorkSessions.$inferSelect;
type ActiveStatus = Extract<BotProfileStatus, { active: true }>;

/** Who reads the origin conversation: a bounded set of people, or unbounded (a public channel's every reader). */
export interface ConversationReaders {
  userIds: string[];
  unbounded: boolean;
}

export interface BotSessionsDeps {
  core: Pick<Core, "audit" | "chatAgent">;
  /** `createWorkSession` with its dependencies bound (the module's `start`). */
  start: WorkSessionStartFn;
  /** The prompt and archive bodies people use (07.16-10), for the bot's follow-up prompts and its stop. */
  controller: WorkSessionControllerDeps;
}

export interface BotStartParams {
  turn: AgentTurnRow;
  profile: BotProfileRow;
  status: ActiveStatus;
  input: AgentChannelWorkSessionStart;
  readers: ConversationReaders;
  /** Whether a member reads the origin conversation (the chat module's `isReadable`). */
  isReadable: (userId: string) => Promise<boolean>;
  /** The audit base of the cell's call (`clientKind`, `sessionId`), for the refusal rows. */
  auditBase: { clientKind: string; sessionId: string };
}

export interface BotPromptParams {
  turn: AgentTurnRow;
  /** The bot's profile, active (the route decided its status); its sponsor is the prompt's author. */
  profile: BotProfileRow;
  workSessionId: string;
  prompt: string;
  /** D-08: written by a turn that read outside content (07.16-19's flag path); marked in the session's history. */
  tainted: boolean;
}

export interface BotStopParams {
  turn: AgentTurnRow;
  workSessionId: string;
}

export interface BotSessions {
  start(tx: Tx, p: BotStartParams): Promise<AgentChannelWorkSessionStartResponse>;
  /**
   * A follow-up prompt to the bot's own session, in the sponsor's tenant transaction: `not_your_session`,
   * `session_ended`, `not_allowed` (the sponsor may no longer prompt it), `prompt_rate` (E2), `prompt_not_allowed`
   * (a slash command), else `queued` through `submitWorkPrompt`.
   */
  prompt(tx: Tx, p: BotPromptParams): Promise<AgentChannelWorkSessionPromptResponse>;
  /**
   * Stop the bot's own session, in its sponsor's tenant transaction: `not_your_session`, `session_ended`, else
   * `stopped` through `archiveWorkSession` (`byAgentId`). Allowed with an inactive profile and on a tainted turn: a bot
   * may always end its own session (PD-13, PD-15).
   */
  stop(tx: Tx, p: BotStopParams): Promise<AgentChannelWorkSessionStopResponse>;
}

/** The refused answer for `code`: its fixed sentence (never runtime text), the inactive reason or the setting. */
export function refusedAnswer(
  code: BotWorkSessionRefusal,
  extra: { reason?: BotProfileInactiveReason; field?: BotWorkSessionRefused["field"] } = {},
): BotWorkSessionRefused {
  const sentence =
    code === "profile_inactive" && extra.reason
      ? `${BOT_WORK_SESSION_SENTENCES.profile_inactive} ${BOT_PROFILE_STATUS_SENTENCES[extra.reason]}`
      : BOT_WORK_SESSION_SENTENCES[code];
  return {
    kind: "refused",
    code,
    sentence: sentence.slice(0, 300),
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.field ? { field: extra.field } : {}),
  };
}

/** The audit actions of a bot's Work Zone tools (PD-21): one per success, one for every refusal. */
export type BotWorkSessionAuditAction =
  | "bot.work_session_started"
  | "bot.work_session_proposed"
  | "bot.work_session_prompted"
  | "bot.work_session_stopped"
  | "bot.work_session_upload"
  | "bot.work_session_download"
  | "bot.work_session_refused";

/**
 * The one audit builder of the bot's Work Zone routes (PD-21, D-14): the bot is the actor, the asker the user; ids,
 * the mode, the model, the outcome and the prompt's length only. Never the prompt, a title, a name or a path. A
 * success names the session as its resource and audit session; a refusal names the bot and the tool it refused.
 * 07.16-19 (D-08, PD-15): every row of a turn that read outside content says `outsideContent: true`, whatever the
 * outcome; a start that became a proposal (`bot.work_session_proposed`) names the approval, a refused fallback the
 * proposal's own refusal code (`proposalRefusal`).
 * 07.17.1.1 (D-05, PD-16): a file move (`bot.work_session_upload|download`, or its refusal) adds the attachment's id,
 * the bytes, their sha256, the direction and the path's length in characters. Never the path or a file name.
 */
export async function auditBotWorkSession(
  tx: Tx,
  core: Pick<Core, "audit">,
  p: {
    action: BotWorkSessionAuditAction;
    turn: AgentTurnRow;
    auditBase: { clientKind: string; sessionId: string };
    outcome:
      | "started"
      | "proposed"
      | "prompted"
      | "stopped"
      | "uploaded"
      | "downloaded"
      | BotWorkSessionRefusal;
    /** The tool refused (refusals only: a success is told apart by its action). */
    tool?: string;
    sponsorUserId: string | null;
    projectId: string | null;
    deviceId: string | null;
    workSessionId?: string;
    mode?: PermissionMode | null;
    model?: string | null;
    promptChars?: number;
    reason?: string;
    field?: string;
    /** The proposal a tainted start became (`bot.work_session_proposed`). */
    approvalId?: string;
    /** Why that proposal could not be made (a `WorkZoneProposalRefusal` code). */
    proposalRefusal?: string;
    /** 07.17.1.1: the attachment moved (the chat file uploaded, or the one a download created). */
    attachmentId?: string | null;
    /** 07.17.1.1: the bytes moved (or the size refused by `file_too_large`). */
    bytes?: number | null;
    /** 07.17.1.1: the lowercase hex sha256 of the bytes moved. */
    sha256?: string | null;
    /** 07.17.1.1: `to_device` (upload) or `from_device` (download). */
    direction?: "to_device" | "from_device";
    /** 07.17.1.1: the repo-relative path's length in characters; the path itself is never recorded (P1). */
    pathLength?: number;
    /** 07.17.1.1: whose per-file limit applied (`file_too_large`). */
    limitSource?: "bot" | "organization" | "server";
  },
): Promise<void> {
  const ok = p.action !== "bot.work_session_refused";
  const onSession = ok && p.workSessionId !== undefined;
  await core.audit.record(tx, {
    clientKind: p.auditBase.clientKind,
    sessionId: onSession && p.workSessionId ? p.workSessionId : p.auditBase.sessionId,
    action: p.action,
    actorKind: "agent",
    actorId: p.turn.agentId,
    agentId: p.turn.agentId,
    userId: p.turn.userId,
    deviceId: p.deviceId,
    resourceType: onSession ? "work_session" : "agent",
    resourceId: onSession && p.workSessionId ? p.workSessionId : p.turn.agentId,
    result: ok ? "success" : "denied",
    metadata: {
      eventId: p.turn.eventId,
      ...(!ok && p.tool ? { tool: p.tool } : {}),
      sponsorUserId: p.sponsorUserId,
      ...(p.projectId ? { projectId: p.projectId } : {}),
      ...(p.workSessionId ? { workSessionId: p.workSessionId } : {}),
      ...(p.mode ? { mode: p.mode } : {}),
      ...(p.model !== undefined && p.model !== null ? { model: p.model } : {}),
      outcome: p.outcome,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.field ? { field: p.field } : {}),
      ...(p.promptChars !== undefined ? { promptChars: p.promptChars } : {}),
      ...(p.turn.tainted ? { outsideContent: true } : {}),
      ...(p.approvalId ? { approvalId: p.approvalId } : {}),
      ...(p.proposalRefusal ? { proposalRefusal: p.proposalRefusal } : {}),
      ...(p.attachmentId ? { attachmentId: p.attachmentId } : {}),
      ...(p.bytes !== undefined && p.bytes !== null ? { bytes: p.bytes } : {}),
      ...(p.sha256 ? { sha256: p.sha256 } : {}),
      ...(p.direction ? { direction: p.direction } : {}),
      ...(p.pathLength !== undefined ? { pathLength: p.pathLength } : {}),
      ...(p.limitSource ? { limitSource: p.limitSource } : {}),
    },
  });
}

// ---------------------------------------------------------------- audience (PD-11)

/** The active members of the tenant. */
async function activeMembers(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(isNull(orgMembers.deactivatedAt));
  return rows.map((r) => r.userId);
}

/**
 * P: the members with access to the project. A team project's people by the one SQL rule (`app.work_project_people`,
 * leads, members and assigned teams; an admin is not a viewer for being one); a personal repository's, the members who
 * may use the device, exactly as `checkAudience` accepts them (the draft's `viewer` relation), plus the sponsor, who
 * may use it (the profile is active).
 */
async function projectPeople(tx: Tx, projectId: string, sponsorUserId: string): Promise<string[] | null> {
  const target = await audienceTarget(tx, projectId);
  if (!target) return null;
  if (target.unit) {
    const res = await tx.execute(
      sql`select user_id::text as user_id from app.work_project_people(${target.unit.id}::uuid)`,
    );
    return (res.rows as Array<{ user_id: string }>).map((r) => r.user_id);
  }
  const members = await activeMembers(tx);
  const refused = await checkAudience(tx, target, { kind: "people", userIds: members }, sponsorUserId);
  const outside = new Set(refused?.ids ?? []);
  return members.filter((id) => id === sponsorUserId || !outside.has(id));
}

/**
 * PD-11 (D-07): who sees a bot's session, decided server-side from existing kinds only. R = the origin conversation's
 * readers, P = the project's people. P ⊆ R with R unbounded → `project`; else S = (R ∩ P) \ {sponsor}: up to 100 →
 * `people` S; more → `people` [requester] when the requester is in P, else `owner`; S empty → `owner`. The sponsor
 * (creator) and the
 * device's owner always see it through their own relations. A later change of the conversation's members does not
 * change a `people` snapshot (ADR-0038).
 */
export async function botSessionAudience(
  tx: Tx,
  p: {
    projectId: string;
    sponsorUserId: string;
    requesterUserId: string;
    readers: ConversationReaders;
    isReadable: (userId: string) => Promise<boolean>;
  },
): Promise<SessionAudienceInput> {
  const people = await projectPeople(tx, p.projectId, p.sponsorUserId);
  if (!people || people.length === 0) return { kind: "owner" };
  const bounded = new Set(p.readers.userIds);
  const reading: string[] = [];
  for (const id of people) {
    if (p.readers.unbounded ? await p.isReadable(id) : bounded.has(id)) reading.push(id);
  }
  // `project` grows with the project; it stays inside R only when R is unbounded (a public channel every member reads).
  // A bounded R (a DM, a group, a private channel, an AI chat) is always a snapshot, even when P ⊆ R today (WR-06).
  if (p.readers.unbounded && reading.length === people.length) return { kind: "project" };
  const shown = reading.filter((id) => id !== p.sponsorUserId);
  if (shown.length === 0) return { kind: "owner" };
  if (shown.length <= WORK_PROJECT_LIMITS.userIdsMax) return { kind: "people", userIds: shown };
  return people.includes(p.requesterUserId) && p.requesterUserId !== p.sponsorUserId
    ? { kind: "people", userIds: [p.requesterUserId] }
    : { kind: "owner" };
}

// ---------------------------------------------------------------- ownership (PD-13)

/**
 * The one ownership rule (PD-13): the session was started by this bot (`started_by_agent_id`) AND has a
 * `bot_work_sessions` row of the same bot. Null otherwise (another bot's, a person's, or not visible here).
 */
export async function ownBotSession(
  tx: Tx,
  p: { agentId: string; workSessionId: string },
): Promise<{ session: SessionRow; bot: BotWorkSessionRow } | null> {
  const [row] = await tx
    .select({ session: workSessions, bot: botWorkSessions })
    .from(workSessions)
    .innerJoin(botWorkSessions, eq(botWorkSessions.workSessionId, workSessions.id))
    .where(
      and(
        eq(workSessions.id, p.workSessionId),
        eq(workSessions.startedByAgentId, p.agentId),
        eq(botWorkSessions.agentId, p.agentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------- start

/** `createWorkSession`'s refusal as the bot's code (PD-10). */
function refusalOf(f: WorkSessionStartFailure): BotWorkSessionRefused {
  switch (f.code) {
    case "not_allowed":
    case "device_not_shared":
      return refusedAnswer("not_allowed");
    case "project_not_found":
    case "not_in_project":
      return refusedAnswer("project_not_allowed");
    case "device_offline":
      return refusedAnswer("device_offline");
    case "runtime_unavailable":
      return refusedAnswer("runtime_unavailable");
    case "prompt_not_allowed":
      return refusedAnswer("prompt_not_allowed");
    case "settings_denied":
      return f.field === "permissionMode"
        ? refusedAnswer("mode_not_allowed")
        : refusedAnswer("setting_not_allowed", { field: settingField(f.field) });
    case "audience_outside_project":
    case "team_not_assigned":
      return refusedAnswer("not_allowed");
  }
}

const SETTING_FIELDS = ["model", "effort", "contextWindow", "fastMode", "permissionMode"] as const;
const settingField = (field: string): BotWorkSessionRefused["field"] =>
  (SETTING_FIELDS as readonly string[]).includes(field)
    ? (field as BotWorkSessionRefused["field"])
    : undefined;

/**
 * The start's settings: what the bot asked, else the profile's defaults (PD-09). A profile that restricts the models
 * but names no default starts on its first allowed model (code review WR-03): never the runtime's default, which may be
 * outside the set. An effort or context window left to the model's default is checked by `createWorkSession`.
 */
function settingsOf(profile: BotProfileRow, input: AgentChannelWorkSessionStart) {
  const contextWindow =
    input.contextWindow ??
    (profile.defaultContextWindow !== null
      ? (Number(profile.defaultContextWindow) as ContextWindow)
      : undefined);
  return {
    model: input.model ?? profile.defaultModel ?? profile.allowedModels[0] ?? undefined,
    effort: input.effort ?? profile.defaultEffort ?? undefined,
    contextWindow,
    fastMode: input.fastMode ?? (profile.fastMode === "on" ? true : undefined),
  };
}

/**
 * The caps' counts (`app.bot_work_session_load`, SECURITY DEFINER): the sponsor's transaction hides other people's
 * sessions behind the audience backstop, but every cap counts the whole organization. Numbers and one flag only.
 * 07.17.1.1 (PD-12): `botPromptsHour` also counts the bot's file moves of the hour (`bot-files.ts`, module-internal).
 */
export async function botSessionLoad(
  tx: Tx,
  agentId: string,
  projectId: string,
): Promise<{ botActive: number; orgActive: number; botPromptsHour: number; treeBusy: boolean }> {
  const states = `{${ACTIVE_STATES.join(",")}}`;
  const res = await tx.execute(
    sql`select bot_active, org_active, bot_prompts_hour, tree_busy
          from app.bot_work_session_load(${agentId}::uuid, ${projectId}::uuid, ${states}::text[])`,
  );
  const row = res.rows[0] as
    | { bot_active: number; org_active: number; bot_prompts_hour: number; tree_busy: boolean }
    | undefined;
  return {
    botActive: Number(row?.bot_active ?? 0),
    orgActive: Number(row?.org_active ?? 0),
    botPromptsHour: Number(row?.bot_prompts_hour ?? 0),
    treeBusy: row?.tree_busy === true,
  };
}

/**
 * The bot's own lock (PD-10): its starts and its prompts are serialised, so the hour's prompt count (and the start's
 * session count) is exact under concurrency. Always taken before any session row lock and before the org's lock.
 * 07.17.1.1 (PD-12): its file moves take it too (`bot-files.ts`, module-internal; not exported from `index.ts`).
 */
export async function lockBot(tx: Tx, agentId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`bot_ws:${agentId}`}, 0))`);
}

/** The organization's lock of bot sessions (PD-10): always taken after `lockBot`, by a start and by a restart. */
async function lockOrg(tx: Tx, organizationId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`bot_ws_org:${organizationId}`}, 0))`);
}

/** `submitWorkPrompt`'s refusals of the body as the bot's codes; anything else is not a bot answer. */
function promptRefusalOf(err: unknown): BotWorkSessionRefused | null {
  if (!(err instanceof HttpError)) return null;
  if (err.code === "session_archived") return refusedAnswer("session_ended");
  if (err.code === "slash_command") return refusedAnswer("prompt_not_allowed");
  return null;
}

export function createBotSessions(deps: BotSessionsDeps): BotSessions {
  const { core, controller } = deps;
  const { svc } = controller;
  const perms = controller.startDeps.perms;

  return {
    async start(tx, p) {
      const { turn, profile, status, input } = p;
      const prompt = input.prompt;
      const refuse = async (answer: BotWorkSessionRefused): Promise<BotWorkSessionRefused> => {
        await auditBotWorkSession(tx, core, {
          action: "bot.work_session_refused",
          tool: BUILTIN_TOOLS.workSessionStart,
          turn,
          auditBase: p.auditBase,
          outcome: answer.code,
          sponsorUserId: profile.sponsorUserId,
          projectId: input.projectId,
          deviceId: profile.deviceId,
          promptChars: prompt.length,
          ...(answer.reason ? { reason: answer.reason } : {}),
          ...(answer.field ? { field: answer.field } : {}),
        });
        return answer;
      };

      // PD-10: this bot's starts, then the organization's bot starts, are serialised (always in this order), so the
      // counts below are exact under concurrency: a second start waits here until the first one commits, then counts
      // its session. The counts see every session of the organization, not only those the sponsor sees.
      await lockBot(tx, turn.agentId);
      await lockOrg(tx, turn.organizationId);
      const load = await botSessionLoad(tx, turn.agentId, input.projectId);
      if (load.botActive >= profile.maxConcurrent) return refuse(refusedAnswer("too_many_sessions"));
      const policy = await loadWorkZonePolicy(tx);
      const orgMax = policy.botSessionsMax ?? BOT_WORK_ZONE_LIMITS.orgSessionsDefault;
      if (load.orgActive >= orgMax) return refuse(refusedAnswer("org_limit"));
      // The start's own prompt counts against the hour (the first prompt is a prompt).
      if (load.botPromptsHour >= profile.promptsPerHour) return refuse(refusedAnswer("prompt_rate"));
      // The project must be one of the profile's that the sponsor can still start in.
      if (!status.projectIds.includes(input.projectId)) return refuse(refusedAnswer("project_not_allowed"));
      // Quick 261113-hu7: an isolated worktree needs git, so a project the device said is in no git repository runs on
      // its own checkout whatever the profile asks (null = the device did not say: the profile's choice stands).
      const [target] = await tx
        .select({ git: projects.git })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      const worktree = profile.worktree && target?.git !== false;
      // One executor per tree (D-15): without a worktree, never next to another active session on the project's tree.
      if (!worktree && load.treeBusy) return refuse(refusedAnswer("tree_busy"));

      const visibility = await botSessionAudience(tx, {
        projectId: input.projectId,
        sponsorUserId: profile.sponsorUserId,
        requesterUserId: turn.userId,
        readers: p.readers,
        isReadable: p.isReadable,
      });

      const sponsor = {
        userId: profile.sponsorUserId,
        organizationId: turn.organizationId,
        clientKind: "agent",
      };
      const settings = settingsOf(profile, input);
      const base: WorkSessionStartInput = {
        projectId: input.projectId,
        deviceId: profile.deviceId,
        runtime: profile.runtime,
        worktree,
        prompt,
        visibility,
        ...(settings.model !== undefined ? { model: settings.model } : {}),
        ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
        ...(settings.contextWindow !== undefined ? { contextWindow: settings.contextWindow } : {}),
        ...(settings.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
      };
      // A mode the bot asked for is never lowered (refused with its reason). Absent = the profile's default; when that
      // default is above what the context allows now (e.g. Full access after outside content off an isolated server,
      // PD-15), the start steps down the ladder below it to the highest mode the one controls context allows, ending
      // with the implicit `default`, which the context lowers itself (an implicit default is lowered, never refused).
      // Each refused attempt writes nothing (`createWorkSession` decides the settings before any insert).
      const opts = { agent: { layer: { ...status.layer, tainted: turn.tainted } } };
      const explicit =
        input.permissionMode ?? (profile.defaultMode !== "default" ? profile.defaultMode : undefined);
      let result = await deps.start(
        tx,
        sponsor,
        { ...base, ...(explicit ? { permissionMode: explicit } : {}) },
        opts,
      );
      const modeDenied = (r: typeof result) =>
        !r.ok && r.code === "settings_denied" && r.field === "permissionMode";
      if (modeDenied(result) && input.permissionMode === undefined && explicit !== undefined) {
        const lower = PermissionMode.options
          .filter(
            (m) =>
              PERMISSION_MODE_RANK[m] < PERMISSION_MODE_RANK[explicit] &&
              PERMISSION_MODE_RANK[m] > PERMISSION_MODE_RANK.default,
          )
          .sort((a, b) => PERMISSION_MODE_RANK[b] - PERMISSION_MODE_RANK[a]);
        for (const mode of lower) {
          result = await deps.start(tx, sponsor, { ...base, permissionMode: mode }, opts);
          if (!modeDenied(result)) break;
        }
        if (modeDenied(result)) result = await deps.start(tx, sponsor, base, opts);
      }
      // The server's own audience can only be refused by a membership change in between: the creator alone sees it.
      if (!result.ok && (result.code === "audience_outside_project" || result.code === "team_not_assigned")) {
        result = await deps.start(tx, sponsor, { ...base, visibility: { kind: "owner" } }, opts);
      }
      if (!result.ok) return refuse(refusalOf(result));
      const session = result.session;

      // The card answers the asker's message, in its thread when it has one (the proposals' rule).
      const [asked] = await tx
        .select({ threadId: messages.threadId })
        .from(messages)
        .where(eq(messages.id, turn.messageId))
        .limit(1);
      const threadRootId = asked?.threadId ?? turn.messageId;
      const card = await composeWorkSessionCard(
        tx,
        {
          id: session.id,
          status: session.status,
          runtime: profile.runtime,
          model: session.model ?? null,
          permissionMode: session.permissionMode,
          projectId: input.projectId,
          deviceId: profile.deviceId,
        },
        { turn: 0, pendingApprovals: 0 },
      );
      const posted = await core.chatAgent.postAgentMessageIn(tx, {
        agentId: turn.agentId,
        conversationId: turn.conversationId,
        threadRootId,
        body: card.title,
        idempotencyKey: `wz:${session.id}`,
        onBehalfOfUserId: turn.userId,
        cardPlatformOwned: true,
        card: {
          kind: "work_zone",
          title: card.title,
          summary: card.title,
          status: card.status,
          ...(card.statusLabel ? { statusLabel: card.statusLabel } : {}),
          fields: card.fields,
          actions: [
            { kind: "open", label: "Open session", target: `/work-zone/${session.id}` },
            { kind: "follow", label: "Follow" },
          ],
        },
      });

      await tx.insert(botWorkSessions).values({
        workSessionId: session.id,
        organizationId: turn.organizationId,
        agentId: turn.agentId,
        profileId: profile.id,
        sponsorUserId: profile.sponsorUserId,
        requesterUserId: turn.userId,
        originConversationId: turn.conversationId,
        originThreadRootId: threadRootId,
        originMessageId: turn.messageId,
        originEventId: turn.eventId,
        cardMessageId: posted.messageId,
        // Phase 07.17.1.1.2-12 (D-03, PD-14): a session a task turn starts belongs to that task (its 07.16 wakes then
        // wake the task, `work-session-wakes.ts`); a turn outside any task leaves it null.
        taskId: turn.taskId ?? null,
      });

      await auditBotWorkSession(tx, core, {
        action: "bot.work_session_started",
        turn,
        auditBase: p.auditBase,
        outcome: "started",
        sponsorUserId: profile.sponsorUserId,
        projectId: input.projectId,
        deviceId: profile.deviceId,
        workSessionId: session.id,
        mode: session.permissionMode,
        model: session.model ?? null,
        promptChars: prompt.length,
      });
      return {
        kind: "started",
        workSessionId: session.id,
        status: session.status,
        cardMessageId: posted.messageId,
        model: session.model ?? null,
        mode: session.permissionMode,
        projectName: card.projectName,
      };
    },

    async prompt(tx, p) {
      const { turn, profile } = p;
      // The bot's lock first (its starts and prompts count the same hour), then the session row, as people do.
      await lockBot(tx, turn.agentId);
      const s = await svc.lock(tx, p.workSessionId);
      // Hidden from the sponsor: a profile re-saved by someone outside the session's audience cannot prompt it.
      if (!s) return refusedAnswer("not_allowed");
      if (!(await ownBotSession(tx, { agentId: turn.agentId, workSessionId: s.id }))) {
        return refusedAnswer("not_your_session");
      }
      if (s.status === "archived") return refusedAnswer("session_ended");
      // The sponsor's own right to prompt this session (principle 6: the bot never prompts above its sponsor).
      const sponsorUserId = profile.sponsorUserId;
      const { allowed } = await perms.decide(
        tx,
        { kind: "user", userId: sponsorUserId },
        "work_session.prompt",
        await sessionFacts(tx, sponsorUserId, s),
      );
      if (!allowed) return refusedAnswer("not_allowed");
      // A finished session (failed, completed) is restarted by this prompt (`submitWorkPrompt`): it becomes active
      // again, so it is held to the start's caps (code review CR-03). The organization's lock is taken after the bot's,
      // as `start` does, so the counts are exact under concurrency; the session itself is not active, so it is not
      // counted. Without a worktree it never restarts next to another active session on its tree (principle 4).
      const restarts = s.status === "failed" || s.status === "completed";
      if (restarts) await lockOrg(tx, turn.organizationId);
      // E2: the hour's prompts of this bot across its sessions, the start's own included (the start cap's count).
      const load = await botSessionLoad(tx, turn.agentId, s.projectId);
      if (restarts) {
        if (load.botActive >= profile.maxConcurrent) return refusedAnswer("too_many_sessions");
        const policy = await loadWorkZonePolicy(tx);
        const orgMax = policy.botSessionsMax ?? BOT_WORK_ZONE_LIMITS.orgSessionsDefault;
        if (load.orgActive >= orgMax) return refusedAnswer("org_limit");
        if (!s.worktree && load.treeBusy) return refusedAnswer("tree_busy");
      }
      if (load.botPromptsHour >= profile.promptsPerHour) return refusedAnswer("prompt_rate");
      const sponsor = { userId: sponsorUserId, organizationId: turn.organizationId, clientKind: "agent" };
      try {
        const queued = await submitWorkPrompt(tx, controller, sponsor, s, p.prompt, {
          authorAgentId: turn.agentId,
          tainted: p.tainted,
        });
        // D-08 (E12): a prompt written after outside content taints the session for good. From now on every bot turn
        // of it runs in Full access only on an isolated server (`botLayerForSession` reads `tainted_at`). The first mark
        // is kept.
        if (p.tainted) {
          await tx
            .update(workSessions)
            .set({ taintedAt: sql`now()` })
            .where(and(eq(workSessions.id, s.id), isNull(workSessions.taintedAt)));
        }
        return {
          kind: "queued",
          workSessionId: s.id,
          promptId: queued.id,
          position: queued.position,
          status: queued.status,
        };
      } catch (err) {
        const refused = promptRefusalOf(err);
        if (refused) return refused;
        throw err;
      }
    },

    async stop(tx, p) {
      const s = await svc.lock(tx, p.workSessionId);
      if (!s || !(await ownBotSession(tx, { agentId: p.turn.agentId, workSessionId: s.id }))) {
        return refusedAnswer("not_your_session");
      }
      if (s.status === "archived") return refusedAnswer("session_ended");
      // Marked before the archive's status change, so the wake handler (07.16-20) never wakes the bot for its own stop.
      await tx
        .update(botWorkSessions)
        .set({ stoppedByAgent: true })
        .where(eq(botWorkSessions.workSessionId, s.id));
      await archiveWorkSession(tx, controller, s, { byAgentId: p.turn.agentId });
      return { kind: "stopped", workSessionId: s.id };
    },
  };
}
