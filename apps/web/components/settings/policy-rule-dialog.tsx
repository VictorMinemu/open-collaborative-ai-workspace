"use client";

import type { ToolApprovalMode, ToolApprovalPolicyPage, ToolApproverKind } from "@ocw/contracts";
import { TOOL_APPROVAL_LIMITS } from "@ocw/contracts";
import { CircleDashed, Hand, Info, RefreshCw, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { type ReactNode, type RefObject, useId, useMemo, useRef, useState } from "react";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog as PlainDialog,
  DialogContent as PlainDialogContent,
  DialogDescription as PlainDialogDescription,
  DialogFooter as PlainDialogFooter,
  DialogHeader as PlainDialogHeader,
  DialogTitle as PlainDialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import {
  effectiveRowMode,
  inheritedReason,
  isWeaker,
  MODE_LABEL,
  normalizeDraft,
  type PolicyDraft,
  type RowMode,
  useRemoveApprovalPolicy,
  useSaveApprovalPolicy,
} from "@/lib/approval-policy-queries";
import { useMembers } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** 44 px controls below 1024 (UI-SPEC: every control in this phase). */
const TOUCH = "max-lg:h-11";
/**
 * Initials in the foreground colour on the avatar's tint: the shared tones measure 4.3-4.5:1 at 12 px, under AA,
 * depending on the person's seed (07.5-09 broken window); the tint still tells people apart.
 */
export const AVATAR_AA = "*:text-foreground";

const MODES: ReadonlyArray<{ value: ToolApprovalMode; hint: string }> = [
  { value: "never", hint: "Bots run it without asking. Other limits still apply." },
  {
    value: "when_tainted",
    hint: "Bots ask first only if they read web pages, files or tool results earlier in the same turn.",
  },
  { value: "always", hint: "Bots ask a person every time, with the exact values." },
];

/** What the dialog edits: one tool, or every tool of one server (`<safe>__*`). */
export interface PolicyRuleTarget {
  pattern: string;
  /** "create_invoice" or "all Acme CRM tools" (after "Approval for"). */
  title: string;
  /** "Acme CRM", "Plugins", "Web requests". */
  sourceName: string;
}

export interface Person {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** The draft the dialog opens with: the row's effective values (an upper rule's when it has none of its own). */
export function initialDraft(row: RowMode, unitScope: boolean): PolicyDraft {
  const carrier = row.own ?? row.policy;
  if (!carrier) return { mode: "never", approverKind: "requester", approverUserIds: [] };
  // "Leads of {unit}" only exists on a unit scope.
  const kind: ToolApproverKind =
    !unitScope && carrier.approverKind === "unit_leads" ? "admins" : carrier.approverKind;
  return normalizeDraft({
    mode: carrier.mode,
    approverKind: kind,
    approverUserIds: [...carrier.approverUserIds],
  });
}

const sameDraft = (a: PolicyDraft, b: PolicyDraft) => {
  const x = normalizeDraft(a);
  const y = normalizeDraft(b);
  return (
    x.mode === y.mode &&
    x.approverKind === y.approverKind &&
    [...x.approverUserIds].sort().join() === [...y.approverUserIds].sort().join()
  );
};

/**
 * Settings › Approval policies rule dialog (`PolicyRuleDialog`, UI-SPEC Surface 4): When to ask, Who approves, the
 * people picker, Save rule / Cancel / Remove rule. Options weaker than an upper rule are disabled with the reason
 * (P-04); the API refuses them anyway (409 `policy_weaker_than_inherited`). A stale save shows the conflict notice
 * with Reload (409 `policy_version_conflict`).
 */
export function PolicyRuleDialog({
  target,
  page,
  onClose,
  onDone,
  finalFocus,
  onReload,
}: {
  target: PolicyRuleTarget | null;
  page: ToolApprovalPolicyPage;
  onClose: () => void;
  /** After a save or a removal, with the toast text ("Rule saved", "Rule removed"). */
  onDone: (message: string) => void;
  finalFocus: RefObject<HTMLElement | null>;
  /** Refetches the page (the conflict notice's Reload). */
  onReload: () => Promise<unknown>;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      {target ? (
        <PolicyRuleForm
          key={target.pattern}
          target={target}
          page={page}
          onClose={onClose}
          onDone={onDone}
          finalFocus={finalFocus}
          onReload={onReload}
        />
      ) : null}
    </Dialog>
  );
}

function PolicyRuleForm({
  target,
  page,
  onClose,
  onDone,
  finalFocus,
  onReload,
}: {
  target: PolicyRuleTarget;
  page: ToolApprovalPolicyPage;
  onClose: () => void;
  onDone: (message: string) => void;
  finalFocus: RefObject<HTMLElement | null>;
  onReload: () => Promise<unknown>;
}) {
  const unitName = page.scope.unitId ? page.scope.label : null;
  const row = effectiveRowMode(page, target.pattern);
  const [base, setBase] = useState<PolicyDraft>(() => initialDraft(row, unitName !== null));
  const [draft, setDraft] = useState<PolicyDraft>(base);
  const [error, setError] = useState<{ conflict: boolean; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [reloading, setReloading] = useState(false);
  const save = useSaveApprovalPolicy();
  const remove = useRemoveApprovalPolicy();
  const members = useMembers();
  const firstRadio = useRef<HTMLInputElement | null>(null);
  const people: Person[] = useMemo(
    () =>
      (members.data?.members ?? [])
        .filter((m) => m.status === "active")
        .map((m) => ({ userId: m.userId, displayName: m.displayName, avatarUrl: m.avatarUrl }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [members.data],
  );

  const changed = !sameDraft(draft, base);
  const needsPeople =
    draft.mode !== "never" && draft.approverKind === "users" && draft.approverUserIds.length === 0;
  const fallback = effectiveRowMode(page, target.pattern, { withoutOwn: true });
  const subject = target.pattern.endsWith("__*") ? `All ${target.sourceName} tools` : target.title;

  function onFailure(err: unknown) {
    const conflict =
      isApiError(err, 409) && (err.code === "policy_version_conflict" || err.code === "policy_exists");
    setError({
      conflict,
      message: conflict
        ? "Someone changed this rule while you were editing. Reload to see it."
        : errorMessage(err),
    });
  }

  function submit() {
    setError(null);
    save.mutate(
      { scopeUnitId: page.scope.unitId, toolPattern: target.pattern, existing: row.own, draft },
      { onSuccess: () => onDone("Rule saved"), onError: onFailure },
    );
  }

  function removeRule() {
    if (!row.own) return;
    remove.mutate(row.own, {
      onSuccess: () => {
        setConfirmRemove(false);
        onDone("Rule removed");
      },
      onError: (err) => {
        setConfirmRemove(false);
        onFailure(err);
      },
    });
  }

  async function reload() {
    setReloading(true);
    try {
      const next = (await onReload()) as { data?: ToolApprovalPolicyPage } | undefined;
      const fresh = next?.data ?? page;
      const d = initialDraft(effectiveRowMode(fresh, target.pattern), unitName !== null);
      setBase(d);
      setDraft(d);
      setError(null);
    } finally {
      setReloading(false);
    }
  }

  return (
    <DialogContent
      data-testid="policy-dialog"
      className="sm:max-w-lg max-sm:top-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none"
      initialFocus={firstRadio}
      finalFocus={finalFocus}
    >
      <DialogHeader>
        <DialogTitle className="break-words">Approval for {target.title}</DialogTitle>
        <DialogDescription className="text-xs">
          {target.sourceName} · {unitName ? `Applies in ${unitName} and its teams` : "Applies to everyone"}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid flex-1 content-start gap-5">
        <PolicyRuleFields
          draft={draft}
          onChange={(d) => {
            setDraft(d);
            setError(null);
          }}
          unitName={unitName}
          inheritedMode={row.inheritedMode}
          inheritedScopeLabel={row.inheritedScopeLabel}
          people={people}
          peopleLoading={members.isPending}
          firstRadio={firstRadio}
        />
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-sm dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
            data-testid="policy-error"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{error.message}</span>
            {error.conflict ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void reload()}
                disabled={reloading}
                className={TOUCH}
                data-testid="policy-reload"
              >
                {reloading ? <Spinner className="size-3.5" /> : <RefreshCw />}
                Reload
              </Button>
            ) : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {row.own ? (
          <Button
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
            className={cn("text-red-700 hover:text-red-800 sm:mr-auto dark:text-red-300", TOUCH)}
            data-testid="policy-remove"
          >
            <Trash2 /> Remove rule
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose} className={TOUCH}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={!changed || needsPeople || save.isPending}
          className={TOUCH}
          data-testid="policy-save"
        >
          {save.isPending ? <Spinner className="size-3.5" /> : null}
          Save rule
        </Button>
      </DialogFooter>

      <RemoveRuleDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        subject={subject}
        fallback={MODE_LABEL[fallback.mode]}
        pending={remove.isPending}
        onConfirm={removeRule}
      />
    </DialogContent>
  );
}

function RemoveRuleDialog({
  open,
  onOpenChange,
  subject,
  fallback,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: string;
  fallback: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  const plural = subject.startsWith("All ") && subject.endsWith(" tools");
  return (
    <PlainDialog open={open} onOpenChange={onOpenChange}>
      <PlainDialogContent data-testid="policy-remove-dialog" initialFocus={cancel}>
        <PlainDialogHeader>
          <PlainDialogTitle>Remove this rule?</PlainDialogTitle>
          <PlainDialogDescription>
            {subject} {plural ? "go" : "goes"} back to {fallback}.
          </PlainDialogDescription>
        </PlainDialogHeader>
        <PlainDialogFooter>
          <Button variant="outline" ref={cancel} onClick={() => onOpenChange(false)} className={TOUCH}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
            className={TOUCH}
            data-testid="policy-remove-confirm"
          >
            {pending ? <Spinner className="size-3.5" /> : null}
            Remove rule
          </Button>
        </PlainDialogFooter>
      </PlainDialogContent>
    </PlainDialog>
  );
}

/**
 * The two fieldsets of the rule dialog, rendered from props only (static markup tests): When to ask (weaker options
 * disabled under an upper rule, with the reason) and Who approves (disabled while Never ask is selected; "Leads of
 * {unit}" only on a unit scope; Specific people with search, chips and the "{n} of 20" counter).
 */
export function PolicyRuleFields({
  draft,
  onChange,
  unitName,
  inheritedMode,
  inheritedScopeLabel,
  people,
  peopleLoading,
  firstRadio,
}: {
  draft: PolicyDraft;
  onChange: (d: PolicyDraft) => void;
  /** null on the organization scope. */
  unitName: string | null;
  inheritedMode: ToolApprovalMode;
  inheritedScopeLabel: string | null;
  people: readonly Person[];
  peopleLoading: boolean;
  firstRadio?: RefObject<HTMLInputElement | null>;
}) {
  const uid = useId();
  const never = draft.mode === "never";
  const reason = inheritedReason(inheritedMode, inheritedScopeLabel);
  // Initial focus: the selected option, or the first one an upper rule leaves available.
  const focusMode = isWeaker(draft.mode, inheritedMode)
    ? MODES.find((m) => !isWeaker(m.value, inheritedMode))?.value
    : draft.mode;
  const approvers: ReadonlyArray<{ value: ToolApproverKind; label: string; hint?: string }> = [
    {
      value: "requester",
      label: "The person who asked",
      hint: "They see the exact action and approve it themselves.",
    },
    ...(unitName ? [{ value: "unit_leads" as const, label: `Leads of ${unitName}` }] : []),
    { value: "admins", label: "Admins" },
    { value: "users", label: "Specific people" },
  ];
  const approverReasonId = `${uid}-approvers-reason`;

  return (
    <>
      <fieldset className="grid gap-2">
        <legend className="mb-2 font-semibold text-sm">When to ask</legend>
        {MODES.map((m) => {
          const disabled = isWeaker(m.value, inheritedMode);
          const reasonId = `${uid}-mode-${m.value}-reason`;
          return (
            <OptionLabel
              key={m.value}
              selected={draft.mode === m.value}
              disabled={disabled}
              testId={`policy-mode-${m.value}`}
              input={
                <input
                  ref={m.value === focusMode ? firstRadio : undefined}
                  type="radio"
                  name={`${uid}-mode`}
                  value={m.value}
                  checked={draft.mode === m.value}
                  disabled={disabled}
                  aria-describedby={disabled ? reasonId : undefined}
                  onChange={() =>
                    onChange(
                      m.value === "never"
                        ? { mode: "never", approverKind: "requester", approverUserIds: [] }
                        : { ...draft, mode: m.value },
                    )
                  }
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
              }
              title={
                <span className="inline-flex items-center gap-1.5">
                  <ModeIcon mode={m.value} />
                  {MODE_LABEL[m.value]}
                </span>
              }
              hint={m.hint}
              reason={disabled ? { id: reasonId, text: reason } : null}
            />
          );
        })}
      </fieldset>

      <fieldset
        className="grid gap-2"
        disabled={never}
        aria-describedby={never ? approverReasonId : undefined}
        data-testid="policy-approvers"
      >
        <legend className="mb-2 font-semibold text-sm">Who approves</legend>
        {never ? (
          <p id={approverReasonId} className="-mt-1 text-muted-foreground text-xs">
            No one approves when bots never ask.
          </p>
        ) : null}
        {approvers.map((a) => (
          <OptionLabel
            key={a.value}
            selected={!never && draft.approverKind === a.value}
            disabled={never}
            testId={`policy-approvers-${a.value}`}
            input={
              <input
                type="radio"
                name={`${uid}-approvers`}
                value={a.value}
                checked={!never && draft.approverKind === a.value}
                onChange={() => onChange({ ...draft, approverKind: a.value })}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
            }
            title={a.label}
            hint={a.hint}
            reason={null}
          >
            {a.value === "users" && !never && draft.approverKind === "users" ? (
              <PeoplePicker
                selected={draft.approverUserIds}
                onChange={(ids) => onChange({ ...draft, approverUserIds: ids })}
                people={people}
                loading={peopleLoading}
              />
            ) : null}
          </OptionLabel>
        ))}
      </fieldset>

      {!never && draft.approverKind !== "requester" ? (
        <p className="flex items-start gap-1.5 text-muted-foreground text-xs" data-testid="policy-four-eyes">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          The person who asked can't approve their own request.
        </p>
      ) : null}
    </>
  );
}

export function ModeIcon({ mode, className }: { mode: ToolApprovalMode; className?: string }) {
  const Icon = mode === "always" ? Hand : mode === "when_tainted" ? TriangleAlert : CircleDashed;
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />;
}

/** A bordered radio label (the `mcp-server-dialog` native-input pattern); `children` sit under it (people picker). */
function OptionLabel({
  selected,
  disabled,
  testId,
  input,
  title,
  hint,
  reason,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  testId: string;
  input: ReactNode;
  title: ReactNode;
  hint?: string;
  reason: { id: string; text: string } | null;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card transition-colors",
        selected && "border-primary bg-primary/5",
        disabled && "bg-muted/30",
      )}
    >
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the native radio is passed in as `input` and rendered inside */}
      <label
        className={cn(
          "flex min-h-11 cursor-pointer items-start gap-3 px-3 py-2.5",
          disabled && "cursor-not-allowed",
        )}
        data-testid={testId}
      >
        {input}
        <span className="min-w-0">
          <span className={cn("block font-medium text-sm", disabled && "text-muted-foreground")}>
            {title}
          </span>
          {hint ? <span className="block text-muted-foreground text-xs leading-snug">{hint}</span> : null}
          {reason ? (
            <span
              id={reason.id}
              className="mt-0.5 block text-amber-800 text-xs leading-snug dark:text-amber-300"
            >
              {reason.text}
            </span>
          ) : null}
        </span>
      </label>
      {children}
    </div>
  );
}

/** Members only (never bots): search, check up to 20, the checked ones as removable chips above the list. */
function PeoplePicker({
  selected,
  onChange,
  people,
  loading,
}: {
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  people: readonly Person[];
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const max = TOOL_APPROVAL_LIMITS.approverUsersMax;
  const byId = new Map(people.map((p) => [p.userId, p]));
  const q = query.trim().toLowerCase();
  const shown = people.filter((p) => !q || p.displayName.toLowerCase().includes(q));
  const full = selected.length >= max;
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id));

  return (
    // On the plain background, not the selected option's tint: the avatar tones are AA on it.
    <div
      className="grid gap-2 rounded-b-lg border-t bg-background px-3 pt-2.5 pb-3"
      data-testid="policy-people"
    >
      {selected.length > 0 ? (
        <ul aria-label="Selected people" className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const p = byId.get(id);
            const name = p?.displayName ?? "Former member";
            return (
              <li
                key={id}
                className="inline-flex items-center gap-1 rounded-full border bg-background py-0.5 pr-0.5 pl-1 text-xs"
                data-testid="policy-person-chip"
              >
                <UserAvatar
                  name={name}
                  src={p?.avatarUrl}
                  seed={id}
                  className={cn("size-4 *:font-semibold *:text-[7px]", AVATAR_AA)}
                />
                <span className="max-w-40 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => toggle(id, false)}
                  className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-lg:size-11 max-lg:-my-2.5"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Search people"
            aria-label="Search people"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={cn("pl-9", TOUCH)}
            data-testid="policy-people-search"
          />
        </div>
        <span
          className="shrink-0 text-muted-foreground text-xs tabular-nums"
          data-testid="policy-people-count"
        >
          {selected.length} of {max}
        </span>
      </div>
      {loading ? (
        <p className="px-1 py-3 text-muted-foreground text-xs">Loading people…</p>
      ) : shown.length === 0 ? (
        <p className="px-1 py-3 text-muted-foreground text-xs">No people match “{query.trim()}”.</p>
      ) : (
        <div
          role="group"
          aria-label="People"
          className="scrollbar-thin -mx-1 grid max-h-60 overflow-y-auto px-1"
        >
          {shown.map((p) => {
            const checked = selected.includes(p.userId);
            return (
              <label
                key={p.userId}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/60",
                  !checked && full && "cursor-not-allowed",
                )}
                data-testid="policy-person"
                data-name={p.displayName}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && full}
                  onChange={(e) => toggle(p.userId, e.target.checked)}
                  className="size-4 shrink-0 accent-primary"
                />
                <UserAvatar
                  name={p.displayName}
                  src={p.avatarUrl}
                  seed={p.userId}
                  className={cn("size-6 *:text-[10px]", AVATAR_AA)}
                />
                <span className="min-w-0 truncate text-sm">{p.displayName}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
