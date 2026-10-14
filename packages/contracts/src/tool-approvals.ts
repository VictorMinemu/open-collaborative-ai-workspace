import { z } from "zod";
import { AgentCardRoute } from "./agent-card-route";
import { Id, IsoDateTime } from "./common";

/**
 * Per-tool approvals (Phase 07.5, D-01, D-02, D-04): an organization decides per tool which bot actions need a person
 * first; the person sees exactly this call and approves it once. Pure logic and schemas shared by the API, the plugin
 * and the web. Imports `common` and the leaf `agent-card-route` only: `approvals.ts` imports this file, never the reverse.
 */

/** Every accepted default of D-04 as one named constant (P-05, P-07, Pitfall 5). */
export const TOOL_APPROVAL_LIMITS = {
  /** Serialized arguments of one call (same bound as 07.4's `AgentChannelConnectorCall`). */
  argumentsBytes: 32_768,
  /** Preview fields a card or view shows; more → `review_only`. */
  previewFields: 12,
  /** Characters of one preview value; a cut value → `review_only`. */
  previewValueChars: 500,
  /** Pending requests per (agent, requester). */
  pendingPerRequester: 5,
  /** A pending request expires after 24 h. */
  pendingTtlMs: 24 * 60 * 60 * 1000,
  /** An approved grant is usable until `decided_at + 15 min`. */
  grantUseMs: 15 * 60 * 1000,
  /** The same action hash denied in this window is refused without a new card. */
  deniedSuppressMs: 24 * 60 * 60 * 1000,
  /** People named by an approver kind `users` rule. */
  approverUsersMax: 20,
  /** Change-history rows per page. */
  historyPage: 30,
} as const;

/** The `tool.call` approval kind (mode `grant`): one later use of exactly the approved call. */
export const TOOL_CALL_KIND = "tool.call";

/** `always` > `when_tainted` (only after outside content in the turn) > `never`. */
export const ToolApprovalMode = z.enum(["never", "always", "when_tainted"]);
export type ToolApprovalMode = z.infer<typeof ToolApprovalMode>;

/** Why the gate refused a call without running it (the plugin turns each into a fixed sentence for the model). */
export const ToolApprovalRefusal = z.enum([
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "arguments_too_large",
  "arguments_invalid",
  "too_many_pending",
  "policy_changed",
]);
export type ToolApprovalRefusal = z.infer<typeof ToolApprovalRefusal>;

// ---------------------------------------------------------------- canonical JSON (RFC 8785, JCS)

const MAX_DEPTH = 32;

export type CanonicalJsonErrorCode =
  | "too_deep"
  | "non_finite"
  | "lone_surrogate"
  | "undefined"
  | "unsupported";

