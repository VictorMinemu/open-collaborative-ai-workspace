import {
  type AgentCardField,
  type AgentChannelWorkZoneProjectsResponse,
  type AgentChannelWorkZonePropose,
  type AgentChannelWorkZoneProposeResponse,
  type ApprovalHeadline,
  ApprovalOrigin,
  type ApprovalView,
  type RuntimeId,
  RuntimeInfo,
  WORK_ZONE_PROPOSAL_LIMITS,
  WORK_ZONE_START_KIND,
  type WorkZoneProposalRefusal,
  type WorkZoneProposalView,
  type WorkZoneStartBlock,
} from "@ocw/contracts";
import {
  agents,
  type agentTurns,
  approvalRequests,
  conversations,
  devices,
  messages,
  orgMembers,
  orgUnits,
  projects,
  type Tx,
  tenantOf,
  workProjectRepos,
  workZoneProposals,
} from "@ocw/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import { conflict } from "../../lib/errors";
import type { ApplyResult, ApprovalKind, ApprovalService } from "../approval";
import { deviceFacts, loadDeviceAccess } from "../device";
import { orgResource, type PermissionService } from "../organization";
import { projectFacts } from "./projects";
import {
  isSessionCommand,
  type WorkSessionActor,
  type WorkSessionStartInput,
  type WorkSessionStartOptions,
  type WorkSessionStartResult,
} from "./start";
import { audienceTarget, projectAccessDenial } from "./visibility";

/**
 * Phase 07.5-08 (D-03, D-04, P-08, APPROVE-03, APPROVE-04): Work Zone proposals. A bot proposes a session (project,
 * device, prompt, runtime; never a mode, model or setting) for the human of its turn; the proposal is stored, mirrored
 * as a platform-owned `work_zone` card in the turn's conversation, and only that human may start it. Start runs
 * `createWorkSession` as them, in their own decision transaction, so it passes exactly the checks a person's click
 * does and never starts above `default`. Every id is resolved inside the caller's tenant transaction (RLS): several
 * proposal columns (conversation, event, requester) have no foreign key. Audit rows carry ids and the prompt's length,
 * never the prompt.
 */

type AgentTurnRow = typeof agentTurns.$inferSelect;
type ProposalRow = typeof workZoneProposals.$inferSelect;
type DeviceRow = typeof devices.$inferSelect;

export const WORK_ZONE_PROPOSAL_RESOURCE = "work_zone_proposal";

/** `createWorkSession` with its dependencies bound (the work-session module's `start`). */
export type WorkSessionStartFn = (
  tx: Tx,
  actor: WorkSessionActor,
  input: WorkSessionStartInput,
  opts?: WorkSessionStartOptions,
) => Promise<WorkSessionStartResult>;

export interface WorkZoneProposalDeps {
  core: Pick<Core, "audit">;
  perms: PermissionService;
  start: WorkSessionStartFn;
  approvals: Pick<ApprovalService, "request">;
}

/** What the Agent Channel routes call (the work-session module's `proposals`). */
export interface WorkZoneProposalService {
  propose(
    tx: Tx,
    p: { turn: AgentTurnRow; input: AgentChannelWorkZonePropose },
  ): Promise<AgentChannelWorkZoneProposeResponse>;
  listProjects(tx: Tx, p: { turn: AgentTurnRow }): Promise<AgentChannelWorkZoneProjectsResponse>;
}

const RUNTIME_LABEL: Record<RuntimeId, string> = { "claude-code": "Claude Code", codex: "Codex" };
/** The proposal input has no runtime: the default runtime of a session start (`createWorkSession`). */
const DEFAULT_RUNTIME: RuntimeId = "claude-code";
/** `permissionModeMeta("default").label` (UI-SPEC R8): the only mode a proposal ever starts in. */
const MODE_LABEL = "Supervised";
const GONE_TITLE = "This proposal no longer exists.";
const MAX_PROJECTS = 50;

const runtimesOf = (d: DeviceRow): RuntimeInfo[] => z.array(RuntimeInfo).catch([]).parse(d.runtimeInfo);

