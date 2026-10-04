import { type OrgRole, ROLE_LABELS } from "@ocw/contracts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Admins and leads stand out; everyone else reads as a quiet outline. Presentation only, not policy. */
const ROLE_VARIANT: Record<OrgRole, "brand" | "outline"> = {
  admin: "brand",
  lead: "brand",
  developer: "outline",
  standard: "outline",
};

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
        "inline-flex h-5 shrink-0 items-center rounded-full border border-destructive/30 bg-destructive/10 px-1.5 font-medium text-[10.5px] text-destructive dark:border-destructive/45 dark:bg-destructive/20 dark:text-red-300",
        className,
      )}
    >
      Deactivated
    </span>
  );
}
