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
  /** Phase 07.8 (D-12, R8): a browser-action approval expires with the held page after 15 min. */
  browserPendingTtlMs: 15 * 60 * 1000,
} as const;

/** The `tool.call` approval kind (mode `grant`): one later use of exactly the approved call. */
export const TOOL_CALL_KIND = "tool.call";

/** `always` > `when_tainted` (only after outside content in the turn) > `never`. */
export const ToolApprovalMode = z.enum(["never", "always", "when_tainted"]);
export type ToolApprovalMode = z.infer<typeof ToolApprovalMode>;

/** Who decides: the asker, named people, the leads of the rule's unit, or anyone holding the org `admin` role (R3). */
export const ToolApproverKind = z.enum(["requester", "users", "unit_leads", "admins"]);
export type ToolApproverKind = z.infer<typeof ToolApproverKind>;

const MODE_RANK: Readonly<Record<ToolApprovalMode, number>> = { never: 0, when_tainted: 1, always: 2 };

/** The strictest of the applicable modes (principle 6: restrictions accumulate); no rule → `never`. */
export function strictestMode(modes: readonly ToolApprovalMode[]): ToolApprovalMode {
  let best: ToolApprovalMode = "never";
  for (const m of modes) if (MODE_RANK[m] > MODE_RANK[best]) best = m;
  return best;
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Every tool of one MCP server or per-member connector (`<safe>__*`, safe name `m` + 8 hex). */
const SERVER_PATTERN = /^m[0-9a-f]{8}__\*$/;
const WEB_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);
/** The one built-in whose calls a person may approve: a keychain HTTP request. */
const APPROVABLE_BUILTIN = "ocw_http_request";
/**
 * Phase 07.8 (SBX-04, D-12): the confined sandbox and browser tools, by name pattern (no import of 07.8-01's tool
 * tuples). Sign-in and close are never approvable: one asks a person already, the other only ends the page.
 */
const CONFINED_TOOL = /^ocw_(sandbox|browser)_[a-z0-9_]+$/;
const NEVER_APPROVABLE_CONFINED: ReadonlySet<string> = new Set(["ocw_browser_signin", "ocw_browser_close"]);

/**
 * True for a tool a policy may name (P-04): MCP and per-member connector tools (`<safe>__<tool>`), approved plugin
 * tools, `ocw_http_request` and the confined `ocw_sandbox_*` / `ocw_browser_*` tools except sign-in and close
 * (Phase 07.8). The web tools and every other `ocw_` built-in are never approvable (they have their own gates, or a
 * flow of their own like `ocw_start_work_zone`). Case-insensitive on the `ocw_` prefix, so a look-alike never slips in.
 */
export function isApprovableTool(name: string): boolean {
  if (!TOOL_NAME.test(name)) return false;
  const lower = name.toLowerCase();
  if (WEB_TOOLS.has(lower)) return false;
  if (lower.startsWith("ocw_")) {
    return name === APPROVABLE_BUILTIN || (CONFINED_TOOL.test(name) && !NEVER_APPROVABLE_CONFINED.has(name));
  }
  return true;
}

/** An approvable exact tool name, or `<safe>__*` for every tool of one server. */
export const ToolPattern = z
  .string()
  .max(128)
  .refine((p) => SERVER_PATTERN.test(p) || isApprovableTool(p), {
    message: "must be an approvable tool name or <server>__*",
  });
export type ToolPattern = z.infer<typeof ToolPattern>;

/** Whether `pattern` covers `tool` (a server pattern covers `<safe>__<anything non-empty>`). */
export function matchesToolPattern(pattern: string, tool: string): boolean {
  if (SERVER_PATTERN.test(pattern)) {
    const prefix = pattern.slice(0, -1);
    return tool.length > prefix.length && tool.startsWith(prefix);
  }
  return pattern === tool;
}

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

/**
 * Where the tool comes from: an MCP server, a per-member connector, an approved plugin or a keychain HTTP request; 07.8
 * (additive): the bot's own sandbox (`ocw_sandbox_*`) or browser (`ocw_browser_*`).
 */
export const ApprovalToolSourceKind = z.enum(["mcp", "connector", "plugin", "http", "sandbox", "browser"]);
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
 * Phase 07.8 (UI-SPEC R8, Surface 6, D-13): what a browser action approval shows: the Action, Element, Page and
 * Session fields. `open` is D-13's navigation to a host other than the loaded session's site (`sessionSite`). Every
 * string is page text or model output, revealed and masked by the server; hosts only, never a page address.
 */
