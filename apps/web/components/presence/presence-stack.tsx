"use client";

import { useMemo } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { usePresence } from "@/lib/realtime";
import { cn } from "@/lib/utils";

/** Someone with at least one live connection in a conversation (RT-04, D-08). */
export interface PresentPerson {
  userId: string;
  state: "online" | "away";
  name: string;
  avatarUrl: string | null;
}

const LABEL = { online: "Active", away: "Away" } as const;

/** Green (Active) or amber (Away) status dot; a ring in the background colour separates it from the avatar. */
export function PresenceDot({ state, className }: { state: "online" | "away"; className?: string }) {
  return (
    <span
      role="img"
      aria-label={LABEL[state]}
      data-testid="presence-dot"
      className={cn(
        "block size-2.5 shrink-0 rounded-full ring-2 ring-background",
        state === "online" ? "bg-success" : "bg-warning",
        className,
      )}
    />
  );
}

/** A person's avatar with their presence dot at the bottom-right (outside the avatar's clipping root). */
export function PresenceAvatar({
  userId,
  name,
  avatarUrl,
  state,
  className,
}: {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  state: "online" | "away";
  className?: string;
}) {
  return (
    <span
      className="relative inline-flex shrink-0"
      data-testid="presence-avatar"
      data-user-id={userId}
      data-state={state}
    >
      <PrincipalAvatar
        kind="user"
        name={name}
        avatarUrl={avatarUrl}
        seed={userId}
        compact
        className={cn(
          "size-6 text-[10px] ring-2 ring-background",
          state === "away" && "opacity-70",
          className,
        )}
      />
      <PresenceDot state={state} className="absolute -right-0.5 -bottom-0.5 size-2" />
    </span>
  );
}

/**
 * Overlapping avatars of the people here now (max 3 at ≥ 640 px, 2 below; "+N" for the rest) with a tooltip
 * naming each one and their state. Renders nothing when nobody is here.
 */
export function PresenceStack({
  people,
  max = 3,
  label,
  className,
}: {
  people: PresentPerson[];
  max?: number;
  label?: string;
  className?: string;
}) {
  if (people.length === 0) return null;
  const narrowMax = Math.min(max, 2);
  const shown = people.slice(0, max);
  const aria = label ?? `${people.length} here now`;
  return (
    <Tooltip
      content={
        <div className="grid gap-0.5 py-0.5">
          <span className="text-background/70">Here now</span>
          {people.slice(0, 8).map((p) => (
            <span key={p.userId} className="flex items-center gap-1.5">
              <PresenceDot state={p.state} className="size-2 ring-0" />
              <span className="max-w-48 truncate">{p.name}</span>
              <span className="text-background/60">{LABEL[p.state]}</span>
            </span>
          ))}
          {people.length > 8 ? (
            <span className="text-background/70">and {people.length - 8} more</span>
          ) : null}
        </div>
      }
      side="bottom"
    >
      <div
        role="group"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the tooltip that names everyone here
        tabIndex={0}
        aria-label={aria}
        data-testid="presence-stack"
        className={cn(
          "flex h-8 items-center rounded-lg px-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
          className,
        )}
      >
        <span className="flex items-center -space-x-1.5">
          {shown.map((p, i) => (
            <span key={p.userId} className={cn("inline-flex", i >= narrowMax && "hidden sm:inline-flex")}>
              <PresenceAvatar userId={p.userId} name={p.name} avatarUrl={p.avatarUrl} state={p.state} />
            </span>
          ))}
        </span>
        {people.length > narrowMax ? (
          <span className="ml-1 font-medium text-muted-foreground text-xs tabular-nums sm:hidden">
            +{people.length - narrowMax}
          </span>
        ) : null}
        {people.length > max ? (
          <span className="ml-1 hidden font-medium text-muted-foreground text-xs tabular-nums sm:inline">
            +{people.length - max}
          </span>
        ) : null}
      </div>
    </Tooltip>
  );
}

/** Presence of a topic joined with names and avatars; the viewer (excludeUserId) is left out. */
export function usePresentPeople(
  topic: string | null,
  o: {
    excludeUserId?: string;
    resolve: (userId: string) => { name: string; avatarUrl: string | null } | undefined;
  },
): PresentPerson[] {
  const present = usePresence(topic);
  const { excludeUserId, resolve } = o;
  return useMemo(
    () =>
      present
        .filter((p) => p.userId !== excludeUserId)
        .map((p) => {
          const who = resolve(p.userId);
          return {
            userId: p.userId,
            state: p.state,
            name: who?.name ?? "Someone",
            avatarUrl: who?.avatarUrl ?? null,
          };
        }),
    [present, excludeUserId, resolve],
  );
}
