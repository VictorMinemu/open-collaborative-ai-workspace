import {
  CreateMcpServerRequest,
  IdParams,
  McpServer,
  McpServerList,
  Ok,
  UpdateMcpServerRequest,
} from "@ocw/contracts";
import { type App, type Core, tenant } from "../../core";
import type { PermissionService } from "../organization";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  probeMcpServer,
  sandboxInfo,
  updateMcpServer,
} from "./service";

const tags = ["mcp"];

/**
 * Settings › MCP servers (D-13): every route is `mcp.manage` (admin surface, non-delegable, T-03.1-09-03).
 * Other tenants see nothing: RLS turns their reads into 404.
 */
export function registerMcpRoutes(app: App, core: Core, perms: PermissionService) {
  const manage = {
    config: { authz: "user" as const },
    preHandler: [core.identity.requireUser, perms.requirePermission("mcp.manage")],
  };

  app.get(
    "/mcp-servers",
    { ...manage, schema: { tags, response: { 200: McpServerList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const servers = await core.db.withTenant(tenant(req), (tx) => listMcpServers(tx));
      return { servers, sandbox: sandboxInfo(core) };
    },
  );

  app.post(
    "/mcp-servers",
    { ...manage, schema: { tags, body: CreateMcpServerRequest, response: { 200: McpServer } } },
    async (req) => core.db.withTenant(tenant(req), (tx) => createMcpServer(core, tx, req.body)),
  );

  app.get(
    "/mcp-servers/:id",
    { ...manage, schema: { tags, params: IdParams, response: { 200: McpServer } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => getMcpServer(tx, req.params.id));
    },
  );

  app.patch(
    "/mcp-servers/:id",
    {
      ...manage,
      schema: { tags, params: IdParams, body: UpdateMcpServerRequest, response: { 200: McpServer } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) => updateMcpServer(core, tx, req.params.id, req.body)),
  );

  app.delete(
    "/mcp-servers/:id",
    { ...manage, schema: { tags, params: IdParams, response: { 200: Ok } } },
    async (req) => {
      await core.db.withTenant(tenant(req), (tx) => deleteMcpServer(core, tx, req.params.id));
      return { ok: true as const };
    },
  );

  app.post(
    "/mcp-servers/:id/probe",
    { ...manage, schema: { tags, params: IdParams, response: { 200: McpServer } } },
    async (req) => core.db.withTenant(tenant(req), (tx) => probeMcpServer(core, tx, req.params.id)),
  );
}
