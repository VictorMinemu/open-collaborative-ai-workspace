import { randomUUID } from "node:crypto";
import {
  AgentChannelEventTypes,
  type AgentChannelMcpProbeResult,
  type CellMcpServer,
  type ConnectorAuthMode,
  type ConnectorOAuthClientInput,
  type ConnectorOAuthClientMethod,
  type ConnectorOAuthStatus,
  type CreateMcpServerRequest,
  cellTopic,
  connectorOAuthUrls,
  isAllowedInjectionHeader,
  isDangerousToolName,
  jsonBytes,
  MCP_INPUT_SCHEMA_MAX_BYTES,
  type McpHeaderInput,
  type McpServer,
  type UpdateMcpServerRequest,
} from "@ocw/contracts";
import {
  agents,
  botToolGrants,
  connectorConnections,
  connectorOAuthClients,
  mcpServers,
  mcpServerTools,
  streamEvents,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import { notifyCellConfig } from "../bot-capabilities";
import { cellEnvName, openclawToolNames, safeServerName } from "./names";
import { checkMcpUrl } from "./url-policy";

/**
 * MCP server registry (D-13, BOT-08). Header values are stored only in `app.secrets` (kind `mcp_credential`);
 * `mcp_servers.headers` keeps `[{name, secretId}]`. Values are revealed in exactly one place, `cellMcpServers`,
 * whose result travels only over the authenticated `/cell` channel. DTOs, audits and events carry names, ids
 * and the host only (principle 8, T-03.1-09-01).
 */

type ServerRow = typeof mcpServers.$inferSelect;
type ToolRow = typeof mcpServerTools.$inferSelect;
type StoredHeader = { name: string; secretId: string };

/** Headers the MCP transport owns, or that would let a value smuggle a request (T-03.1-09-02). */
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Visible ASCII / Latin-1 plus tab: what an HTTP header value may carry (no CR/LF/NUL). */
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]+$/;

// ---------------------------------------------------------------- DTO

type ClientRow = typeof connectorOAuthClients.$inferSelect;

/** What a DTO needs beyond the server row: its tools, OAuth clients and member-connection count. */
interface DtoExtras {
  tools: readonly ToolRow[];
  clients: readonly ClientRow[];
  connections: ReadonlyMap<string, number>;
}

/** Read options: `oauthAvailable` (from `OCW_PUBLIC_API_URL`) turns a sign-in connector's status into `https_required`. */
export interface McpReadOptions {
  oauthAvailable?: boolean;
}

/** The instance's view for the DTOs (D-07 item 4: member sign-in needs HTTPS or localhost). */
export function mcpReadOptions(core: Core): McpReadOptions {
  return { oauthAvailable: connectorOAuthUrls(core.env.OCW_PUBLIC_API_URL).oauthAvailable };
}

function oauthStatusOf(row: ServerRow, opts: McpReadOptions): ConnectorOAuthStatus | null {
  if (row.authMode !== "per_member_oauth") return null;
  if (opts.oauthAvailable === false) return "https_required";
  return row.oauthStatus ?? "ready";
}

function toDto(row: ServerRow, extras: DtoExtras, opts: McpReadOptions): McpServer {
  const perMember = row.authMode !== "org_secret";
  return {
    id: row.id,
    name: row.name,
    safeName: row.safeName,
    transport: row.transport,
    url: row.url,
    sandboxServer: row.sandboxServer,
    // Names only: never the secret id or value.
    headers: row.headers.map((h) => ({ name: h.name, hasValue: true as const })),
    orgEnabled: row.orgEnabled,
    personalAllowed: row.personalAllowed,
    trustedChaining: row.trustedChaining,
    status: row.status,
    statusDetail: row.statusDetail,
    probedAt: row.probedAt ? new Date(row.probedAt).toISOString() : null,
    tools: extras.tools
      .filter((t) => t.serverId === row.id)
      .sort((a, b) => a.openclawName.localeCompare(b.openclawName))
      .map((t) => ({
        name: t.name,
        openclawName: t.openclawName,
        title: t.title,
        description: t.description,
        readOnly: t.readOnly,
        destructive: t.destructive,
        // Only once the API-side probe recorded one (a cell-probed tool has none, and its DTO stays as before).
        ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
      })),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    authMode: row.authMode,
    memberHeaderName: row.authMode === "per_member_secret" ? row.memberHeaderName : null,
    memberHeaderPrefix: row.authMode === "per_member_secret" ? row.memberHeaderPrefix : null,
    oauthScopes: row.authMode === "per_member_oauth" ? (row.oauthScopes ?? null) : null,
    oauthStatus: oauthStatusOf(row, opts),
    // The client secret is never returned: only whether one is stored.
    oauthClients: extras.clients
      .filter((c) => c.serverId === row.id)
      .sort((a, b) => a.issuer.localeCompare(b.issuer))
      .map((c) => ({
        issuer: c.issuer,
        clientId: c.clientId,
        hasSecret: c.clientSecretId !== null,
        method: c.method,
      })),
    memberConnections: perMember ? (extras.connections.get(row.id) ?? 0) : 0,
  };
}

