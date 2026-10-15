import {
  type AgentCardApprovalLink,
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
   * every listed and viewed request, only after the visibility rule passed, so it may show what `view` shows. The
   * viewer is passed (07.5) so a kind may word it for them; it must never show more than that viewer may see.
   */
  headline?(tx: Tx, row: ApprovalRow, viewerUserId: string): Promise<ApprovalHeadline>;
  /**
   * The server-composed content of the card that mirrors the request in a conversation (title, fields, summary and an
   * Open action). The service forces kind `approval` (07.5: or `cardKind`), status `pending` and its own Approve
   * action; `warnings` (at most three) are stored on the request and shown on the card. 07.5 (P-07, UI-SPEC R6):
   * `inlineDecision: false` posts no Approve action (deciding stays the kind's `canDecide`, on the review or through the
   * card route); `labels` rename the Approve, Deny and Open buttons.
   */
  card?(tx: Tx, row: ApprovalRow): Promise<ApprovalCardContent>;
  /**
   * 07.5 (UI-SPEC R6, R7, R9): what the card's approval link adds for every reader (labels, times, ids and routes only,
   * never an argument value: it rides realtime events). Only kinds with this hook add `kind`, `expiresAt` and `usedAt`
   * too; the others keep the exact 07.2 link. An invalid result is dropped.
   */
  link?(tx: Tx, row: ApprovalRow): Promise<ApprovalCardLink>;
  /** `server_apply` only: applies the approved action inside the decision transaction (in a savepoint). */
  apply?(tx: Tx, row: ApprovalRow, ctx: { deciderUserId: string }): Promise<ApplyResult>;
  /**
   * `server_apply` only, optional: the realtime topics `apply` will append to. The decision locks the card's
   * conversation and every `user:` stream it will touch (these and the announced people) up front, in one order
   * (conversation, then `user:` ascending), before `apply` runs: the order a message post follows (07.5-16, #224).
   */
  applyTopics?(tx: Tx, row: ApprovalRow): Promise<readonly string[]>;
  /**
   * Whether the stored action can never be applied again, by anyone (its target went with a cascade, the agent that
   * asked was deleted): a result code (e.g. `scope_gone`) lets `closeGone` close a pending request as `failed` with
   * it; null keeps it pending. Asked only by `closeGone`, which the owners of those lifecycles call (07.2, WINDOWS 144).
   */
  gone?(tx: Tx, row: ApprovalRow): Promise<string | null>;
  /** True when the request concerns private data: the decision note is then audited as its length only. */
  isPrivate?(tx: Tx, row: ApprovalRow): Promise<boolean>;
  /**
   * `grant` kinds only (07.5, P-06): what the decision's card-action turn carries besides the decision. The turn is
   * delivered for the human the request was made for (never the decider); `grant` (sent on `approved` only) tells the
   * bot the one call it may now make; `sourceTainted` = the requesting turn had read untrusted content, so the re-run
   * turn starts tainted (the grant lifts taint for its one claimed call only). Asked with the decided row.
   */
  cardTurn?(tx: Tx, row: ApprovalRow): Promise<ApprovalCardTurn | null>;
}

/** What a kind's `card` hook composes (07.2) plus the 07.5 button switches. */
export interface ApprovalCardContent {
  card: AgentCardInput;
  warnings?: string[];
  /** Default true: the card offers Approve / Deny in place. */
  inlineDecision?: boolean;
  labels?: { approve?: string; deny?: string; open?: string };
  /**
   * 07.5 (UI-SPEC Surface 3): the card's kind. Default `approval`; a Work Zone proposal is a `work_zone` card (its header
   * reads "Work Zone"). Only these two: the service still owns the status and the decision actions.
   */
  cardKind?: "approval" | "work_zone";
}

/** The kind-composed fields of a card's approval link (`ApprovalKind.link`). */
export type ApprovalCardLink = Pick<
  AgentCardApprovalLink,
  "display" | "useBy" | "waitingFor" | "actionFields" | "deviceId" | "resultRoute" | "blocked"
>;

/** What a grant kind adds to the re-run turn of a decision (`ApprovalKind.cardTurn`). */
export interface ApprovalCardTurn {
  grant?: { tool: string; arguments: string; useBy: string };
  sourceTainted?: boolean;
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
