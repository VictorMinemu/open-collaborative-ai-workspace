"use client";

import {
  AssignableTeams,
  type CreateWorkProjectRequest,
  EventTypes,
  LinkableRepos,
  type ProjectDefaultVisibility,
  RepoUnlinkImpact,
  topic,
  WorkProjectDetail,
  WorkProjectIndex,
  WorkProjectParents,
} from "@ocw/contracts";
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";
import { visKeys } from "./visibility-queries";
import { wzKeys } from "./workzone-queries";

/**
 * Work Zone team projects (Phase 07.9, UI-SPEC Surface 4, R6). Every list comes from `/api/v1/work-projects`, decided
 * by the API resolver: the browser renders what it returns and never filters for access.
 */
export const wpKeys = {
  all: ["wp"] as const,
  index: ["wp", "index"] as const,
  parents: ["wp", "parents"] as const,
  project: (unitId: string) => ["wp", "project", unitId] as const,
  assignable: (unitId: string, q: string) => ["wp", "project", unitId, "assignable", q] as const,
  linkable: (unitId: string) => ["wp", "project", unitId, "linkable"] as const,
  impact: (unitId: string, projectId: string) => ["wp", "project", unitId, "impact", projectId] as const,
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

// ---------------------------------------------------------------- project settings (07.9-13, UI-SPEC § 4.3, § 4.4)

/**
 * Every settings write answers the project's new detail: it replaces the cached one, and the lists that read the same
 * facts refetch (the index counts, the repositories `GET /projects` names, the session list whose `teamProject`
 * changes with a link, and the visibility panel's team list). The API decides each write again.
 */
function settle(qc: QueryClient, project: WorkProjectDetail, opts: { repos?: boolean } = {}) {
  qc.setQueryData(wpKeys.project(project.id), project);
  void qc.invalidateQueries({ queryKey: wpKeys.index });
  void qc.invalidateQueries({ queryKey: [...wpKeys.project(project.id), "assignable"] });
  void qc.invalidateQueries({ queryKey: wpKeys.linkable(project.id) });
  void qc.invalidateQueries({ queryKey: visKeys.projectTeams(project.id) });
  void qc.invalidateQueries({ queryKey: wzKeys.projects });
  if (opts.repos) void qc.invalidateQueries({ queryKey: wzKeys.sessions });
}

/**
 * `PATCH /work-projects/:unitId` (D-03): the default for new sessions. Optimistic: the switch moves at once and goes
 * back if the API refuses (the caller shows the toast).
 */
export function useUpdateWorkProject(unitId: string) {
  const qc = useQueryClient();
  const key = wpKeys.project(unitId);
  return useMutation({
    mutationFn: (defaultVisibility: ProjectDefaultVisibility) =>
      api.patch(`/api/v1/work-projects/${unitId}`, {
        body: { defaultVisibility },
        schema: WorkProjectDetail,
      }),
    onMutate: async (defaultVisibility) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const before = qc.getQueryData<WorkProjectDetail>(key);
      if (before) qc.setQueryData<WorkProjectDetail>(key, { ...before, defaultVisibility });
      return { before };
    },
    onError: (_err, _value, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
    },
    onSuccess: (project) => settle(qc, project),
  });
}

/**
 * `GET /work-projects/:unitId/assignable-teams?q=`: teams and departments the viewer may assign and that are not
 * assigned yet (D-14: every one for admins, the led subtree for leads; never a project).
 */
export function useAssignableTeams(unitId: string, q: string, enabled: boolean) {
  const needle = q.trim();
  return useQuery({
    enabled,
    queryKey: wpKeys.assignable(unitId, needle),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/work-projects/${unitId}/assignable-teams${needle ? `?q=${encodeURIComponent(needle)}` : ""}`,
        { schema: AssignableTeams, signal },
      ),
    select: (d) => d.teams,
    placeholderData: keepPreviousData,
  });
}

/** `POST /work-projects/:unitId/teams`: its people get the project and its sessions visible to the project. */
export function useAssignTeam(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (teamId: string) =>
      api.post(`/api/v1/work-projects/${unitId}/teams`, {
        body: { unitId: teamId },
        schema: WorkProjectDetail,
      }),
    onSuccess: (project) => settle(qc, project),
  });
}

/** `DELETE /work-projects/:unitId/teams/:teamId`: people in the project only through it lose access now. */
export function useRemoveTeam(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (teamId: string) =>
      api.del(`/api/v1/work-projects/${unitId}/teams/${teamId}`, { schema: WorkProjectDetail }),
    onSuccess: (project) => settle(qc, project),
  });
}

/** `GET /work-projects/:unitId/linkable-repos`: repositories on devices the viewer can use, by device; names only. */
export function useLinkableRepos(unitId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: wpKeys.linkable(unitId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/work-projects/${unitId}/linkable-repos`, { schema: LinkableRepos, signal }),
    select: (d) => d.devices,
  });
}

/** `POST /work-projects/:unitId/repos`: the repository's sessions belong to the project from now on. */
export function useLinkRepo(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.post(`/api/v1/work-projects/${unitId}/repos`, { body: { projectId }, schema: WorkProjectDetail }),
    onSuccess: (project) => settle(qc, project, { repos: true }),
  });
}

/** `GET /work-projects/:unitId/repos/:projectId/impact`: the server's count of sessions that become personal. */
export function useUnlinkImpact(unitId: string, projectId: string | null) {
  return useQuery({
    enabled: projectId !== null,
    queryKey: wpKeys.impact(unitId, projectId ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/work-projects/${unitId}/repos/${projectId}/impact`, {
        schema: RepoUnlinkImpact,
        signal,
      }),
    select: (d) => d.sessions,
    staleTime: 0,
  });
}

/** `DELETE /work-projects/:unitId/repos/:projectId`: its sessions become personal to the device's people. */
export function useUnlinkRepo(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.del(`/api/v1/work-projects/${unitId}/repos/${projectId}`, { schema: WorkProjectDetail }),
    onSuccess: (project) => settle(qc, project, { repos: true }),
  });
}
