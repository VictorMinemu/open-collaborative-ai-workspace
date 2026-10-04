import type { ApiModule, Core } from "../../core";
import { DeviceHub } from "./hub";
import { registerDeviceLink } from "./link";
import { registerDeviceRoutes } from "./routes";
import { registerDeviceTokenRoute } from "./token";

export {
  type DeviceCommandRow,
  DeviceHub,
  type DeviceRef,
  type DeviceSessionHandler,
  type EnqueueCommand,
} from "./hub";
export { looksAbsolute, sanitizeAnnouncements } from "./link";
export { deviceFacts, normalizePairingCode, toDevice } from "./routes";

export interface DeviceModule extends ApiModule {
  /** Public interface for the work-session module: command queue, presence, diff relay. */
  hub: DeviceHub;
}

/**
 * device module: pairing (enrollment codes → device tokens), the device-token → device-JWT exchange,
 * devices list/rename/share/revoke, projects announced by devices, and the Device Link `GET /runtime/ws`
 * (mounted at the root).
 */
export function createDeviceModule(core: Core): DeviceModule {
  const graceEnv = Number(process.env.OCW_DEVICE_OFFLINE_GRACE_MS);
  const hub = new DeviceHub({
    db: core.db,
    bus: core.bus,
    realtime: core.realtime,
    log: core.log,
    ...(Number.isFinite(graceEnv) && graceEnv > 0 ? { offlineGraceMs: graceEnv } : {}),
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
        },
        { prefix: "/api/v1" },
      );
    },
    async close() {
      await hub.closeAll();
    },
  };
}
