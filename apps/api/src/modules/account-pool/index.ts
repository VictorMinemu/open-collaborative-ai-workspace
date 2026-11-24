import type { ApiModule, Core } from "../../core";
import { type AccountPoolDeps, registerAccountPoolRoutes } from "./routes";

export {
  createDeviceAccountHandler,
  type DeviceAccountParts,
  defaultDeviceAccountParts,
} from "./device-frames";
export {
  createDeviceSignIns,
  DEVICE_SIGN_IN_SIGNAL,
  DEVICE_SIGN_IN_START_TIMEOUT_MS,
  type DeviceSignIns,
  deviceSignInKey,
} from "./device-sign-ins";
export {
  earliestPoolReset,
  everyAccountLimitedSentence,
  type LimitInput,
  type LimitResult,
  markLimited,
  markNeedsSignIn,
  type RecordUsageInput,
  recordUsage,
} from "./limits";
export { previewAccountSources } from "./preview";
export type { AccountPoolDeps } from "./routes";
export { cooldownUntil } from "./select";
export {
  type AccountPoolPort,
  createAccountPoolPort,
  getPoolAccount,
  noAccountSentence,
  type PoolConsumer,
  type SelectAccountInput,
  type SelectAccountResult,
  type StoredSessionAccount,
  selectAccount,
  servesConsumer,
  storedSessionAccount,
  usableFor,
} from "./selection";
export { applySlotsSync, type SlotsSyncOptions, type SlotsSyncResult } from "./slots";
export {
  addClaudeToken,
  insertPoolAccount,
  listPoolAccounts,
  loadPoolPolicy,
  loadPoolView,
  lockPool,
  type NewPoolAccount,
  type PoolAccountRow,
  type PoolChange,
  type PoolDevice,
  type PoolPorts,
  poolAccountStatus,
  poolDevices,
  removeCellProfiles,
  removePoolAccount,
  reorderPool,
  toPoolAccount,
  updatePoolAccount,
  updatePoolPolicy,
} from "./store";
export { openPoolToken, poolTokenAad, replacePoolToken, sealPoolToken } from "./tokens";

/**
 * account-pool module (Phase 07.18, D-01, D-02, D-10, D-13; ADR-0044): the organization's pool of Claude and ChatGPT
 * subscription accounts, one per provider, with its strategy, order and per-account status. It owns
 * `app.account_pool_accounts` and `app.account_pool_policies`, and the only seal and open of Claude setup-tokens
 * (`tokens.ts`, secret kind `pool_token`, AAD `<orgId>:account_pool:<accountId>`). A token is written once and never
 * returned by any route, audit row or log line.
 *
 * Routes (all `authz: user`, `provider.manage`, `cache-control: no-store`): GET `/account-pool`, POST
 * `/account-pool/claude/accounts`, PATCH and DELETE `/account-pool/accounts/:id` (removal is soft, PD-25), PUT
 * `/account-pool/:provider/order` and PUT `/account-pool/:provider/policy`. Every write is audited `account_pool.*` in
 * its transaction and reported to `deps.onChange` there. GET `/account-pool/preview?deviceId=` (07.18-09, PD-19) is the
 * one member route: any member who may use the device sees what a new session there would run on, without labels.
 * Selection for Work Zone sessions is `selection.ts` (`createAccountPoolPort`).
 *
 * 07.18-13 (D-02, D-10, PD-11, PD-25): POST `/account-pool/chatgpt/device-sign-ins`, GET and DELETE
 * `/account-pool/chatgpt/device-sign-ins/current?deviceId=` sign a ChatGPT account in on a service device
 * (`device-sign-ins.ts`); the device's `accounts.sync` keeps its slot rows in step (`slots.ts`), a slot no admin started
 * arriving disabled; removing a slot account sends `account.logout` to its device.
 */
export function createAccountPoolModule(core: Core, deps: AccountPoolDeps = {}): ApiModule {
  return {
    name: "account-pool",
    register(app) {
      registerAccountPoolRoutes(app, core, deps);
    },
  };
}
