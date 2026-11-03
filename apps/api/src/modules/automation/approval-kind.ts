import {
  type AgentCardField,
  type AgentChannelAutomationPropose,
  type AgentChannelAutomationProposeResponse,
  type ApprovalHeadline,
  AUTOMATION_LIMITS,
  type AutomationDraftView,
  type AutomationSchedule,
  type AutomationTarget,
  type AutomationTargetView,
  type CreateAutomationRequest,
  scheduleSummary,
} from "@ocw/contracts";
import {
  agents,
  type agentTurns,
  approvalRequests,
  automationDrafts,
  conversationMembers,
  conversations,
  messages,
  orgMembers,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import { conflict, HttpError } from "../../lib/errors";
import type { ApplyResult, ApprovalKind, ApprovalRow, ApprovalService } from "../approval";
import type { PermissionService } from "../organization";
import { canCreate, decideTarget, type TargetCode } from "./access";
import { firstRunAt, validateSchedule } from "./schedule";
import type { AutomationService } from "./service";

/**
 * Natural-language automations (07.6-12; AUTO-03, D-02, D-03, D-07, UI-SPEC Surface 5 and R5). A bot proposes with
 * `ocw_automation_propose`; the API stores the proposal as an `automation_drafts` row, requests the `automation.create`
 * approval for the person of the turn and posts its platform-owned `automation` card. Nothing runs until that person
 * confirms: Create automation applies the stored draft through `service.create` as them (the same caps, minimum
 * interval and target rules as the editor), Discard denies it, and Edit opens the editor, whose save
 * (`POST /automations {…, fromApprovalId}`) creates the person's own version and closes the proposal as applied with
 * `edited` ("Created with changes"). Only schedules, only this conversation (or its thread) or the person's DM: a
 * proposal never creates a webhook or a mailbox, and a tainted turn never gets here (the route refuses it first).
 *
 * Hash tuple (ADR-0023): `[draft.id, agent_id, run_as_user_id, schedule_cron, time_zone, target_kind, conversation_id,
 * thread_root_message_id, sha256Hex(instructions), max_runs_per_day]`, read from the stored draft only.
 * `canDecide`: the decider is the draft's run-as person (who is also the request's human), still holds
 * `automation.create`, and the target still passes `decideTarget` for them and the bot.
 */

export const AUTOMATION_CREATE_KIND = "automation.create";
const RESOURCE_TYPE = "automation_draft";
const TTL_MS = 24 * 3_600_000;
const GONE_TITLE = "This proposal is no longer available";
const FIELD_MAX = 500;

type DraftRow = typeof automationDrafts.$inferSelect;
/** The delivered turn a proposal comes from (`agent_turns`): its bot, its human, where and in reply to what. */
export type ProposingTurn = Pick<
  typeof agentTurns.$inferSelect,
  "eventId" | "agentId" | "userId" | "conversationId" | "messageId"
>;

export interface AutomationProposals {
  /**
   * Proposes an automation for the turn's human, inside a transaction opened as that human, after the route found the
   * live turn and claimed the call as side-effecting (so a tainted turn never gets here). Every refusal is an answer
   * with a code and the model-facing sentence (UI-SPEC), stores and posts nothing, and is audited.
   */
  propose(
    tx: Tx,
    p: { turn: ProposingTurn; input: AgentChannelAutomationPropose },
  ): Promise<AgentChannelAutomationProposeResponse>;
}

/** The refusal codes of a proposal (the route answers them with the REST create's statuses). */
export type ProposalRefusal =
  | "not_allowed"
  | "target_refused"
  | "agent_unavailable"
  | "invalid_cron"
  | "invalid_time_zone"
  | "schedule_too_frequent"
  | "runs_per_day"
  | "automation_cap";

/** The model-facing sentences (UI-SPEC § Copy › Natural-language card, model-facing tool results). */
export const proposalSentences = {
  proposed: (name: string, person: string) =>
    `I posted a card proposing “${name}”. ${person} has to confirm it. Tell them in one short sentence, without repeating the details.`,
  tainted: (person: string) =>
    `I can't propose an automation after reading outside content in this turn. Tell ${person} to ask again in a new message.`,
  schedule: (person: string, minMinutes: number) =>
    `That schedule isn't valid or runs more often than every ${minMinutes} minutes. Ask ${person} for a simpler schedule.`,
  cap: (person: string, max: number) =>
    `${person} already has ${max} automations. Ask them to delete one first.`,
  target: (person: string) =>
    `You can't deliver to that conversation. Propose this conversation or a DM with ${person} instead.`,
  notAllowed: (person: string) =>
    `${person} isn't allowed to create automations. Tell them an admin can change that.`,
  unavailable: (person: string, bot: string) =>
    `${person} can't use ${bot} for automations. Tell them to pick another bot in Bots › Automations.`,
  runsPerDay: (person: string, max: number) =>
    `This workspace allows at most ${max} runs a day. Ask ${person} whether ${max} or fewer is enough.`,
} as const;

// ---------------------------------------------------------------- reading a draft

async function loadDraft(tx: Tx, id: string): Promise<DraftRow | null> {
  const [d] = await tx.select().from(automationDrafts).where(eq(automationDrafts.id, id)).limit(1);
  return d ?? null;
}

/** The request form of a stored draft's target. */
function draftTarget(d: DraftRow): AutomationTarget {
  if (d.targetKind === "dm") return { kind: "dm" };
  if (d.targetKind === "thread") {
    return {
      kind: "thread",
      conversationId: d.conversationId as string,
      threadRootMessageId: d.threadRootMessageId as string,
    };
  }
  return { kind: "channel", conversationId: d.conversationId as string };
}

const draftSchedule = (d: DraftRow): AutomationSchedule => ({ cron: d.scheduleCron, timeZone: d.timeZone });

/** The create request a confirmed draft becomes: exactly the stored proposal, always a schedule. */
export function draftToRequest(d: DraftRow): CreateAutomationRequest {
  return {
    name: d.name,
    agentId: d.agentId,
    instructions: d.instructions,
    trigger: { kind: "schedule", schedule: draftSchedule(d) },
    target: draftTarget(d),
    maxRunsPerDay: d.maxRunsPerDay,
  };
}

interface DraftWords {
  bot: string;
  person: string;
  /** `#sales`, `This thread`, `Your DM with Scout` (the card's words). */
  deliverTo: string;
  /** The editor's target label (`#sales`, `Thread in #sales`, `Your DM with Scout`). */
  targetLabel: string;
  when: string;
  firstRun: string | null;
}

const plural = (n: number) => `Up to ${n} ${n === 1 ? "run" : "runs"} a day`;

/** `Fri, Oct 9, 5:00 PM` in the automation's zone. */
function firstRunWords(s: AutomationSchedule): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: s.timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(firstRunAt(s));
  } catch {
    return null;
  }
}

