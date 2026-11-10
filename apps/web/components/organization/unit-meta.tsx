import type { OrgUnit, UnitKind } from "@ocw/contracts";
import { Building2, FolderKanban, type LucideIcon, Users } from "lucide-react";
import { cn } from "@/lib/utils";

/** Presentation of the three hierarchy kinds (hierarchy projects are org units, not Work Zone repos). */
export const KIND_META: Record<
  UnitKind,
  { label: string; plural: string; icon: LucideIcon; tone: string; placeholder: string; blurb: string }
> = {
  department: {
    label: "Department",
    plural: "departments",
    icon: Building2,
    tone: "bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
    placeholder: "e.g. Engineering",
    blurb: "Departments hold teams, projects and other departments.",
  },
  team: {
    label: "Team",
    plural: "teams",
    icon: Users,
    tone: "bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    placeholder: "e.g. Backend",
    blurb: "Teams group people who work together. They can hold sub-teams and projects.",
  },
  project: {
    label: "Project",
    plural: "projects",
    icon: FolderKanban,
    tone: "bg-amber-500/14 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
    placeholder: "e.g. Customer portal",
    blurb: "Projects are the leaves of the tree: the people working on one initiative.",
  },
};

const KIND_ORDER: Record<UnitKind, number> = { department: 0, team: 1, project: 2 };

export function KindIcon({
  kind,
  size = "sm",
  className,
}: {
  kind: UnitKind;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { icon: Icon, tone } = KIND_META[kind];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "sm" && "size-6 rounded-md [&_svg]:size-3.5",
        size === "md" && "size-8 rounded-lg [&_svg]:size-4",
        size === "lg" && "size-11 rounded-xl [&_svg]:size-5",
        tone,
        className,
      )}
    >
      <Icon />
    </span>
  );
}

/**
 * A team's or department's `@handle` in muted mono (07.17 D-14), after its name; nothing for projects (never
 * mentionable) or units from an older server. Truncates inside a `min-w-0` row.
 */
export function UnitHandle({
  unit,
  className,
}: {
  unit: Pick<OrgUnit, "kind" | "handle">;
  className?: string;
}) {
  if (unit.kind === "project" || !unit.handle) return null;
  return (
    <span
      data-testid="unit-handle"
      title="Mention handle"
      className={cn("min-w-0 truncate font-mono font-normal text-[11.5px] text-muted-foreground", className)}
    >
      {`@${unit.handle}`}
    </span>
  );
}

export function kindCount(kind: UnitKind, n: number): string {
  return `${n} ${n === 1 ? KIND_META[kind].label.toLowerCase() : KIND_META[kind].plural}`;
}

export interface UnitNode extends OrgUnit {
  children: UnitNode[];
  depth: number;
}

export interface UnitTreeModel {
  roots: UnitNode[];
  byId: Map<string, UnitNode>;
  /** Every node, depth-first in display order. */
  ordered: UnitNode[];
}

function compareUnits(a: OrgUnit, b: OrgUnit): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
  );
}

/** Flat API list → tree sorted by kind, then name. Units whose parent is unknown are shown at the top. */
export function buildTree(units: readonly OrgUnit[]): UnitTreeModel {
  const byId = new Map<string, UnitNode>();
  for (const u of units) byId.set(u.id, { ...u, children: [], depth: 0 });
  const roots: UnitNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const ordered: UnitNode[] = [];
  const walk = (nodes: UnitNode[], depth: number) => {
    nodes.sort(compareUnits);
    for (const n of nodes) {
      n.depth = depth;
      ordered.push(n);
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return { roots, byId, ordered };
}

/** Ancestor names root → parent (the unit itself excluded). */
export function ancestorsOf(unit: OrgUnit, byId: Map<string, OrgUnit>): OrgUnit[] {
  return unit.path
    .slice(0, -1)
    .map((id) => byId.get(id))
    .filter((u): u is OrgUnit => u !== undefined);
}

export const canManageUnit = (u: OrgUnit) => u.viewerCan.includes("unit.manage");
export const canStaffUnit = (u: OrgUnit) => u.viewerCan.includes("unit.members.manage");
