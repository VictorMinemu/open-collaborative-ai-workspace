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
import { onSignInLoad } from "./load";
import { registerSignInRoutes } from "./signin-routes";
import { createWorkBrowserSweeper, type WorkBrowserSweeper } from "./sweep";

export { onBrowserEvent } from "./events";
export type { WorkLiveHub, WorkLiveStats } from "./live";
export { decideSignInLoad, type SignInLoadDecision } from "./load";
export { workSignInAad } from "./signins";
export type { WorkBrowserSweeper } from "./sweep";

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
 * - Members' sign-ins (07.13-17, D-22 … D-25, D-32): sealed per member × site (`signins.ts`), listed and revoked by
 *   their owner and uploaded / re-sealed by the session's device (`signin-routes.ts`), loaded only by the API's own
 *   decision and answered on the requesting socket (`load.ts`, `onSignInLoad`), swept when expired (`sweep.ts`).
 */
export interface WorkBrowserModule {
  module: ApiModule;
  /** Registered with `hub.setBrowserHandler`; its methods are this module's device frame handlers. */
  deviceHandler: DeviceBrowserHandler;
  /** The Device Link hub this module sends browser frames through. */
  hub: DeviceHub;
  /** This instance's live-view hub once the routes are registered (tests: `stats`, `heartbeat`). */
  live(): WorkLiveHub | null;
  /** The expired sign-in sweep (07.13-17; tests call `runOnce(nowMs)`). */
  sweeper: WorkBrowserSweeper;
}

/** How long the session → device answer of a frame is trusted before it is read again (T-07.13-10-03). */
const SESSION_DEVICE_TTL_MS = 5_000;

export function createWorkBrowserModule(
  core: Core,
  deps: { hub: DeviceHub; allowedOrigins?: Set<string> },
): WorkBrowserModule {
  let live: WorkLiveHub | null = null;
  const perms = createPermissionService(core);
  const sweeper = createWorkBrowserSweeper(core, deps.hub);
  const sessionDevice = sessionDeviceCheck(core);
  const deviceHandler: DeviceBrowserHandler = {
    onBrowserEvent: onBrowserEvent(core),
    // 07.13-17 (D-24, D-32, PD-16, P7): decided by the API, answered on the requesting socket only.
    onSignInLoad: onSignInLoad(core, perms),
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
    // 07.13-18 (D-20): the masking hint goes to the lease holder's socket only; a frame naming a session that does not
    // run on the sending device, or a lease that is not the page's current one, reaches nobody.
    async onFocus(device, frame) {
      const hubNow = live;
      if (!hubNow) return;
      if (!(await sessionDevice(device, frame.sessionId))) return;
      await hubNow.onFocus(device.organizationId, frame);
    },
  };
  return {
    module: {
      name: "work-browser",
      register(app) {
        // 07.13-17: the member's own sign-ins (Keychain), the device's hand-back upload and its re-seal; expired
        // sign-ins are swept.
        registerSignInRoutes(app, { core, perms, hub: deps.hub });
        sweeper.start();
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
        sweeper.stop();
        await live?.close();
      },
    },
    deviceHandler,
    hub: deps.hub,
    live: () => live,
    sweeper,
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
