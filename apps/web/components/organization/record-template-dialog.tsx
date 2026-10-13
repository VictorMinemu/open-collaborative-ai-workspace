"use client";

import {
  BOARD_MAX_COLUMNS,
  BOARD_MAX_FIELDS,
  type BoardCard,
  type BoardColumnCategory,
  type BoardFieldType,
  type RecordTemplate,
  type WaitingOn,
} from "@ocw/contracts";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CardTile } from "@/components/chat/board/card-tile";
import { CATEGORY, CategoryIcon } from "@/components/chat/board/column-header";
import { Button } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, isApiError } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { useMe } from "@/lib/queries";
import {
  type ColumnDraft,
  type DraftErrors,
  emptyDraft,
  type FieldDraft,
  fromTemplate,
  keyFromLabel,
  newColumn,
  newField,
  previewNumber,
  previewTitle,
  type TemplateDraft,
  toRequest,
  validateDraft,
} from "@/lib/record-template-form";
import { conflictTemplate, useCreateRecordTemplate, useUpdateRecordTemplate } from "@/lib/template-queries";
import { cn } from "@/lib/utils";
import type { UnitNode } from "./unit-meta";

const FIELD_TYPES: ReadonlyArray<{ value: BoardFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Choice" },
];

const KEEP = "keep";
const ENTER_OPTIONS: ReadonlyArray<{ value: WaitingOn | typeof KEEP; label: string }> = [
  { value: KEEP, label: "Keep as is" },
  { value: "none", label: "Waiting on nobody" },
  { value: "us", label: "Waiting on us" },
  { value: "customer", label: "Waiting on customer" },
  { value: "both", label: "Waiting on both" },
];

const CATEGORIES = Object.keys(CATEGORY) as BoardColumnCategory[];

const PREVIEW_ID = "00000000-0000-4000-8000-000000000000";

/** Token chips under the naming rule: what each inserts at the caret. */
const BASE_TOKENS = [
  { label: "Prefix", token: "{prefix}" },
  { label: "Number", token: "{seq:0000}" },
  { label: "Summary", token: "{summary}" },
] as const;

const conflictCopy = "This template changed while you were editing.";

/**
 * The record template editor (07.1-12, 07.1-UI-SPEC "Record template editor", BOARD-06, D-06, D-08): Basics, Card names
 * (prefix, naming rule with token chips that insert at the caret, and a real `CardTile` preview of the first card),
 * Fields and Columns. Validates in place with `validateDraft()` before any request; API refusals show at the top of the
 * body. A stale edit (409 `template_version_conflict`) offers "Reload template", which loads the current template.
 * Full screen with a sticky footer below 640 px.
 */
