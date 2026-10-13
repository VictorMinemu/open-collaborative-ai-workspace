import { z } from "zod";
import { ActionHash, APPROVAL_NOTE_MAX, ApprovalNote, ApprovalRequestStatus } from "./approvals";
import { Id, IsoDateTime, PrincipalKind } from "./common";

/**
 * Phase 6 Agent Cards (AGENT-04, D-07, P-11): a typed card an agent posts with a message and updates in place.
 * Imports `common` and `approvals` only: `chat.ts` imports this file for `Message.card`, so importing `chat.ts` here
 * would be a cycle (`approvals` never imports `chat.ts` or this file).
 * Actions are server-decided; an Open action can only point to an internal app route (`AgentCardRoute`).
 */

export const AGENT_CARD_TITLE_MAX = 200;
export const AGENT_CARD_FIELDS_MAX = 12;
export const AGENT_CARD_ACTIONS_MAX = 4;
export const AGENT_CARD_SUMMARY_MAX = 2_000;
const AGENT_CARD_ROUTE_MAX = 512;

/** The app areas an Open action may lead to (never an external URL). */
export const AGENT_CARD_ROUTE_PREFIXES = [
  "/chat",
  "/work-zone",
  "/bots",
  "/settings",
  "/search",
  "/share",
  // Phase 07.2: memory files and proposals (`/memory/proposals/<id>`).
  "/memory",
] as const;

export const AgentCardKind = z.enum([
  "work_zone",
  "approval",
  "report",
  "artifact",
  "automation",
  "deployment",
  "pr",
  "generic",
]);
export type AgentCardKind = z.infer<typeof AgentCardKind>;

export const AgentCardStatus = z.enum(["info", "pending", "running", "succeeded", "failed", "cancelled"]);
export type AgentCardStatus = z.infer<typeof AgentCardStatus>;

export const AgentCardField = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(500),
});
export type AgentCardField = z.infer<typeof AgentCardField>;

function hasControlCharacter(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * True for an internal app route: one `AGENT_CARD_ROUTE_PREFIXES` entry followed by the end, "/", "?" or "#"; no
 * scheme, no "//", no backslash (browsers read it as "/"), no "." or ".." path segment (also percent-encoded, which
 * the URL parser normalises), no control character, at most 512 characters. The client re-checks it before navigating.
 */
export function isAgentCardRoute(v: string): boolean {
  if (v.length > AGENT_CARD_ROUTE_MAX || hasControlCharacter(v)) return false;
  if (v.includes("\\") || v.includes("//")) return false;
  const prefixed = AGENT_CARD_ROUTE_PREFIXES.some(
    (p) => v.startsWith(p) && (v.length === p.length || ["/", "?", "#"].includes(v.charAt(p.length))),
  );
  if (!prefixed) return false;
  const path = v.split(/[?#]/, 1)[0] ?? "";
  return path.split("/").every((segment) => {
    const s = segment.replace(/%2e/gi, ".");
    return s !== "." && s !== "..";
  });
}

export const AgentCardRoute = z
  .string()
  .max(AGENT_CARD_ROUTE_MAX)
  .refine(isAgentCardRoute, { message: "must be an internal app route" });
export type AgentCardRoute = z.infer<typeof AgentCardRoute>;

const ActionLabel = z.string().trim().min(1).max(40);

export const AgentCardAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), label: ActionLabel, target: AgentCardRoute }),
  z.object({ kind: z.literal("follow"), label: ActionLabel }),
  z.object({
    kind: z.literal("approve"),
    label: ActionLabel,
    denyLabel: ActionLabel.optional(),
    /** When present, only these people may decide (each still needs `channel.read` + `agent_card.approve`). */
    approverIds: z.array(Id).max(20).optional(),
  }),
]);
export type AgentCardAction = z.infer<typeof AgentCardAction>;

const AgentCardActions = z
  .array(AgentCardAction)
  .max(AGENT_CARD_ACTIONS_MAX)
  .refine((actions) => new Set(actions.map((a) => a.kind)).size === actions.length, {
    message: "at most one action of each kind",
  });