async function findServer(tx: Tx, id: string): Promise<ServerRow> {
  const [row] = await tx.select().from(mcpServers).where(eq(mcpServers.id, id));
  if (!row) throw notFound("MCP server not found", "mcp_server_not_found");
  return row;
}

const toolsOf = (tx: Tx, serverId: string) =>
  tx.select().from(mcpServerTools).where(eq(mcpServerTools.serverId, serverId));

/** Member connections per server, one grouped count (UI-SPEC R4); RLS keeps it to the caller's organization. */
async function connectionCounts(tx: Tx, serverId?: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ serverId: connectorConnections.serverId, n: sql<number>`count(*)::int` })
    .from(connectorConnections)
    .where(serverId ? eq(connectorConnections.serverId, serverId) : undefined)
    .groupBy(connectorConnections.serverId);
  return new Map(rows.map((r) => [r.serverId, Number(r.n)]));
}

export async function listMcpServers(tx: Tx, opts: McpReadOptions = {}): Promise<McpServer[]> {
  const rows = await tx.select().from(mcpServers).orderBy(asc(mcpServers.name), asc(mcpServers.createdAt));
  const tools = await tx.select().from(mcpServerTools);
  const clients = await tx.select().from(connectorOAuthClients);
  const connections = await connectionCounts(tx);
  return rows.map((r) => toDto(r, { tools, clients, connections }, opts));
}

/** 404 `mcp_server_not_found` when absent, including another tenant's server (RLS). */
export async function getMcpServer(tx: Tx, id: string, opts: McpReadOptions = {}): Promise<McpServer> {
  const row = await findServer(tx, id);
  const clients = await tx.select().from(connectorOAuthClients).where(eq(connectorOAuthClients.serverId, id));
  return toDto(
    row,
    { tools: await toolsOf(tx, id), clients, connections: await connectionCounts(tx, id) },
    opts,
  );
}

/** The OAuth clients registered for a server, per issuer (07.4-10 picks one; the secret stays a reference). */
export async function oauthClientsOf(
  tx: Tx,
  serverId: string,
): Promise<
  Array<{
    issuer: string;
    clientId: string;
    clientSecretId: string | null;
    method: ConnectorOAuthClientMethod;
  }>
> {
  const rows = await tx
    .select()
    .from(connectorOAuthClients)
    .where(eq(connectorOAuthClients.serverId, serverId))
    .orderBy(asc(connectorOAuthClients.issuer));
  return rows.map((r) => ({
    issuer: r.issuer,
    clientId: r.clientId,
    clientSecretId: r.clientSecretId,
    method: r.method,
  }));
}

/** Records whether members can start a sign-in (07.4-10: `needs_client` after a discovery without a usable client). */
export async function setOAuthStatus(
  tx: Tx,
  serverId: string,
  status: ConnectorOAuthStatus | null,
): Promise<void> {
  await tx
    .update(mcpServers)
    .set({ oauthStatus: status, updatedAt: new Date().toISOString() })
    .where(eq(mcpServers.id, serverId));
}

export function sandboxInfo(core: Core): { available: boolean; servers: string[] } {
  const available = core.env.OCW_MCP_SANDBOX_URL !== null && core.env.OCW_MCP_SANDBOX_URL !== undefined;
  return { available, servers: available ? [...core.env.OCW_MCP_SANDBOX_SERVERS] : [] };
}

// ---------------------------------------------------------------- validation

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function assertUrl(url: string | undefined): string {
  if (!url) throw badRequest("A URL is required for this transport", "url_required");
  const check = checkMcpUrl(url);
  if (!check.ok) throw badRequest(check.reason, "invalid_url");
  return url;
}

function assertSandboxServer(core: Core, server: string | undefined): string {
  const sandbox = sandboxInfo(core);
  if (!sandbox.available) {
    throw conflict("The stdio sandbox is not configured on this installation", "sandbox_unavailable");
  }
  if (!server || !sandbox.servers.includes(server)) {
    throw badRequest("Pick one of the sandbox's vetted servers", "unknown_sandbox_server");
  }
  return server;
}

/**
 * Resolves a header list against the stored one: `value` → a new secret, `keep` → the stored secret of that
 * name. Returns the new stored list and the secret ids that are no longer referenced.
 */
