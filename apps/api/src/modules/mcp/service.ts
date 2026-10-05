import { randomUUID } from "node:crypto";
import {
  AgentChannelEventTypes,
  type AgentChannelMcpProbeResult,
  type CellMcpServer,
  type CreateMcpServerRequest,
  cellTopic,
  isDangerousToolName,
  type McpHeaderInput,
  type McpServer,
  type UpdateMcpServerRequest,
} from "@ocw/contracts";
import { agents, botToolGrants, mcpServers, mcpServerTools, streamEvents, type Tx, tenantOf } from "@ocw/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
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

function toDto(row: ServerRow, tools: readonly ToolRow[]): McpServer {
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
    tools: tools
      .filter((t) => t.serverId === row.id)
      .sort((a, b) => a.openclawName.localeCompare(b.openclawName))
      .map((t) => ({
        name: t.name,
        openclawName: t.openclawName,
        title: t.title,
        description: t.description,
        readOnly: t.readOnly,
        destructive: t.destructive,
      })),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function findServer(tx: Tx, id: string): Promise<ServerRow> {
  const [row] = await tx.select().from(mcpServers).where(eq(mcpServers.id, id));
  if (!row) throw notFound("MCP server not found", "mcp_server_not_found");
  return row;
}

const toolsOf = (tx: Tx, serverId: string) =>
  tx.select().from(mcpServerTools).where(eq(mcpServerTools.serverId, serverId));

export async function listMcpServers(tx: Tx): Promise<McpServer[]> {
  const rows = await tx.select().from(mcpServers).orderBy(asc(mcpServers.name), asc(mcpServers.createdAt));
  const tools = await tx.select().from(mcpServerTools);
  return rows.map((r) => toDto(r, tools));
}

/** 404 `mcp_server_not_found` when absent, including another tenant's server (RLS). */
export async function getMcpServer(tx: Tx, id: string): Promise<McpServer> {
  const row = await findServer(tx, id);
  return toDto(row, await toolsOf(tx, id));
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

/**
 * Records the cell's probe report (03.1-10 wires the Agent Channel route). A report for anything but the
 * newest probe of the server is ignored (`applied: false`). Success replaces the tool list (names computed
 * here, never trusted from the cell) and drops the grants of tools that disappeared; failure keeps the tools
 * and stores a redacted, length-capped reason.
 */
export async function recordProbeResult(
  core: Core,
  tx: Tx,
  r: AgentChannelMcpProbeResult,
): Promise<{ applied: boolean }> {
  const row = await findServer(tx, r.serverId);
  if ((await latestProbeId(tx, row.id)) !== r.probeId) return { applied: false };
  const { organizationId } = tenantOf(tx);
  const now = new Date().toISOString();
  let toolCount = 0;
  let removedTools: string[] = [];

  if (r.ok) {
    const seen = new Set<string>();
    const tools = (r.tools ?? []).filter((t) => !seen.has(t.name) && seen.add(t.name));
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
          // Only an explicit hint counts: unknown = not read-only, i.e. side-effecting (T-03.1-09-04).
          readOnly: t.annotations?.readOnlyHint === true,
          destructive: t.annotations?.destructiveHint === true,
        })),
      );
    }
    const current = new Set(names);
    removedTools = before.map((t) => t.openclawName).filter((n) => !current.has(n));
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
    toolCount = tools.length;
    await tx
      .update(mcpServers)
      .set({ status: "ready", statusDetail: null, probedAt: now, updatedAt: now })
      .where(eq(mcpServers.id, row.id));
  } else {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from cell-reported text
    const raw = (r.error ?? "The probe failed").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    const detail = (await redactHeaderValues(core, tx, row, raw)).slice(0, 300) || "The probe failed";
    await tx
      .update(mcpServers)
      .set({ status: "error", statusDetail: detail, probedAt: now, updatedAt: now })
      .where(eq(mcpServers.id, row.id));
  }

  await core.audit.record(tx, {
    action: "mcp.server.probed",
    resourceType: "mcp_server",
    resourceId: row.id,
    actorKind: "system",
    metadata: {
      ok: r.ok,
      toolCount,
      ...(removedTools.length > 0 ? { removedTools: removedTools.sort() } : {}),
    },
  });
  await notifyCellConfig(core, tx, "tools.updated", null);
  return { applied: true };
}

