import {
  AGENT_CARD_FIELDS_MAX,
  AGENT_CARD_NOTICE_MAX,
  AGENT_CARD_SUMMARY_MAX,
  AGENT_CARD_TITLE_MAX,
  AgentCardInput,
  canonicalJson,
  JsonPointer,
  type PreviewWatchedRecordResponse,
  WATCHED_LIMITS,
  type WatchedCheckSource,
  type WatchedField,
} from "@ocw/contracts";

/**
 * The server-composed cards and texts of watched records (07.6-UI-SPEC Surface 8c, R9). Every value is plain text the
 * API composes from the record it read; the model never supplies a value. The change card is posted by the watch's bot
 * in the card's thread when a record changed elsewhere; the conflict card (07.6-14) when a bot's compare-and-set update
 * was refused because the record had changed.
 */

/** Rows of changed fields shown on a card; more → one `More` row. With `Detected` the card stays ≤ 12 fields. */
export const CHANGE_ROWS_MAX = WATCHED_LIMITS.cardFieldsMax;
const VALUE_MAX = WATCHED_LIMITS.valueChars;
const ARROW = " → ";
const EMPTY = "(empty)";

const SOURCE_WORDS: Readonly<Record<WatchedCheckSource, string>> = {
  schedule: "on schedule",
  access: "when the thread was opened",
  write: "before an update",
  manual: "when someone checked",
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** At most `max` UTF-16 units, cut with "…" and never inside a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** A value as one line of plain text: `(empty)` for null, missing or blank; JSON for objects and arrays. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "";
    }
  }
  const clean = text.replace(CONTROL, "").trim();
  return clean === "" ? EMPTY : clean;
}

/** `{before} → {after}` within the card's 500 characters; a long side is cut, the short side kept whole. */
export function beforeAfter(before: unknown, after: unknown): string {
  const b = displayValue(before);
  const a = displayValue(after);
  const budget = VALUE_MAX - ARROW.length;
  if (b.length + a.length <= budget) return `${b}${ARROW}${a}`;
  let bMax = Math.floor(budget / 2);
  let aMax = budget - bMax;
  if (b.length < bMax) aMax = budget - b.length;
  else if (a.length < aMax) bMax = budget - a.length;
  return `${cut(b, bMax)}${ARROW}${cut(a, aMax)}`;
}

/** Whether two projected values differ (canonical JSON, so key order never counts as a change). */
function differs(x: unknown, y: unknown): boolean {
  try {
    return canonicalJson(x ?? null) !== canonicalJson(y ?? null);
  } catch {
    return true;
  }
}

/** The watched fields whose value changed between two snapshots (pointer → value), in the watch's order. */
export function changedFields(
  fields: readonly WatchedField[],
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): WatchedField[] {
  return fields.filter((f) => differs(before[f.pointer], after[f.pointer]));
}

