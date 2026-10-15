import { z } from "zod";
import { AgentCardRoute } from "./agent-card-route";
import {
  ActionHash,
  APPROVAL_NOTE_MAX,
  ApprovalKindId,
  ApprovalNote,
  ApprovalRequestStatus,
} from "./approvals";
import { BrowserEndReason, BrowserHost, BrowserSignInStatus } from "./browser";
import { Id, IsoDateTime, PrincipalKind } from "./common";
import { WorkZoneStartBlock } from "./work-zone-proposals";

// The route primitives live in a leaf module (Phase 07.5: `tool-approvals.ts` needs `AgentCardRoute` and
// `approvals.ts` imports it); re-exported here so every existing import keeps working.
export { AGENT_CARD_ROUTE_PREFIXES, AgentCardRoute, isAgentCardRoute } from "./agent-card-route";
// Phase 07.8 (07.8-30): the browser and live-view contracts are published through this file so that
// `packages/contracts/src/index.ts` stays 07.8-01's alone while both contract plans run in the same wave.
export * from "./browser";

/**
 * Phase 6 Agent Cards (AGENT-04, D-07, P-11): a typed card an agent posts with a message and updates in place.
 * Imports `common`, `approvals`, `agent-card-route`, `work-zone-proposals` and `browser` only: `chat.ts` imports this file for `Message.card`, so importing `chat.ts` here
 * would be a cycle (`approvals` never imports `chat.ts` or this file).
 * Actions are server-decided; an Open action can only point to an internal app route (`AgentCardRoute`).
 */

export const AGENT_CARD_TITLE_MAX = 200;
export const AGENT_CARD_FIELDS_MAX = 12;
export const AGENT_CARD_ACTIONS_MAX = 4;
export const AGENT_CARD_SUMMARY_MAX = 2_000;

export const AgentCardKind = z.enum([
  "work_zone",
  "approval",
  "report",
  "artifact",
  "automation",
  "deployment",
  "pr",
  "generic",
  // Phase 07.8 (UI-SPEC R1): the platform-owned "Sign in needed" card.
  "browser",
]);
export type AgentCardKind = z.infer<typeof AgentCardKind>;

export const AgentCardStatus = z.enum(["info", "pending", "running", "succeeded", "failed", "cancelled"]);
export type AgentCardStatus = z.infer<typeof AgentCardStatus>;

export const AgentCardField = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(500),
});
export type AgentCardField = z.infer<typeof AgentCardField>;

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
  // Phase 07.5 (UI-SPEC R6, R7, R9): all optional, composed by the server, so 07.2 links still parse.
  /** The approval's kind, so the card picks its labels (`tool.call`: Approved / Used / Not used). */
  kind: ApprovalKindId.optional(),
  /**
   * `exact`: the action's values are in the card (a DM whose single human is the requester, or a Work Zone card);
   * `summary`: title, tool and source only, no approve action; `review_only`: values were cut, decide on the review.
   */
  display: z.enum(["exact", "summary", "review_only"]).optional(),
  /** When a pending request expires (the card's timer). */
  expiresAt: IsoDateTime.optional(),
  /** A grant's use window end (`decided_at + 15 min`); "Not used" is derived from `approved` and `useBy < now`. */
  useBy: IsoDateTime.nullable().optional(),
  /** When the grant was consumed at dispatch ("Used"). */
  usedAt: IsoDateTime.nullable().optional(),
  /** The approver label ("Waiting for a lead of Sales"). */
  waitingFor: z.string().max(200).nullable().optional(),
  /** How many of the card's leading fields are the ACTION section (the rest are the values). */
  actionFields: z.number().int().min(0).max(3).optional(),
  /** Work Zone proposals: the device, so the card shows its live state (R9). */
  deviceId: Id.nullable().optional(),
  /** Where the result lives once applied (a started session: `/work-zone/<id>`). */
  resultRoute: AgentCardRoute.nullable().optional(),
  /** Why Start is not possible right now (Work Zone proposals). */
  blocked: WorkZoneStartBlock.nullable().optional(),
});
export type AgentCardApprovalLink = z.infer<typeof AgentCardApprovalLink>;

/**
 * A platform-owned sign-in card's link to its browser context (Phase 07.8, D-08, UI-SPEC R1, Surface 2). Composed by the
 * server from the context; the bot supplied only the reason. Updated in place as the sign-in moves on.
 */
export const AgentCardBrowserSignInLink = z.object({
  contextId: Id,
  host: BrowserHost,
  secure: z.boolean(),
  /** The member who may sign in (the turn's requester). */
  requesterId: Id,
  status: BrowserSignInStatus,
  /** When a waiting card expires (the context is held until then, R9). */
  expiresAt: IsoDateTime,
  /** Until when the sealed session lasts, once signed in. */
  sessionExpiresAt: IsoDateTime.nullable(),
  /** Why a `stopped` card stopped (the live view's ended reasons). */
  stopReason: BrowserEndReason.nullable(),
});
export type AgentCardBrowserSignInLink = z.infer<typeof AgentCardBrowserSignInLink>;

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
  /**
   * Viewer-specific: what the viewer may do on this card. `sign_in` (Phase 07.8): the viewer is the requester of a
   * `browser` card and may open the live view to sign in.
   */
  viewerCan: z.array(z.enum(["follow", "decide", "sign_in"])).optional(),
  /**
   * Phase 07.2 (D-08): composed by the server, never by an agent (an agent PATCH is refused), so a model cannot
   * rewrite findings or reader counts. Absent on older cards.
   */
  platformOwned: z.boolean().optional(),
  /** The approval this card mirrors; deciding the card decides the approval (D-05). */
  approval: AgentCardApprovalLink.nullable().optional(),
  /** Phase 07.8: the sign-in this `browser` card mirrors. Absent on every other card. */
  browserSignIn: AgentCardBrowserSignInLink.nullable().optional(),
});
export type AgentCard = z.infer<typeof AgentCard>;

/**
 * What an agent posts; `summary` becomes the plain-text message body (search and notifications keep working). A
 * `browser` (sign-in) card is platform-owned (Phase 07.8, UI-SPEC R1): never an agent's, so it is not a postable kind.
 */
export const AgentCardInput = AgentCard.pick({
  kind: true,
  title: true,
  fields: true,
  status: true,
  actions: true,
}).extend({
  kind: AgentCardKind.exclude(["browser"]),
  summary: z.string().trim().min(1).max(AGENT_CARD_SUMMARY_MAX),
});
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
