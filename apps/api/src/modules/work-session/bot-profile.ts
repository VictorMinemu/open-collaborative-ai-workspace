import {
  BOT_FILE_LIMITS,
  BOT_PROFILE_STATUS_SENTENCES,
  BOT_WORK_ZONE_LIMITS,
  type BotProfileInactiveReason,
  type BotWorkZoneProfileInput as BotWorkZoneProfileBody,
  BotWorkZoneProfileInput,
  BotWorkZoneProfileView,
  type ContextWindow,
  DeviceBotConsentsView,
  type EffortLevel,
  fileSizeLabel,
  Id,
  IdParams,
  PERMISSION_MODE_RANK,
  type PermissionMode,
  SetDeviceBotConsentRequest,
} from "@ocw/contracts";
import {
  agents,
  botWorkZoneProfileProjects,
  botWorkZoneProfiles,
  deviceBotConsents,
  devices,
  orgMembers,
  projects,
  type Tx,
} from "@ocw/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { HttpError, notFound } from "../../lib/errors";
import { findBot, loadBotFacts } from "../bot-capabilities";
import { loadDeviceAccess } from "../device";
import { agentResource, orgResource, type PermissionService } from "../organization";
import { type AgentControlsLayer, loadControlsContext } from "./context";
import { buildRuntimeControls, catalogFor } from "./controls";
import { loadWorkZonePolicy, serverFileMaxBytes } from "./policy";
import { mayCreate, mayStartIn, mayUse } from "./proposals";
import type { ReauthorizeReason } from "./service";

/**
 * Phase 07.16 (D-01 … D-04, D-08, D-14 … D-16, D-22; PD-04 … PD-06, PD-21): a bot's Work Zone profile and the per-bot
 * device consent.
 *
 * - The profile is saved by whoever holds `bot.configure` on the bot (after `bot.read`, hidden as 404): a personal
 *   bot's owner; a team bot's admins, owner and leads of a unit on its path. The saver becomes its sponsor (never a body
 *   field), and every value is validated against the sponsor's live controls for (device, runtime): the one
 *   `loadControlsContext` + `buildRuntimeControls` a person's start uses. Defaults are added to the allowed sets.
 * - `actOnOutsideContent` changes only with `work_zone.manage`; a non-admin who is not the current sponsor re-saving
 *   resets it (the admin accepted the warning for the previous sponsor's rights), and so does any non-admin save that
 *   changes the device, runtime, projects or highest mode (WR-08: the scope it was accepted for). An admin save that
 *   changes nothing
 *   but the flag keeps the sponsor: accepting the warning is not taking the bot over.
 * - The consent is granted, updated and revoked (softly) by the device's owner (`device.update`), and by an admin
 *   (`work_zone.manage`) only on a `service` host (an organization server, ADR-0033), never on someone's laptop.
 * - `profileStatus` re-decides everything at use time, in PD-05's order, and builds the `AgentControlsLayer` the
 *   controls intersect (07.16-06). Nothing starts without a profile and a live consent (D-16).
 *
 * Audit rows carry ids, counts and the mode only: never a project name, a device name or a model id (PD-21).
 */

type ProfileRow = typeof botWorkZoneProfiles.$inferSelect;
type ConsentRow = typeof deviceBotConsents.$inferSelect;
type DeviceFactsRow = typeof devices.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

/** A stored profile with its project ids (sorted). */
export type BotProfileRow = ProfileRow & { projectIds: string[] };

/** `profileStatus`: active with the bot's caps and the facts it was decided on, or the first reason it is not. */
export type BotProfileStatus =
  | {
      active: true;
      layer: AgentControlsLayer;
      consent: ConsentRow;
      device: DeviceFactsRow;
      /** The profile's projects the sponsor can still start in. */
      projectIds: string[];
    }
  | { active: false; reason: BotProfileInactiveReason };

/** The work-session service's re-authorization entry point (the device sweep; 07.16-10 makes it agent-aware). */
export interface AccessSweeper {
  onAccessChanged(
    device: { deviceId: string; organizationId: string },
    reason: ReauthorizeReason,
  ): Promise<void>;
}

const tags = ["work-session"];
const ConsentParams = z.object({ id: Id, agentId: Id });

const invalid = (field: string, message: string) =>
  new HttpError(400, "invalid_work_zone_profile", message, { field });
const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const iso = (v: string | Date) => new Date(v).toISOString();

// ---------------------------------------------------------------- data

/** The bot's profile with its project ids, or null. */
export async function loadBotProfile(tx: Tx, agentId: string): Promise<BotProfileRow | null> {
  const [row] = await tx
    .select()
    .from(botWorkZoneProfiles)
    .where(eq(botWorkZoneProfiles.agentId, agentId))
    .limit(1);
  if (!row) return null;
  const rows = await tx
    .select({ projectId: botWorkZoneProfileProjects.projectId })
    .from(botWorkZoneProfileProjects)
    .where(eq(botWorkZoneProfileProjects.profileId, row.id))
    .orderBy(asc(botWorkZoneProfileProjects.projectId));
  return { ...row, projectIds: rows.map((r) => r.projectId) };
}

