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
  type ToolCallBrowserAction,
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
    case "sandbox":
      return cut(`Run ${tool} in the sandbox`, 200);
    case "browser":
      return cut(`Run ${tool} in the browser`, 200);
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

// ---------------------------------------------------------------- 07.8-14: browser actions (UI-SPEC Surface 6, R8, D-13)

const BROWSER_TOOLS: ReadonlySet<string> = new Set(["ocw_browser_open", "ocw_browser_act"]);

/** The browser tools whose approval shows the R8 view (Action, Element, Page, Session). */
export function isBrowserActionTool(tool: string): boolean {
  return BROWSER_TOOLS.has(tool);
}

const ACTION_LABEL: Record<ToolCallBrowserAction["action"], string> = {
  click: "Click",
  type: "Type",
  select: "Choose",
  press: "Press",
  scroll: "Scroll",
  open: "Open",
};

const HOST_RE = /^[a-z0-9.\-[\]:]{1,260}$/;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const hostText = (v: unknown): string | null => {
  const h = str(v)?.toLowerCase() ?? null;
  return h && HOST_RE.test(h) ? h : null;
};
/** Page text or model output as a person sees it: masked, invisible characters revealed, one line, cut. */
const plain = (v: string, max: number): string => cut(displayText(v.replace(/\s+/g, " ").trim()).text, max);

export interface BrowserActionDisplay {
  title: string;
  browser: ToolCallBrowserAction;
  /** The card and review fields in order: Action, Element, Page, Session, then Value or Option. */
  fields: { label: string; value: string }[];
}

/**
 * The browser action a person approves, from the stored canonical arguments only (`contextId`, `action`, `ref`, the
 * element's role and name captured when the bot asked, `host`, `value`, `option`, `key`, the session flag and site, and
 * for D-13 the host the bot would reach, `navigateTo` or an `open`'s own host). Pure; every string masked and revealed.
 * `summary`: the card every reader of a shared conversation sees, which names the requester instead of "you" and never
 * shows a value.
 */
export function browserActionView(
  args: Record<string, unknown>,
  opts: { requesterName?: string; summary?: boolean } = {},
): BrowserActionDisplay {
  const navigateTo = hostText(args.navigateTo);
  const rawAction = str(args.action);
  const action: ToolCallBrowserAction["action"] =
    navigateTo || rawAction === "open"
      ? "open"
      : rawAction && rawAction in ACTION_LABEL
        ? (rawAction as ToolCallBrowserAction["action"])
        : "click";
  const host = navigateTo ?? hostText(args.host) ?? "unknown";
  const sessionSite = hostText(args.sessionSite);
  const signedIn = args.signedIn === true || (action === "open" && sessionSite !== null);
  const el =
    args.element && typeof args.element === "object" && !Array.isArray(args.element)
      ? (args.element as Record<string, unknown>)
      : null;
  const element =
    el && (str(el.role) || str(el.name))
      ? { role: plain(str(el.role) ?? "element", 60), name: plain(str(el.name) ?? "", 200) }
      : null;
  const value =
    !opts.summary && action === "type" && str(args.value) !== null ? plain(String(args.value), 500) : null;
  const option =
    !opts.summary && action === "select" && str(args.option) ? plain(String(args.option), 200) : null;
  const key = str(args.key) ? plain(String(args.key), 32) : null;
  const named = element?.name ? `“${element.name}”` : null;

  let title: string;
  switch (action) {
    case "open":
      title = `Open ${host}`;
      break;
    case "type":
      title = named ? `Type into ${named} on ${host}` : `Type on ${host}`;
      break;
    case "select":
      title =
        option && named
          ? `Choose “${option}” in ${named} on ${host}`
          : named
            ? `Choose in ${named} on ${host}`
            : `Choose on ${host}`;
      break;
    case "press":
      title = key ? `Press ${key} on ${host}` : `Press a key on ${host}`;
      break;
    case "scroll":
      title = `Scroll on ${host}`;
      break;
    default:
      title = named ? `Click ${named} on ${host}` : `Click on ${host}`;
  }

  const who = opts.summary ? (opts.requesterName ?? "the person who asked") : "you";
  const session = !signedIn
    ? "Not signed in"
    : action === "open" && sessionSite && sessionSite !== host
      ? `Signed in as ${who} on ${sessionSite}`
      : `Signed in as ${who}`;
  const fields: { label: string; value: string }[] = [{ label: "Action", value: ACTION_LABEL[action] }];
  if (element && !opts.summary)
    fields.push({ label: "Element", value: `${element.role} ${named ?? ""}`.trim() });
  fields.push({ label: "Page", value: host });
  fields.push({ label: "Session", value: session });
  if (value !== null) fields.push({ label: "Value", value: value || "(empty)" });
  if (option !== null) fields.push({ label: "Option", value: option });

  return {
    title: cut(title, 200),
    browser: {
      action,
      element: opts.summary ? null : element,
      host,
      secure: args.secure !== false,
      signedIn,
      sessionSite,
      value,
      option,
    },
    fields,
  };
}

/** "{bot} wants to click on {host} for {requester}" (UI-SPEC Surface 6 summary card): no element, no value. */
export function browserSummaryTitle(p: {
  botName: string;
  requesterName: string;
  args: Record<string, unknown>;
}): string {
  const v = browserActionView(p.args, { summary: true, requesterName: p.requesterName });
  if (v.browser.action === "open") {
    return cut(`${p.botName} wants to open ${v.browser.host} for ${p.requesterName}`, 200);
  }
  const verb = v.browser.action === "select" ? "choose" : v.browser.action;
  return cut(`${p.botName} wants to ${verb} on ${v.browser.host} for ${p.requesterName}`, 200);
}
