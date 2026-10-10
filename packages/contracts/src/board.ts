import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { TitleSource } from "./session-title";

/**
 * Phase 07.1 board channels (BOARD-01 … BOARD-06, D-01 … D-08). A board is a channel (`layout: "board"`) whose
 * cards are the root messages of ordinary threads; `board_cards` adds column, rank, waiting state, title, fields and
 * version. A card's message body is its plain-text projection (`cardMessageBody`) so chat search finds cards unchanged.
 * Titles are deterministic (`renderCardTitle`), never model-generated (D-08).
 * Imports `common` and `session-title` only: `chat.ts` imports this file, so importing `chat.ts` here would be a cycle.
 */

export const BOARD_MAX_COLUMNS = 20;
export const BOARD_MAX_FIELDS = 20;
export const BOARD_CARD_TITLE_MAX = 200;
export const BOARD_COLUMN_NAME_MAX = 60;
/** Cards per column in the snapshot and per page of `GET …/columns/:columnId/cards` (P-11). */
export const BOARD_COLUMN_PAGE = 100;
/** The `{summary}` token: the description's first non-empty line, at most this many characters. */
export const BOARD_SUMMARY_MAX = 80;
export const BOARD_NAMING_RULE_MAX = 120;
export const BOARD_FIELD_LABEL_MAX = 60;
export const BOARD_FIELD_TEXT_MAX = 500;
export const BOARD_FIELD_OPTIONS_MAX = 50;
export const BOARD_FIELD_OPTION_MAX = 60;
/**
 * The chat message body limit (`MessageBody`, `PostMessageRequest.body` in chat.ts; equality is tested): a card body
 * always fits it, so a card can always be posted.
 */
export const BOARD_CARD_BODY_MAX = 20_000;
/**
 * Leaves room in the body for the title and every field line: 200 + 8,000 + 20 × (60 + 2 + 500) + separators < 20,000.
 */
export const BOARD_CARD_DESCRIPTION_MAX = 8_000;
/** Fractional rank keys (`fractional-indexing`, ordered with `COLLATE "C"`). */
export const BOARD_RANK_MAX = 128;
/** Ranks in one `board.column_reranked` event (one event per re-rank of one column, P-06). */
export const BOARD_RERANK_MAX = 10_000;

export const BOARD_PREFIX_RE = /^[A-Z0-9]{1,8}$/;
export const BOARD_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** `text` = today's message channel; `board` = the same channel shown as columns of cards (D-01). */
export const ChannelLayout = z.enum(["text", "board"]);
export type ChannelLayout = z.infer<typeof ChannelLayout>;

export const BoardColumnCategory = z.enum(["backlog", "started", "done", "cancelled"]);
export type BoardColumnCategory = z.infer<typeof BoardColumnCategory>;

/** Who the card waits on. `none` shows no chip. */
export const WaitingOn = z.enum(["none", "us", "customer", "both"]);
export type WaitingOn = z.infer<typeof WaitingOn>;

export const BoardFieldType = z.enum(["text", "number", "date", "select"]);
export type BoardFieldType = z.infer<typeof BoardFieldType>;

export const BoardPrefix = z.string().regex(BOARD_PREFIX_RE, "1 to 8 capital letters or digits");
export const BoardFieldKey = z.string().regex(BOARD_FIELD_KEY_RE, "lowercase letters, digits and _");
export const BoardRank = z.string().min(1).max(BOARD_RANK_MAX);
export const BoardColumnName = z.string().trim().min(1).max(BOARD_COLUMN_NAME_MAX);
export const BoardCardTitle = z.string().trim().min(1).max(BOARD_CARD_TITLE_MAX);

export const BoardFieldDef = z
  .object({
    key: BoardFieldKey,
    label: z.string().trim().min(1).max(BOARD_FIELD_LABEL_MAX),
    type: BoardFieldType,
    required: z.boolean().default(false),
    /** Select fields only. */
    options: z
      .array(z.string().trim().min(1).max(BOARD_FIELD_OPTION_MAX))
      .min(1)
      .max(BOARD_FIELD_OPTIONS_MAX)
      .optional(),
  })
  .superRefine((def, ctx) => {
    if (def.type === "select" && !def.options) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "A select field needs options" });
    }
    if (def.type !== "select" && def.options) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Only select fields have options" });
    }
    if (def.options && new Set(def.options).size !== def.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
    }
  });