/** The live (not revoked) consent for (device, bot), or null. */
async function liveConsent(
  tx: Tx,
  deviceId: string,
  agentId: string,
  lock = false,
): Promise<ConsentRow | null> {
  const q = tx
    .select()
    .from(deviceBotConsents)
    .where(
      and(
        eq(deviceBotConsents.deviceId, deviceId),
        eq(deviceBotConsents.agentId, agentId),
        isNull(deviceBotConsents.revokedAt),
      ),
    );
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

async function deviceRow(tx: Tx, id: string): Promise<DeviceFactsRow | null> {
  const [d] = await tx.select().from(devices).where(eq(devices.id, id)).limit(1);
  return d ?? null;
}

/** Display names of members by id ("Former member" when gone). */
async function namesOf(tx: Tx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = unique(ids.filter((x): x is string => x !== null));
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ userId: orgMembers.userId, displayName: orgMembers.displayName })
    .from(orgMembers)
    .where(inArray(orgMembers.userId, wanted));
  return new Map(rows.map((r) => [r.userId, r.displayName]));
}

// ---------------------------------------------------------------- status and the bot's caps (PD-05)

/** The profile's sets as the controls read them: an empty stored set means every value the device's catalog reports. */
function layerOf(profile: BotProfileRow, consent: ConsentRow, device: DeviceFactsRow): AgentControlsLayer {
  const catalog = catalogFor(device.runtimeCatalog, profile.runtime);
  const models = catalog?.models ?? [];
  return {
    agentId: profile.agentId,
    maxMode: profile.maxMode,
    allowFullAccess: consent.allowFullAccess && profile.maxMode === "fullAccess",
    tainted: false,
    isolated: device.hostKind === "service" && device.isolatedServer,
    models: profile.allowedModels.length > 0 ? [...profile.allowedModels] : models.map((m) => m.id),
    efforts:
      profile.allowedEfforts.length > 0
        ? [...profile.allowedEfforts]
        : unique(models.flatMap((m) => m.efforts.map((e) => e.value))),
    contextWindows:
      profile.allowedContextWindows.length > 0
        ? profile.allowedContextWindows.map(Number)
        : unique(models.flatMap((m) => m.contextWindows)),
    fastMode: profile.fastMode,
  };
}

/**
 * Whether the profile can be used right now, re-decided from live facts in PD-05's order (the first failing reason
 * wins): the bot is enabled, a live consent, the device not revoked, the sponsor an active member who may start Work
 * Zone sessions and use the device, one profile project still startable by them, and the organization's cap above 0.
 */
export async function profileStatus(
  tx: Tx,
  perms: PermissionService,
  profile: BotProfileRow,
): Promise<BotProfileStatus> {
  const inactive = (reason: BotProfileInactiveReason): BotProfileStatus => ({ active: false, reason });
  const [bot] = await tx
    .select({ status: agents.status, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, profile.agentId))
    .limit(1);
  if (!bot || bot.deletedAt !== null || bot.status === "disabled") return inactive("bot_disabled");
  const consent = await liveConsent(tx, profile.deviceId, profile.agentId);
  if (!consent) return inactive("no_consent");
  const device = await deviceRow(tx, profile.deviceId);
  if (!device || device.revokedAt !== null) return inactive("device_revoked");
  const sponsor = profile.sponsorUserId;
  const [member] = await tx
    .select({ deactivatedAt: orgMembers.deactivatedAt })
    .from(orgMembers)
    .where(eq(orgMembers.userId, sponsor))
    .limit(1);
  if (!member || member.deactivatedAt !== null) return inactive("sponsor_inactive");
  if (!(await mayCreate(tx, perms, sponsor))) return inactive("sponsor_not_allowed");
  if (!(await mayUse(tx, perms, sponsor, device))) return inactive("sponsor_device_access");
  const live =
    profile.projectIds.length === 0
      ? []
      : await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              inArray(projects.id, profile.projectIds),
              eq(projects.deviceId, device.id),
              isNull(projects.removedAt),
            ),
          )
          .orderBy(asc(projects.id));
  const projectIds: string[] = [];
  for (const p of live) if (await mayStartIn(tx, perms, sponsor, p.id)) projectIds.push(p.id);
  if (projectIds.length === 0) return inactive("no_projects");
  const policy = await loadWorkZonePolicy(tx);
  if ((policy.botSessionsMax ?? BOT_WORK_ZONE_LIMITS.orgSessionsDefault) <= 0)
    return inactive("org_disabled");
  return { active: true, layer: layerOf(profile, consent, device), consent, device, projectIds };
}

