import { type APIRequestContext, expect } from "@playwright/test";
import { FAKE_MCP_HOST, FAKE_URL } from "./bot-tools";
import { asSuperuser } from "./superuser";

/**
 * Watched-record helpers (07.6-17): the fake ERP MCP server (infra/fake-model/fake-erp-mcp.mjs, 07.6-04) mounted by the
 * e2e fake server at `/erp-mcp`, registered as a connector the way an admin would, and its test hook `__mutate` (a sales
 * order changed "elsewhere"). The API reaches it as the test host `fake-mcp`; the spec reaches it on loopback.
 */

export const ERP_TOKEN = process.env.OCW_FAKE_ERP_TOKEN || "e2e-erp-token";
/** The ERP as the API names it (a compose-style host its URL policy accepts). */
export const ERP_URL = `http://${FAKE_MCP_HOST}/erp-mcp`;

/** The seed of the fake ERP (its `reset()`), restored field by field through `__mutate`. */
export const ERP_SEED: Record<string, Record<string, string>> = {
  "SO-10442": { status: "Confirmed", delivery_date: "2026-10-14", total: "1250.00", customer: "Globex S.L." },
  "SO-10443": { status: "Draft", delivery_date: "2026-10-20", total: "980.50", customer: "Initech S.A." },
};

const ERP_TOOLS = [
  { name: "get_record", title: "Get sales order", readOnly: true, destructive: false },
  { name: "update_record", title: "Update sales order", readOnly: false, destructive: true },
  { name: "add_note", title: "Add note", readOnly: false, destructive: false },
  { name: "list_records", title: "List sales orders", readOnly: true, destructive: false },
] as const;

type ServerJson = { id: string; name: string; safeName: string };

/** Removes every connector named `name`, disconnecting members first (their watches go with it). */
export async function removeConnector(admin: APIRequestContext, name: string): Promise<void> {
  const list = (await (await admin.get("/api/v1/mcp-servers")).json()) as { servers: ServerJson[] };
  for (const s of list.servers.filter((x) => x.name === name)) {
    const res = await admin.delete(`/api/v1/mcp-servers/${s.id}?clearConnections=true`);
    expect(res.ok(), `remove ${name}: ${res.status()}`).toBe(true);
  }
}

/**
 * Registers the fake ERP as `name`: with the workspace's own access (organization secret, its tools recorded as the
 * cell's probe would record them) or per member (`perMember`: each member's own key, sent as `Authorization: Bearer`;
 * the first member's connection probes the tools API-side). Returns the server.
 */
export async function registerFakeErp(
  admin: APIRequestContext,
  opts: { name?: string; perMember?: boolean } = {},
): Promise<ServerJson> {
  expect(FAKE_URL, "OCW_E2E_FAKE_URL (the fake ERP) is set by scripts/e2e-isolated.sh").not.toBe("");
  const name = opts.name ?? "ERP";
  await removeConnector(admin, name);
  const res = await admin.post("/api/v1/mcp-servers", {
    data: opts.perMember
      ? {
          name,
          transport: "streamable-http",
          url: ERP_URL,
          authMode: "per_member_secret",
          memberHeaderName: "Authorization",
          memberHeaderPrefix: "Bearer ",
        }
      : {
          name,
          transport: "streamable-http",
          url: ERP_URL,
          headers: [{ name: "Authorization", value: `Bearer ${ERP_TOKEN}` }],
        },
  });
  expect(res.ok(), `register ${name}: ${res.status()} ${await res.text()}`).toBe(true);
  const server = (await res.json()) as ServerJson;
  if (!opts.perMember) await recordErpTools(server);
  return server;
}