async function resolveHeaders(
  core: Core,
  tx: Tx,
  safeName: string,
  input: readonly McpHeaderInput[],
  current: readonly StoredHeader[],
): Promise<{ headers: StoredHeader[]; orphaned: string[]; changed: boolean }> {
  const seen = new Set<string>();
  for (const h of input) {
    const lower = h.name.toLowerCase();
    if (RESERVED_HEADERS.has(lower))
      throw badRequest(`The header ${h.name} cannot be set`, "reserved_header");
    if (seen.has(lower)) throw badRequest(`The header ${h.name} is listed twice`, "duplicate_header");
    seen.add(lower);
    if (h.value !== undefined && h.keep) {
      throw badRequest(`Send either a new value or keep for ${h.name}`, "header_value_required");
    }
    if (h.value !== undefined && !HEADER_VALUE_RE.test(h.value)) {
      throw badRequest(
        `The value of ${h.name} contains characters a header cannot carry`,
        "invalid_header_value",
      );
    }
    if (h.value === undefined && !(h.keep && current.some((c) => c.name.toLowerCase() === lower))) {
      throw badRequest(`A value is required for ${h.name}`, "header_value_required");
    }
  }
  const headers: StoredHeader[] = [];
  let changed = input.length !== current.length;
  for (const h of input) {
    if (h.value === undefined) {
      const stored = current.find((c) => c.name.toLowerCase() === h.name.toLowerCase()) as StoredHeader;
      headers.push({ name: h.name, secretId: stored.secretId });
      if (stored.name !== h.name) changed = true;
      continue;
    }
    const secretId = await core.secrets.put(tx, {
      name: `MCP ${safeName} ${h.name}`,
      kind: "mcp_credential",
      value: h.value,
    });
    headers.push({ name: h.name, secretId });
    changed = true;
  }
  const kept = new Set(headers.map((h) => h.secretId));
  const orphaned = current.map((c) => c.secretId).filter((id) => !kept.has(id));
  if (orphaned.length > 0) changed = true;
  return { headers, orphaned, changed };
}

// ---------------------------------------------------------------- connector auth modes (07.4, D-01)

const STDIO_MEMBER = "Member accounts need a remote server (streamable HTTP or SSE), not the stdio sandbox";

/**
 * The header a member's key is sent in. The contract checks only its shape (`mcp.ts` cannot import keychain's rule:
 * import cycle), so the forbidden-injection rule and the transport's reserved headers are enforced here.
 */
