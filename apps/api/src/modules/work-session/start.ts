import {
  type AuthzDenial,
  type ControlDenialReason,
  type CreateWorkSessionRequest,
  type RuntimeId,
  RuntimeInfo,
  type SessionAudienceInput,
  type SessionSettingsPatch,
  slashDisposition,
  type WorkSession,
} from "@ocw/contracts";
import {
  conversationMembers,
  conversations,
  devices,
  projects,
  type Tx,
  tenantOf,
  workPrompts,
  workSessions,
} from "@ocw/db";
import { eq, max } from "drizzle-orm";
import { z } from "zod";
import type { Core } from "../../core";
import { linkWorkPromptAttachments } from "../artifact";
import { type DeviceHub, deviceFacts, loadDeviceAccess } from "../device";
import { AuthzDeniedError, orgResource, type PermissionService } from "../organization";
import { loadControlsContext } from "./context";
import { buildRuntimeControls, decideSettings, highestAvailableMode, storedSettings } from "./controls";
import { checkImageBudget } from "./images";
import { defaultVisibilityOf } from "./projects";
import type { SessionRow, WorkSessionService } from "./service";
import { heuristicTitle } from "./title";
import { applyAudience, audienceTarget, checkAudience, projectAccessDenial } from "./visibility";

/**
 * Phase 07.5-05 (D-03, D-04, APPROVE-03, APPROVE-04): the ONE way a Work Zone session is created. `POST
 * /work-sessions` calls it for the signed-in member; a Work Zone proposal's Start (07.5-08) calls it for the deciding
 * member, so a session a bot proposed passes exactly the checks a person's click does (ADR-0012: policy ∩ opt-in ∩
 * cap ∩ grain), runs in that person's name and is never started above `default` without an explicit mode.
 */

/** Why a start was refused. Every one is returned before the first write. */
export type WorkSessionStartCode =
  | "not_allowed"
  | "project_not_found"
  | "device_not_shared"
  | "device_offline"
  | "runtime_unavailable"
  | "settings_denied"
  | "prompt_not_allowed"
  | "not_in_project"
  | "audience_outside_project"
  | "team_not_assigned";

export type WorkSessionStartFailure =
  | {
      ok: false;
      /** `work_session.create` (Work Zone module deny included) or `device.use` refused: the resolver's denial. */
      code: "not_allowed" | "device_not_shared";
      message: string;
      denial: AuthzDenial;
    }
  | {
      ok: false;
      code: "project_not_found";
      message: string;
      /** The project exists but is on another device than the one asked for. */
      reason?: "other_device";
    }
  | {
      ok: false;
      /** D-13: the repository is in a team project the actor has no access to (the resolver's denial). */
      code: "not_in_project";
      message: string;
      denial: AuthzDenial;
    }
  | {
      ok: false;
      /** D-04: the asked audience reaches beyond the project (the offending entry ids, never names). */
      code: "audience_outside_project" | "team_not_assigned";
      message: string;
      ids: string[];
    }
  | { ok: false; code: "device_offline" | "runtime_unavailable" | "prompt_not_allowed"; message: string }
  | { ok: false; code: "settings_denied"; message: string; field: string; reason: ControlDenialReason };

export type WorkSessionStartResult = { ok: true; session: WorkSession } | WorkSessionStartFailure;

/** The member the session is created for (the signed-in user, or the person who pressed Start). */
export interface WorkSessionActor {
  userId: string;
  organizationId: string;
  /** The member's client (web, desktop, mobile) for the audit rows; null when unknown. */
  clientKind: string | null;
}

export interface WorkSessionStartDeps {
  core: Pick<Core, "audit">;
  perms: PermissionService;
  svc: WorkSessionService;
  hub: DeviceHub;
}

/** `CreateWorkSessionRequest` before defaults: a proposal passes only projectId, deviceId, runtime and prompt. */
export type WorkSessionStartInput = CreateWorkSessionRequest;

export interface WorkSessionStartOptions {
  /** The bot whose proposal this start comes from: marks the first prompt and the creation audit. */
  proposedByAgentId?: string;
  /** The approval that started it (audit only). */
  approvalId?: string;
}

const RUNTIME_LABEL = { "claude-code": "Claude Code", codex: "Codex" } as const;

// ---------------------------------------------------------------- settings denials (P-08)

/** P-08: the resolver layer a settings denial belongs to. */
const DENIAL_LAYER: Record<ControlDenialReason, AuthzDenial["layer"]> = {
  org_policy: "org",
  device_opt_in: "device",
  device_grant: "device",
  denied_for_you: "user",
  runtime: "resource",
  not_in_catalog: "resource",
  not_confirmed: "resource",
};