export const AgentCardDecision = z.object({
  outcome: z.enum(["approved", "denied"]),
  by: z.object({ kind: PrincipalKind, id: Id.nullable(), displayName: z.string() }),
  at: IsoDateTime,
  /** The approver's note, shown on the decision line (Phase 07.2, UI-SPEC R4). */
  note: z.string().max(APPROVAL_NOTE_MAX).nullable().optional(),
});
export type AgentCardDecision = z.infer<typeof AgentCardDecision>;

/** A platform-owned card's link to its approval request (Phase 07.2, D-05, UI-SPEC R6). */
export const AgentCardApprovalLink = z.object({
  id: Id,
  actionHash: ActionHash,
  status: ApprovalRequestStatus,
  /** The human the agent acted for (a personal-scope proposal is theirs to decide). */
  requestedForUserId: Id.nullable(),
  /** Server-composed warnings, e.g. the taint line. */
  warnings: z.array(z.string().max(200)).max(3),
  /**
   * Why an approved request failed to apply (the kind's code, e.g. `stale_base`), null otherwise; the card says it in
   * words (07.2-17, UI-SPEC Copywriting › failed reasons). Optional: absent on snapshots from before it existed.
   */
  resultCode: z.string().max(64).nullable().optional(),
});
export type AgentCardApprovalLink = z.infer<typeof AgentCardApprovalLink>;

export const AgentCard = z.object({
  kind: AgentCardKind,
  title: z.string().trim().min(1).max(AGENT_CARD_TITLE_MAX),
  fields: z.array(AgentCardField).max(AGENT_CARD_FIELDS_MAX),
  status: AgentCardStatus,
  actions: AgentCardActions,
  /** Optimistic concurrency: only the posting agent updates a card, naming the version it saw. */
  version: z.number().int().positive(),
  decision: AgentCardDecision.nullable(),
  updatedAt: IsoDateTime,
  /** Viewer-specific (REST snapshots only, never on realtime events). */
  following: z.boolean().optional(),
  /** Viewer-specific: what the viewer may do on this card. */
  viewerCan: z.array(z.enum(["follow", "decide"])).optional(),
  /**
   * Phase 07.2 (D-08): composed by the server, never by an agent (an agent PATCH is refused), so a model cannot
   * rewrite findings or reader counts. Absent on older cards.
   */
  platformOwned: z.boolean().optional(),
  /** The approval this card mirrors; deciding the card decides the approval (D-05). */
  approval: AgentCardApprovalLink.nullable().optional(),
});
export type AgentCard = z.infer<typeof AgentCard>;

/** What an agent posts; `summary` becomes the plain-text message body (search and notifications keep working). */
export const AgentCardInput = AgentCard.pick({
  kind: true,
  title: true,
  fields: true,
  status: true,
  actions: true,
}).extend({ summary: z.string().trim().min(1).max(AGENT_CARD_SUMMARY_MAX) });
export type AgentCardInput = z.infer<typeof AgentCardInput>;

export const AgentCardPatch = z
  .object({
    expectedVersion: z.number().int().positive(),
    status: AgentCardStatus.optional(),
    title: AgentCard.shape.title.optional(),
    fields: AgentCard.shape.fields.optional(),
    summary: AgentCardInput.shape.summary.optional(),
  })
  .refine(
    (p) =>
      p.status !== undefined || p.title !== undefined || p.fields !== undefined || p.summary !== undefined,
    { message: "nothing to update" },
  );
export type AgentCardPatch = z.infer<typeof AgentCardPatch>;

export const AgentCardDecisionRequest = z.object({
  outcome: z.enum(["approved", "denied"]),
  /** Required by the server when the card mirrors an approval: the hash the decider was shown (Phase 07.2). */
  actionHash: ActionHash.optional(),
  note: ApprovalNote.optional(),
});
export type AgentCardDecisionRequest = z.infer<typeof AgentCardDecisionRequest>;

export const AgentCardParams = z.object({ messageId: Id });
export type AgentCardParams = z.infer<typeof AgentCardParams>;
