import {
  CreateVaultItemRequest,
  IdParams,
  Ok,
  PrivateHostsSettings,
  SetVaultItemAgentsRequest,
  UpdateVaultItemRequest,
  VaultItem,
  VaultItemList,
} from "@ocw/contracts";
import { type App, authOf, type Core, tenant } from "../../core";
import type { PermissionService } from "../organization";
import {
  createVaultItem,
  deleteVaultItem,
  getVaultItem,
  listVaultItems,
  loadPrivateHosts,
  setPrivateHosts,
  setVaultItemAgents,
  updateVaultItem,
} from "./service";

const tags = ["keychain"];

export interface KeychainDeps {
  /**
   * Called after the commit of a private-host change, with the organization's id (07.8 hardening): the app pushes the
   * organization's sandbox policy to sandboxd, the same path as a settings change, so the egress proxy enforces the new
   * list at once. Injected so this module never imports the sandbox module.
   */
  onPrivateHostsChanged?: (organizationId: string) => Promise<unknown>;
}

/**
 * Settings › Keychain (Phase 07.4, D-04, D-06; UI-SPEC § 3). Every route is `authz: user` and decided by the resolver
 * in the service: personal items are their owner's alone, unit items need `vault.manage` on their unit, another
 * member's or another organization's item is 404. No response carries a value (`hasValue` only). The private-host
 * allowlist is an organization policy (`bot.manage`, UI-SPEC R5).
 */
export function registerKeychainRoutes(
  app: App,
  core: Core,
  perms: PermissionService,
  deps: KeychainDeps = {},
) {
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };
  const admin = {
    config: { authz: "user" as const },
    preHandler: [core.identity.requireUser, perms.requirePermission("bot.manage")],
  };

  app.get(
    "/keychain",
    { ...user, schema: { tags, response: { 200: VaultItemList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => listVaultItems(perms, req, tx));
    },
  );

  app.post(
    "/keychain",
    { ...user, schema: { tags, body: CreateVaultItemRequest, response: { 201: VaultItem } } },
    async (req, reply) => {
      const item = await core.db.withTenant(tenant(req), (tx) =>
        createVaultItem(core, perms, req, tx, req.body),
      );
      reply.code(201);
      return item;
    },
  );

  app.get(
    "/keychain/private-hosts",
    { ...admin, schema: { tags, response: { 200: PrivateHostsSettings } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return { hosts: await core.db.withTenant(tenant(req), (tx) => loadPrivateHosts(tx)) };
    },
  );

  app.put(
    "/keychain/private-hosts",
    { ...admin, schema: { tags, body: PrivateHostsSettings, response: { 200: PrivateHostsSettings } } },
    async (req) => {
      const saved = await core.db.withTenant(tenant(req), (tx) =>
        setPrivateHosts(core, tx, req.body.hosts, authOf(req).userId),
      );
      // After the commit: sandboxd and its egress proxy get the organization's policy with the new list (never throws).
      await deps.onPrivateHostsChanged?.(authOf(req).organizationId);
      return saved;
    },
  );

  app.get(
    "/keychain/:id",
    { ...user, schema: { tags, params: IdParams, response: { 200: VaultItem } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => getVaultItem(perms, req, tx, req.params.id));
    },
  );

  app.patch(
    "/keychain/:id",
    {
      ...user,
      schema: { tags, params: IdParams, body: UpdateVaultItemRequest, response: { 200: VaultItem } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) => updateVaultItem(core, perms, req, tx, req.params.id, req.body)),
  );

  app.delete(
    "/keychain/:id",
    { ...user, schema: { tags, params: IdParams, response: { 200: Ok } } },
    async (req) => {
      await core.db.withTenant(tenant(req), (tx) => deleteVaultItem(core, perms, req, tx, req.params.id));
      return { ok: true as const };
    },
  );

  app.put(
    "/keychain/:id/agents",
    {
      ...user,
      schema: { tags, params: IdParams, body: SetVaultItemAgentsRequest, response: { 200: VaultItem } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) =>
        setVaultItemAgents(core, perms, req, tx, req.params.id, req.body.agentIds),
      ),
  );
}
