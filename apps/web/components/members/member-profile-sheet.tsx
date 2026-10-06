"use client";

import type { MemberDetail } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Mail, MessageCircle, Network } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage, toneFor } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useIsDesktop } from "@/hooks/use-media-query";
import { errorMessage } from "@/lib/api";
import { createDm } from "@/lib/chat-queries";
import { useMemberProfile } from "@/lib/member-queries";
import { useMe } from "@/lib/queries";
import { cn, formatDate, initials } from "@/lib/utils";
import { DeactivatedPill, RoleBadge } from "./member-badges";
import { sortUnits, UNIT_KIND_ICON, UNIT_KIND_LABEL, UNIT_ROLE_TAG } from "./unit-chip";

const isHttpsUrl = (s: string) => /^https:\/\//i.test(s);

/**
 * A member's avatar: an https photo (never sends the workspace URL as referrer, T-02-12-03), an emoji, or
 * initials on a stable tint. The server only accepts emoji or https values.
 */
export function MemberAvatar({
  name,
  avatarUrl,
  seed,
  className,
  textClassName = "text-xs",
  emojiClassName = "text-lg",
}: {
  name: string;
  avatarUrl: string | null | undefined;
  seed: string;
  className?: string;
  /** Size of the initials (scale it with the avatar). */
  textClassName?: string;
  /** Size of an emoji avatar (scale it with the avatar). */
  emojiClassName?: string;
}) {
  if (avatarUrl && !isHttpsUrl(avatarUrl)) {
    return (
      <span
        data-slot="avatar"
        data-avatar="emoji"
        className={cn(
          "relative flex size-8 shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted leading-none",
          className,
        )}
      >
        <span aria-hidden className={cn(emojiClassName, "leading-none")}>
          {avatarUrl}
        </span>
      </span>
    );
  }
  return (
    <Avatar className={className}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback className={cn(toneFor(seed), textClassName)}>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/** Bottom sheet on phones, right-hand panel from md up. */
export function responsiveSheetClass(desktop: boolean, desktopWidth = "w-[26rem] max-w-[92vw]"): string {
  return desktop
    ? desktopWidth
    : "inset-x-0 top-auto bottom-0 h-auto max-h-[90dvh] w-full max-w-none rounded-t-2xl border-t border-l-0 data-ending-style:translate-x-0 data-ending-style:translate-y-full data-starting-style:translate-x-0 data-starting-style:translate-y-full";
}

/** ORG-06: anyone in the organization can open any member's profile (GET /api/v1/members/:userId). */
export function MemberProfileSheet({
  userId,
  open,
  onOpenChange,
}: {
  userId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const desktop = useIsDesktop();
  const profile = useMemberProfile(open ? userId : null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="member-profile-sheet"
        className={cn("overflow-hidden", responsiveSheetClass(desktop))}
      >
        {profile.data ? (
          <ProfileBody member={profile.data} onClose={() => onOpenChange(false)} />
        ) : profile.isError ? (
          <div className="grid gap-2 px-6 pt-16 pb-10 text-center">
            <SheetTitle>Profile unavailable</SheetTitle>
            <SheetDescription>{errorMessage(profile.error)}</SheetDescription>
          </div>
        ) : (
          <ProfileSkeleton />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** "Message" on someone else's active profile: opens (or creates) the DM with them (CHAT-04). */
function MessageButton({ member, onClose }: { member: MemberDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const me = useMe({ enabled: false });
  const [busy, setBusy] = useState(false);
  if (member.status === "deactivated" || member.userId === me.data?.user.id) return null;
  const run = async () => {
    setBusy(true);
    try {
      const dm = await createDm(qc, [{ kind: "user", id: member.userId }]);
      onClose();
      router.push(`/chat/dm/${dm.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Button className="mt-4 w-full" data-testid="profile-message" disabled={busy} onClick={() => void run()}>
      {busy ? <Spinner /> : <MessageCircle />}
      Message
    </Button>
  );
}

function ProfileBody({ member, onClose }: { member: MemberDetail; onClose: () => void }) {
  const deactivated = member.status === "deactivated";
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-8">
      <div
        aria-hidden
        className="h-24 bg-linear-to-br from-primary/20 via-primary/8 to-transparent dark:from-primary/30 dark:via-primary/10"
      />
      <div className="-mt-11 px-6">
        <MemberAvatar
          name={member.displayName}
          avatarUrl={member.avatarUrl}
          seed={member.userId}
          className={cn("size-[5.5rem] ring-4 ring-background", deactivated && "grayscale")}
          textClassName="text-2xl"
          emojiClassName="text-[2.75rem]"
        />
      </div>
      <div className="px-6 pt-3">
        <SheetTitle className="text-xl tracking-tight" data-testid="profile-name">
          {member.displayName}
        </SheetTitle>
        {member.statusEmoji || member.statusText ? (
          <p
            className="mt-1 flex items-center gap-1.5 text-muted-foreground text-sm"
            data-testid="profile-status"
          >
            {member.statusEmoji ? <span aria-hidden>{member.statusEmoji}</span> : null}
            <span>{member.statusText}</span>
          </p>
        ) : null}
        <SheetDescription render={<div />} className="mt-3 flex flex-wrap items-center gap-2">
          <RoleBadge role={member.role} />
          {deactivated ? <DeactivatedPill className="h-6 px-2 text-xs" /> : null}
        </SheetDescription>
        <MessageButton member={member} onClose={onClose} />
      </div>

      <dl className="mt-6 grid gap-px overflow-hidden border-y bg-border">
        <div className="flex items-center gap-3 bg-background px-6 py-3">
          <dt className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Mail className="size-4" aria-hidden />
            <span className="sr-only">Email</span>
          </dt>
          <dd className="min-w-0 truncate text-sm">
            {member.email ? (
              <a href={`mailto:${member.email}`} className="hover:underline">
                {member.email}
              </a>
            ) : (
              <span className="text-muted-foreground">No email</span>
            )}
          </dd>
        </div>
        <div className="flex items-center gap-3 bg-background px-6 py-3">
          <dt className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <CalendarDays className="size-4" aria-hidden />
            <span className="sr-only">Joined</span>
          </dt>
          <dd className="text-sm" data-testid="profile-joined">
            Joined {formatDate(member.joinedAt)}
          </dd>
        </div>
      </dl>

      <section className="px-6 pt-6">
        <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
          Departments, teams and projects
        </h3>
        {member.units.length === 0 ? (
          <p className="mt-2 flex items-center gap-2 text-muted-foreground text-sm">
            <Network className="size-4" aria-hidden />
            Not in any department, team or project yet.
          </p>
        ) : (
          <ul className="mt-2 grid gap-1" data-testid="profile-units">
            {sortUnits(member.units).map((u) => {
              const Icon = UNIT_KIND_ICON[u.kind];
              const tag = UNIT_ROLE_TAG[u.role];
              return (
                <li key={u.unitId}>
                  <Link
                    href={`/settings/organization?unit=${u.unitId}`}
                    className="-mx-2 flex min-h-10 items-center gap-3 rounded-lg px-2 py-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/30"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-sm">{u.name}</span>
                      <span className="block text-muted-foreground text-xs">{UNIT_KIND_LABEL[u.kind]}</span>
                    </span>
                    {tag ? (
                      <span className="shrink-0 rounded-md bg-brand-soft px-1.5 py-0.5 font-medium text-[11px] text-brand-soft-foreground">
                        {tag}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Sized like the loaded profile so nothing jumps when it arrives. */
function ProfileSkeleton() {
  return (
    <div className="pb-8" aria-busy>
      <SheetTitle className="sr-only">Loading profile</SheetTitle>
      <div className="h-24 bg-muted/40" />
      <div className="-mt-11 px-6">
        <Skeleton className="size-[5.5rem] rounded-full ring-4 ring-background" />
      </div>
      <div className="grid gap-2 px-6 pt-4">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-2 h-6 w-28" />
      </div>
      <div className="mt-6 grid gap-3 px-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    </div>
  );
}