export type BoardFieldDef = z.infer<typeof BoardFieldDef>;

/** At most 20 field definitions with unique keys. */
export const BoardFieldDefs = z
  .array(BoardFieldDef)
  .max(BOARD_MAX_FIELDS)
  .superRefine((defs, ctx) => {
    const seen = new Set<string>();
    defs.forEach((d, i) => {
      if (seen.has(d.key))
        ctx.addIssue({ code: "custom", path: [i, "key"], message: `Duplicate field "${d.key}"` });
      seen.add(d.key);
    });
  });

/** A column a template (or the default set) creates. `defaultWaitingOn: null` = "Keep as is" when a card enters. */
export const TemplateColumn = z.object({
  name: BoardColumnName,
  category: BoardColumnCategory,
  defaultWaitingOn: WaitingOn.nullable().default(null),
});
export type TemplateColumn = z.infer<typeof TemplateColumn>;

/** The columns of a board created without a template. */
export const DEFAULT_BOARD_COLUMNS: readonly TemplateColumn[] = [
  { name: "Backlog", category: "backlog", defaultWaitingOn: null },
  { name: "In progress", category: "started", defaultWaitingOn: null },
  { name: "Done", category: "done", defaultWaitingOn: null },
  { name: "Cancelled", category: "cancelled", defaultWaitingOn: null },
];

// ---------------------------------------------------------------- naming rule and card text (pure)

const LINE_BREAK_RE = /\r\n|[\n\r\u2028\u2029]/;
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu;

/** At most `max` UTF-16 units, never ending inside a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** One line: control characters out, whitespace runs collapsed, trimmed. */
function oneLine(text: string): string {
  return text.replace(CONTROL_RE, " ").replace(/\s+/gu, " ").trim();
}

/** The first non-empty line of `text`, on one line, at most `max` characters (the `{summary}` token). */
export function firstLine(text: string, max: number = BOARD_SUMMARY_MAX): string {
  for (const line of text.split(LINE_BREAK_RE)) {
    const clean = oneLine(line);
    if (clean) return clip(clean, max).trimEnd();
  }
  return "";
}

type NamingToken =
  | { kind: "prefix" }
  | { kind: "seq"; pad: number }
  | { kind: "summary" }
  | { kind: "field"; key: string };

type RuleSegment = { kind: "text"; text: string } | { kind: "token"; token: NamingToken; raw: string };

const TOKEN_BODY_RE = /^(?:(prefix)|seq(?::(0{1,8}))?|(summary)|field:([a-z][a-z0-9_]{0,39}))$/;

type Tokenized = { ok: true; segments: RuleSegment[] } | { ok: false; error: string };

function tokenizeRule(rule: string): Tokenized {
  if (rule.length > BOARD_NAMING_RULE_MAX) {
    return { ok: false, error: `A naming rule has at most ${BOARD_NAMING_RULE_MAX} characters` };
  }
  if (LINE_BREAK_RE.test(rule) || /[\p{Cc}\p{Cf}]/u.test(rule)) {
    return { ok: false, error: "A naming rule is one line of plain text" };
  }
  const segments: RuleSegment[] = [];
  let text = "";
  let i = 0;
  while (i < rule.length) {
    const ch = rule.charAt(i);
    if (ch === "}") return { ok: false, error: `Unmatched } at position ${i + 1}` };
    if (ch !== "{") {
      text += ch;
      i += 1;
      continue;
    }
    const close = rule.indexOf("}", i + 1);
    const nextOpen = rule.indexOf("{", i + 1);
    if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
      return { ok: false, error: `Unclosed { at position ${i + 1}` };
    }
    const raw = rule.slice(i, close + 1);
    const m = TOKEN_BODY_RE.exec(rule.slice(i + 1, close));
    if (!m) {
      return {
        ok: false,
        error: `Unknown token ${raw}: use {prefix}, {seq}, {seq:0000}, {summary} or {field:<key>}`,
      };
    }
    const token: NamingToken = m[1]
      ? { kind: "prefix" }
      : m[3]
        ? { kind: "summary" }
        : m[4]
          ? { kind: "field", key: m[4] }
          : { kind: "seq", pad: m[2]?.length ?? 0 };
    if (text) segments.push({ kind: "text", text });
    text = "";
    segments.push({ kind: "token", token, raw });
    i = close + 1;
  }
  if (text) segments.push({ kind: "text", text });
  if (!segments.some((s) => s.kind === "token")) {
    return { ok: false, error: "A naming rule needs at least one token, such as {summary}" };
  }
  return { ok: true, segments };
}

