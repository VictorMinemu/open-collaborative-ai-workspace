"use client";

import { UserAvatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Whose session this is (07.13.1.1, D-02): the session's owner (`createdBy`, moved by Assign to me) in the session
 * header. On ≥ 768 px a compact chip beside the visibility chip (avatar and first name, the full name in its tooltip);
 * below 768 px one quiet line under the title, so the 44 px controls never squeeze the title. Names are plain text
 * through React (T-07.13.1.1-06-02).
 */

/** An owner the directory no longer knows (they left the organization). */
export const FORMER_MEMBER = "a former member";

type OwnerProps = {
  ownerId: string;
  /** The owner's display name; null when they left the organization. */
  name: string | null;
  avatarUrl: string | null | undefined;
  className?: string;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The desktop chip: the same height and rounding as the visibility chip, never interactive. */
export function OwnerChip({ ownerId, name, avatarUrl, className }: OwnerProps) {
  const full = name ?? FORMER_MEMBER;
  const label = `Owner: ${full}`;
  return (
    <Tooltip content={label}>
      <span
        role="group"
        aria-label={label}
        data-testid="session-owner"
        className={cn(
          "inline-flex h-8 min-w-0 max-w-[9rem] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[12px] text-muted-foreground",
          // 768-1023: avatar only (the row is full there, as for the account chip); the tooltip keeps the name.
          "max-lg:w-8 max-lg:justify-center max-lg:px-0",
          className,
        )}
      >
        <UserAvatar name={full} src={avatarUrl} seed={ownerId} className="size-5 [&_span]:text-[9px]" />
        <span aria-hidden className="truncate max-lg:hidden">
          {name ? firstName(name) : "Former member"}
        </span>
      </span>
    </Tooltip>
  );
}

/** The phone line under the title: "Owner · <full name>", truncated. */
export function OwnerLine({ ownerId, name, avatarUrl, className }: OwnerProps) {
  const full = name ?? FORMER_MEMBER;
  return (
    <span
      data-testid="session-owner"
      className={cn("flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs", className)}
    >
      <UserAvatar name={full} src={avatarUrl} seed={ownerId} className="size-4 [&_span]:text-[7.5px]" />
      <span className="truncate">Owner · {full}</span>
    </span>
  );
}

/**
 * The participants shown as "not here" in the header: everyone who prompted the session, minus the viewer, anyone
 * watching right now and the owner (the owner chip or line already shows them).
 */
export function absentParticipants(
  participants: ReadonlyMap<string, string>,
  here: ReadonlySet<string>,
  viewerId: string | null | undefined,
  ownerId: string,
): Array<[string, string]> {
  return [...participants.entries()].filter(([uid]) => uid !== viewerId && uid !== ownerId && !here.has(uid));
}