/** The card's prompt excerpt: at most 500 UTF-16 units, never a split surrogate pair. */
function excerpt(prompt: string): string {
  const max = WORK_ZONE_PROPOSAL_LIMITS.excerptChars;
  if (prompt.length <= max) return prompt;
  let cut = prompt.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const titleOf = (projectName: string) => `Start a session in ${projectName}`.slice(0, 200);

async function loadProposal(tx: Tx, id: string): Promise<ProposalRow | null> {
  const [p] = await tx.select().from(workZoneProposals).where(eq(workZoneProposals.id, id)).limit(1);
  return p ?? null;
}

/** `work_session.create` for a member, decided by the resolver (07.3's Work Zone module deny included). */
async function mayCreate(tx: Tx, perms: PermissionService, userId: string): Promise<boolean> {
  return (await perms.decide(tx, { kind: "user", userId }, "work_session.create", orgResource())).allowed;
}

/** `device.use` for a member on a device (own, shared or granted; never revoked), as a human start decides it. */
async function mayUse(tx: Tx, perms: PermissionService, userId: string, d: DeviceRow): Promise<boolean> {
  const access = await loadDeviceAccess(tx, userId);
  return (await perms.decide(tx, { kind: "user", userId }, "device.use", deviceFacts(d, userId, access)))
    .allowed;
}

/** Project access for a repository linked to a team project (D-13), as `createWorkSession` decides it; true for others. */
async function mayStartIn(
  tx: Tx,
  perms: PermissionService,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const target = await audienceTarget(tx, projectId);
  if (!target?.unit) return true;
  return (await projectAccessDenial(tx, perms, userId, target.unit)) === null;
}

async function namesOf(tx: Tx, p: Pick<ProposalRow, "agentId" | "requestedForUserId">) {
  const [bot] = await tx
    .select({ name: agents.name, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, p.agentId))
    .limit(1);
  const [person] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, p.requestedForUserId))
    .limit(1);
  return {
    bot: bot && bot.deletedAt === null ? bot.name : "Deleted bot",
    person: person?.name ?? "Former member",
  };
}

async function originOf(tx: Tx, conversationId: string): Promise<ApprovalOrigin | null> {
  const [conv] = await tx
    .select({ kind: conversations.kind, name: conversations.name })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return null;
  const parsed = ApprovalOrigin.safeParse({
    kind: conv.kind,
    name: conv.kind === "dm" ? null : (conv.name?.slice(0, 200) ?? null),
  });
  return parsed.success ? parsed.data : null;
}

interface LiveState {
  project: { id: string; name: string; removed: boolean };
  device: { id: string; name: string; online: boolean; usable: boolean };
  runtime: { id: RuntimeId; label: string; available: boolean };
  /** Why the requester cannot start it right now (null: they can). */
  blocked: WorkZoneStartBlock | null;
}

/**
 * The proposal's project, device and runtime as they are NOW, for its requester (the only decider): the card's
 * device state, the review's facts and `startBlocked` (UI-SPEC R9). Start re-checks all of it in `createWorkSession`.
 */
async function liveState(tx: Tx, perms: PermissionService, p: ProposalRow): Promise<LiveState> {
  const [proj] = await tx.select().from(projects).where(eq(projects.id, p.projectId)).limit(1);
  const [dev] = await tx.select().from(devices).where(eq(devices.id, p.deviceId)).limit(1);
  const allowed = await mayCreate(tx, perms, p.requestedForUserId);
  const usable = dev ? await mayUse(tx, perms, p.requestedForUserId, dev) : false;
  const rt = dev ? runtimesOf(dev).find((r) => r.id === p.runtime) : undefined;
  const available = rt?.installed === true && rt.loggedIn === true;
  const removed = !proj || proj.removedAt !== null || proj.deviceId !== p.deviceId;
  const online = dev?.status === "online";
  // D-13 (P-12), in `createWorkSession`'s order: a repository of a team project also needs project access.
  const inProject = removed ? true : await mayStartIn(tx, perms, p.requestedForUserId, p.projectId);
  const blocked: WorkZoneStartBlock | null = !allowed
    ? "not_allowed"
    : removed
      ? "project_not_found"
      : !usable
        ? "device_not_shared"
        : !inProject
          ? "not_in_project"
          : !online
            ? "device_offline"
            : !available
              ? "runtime_unavailable"
              : null;
  return {
    project: { id: p.projectId, name: (proj?.name ?? "Removed project").slice(0, 200), removed },
    device: { id: p.deviceId, name: (dev?.name ?? "Removed device").slice(0, 120), online, usable },
    runtime: { id: p.runtime, label: RUNTIME_LABEL[p.runtime], available },
    blocked,
  };
}

