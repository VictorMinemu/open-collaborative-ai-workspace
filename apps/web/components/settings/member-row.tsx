"use client";

import { type MemberDetail, type OrgRole, ROLE_LABELS } from "@ocw/contracts";
import { toast } from "sonner";
import { UnitChip } from "@/components/members/unit-chip";
import { UserAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { errorMessage } from "@/lib/api";
import { ROLE_OPTIONS, useChangeRole } from "@/lib/member-queries";
import { cn } from "@/lib/utils";

const ROLE_ITEMS = ROLE_OPTIONS.map((value) => ({ value, label: ROLE_LABELS[value] }));

/** Admins and leads stand out; everyone else reads as a quiet outline. Presentation only, not policy. */
const ROLE_VARIANT: Record<OrgRole, "brand" | "outline"> = {
  admin: "brand",
  lead: "brand",
  developer: "outline",
  standard: "outline",
};

const MAX_CHIPS = 2;

export function RoleBadge({ role, className }: { role: OrgRole; className?: string }) {
  return (
    <Badge
      variant={ROLE_VARIANT[role]}
      data-testid="member-role-badge"
      className={cn("h-6 shrink-0 whitespace-nowrap px-2 text-xs", className)}
    >
      {ROLE_LABELS[role]}
    </Badge>
  );
}

export function DeactivatedPill({ className }: { className?: string }) {
  return (
    <span
      data-testid="member-deactivated"
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border border-destructive/25 bg-destructive/8 px-1.5 font-medium text-[10.5px] text-destructive dark:border-destructive/40 dark:bg-destructive/15",
        className,
      )}
    >
      Deactivated
    </span>
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

/**
 * One member: avatar, name with status, unit chips, role (select for `member.manage`, badge otherwise) and
 * the status pill. At 390 px the role control wraps under the name; at ≥ 640 px everything sits on one line.
 */
export function MemberRow({
  member,
  isYou,
  canManage,
  menu,
}: {
  member: MemberDetail;
  isYou: boolean;
  canManage: boolean;
  /** Row actions (rendered at the end of the row). */
  menu?: React.ReactNode;
}) {
  const deactivated = member.status === "deactivated";
  const chips = member.units.slice(0, MAX_CHIPS);
  const more = member.units.length - chips.length;

  return (
    <li
      data-testid="member-row"
      data-user-id={member.userId}
      data-status={member.status}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
    >
      <UserAvatar
        name={member.displayName}
        src={member.avatarUrl}
        seed={member.userId}
        className={cn(
          "row-span-2 size-9 self-start sm:row-span-1 sm:self-center",
          deactivated && "opacity-50",
        )}
      />
      <div className="col-start-2 min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            data-testid="member-name"
            className={cn("truncate font-medium text-sm", deactivated && "text-muted-foreground")}
          >
            {member.displayName}
          </span>
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
        {member.units.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {chips.map((u) => (
              <UnitChip key={u.unitId} unit={u} />
            ))}
            {more > 0 ? (
              <span
                className="inline-flex h-6 items-center rounded-md px-1 text-[11.5px] text-muted-foreground"
                title={member.units
                  .slice(MAX_CHIPS)
                  .map((u) => u.name)
                  .join(", ")}
              >
                +{more}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1 sm:justify-self-end">
        <RoleControl member={member} canManage={canManage} />
      </div>
      <div className="col-start-3 row-start-1 flex justify-end sm:col-start-4">{menu}</div>
    </li>
  );
}
