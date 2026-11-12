import type { RuntimeCompatibilityManifest } from "@ocw/contracts";
import type { ApiModule, Core } from "../../core";
import { defaultRuntimeDistDir, RuntimeDistStore, registerRuntimeDistRoutes } from "./distribution";
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
// 07.17.1.1 PD-05: the Device Link and the file transfer route authenticate a device JWT with the same check.
export { authenticateDeviceJwt } from "./auth";
export { listGrants, loadGrants } from "./grants";
export {
  CommandUndeliverableError,
  type DeviceCommandRow,
  DeviceHub,
  type DeviceRef,
  type DeviceSessionHandler,
  type EnqueueCommand,
  type FileAckWaiter,
  type FileCommandAck,
  frameFits,
  type RuntimePolicySource,
} from "./hub";
export { looksAbsolute, sanitizeAnnouncements } from "./link";
export { deviceFacts, normalizePairingCode, toDevice } from "./routes";
export { bearerValue, looksLikeJwt } from "./token";

export interface DeviceModule extends ApiModule {
  /** Public interface for the work-session module: command queue, presence, diff relay. */
  hub: DeviceHub;
}

/**
 * device module: pairing (enrollment codes and device-code pairing → device tokens), the device-token → device-JWT
 * exchange, devices list/rename/share/revoke, projects announced by devices, the Device Link `GET /runtime/ws`
 * (mounted at the root), and the Local Runtime distribution (07.12-06: the public `GET /api/v1/runtime/version`,
 * `/bundle`, `/bundle.sha256`, `/install.sh` and, 07.17.1-03, `/npm-shrinkwrap.json`, see `distribution.ts`). One
 * `RuntimeDistStore` per API process reads the dist directory (07.17.1 PD-15).
 */
export function createDeviceModule(
  core: Core,
  opts: { maxFrameBytes?: number; runtimeManifest?: RuntimeCompatibilityManifest } = {},
): DeviceModule {
  const graceEnv = Number(process.env.OCW_DEVICE_OFFLINE_GRACE_MS);
  const runtimeDist = new RuntimeDistStore(
    core.env.OCW_RUNTIME_DIST_DIR ?? defaultRuntimeDistDir(),
    core.log,
  );
  const hub = new DeviceHub({
    db: core.db,
    bus: core.bus,
    realtime: core.realtime,
    audit: core.audit,
    log: core.log,
    // 07.17.1 PD-15: the same store the distribution routes read.
    runtimeDist,
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
          registerRuntimeDistRoutes(scope as typeof app, core, runtimeDist);
        },
        { prefix: "/api/v1" },
      );
    },
    async close() {
      await hub.closeAll();
    },
  };
}
