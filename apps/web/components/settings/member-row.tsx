"use client";

import { type MemberDetail, type MemberUnitRef, type OrgRole, ROLE_LABELS } from "@ocw/contracts";
import { History, KeyRound, Lock, LogOut, MoreHorizontal, UserCheck, UserRound, UserX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DeactivatedPill, RoleBadge } from "@/components/members/member-badges";
import { MemberAvatar } from "@/components/members/member-profile-sheet";
import { sortUnits, UnitChip } from "@/components/members/unit-chip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { ROLE_OPTIONS, useChangeRole, useDeactivateMember, useReactivateMember } from "@/lib/member-queries";
import { cn } from "@/lib/utils";
import { ResetLinkDialog } from "./reset-link-dialog";

export { DeactivatedPill, RoleBadge };

const ROLE_ITEMS = ROLE_OPTIONS.map((value) => ({ value, label: ROLE_LABELS[value] }));
const MAX_CHIPS = 2;
function MoreUnits({
  units,
  shown,
  onClick,
  className,
}: {
  units: readonly MemberUnitRef[];
  shown: number;
  onClick: () => void;
  className?: string;
}) {
  const rest = units.slice(shown);
  if (rest.length === 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="member-more-units"
      title={rest.map((u) => u.name).join(", ")}
      aria-label={`${rest.length} more: ${rest.map((u) => u.name).join(", ")}`}
      className={cn(
        "inline-flex h-6 items-center rounded-md px-1 text-[11.5px] text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      +{rest.length}
    </button>
  );
}

function RoleControl({ member, canManage }: { member: MemberDetail; canManage: boolean }) {
  const change = useChangeRole();
  if (!canManage || member.status === "deactivated") return <RoleBadge role={member.role} />;

  function onChange(role: OrgRole | null) {
    if (!role || role === member.role) return;
    change.mutate(
      { userId: member.userId, role },
      {
        onSuccess: (m) =>
          toast.success("Role updated", { description: `${m.displayName} is now ${ROLE_LABELS[m.role]}.` }),
        onError: (err) => toast.error("Could not change the role", { description: errorMessage(err) }),
      },
    );
  }

  return (
    <Select items={ROLE_ITEMS} value={member.role} onValueChange={onChange}>
      <SelectTrigger
        aria-label={`Role of ${member.displayName}`}
        data-testid="member-role-select"
        className="h-10 w-full max-w-56 text-[13px] sm:h-8 sm:w-44"
      />
      <SelectContent>
        {ROLE_ITEMS.map((r) => (
          <SelectItem key={r.value} value={r.value}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type Confirming = "deactivate" | "reactivate" | null;

const DEACTIVATION_EFFECTS = [
  { icon: LogOut, text: "Signed out on every device, right away." },
  { icon: Lock, text: "Cannot sign in until you reactivate them." },
  { icon: History, text: "Their messages, threads and Work Zone history are kept." },
] as const;

/**
 * Row menu. "View profile" for everyone; admin actions (`member.manage`) never on your own row: you change
 * your own password under Security, and the API refuses self-deactivation anyway.
 */
function MemberActions({
  member,
  isYou,
  canManage,
  onOpenProfile,
}: {
  member: MemberDetail;
  isYou: boolean;
  canManage: boolean;
  onOpenProfile: () => void;
}) {
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const deactivate = useDeactivateMember();
  const reactivate = useReactivateMember();
  const deactivated = member.status === "deactivated";
  const admin = canManage && !isYou;
  const pending = deactivate.isPending || reactivate.isPending;

  function onConfirm() {
    const action = confirming === "deactivate" ? deactivate : reactivate;
    // mutateAsync, not mutate(…, callbacks): the mutation's onSettled refetches the list, which hides a deactivated
    // member and unmounts this row, and React Query drops per-call callbacks of an unmounted observer, so the
    // confirmation toast was lost depending on timing. The returned promise settles either way.
    action.mutateAsync(member.userId).then(
      () => {
        toast.success(
          confirming === "deactivate"
            ? `${member.displayName} was deactivated`
            : `${member.displayName} can sign in again`,
        );
        setConfirming(null);
      },
      (err: unknown) =>
        toast.error(confirming === "deactivate" ? "Could not deactivate" : "Could not reactivate", {
          description: errorMessage(err),
        }),
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Actions for ${member.displayName}`}
          data-testid="member-actions"
          className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-popup-open:bg-accent data-popup-open:text-foreground sm:size-8"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={onOpenProfile} data-testid="member-action-profile">
            <UserRound /> View profile
          </DropdownMenuItem>
          {admin ? (
            <>
              <DropdownMenuSeparator />
              {deactivated ? null : (
                <DropdownMenuItem onClick={() => setResetOpen(true)} data-testid="member-action-reset-link">
                  <KeyRound /> Create password reset link
                </DropdownMenuItem>
              )}
              {deactivated ? (
                <DropdownMenuItem
                  onClick={() => setConfirming("reactivate")}
                  data-testid="member-action-reactivate"
                >
                  <UserCheck /> Reactivate
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setConfirming("deactivate")}
                  data-testid="member-action-deactivate"
                >
                  <UserX /> Deactivate
                </DropdownMenuItem>
              )}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {admin ? (
        <>
          <Dialog open={confirming !== null} onOpenChange={(o) => !o && !pending && setConfirming(null)}>
            <DialogContent data-testid="member-confirm-dialog">
              <DialogHeader>
                <span
                  className={cn(
                    "mb-1 flex size-10 items-center justify-center rounded-xl border shadow-xs",
                    confirming === "deactivate"
                      ? "border-destructive/25 bg-destructive/10 text-destructive"
                      : "bg-card text-primary",
                  )}
                >
                  {confirming === "deactivate" ? (
                    <UserX className="size-5" strokeWidth={1.75} />
                  ) : (
                    <UserCheck className="size-5" strokeWidth={1.75} />
                  )}
                </span>
                <DialogTitle>
                  {confirming === "deactivate"
                    ? `Deactivate ${member.displayName}?`
                    : `Reactivate ${member.displayName}?`}
                </DialogTitle>
                <DialogDescription>
                  {confirming === "deactivate"
                    ? "Their sessions end now. Messages and history stay."
                    : "They can sign in again with their password, with the same role and units."}
                </DialogDescription>
              </DialogHeader>
              {confirming === "deactivate" ? (
                <ul className="grid gap-2.5 rounded-lg border bg-muted/40 p-3.5 text-sm">
                  {DEACTIVATION_EFFECTS.map(({ icon: Icon, text }) => (
                    <li key={text} className="flex gap-2.5">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span>{text}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirming(null)}
                  disabled={pending}
                  className="h-10 sm:h-9"
                >
                  Cancel
                </Button>
                <Button
                  variant={confirming === "deactivate" ? "destructive" : "default"}
                  onClick={onConfirm}
                  disabled={pending}
                  data-testid="member-confirm"
                  className="h-10 sm:h-9"
                >
                  {pending ? <Spinner /> : null}
                  {confirming === "deactivate" ? "Deactivate" : "Reactivate"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {deactivated ? null : (
            <ResetLinkDialog member={member} open={resetOpen} onOpenChange={setResetOpen} />
          )}
        </>
      ) : null}
    </>
  );
}

/**
 * One member: avatar, name with status, unit chips, role (select for `member.manage`, badge otherwise),
 * status pill and row menu. At 390 px the role control wraps under the name; from 640 px it is one line.
 */
export function MemberRow({
  member,
  isYou,
  canManage,
  onOpenProfile,
}: {
  member: MemberDetail;
  isYou: boolean;
  canManage: boolean;
  onOpenProfile: (userId: string) => void;
}) {
  const deactivated = member.status === "deactivated";
  const units = sortUnits(member.units);
  const open = () => onOpenProfile(member.userId);

  return (
    <li
      data-testid="member-row"
      data-user-id={member.userId}
      data-status={member.status}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={open}
        className="row-span-2 self-start rounded-full sm:row-span-1 sm:self-center"
      >
        <MemberAvatar
          name={member.displayName}
          avatarUrl={member.avatarUrl}
          seed={member.userId}
          className={cn("size-9", deactivated && "opacity-50 grayscale")}
          textClassName="text-xs"
        />
      </button>
      <div className="col-start-2 min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={open}
            data-testid="member-name"
            className={cn(
              "min-w-0 truncate rounded-sm text-left font-medium text-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/30",
              deactivated && "text-muted-foreground",
            )}
          >
            {member.displayName}
          </button>
          {isYou ? (
            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground uppercase tracking-wide">
              You
            </span>
          ) : null}
          {deactivated ? <DeactivatedPill /> : null}
          {member.statusEmoji || member.statusText ? (
            <span
              data-testid="member-status"
              className="min-w-0 truncate text-muted-foreground text-xs"
              title={member.statusText ?? undefined}
            >
              {member.statusEmoji ? <span aria-hidden>{member.statusEmoji}</span> : null}
              {member.statusText ? <span className="hidden sm:inline"> {member.statusText}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="truncate text-muted-foreground text-xs">{member.email ?? ""}</div>
        {units.length > 0 ? (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
            {units.slice(0, MAX_CHIPS).map((u, i) => (
              // At 390 px one chip fits beside the "+N"; from 640 px two.
              <UnitChip key={u.unitId} unit={u} className={i > 0 ? "max-sm:hidden" : undefined} />
            ))}
            <MoreUnits units={units} shown={1} onClick={open} className="sm:hidden" />
            <MoreUnits units={units} shown={MAX_CHIPS} onClick={open} className="max-sm:hidden" />
          </div>
        ) : null}
      </div>
      <div className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1 sm:justify-self-end">
        <RoleControl member={member} canManage={canManage} />
      </div>
      <div className="col-start-3 row-start-1 flex justify-end self-start sm:col-start-4 sm:self-center">
        <MemberActions member={member} isYou={isYou} canManage={canManage} onOpenProfile={open} />
      </div>
    </li>
  );
}