async function wordsOf(tx: Tx, d: DraftRow): Promise<DraftWords> {
  const [bot] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, d.agentId)).limit(1);
  const [person] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, d.runAsUserId))
    .limit(1);
  const botName = bot?.name ?? "Deleted bot";
  let channel = "deleted conversation";
  if (d.conversationId) {
    const [c] = await tx
      .select({ name: conversations.name })
      .from(conversations)
      .where(eq(conversations.id, d.conversationId))
      .limit(1);
    if (c?.name) channel = c.name;
  }
  const dm = `Your DM with ${botName}`;
  return {
    bot: botName,
    person: person?.name ?? "Former member",
    deliverTo: d.targetKind === "dm" ? dm : d.targetKind === "thread" ? "This thread" : `#${channel}`,
    targetLabel:
      d.targetKind === "dm" ? dm : d.targetKind === "thread" ? `Thread in #${channel}` : `#${channel}`,
    when: `${scheduleSummary(d.scheduleCron)} · ${d.timeZone}`,
    firstRun: firstRunWords(draftSchedule(d)),
  };
}

const clip = (v: string, max = FIELD_MAX) => (v.length <= max ? v : `${v.slice(0, max - 1)}…`);

function fieldsOf(d: DraftRow, w: DraftWords): AgentCardField[] {
  return [
    { label: "Bot", value: clip(w.bot) },
    { label: "When", value: clip(w.when) },
    { label: "Deliver to", value: clip(w.deliverTo) },
    { label: "Runs as", value: clip(w.person) },
    { label: "Limit", value: plural(d.maxRunsPerDay) },
    ...(w.firstRun ? [{ label: "First run", value: w.firstRun }] : []),
    { label: "Instructions", value: clip(d.instructions) },
  ];
}

