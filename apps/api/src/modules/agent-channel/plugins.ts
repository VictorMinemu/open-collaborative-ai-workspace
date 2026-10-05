import {
  AgentChannelPluginList,
  AgentChannelPluginReport,
  AgentChannelPluginVerifyInstall,
  AgentChannelPluginVerifyInstallResponse,
  Ok,
} from "@ocw/contracts";
import type { App, Core } from "../../core";
import { cellPluginList, recordPluginReport, verifyInstall } from "../plugins";
import { cellOf } from "./auth";

/**
 * The cell's side of the OpenClaw Marketplace (03.1-12, D-14), all under the cell token (`cell.sync`):
 *   POST /plugins/verify-install  the install gate's question: exactly this staged (package, version, sha256) an
 *                                 admin-approved install in flight? The gate trusts only this answer (fail closed).
 *   GET  /plugins                 installed plugin ids for the boot allowlist (no digest, no secret).
 *   POST /plugins/report          one install / uninstall outcome; declared tools become capabilities after re-scoring.
 * Another organization's rows are invisible (RLS): its tuples never approve, its flows are 404.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];

export function registerPluginCellRoutes(scope: App, core: Core): void {
  const tenant = (organizationId: string) => ({ organizationId, userId: null });

  scope.post(
    "/plugins/verify-install",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelPluginVerifyInstall,
        response: { 200: AgentChannelPluginVerifyInstallResponse },
      },
    },
    async (req, reply) => {
      const cell = cellOf(req);
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(cell.organizationId), (tx) =>
        verifyInstall(core, tx, req.body, { sessionId: `cell:${cell.credentialId}` }),
      );
    },
  );

  scope.get(
    "/plugins",
    {
      config: { authz: "cell" as const },
      schema: { tags, security: bearer, response: { 200: AgentChannelPluginList } },
    },
    async (req, reply) => {
      const cell = cellOf(req);
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(cell.organizationId), (tx) => cellPluginList(tx));
    },
  );

  scope.post(
    "/plugins/report",
    {
      config: { authz: "cell" as const },
      schema: { tags, security: bearer, body: AgentChannelPluginReport, response: { 200: Ok } },
    },
    async (req) => {
      const cell = cellOf(req);
      await core.db.withTenant(tenant(cell.organizationId), (tx) =>
        recordPluginReport(core, tx, req.body, { sessionId: `cell:${cell.credentialId}` }),
      );
      return { ok: true as const };
    },
  );
}
