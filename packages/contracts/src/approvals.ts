import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { MemoryProposalView } from "./memory";
import { ApprovalOrigin, ToolCallApprovalView } from "./tool-approvals";

/**
 * Approve-and-apply (Phase 07.2, D-05, D-08, ADR-0023): a generic approval a person decides and the server applies
 * (`server_apply`) or that grants exactly one action (`grant`, Phase 07.5). Every decision names the hash of the exact
 * action the approver was shown; the server recomputes it and refuses a mismatch (`approval_action_changed`).
 * Never imports `chat.ts` or `agent-cards.ts` (agent-cards imports this file); imports the 07.5 view files
 * (`tool-approvals.ts`, `work-zone-proposals.ts`), which never import it.
 */

/**
 * `expired` is derived: a pending request past `expiresAt` reads as expired. Named `ApprovalRequestStatus` (like the
 * `approval_requests` table) because `ApprovalStatus` is the Work Zone approval status in `work-session.ts`.
 */
export const ApprovalRequestStatus = z.enum([
  "pending",
  "approved",
  "denied",
  "applied",
  "failed",
  "expired",
]);
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatus>;

/** `server_apply`: the server applies the action in the decision transaction. `grant`: one later use (07.5). */
export const ApprovalMode = z.enum(["server_apply", "grant"]);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

/** An open set of dotted kind ids (`memory.write`, `tool.call`, …); the API's registry decides which exist. */
export const ApprovalKindId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
export type ApprovalKindId = z.infer<typeof ApprovalKindId>;

/**
 * The kinds known so far. Append-only: later phases add theirs (07.5 tool calls, 07.6 automations) and never rename
 * one. A kind without a dedicated view uses the generic `fields` view.
 */
export const KNOWN_APPROVAL_KINDS = ["memory.write", "tool.call", "work_zone.start"] as const;
export type KnownApprovalKind = (typeof KNOWN_APPROVAL_KINDS)[number];

/** SHA-256 of the kind's fixed-order action tuple, lowercase hex. */
export const ActionHash = z.string().regex(/^[0-9a-f]{64}$/);
export type ActionHash = z.infer<typeof ActionHash>;

export const APPROVAL_NOTE_MAX = 280;

/** Plain text: line breaks and tabs are fine, other control characters are refused. */
const NO_CONTROL = /^[^\p{Cc}]*$/u;
const plainText = (s: string) => NO_CONTROL.test(s.replace(/[\n\t]/g, ""));

/** The approver's optional note, shown on the decision line and in the bot's card-action turn (UI-SPEC R4). */
export const ApprovalNote = z
  .string()
  .trim()
  .min(1)
  .max(APPROVAL_NOTE_MAX)
  .refine(plainText, { message: "must be plain text" });
export type ApprovalNote = z.infer<typeof ApprovalNote>;

