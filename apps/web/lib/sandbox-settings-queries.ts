"use client";

import { SandboxSettings, SandboxSettingsView, type UpdateSandboxSettingsRequest } from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Settings › Sandbox & Browser (07.8-19; SBX-03, SBX-05, BRW-04, D-09, D-11, D-12): the organization's settings view,
 * versioned saves, and the admins' kill switch and resume (07.8-11's routes, `bot.manage`). The API decides and
 * validates everything; the page renders the view it answers. A save carries the version the page read: when another
 * admin (or another tab) saved first, the API answers 409 `settings_version_conflict` with the current settings, which
 * replace the cached ones so the page shows them before anyone saves again (T-07.8-19-02).
 */

export const sandboxSettingsKey = ["sandbox-settings"] as const;

const BASE = "/api/v1/sandbox";

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** The settings, the isolation in use and today's usage. A 403 means the caller may not manage sandboxes. */
export function useSandboxSettings(enabled = true) {
  return useQuery({
    enabled,
    queryKey: sandboxSettingsKey,
    queryFn: ({ signal }) => api.get(`${BASE}/settings`, { schema: SandboxSettingsView, signal }),
    retry: noRetryOn4xx,
  });
}

/** A settings change: everything but the version, which the mutation adds from the cached view. */
export type SandboxSettingsPatch = Omit<UpdateSandboxSettingsRequest, "expectedVersion">;

/** Whether an error is the API's version conflict (the cache already holds the current settings). */
export const isVersionConflict = (err: unknown): boolean =>
  isApiError(err, 409) && err.code === "settings_version_conflict";

/**
 * `PUT /sandbox/settings` with the cached version. Success writes the answer into the view; a version conflict writes
 * the current settings from the error's details and refetches the rest of the view (isolation and usage).
 */
export function useUpdateSandboxSettings() {
  const qc = useQueryClient();
  const setSettings = (settings: SandboxSettings) =>
    qc.setQueryData<SandboxSettingsView>(sandboxSettingsKey, (view) => (view ? { ...view, settings } : view));
  return useMutation({
    mutationFn: (patch: SandboxSettingsPatch) => {
      const view = qc.getQueryData<SandboxSettingsView>(sandboxSettingsKey);
      const expectedVersion = view?.settings.version ?? 0;
      return api.put(`${BASE}/settings`, { body: { expectedVersion, ...patch }, schema: SandboxSettings });
    },
    onSuccess: setSettings,
    onError: (err) => {
      if (isVersionConflict(err) && isApiError(err)) {
        const current = SandboxSettings.safeParse((err.details as { settings?: unknown } | null)?.settings);
        if (current.success) setSettings(current.data);
      }
      void qc.invalidateQueries({ queryKey: sandboxSettingsKey });
    },
  });
}

/** `POST /sandbox/kill` or `/sandbox/resume`; the answer is the new settings (with `killed`). */
export function useKillSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "kill" | "resume") => api.post(`${BASE}/${action}`, { schema: SandboxSettings }),
    onSuccess: (settings) => {
      qc.setQueryData<SandboxSettingsView>(sandboxSettingsKey, (view) =>
        view ? { ...view, settings } : view,
      );
      // Running counts drop after a kill: the isolation card's numbers come from the API.
      void qc.invalidateQueries({ queryKey: sandboxSettingsKey });
    },
    onError: () => void qc.invalidateQueries({ queryKey: sandboxSettingsKey }),
  });
}
