"use client";

import {
  MODULE_CATALOG,
  type ModuleAccessModuleState,
  type ModuleAccessPerson,
  type ModuleAccessView,
  ModuleId,
  type ModuleInherited,
} from "@ocw/contracts";
import {
  Bot,
  ChevronRight,
  type LucideIcon,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useModuleAccess, useSetModuleAccess } from "@/lib/module-access-queries";
import { useUnits } from "@/lib/org-queries";
import { useCan } from "@/lib/permissions";
import type { UnitNode } from "./unit-meta";

/**
 * The Modules panel (07.3-04, ADR-0024, ACCESS-02, P-06, P-07): Work Zone, AI chats and Bots on or off for everyone in
 * a unit (or the organization) and per person, as the resolver's ordinary deny rules. Everything editable comes from
 * the API's view: `viewerCan` on the unit decides whether the card shows, `canEdit` per person, `inherited` what an
 * ancestor already turned off. The browser never checks a role.
 */

const MODULE_ICONS: Record<ModuleId, LucideIcon> = {
  work_zone: SquareTerminal,
  ai_chats: Sparkles,
  bots: Bot,
};

const ADMIN_ONLY = "Only an organization admin can change modules for an admin.";

const label = (m: ModuleId) => MODULE_CATALOG[m].label;

/** Where a scope is managed: a unit in Settings › Organization, the organization in Settings › Modules. */
export const scopeHref = (scopeUnitId: string | null) =>
  scopeUnitId ? `/settings/organization?unit=${scopeUnitId}` : "/settings/modules";

/** "Off for everyone in Engineering" / "Off for the whole organization" (a partial rule reads "Partly off …"). */
export function inheritedLine(inherited: ModuleInherited): string {
  const off = inherited.state === "off" ? "Off" : "Partly off";
  return inherited.scopeUnitId === null
    ? `${off} for the whole organization`
    : `${off} for everyone in ${inherited.name}`;
}

/** The Bots warning: turning Bots off on a unit silences that unit's own bots for everyone (D-05). */
export const botsWarning = (scopeName: string, n: number) =>
  `${scopeName} has ${n} ${n === 1 ? "bot" : "bots"}. Turning Bots off also stops them for everyone, admins included.`;

const sameInherited = (a: ModuleInherited | null, b: ModuleInherited | null) =>
  a !== null && b !== null && a.scopeUnitId === b.scopeUnitId && a.state === b.state;

/**
 * The chips of a person's exceptions: their own rows at this scope, and what reaches only them from above (what
 * reaches everyone in the scope is shown on the module row, not per person).
 */
export function personChips(person: ModuleAccessPerson, view: ModuleAccessView): string[] {
  const chips: string[] = [];
  for (const own of person.modules) {
    const everyone = view.modules.find((m) => m.module === own.module)?.inherited ?? null;
    if (own.state !== "on") chips.push(`${label(own.module)} ${own.state}`);
    else if (own.inherited && !sameInherited(own.inherited, everyone)) {
      chips.push(`${label(own.module)} ${own.inherited.state} in ${own.inherited.name}`);
    }
  }
  return chips;
}

export interface ModuleAccessPanelProps {
  view: ModuleAccessView;
  scopeName: string;
  /** The module whose PUT is in flight. */
  pending?: ModuleId | null;
  /** Whether the viewer may open that scope's panel (a "Change" link to it). */
  canOpenScope?: (scopeUnitId: string | null) => boolean;
  /** Why a person's modules are read-only for the viewer (`canEdit: false`). */
  readOnlyReason?: (person: ModuleAccessPerson) => string;
  onToggle(module: ModuleId, enabled: boolean): void;
  onEditPerson(userId: string): void;
  onAddPerson(): void;
}

