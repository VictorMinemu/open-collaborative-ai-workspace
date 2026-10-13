import {
  type AgentCardInput,
  type ApprovalHeadline,
  ApprovalKindId,
  type ApprovalMode,
  type ApprovalView,
} from "@ocw/contracts";
import type { approvalRequests, Tx } from "@ocw/db";
import type { HashAtom } from "./hash";

/** One `app.approval_requests` row, as every kind hook receives it. */
export type ApprovalRow = typeof approvalRequests.$inferSelect;

/** What `apply` reports: a domain conflict is a result code (the request becomes `failed`), never a throw. */
export type ApplyResult = { ok: true } | { ok: false; code: string };

/**
 * One kind of approval (ADR-0023). Registered once per service; every hook runs inside the caller's transaction.
 * `hashInput` reads only the STORED action, so the hash recomputed at decision time proves the action did not change;
 * `canDecide` is evaluated live at every read and decision (never cached at request time) and also decides who may see
 * the request at all (deciders and the requester; everyone else gets 404).
 */
export interface ApprovalKind {
  readonly kind: string;
  readonly mode: ApprovalMode;
  readonly resourceType: string;
  readonly ttlMs: number;
  hashInput(tx: Tx, row: ApprovalRow): Promise<readonly HashAtom[]>;
  canDecide(tx: Tx, deciderUserId: string, row: ApprovalRow): Promise<boolean>;
  /** The users told `approval_request.updated {id, status}` (ids only) besides the requester and the decider. */
  audience(tx: Tx, row: ApprovalRow): Promise<readonly string[]>;
  view(tx: Tx, row: ApprovalRow, viewerUserId: string): Promise<ApprovalView>;
  /**
   * The one-line description an inbox row shows (title, where, who asked, chips), from the stored action. Called for
   * every listed and viewed request, only after the visibility rule passed, so it may show what `view` shows.
   */
  headline?(tx: Tx, row: ApprovalRow): Promise<ApprovalHeadline>;
  /**
   * The server-composed content of the card that mirrors the request in a conversation (title, fields, summary and an
   * Open action). The service forces kind `approval`, status `pending` and its own Approve action; `warnings` (at most
   * three) are stored on the request and shown on the card.
   */
  card?(tx: Tx, row: ApprovalRow): Promise<{ card: AgentCardInput; warnings?: string[] }>;
  /** `server_apply` only: applies the approved action inside the decision transaction (in a savepoint). */
  apply?(tx: Tx, row: ApprovalRow, ctx: { deciderUserId: string }): Promise<ApplyResult>;
  /**
   * Whether the stored action can never be applied again, by anyone (its target went with a cascade, the agent that
   * asked was deleted): a result code (e.g. `scope_gone`) lets `closeGone` close a pending request as `failed` with
   * it; null keeps it pending. Asked only by `closeGone`, which the owners of those lifecycles call (07.2, WINDOWS 144).
   */
  gone?(tx: Tx, row: ApprovalRow): Promise<string | null>;
  /** True when the request concerns private data: the decision note is then audited as its length only. */
  isPrivate?(tx: Tx, row: ApprovalRow): Promise<boolean>;
}

export interface ApprovalRegistry {
  register(kind: ApprovalKind): void;
  get(kind: string): ApprovalKind | undefined;
  kinds(): string[];
}

/** An in-memory registry per service instance. Refuses anything that would make a kind ambiguous or unsafe. */
export function createApprovalRegistry(): ApprovalRegistry {
  const kinds = new Map<string, ApprovalKind>();
  return {
    register(k) {
      if (!ApprovalKindId.safeParse(k.kind).success) throw new Error(`invalid approval kind id "${k.kind}"`);
      if (kinds.has(k.kind)) throw new Error(`approval kind "${k.kind}" is already registered`);
      if (k.mode === "server_apply" && !k.apply) {
        throw new Error(`approval kind "${k.kind}" is server_apply but has no apply hook`);
      }
      if (k.mode === "grant" && k.apply) {
        throw new Error(`approval kind "${k.kind}" is a grant and must not have an apply hook`);
      }
      if (!Number.isSafeInteger(k.ttlMs) || k.ttlMs <= 0) {
        throw new Error(`approval kind "${k.kind}" needs a positive integer ttlMs`);
      }
      if (!k.resourceType) throw new Error(`approval kind "${k.kind}" needs a resourceType`);
      kinds.set(k.kind, k);
    },
    get: (kind) => kinds.get(kind),
    kinds: () => [...kinds.keys()],
  };
}
