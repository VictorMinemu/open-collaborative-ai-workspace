import type { RuntimeCompatibilityManifest } from "@ocw/contracts";
import type { ApiModule, Core } from "../../core";
import { registerRuntimeDistRoutes } from "./distribution";
import { DeviceHub } from "./hub";
import { registerDeviceLink } from "./link";
import { registerDeviceRoutes } from "./routes";
import { registerDeviceTokenRoute } from "./token";

export {
  type DeviceAccess,
  deviceControllerFloor,
  deviceModeCap,
  type GrantRow,
  isRevokedPrincipal,
  loadDeviceAccess,
} from "./access";
export { listGrants, loadGrants } from "./grants";
export {
  CommandUndeliverableError,
  type DeviceCommandRow,
  DeviceHub,
  type DeviceRef,
  type DeviceSessionHandler,
  type EnqueueCommand,
  frameFits,
  type RuntimePolicySource,
} from "./hub";
export { looksAbsolute, sanitizeAnnouncements } from "./link";
export { deviceFacts, normalizePairingCode, toDevice } from "./routes";

export interface DeviceModule extends ApiModule {
  /** Public interface for the work-session module: command queue, presence, diff relay. */
  hub: DeviceHub;
}

/**
 * device module: pairing (enrollment codes and device-code pairing → device tokens), the device-token → device-JWT
 * exchange, devices list/rename/share/revoke, projects announced by devices, the Device Link `GET /runtime/ws`
 * (mounted at the root), and the Local Runtime distribution (07.12-06: the public `GET /api/v1/runtime/version`,
 * `/bundle`, `/bundle.sha256` and `/install.sh`, see `distribution.ts`).
 */
export function createDeviceModule(
  core: Core,
  opts: { maxFrameBytes?: number; runtimeManifest?: RuntimeCompatibilityManifest } = {},
): DeviceModule {
  const graceEnv = Number(process.env.OCW_DEVICE_OFFLINE_GRACE_MS);
  const hub = new DeviceHub({
    db: core.db,
    bus: core.bus,
    realtime: core.realtime,
    audit: core.audit,
    log: core.log,
    ...(Number.isFinite(graceEnv) && graceEnv > 0 ? { offlineGraceMs: graceEnv } : {}),
    ...(opts.maxFrameBytes ? { maxFrameBytes: opts.maxFrameBytes } : {}),
    ...(opts.runtimeManifest ? { runtimeManifest: opts.runtimeManifest } : {}),
  });
  return {
    name: "device",
    prefix: "",
    hub,
    register(app) {
      registerDeviceLink(app, core, hub);
      app.register(
        async (scope) => {
          registerDeviceRoutes(scope as typeof app, core, hub);
          registerDeviceTokenRoute(scope as typeof app, core);
          registerRuntimeDistRoutes(scope as typeof app, core);
        },
        { prefix: "/api/v1" },
      );
    },
    async close() {
      await hub.closeAll();
    },
  };
}
