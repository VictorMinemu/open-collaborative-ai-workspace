"use client";

import {
  type CreateWorkProjectRequest,
  EventTypes,
  topic,
  WorkProjectDetail,
  WorkProjectIndex,
  WorkProjectParents,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

/**
 * Work Zone team projects (Phase 07.9, UI-SPEC Surface 4, R6). Every list comes from `/api/v1/work-projects`, decided
 * by the API resolver: the browser renders what it returns and never filters for access.
 */
export const wpKeys = {
  all: ["wp"] as const,
  index: ["wp", "index"] as const,
  parents: ["wp", "parents"] as const,
  project: (unitId: string) => ["wp", "project", unitId] as const,
};

/** `GET /work-projects`: team projects the viewer can open, their personal repositories, `viewerCan.create`. */
export function useWorkProjects() {
  return useQuery({
    queryKey: wpKeys.index,
    queryFn: ({ signal }) => api.get("/api/v1/work-projects", { schema: WorkProjectIndex, signal }),
  });
}

/**
 * `GET /work-projects/:unitId`. A 404 (no access or unknown id: the same answer, no existence leak), a 403 or a 400
 * (a malformed id) is final, never retried, so the page swaps to the no-access state at once.
 */
export function useWorkProject(unitId: string) {
  return useQuery({
    queryKey: wpKeys.project(unitId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/work-projects/${unitId}`, { schema: WorkProjectDetail, signal }),
    retry: (count, err) => ![400, 403, 404].some((status) => isApiError(err, status)) && count < 2,
  });
}

/** `GET /work-projects/parents`: the teams and departments where the viewer may create a project (no top level). */
export function useWorkProjectParents(enabled: boolean) {
  return useQuery({
    queryKey: wpKeys.parents,
    queryFn: ({ signal }) => api.get("/api/v1/work-projects/parents", { schema: WorkProjectParents, signal }),
    select: (d) => d.parents,
    enabled,
  });
}

/** `POST /work-projects`: the creator becomes the project's lead (D-13). */
export function useCreateWorkProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkProjectRequest) =>
      api.post("/api/v1/work-projects", { body, schema: WorkProjectDetail }),
    onSuccess: (project) => {
      qc.setQueryData(wpKeys.project(project.id), project);
      void qc.invalidateQueries({ queryKey: wpKeys.index });
    },
  });
}

/** Org events after which a project page or the index may read differently (access, teams, repositories, devices). */
const PROJECT_EVENTS: ReadonlySet<string> = new Set([
  EventTypes.unitsUpdated,
  EventTypes.memberUpdated,
  EventTypes.permissionRulesUpdated,
  EventTypes.workProjectUpdated,
  EventTypes.deviceUpdated,
  EventTypes.projectUpdated,
]);

/**
 * Keeps the project pages live (UI-SPEC "Project pages"): the org stream carries ids only, so these events only say
 * when to refetch. Losing access answers 404 on the next read, which the page shows as the no-access state.
 */
export function useWorkProjectsLive(): void {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const orgId = me.data?.organization.id ?? null;
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.op !== "ev" || !PROJECT_EVENTS.has(frame.type)) return;
    void qc.invalidateQueries({ queryKey: wpKeys.all });
  });
}
