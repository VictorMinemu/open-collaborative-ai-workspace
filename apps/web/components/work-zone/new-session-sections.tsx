"use client";

import type { Project } from "@ocw/contracts";
import { Check, FolderGit2, FolderKanban, FolderPlus, Laptop, Lock, Server } from "lucide-react";
import Link from "next/link";
import type { KeyboardEvent, ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isStartable, type RepoGroups } from "@/lib/new-session-groups";
import { cn } from "@/lib/utils";
import { OnlineDot } from "./meta";

/**
 * The New session dialog's building blocks (owner feedback 2026-11-06): the Project list, its loading and empty states,
 * the radio-row look shared with the permission modes, and arrow-key movement inside a radio group.
 */

/** D-14: a repository of the caller's device linked to a team project they can't open (the API names no project). */
export const HIDDEN_PROJECT = "Linked to a project you can't open";

/** 44 px tall below 768 (touch), the desktop size above. */
export const TOUCH = "max-md:min-h-11";

/**
 * The next option for an arrow key in a radio group of `count` options (WAI-ARIA radio group): Down/Right forward,
 * Up/Left back, wrapping; Home and End to the ends. `from` -1 = no option has focus. Null for any other key.
 */
export function stepRadio(count: number, from: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return from < 0 ? 0 : (from + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return from < 0 ? count - 1 : (from - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** On a `role="radiogroup"`: arrow keys focus and choose the next enabled option (one tab stop per group). */
export function onRadioGroupKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
  const next = stepRadio(radios.length, radios.indexOf(document.activeElement as HTMLButtonElement), e.key);
  if (next === null) return;
  e.preventDefault();
  radios[next]?.focus();
  radios[next]?.click();
}

/** A row of a radio list: tinted when chosen, a check at the end, an inset focus ring. */
export const radioRowClass = cn(
  "flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors",
  "hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset",
  "disabled:cursor-not-allowed disabled:hover:bg-transparent aria-checked:bg-brand-soft/60 dark:aria-checked:bg-brand-soft/40",
  TOUCH,
);

export function RowCheck({ checked }: { checked: boolean }) {
  return (
    <Check
      aria-hidden
      className={cn("size-4 shrink-0 text-primary transition-opacity", checked ? "opacity-100" : "opacity-0")}
    />
  );
}

/** A group's heading inside the list; `sub` = a device under the Personal heading. */
function GroupHeading({ children, sub = false }: { children: ReactNode; sub?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 px-3 text-muted-foreground text-xs",
        sub ? "bg-card pt-2 pb-1.5" : "bg-muted/70 py-1.5",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Every repository the caller may see, as one radio list (Phase 07.9-14 grouping, D-01, D-14, R5): team projects
 * first (each repository names its device and status), then the repositories linked to a project the caller can't open
 * (disabled, never personal), then Personal by device. One tab stop: the chosen repository, else the first that can
 * start; arrow keys move between them.
 */
export function ProjectList({
  groups,
  selectedId,
  onSelect,
}: {
  groups: RepoGroups;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const all = [...groups.teams.flatMap((g) => g.repos), ...groups.personal.flatMap((g) => g.repos)];
  const selectable = all.filter(isStartable);
  const stop = selectable.some((p) => p.id === selectedId) ? selectedId : (selectable[0]?.id ?? null);
  const personalHeading = groups.personal.length > 0 && (groups.teams.length > 0 || groups.hidden.length > 0);
  const option = (p: Project, showDevice = false) => (
    <RepoOption
      key={p.id}
      project={p}
      selected={p.id === selectedId}
      tabStop={p.id === stop}
      onSelect={onSelect}
      showDevice={showDevice}
    />
  );
  return (
    <div
      role="radiogroup"
      aria-label="Project"
      onKeyDown={onRadioGroupKeyDown}
      className="divide-y overflow-hidden rounded-lg border bg-card"
    >
      {groups.teams.map((g) => (
        <div key={g.project.id} data-testid={`project-group-${g.project.id}`} className="divide-y">
          <GroupHeading>
            <FolderKanban aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate" title={g.project.name}>
              <span className="font-semibold text-foreground">{g.project.name}</span> · Team project
            </span>
          </GroupHeading>
          {g.repos.map((p) => option(p, true))}
        </div>
      ))}
      {groups.hidden.length > 0 ? (
        <div data-testid="project-group-hidden" className="divide-y">
          <GroupHeading>
            <Lock aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{HIDDEN_PROJECT}</span>
          </GroupHeading>
          {groups.hidden.map((p) => (
            <RepoOption
              key={p.id}
              project={p}
              selected={false}
              tabStop={false}
              onSelect={onSelect}
              showDevice
            />
          ))}
        </div>
      ) : null}
      {personalHeading ? (
        <p
          className="bg-muted/70 px-3 py-1.5 font-semibold text-foreground text-xs"
          data-testid="project-group-personal"
        >
          Personal
        </p>
      ) : null}
      {groups.personal.map((g) => (
        <div key={g.deviceId} className="divide-y">
          <GroupHeading sub={personalHeading}>
            <Laptop aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{g.deviceName}</span>
            <OnlineDot online={g.deviceOnline} className="ml-0.5 size-1.5" />
            <span className="shrink-0">{g.deviceOnline ? "Online" : "Offline"}</span>
          </GroupHeading>
          {g.repos.map((p) => option(p))}
        </div>
      ))}
    </div>
  );
}

/**
 * One repository of the Project list. Under a team project its caption also names the device that runs it, with its
 * status (UI-SPEC Surface 3). A repository linked to a project the caller can't open (D-14) is shown, disabled, with
 * the reason; it never reads as personal.
 */
function RepoOption({
  project: p,
  selected,
  tabStop,
  onSelect,
  showDevice = false,
}: {
  project: Project;
  selected: boolean;
  tabStop: boolean;
  onSelect: (id: string) => void;
  showDevice?: boolean;
}) {
  const hidden = p.teamProjectHidden === true;
  const startable = isStartable(p);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabStop ? 0 : -1}
      data-testid={hidden ? "project-option-hidden" : "project-option"}
      disabled={!startable}
      title={hidden ? `${HIDDEN_PROJECT}. Ask one of its leads to add you.` : undefined}
      onClick={() => onSelect(p.id)}
      className={radioRowClass}
    >
      {hidden ? (
        <Lock aria-hidden className="size-4 shrink-0 text-muted-foreground/70" />
      ) : (
        <FolderGit2
          aria-hidden
          className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
        />
      )}
      <span className={cn("grid min-w-0 flex-1 gap-0.5", !startable && "opacity-60")}>
        <span className="truncate font-medium text-sm leading-tight">{p.name}</span>
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
          <span className="shrink-0">{p.defaultBranch ?? "no branch"}</span>
          {showDevice ? (
            <>
              <span className="min-w-0 truncate"> · {p.deviceName}</span>
              <span aria-hidden className="inline-flex shrink-0 px-0.5">
                <OnlineDot online={p.deviceOnline} className="size-1.5" />
              </span>
              <span className="shrink-0">{p.deviceOnline ? "Online" : "Offline"}</span>
            </>
          ) : null}
          {p.gitRemote ? (
            <span title={p.gitRemote} className="min-w-0 shrink-[4] truncate max-sm:hidden">
              {" "}
              · {p.gitRemote}
            </span>
          ) : null}
        </span>
      </span>
      <RowCheck checked={selected} />
    </button>
  );
}

/** While `GET /projects` loads: the list's own frame with placeholder rows, so nothing jumps when it arrives. */
export function ProjectsLoading() {
  return (
    <div
      aria-busy="true"
      data-testid="new-session-projects-loading"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <span className="sr-only">Loading projects</span>
      <div className="border-b bg-muted px-3 py-2">
        <Skeleton className="h-3 w-40 bg-foreground/10" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 border-b px-3 py-3 last:border-b-0">
          <Skeleton className="size-4 rounded-sm" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-52 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * "Run sessions on a server" (07.12-07, owner feedback 2026-10-29): where sessions start, the way to Add a device ›
 * Server. A paired server then shows up here as one more device, like a laptop.
 */
export function AddServerLink({ className, onClick }: { className?: string; onClick?: () => void }) {
  return (
    <Link
      href="/settings/devices?add=server"
      data-testid="new-session-add-server"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm text-muted-foreground text-xs underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 outline-none hover:text-foreground hover:decoration-solid focus-visible:ring-[3px] focus-visible:ring-ring/40 max-lg:min-h-11",
        className,
      )}
    >
      <Server aria-hidden className="size-3.5 shrink-0" />
      Run sessions on a server
    </Link>
  );
}

/**
 * Nothing to start a session on yet, with the way forward: pair a computer (or ask for one when the caller may not
 * pair), or add a repository to a paired one.
 */
export function ProjectsEmpty({
  kind,
  canPair,
  desktop,
  onAddFromDesktop,
  onNavigate,
}: {
  kind: "no-devices" | "no-projects";
  canPair: boolean;
  /** Inside the desktop app, which can add a repository of this computer directly. */
  desktop: boolean;
  onAddFromDesktop?: () => void;
  /** A link leaves the dialog: close it first. */
  onNavigate?: () => void;
}) {
  const noDevices = kind === "no-devices";
  const Icon = noDevices ? Laptop : FolderGit2;
  return (
    <div
      data-testid={noDevices ? "new-session-empty-devices" : "new-session-empty-projects"}
      className="grid justify-items-center gap-3 rounded-lg border border-dashed px-5 py-7 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-xl border bg-card text-primary shadow-xs">
        <Icon aria-hidden className="size-5" />
      </span>
      <div className="grid max-w-sm gap-1">
        <p className="font-medium text-sm">{noDevices ? "Connect a computer first" : "Add a project"}</p>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          {noDevices ? (
            canPair ? (
              "Sessions run on a paired computer, with your own Claude or ChatGPT subscription."
            ) : (
              "Ask someone on your team to share a computer with you."
            )
          ) : (
            <>
              Add a repository from the desktop app, or run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">
                ocw-runtime add-project .
              </code>{" "}
              inside one on a paired device. Only its name is shared, never its path.
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {noDevices && canPair ? (
          <Link
            href="/settings/devices?add=1"
            onClick={onNavigate}
            className={buttonVariants({ size: "sm", className: TOUCH })}
          >
            <Laptop aria-hidden /> Add a device
          </Link>
        ) : null}
        {!noDevices && desktop ? (
          <Button type="button" size="sm" onClick={onAddFromDesktop} className={TOUCH}>
            <FolderPlus aria-hidden /> Add project from this computer
          </Button>
        ) : null}
        {!noDevices ? (
          <Link
            href="/settings/devices"
            onClick={onNavigate}
            className={buttonVariants({ size: "sm", variant: "outline", className: TOUCH })}
          >
            <Laptop aria-hidden /> Manage devices
          </Link>
        ) : null}
      </div>
      {canPair ? <AddServerLink onClick={onNavigate} /> : null}
    </div>
  );
}