const DENIAL_MESSAGE: Record<ControlDenialReason, string> = {
  org_policy: "Your organization's Work Zone policy does not allow this",
  device_opt_in: "Full access is turned off on this device",
  device_grant: "This is above what you may use on this device",
  denied_for_you: "You are not allowed to use this on this device",
  runtime: "The runtime on this device does not offer this",
  not_in_catalog: "The runtime on this device did not report this option",
  not_confirmed: "This option is not available yet",
};

const FIELD_LABEL: Record<string, string> = {
  model: "Model",
  effort: "Reasoning",
  contextWindow: "Context window",
  fastMode: "Fast mode",
  permissionMode: "Permission mode",
};

/** A refused settings change (P-08): 403 with the layer and reason; audited as `authz.denied` by the handler. */
export function settingsDenied(field: string, reason: ControlDenialReason): AuthzDeniedError {
  return new AuthzDeniedError(
    { permission: "work_session.configure", layer: DENIAL_LAYER[reason], reason },
    { message: `${FIELD_LABEL[field] ?? field}: ${DENIAL_MESSAGE[reason]}` },
  );
}

/** What a member is told when `device.use` refuses a device for a new session. */
export function deviceUnusableMessage(denial: AuthzDenial, deviceName: string): string {
  return denial.reason === "device_revoked"
    ? `${deviceName} was revoked. Pair it again to use it.`
    : "This device is not shared with you. Ask its owner to share it.";
}

/**
 * D-13: a prompt that starts with a settings or refused slash command never enters the queue (it goes through `POST
 * /work-sessions/:id/commands`). Checked on the trimmed prompt (P-08): leading spaces or newlines never hide one.
 */
export function isSessionCommand(prompt: string, runtime: RuntimeId): boolean {
  const disposition = slashDisposition(prompt.trim(), runtime);
  return disposition?.kind === "settings" || disposition?.kind === "refused";
}

export const SLASH_COMMAND_MESSAGE = "Send slash commands from the composer";

/** D-13: what a member is told when a repository's team project does not include them. */
export const NOT_IN_PROJECT_MESSAGE =
  "This repository belongs to a team project you are not in. Ask one of its leads to add you.";

// ---------------------------------------------------------------- start

