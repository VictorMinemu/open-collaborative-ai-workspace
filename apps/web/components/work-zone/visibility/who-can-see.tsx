"use client";

import type { WorkProjectPerson, WorkSessionViewer } from "@ocw/contracts";
import { ChevronDown } from "lucide-react";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { andMore, reasonLabel } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";

/**
 * The panel's answer to "who sees this?" (UI-SPEC §1.2 footer, N3, D-11): two lines, never more. Line 1: up to five
 * faces, "{n} people can see this" and See all; line 2: who always sees it (admins, and the device owner when the
 * session runs on someone else's device). Everything comes from the API; nothing is counted here.
 */
export function WhoCanSee({
  count,
  countText,
  stack,
  alwaysLine,
  seeAll,
  onSeeAll,
  listId,
  sheet = false,
}: {
  /** The API's count; null when it is unknown (a failed draft preview shows "—"). */
  count: number | null;
  countText: string;
  stack: readonly WorkProjectPerson[];
  alwaysLine: string | null;
  /** See all is open; undefined = no list to show (draft mode). */
  seeAll?: boolean | undefined;
  onSeeAll?: (() => void) | undefined;
  listId?: string | undefined;
  sheet?: boolean;
}) {
  const faces = stack.slice(0, 5);
  return (
    <div
      data-testid="who-can-see"
      data-count={count ?? ""}
      className={cn("shrink-0 border-t px-4", sheet ? "pt-1" : "pb-3")}
    >
      <div className={cn("flex items-center gap-2", sheet ? "min-h-14" : "h-12")}>
        {faces.length > 0 ? (
          <div role="group" aria-label={countText} className="flex shrink-0 items-center -space-x-1.5">
            {faces.map((p, i) => (
              // The first face sits on top, so each one keeps its initials readable.
              <span key={p.userId} className="relative inline-flex" style={{ zIndex: faces.length - i }}>
                <UserAvatar
                  name={p.name}
                  src={p.avatarUrl}
                  seed={p.userId}
                  className={cn("size-6 text-[10px] ring-2", sheet ? "ring-background" : "ring-popover")}
                />
              </span>
            ))}
          </div>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm" title={count === null ? undefined : countText}>
          {count === null ? (
            <>
              <span aria-hidden>—</span>
              <span className="sr-only">Couldn't count who can see it</span>
            </>
          ) : (
            countText
          )}
        </span>
        {onSeeAll ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="who-can-see-toggle"
            aria-expanded={seeAll === true}
            aria-controls={listId}
            onClick={onSeeAll}
            className="shrink-0 gap-1 px-2 text-muted-foreground max-md:h-11"
          >
            {seeAll ? "Hide" : "See all"}
            <ChevronDown
              aria-hidden
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                seeAll && "rotate-180",
              )}
            />
          </Button>
        ) : null}
      </div>
      {alwaysLine ? (
        <p
          data-testid="who-can-see-always"
          title={alwaysLine}
          className={cn("truncate text-muted-foreground text-xs", sheet && "pb-1")}
        >
          {alwaysLine}
        </p>
      ) : null}
    </div>
  );
}

/** See all (UI-SPEC §1.2): everyone the API lists, with the reason each can see it; over 50: "and {n} more". */
export function WhoCanSeeList({
  id,
  viewers,
  more,
  viewerId,
  projectName,
}: {
  id: string;
  viewers: readonly WorkSessionViewer[];
  more: number;
  viewerId: string | null | undefined;
  /** The team project's name ("Owner · left {project}"). */
  projectName: string | undefined;
}) {
  return (
    <div id={id} data-testid="who-can-see-all" className="border-t px-2 py-1">
      <ul aria-label="People who can see this session" className="grid max-h-56 overflow-y-auto">
        {viewers.map((v) => (
          <li
            key={v.userId}
            data-user-id={v.userId}
            data-reason={v.reason}
            className="flex h-11 min-w-0 items-center gap-2 rounded-lg px-2 md:h-9"
          >
            <UserAvatar name={v.name} src={v.avatarUrl} seed={v.userId} className="size-6 text-[10px]" />
            <span className="min-w-0 flex-1 truncate text-sm" title={v.name}>
              {v.name}
              {v.userId === viewerId ? <span className="text-muted-foreground"> (you)</span> : null}
            </span>
            <span className="max-w-[45%] shrink-0 truncate text-muted-foreground text-xs">
              {reasonLabel(v.reason, { via: v.via?.name, project: projectName })}
            </span>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="px-2 pt-1 pb-1.5 text-muted-foreground text-xs">{andMore(more)}</p> : null}
    </div>
  );
}
