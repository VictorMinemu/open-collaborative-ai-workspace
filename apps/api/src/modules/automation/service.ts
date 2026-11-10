import {
  AUTOMATION_LIMITS,
  type Automation,
  type AutomationActionKind,
  type AutomationFanOutInput,
  type AutomationInbound,
  type AutomationList,
  type AutomationListQuery,
  type AutomationOptions,
  type AutomationRun,
  type AutomationRunList,
  type AutomationRunListQuery,
  type AutomationRunReason,
  type AutomationTarget,
  type AutomationTargetKind,
  type AutomationTargetOptions,
  type AutomationTargetView,
  type AutomationViewerAction,
  type CreateAutomationRequest,
  type CreateAutomationResponse,
  EventTypes,
  type InboundConfig,
  type SchedulePreviewRequest,
  type SchedulePreviewResponse,
  type UpdateAutomationRequest,
} from "@ocw/contracts";
import {
  agents,
  automationRuns,
  automations,
  boardColumns,
  botPolicies,
  conversations,
  messages,
  orgMembers,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, asc, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
import type { ApprovalService } from "../approval";
import { effectiveDailyLimit, loadPolicy, readCapabilities } from "../bot-capabilities";
import type { ConversationAccess } from "../chat";
import type { PermissionService } from "../organization";
import {
  type AutomationActor,
  canCreate,
  canManage,
  canWebhook,
  decideConversation,
  decideTarget,
  type TargetCode,
  usableBots,
} from "./access";
import {
  type ActionKindHandler,
  type AutomationRow,
  createActionRegistry,
  type TriggerAdapter,
  type TriggerDeps,
} from "./actions";
import { AUTOMATION_CREATE_KIND, closeDraft } from "./approval-kind";
import { mailTrigger } from "./mailboxes";
import { firstRunAt, nextRuns, validateSchedule } from "./schedule";
import { webhookTrigger } from "./webhooks";

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

/**
 * The `bot_policies` column defaults: an organization without a policy row gets these. Phase 07.17 (D-01, D-11): every 5
 * minutes and 288 runs a day, as the database default and the 07.17 migration's update of default-valued rows say.
 */
export const DEFAULT_AUTOMATION_CAPS: AutomationCaps = {
  maxAutomationsPerUser: 10,
  minScheduleMinutes: 5,
  maxInboundPerHour: 30,
  maxRunsPerDayCap: 288,
};

export interface AutomationService {
  /** Each action kind registers once: `agent_turn` (09), `digest` (13). */
  registerActionKind(kind: AutomationActionKind, handler: ActionKindHandler): void;
  actionKind(kind: AutomationActionKind): ActionKindHandler | null;
  /**
   * Creates an automation run as `actor`. With `input.fromApprovalId` (R5, 07.6-12) the form was opened from a bot's
   * proposal: it must be a pending `automation.create` request made for the caller (400 `approval_not_found` for anyone
   * else's, 409 once decided or expired); the automation is created from the body (the person's edits) and the proposal
   * closes as applied with `edited` in the same transaction. `fromApproval` is the approval kind's own apply.
   */
  create(
    tx: Tx,
    actor: AutomationActor,
    input: CreateAutomationRequest,
    opts?: {
      actionKind?: AutomationActionKind;
      config?: Record<string, unknown>;
      fromApproval?: { approvalId: string; edited: boolean };
    },
  ): Promise<CreateAutomationResponse>;
  /** The person's own automations against the cap (digests excluded, P-14). */
  ownCount(tx: Tx, userId: string): Promise<number>;
  /** The owner only (a manager gets 403, P-04); re-decides the target and the trigger entity in the same tx. */
  update(
    tx: Tx,
    actor: AutomationActor,
    id: string,
    input: UpdateAutomationRequest,
  ): Promise<CreateAutomationResponse>;
  /** The owner or an `automation.manage` holder; the trigger entity goes first (R3). */
  remove(tx: Tx, actor: AutomationActor, id: string): Promise<void>;
  /** The owner or an `automation.manage` holder (`pausedBy` records who). */
  pause(tx: Tx, actor: AutomationActor, id: string): Promise<Automation>;
  /** The owner only: resuming restarts runs as them (P-04, D-09). Resets the breaker. */
  resume(tx: Tx, actor: AutomationActor, id: string): Promise<Automation>;
  /** "Run now" (owner only, active only): a `manual` run and its `automation.fire` job in this transaction. */
  runNow(tx: Tx, actor: AutomationActor, id: string): Promise<{ runId: string }>;
  get(tx: Tx, actor: AutomationActor, id: string): Promise<Automation>;
  list(tx: Tx, actor: AutomationActor, q: AutomationListQuery): Promise<AutomationList>;
  runs(tx: Tx, actor: AutomationActor, id: string, q: AutomationRunListQuery): Promise<AutomationRunList>;
  options(tx: Tx, actor: AutomationActor): Promise<AutomationOptions>;
  targetOptions(tx: Tx, actor: AutomationActor, agentId: string): Promise<AutomationTargetOptions>;
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

/**
 * True when a write was refused because its board column was deleted after the target was decided (the column's FK,
 * 07.6 review A HI-03): the target is not postable any more, not a server error. Drizzle wraps the driver's error.
 */
function columnGone(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 3; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (pg.code === "23503" && pg.constraint === "automations_board_column_fk") return true;
    e = pg.cause;
  }
  return false;
}

/** Runs a write, turning a board column that disappeared meanwhile into `target_not_postable` (400). */
async function writingTarget<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (columnGone(err)) throw targetError("target_not_postable");
    throw err;
  }
}

