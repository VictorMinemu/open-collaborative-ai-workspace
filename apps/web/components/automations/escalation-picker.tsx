"use client";

import {
  type EscalationTarget,
  type EscalationTargetView,
  FAN_OUT_LIMITS,
  type Member,
  type OrgUnit,
  userHandle,
} from "@ocw/contracts";
import { Search, X } from "lucide-react";
import { useId, useState } from "react";
import { KIND_META, KindIcon } from "@/components/organization/unit-meta";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One row of the picker: a person (avatar, name, `@handle`) or a team or department (icon, name, handle, reach). */
export interface EscalationOption extends EscalationTargetView {
  avatarUrl: string | null;
  unitKind: "team" | "department" | null;
  /** "Team · 6" / "Department · 24"; null for people. */
  caption: string | null;
}

export interface EscalationOptions {
  people: EscalationOption[];
  teams: EscalationOption[];
}

const PEOPLE_SHOWN = 8;
const TEAMS_SHOWN = 6;

/**
 * Who the bot may mention (D-08, PD-15): active members, and teams and departments (never projects, which are not
 * mentionable). The API decides at save who really qualifies (`escalation_not_allowed`); this only lists and filters.
 */
export function escalationOptions(
  members: readonly Member[],
  units: readonly OrgUnit[],
  opts: {
    q?: string;
    exclude?: readonly Pick<EscalationTarget, "kind" | "id">[];
    /** Handles bots hold (code review WR-04): a team under one of these, or under a person's, is not offered. */
    takenHandles?: ReadonlySet<string>;
  } = {},
): EscalationOptions {
  const needle = (opts.q ?? "").trim().toLowerCase().replace(/^@/, "");
  const taken = new Set((opts.exclude ?? []).map((t) => `${t.kind}:${t.id}`));
  const hit = (...fields: (string | null | undefined)[]) =>
    !needle || fields.some((f) => (f ?? "").toLowerCase().includes(needle));
  const people = members
    .filter((m) => m.status === "active" && !taken.has(`user:${m.userId}`))
    .map((m): EscalationOption & { email: string | null } => ({
      kind: "user",
      id: m.userId,
      handle: userHandle(m),
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      unitKind: null,
      caption: null,
      email: m.email,
    }))
    .filter((p) => hit(p.displayName, p.handle, p.email))
    .slice(0, PEOPLE_SHOWN)
    .map(({ email: _email, ...p }) => p);
  // WR-04: agents, then users, then units hold a handle (ADR-0039 § 10); a shadowed team would name someone else.
  const shadowing = new Set([...(opts.takenHandles ?? []), ...members.map((m) => userHandle(m))]);
  const teams = units
    .filter(
      (u): u is OrgUnit & { kind: "team" | "department" } =>
        (u.kind === "team" || u.kind === "department") &&
        !taken.has(`unit:${u.id}`) &&
        !shadowing.has(u.handle ?? ""),
    )
    .filter((u) => hit(u.name, u.handle))
    .slice(0, TEAMS_SHOWN)
    .map(
      (u): EscalationOption => ({
        kind: "unit",
        id: u.id,
        handle: u.handle ?? "",
        displayName: u.name,
        avatarUrl: null,
        unitKind: u.kind,
        caption: `${KIND_META[u.kind].label} · ${u.reach ?? u.memberCount}`,
      }),
    );
  return { people, teams };
}

/** The `escalation` a save sends (PD-15): ids in chip order; a new automation only when some are chosen, an existing
 * one only when the list changed (`[]` clears it). */
export function escalationForSave(p: {
  value: readonly EscalationTargetView[];
  initial: readonly EscalationTargetView[] | null;
}): EscalationTarget[] | undefined {
  const ids = p.value.map((t) => ({ kind: t.kind, id: t.id }));
  if (!p.initial) return ids.length > 0 ? ids : undefined;
  const key = (ts: readonly Pick<EscalationTarget, "kind" | "id">[]) =>
    ts.map((t) => `${t.kind}:${t.id}`).join(",");
  return key(ids) === key(p.initial) ? undefined : ids;
}

function OptionIcon({
  o,
  className,
}: {
  o: Pick<EscalationOption, "id" | "displayName" | "avatarUrl" | "unitKind">;
  className?: string;
}) {
  return o.unitKind ? (
    <KindIcon kind={o.unitKind} className={cn("size-6 rounded-full", className)} />
  ) : (
    <UserAvatar
      name={o.displayName}
      src={o.avatarUrl}
      seed={o.id}
      className={cn("size-6 text-[10px]", className)}
    />
  );
}