export async function createWorkSession(
  tx: Tx,
  deps: WorkSessionStartDeps,
  actor: WorkSessionActor,
  input: WorkSessionStartInput,
  opts: WorkSessionStartOptions = {},
): Promise<WorkSessionStartResult> {
  const { core, perms, svc, hub } = deps;
  // The transaction is the actor's own: RLS and every audit row default to its tenant context.
  const ctxOfTx = tenantOf(tx);
  if (ctxOfTx.organizationId !== actor.organizationId || ctxOfTx.userId !== actor.userId) {
    throw new Error("createWorkSession must run in the actor's tenant transaction");
  }
  const principal = { kind: "user" as const, userId: actor.userId };
  const runtimeId = input.runtime ?? "claude-code";
  const prompt = input.prompt?.trim();

  const create = await perms.decide(tx, principal, "work_session.create", orgResource());
  if (!create.allowed) {
    const denial = create.denial ?? {
      permission: "work_session.create" as const,
      layer: "role" as const,
      reason: "missing_permission" as const,
    };
    return { ok: false, code: "not_allowed", message: new AuthzDeniedError(denial).message, denial };
  }
  if (prompt !== undefined && (prompt === "" || isSessionCommand(prompt, runtimeId))) {
    return { ok: false, code: "prompt_not_allowed", message: SLASH_COMMAND_MESSAGE };
  }
  const [row] = await tx
    .select({ p: projects, d: devices })
    .from(projects)
    .innerJoin(devices, eq(devices.id, projects.deviceId))
    .where(eq(projects.id, input.projectId));
  if (!row || row.p.removedAt) return { ok: false, code: "project_not_found", message: "Project not found" };
  const { p, d } = row;
  if (input.deviceId && input.deviceId !== d.id) {
    return {
      ok: false,
      code: "project_not_found",
      message: "The project belongs to another device",
      reason: "other_device",
    };
  }
  // Device layer: own, shared or granted (device_not_shared), never revoked (device_revoked).
  const access = await loadDeviceAccess(tx, actor.userId);
  const use = await perms.decide(tx, principal, "device.use", deviceFacts(d, actor.userId, access));
  if (!use.allowed) {
    const denial = use.denial ?? {
      permission: "device.use" as const,
      layer: "role" as const,
      reason: "missing_permission" as const,
    };
    return { ok: false, code: "device_not_shared", message: deviceUnusableMessage(denial, d.name), denial };
  }
  // D-13 (P-12): a repository linked to a team project also needs project access.
  const target = await audienceTarget(tx, p.id);
  if (!target) return { ok: false, code: "project_not_found", message: "Project not found" };
  if (target.unit) {
    const denial = await projectAccessDenial(tx, perms, actor.userId, target.unit);
    if (denial) return { ok: false, code: "not_in_project", message: NOT_IN_PROJECT_MESSAGE, denial };
  }
  if (d.status !== "online") {
    return { ok: false, code: "device_offline", message: `${d.name} is offline. Start the desktop app.` };
  }
  const runtime = z
    .array(RuntimeInfo)
    .catch([])
    .parse(d.runtimeInfo)
    .find((r) => r.id === runtimeId);
  if (!runtime?.installed) {
    return {
      ok: false,
      code: "runtime_unavailable",
      message: `${RUNTIME_LABEL[runtimeId]} is not installed on ${d.name}`,
    };
  }
  if (!runtime.loggedIn) {
    return {
      ok: false,
      code: "runtime_unavailable",
      message: `${RUNTIME_LABEL[runtimeId]} is not signed in on ${d.name}. Sign in from a terminal first.`,
    };
  }
  // The start settings go through the same decision as a change (ADR-0012: full access needs policy ∩
  // opt-in ∩ grain). The model keeps today's free choice here; a change inside the session is catalog-checked.
  const loaded = await loadControlsContext(tx, perms, {
    deviceId: d.id,
    runtime: runtimeId,
    userId: actor.userId,
    inSession: false,
    access,
  });
  if (!loaded) return { ok: false, code: "project_not_found", message: "Device not found" };
  const ctx = loaded.ctx;
  // The start mode is always within the creator's intersection: an explicit mode is refused with its reason;
  // the implicit default is lowered to the highest available mode under it (e.g. a grant capped at plan). A
  // proposal never passes a mode, so it starts at `default` or lower, never higher (APPROVE-04).
  let startMode = input.permissionMode ?? "default";
  const startOption = buildRuntimeControls(runtimeId, ctx, input.model ?? null).permissionModes.find(
    (m) => m.value === startMode,
  );
  if (!startOption?.available) {
    const lower =
      input.permissionMode === undefined ? highestAvailableMode(ctx, input.model ?? null, startMode) : null;
    if (!lower) return settingsFailure("permissionMode", startOption?.reason ?? "runtime");
    startMode = lower;
  }
  const startPatch: SessionSettingsPatch = {
    permissionMode: startMode,
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  };
  const baseline = {
    model: input.model ?? null,
    effort: null,
    contextWindow: null,
    fastMode: false,
    permissionMode: "default" as const,
  };
  const start = decideSettings(baseline, startPatch, runtimeId, ctx);
  if (!start.ok) return settingsFailure(start.field, start.reason);
  // D-03, D-04: the asked audience, validated against the project's access, or the project's default (`project` when
  // its switch is on, `owner` when off; a personal repository: `project`). A proposal never passes one.
  const audience: SessionAudienceInput = input.visibility ?? {
    kind: target.unit ? await defaultVisibilityOf(tx, target.unit.id) : "project",
  };
  if (input.visibility) {
    const refused = await checkAudience(tx, target, input.visibility, actor.userId);
    if (refused) return { ok: false, ...refused };
  }

  // ---- no refusal past this line: every write happens below.
  const title = input.title ?? heuristicTitle(prompt) ?? `${p.name} · ${RUNTIME_LABEL[runtimeId]}`;
  const [conv] = await tx
    .insert(conversations)
    .values({
      organizationId: actor.organizationId,
      kind: "work_session",
      name: title,
      visibility: "public",
      createdBy: actor.userId,
    })
    .returning({ id: conversations.id });
  const [s] = await tx
    .insert(workSessions)
    .values({
      organizationId: actor.organizationId,
      conversationId: conv!.id,
      projectId: p.id,
      deviceId: d.id,
      runtime: runtimeId,
      model: input.model ?? null,
      permissionMode: start.next.permissionMode ?? "default",
      settings: storedSettings(start.next),
      worktree: input.worktree ?? false,
      branch: input.worktree ? null : p.defaultBranch,
      status: "provisioning",
      title,
      // D-19, P-14: a typed title is never replaced; otherwise the first prompt may get an automatic one.
      titleSource: input.title ? "user" : "heuristic",
      createdBy: actor.userId,
      visibility: audience.kind,
    })
    .returning();
  // The chosen teams or people as grants (the same writer as the visibility PUT).
  if (audience.kind === "teams" || audience.kind === "people") {
    await applyAudience(tx, s!.id, audience, actor.userId);
  }
  // Participation only, never the audience (ADR-0019).
  await joinConversation(tx, actor, s!);
  await hub.enqueue(tx, {
    deviceId: d.id,
    workSessionId: s!.id,
    kind: "session.start",
    payload: await svc.startPayload(tx, s!),
  });
  await core.audit.record(tx, {
    action: "work_session.created",
    resourceType: "work_session",
    resourceId: s!.id,
    sessionId: s!.id,
    deviceId: d.id,
    clientKind: actor.clientKind,
    metadata: {
      projectId: p.id,
      runtime: s!.runtime,
      permissionMode: s!.permissionMode,
      worktree: s!.worktree,
      // The audience kind only, never who is in it (D-04).
      visibility: audience.kind,
      ...(opts.proposedByAgentId ? { proposedByAgentId: opts.proposedByAgentId } : {}),
      ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
    },
  });
  if (prompt) {
    await queueWorkPrompt(tx, deps, actor, s!, prompt, [], {
      ...(opts.proposedByAgentId ? { proposedByAgentId: opts.proposedByAgentId } : {}),
    });
  }
  const dto = await svc.emitSession(tx, s!.id);
  return { ok: true, session: dto! };
}

