import {
  ApprovePluginInstallRequest,
  CellPlugin,
  CellPluginList,
  IdParams,
  MarketplacePackageDetail,
  MarketplacePackageParams,
  MarketplacePackageQuery,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
  UpdateCellPluginRequest,
} from "@ocw/contracts";
import { type App, tenant } from "../../core";
import type { PermissionService } from "../organization";
import {
  approveInstall,
  listCellPlugins,
  type PluginsDeps,
  packageDetail,
  searchMarketplace,
  uninstallCellPlugin,
  updateCellPlugin,
} from "./service";

const tags = ["marketplace"];

/**
 * Settings › Marketplace (D-14): every route is `plugin.manage` (admin surface, non-delegable, T-03.1-11-07), so
 * nobody else can make the API call ClawHub. Other tenants see nothing: RLS turns their reads into 404.
 */
export function registerPluginRoutes(app: App, deps: PluginsDeps, perms: PermissionService) {
  const { core } = deps;
  const manage = {
    config: { authz: "user" as const },
    preHandler: [core.identity.requireUser, perms.requirePermission("plugin.manage")],
  };

  app.get(
    "/marketplace/search",
    {
      ...manage,
      schema: { tags, querystring: MarketplaceSearchQuery, response: { 200: MarketplaceSearchResult } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return searchMarketplace(deps, tenant(req), req.query);
    },
  );

  app.get(
    "/marketplace/packages/:name",
    {
      ...manage,
      schema: {
        tags,
        params: MarketplacePackageParams,
        querystring: MarketplacePackageQuery,
        response: { 200: MarketplacePackageDetail },
      },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return packageDetail(deps, tenant(req), req.params.name, req.query.version);
    },
  );

  app.post(
    "/marketplace/installs",
    { ...manage, schema: { tags, body: ApprovePluginInstallRequest, response: { 200: CellPlugin } } },
    async (req) => approveInstall(deps, tenant(req), req.body),
  );

  app.get(
    "/cell-plugins",
    { ...manage, schema: { tags, response: { 200: CellPluginList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const plugins = await core.db.withTenant(tenant(req), (tx) => listCellPlugins(tx));
      return { plugins };
    },
  );

  app.patch(
    "/cell-plugins/:id",
    {
      ...manage,
      schema: { tags, params: IdParams, body: UpdateCellPluginRequest, response: { 200: CellPlugin } },
    },
    async (req) => updateCellPlugin(deps, tenant(req), req.params.id, req.body),
  );

  app.delete(
    "/cell-plugins/:id",
    { ...manage, schema: { tags, params: IdParams, response: { 200: CellPlugin } } },
    async (req) => uninstallCellPlugin(deps, tenant(req), req.params.id),
  );
}
