"use client";

import {
  CreateEnrollmentResponse,
  type CreateWorkSessionRequest,
  DeviceList,
  EventTypes,
  Ok,
  ProjectList,
  type ResolveApprovalRequest,
  SessionCommandResult,
  SessionControls,
  type SessionSettingsPatch,
  topic,
  type UpdateDeviceRequest,
  type UpdatePromptRequest,
  WorkApproval,
  WorkPrompt,
  WorkSession,
  WorkSessionDetail,
  WorkSessionDiff,
  WorkSessionList,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

export const wzKeys = {
  devices: ["wz", "devices"] as const,
  projects: ["wz", "projects"] as const,
  sessions: ["wz", "sessions"] as const,
  session: (id: string) => ["wz", "session", id] as const,
  diff: (id: string) => ["wz", "diff", id] as const,
  controls: (id: string) => ["wz", "controls", id] as const,
};

// ---- devices & projects ----

export function useDevices() {
  return useQuery({
    queryKey: wzKeys.devices,
    queryFn: ({ signal }) => api.get("/api/v1/devices", { schema: DeviceList, signal }),
    select: (d) => d.devices,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: wzKeys.projects,
    queryFn: ({ signal }) => api.get("/api/v1/projects", { schema: ProjectList, signal }),
    select: (d) => d.projects,
  });
}

export function useCreateEnrollment() {
  return useMutation({
    mutationFn: () => api.post("/api/v1/devices/enrollments", { body: {}, schema: CreateEnrollmentResponse }),
  });
}

export function useUpdateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateDeviceRequest & { id: string }) =>
      api.patch(`/api/v1/devices/${id}`, { body, schema: Ok }),
    onSuccess: () => qc.invalidateQueries({ queryKey: wzKeys.devices }),
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/devices/${id}`, { schema: Ok }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: wzKeys.devices });
      void qc.invalidateQueries({ queryKey: wzKeys.projects });
      void qc.invalidateQueries({ queryKey: wzKeys.sessions });
    },
  });
}

// ---- sessions ----

export function useWorkSessions() {
  return useQuery({
    queryKey: wzKeys.sessions,
    queryFn: ({ signal }) => api.get("/api/v1/work-sessions", { schema: WorkSessionList, signal }),
    select: (d) => d.sessions,
  });
}

export function useWorkSession(id: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: wzKeys.session(id),
    queryFn: ({ signal }) => api.get(`/api/v1/work-sessions/${id}`, { schema: WorkSessionDetail, signal }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

export function useCreateWorkSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkSessionRequest) =>
      api.post("/api/v1/work-sessions", { body, schema: WorkSession }),
    onSuccess: () => qc.invalidateQueries({ queryKey: wzKeys.sessions }),
  });
}

export function useQueuePrompt(sessionId: string) {
  return useMutation({
    mutationFn: (body: string) =>
      api.post(`/api/v1/work-sessions/${sessionId}/prompts`, { body: { body }, schema: WorkPrompt }),
  });
}

export function useUpdatePrompt(sessionId: string) {
  return useMutation({
    mutationFn: ({ id, ...body }: UpdatePromptRequest & { id: string }) =>
      api.patch(`/api/v1/work-sessions/${sessionId}/prompts/${id}`, { body, schema: Ok }),
  });
}

export function useInterrupt(sessionId: string) {
  return useMutation({
    mutationFn: () => api.post(`/api/v1/work-sessions/${sessionId}/interrupt`, { body: {}, schema: Ok }),
  });
}

/** What the caller may pick in this session (catalog ∩ policy ∩ device ∩ grain), decided by the API (D-08). */
export function useSessionControls(sessionId: string) {
  return useQuery({
    queryKey: wzKeys.controls(sessionId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/work-sessions/${sessionId}/controls`, { schema: SessionControls, signal }),
    staleTime: 30_000,
  });
}

/** Change the session's settings; the device applies them before the next turn (D-07, D-14). */
export function useUpdateSessionSettings(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SessionSettingsPatch) =>
      api.patch(`/api/v1/work-sessions/${sessionId}/settings`, { body, schema: WorkSession }),
    onSuccess: () => qc.invalidateQueries({ queryKey: wzKeys.controls(sessionId) }),
  });
}

/**
 * Run a `/command` typed in the composer (D-13, P-10): the API changes settings through the policy-checked path,
 * queues a passthrough command as a prompt, or refuses it with a notice. Never sent to the prompt queue raw.
 */
export function useSessionCommand(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      api.post(`/api/v1/work-sessions/${sessionId}/commands`, {
        body: { text },
        schema: SessionCommandResult,
      }),
    onSuccess: (result) => {
      if (result.kind === "settings") void qc.invalidateQueries({ queryKey: wzKeys.controls(sessionId) });
    },
  });
}

export function useResolveApproval(sessionId: string) {
  return useMutation({
    mutationFn: ({ id, ...body }: ResolveApprovalRequest & { id: string }) =>
      api.post(`/api/v1/work-sessions/${sessionId}/approvals/${id}`, { body, schema: WorkApproval }),
  });
}

export function useArchiveSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/work-sessions/${sessionId}/archive`, { body: {}, schema: Ok }),
    onSuccess: () => qc.invalidateQueries({ queryKey: wzKeys.sessions }),
  });
}

export function useDiff(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: wzKeys.diff(sessionId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/work-sessions/${sessionId}/diff`, { schema: WorkSessionDiff, signal }),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** Keep device, project and session lists live from the org stream. */
export function useWorkZoneOrgSync() {
  const me = useMe({ enabled: false });
  const qc = useQueryClient();
  const orgId = me.data?.organization.id ?? null;
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.type === EventTypes.deviceUpdated) {
      void qc.invalidateQueries({ queryKey: wzKeys.devices });
      void qc.invalidateQueries({ queryKey: wzKeys.projects });
      void qc.invalidateQueries({ queryKey: wzKeys.sessions });
    } else if (frame.type === EventTypes.projectUpdated) {
      void qc.invalidateQueries({ queryKey: wzKeys.projects });
      void qc.invalidateQueries({ queryKey: wzKeys.devices });
    } else if (frame.type === EventTypes.workSessionUpdated) {
      const parsed = WorkSession.safeParse(frame.data);
      if (!parsed.success) return;
      qc.setQueryData<{ sessions: WorkSession[] }>(wzKeys.sessions, (old) => {
        if (!old) return old;
        const others = old.sessions.filter((s) => s.id !== parsed.data.id);
        const sessions =
          parsed.data.status === "archived"
            ? others
            : [parsed.data, ...others].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { sessions };
      });
    }
  });
}