/** The ERP's tools as a probe records them (the simulated cell does not probe in this spec). */
export async function recordErpTools(server: ServerJson): Promise<void> {
  await asSuperuser("delete from app.mcp_server_tools where server_id = $1", [server.id]);
  for (const t of ERP_TOOLS) {
    await asSuperuser(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, title, read_only, destructive, input_schema)
       select organization_id, id, $2, $3, $4, $5, $6, $7::jsonb from app.mcp_servers where id = $1`,
      [
        server.id,
        t.name,
        `${server.safeName}__${t.name}`,
        t.title,
        t.readOnly,
        t.destructive,
        JSON.stringify({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
      ],
    );
  }
  await asSuperuser("update app.mcp_servers set status = 'ready' where id = $1", [server.id]);
}

/** A member connects their own key to a per-member ERP (the API probes its tools on the first connection). */
export async function connectErp(member: APIRequestContext, serverId: string): Promise<void> {
  const res = await member.put(`/api/v1/connectors/${serverId}/secret`, { data: { value: ERP_TOKEN } });
  expect(res.ok(), `connect ${serverId}: ${res.status()} ${await res.text()}`).toBe(true);
}

/** Grants `tools` of `server` to a bot, keeping the grants it has. */
export async function grantErp(
  admin: APIRequestContext,
  agentId: string,
  server: ServerJson,
  tools: readonly string[],
): Promise<void> {
  const caps = (await (await admin.get(`/api/v1/agents/${agentId}/capabilities`)).json()) as {
    tools: Array<{ sourceKind: string; sourceId: string; tool: string; granted: boolean }>;
  };
  const kept = caps.tools
    .filter((t) => t.granted && t.sourceId !== server.id)
    .map((t) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool }));
  const res = await admin.patch(`/api/v1/agents/${agentId}/capabilities`, {
    data: {
      tools: [
        ...kept,
        ...tools.map((t) => ({ sourceKind: "mcp", sourceId: server.id, tool: `${server.safeName}__${t}` })),
      ],
    },
  });
  expect(res.ok(), `grant ${tools.join(", ")}: ${res.status()} ${await res.text()}`).toBe(true);
}

/** One JSON-RPC call to the fake ERP on loopback (its own session each time). */
async function erpCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = `${FAKE_URL}/erp-mcp`;
  const headers = { authorization: `Bearer ${ERP_TOKEN}`, "content-type": "application/json" };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
    }),
  });
  expect(init.ok, `erp initialize: ${init.status}`).toBe(true);
  const session = init.headers.get("mcp-session-id") ?? "";
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.ok, `erp ${name}: ${res.status}`).toBe(true);
  const body = (await res.json()) as { result?: { isError?: boolean; structuredContent?: unknown } };
  expect(body.result?.isError ?? false, `erp ${name} failed`).toBe(false);
  return body.result?.structuredContent;
}

/** A change made "elsewhere" (another ERP user): the fake's `__mutate` hook. */
export async function mutateErp(id: string, fields: Record<string, string>): Promise<void> {
  await erpCall("__mutate", { id, fields });
}

/** The record as the ERP has it now. */
export async function readErp(id: string): Promise<Record<string, unknown>> {
  return (await erpCall("get_record", { id })) as Record<string, unknown>;
}

/** Restores the seeded sales orders' fields (the fake keeps state for the whole run). */
export async function resetErp(): Promise<void> {
  for (const [id, fields] of Object.entries(ERP_SEED)) await mutateErp(id, fields);
}

export interface WatchDto {
  id: string;
  cardMessageId: string;
  lastStatus: string;
  checkedAt: string | null;
  lastChangedAt: string | null;
  checkIntervalMinutes: number;
  version: number;
}

/** The board's watches as the API has them. */
export async function watchesOf(api: APIRequestContext, boardId: string): Promise<WatchDto[]> {
  const res = await api.get(`/api/v1/watched-records?conversationId=${boardId}`);
  expect(res.ok(), `watches of ${boardId}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { records: WatchDto[] }).records;
}

/** Waits until the card's watch has been checked after `since` (ISO, or any check when omitted). */
export async function waitChecked(
  api: APIRequestContext,
  boardId: string,
  cardId: string,
  since?: string | null,
): Promise<WatchDto> {
  let last: WatchDto | undefined;
  await expect
    .poll(
      async () => {
        last = (await watchesOf(api, boardId)).find((w) => w.cardMessageId === cardId);
        if (!last?.checkedAt) return false;
        return since ? Date.parse(last.checkedAt) > Date.parse(since) : true;
      },
      { timeout: 30_000, message: `watch of ${cardId} checked` },
    )
    .toBe(true);
  return last as WatchDto;
}

/** Links a card to an ERP record through the API (setup for the specs that do not test the dialog). */
export async function linkWatch(
  api: APIRequestContext,
  input: { cardMessageId: string; serverId: string; agentId: string; externalRef?: string },
): Promise<WatchDto> {
  const res = await api.post("/api/v1/watched-records", {
    data: {
      cardMessageId: input.cardMessageId,
      mcpServerId: input.serverId,
      externalRef: input.externalRef ?? "SO-10442",
      readTool: "get_record",
      idArg: "id",
      writeTool: "update_record",
      fields: [
        { pointer: "/status", label: "Status" },
        { pointer: "/delivery_date", label: "Delivery date" },
        { pointer: "/total", label: "Total" },
      ],
      checkIntervalMinutes: 60,
      agentId: input.agentId,
    },
  });
  expect(res.status(), `link: ${await res.text()}`).toBe(201);
  return (await res.json()) as WatchDto;
}
