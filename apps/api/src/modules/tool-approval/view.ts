import {
  type ApprovalToolSourceKind,
  canonicalJson,
  detectSensitive,
  hasInvisible,
  maskSample,
  prettyCanonicalJson,
  revealInvisible,
  TOOL_APPROVAL_LIMITS,
  type ToolApproverKind,
  type ToolCallPreviewField,
} from "@ocw/contracts";

/**
 * Display helpers of a `tool.call` approval (07.5-07, UI-SPEC Surface 1 and 2, R7): pure functions, no I/O. Every
 * string here is for people only: masking and revealing never touch what is hashed, stored or run (the hash is always
 * over the raw canonical arguments).
 */

const SAFE_PREFIX = /^m[0-9a-f]{8}__(?=.)/;
const MASK = "••••";

/** The tool's own name: `m1a2b3c4d__create_invoice` → `create_invoice` (the server is shown in Source). */
export function shortToolName(tool: string): string {
  return tool.replace(SAFE_PREFIX, "");
}

/** At most `max` UTF-16 units, ending in "…" when cut, never half a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/** `due_date` / `dueDate` → "Due date"; invisible characters revealed; at most 60 characters. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\s]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "Value";
  return cut(revealInvisible(words.charAt(0).toUpperCase() + words.slice(1)), 60);
}

/** The prefixes a masked secret keeps, so a person still recognises the kind of key. */
const SECRET_PREFIX =
  /^(?:sk-ant-|sk-(?:proj-|svcacct-|admin-)?|gh[pousr]_|github_pat_|glpat-|xox[abposr]-|AIza|AKIA|ASIA|ABIA|ACCA|eyJ|Bearer |Basic )/;

function maskSecret(value: string): string {
  if (value.length < 16) return MASK;
  const prefix = SECRET_PREFIX.exec(value)?.[0] ?? value.slice(0, 4);
  return `${prefix}${MASK} ${value.slice(-4)}`;
}

/** The detector kinds a person never needs in full to decide (they can be checked by their ends). */
const MASKED_KINDS = new Set(["secret", "iban", "payment_card"]);

/**
 * Secret-looking values (07.2 detector layer 1: API keys and tokens, IBANs, card numbers) shown by their ends only:
 * `sk-ant-•••• 9f2c`, `ES91 •••• 1332`, `•••• 1111`. Display only.
 */
export function maskForDisplay(text: string): { text: string; masked: boolean } {
  const spans = detectSensitive(text).spans.filter((s) => MASKED_KINDS.has(s.kind));
  if (spans.length === 0) return { text, masked: false };
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    const value = text.slice(s.start, s.end);
    const shown = s.kind === "secret" ? maskSecret(value) : maskSample(s.kind, value);
    out = `${out.slice(0, s.start)}${shown}${out.slice(s.end)}`;
  }
  return { text: out, masked: true };
}

/** A text as a person sees it: masked, then every invisible character revealed as `⟨U+XXXX⟩`. */
export function displayText(raw: string): { text: string; masked: boolean; hidden: boolean } {
  const masked = maskForDisplay(raw);
  return { text: revealInvisible(masked.text), masked: masked.masked, hidden: hasInvisible(raw) };
}

export interface PreviewResult {
  fields: ToolCallPreviewField[];
  /** A value was cut at 500 characters or the arguments need more than 12 fields. */
  truncated: boolean;
  notices: { hiddenCharacters: boolean; maskedSecret: boolean };
}

/**
 * The order people read an action in (UI-SPEC Surface 1): target, recipient, amount, subject, body, then the rest
 * alphabetically. Within a group, the listed order.
 */
const KEY_GROUPS: readonly (readonly string[])[] = [
  ["target", "url"],
  ["to", "recipient", "recipients", "email", "account"],
  ["amount", "total", "price", "currency"],
  ["subject", "title"],
  ["body", "text", "content", "message", "note"],
];

function keyRank(key: string): [number, number] {
  const k = key.toLowerCase();
  for (let g = 0; g < KEY_GROUPS.length; g++) {
    const i = (KEY_GROUPS[g] as readonly string[]).indexOf(k);
    if (i >= 0) return [g, i];
  }
  return [KEY_GROUPS.length, 0];
}