/** What a bot session names that its profile must still cover. */
export interface BotSessionScope {
  deviceId: string;
  runtime: string;
  projectId: string;
}

/**
 * Code review WR-04 (ADR-0038 §1, "re-checked at every tool call and at every dispatch"): why the bot's active profile
 * no longer covers one of its sessions, or null when it does. Another device or runtime is `profile_inactive` (the
 * layer would be the other runtime's); a project the profile no longer lists, or the sponsor can no longer start in, is
 * `project_not_allowed`.
 */
export function profileScopeRefusal(
  profile: Pick<BotProfileRow, "deviceId" | "runtime">,
  status: Extract<BotProfileStatus, { active: true }>,
  s: BotSessionScope,
): "profile_inactive" | "project_not_allowed" | null {
  if (profile.deviceId !== s.deviceId || profile.runtime !== s.runtime) return "profile_inactive";
  if (!status.projectIds.includes(s.projectId)) return "project_not_allowed";
  return null;
}

/**
 * The bot's caps for one of its sessions (PD-05, Pitfall 10): null for a person's session, and for a bot session whose
 * profile is gone, inactive or no longer covers it (another device or runtime, a project it no longer lists: WR-04),
 * so the bot may not act on it. Taint comes from the session.
 */
export async function botLayerForSession(
  tx: Tx,
  perms: PermissionService,
  s: BotSessionScope & { id: string; startedByAgentId: string | null; taintedAt: string | Date | null },
): Promise<AgentControlsLayer | null> {
  if (!s.startedByAgentId) return null;
  const profile = await loadBotProfile(tx, s.startedByAgentId);
  if (!profile || profile.deviceId !== s.deviceId) return null;
  const status = await profileStatus(tx, perms, profile);
  if (!status.active || profileScopeRefusal(profile, status, s)) return null;
  return { ...status.layer, tainted: s.taintedAt !== null };
}

// ---------------------------------------------------------------- save-time validation (PD-04)

interface NormalizedProfile {
  allowedModels: string[];
  allowedEfforts: EffortLevel[];
  allowedContextWindows: ContextWindow[];
  /** 07.17.1.1 (D-07, PD-21): the body's value; absent (an older client) = the stored one, or null for a new profile. */
  fileMaxBytes: number | null;
}

/**
 * The body's allowed sets with the defaults added (pure; the API always stores the defaults inside the sets), and the
 * largest file the profile keeps.
 */
function normalize(body: BotWorkZoneProfileBody, stored: BotProfileRow | null): NormalizedProfile {
  return {
    fileMaxBytes: body.fileMaxBytes !== undefined ? body.fileMaxBytes : (stored?.fileMaxBytes ?? null),
    allowedModels: unique([...body.allowedModels, ...(body.defaultModel ? [body.defaultModel] : [])]),
    allowedEfforts: unique([...body.allowedEfforts, ...(body.defaultEffort ? [body.defaultEffort] : [])]),
    allowedContextWindows: unique([
      ...body.allowedContextWindows,
      ...(body.defaultContextWindow !== null ? [body.defaultContextWindow] : []),
    ]),
  };
}

/**
 * Every value against the sponsor's own live controls for (device, runtime): the device usable and not revoked, every
 * project on it and startable by them, every model / effort / context window / fast mode offered and available
 * (`not_confirmed` never is), `defaultMode` ≤ `maxMode`, a non-Full-access mode available to them, and Full access only
 * with the org policy and their `device.full_access` (the device opt-in and the per-bot consent stay live conditions).
 */