const notAllowed = () => new HttpError(403, "not_allowed", "You can't create automations. Ask an admin.");
const notFound = () => new HttpError(404, "not_found", NOT_FOUND);
const runsPerDayError = (max: number) =>
  new HttpError(400, "bad_request", `Use a whole number from 1 to ${max}`, { max });
const versionConflict = () =>
  new HttpError(409, "version", "This automation changed while you were editing. Reload it.");
const fanOutNotAllowed = () =>
  new HttpError(
    400,
    "fan_out_not_allowed",
    "Only scheduled automations that post in a channel or a board can open a conversation for each item",
  );

/**
 * Phase 07.17 (D-02, D-16, PD-05): fan-out only where no outside content arrives with the trigger: an agent turn on a
 * schedule (Run now included) into a channel or a board. The database check `automations_fan_out_check` says the same.
 */
export function fanOutAllowed(p: {
  actionKind: AutomationActionKind;
  triggerKind: AutomationRow["triggerKind"];
  targetKind: AutomationTargetKind;
}): boolean {
  return (
    p.actionKind === "agent_turn" &&
    p.triggerKind === "schedule" &&
    (p.targetKind === "channel" || p.targetKind === "board")
  );
}

/** The stored columns of the owner's fan-out settings. */
const fanOutColumns = (f: AutomationFanOutInput) => ({
  fanOutEnabled: f.enabled,
  fanOutPerRun: f.perRun,
  fanOutPerDay: f.perDay,
});

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

/** The stored inbound rule in its request form (null for a schedule). */
function inboundOf(row: AutomationRow): AutomationInbound | null {
  if (row.inboundAction === null) return null;
  return { action: row.inboundAction, askBot: row.inboundAskBot, config: row.inboundConfig as InboundConfig };
}

const utcMidnight = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