// ---------------------------------------------------------------- create / update / delete

export async function createMcpServer(core: Core, tx: Tx, input: CreateMcpServerRequest): Promise<McpServer> {
  const ctx = tenantOf(tx);
  let url: string | null = null;
  let sandboxServer: string | null = null;
  if (input.transport === "sandboxed-stdio") {
    if (input.url) throw badRequest("A sandboxed server has no URL", "url_not_allowed");
    sandboxServer = assertSandboxServer(core, input.sandboxServer);
  } else {
    if (input.sandboxServer) {
      throw badRequest("Only sandboxed stdio servers name a sandbox server", "sandbox_server_not_allowed");
    }
    url = assertUrl(input.url);
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
      status: input.orgEnabled ? "probing" : "pending",
      createdBy: ctx.userId ?? null,
    })
    .returning();
  if (!row) throw new Error("mcp server insert failed");

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
    },
  });
  if (row.orgEnabled) {
    // The cell refetches `/cell` (connection details), then discovers the tools.
    await notifyCellConfig(core, tx, "tools.updated", null);
    await requestProbe(core, tx, row.id);
  }
  return getMcpServer(tx, row.id);
}

export async function updateMcpServer(
  core: Core,
  tx: Tx,
  id: string,
  input: UpdateMcpServerRequest,
): Promise<McpServer> {
  const row = await findServer(tx, id);
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
  if (input.headers !== undefined) {
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
  if (changed.length === 0) return getMcpServer(tx, id);

  const enabled = patch.orgEnabled ?? row.orgEnabled;
  const connectionChanged = changed.some((k) => k === "url" || k === "sandboxServer" || k === "headers");
  const reprobe = enabled && (connectionChanged || (changed.includes("orgEnabled") && enabled));
  if (!enabled && connectionChanged) patch.status = "pending";
  await tx
    .update(mcpServers)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(mcpServers.id, id));
  for (const secretId of orphaned) await core.secrets.remove(tx, secretId);

  await core.audit.record(tx, {
    action: "mcp.server.updated",
    resourceType: "mcp_server",
    resourceId: id,
    // Keys, flags, host and header names only.
    metadata: {
      changed,
      ...(changed.includes("url") ? { host: hostOf(patch.url ?? null) } : {}),
      ...(changed.includes("headers") ? { headerNames: headers.map((h) => h.name) } : {}),
      ...Object.fromEntries(
        (["orgEnabled", "personalAllowed", "trustedChaining"] as const)
          .filter((k) => changed.includes(k))
          .map((k) => [k, patch[k]]),
      ),
    },
  });
  // Everything but a rename reaches the cell (connection, toolFilter, alsoAllow or the taint flags).
  if (changed.some((k) => k !== "name")) await notifyCellConfig(core, tx, "tools.updated", null);
  if (reprobe) await requestProbe(core, tx, id);
  return getMcpServer(tx, id);
}

export async function deleteMcpServer(core: Core, tx: Tx, id: string): Promise<void> {
  const row = await findServer(tx, id);
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

/** Admin "probe again": 409 for an org-disabled server (the cell does not know it). */
export async function probeMcpServer(core: Core, tx: Tx, id: string): Promise<McpServer> {
  const row = await findServer(tx, id);
  if (!row.orgEnabled) throw conflict("Enable the server for the organization first", "server_disabled");
  const probeId = await requestProbe(core, tx, id);
  await core.audit.record(tx, {
    action: "mcp.server.probe_requested",
    resourceType: "mcp_server",
    resourceId: id,
    metadata: { probeId },
  });
  return getMcpServer(tx, id);
}

// ---------------------------------------------------------------- cell snapshot

/**
 * The org-enabled servers as the cell renders them (D-13). Header values are revealed ONLY here; the caller
 * must send the result over the authenticated Agent Channel and never log it. `tools` (the server's
 * `toolFilter.include`) = MCP tool names granted on any live bot, minus dangerous names; per-bot exposure is
 * still decided by each agent's `alsoAllow` and every turn.
 */
export async function cellMcpServers(core: Core, tx: Tx): Promise<CellMcpServer[]> {
  const rows = await tx
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.orgEnabled, true))
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
