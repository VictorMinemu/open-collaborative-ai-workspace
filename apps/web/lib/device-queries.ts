"use client";

import {
  DeviceGrant,
  DeviceGrantList,
  type DeviceGrantPrincipalKind,
  Ok,
  type PermissionMode,
  RequestRuntimeUpdateResponse,
  RuntimeUpdateRunList,
  type RuntimeUpdateTarget,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { wzKeys } from "./workzone-queries";

/** Device sharing (Phase 03.2, D-05): grants per member or org unit, each capped at a permission mode. */

const grantsKey = (deviceId: string) => ["wz", "device-grants", deviceId] as const;

export function useDeviceGrants(deviceId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: grantsKey(deviceId),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/devices/${deviceId}/grants`, { schema: DeviceGrantList, signal }),
    select: (d) => d.grants,
  });
}

function useInvalidate(deviceId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: wzKeys.devices });
    void qc.invalidateQueries({ queryKey: wzKeys.projects });
    void qc.invalidateQueries({ queryKey: grantsKey(deviceId) });
  };
}

export function usePutDeviceGrant(deviceId: string) {
  const invalidate = useInvalidate(deviceId);
  return useMutation({
    mutationFn: ({
      kind,
      principalId,
      maxMode,
    }: {
      kind: DeviceGrantPrincipalKind;
      principalId: string;
      maxMode: PermissionMode;
    }) =>
      api.put(`/api/v1/devices/${deviceId}/grants/${kind}/${principalId}`, {
        body: { maxMode },
        schema: DeviceGrant,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteDeviceGrant(deviceId: string) {
  const invalidate = useInvalidate(deviceId);
  return useMutation({
    mutationFn: ({ kind, principalId }: { kind: DeviceGrantPrincipalKind; principalId: string }) =>
      api.del(`/api/v1/devices/${deviceId}/grants/${kind}/${principalId}`, { schema: Ok }),
    onSuccess: invalidate,
  });
}

/**
 * Runtime updates (Phase 07.11, D-05, D-06; 07.17.1 adds the OCW runtime itself): a device's update history and
 * "Update now", both for the device owner and admins only (`device.maintain`, decided by the API). The device list
 * refetches on every `device.updated` ping, so a row's state follows the device live; an open history refetches with it
 * (`useWorkZoneOrgSync`).
 */
export const runtimeUpdatesKey = (deviceId: string) => ["wz", "device-runtime-updates", deviceId] as const;

export function useRuntimeUpdateHistory(
  deviceId: string,
  runtime: RuntimeUpdateTarget | undefined,
  enabled: boolean,
  opts: { refetchInterval?: number | false | (() => number | false) } = {},
) {
  return useQuery({
    enabled,
    queryKey: [...runtimeUpdatesKey(deviceId), runtime ?? "all"],
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/devices/${deviceId}/runtime-updates${runtime ? `?runtime=${encodeURIComponent(runtime)}` : ""}`,
        { schema: RuntimeUpdateRunList, signal },
      ),
    select: (d) => d.runs,
    refetchInterval: opts.refetchInterval ?? false,
  });
}

/** "Update now": a request the API decides and audits; on an error the caller shows `errorMessage(err)`. */
export function useRequestRuntimeUpdate(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runtime: RuntimeUpdateTarget) =>
      api.post(`/api/v1/devices/${deviceId}/runtimes/${encodeURIComponent(runtime)}/update`, {
        schema: RequestRuntimeUpdateResponse,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: wzKeys.devices });
      void qc.invalidateQueries({ queryKey: runtimeUpdatesKey(deviceId) });
    },
  });
}
