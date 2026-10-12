import {
  BOARD_FIELD_KEY_RE,
  BOARD_MAX_COLUMNS,
  BOARD_MAX_FIELDS,
  BOARD_NAMING_RULE_MAX,
  BOARD_PREFIX_RE,
  type BoardColumnCategory,
  type BoardFieldDef,
  type BoardFieldType,
  CreateRecordTemplateRequest,
  DEFAULT_BOARD_COLUMNS,
  parseNamingRule,
  type RecordTemplate,
  renderCardTitle,
  type TemplateColumn,
  type WaitingOn,
} from "@ocw/contracts";

/**
 * The record template editor's form state and its pure helpers (07.1-12, BOARD-06, D-06): a draft the editor edits,
 * the request it sends, validation with the UI-SPEC copy before any request, and the naming preview. The API checks
 * everything again (`CreateRecordTemplateRequest`, `recordTemplateProblems`); this only says it earlier and in place.
 */

export interface FieldDraft {
  /** Stable React key of the row. */
  id: string;
  label: string;
  key: string;
  /** Saved fields keep their key when the label changes (rules and existing boards use it); new ones follow it. */
  keyLocked: boolean;
  type: BoardFieldType;
  required: boolean;
  /** Choice fields only. */
  options: string[];
}

export interface ColumnDraft {
  id: string;
  name: string;
  category: BoardColumnCategory;
  defaultWaitingOn: WaitingOn | null;
}

export interface TemplateDraft {
  /** null = the whole organization. */
  unitId: string | null;
  name: string;
  description: string;
  prefix: string;
  namingRule: string;
  fields: FieldDraft[];
  columns: ColumnDraft[];
}

/** Field (or form) → message. Keys: `name`, `prefix`, `namingRule`, `fields`, `fields.{i}.label|key|options`, `columns`, `columns.{i}.name`, `form`. */
export type DraftErrors = Record<string, string>;

let seq = 0;
/** A fresh row id (React keys only; never sent). */
export const rowId = (kind: "f" | "c" | "o" = "f") => `${kind}${++seq}`;

export function emptyDraft(unitId: string | null): TemplateDraft {
  return {
    unitId,
    name: "",
    description: "",
    prefix: "",
    namingRule: "",
    fields: [],
    columns: DEFAULT_BOARD_COLUMNS.map((c) => ({ id: rowId("c"), ...c })),
  };
}

export function newField(label = ""): FieldDraft {
  return {
    id: rowId("f"),
    label,
    key: keyFromLabel(label),
    keyLocked: false,
    type: "text",
    required: false,
    options: [],
  };
}

export function newColumn(): ColumnDraft {
  return { id: rowId("c"), name: "", category: "started", defaultWaitingOn: null };
}

/** "Customer name" → `customer_name`; always a valid key (`^[a-z][a-z0-9_]{0,39}$`). */
export function keyFromLabel(label: string): string {
  let key = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) key = "field";
  if (!/^[a-z]/.test(key)) key = `f_${key}`;
  return key.slice(0, 40).replace(/_+$/, "");
}

/** The value a field shows in the preview: the sample's, else its label. */
export interface PreviewSample {
  fields?: Record<string, string>;
  summary?: string;
}

/**
 * The title the first card of a board built from this draft gets (07.1-UI-SPEC "Record template editor" › preview):
 * `renderCardTitle` with number 1 (none without a prefix, cards are numbered only on prefixed boards), each field's
 * label as its value and "Summary" as the description, unless a sample says otherwise.
 */
export function previewTitle(
  draft: Pick<TemplateDraft, "prefix" | "namingRule" | "fields">,
  sample: PreviewSample = {},
): string {
  const prefix = draft.prefix.trim() || null;
  const fields: Record<string, string> = {};
  for (const f of draft.fields) fields[f.key] = sample.fields?.[f.key] ?? f.label;
  return renderCardTitle(draft.namingRule.trim() || null, {
    prefix,
    number: prefix ? 1 : null,
    description: sample.summary ?? "Summary",
    fields,
  });
}

/** The card number a board built from this draft shows on its first card's badge (null without a prefix). */
export function previewNumber(draft: Pick<TemplateDraft, "prefix">): number | null {
  return draft.prefix.trim() ? 1 : null;
}

function toField(f: FieldDraft): BoardFieldDef {
  const def: BoardFieldDef = { key: f.key, label: f.label.trim(), type: f.type, required: f.required };
  if (f.type === "select") def.options = f.options.map((o) => o.trim()).filter(Boolean);
  return def;
}

function toColumn(c: ColumnDraft): TemplateColumn {
  return { name: c.name.trim(), category: c.category, defaultWaitingOn: c.defaultWaitingOn };
}

