import {
  AgentCardApprovalLink,
  AgentCardInput,
  type ApprovalDetail,
  ApprovalHeadline,
  type ApprovalList,
  type ApprovalListQuery,
  type ApprovalRequestStatus,
  type ApprovalRequestUpdatedEvent,
  type ApprovalSummary,
  EventTypes,
} from "@ocw/contracts";
import { approvalRequests, messages, type Tx, tenantOf, withSavepoint } from "@ocw/db";
import { and, desc, eq, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { CardAction, LinkedCardInfo, LinkedCards } from "../../lib/chat-agent-bridge";
import { conflict, forbidden, HttpError, notFound } from "../../lib/errors";
import {
  announceCardMessage,
  authorOf,
  convTopic,
  type Directory,
  loadDirectory,
  mirrorCardClosed,
  mirrorCardDecision,
  mirrorCardUsed,
} from "../chat";
import { actionHash } from "./hash";
import {
  type ApplyResult,
  type ApprovalKind,
  type ApprovalRegistry,
  type ApprovalRow,
  createApprovalRegistry,
} from "./registry";

/**
 * The approve-and-apply primitive (MEM-06, D-05, D-08, ADR-0023). A request names one action of a registered kind by
 * the hash of its stored tuple; a person the kind allows decides it once, in one transaction that recomputes the hash,
 * and the server either applies the action there (`server_apply`) or leaves a one-use grant (`grant`, 07.5). Every
 * step is audited with ids, kind and outcome only, and announced ids-only on `user:` streams.
 */

export interface RequestApprovalInput {
  kind: string;
  resourceId: string;
  requestedByAgentId: string | null;
  requestedForUserId: string | null;
  eventId: string | null;
  /**
   * 07.8-14 (D-12 U-5, R8): this request expires sooner than its kind's TTL (a browser action waits only as long as its
   * page is held, 15 minutes). It can only shorten the kind's TTL, never extend it.
   */
  ttlMs?: number;
  /**
   * Where to mirror the request as a platform-owned card: the agent that asked, posting in its conversation in reply
   * to the human's message (the kind must have a `card` hook). The post goes through chat's agent checks.
   */
  card?: {
    agentId: string;
    conversationId: string;
    inReplyToMessageId: string;
    threadRootMessageId: string | null;
  };
}

export interface DecideInput {
  id: string;
  deciderUserId: string;
  outcome: "approved" | "denied";
  actionHash: string;
  note?: string | undefined;
  /**
   * Set by the chat card route: the caller already reads the request's card, so a non-decider gets 403 `not_approver`
   * instead of the 404 that hides a request from everyone else.
   */
  shownOnCard?: boolean;
}

export type ConsumeGrantResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "approval_not_found"
        | "not_approved"
        | "already_used"
        | "approval_expired"
        | "approval_action_changed";
    };

export interface ApprovalService {
  register(kind: ApprovalKind): void;
  request(
    tx: Tx,
    input: RequestApprovalInput,
  ): Promise<{ id: string; actionHash: string; cardMessageId: string | null }>;
  decide(tx: Tx, input: DecideInput): Promise<ApprovalSummary>;
  consumeGrant(tx: Tx, input: { id: string; kind: string; actionHash: string }): Promise<ConsumeGrantResult>;
  /**
   * 07.6-12 (R5): the person a pending request was made for did the action themselves, with their own changes, through
   * the kind's own route (an edited automation saved in the editor), so nobody decides it. Locks the request: 400
   * `approval_not_found` unless it is a request of `kind` made for `userId` (it never reveals someone else's), 409
   * `approval_already_decided` / `approval_expired` otherwise. Then locks the decision's streams in the decision's
   * order, runs `act` (the caller's own action: a refusal throws and rolls everything back), and closes the request as
   * `applied`, decided by that person: audited (`approval.decided` with `selfApproved` and `edited`, then
   * `approval.applied`), mirrored on its card as approved (the bot hears it) and announced, like an approved decision.
   * The kind's `apply` never runs: the person's own action replaced it.
   */
  applyOwn<T>(
    tx: Tx,
    input: { id: string; kind: string; userId: string },
    act: (row: ApprovalRow) => Promise<T>,
  ): Promise<T>;
  get(tx: Tx, id: string, viewerUserId: string): Promise<ApprovalDetail>;
  /**
   * The "gone" path (WINDOWS 144): closes the pending requests among `which` whose kind says their action can never be
   * applied again (`ApprovalKind.gone`) as `failed` with the kind's code, with no decider. Each closure is audited
   * (`approval.closed`, ids and the code), announced ids-only like a decision, and mirrored on its card (status
   * `failed`, live). Called inside the transaction that made the action vanish (a unit or bot deletion, a forget);
   * a request whose kind has no `gone` hook, that is no longer pending, or that is not gone is left as it is.
   */
  closeGone(tx: Tx, which: { ids: readonly string[] } | { requestedByAgentId: string }): Promise<string[]>;
  list(tx: Tx, viewerUserId: string, q: ApprovalListQuery): Promise<ApprovalList>;
  /** The provider chat's card routes use through the bridge (registered by `createApprovalModule`). */
  linkedCards: LinkedCards;
}

