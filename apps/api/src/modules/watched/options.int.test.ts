import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeErpMcp,
  FAKE_ERP_TOOLS,
  type FakeErpMcp,
} from "../../../../../infra/fake-model/fake-erp-mcp.mjs";
import { type ConnectorsStack, fails, type Json, ok, startConnectorsStack } from "../../testing-connectors";
import { replaceServerTools } from "../mcp";

/**
 * 07.6-17 (AUTO-04, D-07, Pitfall 8): the watch dialog's options. `GET /watched-records/options?conversationId=` answers
 * what the viewer may link on this board, with the link's own rules: posting there plus `record.watch` (403 / 404
 * otherwise, hidden = missing across organizations), the board's bots that may post and read it for the viewer, and
 * the remote connectors with a read-only, non-destructive tool one of those bots was granted. A per-member connector
 * says only the viewer's own connection and whether the viewer shares it on this board.
 */

const ERP_TOKEN = `erp-token-${randomUUID()}`;

let s: ConnectorsStack;
let erp: FakeErpMcp;
let erpServer: Server;
let erpUrl = "";
let opsId = "";
let strayId = "";
let ordersId = "";
let erpConnector: Json;
let crmConnector: Json;
let personal: Json;

const core = () => s.stack.built.core;
const options = (who: ConnectorsStack["victor"] = s.victor) =>
  who.request("GET", `/api/v1/watched-records/options?conversationId=${ordersId}`);

