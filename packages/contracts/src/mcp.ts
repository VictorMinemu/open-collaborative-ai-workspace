import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import {
  ConnectorAuthMode,
  ConnectorOAuthClientInput,
  ConnectorOAuthClientView,
  ConnectorOAuthStatus,
  ConnectorOAuthUrls,
  jsonBytes,
} from "./connectors";

/**
 * MCP server registry (Phase 3.1, D-13; BOT-08, BOT-10). Organization Admins (`mcp.manage`) register remote
 * MCP servers (streamable HTTP or legacy SSE) or a vetted server of the stdio sandbox sidecar. Header
 * credentials are WRITE-ONLY: they are stored as SecretReferences (`app.secrets`, kind `mcp_credential`) and
 * travel only to the cell over the authenticated Agent Channel (`CellMcpServer`), never in these DTOs, logs or
 * audit rows (principle 8).
 *
 * Tools are discovered by a probe the cell runs (`mcp.probe` on the cell stream); recorded tools become catalog
 * entries (`<safeName>__<tool>`) that bot managers grant per bot through the capabilities API.
 *
 * Phase 07.4 (D-01) adds the connector auth mode: `org_secret` (the headers above, rendered in the cell) or a
 * per-member mode, where each member connects their own account and the API proxies every call (`connectors.ts`).
 * Every 07.4 field is optional or defaulted, so Phase 3.1 payloads parse unchanged.
 */

export const McpTransport = z.enum(["streamable-http", "sse", "sandboxed-stdio"]);
export type McpTransport = z.infer<typeof McpTransport>;

export const McpHeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "invalid header name");
export type McpHeaderName = z.infer<typeof McpHeaderName>;

/** One header on create/update: a new `value`, or `keep: true` to reuse the stored secret of that name. */
export const McpHeaderInput = z.object({
  name: McpHeaderName,
  value: z.string().min(1).max(4000).optional(),
  keep: z.boolean().optional(),
});
export type McpHeaderInput = z.infer<typeof McpHeaderInput>;

/** Bound of a recorded tool input schema (`mcp_server_tools.input_schema`). */
export const MCP_INPUT_SCHEMA_MAX_BYTES = 16 * 1024;

/**
 * The value prefix put before a member's key in `memberHeaderName` (e.g. `Bearer `): printable ASCII only, so it can
 * never split the header (no CR, LF or other control character).
 */
export const McpMemberHeaderPrefix = z
  .string()
  .max(32)
  .regex(/^[\x20-\x7E]*$/, "printable characters only (no line breaks)");

/** OAuth scopes an admin requests instead of the server's advertised ones. */
export const McpOAuthScopes = z.array(z.string().trim().min(1).max(200)).max(32);

export const McpServerStatus = z.enum(["pending", "probing", "ready", "error"]);
export type McpServerStatus = z.infer<typeof McpServerStatus>;

/** A tool discovered by the probe. `openclawName` is what grants, turns and the cell use. */
export const McpServerTool = z.object({
  name: z.string(),
  openclawName: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  /** Phase 07.4: the tool's JSON input schema (API-side probe), for `ocw_connector_list`; at most 16 KB serialized. */
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine((v) => jsonBytes(v) <= MCP_INPUT_SCHEMA_MAX_BYTES, { message: "input schema over 16 KB" })
    .nullable()
    .optional(),
});
export type McpServerTool = z.infer<typeof McpServerTool>;

export const McpServer = z.object({
  id: Id,
  name: z.string(),
  /** Immutable OpenClaw server name `m` + 8 hex chars (Pitfall P-B2). */
  safeName: z.string(),
  transport: McpTransport,
  url: z.string().nullable(),
  sandboxServer: z.string().nullable(),
  /** Header NAMES only: a value is never returned. */
  headers: z.array(z.object({ name: McpHeaderName, hasValue: z.literal(true) })),
  orgEnabled: z.boolean(),
  personalAllowed: z.boolean(),
  trustedChaining: z.boolean(),
  status: McpServerStatus,
  statusDetail: z.string().nullable(),
  probedAt: IsoDateTime.nullable(),
  tools: z.array(McpServerTool),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // Phase 07.4 (D-01): connector auth mode. Defaults read a Phase 3.1 server as `org_secret`.
  authMode: ConnectorAuthMode.default("org_secret"),
  /** `per_member_secret`: the header a member's key goes in, and the prefix before it. */
  memberHeaderName: McpHeaderName.nullable().default(null),
  memberHeaderPrefix: z.string().nullable().default(null),
  /** `per_member_oauth`: the admin's scope override (null = the server's challenge or advertised scopes). */
  oauthScopes: z.array(z.string()).nullable().default(null),
  /** `per_member_oauth`: whether members can start a connection; null for the other modes. */
  oauthStatus: ConnectorOAuthStatus.nullable().default(null),
  /** Client registrations per issuer: the client secret is never returned (`hasSecret`). */
  oauthClients: z.array(ConnectorOAuthClientView).default([]),
  /** Members connected to it (0 for `org_secret`), shown before a mode switch or a delete clears them (R4). */
  memberConnections: z.number().int().nonnegative().default(0),
});
export type McpServer = z.infer<typeof McpServer>;

