"use client";

import type { OrgUnit, UnitKind } from "@ocw/contracts";
import { ArrowRight, MousePointerClick, Network, Plus, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useUnits, useUnitsLive } from "@/lib/org-queries";
import { useCan } from "@/lib/permissions";
import { UnitDetail } from "./unit-detail";
import { UnitDialogsProvider, useUnitDialogs } from "./unit-dialogs";
import { buildTree, KIND_META, KindIcon, kindCount, type UnitNode, type UnitTreeModel } from "./unit-meta";
import { UnitTree } from "./unit-tree";

/**
 * Settings › Organization: the hierarchy as an indented tree, with the selected unit's detail beside it
 * (≥ 1024 px) or in a bottom sheet (below). Selection lives in `?unit=<id>` so units can be deep-linked.
 */
export function OrgStructure() {
  const units = useUnits();
  useUnitsLive();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const isLg = useMediaQuery("(min-width: 1024px)", true);
  const canCreateTop = useCan("unit.manage");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const tree = useMemo(() => buildTree(units.data?.units ?? []), [units.data]);
  const selectedId = params.get("unit");
  const selected = selectedId ? (tree.byId.get(selectedId) ?? null) : null;
  // The sheet keeps showing the last unit while it slides away.
  const lastSelected = useRef<UnitNode | null>(null);
  if (selected) lastSelected.current = selected;

  const select = useCallback(
    (id: string | null) => router.replace(id ? `${pathname}?unit=${id}` : pathname, { scroll: false }),
    [router, pathname],
  );

  const expandPath = useCallback((unit: OrgUnit) => {
    setCollapsed((prev) => {
      if (!unit.path.slice(0, -1).some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of unit.path.slice(0, -1)) next.delete(id);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string, expand?: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const open = expand ?? next.has(id);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // A deep link or a selection made from the detail reveals the unit in the tree.
  useEffect(() => {
    if (selected) expandPath(selected);
  }, [selected, expandPath]);

  // The selected unit was deleted (here or by someone else): drop the stale selection.
  useEffect(() => {
    if (units.data && selectedId && !tree.byId.has(selectedId)) select(null);
  }, [units.data, selectedId, tree, select]);

  const onCreated = useCallback(
    (unit: OrgUnit) => {
      expandPath(unit);
      // On phones the detail is a sheet: do not cover the tree after every create.
      if (isLg) select(unit.id);
    },
    [isLg, select, expandPath],
  );

  const onDeleted = useCallback(
    (unit: OrgUnit) => {
      if (unit.id === selectedId) select(isLg ? unit.parentId : null);
    },
    [isLg, select, selectedId],
  );

  const sheetUnit = selected ?? lastSelected.current;
  // The sheet focuses its content on open, not the first button (no stray focus ring on the close button).
  const sheetBody = useRef<HTMLDivElement>(null);

  return (
    <UnitDialogsProvider tree={tree} onCreated={onCreated} onMoved={expandPath} onDeleted={onDeleted}>
      <div data-testid="org-structure" className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {units.isError ? (
          <ServerUnreachable onRetry={() => units.refetch()} retrying={units.isFetching} className="flex-1" />
        ) : units.isLoading ? (
          <TreeSkeleton />
        ) : tree.roots.length === 0 ? (
          <OrgEmpty canCreate={canCreateTop} />
        ) : (
          <>
            <section
              aria-label="Structure"
              className="mx-auto flex w-full max-w-3xl flex-col lg:mx-0 lg:min-h-0 lg:w-80 lg:max-w-none lg:shrink-0 lg:border-r"
            >
              <StructureHeader tree={tree} canCreate={canCreateTop} />
              <div className="scrollbar-thin px-2 pb-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pb-3">
                <UnitTree
                  roots={tree.roots}
                  selectedId={selectedId}
                  collapsed={collapsed}
                  onSelect={select}
                  onToggle={toggle}
                />
                {isLg ? null : (
                  <p className="text-balance px-2 pt-4 text-center text-muted-foreground text-xs">
                    Tap a department, team or project to see its people
                    {canCreateTop ? " and manage it" : ""}.
                  </p>
                )}
              </div>
            </section>
            {isLg ? (
              <div className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto">
                {selected ? (
                  <div className="mx-auto w-full max-w-3xl px-6 py-6 xl:px-8">
                    <UnitDetail unit={selected} tree={tree} onSelect={select} />
                  </div>
                ) : (
                  <DetailPlaceholder tree={tree} />
                )}
              </div>
            ) : (
              <Sheet open={selected !== null} onOpenChange={(open) => !open && select(null)}>
                <SheetContent
                  side="bottom"
                  showClose={false}
                  data-testid="unit-sheet"
                  initialFocus={sheetBody}
                  // A dialog opened from inside the sheet (Add people, Remove) is nested: dim the sheet too.
                  className="after:pointer-events-none after:absolute after:inset-0 after:rounded-t-2xl after:bg-black/40 after:opacity-0 after:transition-opacity after:duration-200 data-nested-dialog-open:after:opacity-100"
                >
                  <div
                    aria-hidden
                    className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/25"
                  />
                  <div
                    ref={sheetBody}
                    tabIndex={-1}
                    className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-10 outline-none sm:px-6"
                  >
                    {sheetUnit ? (
                      <UnitDetail
                        unit={sheetUnit}
                        tree={tree}
                        onSelect={select}
                        titleAs={SheetTitle}
                        closeButton={
                          <SheetClose
                            render={
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label="Close"
                                className="size-10 text-muted-foreground"
                              />
                            }
                          >
                            <X />
                          </SheetClose>
                        }
                      />
                    ) : null}
                  </div>
                </SheetContent>
              </Sheet>
            )}
          </>
        )}
      </div>
    </UnitDialogsProvider>
  );
}

function summary(tree: UnitTreeModel): string {
  const counts: Record<UnitKind, number> = { department: 0, team: 0, project: 0 };
  for (const u of tree.ordered) counts[u.kind]++;
  return (["department", "team", "project"] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => kindCount(k, counts[k]))
    .join(" · ");
}

function NewDepartmentButton({ size = "sm" }: { size?: "sm" | "default" }) {
  const dialogs = useUnitDialogs();
  return (
    <Button
      size={size}
      variant={size === "sm" ? "outline" : "default"}
      data-testid="new-department"
      onClick={() => dialogs.open({ type: "create", kind: "department", parent: null })}
    >
      <Plus /> New department
    </Button>
  );
}

function StructureHeader({ tree, canCreate }: { tree: UnitTreeModel; canCreate: boolean }) {
  return (
    <div className="px-4 pt-5 pb-3 sm:px-5 lg:px-4 lg:pt-4">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 className="font-semibold text-[15px] tracking-tight">Structure</h2>
        {canCreate ? <NewDepartmentButton /> : null}
      </div>
      <p className="mt-0.5 text-muted-foreground text-xs" data-testid="org-summary">
        {summary(tree)}
      </p>
    </div>
  );
}

function OrgEmpty({ canCreate }: { canCreate: boolean }) {
  return (
    <EmptyState
      icon={Network}
      title="Mirror how your company is organised"
      description={
        canCreate
          ? "Start with departments, then add teams and projects inside them. People you add to a unit get its access, and Team Leads staff their own part of the tree."
          : "No departments yet. An Organization Admin can set them up."
      }
      className="py-12"
    >
      <div data-testid="org-empty" className="flex flex-col items-center gap-6">
        <ol
          aria-label="How the hierarchy nests"
          className="flex flex-wrap items-center justify-center gap-1.5"
        >
          {(["department", "team", "project"] as const).map((kind, i) => (
            <li key={kind} className="flex items-center gap-1.5">
              {i > 0 ? <ArrowRight aria-hidden className="size-3.5 text-muted-foreground/60" /> : null}
              <span className="flex items-center gap-1.5 rounded-full border bg-card py-1 pr-2.5 pl-1 text-[12.5px] shadow-xs">
                <KindIcon kind={kind} className="size-5 rounded-full [&_svg]:size-3" />
                {KIND_META[kind].label}
              </span>
            </li>
          ))}
        </ol>
        {canCreate ? <NewDepartmentButton size="default" /> : null}
      </div>
    </EmptyState>
  );
}

function DetailPlaceholder({ tree }: { tree: UnitTreeModel }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border bg-card text-muted-foreground shadow-xs">
        <MousePointerClick className="size-5" />
      </span>
      <p className="mt-4 font-medium text-sm">Select a department, team or project</p>
      <p className="mt-1 max-w-xs text-balance text-muted-foreground text-sm">
        See who is in it, who leads it and the access rules that apply. {summary(tree)}.
      </p>
    </div>
  );
}

function TreeSkeleton() {
  const rows = [
    [0, 60],
    [1, 44],
    [2, 52],
    [1, 38],
    [0, 56],
    [1, 48],
  ] as const;
  return (
    <div className="mx-auto w-full max-w-3xl px-2 pt-5 lg:mx-0 lg:w-80 lg:border-r lg:pt-4" aria-busy>
      <div className="mb-3 grid gap-1.5 px-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="grid gap-px">
        {rows.map(([depth, width], i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            key={i}
            className="flex h-11 items-center gap-2 lg:h-9"
            style={{ paddingLeft: 4 + depth * 16 + 30 }}
          >
            <Skeleton className="size-6 rounded-md" />
            <Skeleton className="h-3.5" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
