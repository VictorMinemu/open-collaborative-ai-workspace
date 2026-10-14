import {
  CreateMcpServerRequest,
  connectorOAuthUrls,
  IdParams,
  McpServer,
  McpServerList,
  Ok,
  UpdateMcpServerRequest,
} from "@ocw/contracts";
import { z } from "zod";
import { type App, type Core, tenant } from "../../core";
import type { PermissionService } from "../organization";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  mcpReadOptions,
  probeMcpServer,
  sandboxInfo,
  updateMcpServer,
} from "./service";

const tags = ["mcp"];

/** `DELETE ?clearConnections=true`: confirms disconnecting every member of a per-member connector (D-01, R4). */
const DeleteMcpServerQuery = z.object({ clearConnections: z.enum(["true", "false"]).optional() });

/**
 * Settings › MCP servers (D-13): every route is `mcp.manage` (admin surface, non-delegable, T-03.1-09-03).
 * Other tenants see nothing: RLS turns their reads into 404. Phase 07.4 adds the connector auth mode; a PATCH that
 * leaves a per-member mode, or a DELETE, answers 409 `connections_exist {count}` while members are connected, until
 * `clearConnections` confirms.
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
      const servers = await core.db.withTenant(tenant(req), (tx) => listMcpServers(tx, mcpReadOptions(core)));
      // The redirect URI to register at a provider, and whether member sign-in is possible here (D-07 item 4).
      return { servers, sandbox: sandboxInfo(core), oauth: connectorOAuthUrls(core.env.OCW_PUBLIC_API_URL) };
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
      return core.db.withTenant(tenant(req), (tx) => getMcpServer(tx, req.params.id, mcpReadOptions(core)));
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
    {
      ...manage,
      schema: { tags, params: IdParams, querystring: DeleteMcpServerQuery, response: { 200: Ok } },
    },
    async (req) => {
      const clearConnections = req.query.clearConnections === "true";
      await core.db.withTenant(tenant(req), (tx) =>
        deleteMcpServer(core, tx, req.params.id, { clearConnections }),
      );
      return { ok: true as const };
    },
  );

  app.post(
    "/mcp-servers/:id/probe",
    { ...manage, schema: { tags, params: IdParams, response: { 200: McpServer } } },
    async (req) => core.db.withTenant(tenant(req), (tx) => probeMcpServer(core, tx, req.params.id)),
  );
}