async function validateProfile(
  tx: Tx,
  perms: PermissionService,
  sponsor: string,
  body: BotWorkZoneProfileBody,
  n: NormalizedProfile,
): Promise<void> {
  const d = await deviceRow(tx, body.deviceId);
  if (!d) throw invalid("deviceId", "This device is not in the organization");
  if (d.revokedAt !== null) throw invalid("deviceId", "This device was removed from the organization");
  if (!(await mayUse(tx, perms, sponsor, d))) throw invalid("deviceId", "You can't use this device");

  const rows = await tx
    .select({ id: projects.id, deviceId: projects.deviceId, removedAt: projects.removedAt })
    .from(projects)
    .where(inArray(projects.id, body.projectIds));
  for (const id of body.projectIds) {
    const p = rows.find((r) => r.id === id);
    if (!p || p.removedAt !== null || p.deviceId !== d.id) {
      throw invalid("projectIds", "Every project must be on the chosen device");
    }
    if (!(await mayStartIn(tx, perms, sponsor, id))) {
      throw invalid("projectIds", "You can't start sessions in one of these projects");
    }
  }

  const mc = await loadControlsContext(tx, perms, {
    deviceId: d.id,
    runtime: body.runtime,
    userId: sponsor,
    inSession: false,
  });
  if (!mc) throw invalid("deviceId", "This device is not in the organization");
  const controls = buildRuntimeControls(body.runtime, mc.ctx);
  const available = controls.models.filter((m) => m.available);
  if (body.defaultModel !== null && !available.some((m) => m.id === body.defaultModel)) {
    throw invalid("defaultModel", "The default model is not available on this device for you");
  }
  if (n.allowedModels.length > BOT_WORK_ZONE_LIMITS.allowedValuesMax) {
    throw invalid("allowedModels", "Too many models");
  }
  if (n.allowedModels.some((id) => !available.some((m) => m.id === id))) {
    throw invalid("allowedModels", "One of the models is not available on this device for you");
  }
  // Efforts, context windows and fast mode belong to models: each must be offered by one model the bot may use.
  const usable =
    n.allowedModels.length > 0 ? available.filter((m) => n.allowedModels.includes(m.id)) : available;
  const effortOk = (e: EffortLevel) =>
    usable.some((m) => m.efforts.some((x) => x.value === e && x.available));
  const windowOk = (w: ContextWindow) =>
    usable.some((m) => m.contextWindows.some((x) => x.value === w && x.available));
  if (body.defaultEffort !== null && !effortOk(body.defaultEffort)) {
    throw invalid("defaultEffort", "The default effort is not available for these models");
  }
  if (n.allowedEfforts.length > 10 || !n.allowedEfforts.every(effortOk)) {
    throw invalid("allowedEfforts", "One of the efforts is not available for these models");
  }
  if (body.defaultContextWindow !== null && !windowOk(body.defaultContextWindow)) {
    throw invalid("defaultContextWindow", "The default context window is not available for these models");
  }
  if (n.allowedContextWindows.length > 10 || !n.allowedContextWindows.every(windowOk)) {
    throw invalid("allowedContextWindows", "One of the context windows is not available for these models");
  }
  if (body.fastMode !== "off" && !usable.some((m) => m.fastMode.available)) {
    throw invalid("fastMode", "Fast mode is not available for these models");
  }

  if (PERMISSION_MODE_RANK[body.defaultMode] > PERMISSION_MODE_RANK[body.maxMode]) {
    throw invalid("defaultMode", "The default mode is above the highest mode");
  }
  const modeOk = (mode: PermissionMode) =>
    mode === "fullAccess"
      ? mc.ctx.policy.allowFullAccess && mc.ctx.fullAccessGrain
      : controls.permissionModes.some((p) => p.value === mode && p.available);
  if (!modeOk(body.maxMode)) throw invalid("maxMode", "You can't use this mode on this device");
  if (!modeOk(body.defaultMode)) throw invalid("defaultMode", "You can't use this mode on this device");

  // 07.17.1.1 (D-07, PD-11): a bot's largest file only narrows the organization's. Only a value the body sends is a
  // choice to decide: a body without the key (an older client) keeps the stored value, and the lower of the two applies
  // at every call anyway (`loadBotFileLimit`), so an organization lowered later never breaks an unrelated save.
  if (typeof body.fileMaxBytes === "number") {
    const organization = mc.ctx.policy.botFileMaxBytes ?? BOT_FILE_LIMITS.defaultMaxBytes;
    if (body.fileMaxBytes > organization) {
      throw invalid("fileMaxBytes", `At most ${fileSizeLabel(organization)}, the organization's limit.`);
    }
  }
}

/** Every stored field but the flag equals the (normalized) body: an admin's save that only flips the flag. */
const sameSet = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * WR-08: whether a save changes what an admin reviewed when turning `actOnOutsideContent` on: where the bot runs
 * (device, runtime), on what (projects) and how far (the highest mode).
 */
function scopeChanged(p: BotProfileRow, body: BotWorkZoneProfileBody): boolean {
  return (
    p.deviceId !== body.deviceId ||
    p.runtime !== body.runtime ||
    !sameSet(p.projectIds, body.projectIds) ||
    p.maxMode !== body.maxMode
  );
}

function onlyFlagDiffers(p: BotProfileRow, body: BotWorkZoneProfileBody, n: NormalizedProfile): boolean {
  return (
    p.deviceId === body.deviceId &&
    p.runtime === body.runtime &&
    sameSet(p.projectIds, body.projectIds) &&
    p.defaultModel === body.defaultModel &&
    sameSet(p.allowedModels, n.allowedModels) &&
    p.defaultEffort === body.defaultEffort &&
    sameSet(p.allowedEfforts, n.allowedEfforts) &&
    (p.defaultContextWindow === null ? null : Number(p.defaultContextWindow)) === body.defaultContextWindow &&
    sameSet(p.allowedContextWindows.map(Number), n.allowedContextWindows) &&
    p.fastMode === body.fastMode &&
    p.defaultMode === body.defaultMode &&
    p.maxMode === body.maxMode &&
    p.worktree === body.worktree &&
    p.maxConcurrent === body.maxConcurrent &&
    p.promptsPerHour === body.promptsPerHour &&
    p.wakesPerSessionDay === body.wakesPerSessionDay &&
    (p.fileMaxBytes === null ? null : Number(p.fileMaxBytes)) === n.fileMaxBytes
  );
}