/** "Oct 8, 9:20 AM UTC" in `timeZone` (the card is the same for every reader, so the zone is named). */
export function detectedAt(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(at);
  } catch {
    return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

export interface ChangeCardInput {
  /** The external record id (`external_ref`). */
  recordId: string;
  connectorName: string;
  /** The watched fields; only the changed ones become rows. */
  fields: readonly WatchedField[];
  before: Readonly<Record<string, unknown>>;
  after: Readonly<Record<string, unknown>>;
  source: WatchedCheckSource;
  detectedAt: Date;
  timeZone: string;
  /** The board channel and the card (thread root) the Open action leads to. */
  conversationId: string;
  cardMessageId: string;
}

export type WatchedCardInput = AgentCardInput & {
  statusLabel: string;
  notices: NonNullable<AgentCardInput["notices"]>;
};

/** One row per changed field (≤ 10), `More` beyond, `Detected` last: ≤ 12 fields in total. */
function changeRows(p: ChangeCardInput, changed: readonly WatchedField[]) {
  const rows = changed.slice(0, CHANGE_ROWS_MAX).map((f) => ({
    label: cut(f.label, 60),
    value: beforeAfter(p.before[f.pointer], p.after[f.pointer]),
  }));
  if (changed.length > CHANGE_ROWS_MAX) {
    const more = changed.length - CHANGE_ROWS_MAX;
    rows.push({ label: "More", value: `${more} more field${more === 1 ? "" : "s"} changed` });
  }
  rows.push({
    label: "Detected",
    value: `${detectedAt(p.detectedAt, p.timeZone)} · ${SOURCE_WORDS[p.source]}`,
  });
  return rows.slice(0, AGENT_CARD_FIELDS_MAX);
}

const openCard = (p: ChangeCardInput) => ({
  kind: "open" as const,
  label: "Open card",
  target: `/chat/${p.conversationId}?thread=${p.cardMessageId}`,
});

/** UI-SPEC 8c "Changed elsewhere": a `report` card, info tone, pill `Changed`. */
export function changeCard(p: ChangeCardInput): WatchedCardInput {
  const changed = changedFields(p.fields, p.before, p.after);
  const title = `${p.recordId} changed in ${p.connectorName}`;
  const labels = changed.map((f) => f.label).join(", ");
  const card = AgentCardInput.parse({
    kind: "report",
    status: "info",
    statusLabel: "Changed",
    notices: [],
    title: cut(title, AGENT_CARD_TITLE_MAX),
    fields: changeRows(p, changed),
    actions: [openCard(p)],
    summary: cut(`${title}: ${labels}.`, AGENT_CARD_SUMMARY_MAX),
  });
  return { ...card, statusLabel: "Changed", notices: card.notices ?? [] };
}

/**
 * UI-SPEC 8c "Not saved": a bot's compare-and-set update was refused because the record changed since the last check
 * (07.6-14). Nothing was written; the card shows what changed.
 */
export function conflictCard(p: ChangeCardInput & { botName: string }): WatchedCardInput {
  const changed = changedFields(p.fields, p.before, p.after);
  const notices = [
    {
      tone: "neutral" as const,
      text: cut(
        `Someone changed it in ${p.connectorName} after the last check. Nothing was overwritten.`,
        AGENT_CARD_NOTICE_MAX,
      ),
    },
    {
      tone: "neutral" as const,
      text: cut(`Ask ${p.botName} again with the new values.`, AGENT_CARD_NOTICE_MAX),
    },
  ];
  const card = AgentCardInput.parse({
    kind: "report",
    status: "failed",
    statusLabel: "Not saved",
    notices,
    title: cut(
      `${p.recordId} changed in ${p.connectorName}, so ${p.botName}'s update wasn't saved`,
      AGENT_CARD_TITLE_MAX,
    ),
    fields: changeRows(p, changed),
    actions: [openCard(p)],
    summary: cut(
      `${p.botName}'s update to ${p.recordId} wasn't saved because it changed in ${p.connectorName}.`,
      AGENT_CARD_SUMMARY_MAX,
    ),
  });
  return { ...card, statusLabel: "Not saved", notices: card.notices ?? notices };
}

/** "Reconnect to keep watching" (07.4 connect-card pattern): only the linker sees it, in their DM with the bot. */
export function reconnectCard(p: {
  recordId: string;
  connectorName: string;
  serverId: string;
}): WatchedCardInput {
  const card = AgentCardInput.parse({
    kind: "generic",
    status: "info",
    statusLabel: "Paused",
    notices: [],
    title: cut(`Reconnect ${p.connectorName} to keep watching ${p.recordId}`, AGENT_CARD_TITLE_MAX),
    fields: [
      {
        label: "What happened",
        value:
          `Your ${p.connectorName} sign-in stopped working, so checks of ${p.recordId} are paused. Reconnect and they resume.`.slice(
            0,
            VALUE_MAX,
          ),
      },
    ],
    actions: [
      {
        kind: "open",
        label: "Reconnect",
        target: `/settings/connections?connector=${encodeURIComponent(p.serverId)}`,
      },
    ],
    summary: cut(
      `Checks of ${p.recordId} are paused until you reconnect ${p.connectorName}.`,
      AGENT_CARD_SUMMARY_MAX,
    ),
  });
  return { ...card, statusLabel: "Paused", notices: card.notices ?? [] };
}

// ---------------------------------------------------------------- preview (R9)

const LABEL_KEYS = ["title", "name", "label", "display_name", "displayName"];

const pointerOf = (key: string) => `/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`;

/** "delivery_date" → "Delivery date", "customerName" → "Customer name". */
export function suggestedLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_\-.\s]+/gu, " ")
    .replace(CONTROL, "")
    .trim()
    .toLowerCase();
  const label = words === "" ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  return cut(label || "Field", 60);
}

/**
 * The link dialog's preview of a record read once (R9): every top-level field with its display value and a suggested
 * label, and `numberHints` for values typed as JSON numbers (Pitfall 9: decimals and big integers lose precision, so the
 * dialog suggests text fields for money). Nothing is stored.
 */
export function previewOf(record: unknown): PreviewWatchedRecordResponse {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { label: null, values: [], numberHints: [] };
  }
  const obj = record as Record<string, unknown>;
  const values: PreviewWatchedRecordResponse["values"] = [];
  const numberHints: string[] = [];
  for (const key of Object.keys(obj)) {
    if (values.length >= 200) break;
    const pointer = pointerOf(key);
    if (!JsonPointer.safeParse(pointer).success) continue;
    const value = obj[key];
    values.push({
      pointer,
      value: value === null || value === undefined ? null : cut(displayValue(value), VALUE_MAX),
      suggestedLabel: suggestedLabel(key),
    });
    if (typeof value === "number") numberHints.push(pointer);
  }
  let label: string | null = null;
  for (const k of LABEL_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") {
      label = cut(displayValue(v), 200);
      break;
    }
  }
  return { label, values, numberHints };
}
