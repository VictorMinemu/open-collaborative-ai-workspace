import type { ApiModule, Core } from "../../core";
import { createPermissionService } from "../organization";
import { registerKeychainRoutes } from "./routes";

export { clientCredentialsToken, forgetClientCredentialsToken } from "./client-credentials";
export {
  buildInjectionHeader,
  hostAllowed,
  KeychainError,
  pathAllowed,
  StoredSecret,
  sanitizeModelHeaders,
  secretParts,
} from "./inject";
export {
  type EffectiveVaultItem,
  effectiveVaultItems,
  findVaultItemByHandle,
  injectionFor,
  loadPrivateHosts,
  openVaultSecret,
  prepareInjection,
  privateAllowFor,
  recordSecretUsed,
  type VaultItemRow,
  vaultAad,
} from "./service";

/**
 * keychain module (Phase 07.4, D-04, D-06, D-07; CONN-05): secrets bots use by handle, stored sealed by reference,
 * with the rules that decide when an agent may use one and the header injection the http-request proxy applies
 * (07.4-11). Routes (all `authz: user`): GET/POST `/keychain`, GET/PATCH/DELETE `/keychain/:id`,
 * PUT `/keychain/:id/agents`, GET/PUT `/keychain/private-hosts` (admins: `bot.manage`).
 */
export function createKeychainModule(core: Core): ApiModule {
  const perms = createPermissionService(core);
  return {
    name: "keychain",
    register(app) {
      registerKeychainRoutes(app, core, perms);
    },
  };
}
