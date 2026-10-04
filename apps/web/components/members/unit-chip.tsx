import type { MemberUnitRef, UnitKind, UnitRole } from "@ocw/contracts";
import { Building2, FolderKanban, type LucideIcon, Users } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export const UNIT_KIND_ICON: Record<UnitKind, LucideIcon> = {
  department: Building2,
  team: Users,
  project: FolderKanban,
};

export const UNIT_KIND_LABEL: Record<UnitKind, string> = {
  department: "Department",
  team: "Team",
  project: "Project",
};

/** Unit-level role tag (a unit lead, not the organization role). */
export const UNIT_ROLE_TAG: Record<UnitRole, string | null> = { lead: "Lead", member: null };

const KIND_ORDER: Record<UnitKind, number> = { department: 0, team: 1, project: 2 };

/** Units the member leads first, then departments → teams → projects, then by name. */
export function sortUnits(units: readonly MemberUnitRef[]): MemberUnitRef[] {
  return [...units].sort(
    (a, b) =>
      Number(UNIT_ROLE_TAG[b.role] !== null) - Number(UNIT_ROLE_TAG[a.role] !== null) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name),
  );
}

/** Department / team / project a member belongs to; links to the unit on the Organization page. */
export function UnitChip({ unit, className }: { unit: MemberUnitRef; className?: string }) {
  const Icon = UNIT_KIND_ICON[unit.kind];
  const tag = UNIT_ROLE_TAG[unit.role];
  return (
    <Link
      href={`/settings/organization?unit=${unit.unitId}`}
      data-testid="member-unit-chip"
      title={`${UNIT_KIND_LABEL[unit.kind]}${tag ? ` · ${tag}` : ""}`}
      className={cn(
        "inline-flex h-6 max-w-44 items-center gap-1 rounded-md border bg-background px-1.5 text-[11.5px] text-muted-foreground outline-none transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{unit.name}</span>
      {tag ? (
        <span className="shrink-0 rounded-[4px] bg-brand-soft px-1 font-semibold text-[9.5px] text-brand-soft-foreground uppercase tracking-wider">
          {tag}
        </span>
      ) : null}
    </Link>
  );
}
