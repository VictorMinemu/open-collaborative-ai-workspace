"use client";

import {
  CreateEnrollmentResponse,
  type CreatePromptRequest,
  type CreateWorkSessionRequest,
  DeviceList,
  EventTypes,
  normalizeUserCode,
  Ok,
  PairingRequestView,
  ProjectList,
  type ResolveApprovalRequest,
  RuntimeControls,
  type RuntimeId,
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
  WorkSessionRemovedEvent,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "./api";
import { useMe } from "./queries";
import { useRealtimeStatus, useTopic } from "./realtime";

export const wzKeys = {
  devices: ["wz", "devices"] as const,
  projects: ["wz", "projects"] as const,
  sessions: ["wz", "sessions"] as const,
  session: (id: string) => ["wz", "session", id] as const,
  diff: (id: string) => ["wz", "diff", id] as const,
  controls: (id: string) => ["wz", "controls", id] as const,
  runtimeControls: (deviceId: string, runtime: RuntimeId) =>
    ["wz", "controls", "runtime", deviceId, runtime] as const,
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

// ---- terminal pairing (07.12, D-03): the owner looks up, approves or denies what a server asked for ----

/**
 * The pending request behind a user code (`POST /devices/pairings/lookup`, `device.pair`). Keyed by the canonical code;
 * off for anything that is not a well-formed code. Never retried or refetched on its own: the three routes share a
 * budget of 10 calls a minute per member, and a decided request answers 404.
 */
export function usePairingLookup(userCode: string | null) {
  const canonical = userCode ? normalizeUserCode(userCode) : null;
  return useQuery({
    queryKey: ["wz", "pairing", canonical] as const,
    queryFn: ({ signal }) =>
      api.post("/api/v1/devices/pairings/lookup", {
        body: { userCode: canonical },
        schema: PairingRequestView,
        signal,
      }),
    enabled: canonical !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Approves a pending pairing under the name the owner chose; the server picks up its token on its next poll. */
export function useApprovePairing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { userCode: string; name: string }) =>
      api.post("/api/v1/devices/pairings/approve", { body, schema: Ok }),
    onSuccess: () => qc.invalidateQueries({ queryKey: wzKeys.devices }),
  });
}

/** Denies a pending pairing; the polling server gets `access_denied`. */
export function useDenyPairing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { userCode: string }) =>
      api.post("/api/v1/devices/pairings/deny", { body, schema: Ok }),
    onSuccess: () => qc.invalidateQueries({ queryKey: wzKeys.devices }),
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

