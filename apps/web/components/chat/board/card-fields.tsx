"use client";

import { BOARD_FIELD_TEXT_MAX, type BoardFieldDef, type FieldValue, fieldValuesSchema } from "@ocw/contracts";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";

/**
 * A board's typed card fields (07.1-UI-SPEC "Card dialogs"): one input per definition, in definition order: text
 * `Input`, number `Input`, `type="date"` `Input` or a `Select` of the options. Required fields carry `*` (sr:
 * "required") and `aria-required`. Generic over `BoardFieldDef`, so the new card dialog, the card editor (07.1-11) and
 * the template preview (07.1-12) share it. Values are typed (`string | number | null`); `NaN` marks a number the input
 * could not read, so validation can say so.
 */

export type CardFieldValues = Record<string, FieldValue | undefined>;

/** What an `<input>` string means for a field: numbers parsed (NaN when unreadable), empty = null. */
export function parseFieldInput(def: BoardFieldDef, raw: string): FieldValue {
  if (raw.trim() === "") return null;
  if (def.type === "number") return Number(raw);
  return raw;
}

const isEmpty = (v: FieldValue | undefined) => v === undefined || v === null || v === "";

/** The values as the API takes them: empty optional fields left out, numbers that did not parse kept to fail. */
export function cleanFieldValues(
  defs: readonly BoardFieldDef[],
  values: CardFieldValues,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const d of defs) {
    const v = values[d.key];
    if (isEmpty(v)) {
      if (d.required) out[d.key] = "";
      continue;
    }
    out[d.key] = typeof v === "string" && d.type === "text" ? v.trim() : (v as FieldValue);
  }
  return out;
}

/**
 * Validation with the board's own schema (`fieldValuesSchema`), with the UI-SPEC copy per field: `{Label} is required`,
 * `Enter a number`, `Use a date like 2026-10-08`, `Keep it under 500 characters`. Empty object = valid.
 */
export function fieldErrors(defs: readonly BoardFieldDef[], values: CardFieldValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const cleaned = cleanFieldValues(defs, values);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const parsed = fieldValuesSchema(defs).safeParse(cleaned);
  if (parsed.success) return errors;
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "");
    const def = byKey.get(key);
    if (!def || errors[key]) continue;
    const v = cleaned[key];
    errors[key] = isEmpty(v)
      ? `${def.label} is required`
      : def.type === "number"
        ? "Enter a number"
        : def.type === "date"
          ? "Use a date like 2026-10-08"
          : def.type === "text" && typeof v === "string" && v.length > BOARD_FIELD_TEXT_MAX
            ? "Keep it under 500 characters"
            : `Choose one of the options for ${def.label}`;
  }
  return errors;
}

const NONE = "__none__";

function FieldLabel({ def }: { def: BoardFieldDef }) {
  return (
    <>
      {def.label}
      {def.required ? (
        <>
          <span aria-hidden className="text-destructive">
            {" "}
            *
          </span>
          <span className="sr-only"> required</span>
        </>
      ) : null}
    </>
  );
}

export function CardFields({
  defs,
  values,
  onChange,
  errors,
  idPrefix = "card-field",
}: {
  defs: readonly BoardFieldDef[];
  values: CardFieldValues;
  onChange: (key: string, value: FieldValue) => void;
  errors: Record<string, string | undefined>;
  idPrefix?: string;
}) {
  if (defs.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-slot="card-fields">
      {defs.map((def) => {
        const id = `${idPrefix}-${def.key}`;
        const error = errors[def.key];
        const value = values[def.key];
        const common = {
          id,
          "aria-invalid": !!error,
          "aria-describedby": describedBy(id, error),
          "aria-required": def.required ? true : undefined,
        };
        return (
          <div
            key={def.key}
            data-field-type={def.type}
            className={def.type === "text" ? "sm:col-span-2" : undefined}
          >
            <FormField id={id} label={<FieldLabel def={def} />} error={error}>
              {def.type === "select" ? (
                <Select
                  items={[
                    ...(def.required ? [] : [{ value: NONE, label: "None" }]),
                    ...(def.options ?? []).map((o) => ({ value: o, label: o })),
                  ]}
                  value={typeof value === "string" && value ? value : null}
                  onValueChange={(v) => onChange(def.key, !v || v === NONE ? null : String(v))}
                >
                  <SelectTrigger {...common} placeholder="Choose…" />
                  <SelectContent>
                    {def.required ? null : <SelectItem value={NONE}>None</SelectItem>}
                    {(def.options ?? []).map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  {...common}
                  type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
                  inputMode={def.type === "number" ? "decimal" : undefined}
                  autoComplete="off"
                  maxLength={def.type === "text" ? BOARD_FIELD_TEXT_MAX + 1 : undefined}
                  value={value === null || value === undefined || Number.isNaN(value) ? "" : String(value)}
                  onChange={(e) => onChange(def.key, parseFieldInput(def, e.target.value))}
                />
              )}
            </FormField>
          </div>
        );
      })}
    </div>
  );
}