// ---------------------------------------------------------------- the approval kind

/**
 * `work_zone.start` (`server_apply`, 24 h): Start creates the session as the person who pressed it, who must be the
 * human the bot proposed it for and still hold `work_session.create`. `device.use`, the device's state and the runtime
 * are checked by `createWorkSession` inside `apply`, so a share revoked or a device gone offline since the proposal is
 * a failed request with that code (the card says why), never a session.
 */
export function workZoneStartKind(deps: Pick<WorkZoneProposalDeps, "perms" | "start">): ApprovalKind {
  const { perms } = deps;
  return {
    kind: WORK_ZONE_START_KIND,
    mode: "server_apply",
    resourceType: WORK_ZONE_PROPOSAL_RESOURCE,
    ttlMs: WORK_ZONE_PROPOSAL_LIMITS.pendingTtlMs,

    async hashInput(tx, row) {
      const p = await loadProposal(tx, row.resourceId);
      if (!p) throw conflict(GONE_TITLE, "proposal_gone");
      return [p.agentId, p.requestedForUserId, p.projectId, p.deviceId, p.runtime, sha256Hex(p.prompt)];
    },

    async canDecide(tx, deciderUserId, row) {
      const p = await loadProposal(tx, row.resourceId);
      if (!p || deciderUserId !== p.requestedForUserId || deciderUserId !== row.requestedForUserId)
        return false;
      return mayCreate(tx, perms, deciderUserId);
    },

    async audience(tx, row) {
      const p = await loadProposal(tx, row.resourceId);
      return p ? [p.requestedForUserId] : [];
    },

    async gone(tx, row) {
      const p = await loadProposal(tx, row.resourceId);
      if (!p) return "proposal_gone";
      const [bot] = await tx
        .select({ deletedAt: agents.deletedAt })
        .from(agents)
        .where(eq(agents.id, p.agentId))
        .limit(1);
      return !bot || bot.deletedAt !== null ? "bot_deleted" : null;
    },

    async view(tx, row): Promise<ApprovalView> {
      const p = await loadProposal(tx, row.resourceId);
      if (!p) return { type: "fields", title: GONE_TITLE, fields: [] };
      const live = await liveState(tx, perms, p);
      const who = await namesOf(tx, p);
      const view: WorkZoneProposalView = {
        type: "work_zone_proposal",
        title: titleOf(live.project.name),
        project: live.project,
        device: live.device,
        runtime: live.runtime,
        mode: "default",
        prompt: p.prompt,
        agent: { id: p.agentId, displayName: who.bot.slice(0, 200) },
        requestedFor: { id: p.requestedForUserId, displayName: who.person.slice(0, 200) },
        origin: await originOf(tx, p.conversationId),
        workSessionId: p.workSessionId,
        startBlocked: row.status === "pending" ? live.blocked : null,
      };
      return view;
    },

    async headline(tx, row): Promise<ApprovalHeadline> {
      const p = await loadProposal(tx, row.resourceId);
      if (!p) return { title: GONE_TITLE, context: null, requester: "", tags: [] };
      const live = await liveState(tx, perms, p);
      const who = await namesOf(tx, p);
      return {
        title: titleOf(live.project.name),
        context: `${live.device.name} · ${live.runtime.label}`.slice(0, 120),
        requester: `${who.bot} for ${who.person}`.slice(0, 200),
        tags: [],
        agent: { id: p.agentId, displayName: who.bot.slice(0, 200) },
        origin: await originOf(tx, p.conversationId),
        chips: [
          {
            kind: "device",
            label: live.device.name.slice(0, 80),
            state: live.device.online ? "online" : "offline",
          },
        ],
      };
    },

    async link(tx, row) {
      const p = await loadProposal(tx, row.resourceId);
      if (!p) return { display: "exact", deviceId: null, resultRoute: null, blocked: null };
      const pending = row.status === "pending";
      return {
        display: "exact",
        deviceId: p.deviceId,
        resultRoute: row.status === "applied" && p.workSessionId ? `/work-zone/${p.workSessionId}` : null,
        blocked: pending ? (await liveState(tx, perms, p)).blocked : null,
      };
    },

    async card(tx, row) {
      const p = await loadProposal(tx, row.resourceId);
      if (!p) throw conflict(GONE_TITLE, "proposal_gone");
      const live = await liveState(tx, perms, p);
      const who = await namesOf(tx, p);
      const title = titleOf(live.project.name);
      const shown = excerpt(p.prompt);
      const fields: AgentCardField[] = [
        { label: "Project", value: live.project.name },
        { label: "Device", value: `${live.device.name} · ${live.device.online ? "Online" : "Offline"}` },
        { label: "Runtime", value: live.runtime.label },
        { label: "Mode", value: MODE_LABEL },
        { label: "For", value: `${who.person} · proposed by ${who.bot}`.slice(0, 500) },
        { label: "Prompt", value: shown },
      ];
      return {
        cardKind: "work_zone",
        card: {
          kind: "work_zone",
          title,
          fields,
          status: "pending",
          actions: [{ kind: "open", label: "Review", target: `/approvals/${row.id}` }],
          summary: shown,
        },
        labels: { approve: "Start session", deny: "Dismiss", open: "Review" },
      };
    },

    async apply(tx, row, ctx): Promise<ApplyResult> {
      const p = await loadProposal(tx, row.resourceId);
      if (!p) return { ok: false, code: "proposal_gone" };
      // Defence in depth: `canDecide` already required the requester; the session is theirs or nobody's.
      if (ctx.deciderUserId !== p.requestedForUserId) return { ok: false, code: "not_allowed" };
      const { organizationId } = tenantOf(tx);
      // Only these four fields: no mode, model or setting, so the session starts at `default` (or lower).
      const res = await deps.start(
        tx,
        { userId: ctx.deciderUserId, organizationId, clientKind: null },
        { projectId: p.projectId, deviceId: p.deviceId, runtime: p.runtime, prompt: p.prompt },
        { proposedByAgentId: p.agentId, approvalId: row.id },
      );
      if (!res.ok) return { ok: false, code: res.code };
      await tx
        .update(workZoneProposals)
        .set({ workSessionId: res.session.id })
        .where(eq(workZoneProposals.id, p.id));
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------- proposing

/**
 * Proposes a session for the turn's human. The route has already found the live turn, required the tool in it and
 * claimed the call as side-effecting (so a tainted turn never gets here). Checks, in order, in this one transaction:
 * `work_session.create` → slash-command prompt → project on `deviceId` → `device.use` → online → runtime installed and
 * signed in → an identical proposal (same approval back) → at most 3 pending per (bot, human) → store, request, card.
 * A refusal stores and posts nothing and is audited with its code.
 */
export async function proposeWorkZone(
  tx: Tx,
  deps: WorkZoneProposalDeps,
  p: { turn: AgentTurnRow; input: AgentChannelWorkZonePropose },
): Promise<AgentChannelWorkZoneProposeResponse> {
  const { core, perms } = deps;
  const { turn, input } = p;
  const human = turn.userId;
  const runtime = input.runtime ?? DEFAULT_RUNTIME;
  const prompt = input.prompt.trim();
  const ids = { eventId: turn.eventId, projectId: input.projectId, deviceId: input.deviceId, runtime };

  const refuse = async (code: WorkZoneProposalRefusal): Promise<AgentChannelWorkZoneProposeResponse> => {
    await core.audit.record(tx, {
      action: "work_zone.proposal_refused",
      resourceType: "agent",
      resourceId: turn.agentId,
      result: "denied",
      actorKind: "agent",
      actorId: turn.agentId,
      agentId: turn.agentId,
      userId: human,
      clientKind: "agent",
      metadata: { reason: code, ...ids, promptChars: prompt.length },
    });
    return { refused: code };
  };

  if (!(await mayCreate(tx, perms, human))) return refuse("not_allowed");
  // A bot never changes session settings by prompt (D-13, P-08): checked on the trimmed prompt.
  if (prompt === "" || isSessionCommand(prompt, runtime)) return refuse("prompt_not_allowed");
  const [found] = await tx
    .select({ p: projects, d: devices })
    .from(projects)
    .innerJoin(devices, eq(devices.id, projects.deviceId))
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!found || found.p.removedAt !== null || found.p.deviceId !== input.deviceId) {
    return refuse("project_not_found");
  }
  const d = found.d;
  if (!(await mayUse(tx, perms, human, d))) return refuse("device_not_shared");
  // D-13 (P-12): a repository of a team project the human is not in reads as missing.
  if (!(await mayOpenRepoProject(tx, perms, human, found.p.id))) return refuse("project_not_found");
  if (d.status !== "online") return refuse("device_offline");
  const rt = runtimesOf(d).find((r) => r.id === runtime);
  if (!rt?.installed || !rt.loggedIn) return refuse("runtime_unavailable");

  // Serialise this bot's proposals for this human: the retry and the cap below are exact under concurrency.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`work_zone:proposals:${turn.agentId}:${human}`}, 0))`,
  );
  const promptSha256 = sha256Hex(prompt);
  const [same] = await tx
    .select({ approvalId: approvalRequests.id })
    .from(workZoneProposals)
    .innerJoin(
      approvalRequests,
      and(
        eq(approvalRequests.resourceId, workZoneProposals.id),
        eq(approvalRequests.kind, WORK_ZONE_START_KIND),
      ),
    )
    .where(
      and(
        eq(workZoneProposals.eventId, turn.eventId),
        eq(workZoneProposals.projectId, input.projectId),
        eq(workZoneProposals.deviceId, input.deviceId),
        eq(workZoneProposals.promptSha256, promptSha256),
      ),
    )
    .limit(1);
  if (same) return { approvalId: same.approvalId, created: false };

  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.kind, WORK_ZONE_START_KIND),
        eq(approvalRequests.requestedByAgentId, turn.agentId),
        eq(approvalRequests.requestedForUserId, human),
        eq(approvalRequests.status, "pending"),
        sql`${approvalRequests.expiresAt} > now()`,
      ),
    );
  if ((pending?.n ?? 0) >= WORK_ZONE_PROPOSAL_LIMITS.pendingPerRequester) return refuse("too_many_pending");

  // The card replies to the human's message, in its thread when it has one.
  const [asked] = await tx
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, turn.messageId))
    .limit(1);
  const [proposal] = await tx
    .insert(workZoneProposals)
    .values({
      organizationId: tenantOf(tx).organizationId,
      agentId: turn.agentId,
      requestedForUserId: human,
      conversationId: turn.conversationId,
      threadRootMessageId: asked?.threadId ?? null,
      eventId: turn.eventId,
      projectId: input.projectId,
      deviceId: input.deviceId,
      runtime,
      prompt,
      promptSha256,
    })
    .returning({ id: workZoneProposals.id });
  if (!proposal) throw new Error("work zone proposal insert returned no row");
  const { id: approvalId } = await deps.approvals.request(tx, {
    kind: WORK_ZONE_START_KIND,
    resourceId: proposal.id,
    requestedByAgentId: turn.agentId,
    requestedForUserId: human,
    eventId: turn.eventId,
    card: {
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      inReplyToMessageId: turn.messageId,
      threadRootMessageId: asked?.threadId ?? null,
    },
  });
  await core.audit.record(tx, {
    action: "work_zone.proposed",
    resourceType: WORK_ZONE_PROPOSAL_RESOURCE,
    resourceId: proposal.id,
    actorKind: "agent",
    actorId: turn.agentId,
    agentId: turn.agentId,
    userId: human,
    clientKind: "agent",
    deviceId: input.deviceId,
    metadata: { proposalId: proposal.id, approvalId, ...ids, promptChars: prompt.length },
  });
  return { approvalId, created: true };
}