function assertMemberHeader(name: string | null | undefined): string {
  if (!name) throw badRequest("Name the header each member's key is sent in", "member_header_required");
  if (!isAllowedInjectionHeader(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
    throw badRequest(`The header ${name} cannot carry a member's key`, "member_header_forbidden");
  }
  return name;
}

/** RFC 6749 scope-token: visible ASCII except space, `"` and `\`. Duplicates collapse, order kept. */
const SCOPE_TOKEN_RE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

function normalizeScopes(scopes: readonly string[] | null | undefined): string[] | null {
  if (!scopes || scopes.length === 0) return null;
  const out: string[] = [];
  for (const raw of scopes) {
    const s = raw.trim();
    if (!SCOPE_TOKEN_RE.test(s))
      throw badRequest(`"${s.slice(0, 40)}" is not a valid scope`, "invalid_scope");
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Deletes a server's OAuth client rows (all, or one method) and their sealed client secrets. Returns how many. */
async function removeOAuthClients(
  core: Core,
  tx: Tx,
  serverId: string,
  method?: ConnectorOAuthClientMethod,
): Promise<number> {
  const removed = await tx
    .delete(connectorOAuthClients)
    .where(
      and(
        eq(connectorOAuthClients.serverId, serverId),
        method ? eq(connectorOAuthClients.method, method) : undefined,
      ),
    )
    .returning({ secretId: connectorOAuthClients.clientSecretId });
  for (const r of removed) if (r.secretId) await core.secrets.remove(tx, r.secretId);
  return removed.length;
}

/**
 * The admin's pre-registered client (one per server, keyed by issuer): it replaces the previous pre-registered client
 * and any discovered client of the same issuer. The secret is sealed (`mcp_credential`) and never returned.
 */
async function putPreRegisteredClient(
  core: Core,
  tx: Tx,
  server: { id: string; safeName: string },
  input: ConnectorOAuthClientInput,
): Promise<void> {
  await removeOAuthClients(core, tx, server.id, "pre_registered");
  const sameIssuer = await tx
    .delete(connectorOAuthClients)
    .where(and(eq(connectorOAuthClients.serverId, server.id), eq(connectorOAuthClients.issuer, input.issuer)))
    .returning({ secretId: connectorOAuthClients.clientSecretId });
  for (const r of sameIssuer) if (r.secretId) await core.secrets.remove(tx, r.secretId);
  const clientSecretId = input.clientSecret
    ? await core.secrets.put(tx, {
        name: `MCP ${server.safeName} OAuth client`,
        kind: "mcp_credential",
        value: input.clientSecret,
      })
    : null;
  await tx.insert(connectorOAuthClients).values({
    organizationId: tenantOf(tx).organizationId,
    serverId: server.id,
    issuer: input.issuer,
    clientId: input.clientId,
    clientSecretId,
    method: "pre_registered",
  });
}

/** 409 `connections_exist` with the count, so the admin confirms before members are disconnected (D-01, R4). */
function connectionsExist(count: number, what: string): HttpError {
  return new HttpError(
    409,
    "connections_exist",
    `${count} ${count === 1 ? "member is" : "members are"} connected. Confirm to ${what} and disconnect them.`,
    { count },
  );
}

/**
 * Deletes every member connection of a server and its sealed credential, in the caller's transaction, and audits the
 * count. Tokens are destroyed locally; nothing is revoked at the provider (mcp does not depend on the connectors
 * module; a member's own disconnect revokes there).
 */
async function clearConnections(
  core: Core,
  tx: Tx,
  serverId: string,
  reason: "mode_changed" | "server_deleted",
): Promise<number> {
  const removed = await tx
    .delete(connectorConnections)
    .where(eq(connectorConnections.serverId, serverId))
    .returning({ secretId: connectorConnections.secretId });
  for (const r of removed) if (r.secretId) await core.secrets.remove(tx, r.secretId);
  if (removed.length > 0) {
    await core.audit.record(tx, {
      action: "connector.connections_cleared",
      resourceType: "mcp_server",
      resourceId: serverId,
      metadata: { serverId, count: removed.length, reason },
    });
  }
  return removed.length;
}

// ---------------------------------------------------------------- probe

/** Appends `mcp.probe` on `cell:<org>` and marks the server `probing`. Returns the probe id. */
export async function requestProbe(core: Core, tx: Tx, serverId: string): Promise<string> {
  const { organizationId } = tenantOf(tx);
  const probeId = randomUUID();
  await tx
    .update(mcpServers)
    .set({ status: "probing", statusDetail: null, updatedAt: new Date().toISOString() })
    .where(eq(mcpServers.id, serverId));
  await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.mcpProbe, {
    type: AgentChannelEventTypes.mcpProbe,
    organizationId,
    cellId: organizationId,
    probeId,
    serverId,
  });
  return probeId;
}

/** The id of the newest `mcp.probe` requested for a server (only its result counts). */
async function latestProbeId(tx: Tx, serverId: string): Promise<string | null> {
  const { organizationId } = tenantOf(tx);
  const [row] = await tx
    .select({ payload: streamEvents.payload })
    .from(streamEvents)
    .where(
      and(
        eq(streamEvents.streamId, cellTopic(organizationId)),
        eq(streamEvents.type, AgentChannelEventTypes.mcpProbe),
        sql`${streamEvents.payload}->>'serverId' = ${serverId}`,
      ),
    )
    .orderBy(desc(streamEvents.seq))
    .limit(1);
  const payload = row?.payload as { probeId?: unknown } | undefined;
  return typeof payload?.probeId === "string" ? payload.probeId : null;
}

/** Removes every header value (and its long parts, e.g. the token after `Bearer `) from cell-reported text. */
async function redactHeaderValues(core: Core, tx: Tx, row: ServerRow, text: string): Promise<string> {
  let out = text;
  for (const h of row.headers) {
    const value = await core.secrets.reveal(tx, h.secretId).catch(() => null);
    if (!value) continue;
    const parts = [value, ...value.split(/\s+/).filter((p) => p.length >= 6)].sort(
      (a, b) => b.length - a.length,
    );
    for (const p of parts) out = out.split(p).join("[redacted]");
  }
  return out;
}

/** A discovered tool, normalized: what the cell probe and the API-side probe (07.4-10) both record. */
export interface DiscoveredTool {
  name: string;
  title?: string | null;
  description?: string | null;
  readOnly: boolean;
  destructive: boolean;
  /** The tool's JSON input schema; dropped when over 16 KB serialized or not an object. */
  inputSchema?: object | null;
}

/**
 * Replaces a server's tool list with a probe's result (names computed here, never trusted from the reporter), drops
 * the grants of tools that disappeared, marks the server ready, audits `mcp.server.probed` and tells the cell.
 * Shared by `recordProbeResult` (cell probe, org secret) and the API-side probe of per-member connectors (07.4-10).
 */
export async function replaceServerTools(
  core: Core,
  tx: Tx,
  serverId: string,
  discovered: readonly DiscoveredTool[],
): Promise<{ toolCount: number; removedTools: string[] }> {
  const row = await findServer(tx, serverId);
  const { organizationId } = tenantOf(tx);
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const tools = discovered.filter((t) => !seen.has(t.name) && seen.add(t.name));
  const names = openclawToolNames(
    row.safeName,
    tools.map((t) => t.name),
  );
  const before = await toolsOf(tx, row.id);
  await tx.delete(mcpServerTools).where(eq(mcpServerTools.serverId, row.id));
  if (tools.length > 0) {
    await tx.insert(mcpServerTools).values(
      tools.map((t, i) => ({
        organizationId,
        serverId: row.id,
        name: t.name,
        openclawName: names[i] as string,
        title: t.title ?? null,
        description: t.description ?? null,
        readOnly: t.readOnly,
        destructive: t.destructive,
        inputSchema: boundedSchema(t.inputSchema),
      })),
    );
  }
  const current = new Set(names);
  const removedTools = before.map((t) => t.openclawName).filter((n) => !current.has(n));
  if (removedTools.length > 0) {
    await tx
      .delete(botToolGrants)
      .where(
        and(
          eq(botToolGrants.sourceKind, "mcp"),
          eq(botToolGrants.sourceId, row.id),
          inArray(botToolGrants.toolName, removedTools),
        ),
      );
  }
  await tx
    .update(mcpServers)
    .set({ status: "ready", statusDetail: null, probedAt: now, updatedAt: now })
    .where(eq(mcpServers.id, row.id));
  await core.audit.record(tx, {
    action: "mcp.server.probed",
    resourceType: "mcp_server",
    resourceId: row.id,
    actorKind: "system",
    metadata: {
      ok: true,
      toolCount: tools.length,
      ...(removedTools.length > 0 ? { removedTools: [...removedTools].sort() } : {}),
    },
  });
  await notifyCellConfig(core, tx, "tools.updated", null);
  return { toolCount: tools.length, removedTools: removedTools.sort() };
}

function boundedSchema(schema: object | null | undefined): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  return jsonBytes(schema) <= MCP_INPUT_SCHEMA_MAX_BYTES ? (schema as Record<string, unknown>) : null;
}

/**
 * Records the cell's probe report (03.1-10 wires the Agent Channel route). A report for anything but the
 * newest probe of the server is ignored (`applied: false`), and so is one for a per-member connector, which the
 * cell never probes. Success replaces the tool list (`replaceServerTools`); failure keeps the tools and stores a
 * redacted, length-capped reason.
 */
export async function recordProbeResult(
  core: Core,
  tx: Tx,
  r: AgentChannelMcpProbeResult,
): Promise<{ applied: boolean }> {
  const row = await findServer(tx, r.serverId);
  if (row.authMode !== "org_secret") return { applied: false };
  if ((await latestProbeId(tx, row.id)) !== r.probeId) return { applied: false };

  if (r.ok) {
    await replaceServerTools(
      core,
      tx,
      row.id,
      (r.tools ?? []).map((t) => ({
        name: t.name,
        title: t.title ?? null,
        description: t.description ?? null,
        // Only an explicit hint counts: unknown = not read-only, i.e. side-effecting (T-03.1-09-04).
        readOnly: t.annotations?.readOnlyHint === true,
        destructive: t.annotations?.destructiveHint === true,
      })),
    );
    return { applied: true };
  }

  const now = new Date().toISOString();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from cell-reported text
  const raw = (r.error ?? "The probe failed").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const detail = (await redactHeaderValues(core, tx, row, raw)).slice(0, 300) || "The probe failed";
  await tx
    .update(mcpServers)
    .set({ status: "error", statusDetail: detail, probedAt: now, updatedAt: now })
    .where(eq(mcpServers.id, row.id));
  await core.audit.record(tx, {
    action: "mcp.server.probed",
    resourceType: "mcp_server",
    resourceId: row.id,
    actorKind: "system",
    metadata: { ok: false, toolCount: 0 },
  });
  await notifyCellConfig(core, tx, "tools.updated", null);
  return { applied: true };
}

// ---------------------------------------------------------------- create / update / delete

export async function createMcpServer(core: Core, tx: Tx, input: CreateMcpServerRequest): Promise<McpServer> {
  const ctx = tenantOf(tx);
  const mode: ConnectorAuthMode = input.authMode;
  const perMember = mode !== "org_secret";
  let url: string | null = null;
  let sandboxServer: string | null = null;
  if (input.transport === "sandboxed-stdio") {
    if (perMember) throw badRequest(STDIO_MEMBER, "per_member_needs_remote");
    if (input.url) throw badRequest("A sandboxed server has no URL", "url_not_allowed");
    sandboxServer = assertSandboxServer(core, input.sandboxServer);
  } else {
    if (input.sandboxServer) {
      throw badRequest("Only sandboxed stdio servers name a sandbox server", "sandbox_server_not_allowed");
    }
    url = assertUrl(input.url);
  }
  // The contract refuses these; checked again so no caller of the service can mix the modes.
  if (perMember && input.headers.length > 0) {
    throw badRequest("A per-member connector has no organization headers", "headers_not_allowed");
  }
  const memberHeaderName = mode === "per_member_secret" ? assertMemberHeader(input.memberHeaderName) : null;
  const memberHeaderPrefix = mode === "per_member_secret" ? input.memberHeaderPrefix || null : null;
  const oauthScopes = mode === "per_member_oauth" ? normalizeScopes(input.oauthScopes) : null;
  if (mode !== "per_member_oauth" && input.oauthClient) {
    throw badRequest("Only a member sign-in connector takes an OAuth client", "oauth_not_allowed");
  }

  const id = randomUUID();
  const taken = new Set((await tx.select({ s: mcpServers.safeName }).from(mcpServers)).map((r) => r.s));
  const safeName = safeServerName(id, taken);
  const { headers } = await resolveHeaders(core, tx, safeName, input.headers, []);

  const [row] = await tx
    .insert(mcpServers)
    .values({
      id,
      organizationId: ctx.organizationId,
      name: input.name,
      safeName,
      transport: input.transport,
      url,
      sandboxServer,
      headers,
      orgEnabled: input.orgEnabled,
      personalAllowed: input.personalAllowed,
      trustedChaining: input.trustedChaining,
      // The cell never probes a per-member connector: it waits for the first member (07.4-10's API-side probe).
      status: !perMember && input.orgEnabled ? "probing" : "pending",
      createdBy: ctx.userId ?? null,
      authMode: mode,
      memberHeaderName,
      memberHeaderPrefix,
      oauthScopes,
      oauthStatus: mode === "per_member_oauth" ? "ready" : null,
    })
    .returning();
  if (!row) throw new Error("mcp server insert failed");
  if (mode === "per_member_oauth" && input.oauthClient) {
    await putPreRegisteredClient(core, tx, row, input.oauthClient);
  }

  await core.audit.record(tx, {
    action: "mcp.server.created",
    resourceType: "mcp_server",
    resourceId: row.id,
    metadata: {
      name: row.name,
      safeName,
      transport: row.transport,
      host: hostOf(url),
      sandboxServer,
      headerNames: headers.map((h) => h.name),
      orgEnabled: row.orgEnabled,
      personalAllowed: row.personalAllowed,
      trustedChaining: row.trustedChaining,
      // Never a client secret, key or token: the mode, the member header name and whether a client was entered.
      authMode: mode,
      ...(memberHeaderName ? { memberHeaderName } : {}),
      ...(mode === "per_member_oauth" ? { preRegisteredClient: Boolean(input.oauthClient) } : {}),
    },
  });
  if (row.orgEnabled && !perMember) {
    // The cell refetches `/cell` (connection details), then discovers the tools.
    await notifyCellConfig(core, tx, "tools.updated", null);
    await requestProbe(core, tx, row.id);
  }
  return getMcpServer(tx, row.id, mcpReadOptions(core));
}

export async function updateMcpServer(
  core: Core,
  tx: Tx,
  id: string,
  input: UpdateMcpServerRequest,
): Promise<McpServer> {
  const row = await findServer(tx, id);
  const from = row.authMode;
  const to: ConnectorAuthMode = input.authMode ?? from;
  const modeChanged = to !== from;
  const perMember = to !== "org_secret";

  // ---- the resulting mode's rules, against the stored server (the contract only sees the body)
  if (perMember && row.transport === "sandboxed-stdio")
    throw badRequest(STDIO_MEMBER, "per_member_needs_remote");
  if (perMember && input.headers !== undefined && input.headers.length > 0) {
    throw badRequest("A per-member connector has no organization headers", "headers_not_allowed");
  }
  if (to !== "per_member_secret" && typeof input.memberHeaderName === "string") {
    throw badRequest("Only a member key connector takes a header", "member_header_not_allowed");
  }
  if (
    to !== "per_member_oauth" &&
    (input.oauthClient || (input.oauthScopes && input.oauthScopes.length > 0))
  ) {
    throw badRequest("Only a member sign-in connector takes an OAuth client or scopes", "oauth_not_allowed");
  }
  // Leaving a per-member mode orphans every member's credential: refuse until the admin confirms (D-01, R4).
  const connectionCount =
    from !== "org_secret" && modeChanged ? ((await connectionCounts(tx, id)).get(id) ?? 0) : 0;
  if (connectionCount > 0 && input.clearConnections !== true) {
    throw connectionsExist(connectionCount, "switch the mode");
  }

  const patch: Partial<typeof mcpServers.$inferInsert> = {};
  const changed: string[] = [];

  if (input.name !== undefined && input.name !== row.name) {
    patch.name = input.name;
    changed.push("name");
  }
  if (input.url !== undefined) {
    if (row.transport === "sandboxed-stdio")
      throw badRequest("A sandboxed server has no URL", "url_not_allowed");
    const url = assertUrl(input.url);
    if (url !== row.url) {
      patch.url = url;
      changed.push("url");
    }
  }
  if (input.sandboxServer !== undefined) {
    if (row.transport !== "sandboxed-stdio") {
      throw badRequest("Only sandboxed stdio servers name a sandbox server", "sandbox_server_not_allowed");
    }
    const server = assertSandboxServer(core, input.sandboxServer);
    if (server !== row.sandboxServer) {
      patch.sandboxServer = server;
      changed.push("sandboxServer");
    }
  }
  let orphaned: string[] = [];
  let headers = row.headers;
  if (perMember) {
    // A per-member connector keeps no organization credential: the stored headers go with the switch.
    if (row.headers.length > 0) {
      orphaned = row.headers.map((h) => h.secretId);
      headers = [];
      patch.headers = headers;
      changed.push("headers");
    }
  } else if (input.headers !== undefined) {
    const resolved = await resolveHeaders(core, tx, row.safeName, input.headers, row.headers);
    orphaned = resolved.orphaned;
    if (resolved.changed) {
      headers = resolved.headers;
      patch.headers = headers;
      changed.push("headers");
    }
  }
  for (const key of ["orgEnabled", "personalAllowed", "trustedChaining"] as const) {
    const value = input[key];
    if (value !== undefined && value !== row[key]) {
      patch[key] = value;
      changed.push(key);
    }
  }

  // ---- connector fields of the resulting mode; the other modes' fields are cleared
  if (modeChanged) {
    patch.authMode = to;
    changed.push("authMode");
  }
  if (to === "per_member_secret") {
    const name = assertMemberHeader(
      input.memberHeaderName === undefined ? row.memberHeaderName : input.memberHeaderName,
    );
    const prefix =
      input.memberHeaderPrefix === undefined
        ? modeChanged
          ? null
          : row.memberHeaderPrefix
        : input.memberHeaderPrefix || null;
    if (name !== row.memberHeaderName || prefix !== row.memberHeaderPrefix) {
      patch.memberHeaderName = name;
      patch.memberHeaderPrefix = prefix;
      changed.push("memberHeader");
    }
  } else if (row.memberHeaderName !== null || row.memberHeaderPrefix !== null) {
    patch.memberHeaderName = null;
    patch.memberHeaderPrefix = null;
  }
  let clientChanged = false;
  if (to === "per_member_oauth") {
    if (input.oauthScopes !== undefined) {
      const scopes = normalizeScopes(input.oauthScopes);
      if (!sameList(scopes, row.oauthScopes)) {
        patch.oauthScopes = scopes;
        changed.push("oauthScopes");
      }
    }
    if (input.oauthClient === null) {
      clientChanged = (await removeOAuthClients(core, tx, id, "pre_registered")) > 0;
    } else if (input.oauthClient !== undefined) {
      await putPreRegisteredClient(core, tx, row, input.oauthClient);
      clientChanged = true;
    }
    if (clientChanged) changed.push("oauthClient");
    // A new mode starts ready; an admin's new client answers a `needs_client`.
    if (modeChanged || (clientChanged && row.oauthStatus === "needs_client")) patch.oauthStatus = "ready";
  } else if (from === "per_member_oauth") {
    await removeOAuthClients(core, tx, id);
    patch.oauthScopes = null;
    patch.oauthStatus = null;
  }

  if (changed.length === 0) return getMcpServer(tx, id, mcpReadOptions(core));

  const enabled = patch.orgEnabled ?? row.orgEnabled;
  const connectionChanged = changed.some(
    (k) => k === "url" || k === "sandboxServer" || k === "headers" || k === "authMode",
  );
  // Only an organization-secret server is probed by the cell; a per-member one waits for a member again.
  const reprobe = !perMember && enabled && (connectionChanged || (changed.includes("orgEnabled") && enabled));
  if (perMember && modeChanged) {
    patch.status = "pending";
    patch.statusDetail = null;
  } else if (!enabled && connectionChanged) patch.status = "pending";
  await tx
    .update(mcpServers)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(mcpServers.id, id));
  for (const secretId of orphaned) await core.secrets.remove(tx, secretId);
  if (connectionCount > 0) await clearConnections(core, tx, id, "mode_changed");

  await core.audit.record(tx, {
    action: "mcp.server.updated",
    resourceType: "mcp_server",
    resourceId: id,
    // Keys, flags, host, header names and the mode only: never a client secret, key or token.
    metadata: {
      changed,
      ...(changed.includes("url") ? { host: hostOf(patch.url ?? null) } : {}),
      ...(changed.includes("headers") ? { headerNames: headers.map((h) => h.name) } : {}),
      ...Object.fromEntries(
        (["orgEnabled", "personalAllowed", "trustedChaining"] as const)
          .filter((k) => changed.includes(k))
          .map((k) => [k, patch[k]]),
      ),
      ...(modeChanged ? { authMode: to, previousAuthMode: from } : {}),
      ...(changed.includes("memberHeader") ? { memberHeaderName: patch.memberHeaderName } : {}),
    },
  });
  // Everything but a rename reaches the cell (connection, toolFilter, alsoAllow, the taint flags, or the server
  // leaving or joining the snapshot on a mode switch).
  if (changed.some((k) => k !== "name")) await notifyCellConfig(core, tx, "tools.updated", null);
  if (reprobe) await requestProbe(core, tx, id);
  return getMcpServer(tx, id, mcpReadOptions(core));
}

