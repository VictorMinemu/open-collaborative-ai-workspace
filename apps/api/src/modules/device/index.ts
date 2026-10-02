import type { ApiModule, Core } from "../../core";

/**
 * device module — TODO(B3): device enrollments/pairing, devices list/revoke, projects, and the Device Link WS /runtime/ws (bearer device token → core.db.lookups.deviceByTokenHash). Use prefix "" for /runtime/ws or register it in a second module.
 *
 * Already wired in app.ts: implement routes inside register(); they are mounted under /api/v1.
 * Use core.identity.requireUser as preHandler, core.db.withTenant(tenant(req), …) for every query,
 * core.audit.record(tx, …) for sensitive actions and core.realtime.appendEvent(tx, topic, type, payload).
 */
export function createDeviceModule(_core: Core): ApiModule {
  return {
    name: "device",
    register(_app) {
      // TODO(B3)
    },
  };
}
