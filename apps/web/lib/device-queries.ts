"use client";

import {
  DeviceGrant,
  DeviceGrantList,
  type DeviceGrantPrincipalKind,
  Ok,
  type PermissionMode,
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
