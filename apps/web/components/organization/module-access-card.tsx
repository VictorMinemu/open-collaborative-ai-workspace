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
  Blocks,
  Bot,
  ChevronRight,
  Container,
  type LucideIcon,
  MonitorPlay,
  NotebookText,
  Search,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage, isApiError } from "@/lib/api";
import { useModuleAccess, useSetModuleAccess } from "@/lib/module-access-queries";
import { moduleNames } from "@/lib/modules";
import { useUnits } from "@/lib/org-queries";
import { useCan } from "@/lib/permissions";
import { useMe, useMembers } from "@/lib/queries";
import type { UnitNode } from "./unit-meta";

/**
 * The Modules panel (07.3-04, ADR-0024, ACCESS-02, P-06, P-07): each module of the catalog on or off for everyone in
 * a unit (or the organization) and per person, as the resolver's ordinary deny rules. Everything editable comes from
 * the API's view: `viewerCan` on the unit decides whether the card shows, `canEdit` per person, `inherited` what an
 * ancestor already turned off. The browser never decides by role: a member's role is read only to word why their row
 * is read-only.
 */

const MODULE_ICONS: Record<ModuleId, LucideIcon> = {
  work_zone: SquareTerminal,
  ai_chats: Sparkles,
  bots: Bot,
  memory: NotebookText,
  // Phase 07.8 (UI-SPEC §4.1, P-02): rows like every module, with the organization switch's hint below.
  sandbox: Container,
  browser: MonitorPlay,
};

/** D-12, P-02: Sandbox and Browser run only while the organization switch in Settings › Sandbox & Browser is on. */
export const ORG_SWITCH_HINT = "Runs only when Sandbox & Browser is on for the organization.";
/** U-1: a unit can never turn on what the organization turned off (deny wins); this says how to get "one team only". */
export const ONE_TEAM_HINT =
  "To turn it on for one team, turn it on for the organization, then off for the teams that shouldn't have it.";
const ORG_SWITCHED: ReadonlySet<ModuleId> = new Set<ModuleId>(["sandbox", "browser"]);

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

/** "the organization" or the unit's name, inside a sentence. */
const scopeWords = (view: ModuleAccessView, scopeName: string) =>
  view.scope.scopeUnitId === null ? "the organization" : scopeName;

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

/**
 * What to confirm before turning `module` off for everyone, or null to toggle at once: always at organization scope
 * (it reaches every admin, the caller included), and on a unit for Bots when the unit owns bots (they stop for
 * everyone).
 */