const NOT_FOUND = "Approval not found";
const PAGE = 50;
const BATCH = 100;
/** How many rows one decider page may scan before it answers with what it found and a cursor. */
const SCAN_LIMIT = 500;
/** A placeholder that satisfies the column check until the real hash is computed from the inserted row. */
const PENDING_HASH = "0".repeat(64);

const notFoundError = () => notFound(NOT_FOUND, "approval_not_found");

type Locked = ApprovalRow & { expired: boolean };

/** Every column plus whether the request is past its expiry by the database clock. */
const withExpiry = {
  row: approvalRequests,
  expired: sql<boolean>`${approvalRequests.expiresAt} <= now()`.as("expired"),
};

/** A request's TTL: the kind's, or a shorter positive one the caller asked for (never longer). */
function ttlOf(kindTtlMs: number, requested: number | undefined): number {
  return requested !== undefined && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(kindTtlMs, requested)
    : kindTtlMs;
}

function iso(v: string): string {
  return new Date(v).toISOString();
}

/** `expired` is derived: a pending request past its expiry reads as expired; nothing ever stores it. */
function shownStatus(row: Locked): ApprovalRequestStatus {
  return row.status === "pending" && row.expired ? "expired" : row.status;
}

/** The card status that mirrors a decided request. */
const CARD_STATUS = {
  applied: "succeeded",
  approved: "succeeded",
  failed: "failed",
  denied: "cancelled",
} as const;

const MAX_WARNINGS = 3;

/** The kind-composed fields of a card's approval link (`ApprovalKind.link`), validated against the contract. */
const LinkExtras = AgentCardApprovalLink.pick({
  display: true,
  useBy: true,
  waitingFor: true,
  actionFields: true,
  deviceId: true,
  resultRoute: true,
  blocked: true,
  browser: true,
  edited: true,
});

/** The pending `total` of a kinds-filtered inbox is capped here (nav badges and tab counts show "99+"). */
const TOTAL_CAP = 100;
/** How many pending rows one total may scan (a lower bound past it, like a short page with a cursor). */
const TOTAL_SCAN_LIMIT = 1000;