/**
 * Deletes a server with its tools, grants, header secrets and OAuth clients. With member connections it answers 409
 * `connections_exist` unless `clearConnections` confirms; then every connection and its sealed credential go too.
 */
export async function deleteMcpServer(
  core: Core,
  tx: Tx,
  id: string,
  opts: { clearConnections?: boolean } = {},
): Promise<void> {
  const row = await findServer(tx, id);
  const connections = (await connectionCounts(tx, id)).get(id) ?? 0;
  if (connections > 0 && opts.clearConnections !== true) throw connectionsExist(connections, "delete it");
  await clearConnections(core, tx, id, "server_deleted");
  await removeOAuthClients(core, tx, id);
  await tx
    .delete(botToolGrants)
    .where(and(eq(botToolGrants.sourceKind, "mcp"), eq(botToolGrants.sourceId, id)));
  // Tool rows go with the server (on delete cascade).
  await tx.delete(mcpServers).where(eq(mcpServers.id, id));
  for (const h of row.headers) await core.secrets.remove(tx, h.secretId);
  await core.audit.record(tx, {
    action: "mcp.server.deleted",
    resourceType: "mcp_server",
    resourceId: id,
    metadata: { name: row.name, safeName: row.safeName, transport: row.transport },
  });
  await notifyCellConfig(core, tx, "tools.updated", null);
}