/** D-13: whether `userId` has access to the team project repository `projectId` is linked to (true when personal). */
async function mayOpenRepoProject(
  tx: Tx,
  perms: PermissionService,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const [link] = await tx
    .select({ id: orgUnits.id, path: orgUnits.path })
    .from(workProjectRepos)
    .innerJoin(orgUnits, eq(orgUnits.id, workProjectRepos.unitId))
    .where(eq(workProjectRepos.projectId, projectId))
    .limit(1);
  if (!link) return true;
  const facts = await projectFacts(tx, userId, link);
  return (await perms.decide(tx, { kind: "user", userId }, "work_session.read", facts)).allowed;
}

// ---------------------------------------------------------------- the project list

/**
 * `ocw_work_zone_projects`: the projects the turn's human may start a session on (`work_session.create`, then
 * `device.use` per device), with each device's online state and installed runtimes. Names and ids only: a project's
 * host path never leaves its device (principle 7). Removed projects and revoked devices are left out.
 */
export async function listProposableProjects(
  tx: Tx,
  deps: Pick<WorkZoneProposalDeps, "perms">,
  p: { turn: AgentTurnRow },
): Promise<AgentChannelWorkZoneProjectsResponse> {
  const human = p.turn.userId;
  if (!(await mayCreate(tx, deps.perms, human))) return { projects: [] };
  const rows = await tx
    .select({ p: projects, d: devices, unitId: orgUnits.id, unitPath: orgUnits.path })
    .from(projects)
    .innerJoin(devices, eq(devices.id, projects.deviceId))
    .leftJoin(workProjectRepos, eq(workProjectRepos.projectId, projects.id))
    .leftJoin(orgUnits, eq(orgUnits.id, workProjectRepos.unitId))
    .where(and(isNull(projects.removedAt), isNull(devices.revokedAt)))
    .orderBy(asc(devices.name), asc(projects.name), asc(projects.id));
  const access = await loadDeviceAccess(tx, human);
  const usable = new Map<string, boolean>();
  const inProject = new Map<string, boolean>();
  const out: AgentChannelWorkZoneProjectsResponse["projects"] = [];
  for (const { p: project, d, unitId, unitPath } of rows) {
    if (out.length >= MAX_PROJECTS) break;
    let may = usable.get(d.id);
    if (may === undefined) {
      may = (
        await deps.perms.decide(
          tx,
          { kind: "user", userId: human },
          "device.use",
          deviceFacts(d, human, access),
        )
      ).allowed;
      usable.set(d.id, may);
    }
    if (!may) continue;
    // D-13 (P-12): a team project's repository only for a human with project access (the resolver decides).
    if (unitId !== null && unitPath !== null) {
      let open = inProject.get(unitId);
      if (open === undefined) {
        open = (
          await deps.perms.decide(
            tx,
            { kind: "user", userId: human },
            "work_session.read",
            await projectFacts(tx, human, { id: unitId, path: unitPath }),
          )
        ).allowed;
        inProject.set(unitId, open);
      }
      if (!open) continue;
    }
    out.push({
      projectId: project.id,
      name: project.name.slice(0, 200),
      device: { id: d.id, name: d.name.slice(0, 120), online: d.status === "online" },
      runtimes: runtimesOf(d)
        .filter((r) => r.installed)
        .slice(0, 4)
        .map((r) => ({ id: r.id, label: RUNTIME_LABEL[r.id], available: r.loggedIn })),
    });
  }
  return { projects: out };
}