/** The `POST /record-templates` body (also the changes of a `PATCH`). Empty prefix and rule are null. */
export function toRequest(draft: TemplateDraft): CreateRecordTemplateRequest {
  return {
    unitId: draft.unitId,
    name: draft.name.trim(),
    description: draft.description.trim(),
    prefix: draft.prefix.trim() || null,
    namingRule: draft.namingRule.trim() || null,
    fields: draft.fields.map(toField),
    columns: draft.columns.map(toColumn),
  };
}

/** A saved template as an editable draft; its field keys stay as saved. */
export function fromTemplate(t: RecordTemplate): TemplateDraft {
  return {
    unitId: t.unitId,
    name: t.name,
    description: t.description,
    prefix: t.prefix ?? "",
    namingRule: t.namingRule ?? "",
    fields: t.fields.map((f) => ({
      id: rowId("f"),
      label: f.label,
      key: f.key,
      keyLocked: true,
      type: f.type,
      required: f.required,
      options: f.options ? [...f.options] : [],
    })),
    columns: t.columns.map((c) => ({ id: rowId("c"), ...c })),
  };
}

const TOKEN_RE = /\{[^{}]*\}/g;

/** The rule's message in the UI-SPEC copy, or null when it fits the draft's fields and prefix. */
function ruleProblem(draft: TemplateDraft): string | null {
  const rule = draft.namingRule.trim();
  if (!rule) return null;
  if (rule.length > BOARD_NAMING_RULE_MAX) return `Keep the rule under ${BOARD_NAMING_RULE_MAX} characters`;
  const grammar = parseNamingRule(rule, null);
  if (!grammar.ok) {
    const unknown = (rule.match(TOKEN_RE) ?? []).find(
      (t) => !/^\{(?:prefix|seq(?::0{1,8})?|summary|field:[a-z][a-z0-9_]{0,39})\}$/.test(t),
    );
    if (unknown) {
      return `Unknown token ${unknown}. Use {prefix}, {seq}, {seq:0000}, {summary} or {field:key}`;
    }
    return grammar.error;
  }
  const keys = new Set(draft.fields.map((f) => f.key));
  for (const m of rule.matchAll(/\{field:([a-z][a-z0-9_]{0,39})\}/g)) {
    if (!keys.has(m[1] ?? "")) return `No field with key “${m[1]}”`;
  }
  if (/\{(?:prefix|seq(?::0{1,8})?)\}/.test(rule) && !draft.prefix.trim()) {
    return "Add a prefix to use {prefix} or {seq}";
  }
  return null;
}

/**
 * Every problem of the draft, keyed by where the editor shows it, in the UI-SPEC copy; `{}` = the API would take it.
 * Anything the contract refuses that these checks did not name is reported with the contract's own message.
 */
export function validateDraft(draft: TemplateDraft): DraftErrors {
  const errors: DraftErrors = {};
  const set = (k: string, m: string) => {
    if (!errors[k]) errors[k] = m;
  };

  if (!draft.name.trim()) set("name", "Give the template a name");
  const prefix = draft.prefix.trim();
  if (prefix && !BOARD_PREFIX_RE.test(prefix)) set("prefix", "Use 1–8 capital letters or digits");
  const rule = ruleProblem(draft);
  if (rule) set("namingRule", rule);

  if (draft.fields.length > BOARD_MAX_FIELDS)
    set("fields", `A template can have up to ${BOARD_MAX_FIELDS} fields`);
  const keys = new Set<string>();
  draft.fields.forEach((f, i) => {
    if (!f.label.trim()) set(`fields.${i}.label`, "Give the field a label");
    if (!BOARD_FIELD_KEY_RE.test(f.key)) set(`fields.${i}.key`, "Use lowercase letters, digits and _");
    else if (keys.has(f.key)) set(`fields.${i}.key`, "Field keys must be unique");
    keys.add(f.key);
    if (f.type === "select") {
      const options = f.options.map((o) => o.trim()).filter(Boolean);
      if (options.length === 0) set(`fields.${i}.options`, "Add at least one option");
      else if (new Set(options).size !== options.length) set(`fields.${i}.options`, "Options must be unique");
    }
  });

  if (draft.columns.length === 0) set("columns", "Add at least one column");
  if (draft.columns.length > BOARD_MAX_COLUMNS)
    set("columns", `A board can have up to ${BOARD_MAX_COLUMNS} columns`);
  const names = new Set<string>();
  draft.columns.forEach((c, i) => {
    const name = c.name.trim().toLowerCase();
    if (!name) set(`columns.${i}.name`, "Give the column a name");
    else if (names.has(name)) set(`columns.${i}.name`, "Column names must be unique");
    names.add(name);
  });

  // The contract is the authority: anything it refuses that the checks above did not name.
  if (Object.keys(errors).length === 0) {
    const parsed = CreateRecordTemplateRequest.safeParse(toRequest(draft));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String);
        const key = path.length === 0 ? "form" : path.length >= 3 ? path.slice(0, 3).join(".") : path[0];
        set(key ?? "form", issue.message);
      }
    }
  }
  return errors;
}
