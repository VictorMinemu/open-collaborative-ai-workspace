"use client";

import { X } from "lucide-react";
import { KindIcon } from "@/components/organization/unit-meta";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { inactiveLine, memberCount, PICK_TEAM_HINT } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";

export interface PickerTeam {
  id: string;
  name: string;
  kind: "team" | "department";
  memberCount: number;
  /** Still assigned to the project (an unassigned team stays stored but grants nothing, §1.5). */
  active: boolean;
}

/**
 * The Teams picker (UI-SPEC §1.3), under the Teams row: a checkbox list of the project's assigned teams (no search: a
 * project has few teams), each with its size. Every check applies at once (the panel saves it); nothing checked yet
 * shows the hint and saves nothing. A stored team that is no longer assigned shows greyed with its reason and a
 * remove button, and never counts.
 */
export function TeamPicker({
  teams,
  checked,
  projectName,
  busy,
  sheet,
  onToggle,
}: {
  teams: readonly PickerTeam[];
  checked: ReadonlySet<string>;
  projectName: string;
  /** The team whose change is being saved. */
  busy: string | null;
  sheet: boolean;
  onToggle: (teamId: string) => void;
}) {
  const active = teams.filter((t) => t.active);
  const stale = teams.filter((t) => !t.active && checked.has(t.id));
  const none = active.every((t) => !checked.has(t.id));
  return (
    <fieldset data-testid="team-picker" className="grid min-w-0 gap-px pr-4 pb-2 pl-16">
      <legend className="sr-only">Teams who can see it</legend>
      {active.map((t) => (
        <label
          key={t.id}
          data-testid={`team-option-${t.id}`}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-accent/60 has-[:focus-visible]:bg-accent/60",
            sheet ? "min-h-11" : "min-h-11 md:min-h-9",
          )}
        >
          <input
            type="checkbox"
            checked={checked.has(t.id)}
            onChange={() => onToggle(t.id)}
            aria-label={`${t.name}, ${memberCount(t.memberCount)}`}
            className="size-4 shrink-0 accent-primary"
          />
          {busy === t.id ? (
            <span className="flex size-6 shrink-0 items-center justify-center">
              <Spinner className="size-3 text-muted-foreground" />
            </span>
          ) : (
            <KindIcon kind={t.kind} size="sm" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm" title={t.name}>
            {t.name}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">{memberCount(t.memberCount)}</span>
        </label>
      ))}
      {stale.map((t) => (
        <div
          key={t.id}
          data-testid="visibility-inactive"
          data-team-id={t.id}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-1.5 md:min-h-9"
        >
          <KindIcon kind={t.kind} size="sm" className="opacity-50 grayscale" />
          <span className="grid min-w-0 flex-1 leading-tight">
            <span
              className="truncate text-muted-foreground text-sm line-through decoration-muted-foreground/40"
              title={t.name}
            >
              {t.name}
            </span>
            <span className="truncate text-muted-foreground text-xs">
              {inactiveLine("team", projectName)}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${t.name}`}
            onClick={() => onToggle(t.id)}
            className="text-muted-foreground max-md:size-11"
          >
            {busy === t.id ? <Spinner className="size-3" /> : <X />}
          </Button>
        </div>
      ))}
      {none ? <p className="px-1.5 pt-1 text-muted-foreground text-xs">{PICK_TEAM_HINT}</p> : null}
    </fieldset>
  );
}