/** The preview's key order (stable for any input order). */
export function orderKeys(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => {
    const [ga, ia] = keyRank(a);
    const [gb, ib] = keyRank(b);
    return ga - gb || ia - ib || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/** A top-level value as people read it: strings as they are, anything else as one compact canonical JSON value. */
function rawText(value: unknown): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

/** The preview of the arguments: ordered, labelled, masked, revealed and cut at 500 characters (UI-SPEC R7). */
export function orderPreview(args: Record<string, unknown>): PreviewResult {
  const keys = orderKeys(Object.keys(args));
  let truncated = keys.length > TOOL_APPROVAL_LIMITS.previewFields;
  let hiddenCharacters = false;
  let maskedSecret = false;
  const fields = keys.slice(0, TOOL_APPROVAL_LIMITS.previewFields).map((key) => {
    const shown = displayText(rawText(args[key]));
    if (shown.hidden || hasInvisible(key)) hiddenCharacters = true;
    if (shown.masked) maskedSecret = true;
    if (shown.text.length > TOOL_APPROVAL_LIMITS.previewValueChars) truncated = true;
    return {
      key: cut(revealInvisible(key), 128) || "(empty key)",
      label: humanizeKey(key),
      value: cut(shown.text, TOOL_APPROVAL_LIMITS.previewValueChars),
    };
  });
  return { fields, truncated, notices: { hiddenCharacters, maskedSecret } };
}

const ARGUMENTS_JSON_MAX = 65_536;

/**
 * "All arguments" for the review: the pretty canonical JSON, masked and revealed. When that does not fit the view's
 * bound, the compact canonical form; when even that does not, the compact form cut (and `cut` is set).
 */
export function argumentsDisplay(args: unknown): {
  json: string;
  masked: boolean;
  hidden: boolean;
  cut: boolean;
} {
  const pretty = displayText(prettyCanonicalJson(args));
  if (pretty.text.length <= ARGUMENTS_JSON_MAX) return { json: pretty.text, ...flags(pretty), cut: false };
  const compact = displayText(canonicalJson(args));
  if (compact.text.length <= ARGUMENTS_JSON_MAX) return { json: compact.text, ...flags(compact), cut: false };
  return { json: cut(compact.text, ARGUMENTS_JSON_MAX), ...flags(compact), cut: true };
}

const flags = (d: { masked: boolean; hidden: boolean }) => ({ masked: d.masked, hidden: d.hidden });

const METHOD = /^[A-Za-z]{1,10}$/;

/** The card and review title (UI-SPEC Copywriting › Action card), at most 200 characters. */
export function toolCallTitle(p: {
  tool: string;
  sourceKind: ApprovalToolSourceKind;
  sourceName: string;
  method?: string | null;
  host?: string | null;
}): string {
  const tool = revealInvisible(shortToolName(p.tool));
  switch (p.sourceKind) {
    case "mcp":
    case "connector":
      return cut(`Run ${tool} on ${revealInvisible(p.sourceName)}`, 200);
    case "http": {
      const method = p.method && METHOD.test(p.method) ? p.method.toUpperCase() : null;
      const host = p.host ? revealInvisible(p.host) : null;
      if (method && host) return cut(`Send ${method} to ${host}`, 200);
      if (host) return cut(`Send a request to ${host}`, 200);
      return method ? `Send a ${method} request` : "Send a web request";
    }
    default:
      return cut(`Run ${tool}`, 200);
  }
}

/** The summary card title every reader of the conversation sees: who wants what, for whom, and no value. */
export function summaryTitle(p: { botName: string; tool: string; requesterName: string }): string {
  return cut(`${p.botName} wants to run ${shortToolName(p.tool)} for ${p.requesterName}`, 200);
}

/** The label a rule's `users` list gets when none of its people is a member any more. */
export const NO_APPROVER = "No one can approve this: the people named are gone";

/** "Waiting for …" (UI-SPEC Surface 1 approver label), at most 200 characters. */
export function approverText(p: {
  approverKind: ToolApproverKind | null;
  requesterName: string;
  /** `users`: the names of the people named who are still members. */
  names: readonly string[];
  /** `unit_leads`: the rule's unit. */
  unitName: string | null;
}): string {
  switch (p.approverKind) {
    case null:
    case "requester":
      return cut(`Waiting for ${p.requesterName} to approve`, 200);
    case "admins":
      return "Waiting for an admin";
    case "unit_leads":
      return cut(`Waiting for a lead of ${p.unitName ?? "the unit"}`, 200);
    case "users": {
      const [a, b] = p.names;
      if (a === undefined) return NO_APPROVER;
      if (b === undefined) return cut(`Waiting for ${a}`, 200);
      if (p.names.length === 2) return cut(`Waiting for ${a} or ${b}`, 200);
      return cut(`Waiting for ${a} or ${p.names.length - 1} others`, 200);
    }
  }
}