/** The value has no single canonical form: it is refused, never normalised (T-07.5-01-01). */
export class CanonicalJsonError extends Error {
  readonly code: CanonicalJsonErrorCode;
  constructor(code: CanonicalJsonErrorCode) {
    super(`not canonicalizable: ${code}`);
    this.name = "CanonicalJsonError";
    this.code = code;
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stringLiteral(s: string): string {
  // §3.2.2.2: a lone surrogate MUST be an error (JSON.stringify would escape it instead).
  if (!s.isWellFormed()) throw new CanonicalJsonError("lone_surrogate");
  return JSON.stringify(s);
}

/**
 * One walk for both encodings. `indent` null = the canonical form (no whitespace); a string = the same key order with
 * line breaks (never parse-then-stringify, which would put integer-like keys first).
 */
function encode(value: unknown, depth: number, indent: string | null, pad: string): string {
  if (value === undefined) throw new CanonicalJsonError("undefined");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    // §3.2.2.3: NaN and ±Infinity MUST be an error (JSON.stringify would write null). -0 → "0".
    if (!Number.isFinite(value)) throw new CanonicalJsonError("non_finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return stringLiteral(value);
  if (typeof value !== "object") throw new CanonicalJsonError("unsupported");
  if (depth >= MAX_DEPTH) throw new CanonicalJsonError("too_deep");

  const inner = indent === null ? "" : pad + indent;
  const open = indent === null ? "" : `\n${inner}`;
  const sep = indent === null ? "," : `,\n${inner}`;
  const close = indent === null ? "" : `\n${pad}`;

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new CanonicalJsonError("unsupported");
    if (value.length === 0) return "[]";
    const items: string[] = [];
    // Index loop, not map(): a hole reads as undefined and must throw.
    for (let i = 0; i < value.length; i++) items.push(encode(value[i], depth + 1, indent, inner));
    return `[${open}${items.join(sep)}${close}]`;
  }
  if (!isPlainObject(value)) throw new CanonicalJsonError("unsupported");
  // §3.2.3: the default sort compares UTF-16 code units, which is what the RFC requires.
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  const colon = indent === null ? ":" : ": ";
  const members = keys.map((k) => `${stringLiteral(k)}${colon}${encode(value[k], depth + 1, indent, inner)}`);
  return `{${open}${members.join(sep)}${close}}`;
}

/**
 * RFC 8785 JSON Canonicalization Scheme: the one string that names "exactly this call" (D-02). Plain objects, arrays,
 * strings, finite numbers, booleans and null only; nesting deeper than 32 containers is refused.
 * @throws CanonicalJsonError
 */
export function canonicalJson(value: unknown): string {
  return encode(value, 0, null, "");
}

/** The canonical key order with a two-space indent, for people (the review's "All arguments"). */
export function prettyCanonicalJson(value: unknown): string {
  return encode(value, 0, "  ", "");
}

/**
 * Format (Cf) characters (bidi controls, zero-width, BOM, U+061C), the tag block, lone surrogates and control
 * characters other than line feed, carriage return and tab: invisible or misleading in a value a person approves.
 */
const INVISIBLE = /(?![\n\r\t])[\p{Cc}\p{Cf}\p{Cs}؜\u{E0000}-\u{E007F}]/gu;

/** Shows every invisible character as `⟨U+XXXX⟩` (uppercase hex, 4–6 digits) so a person can see it (UI-SPEC Surface 1). */
export function revealInvisible(text: string): string {
  return text.replace(INVISIBLE, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;
  });
}

/** True when `revealInvisible` would change the text. */
export function hasInvisible(text: string): boolean {
  INVISIBLE.lastIndex = 0;
  const found = INVISIBLE.test(text);
  INVISIBLE.lastIndex = 0;
  return found;
}

// ---------------------------------------------------------------- the tool_call approval view

const Person = z.object({ id: Id, displayName: z.string().max(200) });

/** Where the tool comes from: an MCP server, a per-member connector, an approved plugin or a keychain HTTP request. */
export const ApprovalToolSourceKind = z.enum(["mcp", "connector", "plugin", "http"]);
export type ApprovalToolSourceKind = z.infer<typeof ApprovalToolSourceKind>;

/** Where the request was asked (the review's "Asked in"). */
export const ApprovalOriginKind = z.enum(["channel", "thread", "dm", "group", "ai_chat"]);
export type ApprovalOriginKind = z.infer<typeof ApprovalOriginKind>;

export const ApprovalOrigin = z.object({ kind: ApprovalOriginKind, name: z.string().max(200).nullable() });
export type ApprovalOrigin = z.infer<typeof ApprovalOrigin>;

/** One argument as the server orders and labels it (UI-SPEC R7): value revealed, masked, at most 500 characters. */
export const ToolCallPreviewField = z.object({
  key: z.string().min(1).max(128),
  label: z.string().trim().min(1).max(60),
  value: z.string().max(TOOL_APPROVAL_LIMITS.previewValueChars),
});
export type ToolCallPreviewField = z.infer<typeof ToolCallPreviewField>;

/**
 * `GET /api/v1/approvals/:id` view of a `tool.call` request (P-07, P-09, UI-SPEC Surface 2, R7): only the deciders and
 * the requester ever receive it. Every string that came from the model is plain text, revealed and masked by the server.
 */
export const ToolCallApprovalView = z.object({
  type: z.literal("tool_call"),
  title: z.string().trim().min(1).max(200),
  tool: z.string().min(1).max(128),
  source: z.object({
    kind: ApprovalToolSourceKind,
    name: z.string().max(200),
    /** Whose account runs it: the requester's (per-member connector, personal key) or the organization's. */
    account: z.enum(["requester", "org"]).nullable(),
    /** The keychain key name for `http` (never its value). */
    keyName: z.string().max(120).nullable(),
  }),
  /** Host and path the call reaches, when the source has one. */
  target: z.string().max(500).nullable(),
  preview: z.array(ToolCallPreviewField).max(TOOL_APPROVAL_LIMITS.previewFields),
  /** A value was cut or the arguments need more fields than the preview has: decide on `argumentsJson`. */
  truncated: z.boolean(),
  /** `prettyCanonicalJson` of the arguments, revealed and masked. */
  argumentsJson: z.string().max(65_536),
  argumentsBytes: z.number().int().nonnegative().max(TOOL_APPROVAL_LIMITS.argumentsBytes),
  notices: z.object({ hiddenCharacters: z.boolean(), maskedSecret: z.boolean() }),
  /** The request was made after outside content in the turn. */
  tainted: z.boolean(),
  agent: Person,
  requestedFor: Person,
  /** "Waiting for a lead of Sales" / "Waiting for an admin" (server-composed). */
  approverLabel: z.string().max(200),
  /** The rule that applies now (the review's "Why" row); null when none applies any more. */
  policy: z
    .object({
      scopeUnitId: Id.nullable(),
      scopeLabel: z.string().max(120),
      mode: ToolApprovalMode,
      pattern: z.string().min(1).max(128),
      viewerCanManage: z.boolean(),
    })
    .nullable(),
  audience: z.object({
    origin: ApprovalOrigin,
    /** People who read the conversation (they see a summary card at most). */
    conversationReaders: z.number().int().nonnegative(),
    /** People who can open this view (requester + deciders). */
    detailReaders: z.number().int().nonnegative(),
    /** The card's permalink, when the viewer can read the conversation. */
    messageRoute: AgentCardRoute.nullable(),
  }),
  useBy: IsoDateTime.nullable(),
  usedAt: IsoDateTime.nullable(),
});
export type ToolCallApprovalView = z.infer<typeof ToolCallApprovalView>;
