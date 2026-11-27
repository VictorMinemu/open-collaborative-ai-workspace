"use client";

import { NAMING_RULE_MAX_CHARS, type WorkProjectDetail } from "@ocw/contracts";
import { Save } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useUpdateWorkProjectNamingRule } from "@/lib/work-project-queries";

/**
 * Session naming rules (07.13.1.1, D-08, PD-16): free text an admin (Settings › Work Zone policy) or a project lead
 * (here) writes, followed by the automatic title generator and shown to the session's agent with its rename tool, the
 * project's after the organization's. Untrusted wording data (T-07.13.1.1-07-03): always plain text through React
 * (`whitespace-pre-wrap`), never markdown or HTML. The device keeps titles at 2 to 5 words and 32 characters whatever
 * a rule says (Pitfall 5), so the helper says so.
 */
export const NAMING_RULE_COPY = {
  section: "Session names",
  label: "Naming rule",
  helper:
    "Used for generated titles and when a session's agent renames it. Titles stay 2 to 5 words and 32 characters.",
  projectHelper: "Added after the organization's rule.",
  placeholder: "For example: start with the area, then the change, like “billing retry failed charges”.",
  none: "No naming rule.",
  tooLong: `Use at most ${NAMING_RULE_MAX_CHARS} characters.`,
  save: "Save rule",
  saved: "Naming rule saved",
  cleared: "Naming rule removed",
} as const;

/** CRLF and CR to LF (the API refuses `\r`), trimmed as the API stores it. */
const normalise = (raw: string) => raw.replace(/\r\n?/g, "\n").trim();

/** What is sent for a draft: the normalised text, or null for a blank one (no rule). */
export function namingRuleValue(raw: string): string | null {
  const v = normalise(raw);
  return v === "" ? null : v;
}

/** The length the API checks (after trimming). */
const ruleLength = (raw: string) => normalise(raw).length;

/** What the API would refuse for its length, refused before sending; null when the draft is fine. */
export function namingRuleError(raw: string): string | null {
  return ruleLength(raw) > NAMING_RULE_MAX_CHARS ? NAMING_RULE_COPY.tooLong : null;
}

/**
 * The textarea with its label, counter, helper and error, shared by the organization's and the project's rule. The
 * label is tied to the field; the helper, the counter and the error describe it.
 */
export function NamingRuleField({
  id,
  value,
  helper,
  error,
  disabled,
  onChange,
  testId,
}: {
  id: string;
  value: string;
  helper: string;
  /** The API's refusal, shown when the draft itself is fine. */
  error?: string | null | undefined;
  disabled?: boolean;
  onChange: (value: string) => void;
  testId?: string;
}) {
  const length = ruleLength(value);
  const problem = namingRuleError(value) ?? error ?? null;
  const describedBy = [`${id}-count`, `${id}-hint`, problem ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-medium text-sm">
          {NAMING_RULE_COPY.label}
        </label>
        <span
          id={`${id}-count`}
          aria-live="polite"
          className={cn(
            "shrink-0 text-muted-foreground text-xs tabular-nums",
            length > NAMING_RULE_MAX_CHARS && "font-medium text-destructive",
          )}
        >
          {length}/{NAMING_RULE_MAX_CHARS}
        </span>
      </div>
      <Textarea
        id={id}
        value={value}
        rows={4}
        disabled={disabled}
        placeholder={NAMING_RULE_COPY.placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problem ? true : undefined}
        aria-describedby={describedBy}
        data-testid={testId}
        spellCheck
        className="min-h-28 resize-y"
      />
      <span id={`${id}-hint`} className="text-muted-foreground text-xs leading-relaxed">
        {helper}
      </span>
      {problem ? (
        <p id={`${id}-error`} role="alert" className="text-[13px] text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The project's rule in its Settings tab: managers edit it (`viewerCan.manage`), everyone else reads it. */
export function ProjectNamingRule({
  project,
}: {
  project: Pick<WorkProjectDetail, "id" | "namingRule" | "viewerCan">;
}) {
  const update = useUpdateWorkProjectNamingRule(project.id);
  return (
    <ProjectNamingRuleBody
      rule={project.namingRule ?? null}
      canManage={project.viewerCan.manage}
      pending={update.isPending}
      error={update.error ? errorMessage(update.error) : null}
      onEdit={() => {
        if (update.error) update.reset();
      }}
      onSave={(namingRule) =>
        update.mutate(namingRule, {
          onSuccess: () =>
            toast.success(namingRule === null ? NAMING_RULE_COPY.cleared : NAMING_RULE_COPY.saved),
        })
      }
    />
  );
}

/** The field over its inputs, so the editable and read-only states render in a unit test. */
export function ProjectNamingRuleBody({
  rule,
  canManage,
  pending,
  error,
  onEdit,
  onSave,
}: {
  rule: string | null;
  canManage: boolean;
  pending: boolean;
  /** The API's refusal of the last save, as worded. */
  error?: string | null | undefined;
  /** The draft changed (the wrapper clears an earlier refusal). */
  onEdit?: () => void;
  onSave: (namingRule: string | null) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(rule ?? "");
  // A save (or another manager's, through the detail refetch) brings a new stored rule: start from it.
  useEffect(() => setDraft(rule ?? ""), [rule]);

  if (!canManage) {
    return (
      <div data-testid="project-naming-rule" className="rounded-xl border bg-card px-4 py-3 shadow-xs">
        <p className="font-semibold text-sm">{NAMING_RULE_COPY.label}</p>
        {rule ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{rule}</p>
        ) : (
          <p className="mt-1 text-muted-foreground text-sm">{NAMING_RULE_COPY.none}</p>
        )}
        <p className="mt-1.5 text-muted-foreground text-xs">{NAMING_RULE_COPY.projectHelper}</p>
      </div>
    );
  }

  const value = namingRuleValue(draft);
  const changed = value !== (rule ?? null);
  const invalid = namingRuleError(draft) !== null;
  return (
    <form
      data-testid="project-naming-rule"
      className="grid gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !invalid && !pending) onSave(value);
      }}
    >
      <NamingRuleField
        id={id}
        value={draft}
        helper={`${NAMING_RULE_COPY.projectHelper} ${NAMING_RULE_COPY.helper}`}
        error={error}
        disabled={pending}
        onChange={(v) => {
          setDraft(v);
          onEdit?.();
        }}
        testId="naming-rule-input"
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {changed ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="max-md:h-11"
            disabled={pending}
            onClick={() => setDraft(rule ?? "")}
          >
            Discard
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          data-testid="naming-rule-save"
          className="max-md:h-11"
          disabled={!changed || invalid || pending}
        >
          {pending ? <Spinner /> : <Save />}
          {NAMING_RULE_COPY.save}
        </Button>
      </div>
    </form>
  );
}