/** Admin "probe again": 409 for an org-disabled server (the cell does not know it) or a per-member connector. */
export async function probeMcpServer(core: Core, tx: Tx, id: string): Promise<McpServer> {
  const row = await findServer(tx, id);
  if (row.authMode !== "org_secret") {
    throw conflict("A member connector is probed with a member's own account", "member_connector");
  }
  if (!row.orgEnabled) throw conflict("Enable the server for the organization first", "server_disabled");
  const probeId = await requestProbe(core, tx, id);
  await core.audit.record(tx, {
    action: "mcp.server.probe_requested",
    resourceType: "mcp_server",
    resourceId: id,
    metadata: { probeId },
  });
  return getMcpServer(tx, id, mcpReadOptions(core));
}

// ---------------------------------------------------------------- cell snapshot

/**
 * The org-enabled, organization-secret servers as the cell renders them (D-13; 07.4 C-01: never a per-member one). Header values are revealed ONLY here; the caller
 * must send the result over the authenticated Agent Channel and never log it. `tools` (the server's
 * `toolFilter.include`) = MCP tool names granted on any live bot, minus dangerous names; per-bot exposure is
 * still decided by each agent's `alsoAllow` and every turn.
 */
export async function cellMcpServers(core: Core, tx: Tx): Promise<CellMcpServer[]> {
  const rows = await tx
    .select()
    .from(mcpServers)
    // Per-member connectors never reach the cell: the API calls them with the asking member's credential (C-01).
    .where(and(eq(mcpServers.orgEnabled, true), eq(mcpServers.authMode, "org_secret")))
    .orderBy(asc(mcpServers.safeName));
  if (rows.length === 0) return [];
  const granted = await tx
    .selectDistinct({
      serverId: mcpServerTools.serverId,
      name: mcpServerTools.name,
      openclaw: mcpServerTools.openclawName,
    })
    .from(botToolGrants)
    .innerJoin(agents, eq(agents.id, botToolGrants.agentId))
    .innerJoin(
      mcpServerTools,
      and(
        eq(mcpServerTools.serverId, botToolGrants.sourceId),
        eq(mcpServerTools.openclawName, botToolGrants.toolName),
      ),
    )
    .where(and(eq(botToolGrants.sourceKind, "mcp"), isNull(agents.deletedAt)));

  const sandbox = core.env.OCW_MCP_SANDBOX_URL?.replace(/\/+$/, "") ?? null;
  const out: CellMcpServer[] = [];
  for (const s of rows) {
    let url: string;
    if (s.transport === "sandboxed-stdio") {
      // The sidecar went away or no longer bakes this server: nothing to connect to.
      if (!sandbox || !s.sandboxServer || !core.env.OCW_MCP_SANDBOX_SERVERS.includes(s.sandboxServer))
        continue;
      url = `${sandbox}/${s.sandboxServer}/mcp`;
    } else {
      if (!s.url) continue;
      url = s.url;
    }
    const headers = [];
    for (const [i, h] of s.headers.entries()) {
      headers.push({
        name: h.name,
        envName: cellEnvName(s.safeName, i),
        value: await core.secrets.reveal(tx, h.secretId),
      });
    }
    const tools = granted
      .filter((g) => g.serverId === s.id && !isDangerousToolName(g.openclaw))
      .map((g) => g.name)
      .sort();
    out.push({
      id: s.id,
      safeName: s.safeName,
      transport: s.transport === "sse" ? "sse" : "streamable-http",
      url,
      headers,
      tools,
    });
  }
  return out;
}