const titleOf = (name: string) => `Create “${name}”`;

/**
 * The draft's state as the approval decides it: the request is the one truth (a discard or an expiry never writes the
 * draft; only creating it does).
 */
function draftStatus(d: DraftRow, row: ApprovalRow): DraftRow["status"] {
  if (d.status !== "pending") return d.status;
  if (row.status === "denied") return "discarded";
  if (row.status === "pending" && new Date(row.expiresAt).getTime() <= Date.now()) return "expired";
  return "pending";
}

/** The automations route of an applied proposal ("Open automation"). */
const automationRoute = (automationId: string) => `/bots/automations?edit=${automationId}`;

/**
 * Marks a proposal's draft applied with the automation it became (in the transaction that created it). `edited`: the
 * person saved it from the editor with their own changes (R5). Only a pending draft changes.
 */
export async function closeDraft(
  tx: Tx,
  p: { draftId: string; automationId: string; edited: boolean },
): Promise<void> {
  const [closed] = await tx
    .update(automationDrafts)
    .set({ status: "applied", automationId: p.automationId, edited: p.edited, updatedAt: sql`now()` })
    .where(and(eq(automationDrafts.id, p.draftId), eq(automationDrafts.status, "pending")))
    .returning({ id: automationDrafts.id });
  if (!closed) throw conflict("This proposal was already closed", "approval_already_decided");
}

// ---------------------------------------------------------------- the approval kind

/** What `apply` reports when `service.create` refuses the stored draft (the card says it in words). */
function applyCode(code: string): string {
  switch (code) {
    case "agent_not_member":
    case "personal_bot_target":
    case "target_not_postable":
      return "target_not_postable";
    case "invalid_cron":
    case "invalid_time_zone":
    case "schedule_too_frequent":
      return "schedule_too_frequent";
    case "bad_request":
      return "runs_per_day";
    default:
      return code;
  }
}

/**
 * `automation.create` (`server_apply`, 24 h): see the file comment for the hash tuple and the decider rule. `apply` creates
 * the automation as the decider (who is the run-as person) through `service.create`; a refusal there (the cap reached,
 * the target gone, the bot gone, the schedule now too frequent) fails the request with that code and creates nothing.
 */