/** Pure rendering of one scope's view. */
export function ModuleAccessPanel({
  view,
  scopeName,
  pending = null,
  canOpenScope = () => false,
  readOnlyReason = () => ADMIN_ONLY,
  onToggle,
  onEditPerson,
  onAddPerson,
}: ModuleAccessPanelProps) {
  const listed = view.people
    .map((p) => ({ person: p, chips: personChips(p, view) }))
    .filter((r) => r.chips.length > 0);
  const scopeWords = view.scope.scopeUnitId === null ? "the organization" : scopeName;

  return (
    <div className="grid gap-6">
      <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs" aria-label="Modules">
        {ModuleId.options.map((id) => {
          const state = view.modules.find((m) => m.module === id) ?? {
            module: id,
            state: "on",
            inherited: null,
          };
          return (
            <ModuleRow
              key={id}
              state={state}
              scopeName={scopeName}
              unitBotCount={view.unitBotCount}
              pending={pending === id}
              canOpenScope={canOpenScope}
              onToggle={(enabled) => onToggle(id, enabled)}
            />
          );
        })}
      </ul>

      <section className="grid gap-3" data-testid="module-people" aria-label="Exceptions for people">
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <h4 className="font-semibold text-sm tracking-tight">Exceptions for people</h4>
            <p className="mt-0.5 text-muted-foreground text-sm">
              Turn a module off for one person in {scopeWords}.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onAddPerson} data-testid="module-add-person">
            <UserPlus /> Add person
          </Button>
        </div>
        {listed.length > 0 ? (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {listed.map(({ person: p, chips }) => (
              <li
                key={p.userId}
                data-testid="module-person"
                data-user-id={p.userId}
                className="flex items-center gap-3 px-4 py-3"
              >
                <UserAvatar name={p.displayName} src={p.avatarUrl} seed={p.userId} className="size-9" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm" title={p.displayName}>
                    {p.displayName}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {chips.map((c) => (
                      <Badge key={c} variant="outline" data-testid="module-chip">
                        {c}
                      </Badge>
                    ))}
                  </div>
                  {p.canEdit ? null : (
                    <p className="mt-1 text-muted-foreground text-xs">{readOnlyReason(p)}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-10 shrink-0 sm:h-8"
                  onClick={() => onEditPerson(p.userId)}
                  aria-label={`${p.canEdit ? "Edit" : "View"} modules for ${p.displayName}`}
                  data-testid="module-person-edit"
                >
                  {p.canEdit ? "Edit" : "View"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed px-4 py-4 text-muted-foreground text-sm">
            No exceptions. Everyone in {scopeWords} follows the switches above.
          </p>
        )}
      </section>

      {view.overrides.length > 0 ? (
        <section
          className="grid gap-3"
          data-testid="module-overrides"
          aria-label={`Turned off inside ${scopeName}`}
        >
          <h4 className="font-semibold text-sm tracking-tight">Turned off inside {scopeName}</h4>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {view.overrides.map((o) => (
              <li key={o.unitId}>
                <Link
                  href={scopeHref(o.unitId)}
                  data-testid="module-override"
                  data-unit-id={o.unitId}
                  className="flex min-h-12 items-center gap-3 px-4 py-3 text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{o.name}</span>
                    <span className="text-muted-foreground"> · {overrideSummary(o.modules)}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** "AI chats off, Bots custom". */
const overrideSummary = (modules: readonly ModuleAccessModuleState[]) =>
  modules
    .filter((m) => m.state !== "on")
    .map((m) => `${label(m.module)} ${m.state}`)
    .join(", ");

function ModuleRow({
  state: s,
  scopeName,
  unitBotCount,
  pending,
  canOpenScope,
  onToggle,
}: {
  state: ModuleAccessModuleState;
  scopeName: string;
  unitBotCount: number;
  pending: boolean;
  canOpenScope: (scopeUnitId: string | null) => boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const def = MODULE_CATALOG[s.module];
  const Icon = MODULE_ICONS[s.module];
  const inherited = s.inherited;
  // Blocked from above with nothing of its own to clear: read-only here.
  const locked = inherited !== null && s.state === "on";
  const checked = s.state === "on" && inherited === null;
  const warn = s.module === "bots" && unitBotCount > 0 && checked;

  return (
    <li
      data-testid="module-row"
      data-module={s.module}
      data-state={s.state}
      className="flex items-start gap-3 px-4 py-3.5"
    >
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-[18px]" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-sm">
          {def.label}
          {s.state === "custom" ? (
            <Badge variant="outline" data-testid="module-custom">
              Custom
            </Badge>
          ) : null}
        </p>
        <p className="mt-0.5 text-muted-foreground text-xs">{def.description}</p>
        {s.state === "custom" ? (
          <p className="mt-1.5 text-muted-foreground text-xs">
            Part of this module is off by a manual rule. Turn it on to clear it.
          </p>
        ) : null}
        {inherited ? (
          <p data-testid="module-inherited" className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
            <span className="font-medium text-foreground/80">{inheritedLine(inherited)}</span>
            {canOpenScope(inherited.scopeUnitId) ? (
              <Link
                href={scopeHref(inherited.scopeUnitId)}
                className="rounded font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                Change
              </Link>
            ) : null}
          </p>
        ) : null}
        {warn ? (
          <p
            data-testid="module-bots-warning"
            className="mt-1.5 flex items-start gap-1.5 text-amber-700 text-xs dark:text-amber-300"
          >
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
            {botsWarning(scopeName, unitBotCount)}
          </p>
        ) : null}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2">
        {pending ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
        <Switch
          checked={checked}
          disabled={locked || pending}
          onCheckedChange={(on) => onToggle(on)}
          aria-label={`${def.label} for everyone in ${scopeName}`}
          data-testid={`module-switch-${s.module}`}
          // A 44 px hit area around the 36 × 20 track (390).
          className="after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']"
        />
      </div>
    </li>
  );
}

/** Data, toggles and dialogs for one scope (`scopeUnitId` null = the organization). */
export function ModuleAccessCard({
  scopeUnitId,
  scopeName,
}: {
  scopeUnitId: string | null;
  scopeName: string;
}) {
  const q = useModuleAccess(scopeUnitId);
  const set = useSetModuleAccess(scopeUnitId);
  const units = useUnits();
  const canManageOrg = useCan("unit.modules.manage");
  const [pending, setPending] = useState<ModuleId | null>(null);
  const [, setEditing] = useState<string | null>(null);
  const [, setAdding] = useState(false);

  const canOpenScope = (id: string | null) =>
    id === null
      ? canManageOrg
      : (units.data?.units.find((u) => u.id === id)?.viewerCan.includes("unit.modules.manage") ?? false);

  const toggle = (module: ModuleId, enabled: boolean) => {
    setPending(module);
    set.mutate(
      { module, subject: { kind: "everyone" }, enabled },
      { onError: (err) => toast.error(errorMessage(err)), onSettled: () => setPending(null) },
    );
  };

  if (q.isLoading) {
    return (
      <div className="grid gap-px overflow-hidden rounded-xl border" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="size-9 rounded-lg" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        ))}
      </div>
    );
  }
  if (!q.data) {
    return (
      <p
        role="alert"
        className="rounded-xl border border-dashed px-4 py-6 text-center text-destructive text-sm"
      >
        {errorMessage(q.error)}
      </p>
    );
  }
  return (
    <ModuleAccessPanel
      view={q.data}
      scopeName={scopeName}
      pending={pending}
      canOpenScope={canOpenScope}
      onToggle={toggle}
      onEditPerson={setEditing}
      onAddPerson={() => setAdding(true)}
    />
  );
}

/**
 * The unit detail's Modules card, for admins and the unit's leads (`unit.modules.manage` in the unit's `viewerCan`,
 * decided by the API). Mounted with one line in `unit-detail.tsx`.
 */
export function UnitModulesCard({ unit }: { unit: UnitNode }) {
  if (!unit.viewerCan.includes("unit.modules.manage")) return null;
  return (
    <section className="grid gap-3" data-testid="module-access" aria-label={`Modules in ${unit.name}`}>
      <div className="min-w-0">
        <h3 className="font-semibold text-[15px] tracking-tight">Modules</h3>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Turn Work Zone, AI chats and bots on or off for everyone in {unit.name} and everything inside it.
          Off hides the module and the API refuses it.
        </p>
      </div>
      <ModuleAccessCard scopeUnitId={unit.id} scopeName={unit.name} />
    </section>
  );
}