export const McpServerList = z.object({
  servers: z.array(McpServer),
  /** The stdio sandbox sidecar (`OCW_MCP_SANDBOX_URL`) and the vetted servers baked into it. */
  sandbox: z.object({ available: z.boolean(), servers: z.array(z.string()) }),
  /** Phase 07.4: the instance's OAuth callback and client metadata URLs (optional, so 3.1 lists parse). */
  oauth: ConnectorOAuthUrls.optional(),
});
export type McpServerList = z.infer<typeof McpServerList>;

/** The 07.4 connector fields shared by create and update (null on update clears; refinements below). */
const connectorAuthFields = {
  memberHeaderName: McpHeaderName.optional(),
  memberHeaderPrefix: McpMemberHeaderPrefix.optional(),
  oauthScopes: McpOAuthScopes.optional(),
  oauthClient: ConnectorOAuthClientInput.optional(),
};

const STDIO_MESSAGE =
  "per-member connectors need a streamable-http or sse server (stdio has no member sign-in)";

/** One issue per broken connector rule of `mode`, the request's resulting mode (D-01, CONN-01). */
function checkConnectorAuth(
  mode: ConnectorAuthMode,
  v: {
    transport?: McpTransport | undefined;
    headers?: readonly McpHeaderInput[] | undefined;
    memberHeaderName?: string | null | undefined;
    oauthScopes?: readonly string[] | null | undefined;
    oauthClient?: ConnectorOAuthClientInput | null | undefined;
  },
  ctx: z.RefinementCtx,
  memberHeaderRequired: boolean,
): void {
  const perMember = mode !== "org_secret";
  if (perMember && v.transport === "sandboxed-stdio") {
    ctx.addIssue({ code: "custom", path: ["authMode"], message: STDIO_MESSAGE });
  }
  if (perMember && v.headers !== undefined && v.headers.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["headers"],
      message: "a per-member connector has no organization headers",
    });
  }
  if (mode === "per_member_secret") {
    if (v.memberHeaderName === null || (memberHeaderRequired && v.memberHeaderName === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["memberHeaderName"],
        message: "name the header each member's key is sent in",
      });
    }
  } else if (typeof v.memberHeaderName === "string") {
    ctx.addIssue({
      code: "custom",
      path: ["memberHeaderName"],
      message: "only per_member_secret takes a header",
    });
  }
  if (mode !== "per_member_oauth") {
    if (v.oauthClient) {
      ctx.addIssue({
        code: "custom",
        path: ["oauthClient"],
        message: "only per_member_oauth takes an OAuth client",
      });
    }
    if (v.oauthScopes && v.oauthScopes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["oauthScopes"],
        message: "only per_member_oauth takes OAuth scopes",
      });
    }
  }
}

export const CreateMcpServerRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    transport: McpTransport,
    /** Required for `streamable-http` / `sse`: https, or http to a private compose host. */
    url: z.string().max(2000).optional(),
    /** Required for `sandboxed-stdio`: one of the sandbox's vetted servers. */
    sandboxServer: z.string().max(64).optional(),
    headers: z.array(McpHeaderInput).max(8).default([]),
    orgEnabled: z.boolean().default(true),
    personalAllowed: z.boolean().default(false),
    trustedChaining: z.boolean().default(false),
    /** Phase 07.4 (D-01): `org_secret` = Phase 3.1 behaviour. */
    authMode: ConnectorAuthMode.default("org_secret"),
    ...connectorAuthFields,
  })
  .superRefine((v, ctx) => checkConnectorAuth(v.authMode, v, ctx, true));
export type CreateMcpServerRequest = z.infer<typeof CreateMcpServerRequest>;

/**
 * `PATCH`: any subset; `headers`, when present, REPLACES the header set (`keep` reuses a stored value). Built
 * without the create defaults on purpose: `CreateMcpServerRequest.partial()` would still apply them in Zod 4,
 * so a PATCH of one flag would silently drop every header and reset the other flags.
 */
export const UpdateMcpServerRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    url: z.string().max(2000).optional(),
    sandboxServer: z.string().max(64).optional(),
    headers: z.array(McpHeaderInput).max(8).optional(),
    orgEnabled: z.boolean().optional(),
    personalAllowed: z.boolean().optional(),
    trustedChaining: z.boolean().optional(),
    // Phase 07.4 (D-01): the same connector fields; null clears. The transport cannot change, so the API checks the
    // stored transport and header set against the resulting mode.
    authMode: ConnectorAuthMode.optional(),
    memberHeaderName: McpHeaderName.nullable().optional(),
    memberHeaderPrefix: McpMemberHeaderPrefix.nullable().optional(),
    oauthScopes: McpOAuthScopes.nullable().optional(),
    oauthClient: ConnectorOAuthClientInput.nullable().optional(),
    /** Confirms deleting every member connection when the mode switch or the delete would orphan them (R4). */
    clearConnections: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.authMode !== undefined) checkConnectorAuth(v.authMode, v, ctx, false);
  });
export type UpdateMcpServerRequest = z.infer<typeof UpdateMcpServerRequest>;