async function bot(name: string, username: string): Promise<string> {
  return (
    await ok(
      s.victor.request("POST", "/api/v1/agents", {
        name,
        username,
        instructions: "You help with orders.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;
}

/** Grants `tools` of `server` to `agentId`, keeping the grants it has. */
async function grant(agentId: string, server: Json, tools: string[]): Promise<void> {
  const caps = await ok(s.victor.request("GET", `/api/v1/agents/${agentId}/capabilities`));
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${agentId}/capabilities`, {
      tools: [
        ...(caps.tools as Json[])
          .filter((t) => t.granted)
          .map((t) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool })),
        ...tools.map((t) => ({ sourceKind: "mcp", sourceId: server.id, tool: `${server.safeName}__${t}` })),
      ],
    }),
  );
}

async function orgSecretServer(name: string): Promise<Json> {
  const server = await ok(
    s.victor.request("POST", "/api/v1/mcp-servers", {
      name,
      transport: "streamable-http",
      url: erpUrl,
      headers: [{ name: "Authorization", value: `Bearer ${ERP_TOKEN}` }],
    }),
  );
  await core().db.withTenant({ organizationId: s.orgA }, (tx) =>
    replaceServerTools(
      core(),
      tx,
      server.id,
      FAKE_ERP_TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        readOnly: t.annotations.readOnlyHint,
        destructive: t.annotations.destructiveHint,
        inputSchema: t.inputSchema,
      })),
    ),
  );
  return server;
}

beforeAll(async () => {
  s = await startConnectorsStack();
  erp = createFakeErpMcp({ token: ERP_TOKEN });
  erpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-mcp");
    if (!erp.handle(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => erpServer.listen(0, "127.0.0.1", resolve));
  erpUrl = `http://fake-mcp:${(erpServer.address() as AddressInfo).port}/erp-mcp`;

  opsId = await bot("Ops helper", "opshelper");
  // Granted the ERP's read tool too, but not a member of #orders: never offered there.
  strayId = await bot("Stray bot", "straybot");
  ordersId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", { name: "orders", layout: "board", visibility: "public" }),
    )
  ).id;
  await ok(s.victor.request("POST", `/api/v1/channels/${ordersId}/members`, { kind: "agent", id: opsId }));
  await ok(s.victor.request("POST", `/api/v1/channels/${ordersId}/members`, { kind: "user", id: s.samId }));

  erpConnector = await orgSecretServer("ERP");
  await grant(opsId, erpConnector, ["get_record", "update_record", "add_note"]);
  await grant(strayId, erpConnector, ["get_record", "list_records"]);
  // A connector whose read tools no bot of the board may use: not offered.
  crmConnector = await orgSecretServer("CRM");
  await grant(strayId, crmConnector, ["get_record"]);

  personal = await ok(
    s.victor.request("POST", "/api/v1/mcp-servers", {
      name: "ERP personal",
      transport: "streamable-http",
      url: erpUrl,
      authMode: "per_member_secret",
      memberHeaderName: "Authorization",
      memberHeaderPrefix: "Bearer ",
    }),
  );
  // Víctor connects his own key; the first connection probes the tools API-side.
  await ok(s.victor.request("PUT", `/api/v1/connectors/${personal.id}/secret`, { value: ERP_TOKEN }));
  await grant(opsId, personal, ["get_record"]);
}, 240_000);

afterAll(async () => {
  erpServer?.closeAllConnections();
  await new Promise<void>((resolve) => (erpServer ? erpServer.close(() => resolve()) : resolve()));
  await s?.stop();
});

describe("GET /watched-records/options (the watch dialog)", () => {
  it("Víctor sees the board, its bots and the ERP with the tools Ops helper may use", async () => {
    const o = await ok(options());
    expect(o.channel).toMatchObject({ id: ordersId, name: "orders" });
    expect(o.channel.readers).toBeGreaterThanOrEqual(2);
    expect(o.bots).toEqual([{ id: opsId, displayName: "Ops helper" }]);

    const names = (o.connectors as Json[]).map((c) => c.name).sort();
    expect(names).toEqual(["ERP", "ERP personal"]);
    const org = (o.connectors as Json[]).find((c) => c.id === erpConnector.id) as Json;
    expect(org).toMatchObject({ authMode: "org_secret", connection: null, shared: true });
    const tools = new Map((org.tools as Json[]).map((t) => [t.name, t]));
    expect(tools.get("get_record")).toMatchObject({
      title: "Get sales order",
      readOnly: true,
      destructive: false,
      idArg: "id",
      agentIds: [opsId],
    });
    expect(tools.get("update_record")).toMatchObject({
      readOnly: false,
      destructive: true,
      agentIds: [opsId],
    });
    // Granted only to a bot that is not on the board: listed, usable by nobody here.
    expect(tools.get("list_records")).toMatchObject({ agentIds: [] });
    // No secret, header or URL ever travels.
    expect(JSON.stringify(o)).not.toContain(ERP_TOKEN);
    expect(JSON.stringify(o)).not.toContain("erp-mcp");
  });

  it("a per-member connector: Víctor's own connection and share; Sam (not connected) sees connect-first", async () => {
    const mine = ((await ok(options())).connectors as Json[]).find((c) => c.id === personal.id) as Json;
    expect(mine).toMatchObject({ authMode: "per_member", connection: "connected", shared: false });

    const share = await ok(
      s.victor.request("POST", "/api/v1/member-account-shares", {
        conversationId: ordersId,
        resourceKind: "connector",
        resourceId: personal.id,
      }),
      201,
    );
    const shared = ((await ok(options())).connectors as Json[]).find((c) => c.id === personal.id) as Json;
    expect(shared.shared).toBe(true);

    // Sam reads the same board: Víctor's share is not his, and he has no connection of his own.
    const sams = ((await ok(options(s.sam))).connectors as Json[]).find((c) => c.id === personal.id) as Json;
    expect(sams).toMatchObject({ connection: "not_connected", shared: false });

    expect((await s.victor.request("DELETE", `/api/v1/member-account-shares/${share.id}`)).status).toBe(204);
  });

  it("refused like a link: Alex (no post rights) 403, Eve (another organization) 404, a text channel 400", async () => {
    await fails(options(s.alex), 403);
    await fails(options(s.eve), 404);
    const text = await ok(s.victor.request("POST", "/api/v1/channels", { name: `general-${Date.now()}` }));
    await fails(
      s.victor.request("GET", `/api/v1/watched-records/options?conversationId=${text.id}`),
      400,
      "not_a_board_card",
    );
  });

  it("a connector switched off for the organization is not offered", async () => {
    await ok(s.victor.request("PATCH", `/api/v1/mcp-servers/${erpConnector.id}`, { orgEnabled: false }));
    try {
      const ids = ((await ok(options())).connectors as Json[]).map((c) => c.id);
      expect(ids).not.toContain(erpConnector.id);
      expect(ids).not.toContain(crmConnector.id);
    } finally {
      await ok(s.victor.request("PATCH", `/api/v1/mcp-servers/${erpConnector.id}`, { orgEnabled: true }));
    }
  });
});
