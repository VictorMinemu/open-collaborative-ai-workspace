import { randomUUID } from "node:crypto";
import { decodeWorkBrowserFrame } from "@ocw/contracts";
import { workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApiModule, Core } from "../../core";
import type { DeviceBrowserHandler, DeviceHub, DeviceRef } from "../device";
import { createPermissionService } from "../organization";
import { onBrowserEvent } from "./events";
import { registerWorkLiveView, type WorkLiveHub } from "./live";
import { createLiveRelay } from "./live-relay";
import { registerSignInRoutes } from "./signin-routes";

export { onBrowserEvent } from "./events";
export type { WorkLiveHub, WorkLiveStats } from "./live";

/**
 * The Work Zone browser module (Phase 07.13; D-14, D-15, D-20 … D-28): the Control Plane side of the browser a
 * member's Work Zone session drives on its own device. It sits BESIDE the bots' `modules/browser` (sandboxd contexts)
 * and never generalizes it; anything it reuses from there comes through `modules/browser/index.ts` only.
 *
 * - Device frames: `deviceHandler` is registered on the Device Link hub (`hub.setBrowserHandler`). `browser.event`
 *   keeps the session's `work_browsers` row and audits `work_browser.*` (`events.ts`, 07.13-08); binary live frames
 *   (`onBinary`, 07.13-10) go to the live view once the session is known to run on the sending device; later plans add
 *   the takeover focus hint (`onFocus`, 18) and the sign-in load (`onSignInLoad`, 17) by assigning the handler's methods.
 * - The live view (`live.ts`, 07.13-10): `GET /api/v1/live/work-browser/:sessionId` for the session's audience; frames
 *   reach viewers on other API instances through `live-relay.ts` (Redis transit only while watched, D-33).
 * - Server → device browser frames go through `hub.sendBrowserFrame` (ephemeral: never queued, never logged), and only
 *   to a device whose hello carried `browser` (PD-20).
 */
export interface WorkBrowserModule {
  module: ApiModule;
  /** Registered with `hub.setBrowserHandler`; its methods are this module's device frame handlers. */
  deviceHandler: DeviceBrowserHandler;
  /** The Device Link hub this module sends browser frames through. */
  hub: DeviceHub;
  /** This instance's live-view hub once the routes are registered (tests: `stats`, `heartbeat`). */
  live(): WorkLiveHub | null;
}

/** How long the session → device answer of a frame is trusted before it is read again (T-07.13-10-03). */
const SESSION_DEVICE_TTL_MS = 5_000;

export function createWorkBrowserModule(
  core: Core,
  deps: { hub: DeviceHub; allowedOrigins?: Set<string> },
): WorkBrowserModule {
  let live: WorkLiveHub | null = null;
  const sessionDevice = sessionDeviceCheck(core);
  const deviceHandler: DeviceBrowserHandler = {
    onBrowserEvent: onBrowserEvent(core),
    // Per frame, not awaited, after hello (07.13-08): cheap until the session is known. A frame naming a session
    // that does not run on the sending device reaches nobody (T-07.13-10-03).
    async onBinary(device, bytes) {
      const hubNow = live;
      if (!hubNow) return;
      const frame = decodeWorkBrowserFrame(bytes);
      if (!frame) return;
      if (!(await sessionDevice(device, frame.sessionId))) return;
      hubNow.onFrame(device.organizationId, frame);
    },
  };
  return {
    module: {
      name: "work-browser",
      register(app) {
        const perms = createPermissionService(core);
        // 07.13-17: the member's own sign-ins (Keychain) and the device's hand-back upload.
        registerSignInRoutes(app, { core, perms });
        live = registerWorkLiveView(app, {
          core,
          perms,
          hub: deps.hub,
          allowedOrigins: deps.allowedOrigins ?? new Set(),
          // D-33: this instance's frames transit (one per instance; its id only tells its own messages apart).
          relay: createLiveRelay({ bus: core.bus, instanceId: randomUUID(), log: core.log }),
        });
      },
      async close() {
        await live?.close();
      },
    },
    deviceHandler,
    hub: deps.hub,
    live: () => live,
  };
}

/**
 * Whether `sessionId` runs on `device` (in the device's tenant), cached per session for `SESSION_DEVICE_TTL_MS`; one
 * read at a time per session, the frames meanwhile wait for its answer.
 */
function sessionDeviceCheck(core: Core) {
  const cache = new Map<
    string,
    { deviceId: string | null; at: number; read: Promise<string | null> | null }
  >();
  return async (device: DeviceRef, sessionId: string): Promise<boolean> => {
    const key = `${device.organizationId}:${sessionId}`;
    const now = Date.now();
    let hit = cache.get(key);
    if (!hit || (now - hit.at > SESSION_DEVICE_TTL_MS && !hit.read)) {
      const read = core.db
        .withTenant({ organizationId: device.organizationId, userId: null }, async (tx) => {
          const [row] = await tx
            .select({ deviceId: workSessions.deviceId })
            .from(workSessions)
            .where(eq(workSessions.id, sessionId))
            .limit(1);
          return row?.deviceId ?? null;
        })
        .catch(() => null);
      hit = { deviceId: hit?.deviceId ?? null, at: hit?.at ?? 0, read };
      cache.set(key, hit);
      const entry = hit;
      const deviceId = await read;
      entry.deviceId = deviceId;
      entry.at = Date.now();
      entry.read = null;
      // Bounded: entries of sessions no frame named for a while are dropped.
      if (cache.size > 1_000) {
        for (const [k, e] of cache) if (Date.now() - e.at > SESSION_DEVICE_TTL_MS) cache.delete(k);
      }
      return deviceId === device.deviceId;
    }
    const deviceId = hit.read ? await hit.read : hit.deviceId;
    return deviceId === device.deviceId;
  };
}
