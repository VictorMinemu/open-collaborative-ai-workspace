import type { ApiModule, Core } from "../../core";
import type { DeviceBrowserHandler, DeviceHub } from "../device";
import { onBrowserEvent } from "./events";

export { onBrowserEvent } from "./events";

/**
 * The Work Zone browser module (Phase 07.13; D-14, D-15, D-20 … D-28): the Control Plane side of the browser a
 * member's Work Zone session drives on its own device. It sits BESIDE the bots' `modules/browser` (sandboxd contexts)
 * and never generalizes it; anything it reuses from there comes through `modules/browser/index.ts` only.
 *
 * - Device frames: `deviceHandler` is registered on the Device Link hub (`hub.setBrowserHandler`). `browser.event`
 *   keeps the session's `work_browsers` row and audits `work_browser.*` (`events.ts`, 07.13-08); later plans add the
 *   live frames (`onBinary`, 10), the takeover focus hint (`onFocus`, 18) and the sign-in load (`onSignInLoad`, 17)
 *   by assigning the handler's methods.
 * - Server → device browser frames go through `hub.sendBrowserFrame` (ephemeral: never queued, never logged), and only
 *   to a device whose hello carried `browser` (PD-20).
 */
export interface WorkBrowserModule {
  module: ApiModule;
  /** Registered with `hub.setBrowserHandler`; its methods are this module's device frame handlers. */
  deviceHandler: DeviceBrowserHandler;
  /** The Device Link hub this module sends browser frames through. */
  hub: DeviceHub;
}

export function createWorkBrowserModule(core: Core, deps: { hub: DeviceHub }): WorkBrowserModule {
  const deviceHandler: DeviceBrowserHandler = {
    onBrowserEvent: onBrowserEvent(core),
  };
  return {
    module: {
      name: "work-browser",
      register() {},
    },
    deviceHandler,
    hub: deps.hub,
  };
}