export function automationCreateKind(deps: {
  perms: PermissionService;
  service: AutomationService;
}): ApprovalKind {
  const { perms, service } = deps;
  /** The decider rule, also who may see the request besides its human. */
  async function mayDecide(tx: Tx, userId: string, d: DraftRow, row: ApprovalRow): Promise<boolean> {
    if (userId !== d.runAsUserId || userId !== row.requestedForUserId) return false;
    if (!(await canCreate(perms, tx, { userId }))) return false;
    return (await decideTarget(tx, perms, { agentId: d.agentId, userId, target: draftTarget(d) })).ok;
  }
  return {
    kind: AUTOMATION_CREATE_KIND,
    mode: "server_apply",
    resourceType: RESOURCE_TYPE,
    ttlMs: TTL_MS,

    async hashInput(tx, row) {
      const d = await loadDraft(tx, row.resourceId);
      if (!d) throw conflict(GONE_TITLE, "proposal_gone");
      return [
        d.id,
        d.agentId,
        d.runAsUserId,
        d.scheduleCron,
        d.timeZone,
        d.targetKind,
        d.conversationId,
        d.threadRootMessageId,
        sha256Hex(d.instructions),
        d.maxRunsPerDay,
      ];
    },

    async canDecide(tx, deciderUserId, row) {
      const d = await loadDraft(tx, row.resourceId);
      return d ? mayDecide(tx, deciderUserId, d, row) : false;
    },

    async audience(tx, row) {
      const d = await loadDraft(tx, row.resourceId);
      return d ? [d.runAsUserId] : [];
    },

    async gone(tx, row) {
      const d = await loadDraft(tx, row.resourceId);
      if (!d) return "proposal_gone";
      const [bot] = await tx
        .select({ deletedAt: agents.deletedAt })
        .from(agents)
        .where(eq(agents.id, d.agentId))
        .limit(1);
      return !bot || bot.deletedAt !== null ? "bot_deleted" : null;
    },

    async view(tx, row) {
      const d = await loadDraft(tx, row.resourceId);
      if (!d) return { type: "fields", title: GONE_TITLE, fields: [] };
      const w = await wordsOf(tx, d);
      const target = { ...draftTarget(d), label: w.targetLabel } as AutomationTargetView;
      const view: AutomationDraftView = {
        type: "automation_draft",
        title: titleOf(d.name),
        fields: fieldsOf(d, w),
        draft: {
          name: d.name,
          agent: { id: d.agentId, displayName: w.bot.slice(0, 200) },
          runAs: { id: d.runAsUserId, displayName: w.person.slice(0, 200) },
          instructions: d.instructions,
          schedule: draftSchedule(d),
          target,
          maxRunsPerDay: d.maxRunsPerDay,
          status: draftStatus(d, row),
          automationId: d.automationId,
          edited: d.edited,
        },
      };
      return view;
    },

    async headline(tx, row): Promise<ApprovalHeadline> {
      const d = await loadDraft(tx, row.resourceId);
      if (!d) return { title: GONE_TITLE, context: null, requester: "", tags: [] };
      const w = await wordsOf(tx, d);
      return {
        title: titleOf(d.name).slice(0, 200),
        context: `${w.when} · ${w.targetLabel}`.slice(0, 120),
        requester: `${w.bot} for ${w.person}`.slice(0, 200),
        tags: [],
        agent: { id: d.agentId, displayName: w.bot.slice(0, 200) },
      };
    },

    async link(tx, row) {
      const d = await loadDraft(tx, row.resourceId);
      return {
        display: "exact",
        resultRoute: row.status === "applied" && d?.automationId ? automationRoute(d.automationId) : null,
        edited: d?.edited ?? false,
      };
    },

    async card(tx, row) {
      const d = await loadDraft(tx, row.resourceId);
      if (!d) throw conflict(GONE_TITLE, "proposal_gone");
      const w = await wordsOf(tx, d);
      return {
        cardKind: "automation",
        card: {
          kind: "automation",
          title: titleOf(d.name),
          fields: fieldsOf(d, w),
          status: "pending",
          actions: [{ kind: "open", label: "Edit", target: `/bots/automations?draft=${row.id}` }],
          // UI-SPEC: the screen-reader summary (also the message body search and notifications read).
          summary: clip(
            `${w.bot} proposes an automation “${d.name}” for ${w.person}: ${w.when}, delivered to ${w.deliverTo}.`,
            2_000,
          ),
        },
        labels: { approve: "Create automation", deny: "Discard", open: "Edit" },
      };
    },

    async apply(tx, row, ctx): Promise<ApplyResult> {
      const d = await loadDraft(tx, row.resourceId);
      if (d?.status !== "pending") return { ok: false, code: "proposal_gone" };
      // Defence in depth: `canDecide` already required the run-as person; the automation is theirs or nobody's (P-04).
      if (ctx.deciderUserId !== d.runAsUserId) return { ok: false, code: "not_allowed" };
      try {
        const created = await service.create(tx, { userId: ctx.deciderUserId }, draftToRequest(d), {
          fromApproval: { approvalId: row.id, edited: false },
        });
        await closeDraft(tx, { draftId: d.id, automationId: created.automation.id, edited: false });
        return { ok: true };
      } catch (err) {
        if (err instanceof HttpError) return { ok: false, code: applyCode(err.code) };
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------- proposing

/**
 * Registers `automation.create` on the approval service (once, from the module index) and returns the proposal entry
 * point the Agent Channel route calls.
 */
export function registerAutomationApprovalKind(
  approvals: ApprovalService,
  service: AutomationService,
  deps: { core: Core; perms: PermissionService },
): AutomationProposals {
  approvals.register(automationCreateKind({ perms: deps.perms, service }));
  return {
    propose: (tx, p) => proposeAutomation(tx, { ...deps, approvals, service }, p),
  };
}

/** The display name of a member ("Former member" once they left). */
async function personName(tx: Tx, userId: string): Promise<string> {
  const [m] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return m?.name ?? "Former member";
}

/**
 * The target of `here`: a top-level message in a channel → the channel; a message in a thread → that thread; the
 * person's own DM with this bot → their DM. Anything else (a group DM, a DM with other people, an AI chat) cannot be
 * proposed (`target_refused`). `dm` is always the person's DM with the bot (resolved per run).
 */
async function targetOfTurn(
  tx: Tx,
  turn: ProposingTurn,
  kind: AgentChannelAutomationPropose["target"]["kind"],
  asked: { threadId: string | null } | undefined,
): Promise<AutomationTarget | null> {
  if (kind === "dm") return { kind: "dm" };
  const [conv] = await tx
    .select({ id: conversations.id, kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, turn.conversationId))
    .limit(1);
  if (!conv) return null;
  if (conv.kind === "channel") {
    return asked?.threadId
      ? { kind: "thread", conversationId: conv.id, threadRootMessageId: asked.threadId }
      : { kind: "channel", conversationId: conv.id };
  }
  if (conv.kind !== "dm") return null;
  const members = await tx
    .select({ kind: conversationMembers.memberKind, id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conv.id));
  const own =
    members.length === 2 &&
    members.some((m) => m.kind === "user" && m.id === turn.userId) &&
    members.some((m) => m.kind === "agent" && m.id === turn.agentId);
  return own ? { kind: "dm" } : null;
}

async function proposeAutomation(
  tx: Tx,
  deps: {
    core: Core;
    perms: PermissionService;
    approvals: ApprovalService;
    service: AutomationService;
  },
  p: { turn: ProposingTurn; input: AgentChannelAutomationPropose },
): Promise<AgentChannelAutomationProposeResponse> {
  const { core, perms, approvals, service } = deps;
  const { turn, input } = p;
  const human = turn.userId;
  const person = await personName(tx, human);
  const ids = { eventId: turn.eventId, targetKind: input.target.kind };

  const refuse = async (
    code: ProposalRefusal,
    sentence: string,
  ): Promise<AgentChannelAutomationProposeResponse> => {
    // Ids and codes only: never the name, the instructions or the schedule.
    await core.audit.record(tx, {
      action: "automation.proposal_refused",
      resourceType: "agent",
      resourceId: turn.agentId,
      result: "denied",
      actorKind: "agent",
      actorId: turn.agentId,
      agentId: turn.agentId,
      userId: human,
      clientKind: "agent",
      metadata: { reason: code, ...ids },
    });
    return { ok: false, code, sentence: sentence.slice(0, 500) };
  };

  if (!(await canCreate(perms, tx, { userId: human }))) {
    return refuse("not_allowed", proposalSentences.notAllowed(person));
  }
  const caps = await service.caps(tx);
  const schedule: AutomationSchedule = input.schedule;
  const check = validateSchedule(schedule, caps.minScheduleMinutes);
  if (!check.ok) return refuse(check.code, proposalSentences.schedule(person, caps.minScheduleMinutes));
  const maxRunsPerDay =
    input.maxRunsPerDay ?? Math.min(AUTOMATION_LIMITS.maxRunsPerDayDefault, caps.maxRunsPerDayCap);
  if (maxRunsPerDay > caps.maxRunsPerDayCap) {
    return refuse("runs_per_day", proposalSentences.runsPerDay(person, caps.maxRunsPerDayCap));
  }
  if ((await service.ownCount(tx, human)) >= caps.maxAutomationsPerUser) {
    return refuse("automation_cap", proposalSentences.cap(person, caps.maxAutomationsPerUser));
  }

  const [asked] = await tx
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, turn.messageId))
    .limit(1);
  const target = await targetOfTurn(tx, turn, input.target.kind, asked);
  if (!target) return refuse("target_refused", proposalSentences.target(person));
  const decided = await decideTarget(tx, perms, { agentId: turn.agentId, userId: human, target });
  if (!decided.ok) {
    const code: TargetCode = decided.code;
    if (code === "agent_unavailable" || code === "bot_not_readable") {
      const [bot] = await tx
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, turn.agentId))
        .limit(1);
      return refuse("agent_unavailable", proposalSentences.unavailable(person, bot?.name ?? "this bot"));
    }
    return refuse("target_refused", proposalSentences.target(person));
  }

  const name = input.name.trim();
  const instructions = input.instructions.trim();
  const columns = {
    agentId: turn.agentId,
    runAsUserId: human,
    eventId: turn.eventId,
    name,
    instructions,
    scheduleCron: schedule.cron.trim(),
    timeZone: schedule.timeZone,
    targetKind: target.kind as "channel" | "thread" | "dm",
    conversationId: target.kind === "dm" ? null : target.conversationId,
    threadRootMessageId: target.kind === "thread" ? target.threadRootMessageId : null,
    maxRunsPerDay,
  };

  // The same proposal twice in one turn (a retried call) answers with the first one's approval, posting nothing.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`automation:proposals:${turn.eventId}`}, 0))`,
  );
  const same = await tx
    .select({ approvalId: approvalRequests.id, d: automationDrafts })
    .from(automationDrafts)
    .innerJoin(
      approvalRequests,
      and(
        eq(approvalRequests.resourceId, automationDrafts.id),
        eq(approvalRequests.kind, AUTOMATION_CREATE_KIND),
      ),
    )
    .where(and(eq(automationDrafts.eventId, turn.eventId), eq(automationDrafts.status, "pending")));
  const again = same.find(
    (r) =>
      r.d.name === columns.name &&
      r.d.instructions === columns.instructions &&
      r.d.scheduleCron === columns.scheduleCron &&
      r.d.timeZone === columns.timeZone &&
      r.d.targetKind === columns.targetKind &&
      r.d.conversationId === columns.conversationId &&
      r.d.threadRootMessageId === columns.threadRootMessageId &&
      r.d.maxRunsPerDay === columns.maxRunsPerDay,
  );
  if (again)
    return { ok: true, approvalId: again.approvalId, sentence: proposalSentences.proposed(name, person) };

  const [draft] = await tx
    .insert(automationDrafts)
    .values({ organizationId: tenantOf(tx).organizationId, ...columns })
    .returning({ id: automationDrafts.id });
  if (!draft) throw new Error("automation draft insert returned no row");

  // The card replies to the person's message: in its thread in a channel (a new thread under a top-level message, as
  // every bot reply there), flat in a DM.
  const [conv] = await tx
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, turn.conversationId))
    .limit(1);
  const threadRootMessageId =
    conv?.kind === "channel" ? (asked?.threadId ?? asked?.id ?? null) : (asked?.threadId ?? null);
  const { id: approvalId } = await approvals.request(tx, {
    kind: AUTOMATION_CREATE_KIND,
    resourceId: draft.id,
    requestedByAgentId: turn.agentId,
    requestedForUserId: human,
    eventId: turn.eventId,
    card: {
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      inReplyToMessageId: turn.messageId,
      threadRootMessageId,
    },
  });
  await core.audit.record(tx, {
    action: "automation.proposed",
    resourceType: RESOURCE_TYPE,
    resourceId: draft.id,
    actorKind: "agent",
    actorId: turn.agentId,
    agentId: turn.agentId,
    userId: human,
    clientKind: "agent",
    metadata: {
      draftId: draft.id,
      approvalId,
      eventId: turn.eventId,
      agentId: turn.agentId,
      targetKind: columns.targetKind,
      conversationId: columns.conversationId,
    },
  });
  return { ok: true, approvalId, sentence: proposalSentences.proposed(name, person) };
}
