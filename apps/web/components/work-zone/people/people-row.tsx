"use client";

import type { WorkSession } from "@ocw/contracts";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { OnlineDot, RuntimeLogo, STATUS, StatusChip } from "../meta";
import { VisibilityMarker, VisibilitySrSuffix } from "../visibility/visibility-marker";

export const ROW_COPY = {
  server: "Server",
  serverHint: "Runs on a server",
} as const;

/** The status on a phone: the chip's icon and colour without its label (the label is the accessible name). */
function PhoneStatus({ status }: { status: WorkSession["status"] }) {
  const s = STATUS[status];
  if (!s) return null;
  const Icon = s.icon;
  return (
    <span
      role="img"
      aria-label={s.label}
      data-testid="people-row-status-phone"
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full sm:hidden ${s.tone}`}
    >
      <Icon aria-hidden className={s.spin ? "size-3.5 animate-spin [animation-duration:2s]" : "size-3.5"} />
    </span>
  );
}

/**
 * One session in the people view (D-01): the `RecentSessionRow` look (runtime logo, title with its visibility marker,
 * project · online dot · device · last activity, the status chip from `sm` up), as a card holding the session link.
 * Names and titles are plain text through React.
 */
export function PeopleRow({
  session: s,
  viewerId,
  actions,
}: {
  session: WorkSession;
  viewerId: string | null;
  /** The row menu, outside the link (a button inside a link is invalid markup and steals the link's clicks). */
  actions?: React.ReactNode;
}) {
  const title = (
    <span className="truncate font-medium text-sm" title={s.title}>
      {s.title}
    </span>
  );
  return (
    <li
      data-testid="people-row"
      data-session={s.id}
      className="flex min-w-0 items-center rounded-xl border bg-card shadow-xs transition-colors focus-within:border-foreground/15 hover:border-foreground/15 hover:bg-accent/30"
    >
      <Link
        href={`/work-zone/${s.id}`}
        className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-xl py-3 pr-2 pl-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset sm:pl-4"
      >
        <RuntimeLogo runtime={s.runtime} className="size-8 rounded-lg" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          {s.visibility?.differsFromDefault ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {title}
              <VisibilityMarker session={s} viewerId={viewerId} />
              <VisibilitySrSuffix session={s} viewerId={viewerId} />
            </span>
          ) : (
            title
          )}
          {/* The names truncate; the Server marker and the time never do. */}
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <span className="min-w-0 truncate" title={s.projectName}>
              {s.projectName}
            </span>
            <span aria-hidden>·</span>
            <OnlineDot online={s.deviceOnline} className="size-1.5 shrink-0" />
            <span className="min-w-0 truncate" title={s.deviceName}>
              {s.deviceName}
            </span>
            {s.deviceHostKind === "service" ? (
              <Badge
                variant="outline"
                data-testid="server-marker"
                title={ROW_COPY.serverHint}
                className="px-1 text-[11px]"
              >
                {ROW_COPY.server}
              </Badge>
            ) : null}
            <span aria-hidden>·</span>
            <span data-testid="people-row-time" className="shrink-0 whitespace-nowrap">
              {relativeTime(s.updatedAt)}
            </span>
          </span>
        </span>
        <PhoneStatus status={s.status} />
        <StatusChip status={s.status} className="hidden sm:inline-flex" />
      </Link>
      {actions}
    </li>
  );
}
