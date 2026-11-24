import type { ApiModule, Core } from "../../core";
import { type AccountPoolDeps, registerAccountPoolRoutes } from "./routes";

export type { AccountPoolDeps } from "./routes";
export {
  insertPoolAccount,
  listPoolAccounts,
  loadPoolPolicy,
  loadPoolView,
  lockPool,
  type NewPoolAccount,
  type PoolAccountRow,
  type PoolChange,
  type PoolDevice,
  poolAccountStatus,
  poolDevices,
  toPoolAccount,
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
 * `/account-pool/claude/accounts`.
 */
export function createAccountPoolModule(core: Core, deps: AccountPoolDeps = {}): ApiModule {
  return {
    name: "account-pool",
    register(app) {
      registerAccountPoolRoutes(app, core, deps);
    },
  };
}
