"use client";

import { Menu } from "@base-ui/react/menu";
import { ASSIGN_REFUSAL_TEXT, type WorkSession } from "@ocw/contracts";
import { ArrowUpRight, MoreHorizontal, PencilLine, UserRoundCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { relativeTime, shortAge } from "@/lib/utils";
import { OnlineDot, RuntimeLogo, STATUS, StatusChip } from "../meta";
import { ASSIGN_DIALOG_COPY, AssignSessionDialog } from "../session-owner/assign-dialog";
import { RENAME_COPY, RenameSessionDialog } from "../session-owner/rename-dialog";
import { VisibilityMarker, VisibilitySrSuffix } from "../visibility/visibility-marker";

export const ROW_COPY = {
  server: "Server",
  serverHint: "Runs on a server",
  open: "Open",
  menu: (title: string) => `Session actions for ${title}`,
} as const;

export type RowAction = "open" | "rename" | "assign";

/**
 * What a row's menu offers (D-04, D-06). A UI hint only, from fields of the list row (the DTO carries no device owner
 * and none is inferred): it hides what cannot apply; the dialogs show the API's decision (the assign preview's
 * `allowed`/`reason`, a refused rename), and the API refuses the write anyway (T-07.13.1.1-07-02).
 * - archived: Open only;
 * - Rename only when the row's per-viewer `canRename` (the API's `work_session.configure` decision) says so (WR-03);
 * - the viewer's own session (the session's owner, never the device's): no Assign and no reason;
 * - bot-started: the sponsor keeps it (the API checks this first);
 * - not on a server (`desktop`, or a host the device never reported): the server sentence;
 * - otherwise Assign to me.
 */
export function rowActions(
  session: Pick<WorkSession, "createdBy" | "deviceHostKind" | "startedByAgent" | "status" | "canRename">,
  viewerId: string | null,
): { actions: RowAction[]; reason: string | null } {
  if (session.status === "archived") return { actions: ["open"], reason: null };
  const base: RowAction[] = session.canRename === true ? ["open", "rename"] : ["open"];
  if (session.createdBy === viewerId) return { actions: base, reason: null };
  if (session.startedByAgent) return { actions: base, reason: ASSIGN_REFUSAL_TEXT.bot_session };
  if (session.deviceHostKind !== "service")
    return { actions: base, reason: ASSIGN_REFUSAL_TEXT.not_on_server };
  return { actions: [...base, "assign"], reason: null };
}

/**
 * The row's "Session actions" menu: Open, Rename… and Assign to me… (or the one-line reason), opening plan 06's
 * dialogs. The dialogs mount on first use and stay mounted (their close animation), so a long list runs no assign
 * preview or mutation observers it never needs.
 */
export function RowMenu({ session, viewerId }: { session: WorkSession; viewerId: string | null }) {
  const { actions, reason } = rowActions(session, viewerId);
  const [dialog, setDialog] = useState<"assign" | "rename" | null>(null);
  const [used, setUsed] = useState<{ assign: boolean; rename: boolean }>({ assign: false, rename: false });
  const open = (d: "assign" | "rename") => {
    setUsed((u) => ({ ...u, [d]: true }));
    setDialog(d);
  };
  const extra = actions.includes("rename") || actions.includes("assign") || reason !== null;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={ROW_COPY.menu(session.title)}
              data-testid="people-row-actions"
              className="mr-1.5 size-9 shrink-0 text-muted-foreground hover:text-foreground max-md:size-11 sm:mr-2"
            />
          }
        >
          <MoreHorizontal />
        </Menu.Trigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-testid="people-row-open"
            className="max-md:min-h-11"
            render={<Link href={`/work-zone/${session.id}`} />}
          >
            <ArrowUpRight /> {ROW_COPY.open}
          </DropdownMenuItem>
          {extra ? <DropdownMenuSeparator /> : null}
          {actions.includes("rename") ? (
            <DropdownMenuItem
              data-testid="session-rename"
              className="max-md:min-h-11"
              onClick={() => open("rename")}
            >
              <PencilLine /> {RENAME_COPY.menuItem}
            </DropdownMenuItem>
          ) : null}
          {actions.includes("assign") ? (
            <DropdownMenuItem
              data-testid="session-assign"
              className="max-md:min-h-11"
              onClick={() => open("assign")}
            >
              <UserRoundCheck /> {ASSIGN_DIALOG_COPY.menuItem}
            </DropdownMenuItem>
          ) : reason ? (
            // Not a disabled item: one quiet line that says why Assign to me is not offered (D-04), as in the header.
            <p
              data-testid="session-assign-reason"
              className="max-w-64 px-2 py-1.5 text-muted-foreground text-xs leading-snug"
            >
              {reason}
            </p>
          ) : null}
        </DropdownMenuContent>
      </Menu.Root>
      {used.assign ? (
        <AssignSessionDialog
          session={session}
          open={dialog === "assign"}
          onOpenChange={(o) => setDialog(o ? "assign" : null)}
        />
      ) : null}
      {used.rename ? (
        <RenameSessionDialog
          session={session}
          open={dialog === "rename"}
          onOpenChange={(o) => setDialog(o ? "rename" : null)}
        />
      ) : null}
    </>
  );
}

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
          {/* Below 640 px the short age ends the title line, so the meta line keeps room for the names. */}
          <span className="flex min-w-0 items-center gap-1.5">
            {title}
            {s.visibility?.differsFromDefault ? (
              <>
                <VisibilityMarker session={s} viewerId={viewerId} />
                <VisibilitySrSuffix session={s} viewerId={viewerId} />
              </>
            ) : null}
            <span
              aria-hidden
              className="ml-auto shrink-0 whitespace-nowrap pl-1 text-muted-foreground text-xs tabular-nums sm:hidden"
            >
              {shortAge(s.updatedAt)}
            </span>
          </span>
          {/* The names truncate; the Server marker and the time never do. */}
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <span className="min-w-0 max-w-[45%] shrink-0 truncate" title={s.projectName}>
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
            <span aria-hidden className="max-sm:hidden">
              ·
            </span>
            {/* On phones this stays for screen readers; the short age above is what shows. */}
            <span data-testid="people-row-time" className="shrink-0 whitespace-nowrap max-sm:sr-only">
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
