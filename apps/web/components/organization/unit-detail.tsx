"use client";

import { ROLE_LABELS, ROLE_RANK, type UnitMember, UnitRole } from "@ocw/contracts";
import {
  ChevronDown,
  ChevronRight,
  Crown,
  Plus,
  SquareTerminal,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import Link from "next/link";
import { type ElementType, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { ProjectDefaultSwitch } from "@/components/work-zone/projects/project-default-switch";
import { ProjectReposSection } from "@/components/work-zone/projects/project-repos-section";
import { ProjectTeamsSection } from "@/components/work-zone/projects/project-teams-section";
import { ListError, ListSkeleton } from "@/components/work-zone/projects/settings-list";
import { errorMessage, isApiError } from "@/lib/api";
import { useRemoveUnitMember, useUnitMembers, useUpdateUnitMember } from "@/lib/org-queries";
import { useCan } from "@/lib/permissions";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWorkProject, useWorkProjectsLive } from "@/lib/work-project-queries";
import { projectHref } from "@/lib/work-zone-routes";
import { AddPeopleDialog } from "./add-people-dialog";
import { UnitModulesCard } from "./module-access-card";
import { RecordTemplatesCard } from "./record-templates-card";
import { UnitActionsMenu, useUnitDialogs } from "./unit-dialogs";
import {
  ancestorsOf,
  canManageUnit,
  canStaffUnit,
  KIND_META,
  KindIcon,
  kindCount,
  type UnitNode,
  type UnitTreeModel,
} from "./unit-meta";
import { UnitRulesCard } from "./unit-rules-card";
import { childKinds } from "./unit-tree";

/** Unit-membership role (data about the member), not an authorization check: those come from viewerCan. */
const leadsUnit = (m: UnitMember) => m.role === UnitRole.enum.lead;

export const LEAD_INELIGIBLE_HINT = "Only Team Leads or Organization Admins can lead a unit";

/** Removing someone from a project also hides its sessions from them (07.9 R9, U-8). */
export const removeFromProjectSentence = (project: string) =>
  `They also stop seeing ${project}'s sessions unless a team still gives them access.`;

/**
 * The selected unit: where it sits, what it holds, its people and (for admins) the access rules scoped to
 * it. Controls render from the unit's `viewerCan`: unit.manage (structure, Lead toggle, removing a lead)
 * and unit.members.manage (Add people, remove a member). The API re-decides every action.
 */
export function UnitDetail({
  unit,
  tree,
  onSelect,
  titleAs: Title = "h2",
  closeButton,
}: {
  unit: UnitNode;
  tree: UnitTreeModel;
  onSelect: (id: string) => void;
  /** The sheet passes its accessible title component. */
  titleAs?: ElementType;
  /** The sheet's close button, grouped with the actions menu. */
  closeButton?: ReactNode;
}) {
  const me = useMe({ enabled: false });
  const canReadRules = useCan("rule.read");
  const ancestors = ancestorsOf(unit, tree.byId);
  const meta = KIND_META[unit.kind];
  const createKinds = childKinds(unit.kind);

  return (
    <div data-testid="unit-detail" data-unit-id={unit.id} className="grid gap-7">
      <header className="flex items-start gap-4">
        <KindIcon kind={unit.kind} size="lg" />
        <div className="min-w-0 flex-1">
          <nav
            aria-label="Location"
            className="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground text-xs"
          >
            <span className="truncate">{me.data?.organization.name ?? "Organization"}</span>
            {ancestors.map((a) => (
              <span key={a.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight aria-hidden className="size-3 shrink-0 opacity-60" />
                <button
                  type="button"
                  onClick={() => onSelect(a.id)}
                  className="max-w-[10rem] truncate rounded hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {a.name}
                </button>
              </span>
            ))}
          </nav>
          <Title
            data-testid="unit-detail-name"
            className="mt-1 break-words font-semibold text-xl tracking-tight"
          >
            {unit.name}
          </Title>
          <p className="mt-0.5 text-muted-foreground text-sm">{meta.label}</p>
        </div>
        <div className="-mt-1 flex shrink-0 items-center gap-1">
          <UnitActionsMenu
            unit={unit}
            createKinds={createKinds}
            variant="outline"
            className="size-10 lg:size-9"
          />
          {closeButton}
        </div>
      </header>

      <dl className="grid grid-cols-3 divide-x rounded-xl border bg-card shadow-xs">
        <Stat label="Members" value={unit.memberCount} />
        <Stat label="Leads" value={unit.leadCount} />
        <Stat label="Inside" value={unit.children.length} />
      </dl>

      {unit.children.length > 0 || (canManageUnit(unit) && createKinds.length > 0) ? (
        <ChildrenSection unit={unit} createKinds={createKinds} onSelect={onSelect} />
      ) : null}

      <MembersSection unit={unit} />
      {unit.kind === "project" ? <ProjectUnitSections unit={unit} /> : null}
      <UnitModulesCard unit={unit} />
      <RecordTemplatesCard unit={unit} />

      {canReadRules ? <UnitRulesCard unit={unit} /> : null}
    </div>
  );
}

/**
 * A project unit's Teams and Work Zone sections (07.9 Surface 5): the same components as the Work Zone project page's
 * Settings tab, fed by the same `GET /work-projects/:unitId`, so a change in one place is the change in the other.
 * Whoever the API does not answer (no access and no management, or the Work Zone off) gets nothing here, never an error.
 */
function ProjectUnitSections({ unit }: { unit: UnitNode }) {
  const project = useWorkProject(unit.id);
  useWorkProjectsLive();
  if (project.data) {
    const p = project.data;
    return (
      <>
        <ProjectTeamsSection project={p} />
        <section className="grid gap-5" data-testid="org-unit-workzone" aria-label="Work Zone">
          <div className="grid gap-3">
            <SectionHeader
              title="Work Zone"
              action={
                <Link
                  href={projectHref(p.id)}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-md:h-11")}
                >
                  <SquareTerminal /> Open in Work Zone
                </Link>
              }
            />
            <ProjectDefaultSwitch project={p} />
          </div>
          <ProjectReposSection project={p} />
        </section>
      </>
    );
  }
  if (project.isError) {
    if ([400, 403, 404].some((status) => isApiError(project.error, status))) return null;
    return (
      <section className="grid gap-3" aria-label="Work Zone">
        <SectionHeader title="Work Zone" />
        <ListError
          message="Couldn't load this project's Work Zone settings."
          onRetry={() => project.refetch()}
          retrying={project.isFetching}
        />
      </section>
    );
  }
  return (
    <section className="grid gap-3" aria-label="Teams">
      <SectionHeader title="Teams" />
      <ListSkeleton />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 font-semibold text-lg tabular-nums tracking-tight">{value}</dd>
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  count,
  action,
}: {
  title: string;
  description?: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 font-semibold text-[15px] tracking-tight">
          {title}
          {count !== undefined ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </h3>
        {description ? <p className="mt-0.5 text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 gap-2">{action}</div> : null}
    </div>
  );
}

function ChildrenSection({
  unit,
  createKinds,
  onSelect,
}: {
  unit: UnitNode;
  createKinds: ReturnType<typeof childKinds>;
  onSelect: (id: string) => void;
}) {
  const manage = canManageUnit(unit);
  const counts = (["department", "team", "project"] as const)
    .map((k) => [k, unit.children.filter((c) => c.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => kindCount(k, n))
    .join(" · ");

  return (
    <section className="grid gap-3" aria-label={`Inside ${unit.name}`}>
      <SectionHeader
        title="Inside"
        description={counts || `Nothing inside ${unit.name} yet.`}
        action={manage && createKinds.length > 0 ? <AddChildMenu unit={unit} kinds={createKinds} /> : null}
      />
      {unit.children.length > 0 ? (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {unit.children.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                data-testid="unit-child"
                className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/60"
              >
                <KindIcon kind={c.kind} />
                <span className="min-w-0 flex-1 truncate font-medium text-sm" title={c.name}>
                  {c.name}
                </span>
                <span className="flex items-center gap-1 text-muted-foreground text-xs tabular-nums">
                  <Users className="size-3" />
                  {c.memberCount}
                </span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AddChildMenu({ unit, kinds }: { unit: UnitNode; kinds: ReturnType<typeof childKinds> }) {
  const dialogs = useUnitDialogs();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            data-testid="add-child"
            aria-label={`Add inside ${unit.name}`}
          />
        }
      >
        <Plus /> Add
        <ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {kinds.map((k) => {
          const Icon = KIND_META[k].icon;
          return (
            <DropdownMenuItem key={k} onClick={() => dialogs.open({ type: "create", kind: k, parent: unit })}>
              <Icon /> {KIND_META[k].label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MembersSection({ unit }: { unit: UnitNode }) {
  const members = useUnitMembers(unit.id);
  const me = useMe({ enabled: false });
  const [adding, setAdding] = useState(false);
  const staff = canStaffUnit(unit);
  const list = members.data?.members ?? [];
  // Leads first, then by name (the API orders by name).
  const sorted = [...list].sort((a, b) => Number(leadsUnit(b)) - Number(leadsUnit(a)));

  return (
    <section className="grid gap-3" data-testid="unit-members" aria-label={`People in ${unit.name}`}>
      <SectionHeader
        title="People"
        count={members.data ? list.length : undefined}
        description={`Direct members of this ${KIND_META[unit.kind].label.toLowerCase()} and who leads it.`}
        action={
          staff ? (
            <Button size="sm" onClick={() => setAdding(true)} data-testid="add-people">
              <UserPlus /> Add people
            </Button>
          ) : null
        }
      />
      {members.isLoading ? (
        <div className="grid gap-px overflow-hidden rounded-xl border">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-9 rounded-full" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          ))}
        </div>
      ) : members.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-dashed px-4 py-6 text-center text-destructive text-sm"
        >
          {errorMessage(members.error)}
        </p>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Users className="size-5" />
          </span>
          <p className="font-medium text-sm">No one in {unit.name} yet</p>
          <p className="max-w-sm text-balance text-muted-foreground text-sm">
            People you add get the access scoped to this {KIND_META[unit.kind].label.toLowerCase()} and
            everything inside it.
          </p>
          {staff ? (
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setAdding(true)}>
              <UserPlus /> Add people
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {sorted.map((m) => (
            <MemberRow key={m.userId} unit={unit} member={m} isMe={m.userId === me.data?.user.id} />
          ))}
        </ul>
      )}
      {staff ? (
        <AddPeopleDialog
          open={adding}
          onOpenChange={setAdding}
          unit={unit}
          existing={list.map((m) => m.userId)}
        />
      ) : null}
    </section>
  );
}

function MemberRow({ unit, member: m, isMe }: { unit: UnitNode; member: UnitMember; isMe: boolean }) {
  const update = useUpdateUnitMember(unit.id);
  const remove = useRemoveUnitMember(unit.id);
  const [confirm, setConfirm] = useState(false);
  const manage = canManageUnit(unit);
  const isLead = leadsUnit(m);
  // Removing a lead takes lead authority away: the same decision as appointing one (unit.manage).
  const canRemove = canStaffUnit(unit) && (!isLead || manage);
  // D-06 target eligibility (data about the member, not the viewer); the API answers lead_requires_role.
  const eligible = ROLE_RANK[m.orgRole] >= ROLE_RANK.lead;

  const toggle = (lead: boolean) =>
    update.mutate(
      { userId: m.userId, role: lead ? "lead" : "member" },
      {
        onSuccess: () =>
          toast.success(
            lead ? `${m.displayName} now leads ${unit.name}` : `${m.displayName} is no longer a lead`,
          ),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  const leadSwitch = (
    <Switch
      checked={isLead}
      disabled={!eligible || update.isPending}
      onCheckedChange={toggle}
      aria-label={`${m.displayName} leads ${unit.name}`}
      data-testid="lead-switch"
    />
  );

  return (
    <li
      data-testid="unit-member"
      data-user-id={m.userId}
      data-role={m.role}
      className="flex items-center gap-3 px-4 py-3"
    >
      <UserAvatar name={m.displayName} src={m.avatarUrl} seed={m.userId} className="size-9" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-medium text-sm" title={m.displayName}>
            {m.displayName}
            {isMe ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
          </p>
          <Badge variant={isLead ? "brand" : "outline"} data-testid="unit-role">
            {isLead ? <Crown /> : null}
            {isLead ? "Lead" : "Member"}
          </Badge>
        </div>
        <p className="truncate text-muted-foreground text-xs">
          {ROLE_LABELS[m.orgRole]}
          {m.status === "deactivated" ? " · Deactivated" : ""}
        </p>
      </div>
      {manage ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs">Lead</span>
          {eligible ? (
            leadSwitch
          ) : (
            <Tooltip content={LEAD_INELIGIBLE_HINT}>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable wrapper so keyboard users get the tooltip of the disabled switch */}
              <span tabIndex={0} data-testid="lead-switch-wrapper" className="inline-flex rounded-full">
                {leadSwitch}
              </span>
            </Tooltip>
          )}
        </div>
      ) : null}
      {canRemove ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${m.displayName} from ${unit.name}`}
          data-testid="remove-member"
          className="size-10 shrink-0 text-muted-foreground hover:text-destructive sm:size-8"
          onClick={() => setConfirm(true)}
        >
          <UserMinus />
        </Button>
      ) : null}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent data-testid="remove-member-dialog">
          <DialogHeader>
            <DialogTitle>
              Remove {m.displayName} from {unit.name}?
            </DialogTitle>
            <DialogDescription>
              They lose the access they get through this {KIND_META[unit.kind].label.toLowerCase()}. Their
              account and other memberships are not affected.
              {unit.kind === "project" ? ` ${removeFromProjectSentence(unit.name)}` : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              data-testid="confirm-remove-member"
              onClick={() =>
                remove.mutate(m.userId, {
                  onSuccess: () => {
                    setConfirm(false);
                    toast.success(`${m.displayName} removed from ${unit.name}`);
                  },
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            >
              {remove.isPending ? <Spinner /> : <UserMinus />} Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