export function createApprovalService(core: Pick<Core, "audit" | "realtime" | "chatAgent">): ApprovalService {
  const registry: ApprovalRegistry = createApprovalRegistry();

  async function lockRow(tx: Tx, id: string): Promise<Locked | null> {
    const [r] = await tx
      .select(withExpiry)
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .for("update");
    return r ? { ...r.row, expired: r.expired } : null;
  }

  async function readRow(tx: Tx, id: string): Promise<Locked | null> {
    const [r] = await tx
      .select(withExpiry)
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    return r ? { ...r.row, expired: r.expired } : null;
  }

  function summaryOf(row: Locked, dir: Directory, canDecide: boolean): ApprovalSummary {
    const status = shownStatus(row);
    const requester = row.requestedByAgentId
      ? authorOf(dir, "agent", row.requestedByAgentId)
      : authorOf(dir, row.requestedForUserId ? "user" : "system", row.requestedForUserId);
    return {
      id: row.id,
      kind: row.kind,
      mode: row.mode,
      status,
      actionHash: row.actionHash,
      requestedBy: {
        agentId: row.requestedByAgentId,
        userId: row.requestedForUserId,
        displayName: requester.displayName,
      },
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
      decidedBy: row.decidedBy
        ? { id: row.decidedBy, displayName: authorOf(dir, "user", row.decidedBy).displayName }
        : null,
      decisionNote: row.decisionNote,
      resultCode: row.resultCode,
      viewerCan: canDecide && status === "pending" ? ["decide"] : [],
    };
  }

  /** The kind's inbox line for this viewer, parsed; null for a kind without one, or a bad one. */
  async function headlineOf(
    tx: Tx,
    kind: ApprovalKind,
    row: ApprovalRow,
    viewerUserId: string,
  ): Promise<ApprovalHeadline | null> {
    if (!kind.headline) return null;
    const parsed = ApprovalHeadline.safeParse(await kind.headline(tx, row, viewerUserId));
    return parsed.success ? parsed.data : null;
  }

  /** The detail's summary with the kind's inbox line (a kind without one, or a bad one, leaves the summary as it is). */
  async function withHeadline(
    tx: Tx,
    kind: ApprovalKind,
    row: ApprovalRow,
    summary: ApprovalSummary,
    viewerUserId: string,
  ): Promise<ApprovalSummary> {
    const headline = await headlineOf(tx, kind, row, viewerUserId);
    return headline ? { ...summary, headline } : summary;
  }

  /**
   * A card's approval link (no viewer field): the 07.2 fields, and for a kind with a `link` hook (07.5, UI-SPEC R6, R7,
   * R9) its kind, expiry and use time plus the kind's fields, parsed. An invalid result adds nothing of the kind's and
   * reads as `review_only` (I-1, fail closed): the card then never approves and never shows a decision note.
   */
  async function linkOf(tx: Tx, row: Locked): Promise<LinkedCardInfo> {
    const base: LinkedCardInfo = {
      id: row.id,
      actionHash: row.actionHash,
      status: shownStatus(row),
      requestedForUserId: row.requestedForUserId,
      warnings: row.cardWarnings,
      resultCode: row.resultCode,
    };
    const kind = registry.get(row.kind);
    if (!kind?.link) return base;
    const extras = LinkExtras.safeParse(await kind.link(tx, row));
    return {
      ...base,
      kind: row.kind,
      expiresAt: iso(row.expiresAt),
      usedAt: row.consumedAt ? iso(row.consumedAt) : null,
      ...(extras.success ? extras.data : { display: "review_only" as const }),
    };
  }

  /**
   * The deciders' and the requester's `user:` streams (plus extra ids), ids and status only, never `org:`.
   *
   * Stream lock order (07.5-16): every append locks its stream's row until commit, so two transactions that touch the
   * same streams in different orders deadlock. The order kept here is the one a message post already follows: the
   * conversation's stream first, then `user:` streams in ascending id order, then the cell's stream. So the `user:`
   * streams go in ascending id order (never the audience's order, which puts the requester first), and every caller
   * announces after the card's conversation event and before the bot's card action.
   */
  async function announce(tx: Tx, kind: ApprovalKind, row: ApprovalRow, extra: Array<string | null>) {
    const ev: ApprovalRequestUpdatedEvent = { id: row.id, status: row.status };
    for (const userId of await announcedTo(tx, kind, row, extra)) {
      await core.realtime.appendEvent(tx, `user:${userId}`, EventTypes.approvalRequestUpdated, ev);
    }
  }

  /**
   * Locks, in the order a message post takes them, the streams a `server_apply` decision appends to before its `apply`
   * runs: the card's conversation, then the `user:` streams of the kind's `applyTopics` and of `announce`, ascending.
   * Other topics `apply` names (e.g. `org:`) are left to the append itself.
   */
  async function lockDecisionStreams(tx: Tx, kind: ApprovalKind, row: ApprovalRow, deciderUserId: string) {
    const users = new Set((await announcedTo(tx, kind, row, [deciderUserId])).map((id) => `user:${id}`));
    for (const topic of (await kind.applyTopics?.(tx, row)) ?? [])
      if (topic.startsWith("user:")) users.add(topic);
    const conv = row.cardMessageId
      ? (
          await tx
            .select({ conversationId: messages.conversationId })
            .from(messages)
            .where(eq(messages.id, row.cardMessageId))
            .limit(1)
        )[0]?.conversationId
      : undefined;
    await core.realtime.lockStreams(tx, [...(conv ? [convTopic(conv)] : []), ...[...users].sort()]);
  }

  /** Who `announce` tells, in ascending id order (the stream lock order). */
  async function announcedTo(tx: Tx, kind: ApprovalKind, row: ApprovalRow, extra: Array<string | null>) {
    const to = new Set<string>(await kind.audience(tx, row));
    for (const id of [row.requestedForUserId, ...extra]) if (id) to.add(id);
    return [...to].sort();
  }

  async function recompute(tx: Tx, kind: ApprovalKind, row: ApprovalRow): Promise<string> {
    return actionHash(row.kind, await kind.hashInput(tx, row));
  }

  /** Audit ids, kind and mode only; actor is the deciding human (the transaction's user) unless named. */
  const auditIds = (row: ApprovalRow) => ({ approvalId: row.id, kind: row.kind, mode: row.mode });

  /**
   * Who may see a request: whoever may decide it now, the human it was requested for, and whoever decided it. Anyone
   * else gets 404, so the existence of a request never leaks (a personal-scope kind decides only its owner).
   */
  async function visibility(tx: Tx, kind: ApprovalKind, row: ApprovalRow, viewer: string) {
    const canDecide = await kind.canDecide(tx, viewer, row);
    const visible = canDecide || row.requestedForUserId === viewer || row.decidedBy === viewer;
    return { canDecide, visible };
  }

  /** The requests mirrored by these card messages (RLS: this organization only). */
  async function byCard(tx: Tx, messageIds: readonly string[]): Promise<Locked[]> {
    if (messageIds.length === 0) return [];
    const rows = await tx
      .select(withExpiry)
      .from(approvalRequests)
      .where(inArray(approvalRequests.cardMessageId, [...messageIds]));
    return rows.map((r) => ({ ...r.row, expired: r.expired }));
  }

  const linkedCards: LinkedCards = {
    async linkOf(tx, messageIds) {
      const out = new Map<string, LinkedCardInfo>();
      for (const row of await byCard(tx, messageIds)) {
        if (row.cardMessageId) out.set(row.cardMessageId, await linkOf(tx, row));
      }
      return out;
    },
    async canDecide(tx, messageIds, userId) {
      const out = new Set<string>();
      for (const row of await byCard(tx, messageIds)) {
        const kind = registry.get(row.kind);
        if (row.cardMessageId && kind && (await kind.canDecide(tx, userId, row))) out.add(row.cardMessageId);
      }
      return out;
    },
    async decide(tx, input) {
      const [row] = await byCard(tx, [input.messageId]);
      if (!row) throw notFound("Card not found", "card_not_found");
      return service.decide(tx, {
        id: row.id,
        deciderUserId: input.deciderUserId,
        outcome: input.outcome,
        actionHash: input.actionHash,
        note: input.note,
        shownOnCard: true,
      });
    },
  };

  /**
   * Posts the platform-owned mirror of a new request where it was born: the kind composes title, fields, summary and
   * its Open action; the service forces kind `approval`, status `pending` and its own Approve action (no approver
   * list: the kind decides), stores the kind's warnings and links the card to the request. 07.5: a kind may turn the
   * in-card decision off (`inlineDecision: false`, only the Open action; deciding stays `canDecide` behind the review
   * and the card route), name the Approve, Deny and Open buttons (`labels`) and post a `work_zone` card (`cardKind`).
   */
  async function postMirror(
    tx: Tx,
    kind: ApprovalKind,
    row: ApprovalRow,
    target: NonNullable<RequestApprovalInput["card"]>,
  ): Promise<string> {
    if (!kind.card) throw new Error(`approval kind "${kind.kind}" has no card`);
    const composed = await kind.card(tx, row);
    const warnings = (composed.warnings ?? []).slice(0, MAX_WARNINGS).map((w) => w.slice(0, 200));
    const labels = composed.labels ?? {};
    const card = AgentCardInput.parse({
      ...composed.card,
      kind: composed.cardKind ?? "approval",
      status: "pending",
      actions: [
        ...(composed.inlineDecision === false
          ? []
          : [{ kind: "approve", label: labels.approve ?? "Approve", denyLabel: labels.deny ?? "Deny" }]),
        ...composed.card.actions
          .filter((a) => a.kind === "open")
          .map((a) => (labels.open ? { ...a, label: labels.open } : a)),
      ],
    });
    const posted = await core.chatAgent.postAgentMessageIn(tx, {
      agentId: target.agentId,
      conversationId: target.conversationId,
      threadRootId: target.threadRootMessageId,
      body: card.summary,
      idempotencyKey: `approval:${row.id}`,
      inReplyToMessageId: target.inReplyToMessageId,
      ...(row.requestedForUserId ? { onBehalfOfUserId: row.requestedForUserId } : {}),
      card,
      cardPlatformOwned: true,
    });
    await tx
      .update(approvalRequests)
      .set({ cardMessageId: posted.messageId, cardWarnings: warnings })
      .where(eq(approvalRequests.id, row.id));
    // The card was announced before this link existed: announce it again so live readers get the approval link.
    if (posted.created) await announceCardMessage(tx, core, posted.messageId);
    return posted.messageId;
  }

  const service: ApprovalService = {
    linkedCards,
    register: (kind) => registry.register(kind),

    async request(tx, input) {
      const kind = registry.get(input.kind);
      if (!kind) throw new Error(`approval kind "${input.kind}" is not registered`);
      const { organizationId } = tenantOf(tx);
      const [inserted] = await tx
        .insert(approvalRequests)
        .values({
          organizationId,
          kind: kind.kind,
          mode: kind.mode,
          resourceType: kind.resourceType,
          resourceId: input.resourceId,
          actionHash: PENDING_HASH,
          requestedByAgentId: input.requestedByAgentId,
          requestedForUserId: input.requestedForUserId,
          eventId: input.eventId,
          expiresAt: sql`now() + make_interval(secs => ${ttlOf(kind.ttlMs, input.ttlMs) / 1000})`,
        })
        .returning();
      if (!inserted) throw new Error("approval insert returned no row");
      const hash = await recompute(tx, kind, inserted);
      const [row] = await tx
        .update(approvalRequests)
        .set({ actionHash: hash })
        .where(eq(approvalRequests.id, inserted.id))
        .returning();
      if (!row) throw new Error("approval hash update returned no row");
      await core.audit.record(tx, {
        action: "approval.requested",
        resourceType: "approval_request",
        resourceId: row.id,
        ...(row.requestedByAgentId
          ? { actorKind: "agent" as const, actorId: row.requestedByAgentId, agentId: row.requestedByAgentId }
          : {}),
        metadata: { ...auditIds(row), resourceType: row.resourceType, resourceId: row.resourceId },
      });
      // Stream lock order (`announce`): the card's conversation, then the `user:` streams, taken up front because the
      // card's own post notifies people (their `user:` streams) before this request is announced.
      if (input.card) {
        await core.realtime.lockStreams(tx, [
          convTopic(input.card.conversationId),
          ...(await announcedTo(tx, kind, row, [])).map((id) => `user:${id}`),
        ]);
      }
      const cardMessageId = input.card ? await postMirror(tx, kind, row, input.card) : null;
      await announce(tx, kind, row, []);
      return { id: row.id, actionHash: hash, cardMessageId };
    },

    async decide(tx, input) {
      const row = await lockRow(tx, input.id);
      const kind = row ? registry.get(row.kind) : undefined;
      if (!row || !kind) throw notFoundError();
      const { canDecide, visible } = await visibility(tx, kind, row, input.deciderUserId);
      if (!visible && !input.shownOnCard) throw notFoundError();
      if (row.status !== "pending") {
        throw conflict("This request was already decided", "approval_already_decided");
      }
      if (row.expired) throw conflict("This request expired", "approval_expired");
      if (!canDecide) throw forbidden("You cannot decide this request", "not_approver");
      const recomputed = await recompute(tx, kind, row);
      if (recomputed !== row.actionHash || input.actionHash !== row.actionHash) {
        throw conflict(
          "The action changed since it was requested or shown; reload it",
          "approval_action_changed",
        );
      }
      const note = input.note ?? null;
      const [decided] = await tx
        .update(approvalRequests)
        .set({
          status: input.outcome,
          decidedBy: input.deciderUserId,
          decidedAt: sql`now()`,
          decisionNote: note,
        })
        .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.status, "pending")))
        .returning();
      if (!decided) throw conflict("This request was already decided", "approval_already_decided");
      const isPrivate = note !== null && kind.isPrivate ? await kind.isPrivate(tx, decided) : false;
      await core.audit.record(tx, {
        action: "approval.decided",
        resourceType: "approval_request",
        resourceId: decided.id,
        metadata: {
          ...auditIds(decided),
          outcome: input.outcome,
          ...(note === null ? {} : isPrivate ? { noteChars: note.length } : { note }),
          // The decider is the human the request was made for (allowed by the kind's canDecide): a flag, no names.
          ...(decided.requestedForUserId === input.deciderUserId ? { selfApproved: true } : {}),
        },
      });

      let final: ApprovalRow = decided;
      if (input.outcome === "approved" && kind.mode === "server_apply") {
        // Stream lock order (#224): the card's conversation, then every `user:` stream this decision appends to
        // (what `apply` announces and who `announce` tells), ascending, before `apply` writes its own events.
        await lockDecisionStreams(tx, kind, decided, input.deciderUserId);
        final = await applyApproved(tx, kind, decided, recomputed, input.deciderUserId);
      }
      // Stream lock order (`announce`): the card's conversation, then the `user:` streams, then the bot's card action.
      const announced = () => announce(tx, kind, final, [input.deciderUserId]);
      const dir = await loadDirectory(tx);
      if (!final.cardMessageId) await announced();
      else {
        const status = final.status as keyof typeof CARD_STATUS;
        await mirrorCardDecision(tx, core, {
          messageId: final.cardMessageId,
          outcome: input.outcome,
          deciderUserId: input.deciderUserId,
          // WINDOWS 135: an approved grant is not done until the bot uses it (`consumeGrant` → succeeded).
          status:
            kind.mode === "grant" && final.status === "approved"
              ? "running"
              : (CARD_STATUS[status] ?? "succeeded"),
          note,
          ...(await cardTurnOf(tx, kind, final, input, dir)),
          // 07.5-11: an approved request that failed to apply tells the bot why (the card already shows it).
          ...(final.status === "failed" && final.resultCode ? { resultCode: final.resultCode } : {}),
          beforeCardAction: announced,
        });
      }
      return summaryOf({ ...final, expired: false }, dir, false);
    },

    async consumeGrant(tx, input) {
      const row = await lockRow(tx, input.id);
      const kind = row ? registry.get(row.kind) : undefined;
      if (!row || !kind || row.kind !== input.kind || kind.mode !== "grant") {
        return { ok: false, code: "approval_not_found" };
      }
      if (row.status === "applied" || row.consumedAt) return { ok: false, code: "already_used" };
      if (row.status === "pending") {
        return { ok: false, code: row.expired ? "approval_expired" : "not_approved" };
      }
      if (row.status !== "approved") return { ok: false, code: "not_approved" };
      if (row.expired) return { ok: false, code: "approval_expired" };
      const recomputed = await recompute(tx, kind, row);
      if (recomputed !== row.actionHash || input.actionHash !== row.actionHash) {
        return { ok: false, code: "approval_action_changed" };
      }
      const [used] = await tx
        .update(approvalRequests)
        .set({ consumedAt: sql`now()`, appliedAt: sql`now()`, status: "applied" })
        .where(
          and(
            eq(approvalRequests.id, row.id),
            eq(approvalRequests.status, "approved"),
            isNull(approvalRequests.consumedAt),
            eq(approvalRequests.actionHash, recomputed),
          ),
        )
        .returning();
      if (!used) return { ok: false, code: "already_used" };
      await core.audit.record(tx, {
        action: "approval.grant_consumed",
        resourceType: "approval_request",
        resourceId: used.id,
        metadata: auditIds(used),
      });
      // WINDOWS 135: the card turns from "approved" (running) to "used" (succeeded) only now; approval row first, then card.
      if (used.cardMessageId) await mirrorCardUsed(tx, core, { messageId: used.cardMessageId });
      await announce(tx, kind, used, [used.decidedBy]);
      return { ok: true };
    },

    async applyOwn(tx, input, act) {
      const row = await lockRow(tx, input.id);
      const kind = row ? registry.get(row.kind) : undefined;
      if (!row || !kind || row.kind !== input.kind || row.requestedForUserId !== input.userId) {
        throw new HttpError(400, "approval_not_found", "That proposal was not found");
      }
      if (row.status !== "pending") {
        throw conflict("This request was already decided", "approval_already_decided");
      }
      if (row.expired) throw conflict("This request expired", "approval_expired");
      // Stream lock order (#224): the card's conversation, then every `user:` stream, before `act` appends to any.
      await lockDecisionStreams(tx, kind, row, input.userId);
      const out = await act(row);
      const [final] = await tx
        .update(approvalRequests)
        .set({
          status: "applied",
          decidedBy: input.userId,
          decidedAt: sql`now()`,
          consumedAt: sql`now()`,
          appliedAt: sql`now()`,
        })
        .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.status, "pending")))
        .returning();
      if (!final) throw conflict("This request was already decided", "approval_already_decided");
      await core.audit.record(tx, {
        action: "approval.decided",
        resourceType: "approval_request",
        resourceId: final.id,
        metadata: { ...auditIds(final), outcome: "approved", selfApproved: true, edited: true },
      });
      await core.audit.record(tx, {
        action: "approval.applied",
        resourceType: "approval_request",
        resourceId: final.id,
        metadata: { ...auditIds(final), edited: true },
      });
      const announced = () => announce(tx, kind, final, [input.userId]);
      if (!final.cardMessageId) await announced();
      else {
        const dir = await loadDirectory(tx);
        await mirrorCardDecision(tx, core, {
          messageId: final.cardMessageId,
          outcome: "approved",
          deciderUserId: input.userId,
          status: "succeeded",
          note: null,
          decidedBy: { id: input.userId, displayName: authorOf(dir, "user", input.userId).displayName },
          beforeCardAction: announced,
        });
      }
      return out;
    },

    async closeGone(tx, which) {
      const ids =
        "ids" in which
          ? [...new Set(which.ids)]
          : (
              await tx
                .select({ id: approvalRequests.id })
                .from(approvalRequests)
                .where(
                  and(
                    eq(approvalRequests.requestedByAgentId, which.requestedByAgentId),
                    eq(approvalRequests.status, "pending"),
                  ),
                )
            ).map((r) => r.id);
      const closed: string[] = [];
      for (const id of ids.sort()) {
        const row = await lockRow(tx, id);
        const kind = row ? registry.get(row.kind) : undefined;
        if (!row || !kind?.gone || row.status !== "pending") continue;
        const code = await kind.gone(tx, row);
        if (!code) continue;
        const [final] = await tx
          .update(approvalRequests)
          .set({ status: "failed", resultCode: code.slice(0, 64) })
          .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.status, "pending")))
          .returning();
        if (!final) continue;
        await core.audit.record(tx, {
          action: "approval.closed",
          resourceType: "approval_request",
          resourceId: final.id,
          result: "error",
          metadata: { ...auditIds(final), resultCode: final.resultCode },
        });
        if (final.cardMessageId) {
          await mirrorCardClosed(tx, core, { messageId: final.cardMessageId, status: "failed" });
        }
        await announce(tx, kind, final, []);
        closed.push(final.id);
      }
      return closed;
    },

    async get(tx, id, viewerUserId) {
      const row = await readRow(tx, id);
      const kind = row ? registry.get(row.kind) : undefined;
      if (!row || !kind) throw notFoundError();
      const { canDecide, visible } = await visibility(tx, kind, row, viewerUserId);
      if (!visible) throw notFoundError();
      return {
        ...(await withHeadline(
          tx,
          kind,
          row,
          summaryOf(row, await loadDirectory(tx), canDecide),
          viewerUserId,
        )),
        view: await kind.view(tx, row, viewerUserId),
      };
    },

    async list(tx, viewerUserId, q) {
      // Fail closed even if a caller bypasses the route's schema: an unknown role lists nothing.
      if (q.role !== "decider" && q.role !== "requester") {
        throw new HttpError(400, "validation_error", "role must be decider or requester");
      }
      // 07.5 (UI-SPEC R1): a kinds-filtered inbox also gets its pending `total`; without `kinds` the 07.2 shape stays.
      const withTotal = q.kinds !== undefined;
      const kinds = registry.kinds();
      if (kinds.length === 0) return { items: [], nextCursor: null, ...(withTotal ? { total: 0 } : {}) };
      // Which requests the query is about, whatever their status (shared with the pending total).
      const scope: SQL[] = [inArray(approvalRequests.kind, kinds)];
      if (q.kind) scope.push(eq(approvalRequests.kind, q.kind));
      if (q.kinds) scope.push(inArray(approvalRequests.kind, q.kinds));
      if (q.role === "requester") scope.push(eq(approvalRequests.requestedForUserId, viewerUserId));
      const filters: SQL[] = [...scope];
      if (q.status === "expired") {
        filters.push(eq(approvalRequests.status, "pending"), sql`${approvalRequests.expiresAt} <= now()`);
      } else if (q.status === "pending") {
        filters.push(eq(approvalRequests.status, "pending"), sql`${approvalRequests.expiresAt} > now()`);
      } else if (q.status) {
        filters.push(eq(approvalRequests.status, q.status));
      }
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;

      const items: ApprovalSummary[] = [];
      let dir: Directory | null = null;
      let after = cursor;
      let scanned = 0;
      let more = true;
      scan: while (scanned < SCAN_LIMIT) {
        const batch = await tx
          .select(withExpiry)
          .from(approvalRequests)
          .where(and(...filters, ...(after ? [lt(approvalRequests.id, after)] : [])))
          .orderBy(desc(approvalRequests.id))
          .limit(BATCH);
        for (const r of batch) {
          scanned += 1;
          after = r.row.id;
          const row: Locked = { ...r.row, expired: r.expired };
          const kind = registry.get(row.kind);
          if (!kind) continue;
          // The same rule as `get`, whatever the role: a row the viewer may neither decide nor asked for nor decided is
          // never listed (live: a decider who lost the right stops seeing it). Then the role narrows it.
          const { canDecide, visible } = await visibility(tx, kind, row, viewerUserId);
          if (!visible || !inRole(q.role, row, canDecide, viewerUserId)) continue;
          dir ??= await loadDirectory(tx);
          // Every listed row says whether its kind has a line: the kind's headline for this viewer, or null.
          items.push({
            ...summaryOf(row, dir, canDecide),
            headline: await headlineOf(tx, kind, row, viewerUserId),
          });
          if (items.length === PAGE) break scan;
        }
        if (batch.length < BATCH) {
          more = false;
          break;
        }
      }
      const nextCursor = more && after ? encodeCursor(after) : null;
      if (!withTotal) return { items, nextCursor };
      // A first page of pending requests that holds them all already is the total.
      const total =
        q.status === "pending" && !q.cursor && nextCursor === null
          ? Math.min(items.length, TOTAL_CAP)
          : await pendingTotal(tx, viewerUserId, q.role, scope);
      return { items, nextCursor, total };
    },
  };

  /**
   * How many pending (not expired) requests in `scope` the viewer would list in `role`, by the same live visibility
   * rule as `list`, capped at `TOTAL_CAP`; at most `TOTAL_SCAN_LIMIT` rows are read (then it is a lower bound).
   */
  async function pendingTotal(
    tx: Tx,
    viewerUserId: string,
    role: "decider" | "requester",
    scope: readonly SQL[],
  ): Promise<number> {
    const filters = [
      ...scope,
      eq(approvalRequests.status, "pending"),
      sql`${approvalRequests.expiresAt} > now()`,
    ];
    let count = 0;
    let scanned = 0;
    let after: string | null = null;
    while (scanned < TOTAL_SCAN_LIMIT) {
      const batch = await tx
        .select(withExpiry)
        .from(approvalRequests)
        .where(and(...filters, ...(after ? [lt(approvalRequests.id, after)] : [])))
        .orderBy(desc(approvalRequests.id))
        .limit(BATCH);
      for (const r of batch) {
        scanned += 1;
        after = r.row.id;
        const row: Locked = { ...r.row, expired: r.expired };
        const kind = registry.get(row.kind);
        if (!kind) continue;
        const { canDecide, visible } = await visibility(tx, kind, row, viewerUserId);
        if (visible && inRole(role, row, canDecide, viewerUserId)) count += 1;
        if (count === TOTAL_CAP) return count;
      }
      if (batch.length < BATCH) break;
    }
    return count;
  }

  /**
   * Consumes the one-use grant (conditional on the hash just recomputed) and applies the action in a savepoint: a
   * result that is not ok rolls back every write of `apply` and marks the request `failed` with its code.
   */
  async function applyApproved(
    tx: Tx,
    kind: ApprovalKind,
    row: ApprovalRow,
    recomputed: string,
    deciderUserId: string,
  ): Promise<ApprovalRow> {
    const [consumed] = await tx
      .update(approvalRequests)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(approvalRequests.id, row.id),
          eq(approvalRequests.status, "approved"),
          isNull(approvalRequests.consumedAt),
          eq(approvalRequests.actionHash, recomputed),
        ),
      )
      .returning();
    if (!consumed || !kind.apply) {
      throw new HttpError(409, "approval_already_decided", "This request was already used");
    }
    const apply = kind.apply;
    const result: ApplyResult = await withSavepoint(
      tx,
      (sp) => apply(sp, consumed, { deciderUserId }),
      (r) => r.ok,
    );
    const [final] = await tx
      .update(approvalRequests)
      .set(
        result.ok
          ? { status: "applied", appliedAt: sql`now()` }
          : { status: "failed", resultCode: result.code.slice(0, 64) },
      )
      .where(eq(approvalRequests.id, row.id))
      .returning();
    if (!final) throw new Error("approval result update returned no row");
    await core.audit.record(tx, {
      action: result.ok ? "approval.applied" : "approval.apply_failed",
      resourceType: "approval_request",
      resourceId: final.id,
      ...(result.ok ? {} : { result: "error" as const }),
      metadata: { ...auditIds(final), ...(result.ok ? {} : { resultCode: final.resultCode }) },
    });
    return final;
  }

  /**
   * The card-action turn fields of a decision (P-06): every kind names the decider (`decidedBy`); a `grant` kind with a
   * requester re-runs for that requester (`turnUserId`), carries its grant on `approved` and starts tainted when the
   * request came from a tainted turn. `server_apply` kinds keep the decider as the turn's human (07.2 rule).
   */
  async function cardTurnOf(
    tx: Tx,
    kind: ApprovalKind,
    row: ApprovalRow,
    input: DecideInput,
    dir: Directory,
  ): Promise<
    Pick<CardAction, "turnUserId" | "decidedBy" | "grant" | "tainted" | "memberData" | "sessionOutputRead">
  > {
    const decidedBy = {
      id: input.deciderUserId,
      displayName: authorOf(dir, "user", input.deciderUserId).displayName,
    };
    if (kind.mode !== "grant" || !row.requestedForUserId) return { decidedBy };
    const turn = kind.cardTurn ? await kind.cardTurn(tx, row) : null;
    return {
      decidedBy,
      turnUserId: row.requestedForUserId,
      ...(turn?.grant && input.outcome === "approved" ? { grant: turn.grant } : {}),
      ...(turn?.sourceTainted === true ? { tainted: true } : {}),
      ...(turn?.sourceMemberData === true ? { memberData: true } : {}),
      ...(turn?.sourceSessionOutputRead === true ? { sessionOutputRead: true } : {}),
    };
  }

  return service;
}

/** The role filter of the inbox, applied after the visibility rule: what I may decide (or decided), or what I asked for. */
function inRole(
  role: "decider" | "requester",
  row: ApprovalRow,
  canDecide: boolean,
  viewer: string,
): boolean {
  return role === "decider" ? canDecide || row.decidedBy === viewer : row.requestedForUserId === viewer;
}

/** The list cursor: the last scanned id (ids are uuidv7, so id order is creation order). */
function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "invalid_cursor", "Invalid cursor");
  return id;
}
