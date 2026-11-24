import type { Core } from "../../core";
import type { DeviceAccountHandler } from "../device";
import { recordUsage } from "./limits";

/**
 * The parts of the device account handler other plans add (07.18-13: the Codex slots a device reports, and the device
 * sign-ins it runs). Each is optional; a frame whose part is missing is ignored.
 */
export interface DeviceAccountParts {
  slots?: Pick<DeviceAccountHandler, "onAccountsSync">;
  signIns?: Pick<DeviceAccountHandler, "onAccountLogin" | "onAccountCommandResult">;
}

/**
 * The one handler of a device's account frames (Phase 07.18, D-09, PD-09, E11), registered with
 * `deviceModule.hub.setAccountHandler`. Every frame runs in the device's own tenant (the organization comes from the
 * link's authentication, never from the frame). `account.usage` is stored here (`recordUsage`, ownership checked);
 * `accounts.sync`, `account.login` and the acks of `account.*` commands go to `parts` when given.
 */
export function createDeviceAccountHandler(
  core: Pick<Core, "db">,
  parts: DeviceAccountParts = {},
): DeviceAccountHandler {
  const handler: DeviceAccountHandler = {
    async onAccountUsage(device, frame) {
      await core.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
        recordUsage(tx, {
          deviceId: device.deviceId,
          accountId: frame.accountId,
          slotId: frame.slotId,
          usage: frame.usage,
          now: new Date(),
        }),
      );
    },
  };
  const { slots, signIns } = parts;
  if (slots?.onAccountsSync) handler.onAccountsSync = (d, f) => slots.onAccountsSync!(d, f);
  if (signIns?.onAccountLogin) handler.onAccountLogin = (d, f) => signIns.onAccountLogin!(d, f);
  if (signIns?.onAccountCommandResult) {
    handler.onAccountCommandResult = (d, c, ok, e) => signIns.onAccountCommandResult!(d, c, ok, e);
  }
  return handler;
}