/** The grouped option list (People, then Teams), rendered inline under the field so nothing clips in the sheet. */
export function EscalationOptionList({
  listId,
  options,
  active,
  onPick,
  onActive,
}: {
  listId: string;
  options: EscalationOptions;
  active: number;
  onPick: (o: EscalationOption) => void;
  onActive: (i: number) => void;
}) {
  const flat = [...options.people, ...options.teams];
  const row = (o: EscalationOption) => {
    const i = flat.indexOf(o);
    return (
      <button
        key={`${o.kind}:${o.id}`}
        id={`${listId}-${i}`}
        type="button"
        role="option"
        aria-selected={i === active}
        data-testid="escalation-option"
        data-kind={o.kind}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => onActive(i)}
        onClick={() => onPick(o)}
        className={cn(
          "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-accent md:min-h-9",
          i === active && "bg-accent/70",
        )}
      >
        <OptionIcon o={o} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-sm">{o.displayName}</span>
          {o.handle ? <span className="truncate text-muted-foreground text-xs">@{o.handle}</span> : null}
        </span>
        {o.caption ? (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{o.caption}</span>
        ) : null}
      </button>
    );
  };
  return (
    <div
      id={listId}
      role="listbox"
      aria-label="People and teams"
      className="scrollbar-thin grid max-h-64 gap-px overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground"
    >
      {flat.length === 0 ? (
        <p className="px-2 py-2 text-muted-foreground text-xs">Nobody and no team matches.</p>
      ) : null}
      {options.people.length > 0 ? (
        <div role="group" aria-label="People" className="grid gap-px">
          <p
            aria-hidden
            className="px-2 pt-1.5 pb-1 font-semibold text-[11px] text-muted-foreground uppercase tracking-wider"
          >
            People
          </p>
          {options.people.map(row)}
        </div>
      ) : null}
      {options.teams.length > 0 ? (
        <div role="group" aria-label="Teams" className="grid gap-px">
          <p
            aria-hidden
            className="px-2 pt-1.5 pb-1 font-semibold text-[11px] text-muted-foreground uppercase tracking-wider"
          >
            Teams
          </p>
          {options.teams.map(row)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "When it needs people" (07.17, D-08, PD-15, PD-19): up to five people and teams the bot mentions when it finishes
 * or needs help, as removable chips, and one field searching people and teams. The options open inline under the field
 * (the 07.11 people picker's reason: nothing clips inside the sheet, and a phone's keyboard never covers an overlay).
 * The web never decides who qualifies: `escalation_not_allowed` comes back as `error`.
 */
export function EscalationPicker({
  value,
  onChange,
  members,
  units,
  takenHandles,
  targetName,
  disabled,
  error,
}: {
  value: readonly EscalationTargetView[];
  onChange: (next: EscalationTargetView[]) => void;
  members: readonly Member[];
  units: readonly OrgUnit[];
  /** Handles bots hold (WR-04); absent = none known. */
  takenHandles?: ReadonlySet<string>;
  /** `#orders`, `Fleet`, `your DM`; null while unknown. */
  targetName: string | null;
  disabled?: boolean;
  error?: string | undefined;
}) {
  const listId = useId();
  const fieldId = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const full = value.length >= FAN_OUT_LIMITS.escalationMax;
  const options = escalationOptions(members, units, {
    q,
    exclude: value,
    ...(takenHandles ? { takenHandles } : {}),
  });
  const flat = [...options.people, ...options.teams];
  const showOptions = open && !full && !disabled;
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const hint = targetName
    ? targetName === "your DM"
      ? "Only you can read your DM, so only you get its notification."
      : `They get a notification only if they can read ${targetName}.`
    : "They get a notification only if they can read where it delivers.";

  const pick = (o: EscalationOption) => {
    if (full) return;
    onChange([...value, { kind: o.kind, id: o.id, handle: o.handle, displayName: o.displayName }]);
    setQ("");
    setActive(0);
  };

  return (
    <div className="grid min-w-0 gap-2" data-testid="escalation-picker">
      <label htmlFor={fieldId} className="font-medium text-sm">
        Mention when it finishes or needs help
      </label>
      {value.length > 0 ? (
        <ul aria-label="People and teams to mention" className="flex min-w-0 flex-wrap gap-1.5">
          {value.map((t) => {
            const u = t.kind === "unit" ? unitById.get(t.id) : undefined;
            const m = t.kind === "user" ? memberById.get(t.id) : undefined;
            const unitKind =
              u && (u.kind === "team" || u.kind === "department")
                ? u.kind
                : t.kind === "unit"
                  ? "team"
                  : null;
            return (
              <li
                key={`${t.kind}:${t.id}`}
                data-testid="escalation-chip"
                data-kind={t.kind}
                className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full border bg-muted/60 py-0.5 pr-0.5 pl-1 text-[13px] max-md:h-11"
              >
                <OptionIcon
                  o={{ id: t.id, displayName: t.displayName, avatarUrl: m?.avatarUrl ?? null, unitKind }}
                  className="size-6"
                />
                <span className="truncate" title={t.handle ? `@${t.handle}` : undefined}>
                  {t.displayName}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${t.displayName}`}
                  disabled={disabled}
                  onClick={() => onChange(value.filter((x) => !(x.kind === t.kind && x.id === t.id)))}
                  className="shrink-0 rounded-full text-muted-foreground max-md:size-11"
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-lg border bg-background px-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/25",
          (full || disabled) && "opacity-60",
        )}
      >
        <Search aria-hidden className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
        <input
          id={fieldId}
          data-testid="escalation-add"
          role="combobox"
          aria-expanded={showOptions}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showOptions && flat[active] ? `${listId}-${active}` : undefined}
          aria-label="Add a person or team"
          aria-invalid={!!error}
          aria-describedby={`${fieldId}-${error ? "error" : "hint"}`}
          placeholder={full ? `Up to ${FAN_OUT_LIMITS.escalationMax}` : "Add a person or team"}
          value={q}
          disabled={full || disabled}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={(e) => {
            setOpen(true);
            const el = e.currentTarget;
            window.setTimeout(() => el.scrollIntoView({ block: "nearest" }), 300);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && showOptions) {
              // The first Escape closes the options; the next one reaches the sheet.
              e.stopPropagation();
              setOpen(false);
              return;
            }
            if (!showOptions || flat.length === 0) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (i + step + flat.length) % flat.length);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const o = flat[active] ?? flat[0];
              if (o) pick(o);
            }
          }}
          autoComplete="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed max-md:h-11 max-md:text-base"
        />
      </div>
      {showOptions ? (
        <EscalationOptionList
          listId={listId}
          options={options}
          active={active}
          onPick={pick}
          onActive={setActive}
        />
      ) : null}
      {error ? (
        <p id={`${fieldId}-error`} role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : (
        <p id={`${fieldId}-hint`} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