// ---------------------------------------------------------------- views

/**
 * The profile as its editors see it. `serverMaxBytes` is this server's `OCW_ATTACHMENT_MAX_BYTES` (07.17.1.1, D-07):
 * with the organization's value it is the `limits` the "Largest file" field needs, on every view (a new profile too).
 */
async function profileView(
  tx: Tx,
  perms: PermissionService,
  profile: BotProfileRow | null,
  viewer: { admin: boolean },
  serverMaxBytes: number,
): Promise<BotWorkZoneProfileView> {
  const viewerCan = { edit: true, setOutsideContent: viewer.admin };
  const limits = {
    organizationFileMaxBytes:
      (await loadWorkZonePolicy(tx)).botFileMaxBytes ?? BOT_FILE_LIMITS.defaultMaxBytes,
    serverFileMaxBytes: serverMaxBytes,
  };
  if (!profile)
    return { profile: null, status: { active: false, reason: null, sentence: null }, viewerCan, limits };
  const names = await namesOf(tx, [profile.sponsorUserId, profile.actOnOutsideContentBy]);
  const d = await deviceRow(tx, profile.deviceId);
  const projectRows =
    profile.projectIds.length === 0
      ? []
      : await tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, profile.projectIds))
          .orderBy(asc(projects.name), asc(projects.id));
  const status = await profileStatus(tx, perms, profile);
  const person = (id: string) => ({ id, displayName: (names.get(id) ?? "Former member").slice(0, 200) });
  return {
    profile: {
      id: profile.id,
      agentId: profile.agentId,
      deviceId: profile.deviceId,
      runtime: profile.runtime,
      defaultModel: profile.defaultModel,
      allowedModels: profile.allowedModels,
      defaultEffort: profile.defaultEffort,
      allowedEfforts: profile.allowedEfforts,
      defaultContextWindow:
        profile.defaultContextWindow === null ? null : Number(profile.defaultContextWindow),
      allowedContextWindows: profile.allowedContextWindows.map(Number),
      fastMode: profile.fastMode,
      defaultMode: profile.defaultMode,
      maxMode: profile.maxMode,
      worktree: profile.worktree,
      maxConcurrent: profile.maxConcurrent,
      promptsPerHour: profile.promptsPerHour,
      wakesPerSessionDay: profile.wakesPerSessionDay,
      fileMaxBytes: profile.fileMaxBytes === null ? null : Number(profile.fileMaxBytes),
      actOnOutsideContent: profile.actOnOutsideContent,
      sponsor: person(profile.sponsorUserId),
      device: {
        id: profile.deviceId,
        name: (d?.name ?? "Removed device").slice(0, 120),
        online: d?.status === "online",
        hostKind: d?.hostKind ?? null,
        isolatedServer: d?.isolatedServer ?? false,
      },
      projects: projectRows.map((p) => ({ id: p.id, name: p.name.slice(0, 200) })),
      actOnOutsideContentBy: profile.actOnOutsideContentBy ? person(profile.actOnOutsideContentBy) : null,
      actOnOutsideContentAt: profile.actOnOutsideContentAt ? iso(profile.actOnOutsideContentAt) : null,
      updatedAt: iso(profile.updatedAt),
    },
    status: status.active
      ? { active: true, reason: null, sentence: null }
      : { active: false, reason: status.reason, sentence: BOT_PROFILE_STATUS_SENTENCES[status.reason] },
    viewerCan,
    limits,
  };
}