/** The tokens a valid rule uses (empty for an invalid one). */
export function namingRuleTokens(rule: string): NamingToken[] {
  const t = tokenizeRule(rule);
  return t.ok ? t.segments.flatMap((s) => (s.kind === "token" ? [s.token] : [])) : [];
}

/**
 * Checks a naming rule against the fixed grammar: `{prefix}`, `{seq}`, `{seq:` + 1–8 zeros + `}`, `{summary}` and
 * `{field:<key>}`; everything else is literal text. Unknown tokens, unknown field keys, unbalanced braces, line
 * breaks and rules over 120 characters are refused. `fieldKeys: null` checks the grammar only (a partial update whose
 * field list is merged and re-checked by the API).
 */
export function parseNamingRule(
  rule: string,
  fieldKeys: readonly string[] | null,
): { ok: true } | { ok: false; error: string } {
  const t = tokenizeRule(rule);
  if (!t.ok) return t;
  if (fieldKeys) {
    for (const s of t.segments) {
      if (s.kind === "token" && s.token.kind === "field" && !fieldKeys.includes(s.token.key)) {
        return { ok: false, error: `Unknown field "${s.token.key}" in ${s.raw}` };
      }
    }
  }
  return { ok: true };
}

export type FieldValue = string | number | null;

export interface CardTitleContext {
  prefix: string | null;
  /** The per-board number; null when the board has no prefix. */
  number: number | null;
  description: string;
  fields: Readonly<Record<string, unknown>>;
}

