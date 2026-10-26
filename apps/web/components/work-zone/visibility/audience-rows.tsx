"use client";

import type { SessionVisibilityKind } from "@ocw/contracts";
import { FolderKanban, Info, Lock, type LucideIcon, UserRound, Users } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useRef } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type ChoiceLine, PANEL_TITLE } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";

export const CHOICES = [
  "owner",
  "project",
  "teams",
  "people",
] as const satisfies readonly SessionVisibilityKind[];

/** The chip's and the rows' icons (UI-SPEC Design System): never coloured (N5). */
export const CHOICE_ICON: Record<SessionVisibilityKind, LucideIcon> = {
  owner: Lock,
  project: FolderKanban,
  teams: Users,
  people: UserRound,
};

export type ChoiceLines = {
  owner: ChoiceLine;
  project: ChoiceLine;
  teams: ChoiceLine & { disabled: boolean };
  people: ChoiceLine;
};

/**
 * The four choices (UI-SPEC §1.2): a fieldset of native radios, each row a label with its one-line explanation and
 * "Default" on the project's default. Always the same four, in the same order; Teams is disabled (never hidden) when
 * there are no teams to pick. The picker of the chosen Teams / People row renders right under it. `onChoose` says
 * whether the change came from an arrow key (the panel waits 400 ms before saving it, §Interaction) or not.
 */
export function AudienceRows({
  choice,
  lines,
  defaultKind,
  busy,
  sheet,
  onChoose,
  pickers,
  assignTeamsHref,
}: {
  choice: SessionVisibilityKind;
  lines: ChoiceLines;
  /** The choice new sessions of this project start with ("Default"). */
  defaultKind: SessionVisibilityKind;
  /** A choice whose change is being saved (its icon becomes a spinner). */
  busy: SessionVisibilityKind | null;
  sheet: boolean;
  onChoose: (kind: SessionVisibilityKind, viaArrow: boolean) => void;
  pickers: Partial<Record<"teams" | "people", ReactNode>>;
  /** Editors of a team project without teams get a way to assign some. */
  assignTeamsHref: string | null;
}) {
  const name = useId();
  const arrow = useRef(false);
  return (
    <fieldset
      data-testid="visibility-choices"
      className="grid min-w-0 gap-px px-0 py-1"
      onKeyDown={(e) => {
        arrow.current = e.key.startsWith("Arrow");
      }}
      onPointerDown={() => {
        arrow.current = false;
      }}
    >
      <legend className="sr-only">{PANEL_TITLE}</legend>
      {CHOICES.map((kind) => {
        const line = lines[kind];
        const disabled = kind === "teams" && lines.teams.disabled;
        const Icon = CHOICE_ICON[kind];
        const checked = choice === kind;
        const picker = kind === "teams" || kind === "people" ? pickers[kind] : null;
        return (
          <div key={kind} className="min-w-0">
            <label
              data-testid={`visibility-option-${kind}`}
              data-checked={checked}
              className={cn(
                "grid min-w-0 cursor-pointer grid-cols-[16px_16px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg px-4 transition-colors hover:bg-accent/60 has-[:focus-visible]:bg-accent/60",
                sheet ? "min-h-14 py-2.5" : "min-h-11 py-2",
                disabled && "cursor-default hover:bg-transparent",
              )}
            >
              <input
                type="radio"
                name={name}
                value={kind}
                checked={checked}
                disabled={disabled}
                aria-labelledby={`${name}-${kind}-label`}
                aria-describedby={`${name}-${kind}-line`}
                onChange={() => {
                  const viaArrow = arrow.current;
                  arrow.current = false;
                  onChoose(kind, viaArrow);
                }}
                className="mt-0.5 size-4 accent-primary"
              />
              {busy === kind ? (
                <Spinner className="mt-0.5 size-3 text-muted-foreground" />
              ) : (
                <Icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
              )}
              <span className="grid min-w-0">
                <span
                  id={`${name}-${kind}-label`}
                  className={cn("font-semibold text-sm leading-5", disabled && "text-muted-foreground")}
                >
                  {line.label}
                </span>
                <span
                  id={`${name}-${kind}-line`}
                  title={line.line}
                  className="truncate text-muted-foreground text-xs leading-4"
                >
                  {line.line}
                </span>
              </span>
              {defaultKind === kind ? (
                <span className="pt-0.5 text-muted-foreground text-xs leading-4">Default</span>
              ) : (
                <span />
              )}
            </label>
            {kind === "teams" && disabled && assignTeamsHref ? (
              <div className="pr-4 pb-1 pl-16">
                <Link
                  href={assignTeamsHref}
                  className={cn(buttonVariants({ variant: "link", size: "sm" }), "h-8 text-xs max-md:h-11")}
                >
                  Assign teams
                </Link>
              </div>
            ) : null}
            {checked && picker ? picker : null}
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The read-only panel's one row (UI-SPEC §1.4): only the current choice, as plain text (no radio: nothing that looks
 * clickable and is not, N1), the names it lists, then who may change it.
 */
export function CurrentChoice({
  kind,
  line,
  names,
  note,
}: {
  kind: SessionVisibilityKind;
  line: ChoiceLine;
  names: ReactNode;
  note: string;
}) {
  const Icon = CHOICE_ICON[kind];
  return (
    <div className="grid gap-1 py-1">
      <div
        data-testid="visibility-current"
        data-kind={kind}
        className="grid min-h-11 min-w-0 grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2 px-4 py-2"
      >
        <Icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
        <span className="grid min-w-0">
          <span className="font-semibold text-sm leading-5">{line.label}</span>
          <span title={line.line} className="truncate text-muted-foreground text-xs leading-4">
            {line.line}
          </span>
          {names ? <span className="pt-1.5">{names}</span> : null}
        </span>
      </div>
      <p
        data-testid="visibility-readonly-note"
        className="flex items-start gap-1.5 px-4 pb-2 text-muted-foreground text-xs leading-4"
      >
        <Info aria-hidden className="size-3.5 shrink-0" />
        <span>{note}</span>
      </p>
    </div>
  );
}
