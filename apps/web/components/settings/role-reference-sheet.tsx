"use client";

import {
  type OrgRole,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_SURFACE,
  Permission,
  type PermissionSurface,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLE_SURFACES,
} from "@ocw/contracts";
import { Check, Minus } from "lucide-react";
import { Fragment } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsDesktop } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

const ROLES: readonly OrgRole[] = ["standard", "developer", "lead", "admin"];

/** Short column headers; the full role names are in the header's title and the screen-reader label. */
const ROLE_SHORT: Record<OrgRole, string> = {
  standard: "Standard",
  developer: "Developer",
  lead: "Team Lead",
  admin: "Admin",
};
const ROLE_TINY: Record<OrgRole, string> = {
  standard: "Standard",
  developer: "Dev",
  lead: "Lead",
  admin: "Admin",
};

/** Matrix groups in reading order. `runtime` permissions belong to devices and the agent cell, not people. */
const GROUPS: ReadonlyArray<{ surface: PermissionSurface; label: string }> = [
  { surface: "account", label: "Account" },
  { surface: "chat", label: "Chat" },
  { surface: "bots", label: "Bots" },
  { surface: "workzone", label: "Work Zone" },
  { surface: "team", label: "Team" },
  { surface: "admin", label: "Administration" },
];

/** Granted only through a relation (your own account, a device you own or that is shared with you). */
const RELATION_ONLY: readonly Permission[] = ["account.manage", "device.use", "device.update"];

export type Grant = "granted" | "own" | "none";

/** Role × permission matrix, derived from the same tables the API resolver uses. */
export function grantFor(role: OrgRole, permission: Permission): Grant {
  if (ROLE_PERMISSIONS[role].includes(permission)) return "granted";
  if (RELATION_ONLY.includes(permission) && ROLE_SURFACES[role].includes(PERMISSION_SURFACE[permission])) {
    return "own";
  }
  return "none";
}

const ROWS = GROUPS.map((g) => ({
  ...g,
  permissions: Permission.options.filter((p) => PERMISSION_SURFACE[p] === g.surface),
})).filter((g) => g.permissions.length > 0);

function Cell({ grant, role }: { grant: Grant; role: OrgRole }) {
  const label =
    grant === "granted"
      ? `${ROLE_LABELS[role]}: yes`
      : grant === "own"
        ? `${ROLE_LABELS[role]}: own items`
        : `${ROLE_LABELS[role]}: no`;
  return (
    <td
      data-role={role}
      data-grant={grant}
      className="border-t px-1 py-2 text-center align-middle group-hover:bg-muted/60"
    >
      <span className="sr-only">{label}</span>
      {grant === "granted" ? (
        <span className="mx-auto flex size-5 items-center justify-center rounded-full bg-primary/12 text-primary sm:size-6">
          <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
        </span>
      ) : grant === "own" ? (
        <span
          aria-hidden
          className="mx-auto inline-flex h-5 items-center rounded-full border border-primary/25 px-1 font-medium text-[10px] text-primary sm:px-1.5"
        >
          Own
        </span>
      ) : (
        <Minus className="mx-auto size-3.5 text-muted-foreground/45" aria-hidden />
      )}
    </td>
  );
}

/** "What can each role do?" — the read-only roles view (custom roles are out of scope). */
export function RoleReferenceSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const desktop = useIsDesktop();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="role-reference-sheet"
        className={cn(
          desktop
            ? "w-[46rem] max-w-[92vw]"
            : "inset-x-0 top-auto bottom-0 h-[88dvh] w-full max-w-none rounded-t-2xl border-t border-l-0 data-ending-style:translate-x-0 data-ending-style:translate-y-full data-starting-style:translate-x-0 data-starting-style:translate-y-full",
        )}
      >
        <div className="border-b px-5 pt-5 pb-4 pr-12 sm:px-6">
          <SheetTitle className="text-lg tracking-tight">What can each role do?</SheetTitle>
          <SheetDescription className="mt-1">
            Roles are cumulative: each includes everything to its left. Team Leads also manage the people in
            the units they lead, and deny rules can narrow any role.
          </SheetDescription>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto px-1 pb-6 sm:px-4">
          <table
            className="w-full border-separate border-spacing-0 text-sm sm:min-w-[34rem]"
            data-testid="role-matrix"
          >
            <thead className="sticky top-0 z-20">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-30 bg-background px-2 pt-3 pb-2 text-left font-medium text-muted-foreground text-xs sm:px-3"
                >
                  Capability
                </th>
                {ROLES.map((r) => (
                  <th
                    key={r}
                    scope="col"
                    title={ROLE_LABELS[r]}
                    className="w-14 bg-background px-0.5 pt-3 pb-2 text-center font-semibold text-[11px] text-foreground sm:w-[5.25rem] sm:px-1 sm:text-xs"
                  >
                    <span className="sm:hidden">{ROLE_TINY[r]}</span>
                    <span className="hidden sm:inline">{ROLE_SHORT[r]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((g) => (
                <Fragment key={g.surface}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={1}
                      className="sticky left-0 z-10 bg-background px-2 pt-5 pb-1.5 text-left font-semibold text-[11px] text-muted-foreground uppercase tracking-wider sm:px-3"
                    >
                      {g.label}
                    </th>
                    <td colSpan={ROLES.length} className="bg-background" />
                  </tr>
                  {g.permissions.map((p) => (
                    <tr key={p} data-testid="role-matrix-row" data-permission={p} className="group">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 border-t bg-background px-2 py-2 text-left font-normal text-[12.5px] leading-snug group-hover:bg-muted/60 sm:px-3 sm:text-[13px]"
                      >
                        {PERMISSION_DESCRIPTIONS[p]}
                      </th>
                      {ROLES.map((r) => (
                        <Cell key={r} role={r} grant={grantFor(r, p)} />
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="mt-4 flex items-start gap-2 px-2 text-muted-foreground text-xs sm:px-3">
            <span className="inline-flex h-5 items-center rounded-full border border-primary/25 px-1.5 font-medium text-[10px] text-primary">
              Own
            </span>
            Only for your own account, or devices you own or that are shared with you.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
