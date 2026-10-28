"use client";

import type { WorkProjectParent } from "@ocw/contracts";
import { useMemo } from "react";
import { useWorkProjectParents, useWorkProjects } from "@/lib/work-project-queries";

/**
 * Where the viewer may create a team project, by department (Phase 07.10-05, D-07, UI-SPEC § 2, R3, R6). Read only from
 * `GET /work-projects/parents` (the resolver's `work_project.manage`); `POST /work-projects` decides again. The section
 * "+" shows where `canCreateIn` says so and opens New project on `defaultParentFor`.
 */
export interface CreatableUnits {
  /** Some unit the viewer may create in sits in the department `sectionKey` (or is it). */
  canCreateIn(sectionKey: string): boolean;
  /** The department itself when the viewer may create there, else the first unit inside it (the API's order). */
  defaultParentFor(sectionKey: string): string | undefined;
}

export function creatableUnits(
  parents: readonly Pick<WorkProjectParent, "id" | "topId">[] | undefined,
): CreatableUnits {
  const byTop = new Map<string, string>();
  for (const p of parents ?? []) {
    // The department itself wins over the units inside it; otherwise the first one the API listed.
    if (p.id === p.topId || !byTop.has(p.topId)) byTop.set(p.topId, p.id);
  }
  return {
    canCreateIn: (key) => byTop.has(key),
    defaultParentFor: (key) => byTop.get(key),
  };
}

/** One parents request, and only when the index says the viewer may create somewhere (PD-12). */
export function useCreatableUnits(): CreatableUnits {
  const index = useWorkProjects();
  const parents = useWorkProjectParents(index.data?.viewerCan.create === true);
  return useMemo(() => creatableUnits(parents.data), [parents.data]);
}