export function offConfirmation(
  view: ModuleAccessView,
  module: ModuleId,
  scopeName: string,
): { title: string; body: string } | null {
  const l = label(module);
  if (view.scope.scopeUnitId === null) {
    return {
      title: `Turn ${l} off for everyone?`,
      body: `Everyone in the organization loses ${l} right away, admins included. Turning it back on restores it.`,
    };
  }
  if (module === "bots" && view.unitBotCount > 0) {
    return {
      title: `Turn Bots off for everyone in ${scopeName}?`,
      body: botsWarning(scopeName, view.unitBotCount),
    };
  }
  return null;
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
  const words = scopeWords(view, scopeName);

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
              Turn a module off for one person in {words}.
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
            No exceptions. Everyone in {words} follows the switches above.
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
        {ORG_SWITCHED.has(s.module) ? (
          <p className="mt-0.5 text-muted-foreground text-xs" data-testid="module-org-hint">
            {ORG_SWITCH_HINT}
          </p>
        ) : null}
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
        {locked && inherited?.scopeUnitId === null && ORG_SWITCHED.has(s.module) ? (
          <p className="mt-1 text-muted-foreground text-xs" data-testid="module-unit-hint">
            {ONE_TEAM_HINT}
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
  const members = useMembers();
  const canManageOrg = useCan("unit.modules.manage");
  const [pending, setPending] = useState<ModuleId | null>(null);
  const [confirm, setConfirm] = useState<ModuleId | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const canOpenScope = (id: string | null) =>
    id === null
      ? canManageOrg
      : (units.data?.units.find((u) => u.id === id)?.viewerCan.includes("unit.modules.manage") ?? false);

  // Wording only: the API decided `canEdit`; the member's role says whether "an admin" is the right word.
  const roles = new Map((members.data?.members ?? []).map((m) => [m.userId, m.role]));
  const readOnlyReason = (p: ModuleAccessPerson) =>
    roles.get(p.userId) === "admin"
      ? ADMIN_ONLY
      : `Only an organization admin can change modules for ${p.displayName}.`;

  const apply = (module: ModuleId, enabled: boolean) => {
    setPending(module);
    set.mutate(
      { module, subject: { kind: "everyone" }, enabled },
      { onError: (err) => toast.error(errorMessage(err)), onSettled: () => setPending(null) },
    );
  };
  const toggle = (module: ModuleId, enabled: boolean) => {
    if (!enabled && q.data && offConfirmation(q.data, module, scopeName)) setConfirm(module);
    else apply(module, enabled);
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
    if (scopeUnitId === null && isApiError(q.error, 403)) {
      return (
        <div
          data-testid="module-access-forbidden"
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Blocks className="size-5" />
          </span>
          <p className="max-w-sm text-balance text-muted-foreground text-sm">
            Only organization admins manage modules here. Team leads: Settings › Organization.
          </p>
        </div>
      );
    }
    return (
      <p
        role="alert"
        className="rounded-xl border border-dashed px-4 py-6 text-center text-destructive text-sm"
      >
        {errorMessage(q.error)}
      </p>
    );
  }

  const view = q.data;
  const confirmCopy = confirm ? offConfirmation(view, confirm, scopeName) : null;
  const person = editing ? (view.people.find((p) => p.userId === editing) ?? null) : null;

  return (
    <>
      <ModuleAccessPanel
        view={view}
        scopeName={scopeName}
        pending={pending}
        canOpenScope={canOpenScope}
        readOnlyReason={readOnlyReason}
        onToggle={toggle}
        onEditPerson={setEditing}
        onAddPerson={() => setAdding(true)}
      />

      <Dialog open={confirmCopy !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
        <DialogContent data-testid="module-confirm">
          <DialogHeader>
            <DialogTitle>{confirmCopy?.title}</DialogTitle>
            <DialogDescription>{confirmCopy?.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="module-confirm-off"
              onClick={() => {
                if (confirm) apply(confirm, false);
                setConfirm(null);
              }}
            >
              Turn off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddPersonDialog
        open={adding}
        onOpenChange={setAdding}
        view={view}
        scopeName={scopeName}
        onPick={(userId) => {
          setAdding(false);
          setEditing(userId);
        }}
      />

      <PersonModulesDialog
        person={person}
        view={view}
        scopeName={scopeName}
        scopeUnitId={scopeUnitId}
        readOnlyReason={readOnlyReason}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

/** People of the scope with every module on: picking one opens "Modules for <name>". */
function AddPersonDialog({
  open,
  onOpenChange,
  view,
  scopeName,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ModuleAccessView;
  scopeName: string;
  onPick: (userId: string) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const q = query.trim().toLowerCase();
  const pickable = view.people.filter((p) => p.modules.every((m) => m.state === "on"));
  const candidates = pickable
    .filter((p) => !q || p.displayName.toLowerCase().includes(q))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="module-add-person-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">Add an exception</DialogTitle>
          <DialogDescription>
            Pick someone in {scopeWords(view, scopeName)}, then choose which modules they lose.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by name"
            aria-label="Search people"
            data-testid="module-person-search"
            className="h-10 pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <DialogBody className="-mt-1 min-h-40">
          {candidates.length === 0 ? (
            <p className="px-2 py-10 text-center text-muted-foreground text-sm">
              {pickable.length > 0
                ? `No one matches “${query.trim()}”`
                : `Everyone in ${scopeWords(view, scopeName)} already has an exception`}
            </p>
          ) : (
            <ul className="grid gap-0.5" aria-label="People">
              {candidates.map((p) => (
                <li key={p.userId}>
                  <button
                    type="button"
                    onClick={() => onPick(p.userId)}
                    data-testid="module-pick-person"
                    data-user-id={p.userId}
                    className="group flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
                  >
                    <UserAvatar name={p.displayName} src={p.avatarUrl} seed={p.userId} className="size-9" />
                    <span className="min-w-0 flex-1 truncate font-medium text-sm">{p.displayName}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Why a person cannot get a module back here: off for everyone in this scope (the scope's own row, 07.3-02 open item
 * 1), off for everyone above, or off for them above. Null when nothing above or here blocks it.
 */
function blockedFor(
  own: ModuleAccessModuleState,
  everyone: ModuleAccessModuleState | undefined,
  view: ModuleAccessView,
  scopeName: string,
): string | null {
  if (everyone && everyone.state !== "on") {
    const off = everyone.state === "off" ? "Off" : "Partly off";
    return view.scope.scopeUnitId === null
      ? `${off} for the whole organization`
      : `${off} for everyone in ${scopeName}`;
  }
  if (everyone?.inherited) return inheritedLine(everyone.inherited);
  if (own.inherited) {
    const off = own.inherited.state === "off" ? "Off" : "Partly off";
    return own.inherited.scopeUnitId === null
      ? `${off} for them in the whole organization`
      : `${off} for them in ${own.inherited.name}`;
  }
  return null;
}

function PersonModulesDialog({
  person,
  view,
  scopeName,
  scopeUnitId,
  readOnlyReason,
  onClose,
}: {
  person: ModuleAccessPerson | null;
  view: ModuleAccessView;
  scopeName: string;
  scopeUnitId: string | null;
  readOnlyReason: (p: ModuleAccessPerson) => string;
  onClose: () => void;
}) {
  const set = useSetModuleAccess(scopeUnitId);
  const [pending, setPending] = useState<ModuleId | null>(null);

  const toggle = (module: ModuleId, enabled: boolean) => {
    if (!person) return;
    setPending(module);
    set.mutate(
      { module, subject: { kind: "user", userId: person.userId }, enabled },
      { onError: (err) => toast.error(errorMessage(err)), onSettled: () => setPending(null) },
    );
  };

  return (
    <Dialog open={person !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent data-testid="module-person-dialog" className="sm:max-w-lg">
        {person ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">Modules for {person.displayName}</DialogTitle>
              <DialogDescription>
                Off here applies to {person.displayName} in {scopeWords(view, scopeName)} and wins over any
                role. Everyone else keeps the module.
              </DialogDescription>
            </DialogHeader>
            {person.canEdit ? null : (
              <p
                data-testid="module-person-readonly"
                className="rounded-lg border bg-muted/50 px-3 py-2.5 text-muted-foreground text-sm"
              >
                {readOnlyReason(person)}
              </p>
            )}
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
              {ModuleId.options.map((id) => {
                const own = person.modules.find((m) => m.module === id) ?? {
                  module: id,
                  state: "on",
                  inherited: null,
                };
                const blocked = blockedFor(
                  own,
                  view.modules.find((m) => m.module === id),
                  view,
                  scopeName,
                );
                const Icon = MODULE_ICONS[id];
                const checked = own.state === "on" && blocked === null;
                return (
                  <li
                    key={id}
                    data-testid="person-module-row"
                    data-module={id}
                    data-state={own.state}
                    className="flex items-start gap-3 px-4 py-3"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="size-4" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-sm">
                        {label(id)}
                        {own.state === "custom" ? <Badge variant="outline">Custom</Badge> : null}
                      </p>
                      {blocked ? (
                        <p className="mt-0.5 text-muted-foreground text-xs">{blocked}</p>
                      ) : own.state === "custom" ? (
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Part of this module is off by a manual rule. Turn it on to clear it.
                        </p>
                      ) : (
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          {MODULE_CATALOG[id].description}
                        </p>
                      )}
                    </div>
                    <div className="flex h-8 shrink-0 items-center gap-2">
                      {pending === id ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
                      <Switch
                        checked={checked}
                        disabled={
                          !person.canEdit || pending === id || (blocked !== null && own.state === "on")
                        }
                        onCheckedChange={(on) => toggle(id, on)}
                        aria-label={`${label(id)} for ${person.displayName}`}
                        data-testid={`person-module-switch-${id}`}
                        className="after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Settings › Modules: the organization scope, for admins (the API answers 403 to anyone else). */
export function OrganizationModulesCard() {
  const me = useMe({ enabled: false });
  const name = me.data?.organization.name ?? "the organization";
  return (
    <section className="grid gap-3" data-testid="module-access" aria-label="Modules for the organization">
      <div className="min-w-0">
        <h2 className="font-semibold text-[15px] tracking-tight">Everyone in {name}</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Turn {moduleNames()} on or off for the whole organization, admins included. Off hides the module and
          the API refuses it.
        </p>
      </div>
      <ModuleAccessCard scopeUnitId={null} scopeName={name} />
    </section>
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
          Turn {moduleNames()} on or off for everyone in {unit.name} and everything inside it. Off hides the
          module and the API refuses it.
        </p>
      </div>
      <ModuleAccessCard scopeUnitId={unit.id} scopeName={unit.name} />
    </section>
  );
}