async function consentsView(tx: Tx, d: DeviceFactsRow, grant: boolean): Promise<DeviceBotConsentsView> {
  const live = await tx
    .select({ c: deviceBotConsents, name: agents.name, handle: agents.username })
    .from(deviceBotConsents)
    .innerJoin(agents, eq(agents.id, deviceBotConsents.agentId))
    .where(
      and(
        eq(deviceBotConsents.deviceId, d.id),
        isNull(deviceBotConsents.revokedAt),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(asc(deviceBotConsents.grantedAt), asc(deviceBotConsents.agentId))
    .limit(100);
  const consented = new Set(live.map((r) => r.c.agentId));
  const asked = (
    await tx
      .select({ p: botWorkZoneProfiles, name: agents.name, handle: agents.username })
      .from(botWorkZoneProfiles)
      .innerJoin(agents, eq(agents.id, botWorkZoneProfiles.agentId))
      .where(and(eq(botWorkZoneProfiles.deviceId, d.id), isNull(agents.deletedAt)))
      .orderBy(asc(botWorkZoneProfiles.updatedAt), asc(botWorkZoneProfiles.agentId))
  )
    .filter((r) => !consented.has(r.p.agentId))
    .slice(0, 100);
  const names = await namesOf(tx, [
    ...live.map((r) => r.c.grantedBy),
    ...asked.map((r) => r.p.sponsorUserId),
  ]);
  const person = (id: string) => ({ id, displayName: (names.get(id) ?? "Former member").slice(0, 200) });
  return {
    consents: live.map((r) => ({
      agentId: r.c.agentId,
      displayName: r.name.slice(0, 200),
      handle: r.handle.slice(0, 64),
      allowFullAccess: r.c.allowFullAccess,
      grantedBy: person(r.c.grantedBy),
      grantedAt: iso(r.c.grantedAt),
    })),
    requests: asked.map((r) => ({
      agentId: r.p.agentId,
      displayName: r.name.slice(0, 200),
      handle: r.handle.slice(0, 64),
      sponsor: person(r.p.sponsorUserId),
      profileUpdatedAt: iso(r.p.updatedAt),
    })),
    viewerCan: { grant },
  };
}

// ---------------------------------------------------------------- routes

export function registerBotProfileRoutes(
  app: App,
  core: Core,
  perms: PermissionService,
  service: AccessSweeper,
): void {
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };
  // 07.17.1.1 (D-07): the server's ceiling, shown with the organization's limit on every profile view.
  const fileCeiling = serverFileMaxBytes(core.env);

  /** The `configurableBot` steps of the bot routes: `bot.read` hidden as 404, then `bot.configure` (403). */
  async function managedBot(req: FastifyRequest, tx: Tx, id: string): Promise<AgentRow> {
    const row = await findBot(tx, id);
    if (!row) throw notFound("Bot not found", "agent_not_found");
    const resource = agentResource(await loadBotFacts(tx, row), authOf(req).userId);
    await perms.assertCan(req, tx, "bot.read", resource, { hideAs404: true });
    await perms.assertCan(req, tx, "bot.configure", resource);
    return row;
  }

  /** The device sweep once the change is committed (07.16-10 makes it agent-aware); one call per device. */
  async function sweep(organizationId: string, deviceIds: readonly string[]) {
    for (const deviceId of unique(deviceIds)) {
      await service.onAccessChanged({ deviceId, organizationId }, "access_changed");
    }
  }

  app.get(
    "/agents/:id/work-zone-profile",
    { ...user, schema: { tags, params: IdParams, response: { 200: BotWorkZoneProfileView } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const bot = await managedBot(req, tx, req.params.id);
        const admin = await perms.can(req, tx, "work_zone.manage", orgResource());
        return profileView(tx, perms, await loadBotProfile(tx, bot.id), { admin }, fileCeiling);
      });
    },
  );

  app.put(
    "/agents/:id/work-zone-profile",
    {
      ...user,
      schema: {
        tags,
        params: IdParams,
        body: BotWorkZoneProfileInput,
        response: { 200: BotWorkZoneProfileView },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const body = req.body;
      const { view, swept } = await core.db.withTenant(tenant(req), async (tx) => {
        const bot = await managedBot(req, tx, req.params.id);
        // One save at a time per bot (the profile's sponsor and flag rules read the stored row).
        await tx.execute(sql`select 1 from app.agents where id = ${bot.id} for update`);
        const existing = await loadBotProfile(tx, bot.id);
        const admin = await perms.can(req, tx, "work_zone.manage", orgResource());
        const stored = existing?.actOnOutsideContent ?? false;
        // A non-admin save that resets the flag anyway (WR-08's rules below) may say so: `false` is not a change.
        const resets =
          !admin &&
          existing !== null &&
          stored &&
          (existing.sponsorUserId !== auth.userId || scopeChanged(existing, body));
        if (
          body.actOnOutsideContent !== stored &&
          !admin &&
          !(resets && body.actOnOutsideContent === false)
        ) {
          throw new HttpError(
            403,
            "outside_content_admin_only",
            "Only an admin can change whether this bot acts on outside content",
          );
        }
        const n = normalize(body, existing);
        const flagOnly =
          admin &&
          existing !== null &&
          body.actOnOutsideContent !== stored &&
          onlyFlagDiffers(existing, body, n);
        const sponsor = flagOnly && existing ? existing.sponsorUserId : auth.userId;
        await validateProfile(tx, perms, sponsor, body, n);

        let flag = body.actOnOutsideContent;
        let flagChange: "set" | "sponsor_changed" | "scope_changed" | null = flag !== stored ? "set" : null;
        if (!admin && existing && stored && existing.sponsorUserId !== auth.userId) {
          flag = false;
          flagChange = "sponsor_changed";
        } else if (!admin && existing && stored && scopeChanged(existing, body)) {
          // Code review WR-08: the admin accepted the warning for this device, runtime, projects and highest mode; a
          // non-admin who changes any of them (the sponsor included) turns the flag off, audited.
          flag = false;
          flagChange = "scope_changed";
        }
        const now = new Date().toISOString();
        const values = {
          sponsorUserId: sponsor,
          deviceId: body.deviceId,
          runtime: body.runtime,
          defaultModel: body.defaultModel,
          allowedModels: n.allowedModels,
          defaultEffort: body.defaultEffort,
          allowedEfforts: n.allowedEfforts,
          defaultContextWindow: body.defaultContextWindow === null ? null : String(body.defaultContextWindow),
          allowedContextWindows: n.allowedContextWindows.map(String),
          fastMode: body.fastMode,
          defaultMode: body.defaultMode,
          maxMode: body.maxMode,
          worktree: body.worktree,
          maxConcurrent: body.maxConcurrent,
          promptsPerHour: body.promptsPerHour,
          wakesPerSessionDay: body.wakesPerSessionDay,
          fileMaxBytes: n.fileMaxBytes,
          actOnOutsideContent: flag,
          actOnOutsideContentBy:
            flagChange === null ? (existing?.actOnOutsideContentBy ?? null) : flag ? auth.userId : null,
          actOnOutsideContentAt:
            flagChange === null ? (existing?.actOnOutsideContentAt ?? null) : flag ? now : null,
          updatedBy: auth.userId,
          updatedAt: now,
        };
        let profileId: string;
        if (existing) {
          // The project rows carry the profile's device in their key: they go first when the device changes.
          await tx
            .delete(botWorkZoneProfileProjects)
            .where(eq(botWorkZoneProfileProjects.profileId, existing.id));
          await tx.update(botWorkZoneProfiles).set(values).where(eq(botWorkZoneProfiles.id, existing.id));
          profileId = existing.id;
        } else {
          const [row] = await tx
            .insert(botWorkZoneProfiles)
            .values({ organizationId: auth.organizationId, agentId: bot.id, ...values })
            .returning({ id: botWorkZoneProfiles.id });
          if (!row) throw new Error("bot work zone profile insert returned no row");
          profileId = row.id;
        }
        await tx.insert(botWorkZoneProfileProjects).values(
          body.projectIds.map((projectId) => ({
            organizationId: auth.organizationId,
            profileId,
            deviceId: body.deviceId,
            projectId,
          })),
        );
        await core.audit.record(tx, {
          action: "bot.work_zone_profile_saved",
          resourceType: "agent",
          resourceId: bot.id,
          agentId: bot.id,
          deviceId: body.deviceId,
          clientKind: auth.clientKind,
          metadata: {
            agentId: bot.id,
            deviceId: body.deviceId,
            projectCount: body.projectIds.length,
            runtime: body.runtime,
            maxMode: body.maxMode,
            sponsorUserId: sponsor,
            ...(existing && existing.deviceId !== body.deviceId
              ? { previousDeviceId: existing.deviceId }
              : {}),
          },
        });
        if (flagChange) {
          await core.audit.record(tx, {
            action: "bot.work_zone_profile_outside_content_changed",
            resourceType: "agent",
            resourceId: bot.id,
            agentId: bot.id,
            deviceId: body.deviceId,
            clientKind: auth.clientKind,
            metadata: { agentId: bot.id, value: flag, sponsorUserId: sponsor, reason: flagChange },
          });
        }
        const saved = await loadBotProfile(tx, bot.id);
        return {
          view: await profileView(tx, perms, saved, { admin }, fileCeiling),
          swept: [...(existing ? [existing.deviceId] : []), body.deviceId],
        };
      });
      await sweep(auth.organizationId, swept);
      return view;
    },
  );

  app.delete(
    "/agents/:id/work-zone-profile",
    { ...user, schema: { tags, params: IdParams, response: { 200: BotWorkZoneProfileView } } },
    async (req) => {
      const auth = authOf(req);
      const { view, deviceId } = await core.db.withTenant(tenant(req), async (tx) => {
        const bot = await managedBot(req, tx, req.params.id);
        const existing = await loadBotProfile(tx, bot.id);
        if (!existing) throw notFound("This bot has no Work Zone profile", "work_zone_profile_not_found");
        // The profile's project rows go with it (ON DELETE CASCADE).
        await tx.delete(botWorkZoneProfiles).where(eq(botWorkZoneProfiles.id, existing.id));
        await core.audit.record(tx, {
          action: "bot.work_zone_profile_deleted",
          resourceType: "agent",
          resourceId: bot.id,
          agentId: bot.id,
          deviceId: existing.deviceId,
          clientKind: auth.clientKind,
          metadata: { agentId: bot.id, deviceId: existing.deviceId, sponsorUserId: existing.sponsorUserId },
        });
        const admin = await perms.can(req, tx, "work_zone.manage", orgResource());
        return {
          view: await profileView(tx, perms, null, { admin }, fileCeiling),
          deviceId: existing.deviceId,
        };
      });
      await sweep(auth.organizationId, [deviceId]);
      return view;
    },
  );

  // ---- device consents (D-03, D-04, D-22, PD-06)

  /** A visible, non-revoked device (404 otherwise) and who may decide its bots: the owner, or an admin on a server. */
  async function consentDevice(req: FastifyRequest, tx: Tx, id: string, lock: boolean) {
    const auth = authOf(req);
    const q = tx.select().from(devices).where(eq(devices.id, id));
    const [d] = lock ? await q.for("update") : await q;
    if (!d || d.revokedAt !== null) throw notFound("Device not found");
    const facts = (await loadDeviceAccess(tx, auth.userId)).facts(d);
    const owner = await perms.can(req, tx, "device.update", facts);
    const admin = await perms.can(req, tx, "work_zone.manage", orgResource());
    return { d, facts, owner, admin, grant: owner || (admin && d.hostKind === "service") };
  }

  app.get(
    "/devices/:id/bot-consents",
    { ...user, schema: { tags, params: IdParams, response: { 200: DeviceBotConsentsView } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const c = await consentDevice(req, tx, req.params.id, false);
        // The owner and admins read the list; anyone else is refused as `device.update` refuses them.
        if (!c.owner && !c.admin) await perms.assertCan(req, tx, "device.update", c.facts);
        return consentsView(tx, c.d, c.grant);
      });
    },
  );

  app.put(
    "/devices/:id/bot-consents/:agentId",
    {
      ...user,
      schema: {
        tags,
        params: ConsentParams,
        body: SetDeviceBotConsentRequest,
        response: { 200: DeviceBotConsentsView },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { view, changed } = await core.db.withTenant(tenant(req), async (tx) => {
        const c = await consentDevice(req, tx, req.params.id, true);
        if (!c.grant) await perms.assertCan(req, tx, "device.update", c.facts);
        const bot = await findBot(tx, req.params.agentId);
        if (!bot) throw notFound("Bot not found", "agent_not_found");
        const { allowFullAccess } = req.body;
        const live = await liveConsent(tx, c.d.id, bot.id, true);
        let action: "device.bot_consent_granted" | "device.bot_consent_updated" | null = null;
        if (!live) {
          await tx.insert(deviceBotConsents).values({
            organizationId: auth.organizationId,
            deviceId: c.d.id,
            agentId: bot.id,
            allowFullAccess,
            grantedBy: auth.userId,
          });
          action = "device.bot_consent_granted";
        } else if (live.allowFullAccess !== allowFullAccess) {
          await tx
            .update(deviceBotConsents)
            .set({ allowFullAccess, updatedAt: new Date().toISOString() })
            .where(eq(deviceBotConsents.id, live.id));
          action = "device.bot_consent_updated";
        }
        if (action) {
          await core.audit.record(tx, {
            action,
            resourceType: "device",
            resourceId: c.d.id,
            deviceId: c.d.id,
            agentId: bot.id,
            clientKind: auth.clientKind,
            metadata: { deviceId: c.d.id, agentId: bot.id, allowFullAccess },
          });
        }
        return { view: await consentsView(tx, c.d, c.grant), changed: action !== null };
      });
      if (changed) await sweep(auth.organizationId, [req.params.id]);
      return view;
    },
  );

  app.delete(
    "/devices/:id/bot-consents/:agentId",
    { ...user, schema: { tags, params: ConsentParams, response: { 200: DeviceBotConsentsView } } },
    async (req) => {
      const auth = authOf(req);
      const view = await core.db.withTenant(tenant(req), async (tx) => {
        const c = await consentDevice(req, tx, req.params.id, true);
        if (!c.grant) await perms.assertCan(req, tx, "device.update", c.facts);
        // Soft revocation: the row stays (history), the bot loses the device at once.
        const [revoked] = await tx
          .update(deviceBotConsents)
          .set({ revokedAt: new Date().toISOString(), revokedBy: auth.userId })
          .where(
            and(
              eq(deviceBotConsents.deviceId, c.d.id),
              eq(deviceBotConsents.agentId, req.params.agentId),
              isNull(deviceBotConsents.revokedAt),
            ),
          )
          .returning({ allowFullAccess: deviceBotConsents.allowFullAccess });
        if (!revoked) throw notFound("This bot has no consent on this device", "bot_consent_not_found");
        await core.audit.record(tx, {
          action: "device.bot_consent_revoked",
          resourceType: "device",
          resourceId: c.d.id,
          deviceId: c.d.id,
          agentId: req.params.agentId,
          clientKind: auth.clientKind,
          metadata: {
            deviceId: c.d.id,
            agentId: req.params.agentId,
            allowFullAccess: revoked.allowFullAccess,
          },
        });
        return consentsView(tx, c.d, c.grant);
      });
      await sweep(auth.organizationId, [req.params.id]);
      return view;
    },
  );
}
