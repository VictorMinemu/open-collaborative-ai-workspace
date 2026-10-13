import {
  type ApprovalDetail,
  type ApprovalList,
  type ApprovalListQuery,
  type ApprovalRequestStatus,
  type ApprovalRequestUpdatedEvent,
  type ApprovalSummary,
  EventTypes,
} from "@ocw/contracts";
import { approvalRequests, type Tx, tenantOf, withSavepoint } from "@ocw/db";
import { and, desc, eq, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { conflict, forbidden, HttpError, notFound } from "../../lib/errors";
import { authorOf, type Directory, loadDirectory } from "../chat";
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
}

export interface DecideInput {
  id: string;
  deciderUserId: string;
  outcome: "approved" | "denied";
  actionHash: string;
  note?: string | undefined;
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
  request(tx: Tx, input: RequestApprovalInput): Promise<{ id: string; actionHash: string }>;
  decide(tx: Tx, input: DecideInput): Promise<ApprovalSummary>;
  consumeGrant(tx: Tx, input: { id: string; kind: string; actionHash: string }): Promise<ConsumeGrantResult>;
  get(tx: Tx, id: string, viewerUserId: string): Promise<ApprovalDetail>;
  list(tx: Tx, viewerUserId: string, q: ApprovalListQuery): Promise<ApprovalList>;
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

function iso(v: string): string {
  return new Date(v).toISOString();
}

/** `expired` is derived: a pending request past its expiry reads as expired; nothing ever stores it. */
function shownStatus(row: Locked): ApprovalRequestStatus {
  return row.status === "pending" && row.expired ? "expired" : row.status;
}

export function createApprovalService(core: Pick<Core, "audit" | "realtime">): ApprovalService {
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

  /** The deciders' and the requester's `user:` streams (plus extra ids), ids and status only, never `org:`. */
  async function announce(tx: Tx, kind: ApprovalKind, row: ApprovalRow, extra: Array<string | null>) {
    const to = new Set<string>(await kind.audience(tx, row));
    for (const id of [row.requestedForUserId, ...extra]) if (id) to.add(id);
    const ev: ApprovalRequestUpdatedEvent = { id: row.id, status: row.status };
    for (const userId of to) {
      await core.realtime.appendEvent(tx, `user:${userId}`, EventTypes.approvalRequestUpdated, ev);
    }
  }

  async function recompute(tx: Tx, kind: ApprovalKind, row: ApprovalRow): Promise<string> {
    return actionHash(row.kind, await kind.hashInput(tx, row));
  }

  /** Audit ids, kind and mode only; actor is the deciding human (the transaction's user) unless named. */
  const ids = (row: ApprovalRow) => ({ approvalId: row.id, kind: row.kind, mode: row.mode });

  /**
   * Who may see a request: whoever may decide it now, the human it was requested for, and whoever decided it. Anyone
   * else gets 404, so the existence of a request never leaks (a personal-scope kind decides only its owner).
   */
  async function visibility(tx: Tx, kind: ApprovalKind, row: ApprovalRow, viewer: string) {
    const canDecide = await kind.canDecide(tx, viewer, row);
    const visible = canDecide || row.requestedForUserId === viewer || row.decidedBy === viewer;
    return { canDecide, visible };
  }

  const service: ApprovalService = {
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
          expiresAt: sql`now() + make_interval(secs => ${kind.ttlMs / 1000})`,
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
        metadata: { ...ids(row), resourceType: row.resourceType, resourceId: row.resourceId },
      });
      await announce(tx, kind, row, []);
      return { id: row.id, actionHash: hash };
    },

    async decide(tx, input) {
      const row = await lockRow(tx, input.id);
      const kind = row ? registry.get(row.kind) : undefined;
      if (!row || !kind) throw notFoundError();
      const { canDecide, visible } = await visibility(tx, kind, row, input.deciderUserId);
      if (!visible) throw notFoundError();
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
          ...ids(decided),
          outcome: input.outcome,
          ...(note === null ? {} : isPrivate ? { noteChars: note.length } : { note }),
        },
      });

      let final: ApprovalRow = decided;
      if (input.outcome === "approved" && kind.mode === "server_apply") {
        final = await applyApproved(tx, kind, decided, recomputed, input.deciderUserId);
      }
      await announce(tx, kind, final, [input.deciderUserId]);
      return summaryOf({ ...final, expired: false }, await loadDirectory(tx), false);
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
        metadata: ids(used),
      });
      await announce(tx, kind, used, [used.decidedBy]);
      return { ok: true };
    },

    async get(tx, id, viewerUserId) {
      const row = await readRow(tx, id);
      const kind = row ? registry.get(row.kind) : undefined;
      if (!row || !kind) throw notFoundError();
      const { canDecide, visible } = await visibility(tx, kind, row, viewerUserId);
      if (!visible) throw notFoundError();
      return {
        ...summaryOf(row, await loadDirectory(tx), canDecide),
        view: await kind.view(tx, row, viewerUserId),
      };
    },

    async list(tx, viewerUserId, q) {
      const kinds = registry.kinds();
      if (kinds.length === 0) return { items: [], nextCursor: null };
      const filters: SQL[] = [inArray(approvalRequests.kind, kinds)];
      if (q.kind) filters.push(eq(approvalRequests.kind, q.kind));
      if (q.status === "expired") {
        filters.push(eq(approvalRequests.status, "pending"), sql`${approvalRequests.expiresAt} <= now()`);
      } else if (q.status === "pending") {
        filters.push(eq(approvalRequests.status, "pending"), sql`${approvalRequests.expiresAt} > now()`);
      } else if (q.status) {
        filters.push(eq(approvalRequests.status, q.status));
      }
      if (q.role === "requester") filters.push(eq(approvalRequests.requestedForUserId, viewerUserId));
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
          // Live: a decider who lost the right stops seeing the request (unless they decided it).
          const canDecide = await kind.canDecide(tx, viewerUserId, row);
          if (q.role === "decider" && !canDecide && row.decidedBy !== viewerUserId) continue;
          dir ??= await loadDirectory(tx);
          items.push(summaryOf(row, dir, canDecide));
          if (items.length === PAGE) break scan;
        }
        if (batch.length < BATCH) {
          more = false;
          break;
        }
      }
      return { items, nextCursor: more && after ? encodeCursor(after) : null };
    },
  };

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
      metadata: { ...ids(final), ...(result.ok ? {} : { resultCode: final.resultCode }) },
    });
    return final;
  }

  return service;
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