/** Queues a prompt; `attachmentIds` are the session composer's uploaded images (06.1), in tray order. */
export function useQueuePrompt(sessionId: string) {
  return useMutation({
    mutationFn: ({ body, attachmentIds }: CreatePromptRequest) =>
      api.post(`/api/v1/work-sessions/${sessionId}/prompts`, {
        body: attachmentIds?.length ? { body, attachmentIds } : { body },
        schema: WorkPrompt,
      }),
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

/**
 * What the caller may pick for a NEW session on `deviceId` with `runtime` (catalog ∩ policy ∩ device ∩ grain),
 * decided by the API (D-08, WZC-03). Disabled until both are known.
 */
export function useRuntimeControls(deviceId: string | null | undefined, runtime: RuntimeId) {
  return useQuery({
    enabled: !!deviceId,
    queryKey: wzKeys.runtimeControls(deviceId ?? "", runtime),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/work-zone/controls?deviceId=${encodeURIComponent(deviceId ?? "")}&runtime=${encodeURIComponent(runtime)}`,
        { schema: RuntimeControls, signal },
      ),
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

/**
 * Applies a session frame from the member's own `user:` topic to the session list (Phase 07.9, D-08): the API sends a
 * session's DTO (`work_session.updated`) only to the people who may see it, and `work_session.removed { id }` to the
 * people an audience change removed. The browser applies what it was sent and never decides access: an archived
 * session leaves the list, an older copy never replaces a newer one (frames of two transactions may cross), and a
 * payload that does not parse (e.g. a redacted `{}`) is ignored. Pure, so the list sync is unit-tested.
 */
export function applySessionFrame(
  old: WorkSessionList | undefined,
  frame: { type: string; data: unknown },
): WorkSessionList | undefined {
  if (!old) return old;
  if (frame.type === EventTypes.workSessionRemoved) {
    const removed = WorkSessionRemovedEvent.safeParse(frame.data);
    if (!removed.success) return old;
    const sessions = old.sessions.filter((s) => s.id !== removed.data.id);
    return sessions.length === old.sessions.length ? old : { ...old, sessions };
  }
  if (frame.type !== EventTypes.workSessionUpdated) return old;
  const parsed = WorkSession.safeParse(frame.data);
  if (!parsed.success) return old;
  const next = parsed.data;
  const current = old.sessions.find((s) => s.id === next.id);
  if (current && current.updatedAt > next.updatedAt) return old;
  const others = old.sessions.filter((s) => s.id !== next.id);
  const sessions =
    next.status === "archived"
      ? others
      : [next, ...others].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { ...old, sessions };
}

/**
 * Merges a `ws:` `work_session.updated` snapshot into the session view's state (Phase 07.10, PD-03). The shared `ws:`
 * stream carries the viewer-neutral DTO, without the fields the API decides per viewer (the team project, whether it
 * is hidden, the viewer's attention), so those keep the values of the view's REST snapshot (or of a later shaped DTO):
 * the breadcrumb's project link and the "You left {project}" line survive every live update. A snapshot that carries
 * one of them wins: the team project and its `teamProjectHidden` flag travel as a pair (a shaped DTO omits the flag
 * when the project is named); `attention` on its own. Every other field always comes from `next`. Pure.
 */
export function mergeSessionSnapshot(prev: WorkSession, next: WorkSession): WorkSession {
  const out: WorkSession = { ...next };
  if (!("teamProject" in next) && !("teamProjectHidden" in next)) {
    if ("teamProject" in prev) out.teamProject = prev.teamProject;
    if ("teamProjectHidden" in prev) out.teamProjectHidden = prev.teamProjectHidden;
  }
  if (!("attention" in next) && "attention" in prev) out.attention = prev.attention;
  return out;
}

/** Org events after which the session list is fetched again: access may have changed for anyone (D-08, P-08). */
const SESSION_ACCESS_EVENTS: ReadonlySet<string> = new Set([
  EventTypes.deviceUpdated,
  EventTypes.unitsUpdated,
  EventTypes.permissionRulesUpdated,
  EventTypes.workProjectUpdated,
]);

/**
 * True when an org event may have changed which sessions this user reads, so the list is fetched again: a structural
 * access change for anyone, or a change to this user's own membership (`member.updated`: a role downgrade or a
 * deactivation; the server revokes live views with `cause: role`, the refetch drops the rows from the list). Another
 * member's change never touches this user's audience.
 */
export function sessionListStale(frame: { type: string; data: unknown }, userId: string | null): boolean {
  if (SESSION_ACCESS_EVENTS.has(frame.type)) return true;
  if (frame.type !== EventTypes.memberUpdated || userId === null) return false;
  const data = frame.data as { userId?: unknown } | null;
  return data?.userId === userId;
}

/**
 * Keep device, project and session lists live. The org stream carries ids only (devices, projects, units, rules,
 * team projects), so it only says when to refetch; the sessions themselves arrive on the member's own `user:` topic
 * (D-08). Ephemeral frames are not replayed, so a reconnect refetches the list.
 */
export function useWorkZoneOrgSync() {
  const me = useMe({ enabled: false });
  const qc = useQueryClient();
  const orgId = me.data?.organization.id ?? null;
  const userId = me.data?.user.id ?? null;
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.type === EventTypes.projectUpdated || frame.type === EventTypes.workProjectUpdated) {
      void qc.invalidateQueries({ queryKey: wzKeys.projects });
      void qc.invalidateQueries({ queryKey: wzKeys.devices });
    }
    if (frame.type === EventTypes.deviceUpdated) {
      void qc.invalidateQueries({ queryKey: wzKeys.devices });
      void qc.invalidateQueries({ queryKey: wzKeys.projects });
      // 07.11: an open runtime-update history follows the device's runs (only active queries refetch).
      void qc.invalidateQueries({ queryKey: ["wz", "device-runtime-updates"] });
    }
    if (sessionListStale(frame, userId)) void qc.invalidateQueries({ queryKey: wzKeys.sessions });
  });
  useTopic(userId ? topic("user", userId) : null, (frame) => {
    if (frame.type !== EventTypes.workSessionUpdated && frame.type !== EventTypes.workSessionRemoved) return;
    qc.setQueryData<WorkSessionList>(wzKeys.sessions, (old) => applySessionFrame(old, frame));
  });
  const status = useRealtimeStatus();
  const wasDown = useRef(false);
  useEffect(() => {
    if (status === "reconnecting") wasDown.current = true;
    if (status === "open" && wasDown.current) {
      wasDown.current = false;
      void qc.invalidateQueries({ queryKey: wzKeys.sessions });
    }
  }, [status, qc]);
}
