import type { ApiModule, Core } from "../../core";
import { createPermissionService } from "../organization";
import { createClawhubClient } from "./clawhub";
import { registerPluginRoutes } from "./routes";

export {
  CLAWHUB_TIMEOUT_MS,
  type ClawhubClient,
  createClawhubClient,
  declaredSurfaceOf,
  MarketplaceNotFoundError,
  MarketplaceUnavailableError,
} from "./clawhub";
export {
  bundledPluginIds,
  canonicalSurface,
  compatibilityOf,
  OPENCLAW_HOST_VERSION,
  refusedReportedSurface,
  reviewTokenOf,
  type SandboxPackageRiskInput,
  scorePluginRisk,
  scoreSandboxPackageRisk,
} from "./risk";
export {
  approveInstall,
  buildVersionReview,
  type CellActor,
  cellApprovedPlugins,
  cellPluginList,
  getCellPlugin,
  listCellPlugins,
  type PluginsDeps,
  packageDetail,
  recordPluginReport,
  searchMarketplace,
  uninstallCellPlugin,
  updateCellPlugin,
  verifyInstall,
} from "./service";

/**
 * plugins module (Phase 3.1, D-14; BOT-09, BOT-10): the OpenClaw Marketplace. The API proxies ClawHub
 * (`OCW_CLAWHUB_URL`, cached, telemetry-free), scores every release, and lets Organization Admins
 * (`plugin.manage`) approve exact pinned versions, change plugin settings, update and uninstall. The cell executes
 * `plugin.install.v1` / `plugin.uninstall.v1` and reports back (03.1-12).
 *
 * Routes (all `authz: user` + `plugin.manage`): GET `/marketplace/search`, GET `/marketplace/packages/:name`,
 * POST `/marketplace/installs`, GET `/cell-plugins`, PATCH/DELETE `/cell-plugins/:id`.
 */
export function createPluginsModule(core: Core): ApiModule {
  const perms = createPermissionService(core);
  const clawhub = createClawhubClient({ baseUrl: core.env.OCW_CLAWHUB_URL, bus: core.bus });
  return {
    name: "plugins",
    register(app) {
      registerPluginRoutes(app, { core, clawhub }, perms);
    },
  };
}