export function createAutomationService(
  core: Core,
  perms: PermissionService,
  access: ConversationAccess,
  /** The proposals an edited form closes (R5, 07.6-12); absent = `fromApprovalId` is always `approval_not_found`. */
  approvals?: ApprovalService,
): AutomationService {
  const kinds = createActionRegistry();
  const triggerDeps: TriggerDeps = { core, perms };
  /** R3: the endpoint or mailbox behind a webhook or mail trigger lives and dies with its automation, in its tx. */
  const adapterOf = (kind: "webhook" | "mail"): TriggerAdapter<unknown> =>
    kind === "webhook" ? webhookTrigger : mailTrigger;

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
    // Decided for everyone (the owner too), so every answer carries a resolver decision.
    const manage = await canManage(perms, tx, actor);
    if (!owner && !manage) throw notFound();
    return { row, owner };
  }

  /** `visible`, then the owner alone: a manager is told 403 (they govern, never act as someone else, P-04). */
  async function owned(tx: Tx, actor: AutomationActor, id: string, message: string) {
    const { row, owner } = await visible(tx, actor, id);
    if (!owner) throw new HttpError(403, "not_allowed", message);
    if (!(await canCreate(perms, tx, actor))) throw notAllowed();
    return row;
  }

  /** The row locked for this transaction (every mutation serialises on it). */
  async function locked(tx: Tx, id: string): Promise<AutomationRow> {
    const [row] = await tx.select().from(automations).where(eq(automations.id, id)).for("update");
    if (!row) throw notFound();
    return row;
  }

  /** Writes `changes` with `version + 1` and returns the new row. */
  async function bump(tx: Tx, row: AutomationRow, changes: Partial<typeof automations.$inferInsert>) {
    const [after] = await writingTarget(() =>
      tx
        .update(automations)
        .set({ ...changes, version: row.version + 1, updatedAt: sql`now()` })
        .where(and(eq(automations.id, row.id), eq(automations.version, row.version)))
        .returning(),
    );
    if (!after) throw versionConflict();
    return after;
  }

  async function announceRun(tx: Tx, row: Pick<AutomationRow, "id" | "runAsUserId">, runId: string) {
    await core.realtime.appendEvent(tx, `user:${row.runAsUserId}`, EventTypes.automationRunUpdated, {
      automationId: row.id,
      runId,
    });
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
          webhook: row.triggerKind === "webhook" ? await webhookTrigger.view(tx, row, triggerDeps) : null,
          mailbox: row.triggerKind === "mail" ? await mailTrigger.view(tx, row, triggerDeps) : null,
        },
        target: { ...target, label } as AutomationTargetView,
        inbound: inboundOf(row),
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
        fanOut: { enabled: row.fanOutEnabled, perRun: row.fanOutPerRun, perDay: row.fanOutPerDay },
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
    ownCount,

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
      // "Created with changes" (R5, T-07.6-12-04): the proposal must be the caller's own and still pending; it closes as
      // applied with `edited` only once the automation (the caller's edits, under every rule below) exists.
      if (input.fromApprovalId) {
        const { fromApprovalId, ...edited } = input;
        if (!approvals || actionKind !== "agent_turn" || opts.fromApproval) {
          throw new HttpError(400, "approval_not_found", "That proposal was not found");
        }
        return approvals.applyOwn(
          tx,
          { id: fromApprovalId, kind: AUTOMATION_CREATE_KIND, userId: actor.userId },
          async (row) => {
            const created = await service.create(tx, actor, edited, {
              fromApproval: { approvalId: row.id, edited: true },
            });
            await closeDraft(tx, {
              draftId: row.resourceId,
              automationId: created.automation.id,
              edited: true,
            });
            return created;
          },
        );
      }
      const trigger = input.trigger;
      if (
        input.fanOut?.enabled &&
        !fanOutAllowed({ actionKind, triggerKind: trigger.kind, targetKind: input.target.kind })
      ) {
        throw fanOutNotAllowed();
      }
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
      if (input.maxRunsPerDay > caps.maxRunsPerDayCap) throw runsPerDayError(caps.maxRunsPerDayCap);
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

      const [row] = await writingTarget(() =>
        tx
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
            scheduleCron: trigger.kind === "schedule" ? trigger.schedule.cron : null,
            timeZone: trigger.kind === "schedule" ? trigger.schedule.timeZone : null,
            ...targetColumns(input.target, decided.conversationId),
            inboundAction: input.inbound?.action ?? null,
            inboundAskBot: input.inbound?.askBot ?? true,
            inboundConfig: input.inbound?.config ?? {},
            config: opts.config ?? {},
            maxRunsPerDay: input.maxRunsPerDay,
            nextRunAt,
            // 07.17 (PD-05): absent = off, the column defaults.
            ...(input.fanOut ? fanOutColumns(input.fanOut) : {}),
          })
          .returning(),
      );
      const created = row as AutomationRow;
      // The trigger's own entity, in this transaction: a refusal there leaves no automation behind.
      const made =
        trigger.kind === "schedule"
          ? {}
          : await adapterOf(trigger.kind).onCreate(tx, created, trigger, triggerDeps);
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
          // A bot's proposal it came from (07.6-12): confirmed as proposed, or saved with the person's changes.
          ...(opts.fromApproval
            ? { approvalId: opts.fromApproval.approvalId, edited: opts.fromApproval.edited }
            : {}),
        },
      });
      await announce(tx, created);
      return {
        automation: await service.toDto(tx, created, actor),
        ...(made.webhookSecret ? { webhookSecret: made.webhookSecret } : {}),
      };
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

    async update(tx, actor, id, input) {
      await owned(tx, actor, id, "Only its owner can edit an automation");
      const before = await locked(tx, id);
      if (before.version !== input.expectedVersion) throw versionConflict();
      // 07.17 (PD-05): the resulting row decides, so a fan-out automation never moves to a trigger or a target where
      // outside content arrives with the run (and the database check is never the one to refuse).
      if (
        (input.fanOut?.enabled ?? before.fanOutEnabled) &&
        !fanOutAllowed({
          actionKind: before.actionKind,
          triggerKind: input.trigger?.kind ?? before.triggerKind,
          targetKind: input.target?.kind ?? before.targetKind,
        })
      ) {
        throw fanOutNotAllowed();
      }
      if (before.actionKind === "digest") {
        throw new HttpError(400, "bad_request", "Change the digest in its own settings");
      }
      const trigger = input.trigger;
      const kind = trigger?.kind ?? before.triggerKind;
      if (
        trigger?.kind === "webhook" &&
        before.triggerKind !== "webhook" &&
        !(await canWebhook(perms, tx, actor))
      ) {
        throw new HttpError(403, "webhook_not_allowed", "Only team leads and admins can create webhooks.");
      }
      const caps = await loadCaps(tx);
      if (input.maxRunsPerDay !== undefined && input.maxRunsPerDay > caps.maxRunsPerDayCap) {
        throw runsPerDayError(caps.maxRunsPerDayCap);
      }
      let schedule = { cron: before.scheduleCron, timeZone: before.timeZone, nextRunAt: before.nextRunAt };
      if (trigger?.kind === "schedule") {
        const check = validateSchedule(trigger.schedule, caps.minScheduleMinutes);
        if (!check.ok) throw scheduleError(check.code, caps.minScheduleMinutes);
        const same =
          before.triggerKind === "schedule" &&
          before.scheduleCron === trigger.schedule.cron &&
          before.timeZone === trigger.schedule.timeZone;
        schedule = {
          ...trigger.schedule,
          // A changed schedule starts from now; an unchanged one keeps its grid.
          nextRunAt: same ? before.nextRunAt : firstRunAt(trigger.schedule).toISOString(),
        };
      } else if (trigger) {
        schedule = { cron: null, timeZone: null, nextRunAt: null };
      }
      // The inbound rule follows the trigger: kept while the kind stays, required for webhook and mail, none otherwise.
      const inbound =
        input.inbound !== undefined ? input.inbound : kind === before.triggerKind ? inboundOf(before) : null;
      if (kind === "schedule" && inbound)
        throw new HttpError(400, "bad_request", "A schedule has no inbound rule");
      if (kind !== "schedule" && !inbound) {
        throw new HttpError(400, "bad_request", "A webhook or mail trigger needs an inbound rule");
      }
      const target = input.target ?? targetOf(before);
      if (inbound?.action === "board_card" && target.kind !== "board") {
        throw new HttpError(400, "bad_request", "A board card needs a board target");
      }
      const agentId = input.agentId ?? before.agentId;
      // Every save re-decides the target for the owner and the bot (P-08), whatever changed.
      const decided = await decideTarget(tx, perms, { agentId, userId: actor.userId, target });
      if (!decided.ok) throw targetError(decided.code);

      const after = await bump(tx, before, {
        name: input.name ?? before.name,
        agentId,
        instructions: input.instructions ?? before.instructions,
        triggerKind: kind,
        scheduleCron: schedule.cron,
        timeZone: schedule.timeZone,
        nextRunAt: schedule.nextRunAt,
        ...targetColumns(target, decided.conversationId),
        inboundAction: inbound?.action ?? null,
        inboundAskBot: inbound?.askBot ?? true,
        inboundConfig: inbound?.config ?? {},
        maxRunsPerDay: input.maxRunsPerDay ?? before.maxRunsPerDay,
        ...(input.fanOut ? fanOutColumns(input.fanOut) : {}),
        // The run log root is a message of the target conversation (its key carries both): another conversation
        // starts a new thread on its next fan-out run. Turning fan-out off and on again keeps it (PD-05).
        ...(decided.conversationId !== before.conversationId ? { runLogMessageId: null } : {}),
      });
      // R3: the trigger's entity changes with the automation, in this transaction.
      let made: { webhookSecret?: string } = {};
      if (trigger && trigger.kind !== before.triggerKind) {
        if (before.triggerKind !== "schedule")
          await adapterOf(before.triggerKind).onDelete(tx, before, triggerDeps);
        if (trigger.kind !== "schedule")
          made = await adapterOf(trigger.kind).onCreate(tx, after, trigger, triggerDeps);
      } else if (trigger && trigger.kind !== "schedule") {
        made = await adapterOf(trigger.kind).onUpdate(tx, before, after, trigger, triggerDeps);
      }
      const { expectedVersion: _version, ...changes } = input;
      await core.audit.record(tx, {
        action: "automation.updated",
        resourceType: "automation",
        resourceId: after.id,
        userId: actor.userId,
        agentId: after.agentId,
        metadata: {
          automationId: after.id,
          agentId: after.agentId,
          triggerKind: after.triggerKind,
          targetKind: after.targetKind,
          conversationId: after.conversationId,
          // Which fields changed (their names only, never their values).
          changed: Object.keys(changes)
            .filter((k) => changes[k as keyof typeof changes] !== undefined)
            .sort(),
          version: after.version,
        },
      });
      await announce(tx, after);
      return {
        automation: await service.toDto(tx, after, actor),
        ...(made.webhookSecret ? { webhookSecret: made.webhookSecret } : {}),
      };
    },

    async remove(tx, actor, id) {
      await visible(tx, actor, id);
      const row = await locked(tx, id);
      // R3: the endpoint (tombstoned, 410) or mailbox goes with it, first, in this transaction.
      if (row.triggerKind !== "schedule") await adapterOf(row.triggerKind).onDelete(tx, row, triggerDeps);
      await core.audit.record(tx, {
        action: "automation.deleted",
        resourceType: "automation",
        resourceId: row.id,
        userId: actor.userId,
        agentId: row.agentId,
        metadata: {
          automationId: row.id,
          runAsUserId: row.runAsUserId,
          agentId: row.agentId,
          actionKind: row.actionKind,
          triggerKind: row.triggerKind,
        },
      });
      await tx.delete(automations).where(eq(automations.id, row.id));
      await announce(tx, row);
    },

    async pause(tx, actor, id) {
      await visible(tx, actor, id);
      const row = await locked(tx, id);
      if (row.status === "paused") return service.toDto(tx, row, actor);
      // Pausing changes nothing else: `due_automations` returns active automations only.
      const after = await bump(tx, row, {
        status: "paused",
        pausedBy: actor.userId,
        pausedAt: new Date().toISOString(),
        pausedReason: null,
      });
      await core.audit.record(tx, {
        action: "automation.paused",
        resourceType: "automation",
        resourceId: row.id,
        userId: actor.userId,
        agentId: row.agentId,
        metadata: { automationId: row.id, runAsUserId: row.runAsUserId, previousStatus: row.status },
      });
      await announce(tx, after);
      return service.toDto(tx, after, actor);
    },

    async resume(tx, actor, id) {
      await owned(tx, actor, id, "Only its owner can resume an automation");
      const row = await locked(tx, id);
      if (row.status === "active") return service.toDto(tx, row, actor);
      const after = await bump(tx, row, {
        status: "active",
        pausedBy: null,
        pausedAt: null,
        pausedReason: null,
        consecutiveFailures: 0,
        // The instants missed while paused are not run: the next one is after now.
        nextRunAt:
          row.triggerKind === "schedule"
            ? firstRunAt({ cron: row.scheduleCron as string, timeZone: row.timeZone as string }).toISOString()
            : null,
      });
      await core.audit.record(tx, {
        action: "automation.resumed",
        resourceType: "automation",
        resourceId: row.id,
        userId: actor.userId,
        agentId: row.agentId,
        metadata: { automationId: row.id, previousStatus: row.status },
      });
      await announce(tx, after);
      return service.toDto(tx, after, actor);
    },

    async runNow(tx, actor, id) {
      await owned(tx, actor, id, "Only its owner can run an automation");
      const row = await locked(tx, id);
      if (row.status !== "active") {
        throw new HttpError(409, "automation_inactive", "Resume the automation to run it");
      }
      // The same daily budget as scheduled runs (P-09), counted under the row lock.
      const [today] = await tx
        .select({ n: count() })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.automationId, row.id),
            ne(automationRuns.status, "skipped"),
            gte(automationRuns.createdAt, utcMidnight()),
          ),
        );
      const overBudget = Number(today?.n ?? 0) >= row.maxRunsPerDay;
      const [run] = await tx
        .insert(automationRuns)
        .values({
          organizationId: row.organizationId,
          automationId: row.id,
          trigger: "manual",
          status: overBudget ? "skipped" : "queued",
          reason: overBudget ? "runs_per_day" : null,
        })
        .returning({ id: automationRuns.id });
      const runId = (run as { id: string }).id;
      if (overBudget) {
        await core.audit.record(tx, {
          action: "automation.run_skipped",
          resourceType: "automation",
          resourceId: row.id,
          userId: actor.userId,
          agentId: row.agentId,
          metadata: { automationId: row.id, runId, trigger: "manual", reason: "runs_per_day" },
        });
      } else {
        // Ids only (Pitfall 7); the job exists only if this transaction commits.
        await core.jobs.sendInTx(tx, "automation.fire", { organizationId: row.organizationId, runId });
        await core.audit.record(tx, {
          action: "automation.run_started",
          resourceType: "automation",
          resourceId: row.id,
          userId: actor.userId,
          agentId: row.agentId,
          metadata: { automationId: row.id, runId, trigger: "manual" },
        });
      }
      await announceRun(tx, row, runId);
      return { runId };
    },

    async runs(tx, actor, id, q) {
      const { row } = await visible(tx, actor, id);
      let cursor: { createdAt: string; id: string } | undefined;
      if (q.before) {
        const [c] = await tx
          .select({ createdAt: automationRuns.createdAt, id: automationRuns.id })
          .from(automationRuns)
          .where(and(eq(automationRuns.id, q.before), eq(automationRuns.automationId, row.id)))
          .limit(1);
        if (!c) throw new HttpError(400, "bad_request", "Unknown cursor");
        cursor = c;
      }
      const page = AUTOMATION_LIMITS.runsPage;
      const rows = await tx
        .select({
          run: automationRuns,
          anchorConversationId: messages.conversationId,
          anchorThreadId: messages.threadId,
        })
        .from(automationRuns)
        .leftJoin(messages, eq(messages.id, automationRuns.anchorMessageId))
        .where(
          and(
            eq(automationRuns.automationId, row.id),
            cursor
              ? sql`(${automationRuns.createdAt}, ${automationRuns.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
        .limit(page + 1);
      const shown = rows.slice(0, page);
      return {
        runs: shown.map(
          ({ run, anchorConversationId, anchorThreadId }): AutomationRun => ({
            id: run.id,
            trigger: run.trigger,
            status: run.status,
            reason: (run.reason as AutomationRunReason | null) ?? null,
            scheduledFor: iso(run.scheduledFor),
            createdAt: new Date(run.createdAt).toISOString(),
            answeredAt: iso(run.answeredAt),
            tainted: run.tainted,
            anchor:
              run.anchorMessageId && anchorConversationId
                ? {
                    conversationId: anchorConversationId,
                    messageId: run.anchorMessageId,
                    threadRootId: anchorThreadId ?? run.anchorMessageId,
                  }
                : null,
          }),
        ),
        nextCursor: rows.length > page ? (shown[shown.length - 1]?.run.id ?? null) : null,
      };
    },

    async options(tx, actor) {
      const create = await canCreate(perms, tx, actor);
      const webhook = create && (await canWebhook(perms, tx, actor));
      const caps = await loadCaps(tx);
      const bots = create ? await usableBots(tx, perms, actor.userId) : [];
      const policy = await loadPolicy(tx);
      return {
        canCreate: create,
        canWebhook: webhook,
        bots: bots.map(({ row: _row, ...b }) => b),
        caps: {
          maxAutomationsPerUser: caps.maxAutomationsPerUser,
          used: await ownCount(tx, actor.userId),
          minScheduleMinutes: caps.minScheduleMinutes,
          maxInboundPerHour: caps.maxInboundPerHour,
          maxRunsPerDayCap: caps.maxRunsPerDayCap,
        },
        botDailyLimit: Object.fromEntries(
          bots.map((b) => [b.id, effectiveDailyLimit(b.row.scope, readCapabilities(b.row), policy)]),
        ),
      };
    },

    async targetOptions(tx, actor, agentId) {
      if (!(await canCreate(perms, tx, actor))) throw notAllowed();
      const bot = (await usableBots(tx, perms, actor.userId)).find((b) => b.id === agentId);
      if (!bot) throw new HttpError(404, "not_found", "Bot not found");
      // A personal bot delivers only to its owner's DM (P-08): no conversation to offer.
      if (bot.personal) return { conversations: [] };
      const ids = await access.readableIds(tx, actor.userId, { kinds: ["channel"] });
      if (ids.length === 0) return { conversations: [] };
      const convs = await tx
        .select()
        .from(conversations)
        .where(inArray(conversations.id, ids))
        .orderBy(asc(conversations.name), asc(conversations.id));
      const boardIds = convs.filter((c) => c.layout === "board").map((c) => c.id);
      const columns =
        boardIds.length === 0
          ? []
          : await tx
              .select({
                id: boardColumns.id,
                conversationId: boardColumns.conversationId,
                name: boardColumns.name,
                category: boardColumns.category,
              })
              .from(boardColumns)
              .where(inArray(boardColumns.conversationId, boardIds))
              .orderBy(sql`${boardColumns.rank} collate "C"`, asc(boardColumns.id));
      const out: AutomationTargetOptions["conversations"] = [];
      for (const conv of convs) {
        out.push({
          conversationId: conv.id,
          name: conv.name ?? "",
          layout: conv.layout,
          disabledReason: await decideConversation(tx, perms, { agentId, userId: actor.userId, conv }),
          columns: columns
            .filter((c) => c.conversationId === conv.id)
            .map(({ id, name, category }) => ({ id, name, category })),
        });
      }
      return { conversations: out };
    },
  };
  return service;
}