function settingsFailure(field: string, reason: ControlDenialReason): WorkSessionStartFailure {
  return {
    ok: false,
    code: "settings_denied",
    message: settingsDenied(field, reason).message,
    field,
    reason,
  };
}

// ---------------------------------------------------------------- helpers shared with the prompt routes

/** The member joins the session's conversation (owner when they created the session). */
export async function joinConversation(tx: Tx, actor: WorkSessionActor, s: SessionRow): Promise<void> {
  await tx
    .insert(conversationMembers)
    .values({
      conversationId: s.conversationId,
      organizationId: actor.organizationId,
      memberKind: "user",
      memberId: actor.userId,
      role: s.createdBy === actor.userId ? "owner" : "member",
    })
    .onConflictDoNothing();
}

/**
 * Queue a prompt authored by `actor` at the end of the session's queue (images linked and budget-checked), audit
 * and emit it, and ask for a title on the session's first prompt. `proposedByAgentId` marks a bot's proposal.
 */
export async function queueWorkPrompt(
  tx: Tx,
  deps: Pick<WorkSessionStartDeps, "core" | "svc">,
  actor: WorkSessionActor,
  s: SessionRow,
  body: string,
  attachmentIds: readonly string[] = [],
  opts: { proposedByAgentId?: string } = {},
) {
  const { core, svc } = deps;
  const [{ pos } = { pos: 0 }] = await tx
    .select({ pos: max(workPrompts.position) })
    .from(workPrompts)
    .where(eq(workPrompts.workSessionId, s.id));
  const [p] = await tx
    .insert(workPrompts)
    .values({
      organizationId: actor.organizationId,
      workSessionId: s.id,
      authorUserId: actor.userId,
      originDeviceId: null,
      body,
      position: Number(pos ?? 0) + 1,
      ...(opts.proposedByAgentId ? { proposedByAgentId: opts.proposedByAgentId } : {}),
    })
    .returning();
  // 06.1 (P-05): the sender's own ready images of this session's conversation, or one uniform 409 (the whole
  // transaction rolls back: nothing is queued, sent or audited).
  const images = await linkWorkPromptAttachments(tx, {
    conversationId: s.conversationId,
    workPromptId: p!.id,
    uploaderId: actor.userId,
    ids: [...attachmentIds],
  });
  // WZ-IMG-02 (P-01, P-03): each image as sent fits 2 MiB, from the sizes recorded at upload (no storage call
  // while the session row is locked); otherwise 400 image_too_large and the transaction rolls back.
  checkImageBudget(images);
  await core.audit.record(tx, {
    action: "work_prompt.queued",
    resourceType: "work_prompt",
    resourceId: p!.id,
    sessionId: s.id,
    deviceId: s.deviceId,
    clientKind: actor.clientKind,
    metadata: {
      promptId: p!.id,
      authorUserId: actor.userId,
      originDeviceId: null,
      executionDeviceId: s.deviceId,
      workSessionId: s.id,
      length: body.length,
      // Ids and a count only, never bytes (D-03).
      ...(images.length > 0 ? { attachmentIds: images.map((a) => a.id), imageCount: images.length } : {}),
    },
  });
  await svc.emitPrompt(tx, p!);
  // D-18, P-18: the session's first prompt (not a slash command) asks its device for a short title, unless a
  // user typed one. At most once: later prompts never ask.
  if (pos === null && s.titleSource === "heuristic" && !slashDisposition(body, s.runtime)) {
    await svc.requestTitle(tx, s, body, actor.clientKind);
  }
  return p!;
}
