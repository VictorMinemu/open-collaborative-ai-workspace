import {
  type AgentChannelWorkSessionStart,
  type AgentChannelWorkSessionStartResponse,
  BOT_PROFILE_STATUS_SENTENCES,
  BOT_WORK_SESSION_SENTENCES,
  type BotProfileInactiveReason,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  type ContextWindow,
  type PermissionMode,
  type SessionAudienceInput,
  WORK_PROJECT_LIMITS,
} from "@ocw/contracts";
import { type agentTurns, botWorkSessions, messages, orgMembers, type Tx, workSessions } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { composeWorkSessionCard } from "./bot-card";
import type { BotProfileRow, BotProfileStatus } from "./bot-profile";
import type { WorkSessionStartFn } from "./proposals";
import type { SessionRow } from "./service";
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
 * - The device, runtime and worktree are the profile's; model and options absent = the profile's defaults (PD-09).
 * - The audience is decided here from existing kinds only (PD-11, `botSessionAudience`), never by the bot.
 * - One `bot_work_sessions` row (origin, requester, card) and one platform-owned `work_zone` card in the asker's thread
 *   (PD-12), then `bot.work_session_started` with ids, the mode, the model and the prompt's length only (PD-21).
 *
 * `ownBotSession` is the one ownership rule (PD-13) the prompt, stop and read routes use.
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

export interface BotSessions {
  start(tx: Tx, p: BotStartParams): Promise<AgentChannelWorkSessionStartResponse>;
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

/**
 * `bot.work_session_started` / `bot.work_session_refused` (PD-21): the bot is the actor, the asker the user; ids, the
 * mode, the model, the outcome and the prompt's length only. Never the prompt, a title, a name or a path.
 */
export async function auditBotStart(
  tx: Tx,
  core: Pick<Core, "audit">,
  p: {
    turn: AgentTurnRow;
    auditBase: { clientKind: string; sessionId: string };
    outcome: "started" | BotWorkSessionRefusal;
    sponsorUserId: string | null;
    projectId: string;
    deviceId: string | null;
    workSessionId?: string;
    mode?: PermissionMode | null;
    model?: string | null;
    promptChars: number;
    reason?: string;
    field?: string;
  },
): Promise<void> {
  const ok = p.outcome === "started";
  await core.audit.record(tx, {
    clientKind: p.auditBase.clientKind,
    sessionId: ok && p.workSessionId ? p.workSessionId : p.auditBase.sessionId,
    action: ok ? "bot.work_session_started" : "bot.work_session_refused",
    actorKind: "agent",
    actorId: p.turn.agentId,
    agentId: p.turn.agentId,
    userId: p.turn.userId,
    deviceId: p.deviceId,
    resourceType: ok ? "work_session" : "agent",
    resourceId: ok && p.workSessionId ? p.workSessionId : p.turn.agentId,
    result: ok ? "success" : "denied",
    metadata: {
      eventId: p.turn.eventId,
      sponsorUserId: p.sponsorUserId,
      projectId: p.projectId,
      ...(p.workSessionId ? { workSessionId: p.workSessionId } : {}),
      ...(p.mode ? { mode: p.mode } : {}),
      ...(p.model !== undefined && p.model !== null ? { model: p.model } : {}),
      outcome: p.outcome,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.field ? { field: p.field } : {}),
      promptChars: p.promptChars,
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
 * readers, P = the project's people. P ⊆ R → `project`; else S = (R ∩ P) \ {sponsor}: up to 100 → `people` S; more →
 * `people` [requester] when the requester is in P, else `owner`; S empty → `owner`. The sponsor (creator) and the
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
  if (reading.length === people.length) return { kind: "project" };
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

/** The start's settings: what the bot asked, else the profile's defaults (PD-09). */
function settingsOf(profile: BotProfileRow, input: AgentChannelWorkSessionStart) {
  const contextWindow =
    input.contextWindow ??
    (profile.defaultContextWindow !== null
      ? (Number(profile.defaultContextWindow) as ContextWindow)
      : undefined);
  return {
    model: input.model ?? profile.defaultModel ?? undefined,
    effort: input.effort ?? profile.defaultEffort ?? undefined,
    contextWindow,
    fastMode: input.fastMode ?? (profile.fastMode === "on" ? true : undefined),
  };
}

export function createBotSessions(deps: BotSessionsDeps): BotSessions {
  const { core } = deps;

  return {
    async start(tx, p) {
      const { turn, profile, status, input } = p;
      const prompt = input.prompt;
      const refuse = async (answer: BotWorkSessionRefused): Promise<BotWorkSessionRefused> => {
        await auditBotStart(tx, core, {
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

      // The project must be one of the profile's that the sponsor can still start in (PD-10).
      if (!status.projectIds.includes(input.projectId)) return refuse(refusedAnswer("project_not_allowed"));

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
        worktree: profile.worktree,
        prompt,
        visibility,
        ...(settings.model !== undefined ? { model: settings.model } : {}),
        ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
        ...(settings.contextWindow !== undefined ? { contextWindow: settings.contextWindow } : {}),
        ...(settings.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
      };
      // A mode the bot asked for is never lowered (refused with its reason). Absent = the profile's default; when that
      // default is above what the context allows now, the start falls back to the implicit `default`, which the one
      // controls context lowers to the highest available mode (PD-15: an implicit default is lowered, never refused).
      const opts = { agent: { layer: { ...status.layer, tainted: turn.tainted } } };
      const explicit =
        input.permissionMode ?? (profile.defaultMode !== "default" ? profile.defaultMode : undefined);
      let result = await deps.start(
        tx,
        sponsor,
        { ...base, ...(explicit ? { permissionMode: explicit } : {}) },
        opts,
      );
      if (
        !result.ok &&
        result.code === "settings_denied" &&
        result.field === "permissionMode" &&
        input.permissionMode === undefined &&
        explicit !== undefined
      ) {
        result = await deps.start(tx, sponsor, base, opts);
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
      });

      await auditBotStart(tx, core, {
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
  };
}
