import {
  BOT_WORK_ZONE_LIMITS,
  type EffortLevel,
  MODULE_CATALOG,
  PERMISSION_MODE_RANK,
  type PermissionMode,
  type TurnWorkZone,
} from "@ocw/contracts";
import { botWorkSessions, projects, type Tx, workSessions } from "@ocw/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { orgResource, type PermissionService } from "../organization";
import { loadBotProfile, profileStatus } from "./bot-profile";
import { loadControlsContext } from "./context";
import { buildRuntimeControls } from "./controls";
import { ACTIVE_STATES } from "./service";

/**
 * Phase 07.16 (D-05, D-21, PD-17): whether one delivered turn of a bot is offered the four `ocw_work_session_*` tools,
 * and the Work Zone context it carries (`turn.workZone`). Decided at delivery, server-side; every work-session route
 * re-decides everything at call time (the live turn, the profile, the sponsor's rights), so this is what the model is
 * told, never what it is allowed.
 *
 * - No profile, or a profile that is not active (`profileStatus`, PD-05) → no offer. A bot without a profile pays one
 *   lookup and gets the turn it got before the phase (BWZ-06).
 * - The asker must pass the Work Zone module gate (`work_session.read` at organization scope, 07.3). D-21: they need
 *   not hold `work_session.create` themselves; the session runs under the sponsor's rights.
 * - The options are the ONE controls builder a start uses (the sponsor's live controls ∩ the bot's layer, PD-07), so
 *   a model the device stopped reporting, or a mode above the bot's caps, is never listed. `maxMode` is already lowered
 *   for a turn that starts after outside content off an isolated server (PD-08).
 * - Lists are bounded (`turnProjects`, `turnSessions`) and carry repository names and ids only: never a team project
 *   name, a path or a URL. The bot's sessions are those it started from this conversation, as the turn's transaction
 *   can see them.
 */
export async function workZoneOfferFor(
  tx: Tx,
  perms: PermissionService,
  p: {
    agentId: string;
    askerUserId: string;
    conversationId: string;
    /** The turn starts tainted (outside content, D-08): Full access only on an isolated server. */
    tainted?: boolean;
  },
): Promise<TurnWorkZone | null> {
  const profile = await loadBotProfile(tx, p.agentId);
  if (!profile) return null;
  const gate = await perms.decide(
    tx,
    { kind: "user", userId: p.askerUserId },
    MODULE_CATALOG.work_zone.entry,
    orgResource(),
  );
  if (!gate.allowed) return null;
  const status = await profileStatus(tx, perms, profile);
  if (!status.active) return null;

  const layer = { ...status.layer, tainted: p.tainted === true };
  const mc = await loadControlsContext(tx, perms, {
    deviceId: status.device.id,
    runtime: profile.runtime,
    userId: profile.sponsorUserId,
    inSession: false,
    agent: layer,
  });
  if (!mc) return null;
  const controls = buildRuntimeControls(profile.runtime, mc.ctx);
  const usable = controls.models.filter((m) => m.available);
  const models = usable.map((m) => m.id).slice(0, BOT_WORK_ZONE_LIMITS.allowedValuesMax);
  const efforts: EffortLevel[] = [];
  for (const m of usable) {
    for (const e of m.efforts) {
      if (e.available && !efforts.includes(e.value as EffortLevel)) efforts.push(e.value as EffortLevel);
    }
  }
  const modes = controls.permissionModes.filter((m) => m.available).map((m) => m.value);
  const maxMode: PermissionMode = modes.at(-1) ?? profile.defaultMode;
  const defaultMode: PermissionMode =
    PERMISSION_MODE_RANK[profile.defaultMode] <= PERMISSION_MODE_RANK[maxMode]
      ? profile.defaultMode
      : maxMode;

  const listed =
    status.projectIds.length === 0
      ? []
      : await tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, status.projectIds))
          .orderBy(asc(projects.name), asc(projects.id));
  const shown = listed.slice(0, BOT_WORK_ZONE_LIMITS.turnProjects);

  const sessions = await tx
    .select({ id: workSessions.id, status: workSessions.status, projectName: projects.name })
    .from(botWorkSessions)
    .innerJoin(workSessions, eq(workSessions.id, botWorkSessions.workSessionId))
    .innerJoin(projects, eq(projects.id, workSessions.projectId))
    .where(
      and(
        eq(botWorkSessions.agentId, p.agentId),
        eq(botWorkSessions.originConversationId, p.conversationId),
        inArray(workSessions.status, ACTIVE_STATES),
      ),
    )
    .orderBy(desc(workSessions.createdAt), desc(workSessions.id))
    .limit(BOT_WORK_ZONE_LIMITS.turnSessions);

  return {
    runtime: profile.runtime,
    device: {
      id: status.device.id,
      name: status.device.name.slice(0, 120),
      online: status.device.status === "online",
    },
    projects: shown.map((r) => ({ id: r.id, name: r.name.slice(0, 200) })),
    projectsMore: listed.length - shown.length,
    models,
    defaultModel:
      profile.defaultModel !== null && models.includes(profile.defaultModel) ? profile.defaultModel : null,
    efforts: efforts.slice(0, 10),
    fastMode:
      profile.fastMode !== "off" && usable.some((m) => m.fastMode.available) ? profile.fastMode : "off",
    defaultMode,
    maxMode,
    outsideContent: profile.actOnOutsideContent,
    sessions: sessions.map((s) => ({ id: s.id, status: s.status, projectName: s.projectName.slice(0, 200) })),
  };
}