export function RecordTemplateDialog({
  unit,
  template,
  onClose,
}: {
  unit: Pick<UnitNode, "id" | "name">;
  /** Edit this template; null = a new template for `unit`. */
  template: RecordTemplate | null;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent
        data-testid="record-template-dialog"
        className="sm:max-w-2xl max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none"
      >
        <TemplateForm unit={unit} template={template} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function TemplateForm({
  unit,
  template,
  onClose,
}: {
  unit: Pick<UnitNode, "id" | "name">;
  template: RecordTemplate | null;
  onClose: () => void;
}) {
  const me = useMe({ enabled: false });
  const canOrgWide = useCan("unit.manage");
  const create = useCreateRecordTemplate();
  const update = useUpdateRecordTemplate();
  const [draft, setDraft] = useState<TemplateDraft>(() =>
    template ? fromTemplate(template) : emptyDraft(unit.id),
  );
  const [version, setVersion] = useState(template?.version ?? 1);
  const [submitted, setSubmitted] = useState(false);
  const [ruleTouched, setRuleTouched] = useState(false);
  const [apiErrors, setApiErrors] = useState<DraftErrors>({});
  const [conflict, setConflict] = useState<RecordTemplate | null>(null);
  const ruleRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pending = create.isPending || update.isPending;
  const editing = template !== null;

  const allErrors = useMemo(() => validateDraft(draft), [draft]);
  const errors: DraftErrors = {
    ...(submitted
      ? allErrors
      : ruleTouched && allErrors.namingRule
        ? { namingRule: allErrors.namingRule }
        : {}),
    ...apiErrors,
  };

  const change = (patch: Partial<TemplateDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setApiErrors({});
  };
  const setFields = (fn: (fields: FieldDraft[]) => FieldDraft[]) =>
    setDraft((d) => {
      setApiErrors({});
      return { ...d, fields: fn(d.fields) };
    });
  const setColumns = (fn: (cols: ColumnDraft[]) => ColumnDraft[]) =>
    setDraft((d) => {
      setApiErrors({});
      return { ...d, columns: fn(d.columns) };
    });

  const insertToken = (token: string) => {
    const el = ruleRef.current;
    const rule = draft.namingRule;
    const start = el?.selectionStart ?? rule.length;
    const end = el?.selectionEnd ?? start;
    change({ namingRule: rule.slice(0, start) + token + rule.slice(end) });
    pendingCaret.current = start + token.length;
  };

  // The caret goes right after an inserted token in the same commit, before the next keystroke can land elsewhere.
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const el = ruleRef.current;
    if (caret === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  });

  const reload = () => {
    if (!conflict) return;
    setDraft(fromTemplate(conflict));
    setVersion(conflict.version);
    setConflict(null);
    setSubmitted(false);
    setRuleTouched(false);
    setApiErrors({});
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setConflict(null);
    setApiErrors({});
    if (Object.keys(allErrors).length > 0) {
      requestAnimationFrame(() =>
        bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const body = toRequest(draft);
    try {
      if (template) {
        const { unitId: _scope, ...changes } = body;
        await update.mutateAsync({ id: template.id, body: { expectedVersion: version, ...changes } });
      } else {
        await create.mutateAsync(body);
      }
      onClose();
    } catch (err) {
      const current = conflictTemplate(err);
      if (current) {
        setConflict(current);
        bodyRef.current?.scrollTo({ top: 0 });
      } else if (isApiError(err, 409) && err.code === "template_exists") {
        setApiErrors({ name: `A template named “${body.name}” already exists here` });
      } else if (isApiError(err) && err.code === "invalid_naming_rule") {
        setApiErrors({ namingRule: err.message });
      } else {
        setApiErrors({ form: errorMessage(err) });
        bodyRef.current?.scrollTo({ top: 0 });
      }
    }
  }

  const title = previewTitle(draft);
  const number = previewNumber(draft);
  const now = useMemo(() => new Date().toISOString(), []);
  const previewCard: BoardCard = {
    messageId: PREVIEW_ID,
    conversationId: PREVIEW_ID,
    columnId: PREVIEW_ID,
    rank: "a0",
    waitingOn: "none",
    title,
    titleSource: "auto",
    description: "",
    number,
    fields: {},
    authorKind: "user",
    authorId: me.data?.user.id ?? PREVIEW_ID,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: now,
    movedAt: now,
    version: 1,
  };
  const prefix = draft.prefix.trim();
  const ruleError = errors.namingRule;

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit template" : "New template"}</DialogTitle>
      </DialogHeader>
      <DialogBody
        ref={bodyRef}
        data-testid="record-template-body"
        className="grid flex-1 content-start gap-6 pb-6"
      >
        {conflict ? (
          <div
            role="alert"
            data-testid="template-conflict"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
          >
            {conflictCopy}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-md:h-11"
              onClick={reload}
              data-testid="reload-template"
            >
              Reload template
            </Button>
          </div>
        ) : errors.form ? (
          <p
            role="alert"
            data-testid="template-form-error"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
          >
            {errors.form}
          </p>
        ) : null}

        <Section title="Basics">
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField id="template-name" label="Name" error={errors.name}>
              <Input
                id="template-name"
                autoFocus
                autoComplete="off"
                placeholder="e.g. Case file"
                maxLength={80}
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
                aria-invalid={!!errors.name}
                aria-describedby={describedBy("template-name", errors.name)}
                className="max-sm:h-11"
              />
            </FormField>
            <fieldset className="grid content-start gap-2">
              <legend className="mb-2 font-medium text-sm">Available in</legend>
              {editing ? (
                <p className="text-sm" data-testid="template-scope">
                  {draft.unitId === null ? "The whole organization" : `${unit.name} and the units inside it`}
                </p>
              ) : (
                <div className="grid gap-1">
                  <ScopeOption
                    checked={draft.unitId !== null}
                    onSelect={() => change({ unitId: unit.id })}
                    value="unit"
                  >
                    {unit.name} and the units inside it
                  </ScopeOption>
                  {canOrgWide ? (
                    <ScopeOption
                      checked={draft.unitId === null}
                      onSelect={() => change({ unitId: null })}
                      value="org"
                    >
                      The whole organization
                    </ScopeOption>
                  ) : null}
                </div>
              )}
            </fieldset>
          </div>
          <FormField
            id="template-description"
            label={
              <>
                Description <span className="font-normal text-muted-foreground">(optional)</span>
              </>
            }
          >
            <Textarea
              id="template-description"
              rows={2}
              maxLength={500}
              placeholder="What boards use it for"
              value={draft.description}
              onChange={(e) => change({ description: e.target.value })}
              className="min-h-16"
            />
          </FormField>
        </Section>

        <Separator />

        <Section title="Card names">
          <FormField
            id="template-prefix"
            label={
              <>
                Prefix <span className="font-normal text-muted-foreground">(optional)</span>
              </>
            }
            error={errors.prefix}
            hint={
              prefix
                ? `1–8 capital letters or digits. Cards are numbered ${prefix}-1, ${prefix}-2…`
                : "1–8 capital letters or digits."
            }
          >
            <Input
              id="template-prefix"
              autoComplete="off"
              spellCheck={false}
              maxLength={8}
              placeholder="EXP"
              value={draft.prefix}
              onChange={(e) => change({ prefix: e.target.value.toUpperCase() })}
              aria-invalid={!!errors.prefix}
              aria-describedby={describedBy("template-prefix", errors.prefix, "hint")}
              className="w-32 font-mono tabular-nums max-sm:h-11"
            />
          </FormField>
          <FormField
            id="template-rule"
            label={
              <>
                Naming rule <span className="font-normal text-muted-foreground">(optional)</span>
              </>
            }
            error={ruleError}
            hint="Leave empty to use the first line of the description."
          >
            <Input
              ref={ruleRef}
              id="template-rule"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              placeholder="{prefix}-{seq:0000} · {summary}"
              value={draft.namingRule}
              onChange={(e) => change({ namingRule: e.target.value })}
              onBlur={(e) => {
                if (!(e.relatedTarget instanceof HTMLElement && e.relatedTarget.dataset.token)) {
                  setRuleTouched(true);
                }
              }}
              aria-invalid={!!ruleError}
              aria-describedby={describedBy("template-rule", ruleError, "hint")}
              className="font-mono text-sm max-sm:h-11"
            />
          </FormField>
          <div className="flex flex-wrap items-center gap-2" data-testid="token-chips">
            <span className="text-muted-foreground text-xs">Insert:</span>
            {[
              ...BASE_TOKENS,
              ...draft.fields
                .filter((f) => f.label.trim())
                .map((f) => ({ label: f.label.trim(), token: `{field:${f.key}}` })),
            ].map((t) => (
              <Button
                key={t.token}
                type="button"
                size="sm"
                variant="outline"
                data-token={t.token}
                data-testid="token-chip"
                aria-label={`Insert ${t.label}`}
                className="max-sm:h-11"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertToken(t.token)}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-2">
            <span className="font-medium text-sm" id="template-preview-label">
              Preview
            </span>
            <ul
              aria-labelledby="template-preview-label"
              data-testid="template-preview"
              className="w-68 max-w-full"
              inert
            >
              <CardTile
                card={previewCard}
                board={{ prefix: prefix || null, namingRule: draft.namingRule.trim() || null }}
                author={me.data ? { name: me.data.user.name, avatarUrl: me.data.user.image } : null}
                canPost={false}
                onOpen={() => undefined}
              />
            </ul>
          </div>
        </Section>

        <Separator />

        <Section
          title="Fields"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-sm:h-11"
              disabled={draft.fields.length >= BOARD_MAX_FIELDS}
              onClick={() => setFields((f) => [...f, newField()])}
              data-testid="add-field"
            >
              <Plus /> Add field
            </Button>
          }
        >
          {errors.fields ? (
            <p role="alert" className="text-[13px] text-destructive">
              {errors.fields}
            </p>
          ) : null}
          {draft.fields.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-3 text-muted-foreground text-xs">
              No fields. Cards then ask only for a title and a description.
            </p>
          ) : (
            <ul className="grid gap-3">
              {draft.fields.map((f, i) => (
                <FieldRow
                  key={f.id}
                  field={f}
                  index={i}
                  count={draft.fields.length}
                  errors={errors}
                  onChange={(patch) =>
                    setFields((all) => all.map((x) => (x.id === f.id ? { ...x, ...patch } : x)))
                  }
                  onMove={(to) => setFields((all) => move(all, i, to))}
                  onRemove={() => {
                    setFields((all) => all.filter((x) => x.id !== f.id));
                    setRuleTouched(true);
                  }}
                />
              ))}
            </ul>
          )}
        </Section>

        <Separator />

        <Section
          title="Columns"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-sm:h-11"
              disabled={draft.columns.length >= BOARD_MAX_COLUMNS}
              onClick={() => setColumns((c) => [...c, newColumn()])}
              data-testid="add-template-column"
            >
              <Plus /> Add column
            </Button>
          }
        >
          {errors.columns ? (
            <p role="alert" className="text-[13px] text-destructive">
              {errors.columns}
            </p>
          ) : null}
          <ul className="grid gap-3">
            {draft.columns.map((c, i) => (
              <ColumnRow
                key={c.id}
                column={c}
                index={i}
                count={draft.columns.length}
                error={errors[`columns.${i}.name`]}
                onChange={(patch) =>
                  setColumns((all) => all.map((x) => (x.id === c.id ? { ...x, ...patch } : x)))
                }
                onMove={(to) => setColumns((all) => move(all, i, to))}
                onRemove={() => setColumns((all) => all.filter((x) => x.id !== c.id))}
              />
            ))}
          </ul>
        </Section>
      </DialogBody>
      <DialogFooter className="sticky bottom-0 max-sm:pb-[max(env(safe-area-inset-bottom),12px)]">
        <Button type="button" variant="outline" onClick={onClose} className="max-md:h-11">
          Cancel
        </Button>
        <Button type="submit" disabled={pending} className="max-md:h-11" data-testid="save-template">
          {pending ? <Spinner /> : null}
          {editing ? "Save template" : "Create template"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-4" aria-label={title}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ScopeOption({
  checked,
  onSelect,
  value,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  value: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm max-sm:min-h-11">
      <input
        type="radio"
        name="template-scope"
        value={value}
        checked={checked}
        onChange={onSelect}
        className="size-4 shrink-0 accent-primary"
        data-testid={`template-scope-${value}`}
      />
      <span className="min-w-0 break-words">{children}</span>
    </label>
  );
}

function RowActions({
  noun,
  index,
  count,
  onMove,
  onRemove,
  canRemove = true,
}: {
  noun: "field" | "column";
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
  canRemove?: boolean;
}) {
  const cls = "text-muted-foreground max-sm:size-11";
  return (
    <div className="flex items-center justify-end gap-1 sm:h-9">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className={cls}
        aria-label={`Move ${noun} up`}
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className={cls}
        aria-label={`Move ${noun} down`}
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        <ArrowDown />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className={cn(cls, "hover:text-destructive")}
        aria-label={`Remove ${noun}`}
        disabled={!canRemove}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

const rowClass =
  "grid gap-2 rounded-lg border p-3 sm:items-start sm:gap-x-3 sm:rounded-none sm:border-0 sm:p-0";

function FieldRow({
  field: f,
  index: i,
  count,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  field: FieldDraft;
  index: number;
  count: number;
  errors: DraftErrors;
  onChange: (patch: Partial<FieldDraft>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const [option, setOption] = useState("");
  const labelId = `field-${f.id}-label`;
  const labelError = errors[`fields.${i}.label`] ?? errors[`fields.${i}.key`];
  const optionsError = errors[`fields.${i}.options`];
  const name = f.label.trim() || `Field ${i + 1}`;
  const addOption = () => {
    const o = option.trim();
    if (!o) return;
    if (!f.options.includes(o)) onChange({ options: [...f.options, o] });
    setOption("");
  };
  return (
    <li
      data-testid="template-field-row"
      data-key={f.key}
      className={cn(rowClass, "sm:grid-cols-[minmax(0,1fr)_8.5rem_auto_auto]")}
    >
      <div className="grid min-w-0 gap-1">
        <Input
          id={labelId}
          aria-label={`Field ${i + 1} label`}
          placeholder="Label, e.g. Customer"
          maxLength={60}
          value={f.label}
          onChange={(e) =>
            onChange({ label: e.target.value, ...(f.keyLocked ? {} : { key: keyFromLabel(e.target.value) }) })
          }
          aria-invalid={!!labelError}
          aria-describedby={describedBy(labelId, labelError, "key")}
          data-testid="field-label"
          className="max-sm:h-11"
        />
        {labelError ? (
          <p id={`${labelId}-error`} role="alert" className="text-[13px] text-destructive">
            {labelError}
          </p>
        ) : (
          <p
            id={`${labelId}-hint`}
            className="font-mono text-muted-foreground text-xs"
            data-testid="field-key"
          >
            key: {f.key}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3 sm:contents">
        <div className="min-w-0 flex-1 sm:flex-none">
          <Select
            items={FIELD_TYPES}
            value={f.type}
            onValueChange={(v) => v && onChange({ type: v as BoardFieldType })}
          >
            <SelectTrigger aria-label={`Type of ${name}`} data-testid="field-type" className="max-sm:h-11" />
            <SelectContent>
              {FIELD_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="flex h-9 items-center gap-2 text-sm max-sm:h-11">
          <Switch
            checked={f.required}
            onCheckedChange={(required) => onChange({ required })}
            aria-label={`${name} is required`}
            data-testid="field-required"
          />
          <span aria-hidden>Required</span>
        </span>
      </div>
      <RowActions noun="field" index={i} count={count} onMove={onMove} onRemove={onRemove} />
      {f.type === "select" ? (
        <div className="grid gap-2 sm:col-span-4 sm:pl-3" data-testid="field-options">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">Options</span>
            {f.options.map((o) => (
              <span
                key={o}
                className="inline-flex h-7 items-center gap-1 rounded-md border bg-muted/40 pr-0.5 pl-2 text-sm max-sm:h-9"
              >
                {o}
                <button
                  type="button"
                  aria-label={`Remove option ${o}`}
                  onClick={() => onChange({ options: f.options.filter((x) => x !== o) })}
                  className="relative inline-flex size-6 items-center justify-center rounded text-muted-foreground outline-none after:absolute after:-inset-2 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <Input
                aria-label={`New option for ${name}`}
                placeholder="Add option"
                maxLength={60}
                value={option}
                onChange={(e) => setOption(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOption();
                  }
                }}
                aria-invalid={!!optionsError}
                className="h-8 w-32 max-sm:h-11"
                data-testid="option-input"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="max-sm:h-11"
                onClick={addOption}
                data-testid="add-option"
              >
                <Plus /> Add option
              </Button>
            </span>
          </div>
          {optionsError ? (
            <p role="alert" className="text-[13px] text-destructive">
              {optionsError}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ColumnRow({
  column: c,
  index: i,
  count,
  error,
  onChange,
  onMove,
  onRemove,
}: {
  column: ColumnDraft;
  index: number;
  count: number;
  error: string | undefined;
  onChange: (patch: Partial<ColumnDraft>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const nameId = `column-${c.id}-name`;
  const name = c.name.trim() || `Column ${i + 1}`;
  return (
    <li
      data-testid="template-column-row"
      className={cn(rowClass, "sm:grid-cols-[minmax(0,1fr)_8.5rem_12rem_auto] sm:gap-x-2")}
    >
      <div className="grid min-w-0 gap-1">
        <Input
          id={nameId}
          aria-label={`Column ${i + 1} name`}
          placeholder="e.g. Waiting for parts"
          maxLength={60}
          value={c.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-invalid={!!error}
          aria-describedby={describedBy(nameId, error)}
          data-testid="column-name"
          className="max-sm:h-11"
        />
        {error ? (
          <p id={`${nameId}-error`} role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 sm:contents">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <CategoryIcon
            category={c.category}
            decorative
            className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2"
          />
          <Select
            items={CATEGORIES.map((k) => ({ value: k, label: CATEGORY[k].label }))}
            value={c.category}
            onValueChange={(v) => v && onChange({ category: v as BoardColumnCategory })}
          >
            <SelectTrigger
              aria-label={`Category of ${name}`}
              data-testid="column-category"
              className="pl-9 max-sm:h-11"
            />
            <SelectContent>
              {CATEGORIES.map((k) => (
                <SelectItem key={k} value={k}>
                  <span className="flex items-center gap-2">
                    <CategoryIcon category={k} decorative />
                    {CATEGORY[k].label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 flex-1 sm:flex-none">
          <Select
            items={ENTER_OPTIONS}
            value={c.defaultWaitingOn ?? KEEP}
            onValueChange={(v) => v && onChange({ defaultWaitingOn: v === KEEP ? null : (v as WaitingOn) })}
          >
            <SelectTrigger
              aria-label={`When a card enters ${name}`}
              data-testid="column-enter"
              className="max-sm:h-11"
            />
            <SelectContent>
              {ENTER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <RowActions
        noun="column"
        index={i}
        count={count}
        onMove={onMove}
        onRemove={onRemove}
        canRemove={count > 1}
      />
    </li>
  );
}
