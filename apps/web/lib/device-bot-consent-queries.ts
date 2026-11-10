"use client";

import { DeviceBotConsentsView, type SetDeviceBotConsentRequest } from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Which bots may run Work Zone sessions on a device (07.16-13, D-03, D-04, D-22, PD-06) on 07.16-07's routes
 * (`GET|PUT|DELETE /api/v1/devices/:id/bot-consents[/:agentId]`). The API decides who may grant (the device owner, or
 * an admin on a server) and answers every change with the whole view, which replaces the cache: the list on screen is
 * always what the API holds.
 */
export const deviceBotConsentKeys = {
  consents: (deviceId: string) => ["device-bot-consents", deviceId] as const,
};

const path = (deviceId: string) => `/api/v1/devices/${deviceId}/bot-consents`;

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** `GET /devices/:id/bot-consents`: allowed bots, bots asking, and whether the viewer may decide. */
export function useDeviceBotConsents(deviceId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: deviceBotConsentKeys.consents(deviceId),
    queryFn: ({ signal }) => api.get(path(deviceId), { schema: DeviceBotConsentsView, signal }),
    retry: noRetryOn4xx,
  });
}

export type SetConsentVariables = { agentId: string } & SetDeviceBotConsentRequest;

/** Allow a bot, or change its Full access checkbox: one PUT; the answer is cached (the hook's and the tests'). */
export function setConsentMutation(qc: QueryClient, deviceId: string) {
  return {
    mutationFn: ({ agentId, allowFullAccess }: SetConsentVariables) =>
      api.put(`${path(deviceId)}/${agentId}`, {
        body: { allowFullAccess } satisfies SetDeviceBotConsentRequest,
        schema: DeviceBotConsentsView,
      }),
    onSuccess: (view: DeviceBotConsentsView) => {
      qc.setQueryData(deviceBotConsentKeys.consents(deviceId), view);
    },
  };
}

/** Revoke a bot: one DELETE; the answer (the bot no longer listed as allowed) is cached. */
export function revokeConsentMutation(qc: QueryClient, deviceId: string) {
  return {
    mutationFn: (agentId: string) =>
      api.del(`${path(deviceId)}/${agentId}`, { schema: DeviceBotConsentsView }),
    onSuccess: (view: DeviceBotConsentsView) => {
      qc.setQueryData(deviceBotConsentKeys.consents(deviceId), view);
    },
  };
}

/** `PUT /devices/:id/bot-consents/:agentId`. A refusal leaves the cache alone. */
export function useSetDeviceBotConsent(deviceId: string) {
  const qc = useQueryClient();
  return useMutation(setConsentMutation(qc, deviceId));
}

/** `DELETE /devices/:id/bot-consents/:agentId`. */
export function useRevokeDeviceBotConsent(deviceId: string) {
  const qc = useQueryClient();
  return useMutation(revokeConsentMutation(qc, deviceId));
}