/** A host as `URL.host` reports it (same rule as `BrowserHost`; this file imports no browser contract). */
const ApprovalHost = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[a-z0-9.\-[\]:]+$/);

export const ToolCallBrowserAction = z.strictObject({
  action: z.enum(["click", "type", "select", "press", "scroll", "open"]),
  element: z.strictObject({ role: z.string().max(60), name: z.string().max(200) }).nullable(),
  host: ApprovalHost,
  secure: z.boolean(),
  /** A member's sealed session is loaded for the page ("Signed in as you"). */
  signedIn: z.boolean(),
  /** The loaded session's site, when one is loaded (D-13 compares it with `host`). */
  sessionSite: ApprovalHost.nullable(),
  /** What the bot will type (type actions only). */
  value: z.string().max(TOOL_APPROVAL_LIMITS.previewValueChars).nullable(),
  /** The option it will choose (select actions only). */
  option: z.string().max(200).nullable(),
});
export type ToolCallBrowserAction = z.infer<typeof ToolCallBrowserAction>;

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
      pattern: ToolPattern,
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
  /** Phase 07.8: the browser action being approved; absent on every other tool's view. */
  browser: ToolCallBrowserAction.nullable().optional(),
});
export type ToolCallApprovalView = z.infer<typeof ToolCallApprovalView>;

// ---------------------------------------------------------------- policies (APPROVE-01, P-04, UI-SPEC Surface 4)

const Actor = z.object({ id: Id, displayName: z.string().max(200) });
const ApproverUserIds = z.array(Id).max(TOOL_APPROVAL_LIMITS.approverUsersMax);

/** One rule: organization-wide (`scopeUnitId` null) or on a unit subtree. */
export const ToolApprovalPolicy = z.object({
  id: Id,
  scopeUnitId: Id.nullable(),
  toolPattern: ToolPattern,
  mode: ToolApprovalMode,
  approverKind: ToolApproverKind,
  approverUserIds: ApproverUserIds,
  version: z.number().int().positive(),
  updatedAt: IsoDateTime,
  updatedBy: Actor.nullable(),
});
export type ToolApprovalPolicy = z.infer<typeof ToolApprovalPolicy>;

type ApproverShape = {
  scopeUnitId?: string | null;
  mode?: ToolApprovalMode;
  approverKind?: ToolApproverKind;
  approverUserIds?: readonly string[];
};

/**
 * The approver rules, on the fields present (an update is re-checked by the API against the stored rule):
 * `users` ⇒ 1..20 distinct people; any other kind ⇒ no people; `unit_leads` ⇒ a unit scope (when the scope is known);
 * `never` ⇒ approver kind `requester` (nobody is asked).
 */
function approverIssues(v: ApproverShape, ctx: z.RefinementCtx): void {
  const ids = v.approverUserIds ?? [];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["approverUserIds"], message: "each person once" });
  }
  if (v.approverKind === "users" && ids.length === 0) {
    ctx.addIssue({ code: "custom", path: ["approverUserIds"], message: "name at least one person" });
  }
  if (v.approverKind !== undefined && v.approverKind !== "users" && ids.length > 0) {
    ctx.addIssue({ code: "custom", path: ["approverUserIds"], message: "only for approver kind users" });
  }
  if (v.approverKind === "unit_leads" && v.scopeUnitId === null) {
    ctx.addIssue({ code: "custom", path: ["approverKind"], message: "unit leads need a unit rule" });
  }
  if (v.mode === "never" && v.approverKind !== undefined && v.approverKind !== "requester") {
    ctx.addIssue({ code: "custom", path: ["approverKind"], message: "a never rule asks nobody" });
  }
}

/** `POST /api/v1/tool-approval-policies`. */
export const CreateToolApprovalPolicyRequest = z
  .strictObject({
    scopeUnitId: Id.nullable(),
    toolPattern: ToolPattern,
    mode: ToolApprovalMode,
    approverKind: ToolApproverKind,
    approverUserIds: ApproverUserIds.optional(),
  })
  .superRefine(approverIssues);
export type CreateToolApprovalPolicyRequest = z.infer<typeof CreateToolApprovalPolicyRequest>;

/** `PATCH /api/v1/tool-approval-policies/:id`: the version seen and at least one change (409 on a stale version). */
export const UpdateToolApprovalPolicyRequest = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    mode: ToolApprovalMode.optional(),
    approverKind: ToolApproverKind.optional(),
    approverUserIds: ApproverUserIds.optional(),
  })
  .refine((v) => v.mode !== undefined || v.approverKind !== undefined || v.approverUserIds !== undefined, {
    message: "nothing to update",
  })
  .superRefine(approverIssues);