/** `POST /api/v1/approvals/:id/decision`. */
export const ApprovalDecisionRequest = z.object({
  outcome: z.enum(["approved", "denied"]),
  /** The hash the approver was shown; a mismatch is 409 `approval_action_changed`. */
  actionHash: ActionHash,
  note: ApprovalNote.optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

/** A short chip of an inbox row ("IBAN", "Used web content"): `warning` reads amber, `neutral` outlined. */
export const ApprovalTag = z.object({
  label: z.string().trim().min(1).max(40),
  tone: z.enum(["warning", "neutral"]),
});
export type ApprovalTag = z.infer<typeof ApprovalTag>;

/**
 * What an inbox row shows without opening the request (07.2-13, D-08): composed by the kind on the server from the
 * stored action, plain text only (never Markdown). Visible exactly to whoever may see the request itself.
 */
export const ApprovalHeadline = z.object({
  /** "Append to clients/acme.md". */
  title: z.string().trim().min(1).max(200),
  /** Where it applies ("Ventas · Team", "You & Scout · Private"); null when the target is gone. */
  context: z.string().max(120).nullable(),
  /** Who asked ("Scout for Sam Lee"). */
  requester: z.string().max(200),
  tags: z.array(ApprovalTag).max(8),
  // Phase 07.5 (UI-SPEC Surface 2 rows): optional, so 07.2 headlines still parse.
  /** The bot that asked (row avatar). */
  agent: z
    .object({ id: Id, displayName: z.string().max(200) })
    .nullable()
    .optional(),
  /** Where it was asked ("# ops", "DM"). */
  origin: ApprovalOrigin.nullable().optional(),
  /** Row chips: the action's source, the Work Zone device with its state, outside content. */
  chips: z
    .array(
      z.object({
        kind: z.enum(["source", "device", "tainted"]),
        label: z.string().trim().min(1).max(80),
        icon: z.enum(["plug", "globe", "package"]).optional(),
        state: z.enum(["online", "offline"]).optional(),
      }),
    )
    .max(3)
    .optional(),
  /** An approved grant's use window end (`tool.call`). */
  useBy: IsoDateTime.nullable().optional(),
});
export type ApprovalHeadline = z.infer<typeof ApprovalHeadline>;

export const ApprovalSummary = z.object({
  id: Id,
  kind: ApprovalKindId,
  mode: ApprovalMode,
  status: ApprovalRequestStatus,
  actionHash: ActionHash,
  /** The agent and the human it acted for; either may be null for system requests. */
  requestedBy: z.object({ agentId: Id.nullable(), userId: Id.nullable(), displayName: z.string() }),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
  decidedBy: z.object({ id: Id, displayName: z.string() }).nullable(),
  decisionNote: z.string().max(APPROVAL_NOTE_MAX).nullable(),
  /** Why an approved request failed to apply (a kind-defined code), null otherwise. */
  resultCode: z.string().max(64).nullable(),
  /** The resolver's live decision for the viewer. */
  viewerCan: z.array(z.enum(["decide"])),
  /** The kind's one-line description for lists; absent or null for kinds without one (07.2-13, 07.5-06). */
  headline: ApprovalHeadline.nullable().optional(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummary>;

/** A label and value pair of the generic view (same bounds as an Agent Card field). */
export const ApprovalField = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(500),
});
export type ApprovalField = z.infer<typeof ApprovalField>;

/** What the approver is shown: a kind-specific view, or the generic title-and-fields view any later kind can use. */
export const ApprovalView = z.discriminatedUnion("type", [
  z.object({ type: z.literal("memory_proposal"), proposal: MemoryProposalView }),
  z.object({
    type: z.literal("fields"),
    title: z.string().trim().min(1).max(200),
    fields: z.array(ApprovalField).max(12),
  }),
  // Phase 07.5: exactly the call a bot asks to run once.
  ToolCallApprovalView,
]);
export type ApprovalView = z.infer<typeof ApprovalView>;

/** `GET /api/v1/approvals/:id`. */
export const ApprovalDetail = ApprovalSummary.extend({ view: ApprovalView });
export type ApprovalDetail = z.infer<typeof ApprovalDetail>;

/** `?kinds=tool.call,work_zone.start`: 1 to 4 kind ids, comma-separated (an empty item is refused). */
export const ApprovalKindsParam = z
  .string()
  .max(300)
  .transform((v) => v.split(","))
  .pipe(z.array(ApprovalKindId).min(1).max(4));
export type ApprovalKindsParam = z.infer<typeof ApprovalKindsParam>;

/** `GET /api/v1/approvals`: what the caller may decide, or what the caller's agents asked for. */
export const ApprovalListQuery = z.object({
  role: z.enum(["decider", "requester"]),
  status: ApprovalRequestStatus.optional(),
  kind: ApprovalKindId.optional(),
  /** Phase 07.5 (UI-SPEC R1): only these kinds; combined with `kind` = the intersection; absent = all. */
  kinds: ApprovalKindsParam.optional(),
  cursor: z.string().max(200).optional(),
});
export type ApprovalListQuery = z.infer<typeof ApprovalListQuery>;

export const ApprovalList = z.object({
  items: z.array(ApprovalSummary),
  nextCursor: z.string().nullable(),
  /** Phase 07.5: pending requests matching the filters, capped at 100 (nav badges and the tab count). */
  total: z.number().int().min(0).max(100).optional(),
});
export type ApprovalList = z.infer<typeof ApprovalList>;

export const ApprovalErrorCode = z.enum([
  "approval_not_found",
  "approval_expired",
  "not_approver",
  "approval_action_changed",
  "approval_already_decided",
  "action_hash_required",
]);
export type ApprovalErrorCode = z.infer<typeof ApprovalErrorCode>;

/** `approval_request.updated`, on the deciders' and the requester's `user:<id>` streams only: ids and status. */
export const ApprovalRequestUpdatedEvent = z.object({ id: Id, status: ApprovalRequestStatus });
export type ApprovalRequestUpdatedEvent = z.infer<typeof ApprovalRequestUpdatedEvent>;
