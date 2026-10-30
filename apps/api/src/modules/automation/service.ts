import {
  type Automation,
  type AutomationActionKind,
  type AutomationList,
  type AutomationListQuery,
  type AutomationRunReason,
  type AutomationTarget,
  type AutomationTargetView,
  type AutomationViewerAction,
  type CreateAutomationRequest,
  type CreateAutomationResponse,
  EventTypes,
  type InboundConfig,
  type SchedulePreviewRequest,
  type SchedulePreviewResponse,
} from "@ocw/contracts";
import {
  agents,
  automationRuns,
  automations,
  boardColumns,
  botPolicies,
  conversations,
  orgMembers,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
import type { ConversationAccess } from "../chat";
import type { PermissionService } from "../organization";
import {
  type AutomationActor,
  canCreate,
  canManage,
  canWebhook,
  decideTarget,
  type TargetCode,
} from "./access";
import { type ActionKindHandler, type AutomationRow, createActionRegistry } from "./actions";
import { firstRunAt, nextRuns, validateSchedule } from "./schedule";

/**
 * The automation entity (D-01, D-07; PRD §73-75): a standing order run as its creator, with a trigger, a target by
 * stable ids and a daily budget. Every mutation bumps `version`, writes one audit row (ids, kinds and codes only:
 * never the name, the instructions or a payload) and announces `automation.updated` on the run-as person's `user:`
 * stream. The runner (09), the digest (13), the approval kind (12) and the triggers (10, 11) reuse this service.
 */

export interface AutomationCaps {
  maxAutomationsPerUser: number;
  minScheduleMinutes: number;
  maxInboundPerHour: number;
  maxRunsPerDayCap: number;
}

/** The `bot_policies` column defaults: an organization without a policy row gets these. */
export const DEFAULT_AUTOMATION_CAPS: AutomationCaps = {
  maxAutomationsPerUser: 10,
  minScheduleMinutes: 15,
  maxInboundPerHour: 30,
  maxRunsPerDayCap: 96,
};

export interface AutomationService {
  /** Each action kind registers once: `agent_turn` (09), `digest` (13). */
  registerActionKind(kind: AutomationActionKind, handler: ActionKindHandler): void;
  actionKind(kind: AutomationActionKind): ActionKindHandler | null;
  create(
    tx: Tx,
    actor: AutomationActor,
    input: CreateAutomationRequest,
    opts?: { actionKind?: AutomationActionKind; config?: Record<string, unknown> },
  ): Promise<CreateAutomationResponse>;
  get(tx: Tx, actor: AutomationActor, id: string): Promise<Automation>;
  list(tx: Tx, actor: AutomationActor, q: AutomationListQuery): Promise<AutomationList>;
  preview(tx: Tx, input: SchedulePreviewRequest): Promise<SchedulePreviewResponse>;
  caps(tx: Tx): Promise<AutomationCaps>;
  toDto(tx: Tx, row: AutomationRow, viewer: AutomationActor): Promise<Automation>;
  /** `automation.updated {automationId}` on `user:<runAs>` (ids only). */
  announce(tx: Tx, row: Pick<AutomationRow, "id" | "runAsUserId">): Promise<void>;
}

const NOT_FOUND = "Automation not found";

const TARGET_MESSAGES: Record<TargetCode, [string, string]> = {
  agent_not_member: ["agent_not_member", "The bot isn't a member of that conversation"],
  target_not_postable: ["target_not_postable", "You can't post in that conversation"],
  personal_bot_target: ["personal_bot_target", "Personal bots deliver only to your DMs"],
  // A bot the creator may not see reads exactly like one that is not available.
  bot_not_readable: ["agent_unavailable", "That bot isn't available"],
  agent_unavailable: ["agent_unavailable", "That bot isn't available"],
};

export function targetError(code: TargetCode): HttpError {
  const [httpCode, message] = TARGET_MESSAGES[code];
  return new HttpError(400, httpCode, message);
}

const notAllowed = () => new HttpError(403, "not_allowed", "You can't create automations. Ask an admin.");
const notFound = () => new HttpError(404, "not_found", NOT_FOUND);

/** The columns of a target (stable ids only, principle 11). */
export function targetColumns(target: AutomationTarget, conversationId: string | null) {
  return {
    targetKind: target.kind,
    conversationId,
    threadRootMessageId: target.kind === "thread" ? target.threadRootMessageId : null,
    boardColumnId: target.kind === "board" ? target.columnId : null,
  };
}

/** The request form of a stored target. */
export function targetOf(row: AutomationRow): AutomationTarget {
  switch (row.targetKind) {
    case "dm":
      return { kind: "dm" };
    case "channel":
      return { kind: "channel", conversationId: row.conversationId as string };
    case "thread":
      return {
        kind: "thread",
        conversationId: row.conversationId as string,
        threadRootMessageId: row.threadRootMessageId as string,
      };
    default:
      return {
        kind: "board",
        conversationId: row.conversationId as string,
        columnId: row.boardColumnId as string,
      };
  }
}

const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

const utcMidnight = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

export function createAutomationService(
  core: Core,
  perms: PermissionService,
  access: ConversationAccess,
): AutomationService {
  const kinds = createActionRegistry();

  async function loadCaps(tx: Tx): Promise<AutomationCaps> {
    const [row] = await tx
      .select({
        maxAutomationsPerUser: botPolicies.maxAutomationsPerUser,
        minScheduleMinutes: botPolicies.minScheduleMinutes,
        maxInboundPerHour: botPolicies.maxInboundPerHour,
        maxRunsPerDayCap: botPolicies.maxRunsPerDayCap,
      })
      .from(botPolicies)
      .limit(1);
    return row ?? DEFAULT_AUTOMATION_CAPS;
  }

  /** The creator's own automations against the cap (the digest is not one of them, P-14). */
  async function ownCount(tx: Tx, userId: string): Promise<number> {
    const [r] = await tx
      .select({ n: count() })
      .from(automations)
      .where(and(eq(automations.runAsUserId, userId), ne(automations.actionKind, "digest")));
    return Number(r?.n ?? 0);
  }

  async function loadRow(tx: Tx, id: string): Promise<AutomationRow | null> {
    const [row] = await tx.select().from(automations).where(eq(automations.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The row when the actor may see it: its owner (the run-as person) or an `automation.manage` holder. Anyone else,
   * and every other organization (RLS), gets 404: hidden reads exactly like missing.
   */
  async function visible(tx: Tx, actor: AutomationActor, id: string) {
    const row = await loadRow(tx, id);
    if (!row) throw notFound();
    const owner = row.runAsUserId === actor.userId;
    if (!owner && !(await canManage(perms, tx, actor))) throw notFound();
    return { row, owner };
  }

  async function announce(tx: Tx, row: Pick<AutomationRow, "id" | "runAsUserId">) {
    await core.realtime.appendEvent(tx, `user:${row.runAsUserId}`, EventTypes.automationUpdated, {
      automationId: row.id,
    });
  }

  function scheduleError(code: "invalid_cron" | "invalid_time_zone" | "schedule_too_frequent", min: number) {
    if (code === "schedule_too_frequent") {
      return new HttpError(400, code, `Runs can be at most every ${min} minutes in this workspace`, {
        minMinutes: min,
      });
    }
    return new HttpError(
      400,
      code,
      code === "invalid_cron" ? "That schedule isn't valid" : "Pick a time zone from the list",
    );
  }

  /** The person's display names, by user id ("Former member" once they left). */
  async function names(tx: Tx, ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map<string, string>();
    const rows = await tx
      .select({ id: orgMembers.userId, name: orgMembers.displayName })
      .from(orgMembers)
      .where(inArray(orgMembers.userId, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async function toDtos(tx: Tx, rows: readonly AutomationRow[], viewer: AutomationActor) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const people = await names(tx, [
      ...rows.map((r) => r.runAsUserId),
      ...rows.flatMap((r) => (r.pausedBy ? [r.pausedBy] : [])),
    ]);
    const bots = new Map(
      (
        await tx
          .select({ id: agents.id, name: agents.name, scope: agents.scope })
          .from(agents)
          .where(inArray(agents.id, [...new Set(rows.map((r) => r.agentId))]))
      ).map((b) => [b.id, b]),
    );
    const convIds = [...new Set(rows.flatMap((r) => (r.conversationId ? [r.conversationId] : [])))];
    const convs = new Map(
      convIds.length === 0
        ? []
        : (
            await tx
              .select({
                id: conversations.id,
                name: conversations.name,
                visibility: conversations.visibility,
              })
              .from(conversations)
              .where(inArray(conversations.id, convIds))
          ).map((c) => [c.id, c]),
    );
    const columnIds = [...new Set(rows.flatMap((r) => (r.boardColumnId ? [r.boardColumnId] : [])))];
    const columns = new Map(
      columnIds.length === 0
        ? []
        : (
            await tx
              .select({ id: boardColumns.id, name: boardColumns.name })
              .from(boardColumns)
              .where(inArray(boardColumns.id, columnIds))
          ).map((c) => [c.id, c.name]),
    );
    const lastRuns = new Map(
      (
        await tx
          .selectDistinctOn([automationRuns.automationId], {
            automationId: automationRuns.automationId,
            status: automationRuns.status,
            reason: automationRuns.reason,
            at: automationRuns.createdAt,
          })
          .from(automationRuns)
          .where(inArray(automationRuns.automationId, ids))
          .orderBy(automationRuns.automationId, desc(automationRuns.createdAt), desc(automationRuns.id))
      ).map((r) => [r.automationId, r]),
    );
    const inbound = new Map(
      (
        await tx
          .select({ automationId: automationRuns.automationId, n: count() })
          .from(automationRuns)
          .where(
            and(
              inArray(automationRuns.automationId, ids),
              inArray(automationRuns.trigger, ["webhook", "mail"]),
              gte(automationRuns.createdAt, utcMidnight()),
            ),
          )
          .groupBy(automationRuns.automationId)
      ).map((r) => [r.automationId, Number(r.n)]),
    );
    const creates = rows.some((r) => r.runAsUserId === viewer.userId) && (await canCreate(perms, tx, viewer));
    const readable = new Map<string, boolean>();

    const out: Automation[] = [];
    for (const row of rows) {
      const bot = bots.get(row.agentId);
      const botName = bot?.name ?? "Deleted bot";
      const runAsName = people.get(row.runAsUserId) ?? "Former member";
      const owner = row.runAsUserId === viewer.userId;
      const conv = row.conversationId ? convs.get(row.conversationId) : undefined;
      // A manager sees the target of someone's automation by name only when they could read it themselves.
      let convName = conv?.name ?? "deleted conversation";
      if (conv && !owner && conv.visibility === "private") {
        if (!readable.has(conv.id))
          readable.set(conv.id, await access.isReadable(tx, viewer.userId, conv.id));
        if (!readable.get(conv.id)) convName = "private channel";
      }
      const target = targetOf(row);
      let label: string;
      switch (target.kind) {
        case "dm":
          label = owner ? `Your DM with ${botName}` : `${runAsName}'s DM with ${botName}`;
          break;
        case "channel":
          label = `#${convName}`;
          break;
        case "thread":
          label = `Thread in #${convName}`;
          break;
        default:
          label = `${convName} board · ${columns.get(target.columnId) ?? "deleted column"}`;
      }
      const viewerCan: AutomationViewerAction[] = owner
        ? [
            ...(creates && row.actionKind === "agent_turn" ? (["edit"] as const) : []),
            ...(creates && row.status === "active" ? (["run"] as const) : []),
            "pause",
            "delete",
          ]
        : ["pause", "delete"];
      const last = lastRuns.get(row.id);
      out.push({
        id: row.id,
        name: row.name,
        actionKind: row.actionKind,
        agent: { id: row.agentId, displayName: botName, personal: bot?.scope === "personal" },
        runAs: { id: row.runAsUserId, displayName: runAsName },
        instructions: row.instructions,
        trigger: {
          kind: row.triggerKind,
          schedule:
            row.triggerKind === "schedule"
              ? { cron: row.scheduleCron as string, timeZone: row.timeZone as string }
              : null,
          webhook: null,
          mailbox: null,
        },
        target: { ...target, label } as AutomationTargetView,
        inbound:
          row.inboundAction === null
            ? null
            : {
                action: row.inboundAction,
                askBot: row.inboundAskBot,
                config: row.inboundConfig as InboundConfig,
              },
        maxRunsPerDay: row.maxRunsPerDay,
        status: row.status,
        pausedBy: row.pausedBy
          ? { id: row.pausedBy, displayName: people.get(row.pausedBy) ?? "Former member" }
          : null,
        pausedAt: iso(row.pausedAt),
        consecutiveFailures: row.consecutiveFailures,
        nextRunAt: iso(row.nextRunAt),
        lastRun: last
          ? {
              status: last.status,
              reason: (last.reason as AutomationRunReason | null) ?? null,
              at: new Date(last.at).toISOString(),
            }
          : null,
        inboundToday: inbound.get(row.id) ?? 0,
        version: row.version,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
        viewerCan,
      });
    }
    return out;
  }

  const service: AutomationService = {
    registerActionKind(kind, handler) {
      kinds.register(kind, handler);
    },
    actionKind(kind) {
      return kinds.get(kind);
    },

    caps: loadCaps,
    announce,

    async toDto(tx, row, viewer) {
      const [dto] = await toDtos(tx, [row], viewer);
      return dto as Automation;
    },

    async preview(tx, input) {
      const caps = await loadCaps(tx);
      const check = validateSchedule(input, caps.minScheduleMinutes);
      if (!check.ok) {
        return check.code === "schedule_too_frequent"
          ? { ok: false, code: check.code, minMinutes: caps.minScheduleMinutes }
          : { ok: false, code: check.code };
      }
      return { ok: true, next: nextRuns(input, new Date(), 3).map((d) => d.toISOString()) };
    },

    async create(tx, actor, input, opts = {}) {
      const actionKind = opts.actionKind ?? "agent_turn";
      if (!(await canCreate(perms, tx, actor))) throw notAllowed();
      // "Created with changes" from a bot's proposal is 07.6-12's (the approval kind); until then no draft exists.
      if (input.fromApprovalId) throw new HttpError(400, "approval_not_found", "That proposal was not found");
      const trigger = input.trigger;
      if (trigger.kind === "webhook" && !(await canWebhook(perms, tx, actor))) {
        throw new HttpError(403, "webhook_not_allowed", "Only team leads and admins can create webhooks.");
      }
      const caps = await loadCaps(tx);
      if (actionKind !== "digest") {
        // One creator's concurrent saves count one after the other.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`automations:cap:${actor.userId}`}, 0))`,
        );
        if ((await ownCount(tx, actor.userId)) >= caps.maxAutomationsPerUser) {
          throw new HttpError(
            409,
            "automation_cap",
            `You've reached ${caps.maxAutomationsPerUser} automations. Delete one to add another.`,
            { max: caps.maxAutomationsPerUser },
          );
        }
      }
      if (input.maxRunsPerDay > caps.maxRunsPerDayCap) {
        throw new HttpError(400, "bad_request", `Use a whole number from 1 to ${caps.maxRunsPerDayCap}`, {
          max: caps.maxRunsPerDayCap,
        });
      }
      let nextRunAt: string | null = null;
      if (trigger.kind === "schedule") {
        const check = validateSchedule(trigger.schedule, caps.minScheduleMinutes);
        if (!check.ok) throw scheduleError(check.code, caps.minScheduleMinutes);
        nextRunAt = firstRunAt(trigger.schedule).toISOString();
      }
      if (input.inbound?.action === "board_card" && input.target.kind !== "board") {
        throw new HttpError(400, "bad_request", "A board card needs a board target");
      }
      const decided = await decideTarget(tx, perms, {
        agentId: input.agentId,
        userId: actor.userId,
        target: input.target,
      });
      if (!decided.ok) throw targetError(decided.code);
      if (trigger.kind !== "schedule") {
        throw new HttpError(400, "trigger_unavailable", "This trigger isn't available yet");
      }

      const [row] = await tx
        .insert(automations)
        .values({
          organizationId: tenantOf(tx).organizationId,
          name: input.name,
          agentId: input.agentId,
          // P-04, T-07.6-05-01: always the caller (the CHECK in the schema refuses anything else).
          runAsUserId: actor.userId,
          createdBy: actor.userId,
          actionKind,
          instructions: actionKind === "digest" ? "" : input.instructions,
          triggerKind: trigger.kind,
          scheduleCron: trigger.schedule.cron,
          timeZone: trigger.schedule.timeZone,
          ...targetColumns(input.target, decided.conversationId),
          config: opts.config ?? {},
          maxRunsPerDay: input.maxRunsPerDay,
          nextRunAt,
        })
        .returning();
      const created = row as AutomationRow;
      await core.audit.record(tx, {
        action: "automation.created",
        resourceType: "automation",
        resourceId: created.id,
        userId: actor.userId,
        agentId: created.agentId,
        metadata: {
          automationId: created.id,
          agentId: created.agentId,
          actionKind: created.actionKind,
          triggerKind: created.triggerKind,
          targetKind: created.targetKind,
          conversationId: created.conversationId,
        },
      });
      await announce(tx, created);
      return { automation: await service.toDto(tx, created, actor) };
    },

    async get(tx, actor, id) {
      const { row } = await visible(tx, actor, id);
      return service.toDto(tx, row, actor);
    },

    async list(tx, actor, q) {
      const manage = await canManage(perms, tx, actor);
      if (q.scope === "all" && !manage) {
        throw new HttpError(403, "not_allowed", "Only admins can see everyone's automations");
      }
      const rows = await tx
        .select()
        .from(automations)
        .where(q.scope === "all" ? undefined : eq(automations.runAsUserId, actor.userId))
        .orderBy(automations.createdAt, automations.id);
      const caps = await loadCaps(tx);
      return {
        automations: await toDtos(tx, rows, actor),
        usage: { used: await ownCount(tx, actor.userId), max: caps.maxAutomationsPerUser },
        canManage: manage,
      };
    },
  };
  return service;
}