export type UpdateToolApprovalPolicyRequest = z.infer<typeof UpdateToolApprovalPolicyRequest>;

/** `?scope=org` or `?scope=<unitId>`. */
export const ToolApprovalScope = z.union([z.literal("org"), Id]);
export type ToolApprovalScope = z.infer<typeof ToolApprovalScope>;

export const ToolApprovalScopeQuery = z.object({ scope: ToolApprovalScope });
export type ToolApprovalScopeQuery = z.infer<typeof ToolApprovalScopeQuery>;

/** `DELETE /api/v1/tool-approval-policies/:id?expectedVersion=`. */
export const DeleteToolApprovalPolicyQuery = z.object({
  expectedVersion: z.coerce.number().int().positive(),
});
export type DeleteToolApprovalPolicyQuery = z.infer<typeof DeleteToolApprovalPolicyQuery>;

/** `GET /api/v1/tool-approval-policies/access`: where the caller may manage rules (R4). */
export const ToolApprovalAccess = z.object({
  manageable: z.object({ organization: z.boolean(), unitIds: z.array(Id).max(500) }),
});
export type ToolApprovalAccess = z.infer<typeof ToolApprovalAccess>;

export const ApprovableTool = z.object({ name: z.string().min(1).max(128), sideEffecting: z.boolean() });
export type ApprovableTool = z.infer<typeof ApprovableTool>;

/** The tools a rule can name, grouped by where they come from (the rule dialog's catalog). */
export const ApprovableGroup = z.object({
  source: z.object({
    kind: ApprovalToolSourceKind,
    id: Id.nullable(),
    name: z.string().max(200),
    /** `m` + 8 hex for MCP servers and connectors (the `<safe>__*` pattern); null otherwise. */
    safeName: z
      .string()
      .regex(/^m[0-9a-f]{8}$/)
      .nullable(),
  }),
  tools: z.array(ApprovableTool).max(200),
});
export type ApprovableGroup = z.infer<typeof ApprovableGroup>;

/** `GET /api/v1/tool-approval-policies?scope=`: the scope's rules, the stricter ones above it and the catalog. */
export const ToolApprovalPolicyPage = z.object({
  scope: z.object({ unitId: Id.nullable(), label: z.string().max(120) }),
  policies: z.array(ToolApprovalPolicy).max(500),
  inherited: z.array(ToolApprovalPolicy.extend({ scopeLabel: z.string().max(120) })).max(500),
  catalog: z.array(ApprovableGroup).max(100),
  /** Policy id → approver label ("Leads of Sales", "Marta Gil or 2 others"). */
  approverLabels: z.record(Id, z.string().max(200)),
});
export type ToolApprovalPolicyPage = z.infer<typeof ToolApprovalPolicyPage>;

/** One change from the `tool_approval_policy.*` audit rows (R5); never tool arguments. */
export const ToolApprovalHistoryItem = z.object({
  id: Id,
  at: IsoDateTime,
  actor: Actor.nullable(),
  action: z.enum(["created", "updated", "deleted"]),
  toolPattern: z.string().max(128),
  mode: ToolApprovalMode.nullable(),
  approverLabel: z.string().max(200).nullable(),
});
export type ToolApprovalHistoryItem = z.infer<typeof ToolApprovalHistoryItem>;

export const ToolApprovalHistory = z.object({
  items: z.array(ToolApprovalHistoryItem).max(TOOL_APPROVAL_LIMITS.historyPage),
  nextCursor: z.string().max(200).nullable(),
});
export type ToolApprovalHistory = z.infer<typeof ToolApprovalHistory>;

/** `GET /api/v1/tool-approval-policies/history?scope=&cursor=`. */
export const ToolApprovalHistoryQuery = z.object({
  scope: ToolApprovalScope,
  cursor: z.string().max(200).optional(),
});
export type ToolApprovalHistoryQuery = z.infer<typeof ToolApprovalHistoryQuery>;

/** Policy route errors: 400 `tool_not_approvable` / `invalid_tool_pattern`; 409 for the other three. */
export const ToolApprovalErrorCode = z.enum([
  "tool_not_approvable",
  "invalid_tool_pattern",
  "policy_exists",
  "policy_version_conflict",
  "policy_weaker_than_inherited",
]);
export type ToolApprovalErrorCode = z.infer<typeof ToolApprovalErrorCode>;
