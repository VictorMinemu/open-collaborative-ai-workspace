import type { Core } from "../../core";
import type { DeviceAccountHandler } from "../device";
import { createDeviceSignIns } from "./device-sign-ins";
import { recordUsage } from "./limits";
import { applySlotsSync } from "./slots";

/**
 * The parts of the device account handler: the Codex slots a device reports, and the device sign-ins it runs
 * (07.18-13). Each is optional; a frame whose part is missing is ignored.
 */
export interface DeviceAccountParts {
  slots?: Pick<DeviceAccountHandler, "onAccountsSync">;
  signIns?: Pick<DeviceAccountHandler, "onAccountLogin" | "onAccountCommandResult">;
}

/**
 * The default parts (07.18-13, D-02, PD-11, E11): `accounts.sync` reconciles the device's slot rows (`applySlotsSync`,
 * leaving the slot of a running sign-in to the sign-in), `account.login` frames and `account.*` acks drive the device
 * sign-ins (`createDeviceSignIns`). Frames send no command, so no hub is needed here.
 */
export function defaultDeviceAccountParts(core: Core): Required<DeviceAccountParts> {
  const signIns = createDeviceSignIns(core);
  return {
    slots: {
      async onAccountsSync(device, frame) {
        const signingIn = await signIns.inFlightSlots(device.organizationId, device.deviceId);
        await core.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
          applySlotsSync(tx, core.audit, device, frame, { signingIn }),
        );
      },
    },
    signIns: {
      onAccountLogin: (device, frame) => signIns.onAccountLogin(device, frame),
      onAccountCommandResult: (device, command, ok, error) =>
        signIns.onCommandResult(device, command, ok, error),
    },
  };
}

/**
 * The one handler of a device's account frames (Phase 07.18, D-09, PD-09, E11), registered with
 * `deviceModule.hub.setAccountHandler`. Every frame runs in the device's own tenant (the organization comes from the
 * link's authentication, never from the frame). `account.usage` is stored here (`recordUsage`, ownership checked);
 * `accounts.sync`, `account.login` and the acks of `account.*` commands go to `parts` (by default
 * `defaultDeviceAccountParts`).
 */
export function createDeviceAccountHandler(
  core: Core,
  parts: DeviceAccountParts = defaultDeviceAccountParts(core),
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