function fieldText(value: unknown): string {
  if (typeof value === "string") return oneLine(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * The card title a naming rule produces (D-06, D-08): deterministic, plain text, one line, 1–200 characters. A token
 * that renders empty is dropped together with the literal text joining it to the previous non-empty token (so " · "
 * never doubles or dangles); text before the first token belongs to it, text after the last token belongs to that
 * one. An empty result falls back to the summary, then to "Untitled". A null or invalid rule renders the summary.
 */
export function renderCardTitle(rule: string | null, ctx: CardTitleContext): string {
  const summary = firstLine(ctx.description);
  const t = rule === null ? null : tokenizeRule(rule);
  let out = "";
  if (t?.ok) {
    let pending = "";
    let emitted = false;
    let seenToken = false;
    let lastTokenEmpty = true;
    for (const s of t.segments) {
      if (s.kind === "text") {
        pending += s.text;
        continue;
      }
      const tok = s.token;
      const value =
        tok.kind === "prefix"
          ? (ctx.prefix ?? "")
          : tok.kind === "seq"
            ? ctx.number === null
              ? ""
              : String(ctx.number).padStart(tok.pad, "0")
            : tok.kind === "summary"
              ? summary
              : fieldText(ctx.fields[tok.key]);
      const isFirstToken = !seenToken;
      seenToken = true;
      lastTokenEmpty = value === "";
      if (value) {
        // Leading text of the rule belongs to the first token; later text joins two non-empty tokens.
        out += emitted || isFirstToken ? pending + value : value;
        emitted = true;
      }
      pending = "";
    }
    if (emitted && !lastTokenEmpty) out += pending;
  }
  const title = clip(oneLine(out), BOARD_CARD_TITLE_MAX).trimEnd();
  return title || summary || "Untitled";
}

/**
 * The plain-text message body of a card (D-02, BOARD-05): title, a blank line, the description, a blank line, then one
 * "Label: value" line per non-empty field in definition order. Labels come from the definitions; values without a
 * definition are left out. Always within the chat message body limit.
 */
export function cardMessageBody(card: {
  title: string;
  description: string;
  fields: Readonly<Record<string, unknown>>;
  defs: readonly BoardFieldDef[];
}): string {
  const parts = [oneLine(card.title) || "Untitled"];
  const description = card.description.trim();
  if (description) parts.push(description);
  const lines = card.defs.flatMap((d) => {
    const v = fieldText(card.fields[d.key]);
    return v ? [`${oneLine(d.label)}: ${v}`] : [];
  });
  if (lines.length > 0) parts.push(lines.join("\n"));
  return clip(parts.join("\n\n"), BOARD_CARD_BODY_MAX).trimEnd();
}

const FieldValue = z.union([z.string().max(BOARD_FIELD_TEXT_MAX), z.number(), z.null()]);

/** Field values of a card as stored and sent: known key shape, at most 20 entries. Typed per board by `fieldValuesSchema`. */
export const BoardFieldValues = z
  .record(BoardFieldKey, FieldValue)
  .refine((v) => Object.keys(v).length <= BOARD_MAX_FIELDS, {
    message: `At most ${BOARD_MAX_FIELDS} fields`,
  });
export type BoardFieldValues = z.infer<typeof BoardFieldValues>;

/**
 * The values a board with these definitions accepts: a strict object (unknown keys refused); text ≤ 500 characters,
 * number finite, date `YYYY-MM-DD`, select one of the options; required fields refuse absent, null and empty values.
 */
export function fieldValuesSchema(defs: readonly BoardFieldDef[]): z.ZodType<Record<string, FieldValue>> {
  const shape: Record<string, z.ZodType<FieldValue | undefined>> = {};
  for (const d of defs) {
    const base: z.ZodType<string | number> =
      d.type === "text"
        ? z.string().trim().max(BOARD_FIELD_TEXT_MAX)
        : d.type === "number"
          ? z.number()
          : d.type === "date"
            ? z.iso.date()
            : z
                .string()
                .refine((v) => d.options?.includes(v) ?? false, { message: "Not one of the options" });
    shape[d.key] = d.required
      ? base.refine((v) => v !== "", { message: `${d.label} is required` })
      : z.union([base, z.null()]).optional();
  }
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, FieldValue>>;
}

// ---------------------------------------------------------------- board, columns, cards

/** Board settings: a snapshot of the template it was created from (template edits affect new boards only, P-08). */
export const Board = z.object({
  conversationId: Id,
  templateId: Id.nullable(),
  prefix: BoardPrefix.nullable(),
  namingRule: z.string().max(BOARD_NAMING_RULE_MAX).nullable(),
  fields: z.array(BoardFieldDef).max(BOARD_MAX_FIELDS),
  version: z.number().int().min(1),
});
export type Board = z.infer<typeof Board>;

export const BoardColumn = z.object({
  id: Id,
  conversationId: Id,
  name: BoardColumnName,
  rank: BoardRank,
  category: BoardColumnCategory,
  /** Applied when a card enters the column; null = "Keep as is". */
  defaultWaitingOn: WaitingOn.nullable(),
});
export type BoardColumn = z.infer<typeof BoardColumn>;

/** A card = the root message of a thread (`messageId`) plus its board state. Never carries viewer-specific fields. */
export const BoardCard = z.object({
  messageId: Id,
  conversationId: Id,
  columnId: Id,
  rank: BoardRank,
  waitingOn: WaitingOn,
  title: BoardCardTitle,
  /** `user` = typed by a person, never replaced by the naming rule (BOARD-06). */
  titleSource: TitleSource,
  description: z.string().max(BOARD_CARD_DESCRIPTION_MAX),
  number: z.number().int().positive().nullable(),
  fields: BoardFieldValues,
  authorKind: z.enum(["user", "agent"]),
  authorId: Id,
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  movedAt: IsoDateTime,
  /** Optimistic concurrency (D-05): every move or edit bumps it; a re-rank does not. */
  version: z.number().int().min(1),
});
export type BoardCard = z.infer<typeof BoardCard>;

export const BoardColumnCards = z.object({
  columnId: Id,
  cards: z.array(BoardCard).max(BOARD_COLUMN_PAGE),
  /** More cards than one page: `GET /boards/:conversationId/columns/:columnId/cards?after=<rank>` serves the rest. */
  hasMore: z.boolean(),
});
export type BoardColumnCards = z.infer<typeof BoardColumnCards>;

/** `GET /boards/:conversationId`. Subscribe to `conv:<id>` with `afterSeq = lastSeq`. */
export const BoardSnapshot = z.object({
  board: Board,
  columns: z.array(BoardColumn).max(BOARD_MAX_COLUMNS),
  cards: z.array(BoardColumnCards).max(BOARD_MAX_COLUMNS),
  lastSeq: z.number().int().nonnegative(),
});
export type BoardSnapshot = z.infer<typeof BoardSnapshot>;

export const BoardColumnPageQuery = z.object({ after: BoardRank.optional() });
export type BoardColumnPageQuery = z.infer<typeof BoardColumnPageQuery>;

/** Where a moved card lands: after `afterCardId` in `columnId`; null = top of the column. */
export const BoardCardMove = z.object({ columnId: Id, afterCardId: Id.nullable() });
export type BoardCardMove = z.infer<typeof BoardCardMove>;

const CardDescription = z.string().trim().max(BOARD_CARD_DESCRIPTION_MAX);

/** `POST /boards/:conversationId/cards`. Without `columnId` the card lands at the bottom of the first backlog column. */
export const CreateBoardCardRequest = z
  .object({
    /** Typed title (`titleSource: "user"`); absent = rendered by the board's naming rule. */
    title: BoardCardTitle.optional(),
    description: CardDescription.default(""),
    columnId: Id.optional(),
    waitingOn: WaitingOn.optional(),
    fields: BoardFieldValues.optional(),
    /** Client-generated idempotency key (same as `PostMessageRequest.clientMessageId`). */
    clientMessageId: z.string().min(1).max(64),
  })
  .refine((v) => (v.title?.length ?? 0) > 0 || v.description.length > 0, {
    message: "Give the card a title or a description",
    path: ["description"],
  });
export type CreateBoardCardRequest = z.infer<typeof CreateBoardCardRequest>;

/** `PATCH /boards/:conversationId/cards/:messageId`. Moves and waiting state: any poster; text: the author only (P-02). */
export const UpdateBoardCardRequest = z
  .object({
    expectedVersion: z.number().int().min(1),
    move: BoardCardMove.optional(),
    waitingOn: WaitingOn.optional(),
    title: BoardCardTitle.optional(),
    description: CardDescription.optional(),
    fields: BoardFieldValues.optional(),
  })
  .refine(
    (v) =>
      v.move !== undefined ||
      v.waitingOn !== undefined ||
      v.title !== undefined ||
      v.description !== undefined ||
      v.fields !== undefined,
    { message: "Change at least one thing" },
  );
export type UpdateBoardCardRequest = z.infer<typeof UpdateBoardCardRequest>;

// ---------------------------------------------------------------- events (on `conv:<id>` only, P-06)

/** `board.card_upserted`: one card created, moved or edited. Removal rides `message.deleted`. */
export const BoardCardUpsertedEvent = z.object({ card: BoardCard });
export type BoardCardUpsertedEvent = z.infer<typeof BoardCardUpsertedEvent>;

/** `board.updated`: the board settings and the full column list (small; clients replace both). */
export const BoardUpdatedEvent = z.object({
  conversationId: Id,
  board: Board,
  columns: z.array(BoardColumn).max(BOARD_MAX_COLUMNS),
});
export type BoardUpdatedEvent = z.infer<typeof BoardUpdatedEvent>;

/** `board.column_reranked`: one column's new ranks after a server re-rank; card versions are unchanged. */
export const BoardColumnRerankedEvent = z.object({
  conversationId: Id,
  columnId: Id,
  ranks: z.array(z.object({ messageId: Id, rank: BoardRank })).max(BOARD_RERANK_MAX),
});
export type BoardColumnRerankedEvent = z.infer<typeof BoardColumnRerankedEvent>;

// ---------------------------------------------------------------- record templates (D-06, P-08)

export const RECORD_TEMPLATE_NAME_MAX = 80;
export const RECORD_TEMPLATE_DESCRIPTION_MAX = 500;
/** Templates in one `GET /record-templates` answer (the unit's, its ancestors' and organization-wide ones). */
export const RECORD_TEMPLATE_LIST_MAX = 200;

/** 1–20 columns, names unique ignoring case. */
export const TemplateColumns = z
  .array(TemplateColumn)
  .min(1)
  .max(BOARD_MAX_COLUMNS)
  .superRefine((cols, ctx) => {
    const seen = new Set<string>();
    cols.forEach((c, i) => {
      const name = c.name.toLowerCase();
      if (seen.has(name))
        ctx.addIssue({ code: "custom", path: [i, "name"], message: `Duplicate column "${c.name}"` });
      seen.add(name);
    });
  });

const NamingRuleText = z.string().trim().min(1).max(BOARD_NAMING_RULE_MAX);

/**
 * Why a template's prefix, naming rule and fields do not fit together (empty = they do). The rule must parse against
 * the template's own field keys, and `{prefix}` or `{seq}` need a prefix (cards are numbered only on prefixed boards,
 * P-07). `fieldKeys: null` checks the grammar only. The API runs it again on the merged template of an update.
 */
export function recordTemplateProblems(t: {
  prefix: string | null;
  namingRule: string | null;
  fieldKeys: readonly string[] | null;
}): string[] {
  if (t.namingRule === null) return [];
  const parsed = parseNamingRule(t.namingRule, t.fieldKeys);
  if (!parsed.ok) return [parsed.error];
  const numbered = namingRuleTokens(t.namingRule).some((k) => k.kind === "prefix" || k.kind === "seq");
  return numbered && t.prefix === null ? ["{prefix} and {seq} need a prefix"] : [];
}

export const RecordTemplate = z.object({
  id: Id,
  /** null = organization-wide; otherwise usable by channels placed in this unit or below (P-08). */
  unitId: Id.nullable(),
  name: z.string().min(1).max(RECORD_TEMPLATE_NAME_MAX),
  description: z.string().max(RECORD_TEMPLATE_DESCRIPTION_MAX),
  prefix: BoardPrefix.nullable(),
  namingRule: z.string().max(BOARD_NAMING_RULE_MAX).nullable(),
  fields: z.array(BoardFieldDef).max(BOARD_MAX_FIELDS),
  columns: z.array(TemplateColumn).min(1).max(BOARD_MAX_COLUMNS),
  version: z.number().int().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RecordTemplate = z.infer<typeof RecordTemplate>;

export const RecordTemplateList = z.object({
  templates: z.array(RecordTemplate).max(RECORD_TEMPLATE_LIST_MAX),
  /** The resolver's decision for the queried unit (`unit.members.manage`, or `unit.manage` org-wide): UI gating only. */
  canManage: z.boolean(),
});
export type RecordTemplateList = z.infer<typeof RecordTemplateList>;

/** `GET /record-templates?unitId=`: templates a channel placed in this unit may use; absent = organization-wide only. */
export const RecordTemplateListQuery = z.object({ unitId: Id.optional() });
export type RecordTemplateListQuery = z.infer<typeof RecordTemplateListQuery>;

const TemplateName = z.string().trim().min(1).max(RECORD_TEMPLATE_NAME_MAX);
const TemplateDescription = z.string().trim().max(RECORD_TEMPLATE_DESCRIPTION_MAX);

/** `POST /record-templates`. Without `columns` the template gets `DEFAULT_BOARD_COLUMNS`. */
export const CreateRecordTemplateRequest = z
  .object({
    unitId: Id.nullable().default(null),
    name: TemplateName,
    description: TemplateDescription.default(""),
    prefix: BoardPrefix.nullable().default(null),
    namingRule: NamingRuleText.nullable().default(null),
    fields: BoardFieldDefs.default(() => []),
    columns: TemplateColumns.default(() => DEFAULT_BOARD_COLUMNS.map((c) => ({ ...c }))),
  })
  .superRefine((t, ctx) => {
    const fieldKeys = t.fields.map((f) => f.key);
    for (const message of recordTemplateProblems({ prefix: t.prefix, namingRule: t.namingRule, fieldKeys })) {
      ctx.addIssue({ code: "custom", path: ["namingRule"], message });
    }
  });
export type CreateRecordTemplateRequest = z.infer<typeof CreateRecordTemplateRequest>;

/** `PATCH /record-templates/:id`: the version the editor saw plus at least one change. Affects new boards only. */
export const UpdateRecordTemplateRequest = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: TemplateName.optional(),
    description: TemplateDescription.optional(),
    prefix: BoardPrefix.nullable().optional(),
    namingRule: NamingRuleText.nullable().optional(),
    fields: BoardFieldDefs.optional(),
    columns: TemplateColumns.optional(),
  })
  .superRefine((t, ctx) => {
    const { expectedVersion: _v, ...changes } = t;
    if (Object.values(changes).every((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", message: "Change at least one thing" });
    }
    if (typeof t.namingRule === "string") {
      const problems = recordTemplateProblems({
        // Unknown (absent) prefix and fields are merged and re-checked by the API.
        prefix: t.prefix === undefined ? "" : t.prefix,
        namingRule: t.namingRule,
        fieldKeys: t.fields ? t.fields.map((f) => f.key) : null,
      });
      for (const message of problems) ctx.addIssue({ code: "custom", path: ["namingRule"], message });
    }
  });
export type UpdateRecordTemplateRequest = z.infer<typeof UpdateRecordTemplateRequest>;
