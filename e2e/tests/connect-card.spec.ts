import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { cellToken } from "../support/cell-token";
import { ALEX } from "../support/chat";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL, shot } from "./env";

/**
 * 07.4-12 (CONN-04, SC2; 07.4-UI-SPEC § 5, R8): the "Connect your account" card. A member (Sam at 1440, Alex at 390,
 * so each width shows its own DM) asks a team bot to use a per-member connector they have not connected; the simulated
 * cell calls `POST /connectors/call` for that turn, the API answers 409 `not_connected` and posts the platform's card
 * as the bot in the member's DM: kind generic, status Info, one "How it works"
 * field and a Connect action to Settings › Connections for this connector, carrying the way back to the chat. Rendered
 * by the existing card renderer at 1440 and 390, light and dark; axe finds nothing serious. No model is called.
 */

test.describe.configure({ mode: "serial" });

const BOT = "Scout";
const CONNECTOR = "Acme CRM";

let admin: APIRequestContext;
let plugin: FakeCellPlugin;
let scoutId = "";
let serverId = "";
let safeName = "";

async function bothThemes(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The team bot Scout on the never-metered mock model (created once; both projects share it). */
async function ensureScout(api: APIRequestContext): Promise<string> {
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  const found = listed.agents.find((a) => a.name === BOT);
  if (found) return found.id;
  const res = await api.post("/api/v1/agents", {
    data: {
      name: BOT,
      username: "scout",
      description: "Looks things up in the CRM.",
      instructions: "You are Scout.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create Scout: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** A per-member connector with one probed tool, granted to Scout (created once). */
async function ensureConnector(api: APIRequestContext): Promise<void> {
  const listed = (await (await api.get("/api/v1/mcp-servers")).json()) as {
    servers: Array<{ id: string; name: string; safeName: string }>;
  };
  let server = listed.servers.find((s) => s.name === CONNECTOR);
  if (!server) {
    const res = await api.post("/api/v1/mcp-servers", {
      data: {
        name: CONNECTOR,
        transport: "streamable-http",
        url: "https://crm.acme.example/mcp",
        authMode: "per_member_secret",
        memberHeaderName: "Authorization",
        memberHeaderPrefix: "Bearer ",
      },
    });
    expect(res.ok(), `create connector: ${res.status()}`).toBe(true);
    server = (await res.json()) as { id: string; name: string; safeName: string };
    // The catalog a first member's probe would fill (no member has connected in this run).
    await asSuperuser(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only, description)
       select organization_id, id, 'whoami', $2, true, 'Who you are in the CRM' from app.mcp_servers where id = $1`,
      [server.id, `${server.safeName}__whoami`],
    );
    await asSuperuser("update app.mcp_servers set status = 'ready' where id = $1", [server.id]);
  }
  serverId = server.id;
  safeName = server.safeName;
  const granted = await api.patch(`/api/v1/agents/${scoutId}/capabilities`, {
    data: { tools: [{ sourceKind: "mcp", sourceId: serverId, tool: `${safeName}__whoami` }] },
  });
  expect(granted.ok(), `grant: ${granted.status()}`).toBe(true);
}

test.beforeAll(async () => {
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  scoutId = await ensureScout(admin);
  await ensureConnector(admin);
  plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true });
  await plugin.start();
});

test.afterAll(async () => {
  await plugin?.stop();
  await admin?.dispose();
});

test("a member asks Scout to use their CRM account before connecting it: the connect card in their DM, per UI-SPEC § 5", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const w = info.project.name === "mobile" ? "390" : "1440";
  // Each project has its own member, so each DM shows exactly the card its own turn produced.
  const actor = info.project.name === "mobile" ? ALEX : SAM;
  const member = await apiAs(actor);
  const dm = (await (
    await member.post("/api/v1/dms", { data: { participants: [{ kind: "agent", id: scoutId }] } })
  ).json()) as { id: string };

  // Sam's message is delivered to the cell; the cell asks the proxy for his account; the API posts the card.
  const asked = (await (
    await member.post(`/api/v1/conversations/${dm.id}/messages`, { data: { body: "Who am I in the CRM?" } })
  ).json()) as { id: string };
  const ev = await plugin.waitFor(
    (e) =>
      e.type === "agent.mention.v1" && (e.data as { message?: { id?: string } }).message?.id === asked.id,
    15_000,
  );
  const eventId = (ev.data as unknown as { eventId: string }).eventId;
  const res = await fetch(`${API_URL}/agent-channel/v1/connectors/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${cellToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ eventId, agentId: scoutId, connector: safeName, tool: "whoami", arguments: {} }),
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_connected");
  await member.dispose();

  const s = await openAs(browser, actor, info.project.name);
  try {
    await s.page.goto(`${BASE_URL}/chat/dm/${dm.id}`);
    const row = s.page.locator('[data-testid="message"][data-author-kind="agent"]').last();
    const card = row.getByTestId("agent-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute("data-kind", "generic");
    await expect(card.getByTestId("agent-card-title")).toHaveText(`Connect your ${CONNECTOR} account`);
    await expect(card.getByRole("status", { name: "Status: Info" })).toBeVisible();
    await expect(card.getByTestId("agent-card-fields")).toContainText("How it works");
    await expect(card.getByTestId("agent-card-fields")).toContainText(
      `${BOT} uses your account only when you ask. Results stay in your private chats unless you allow a conversation.`,
    );
    const open = card.getByTestId("agent-card-open");
    await expect(open).toContainText("Connect");
    const href = (await open.getAttribute("href")) ?? "";
    const url = new URL(href, BASE_URL);
    expect(url.pathname).toBe("/settings/connections");
    expect(url.searchParams.get("connector")).toBe(serverId);
    expect(url.searchParams.get("return")).toBe(`/chat/dm/${dm.id}?m=${asked.id}`);
    // The bot's message carries the card under Scout's name; the summary is the screen-reader description.
    await expect(row.getByTestId("message-author")).toHaveText(BOT);
    await expect(
      row.getByText(`${BOT} needs your ${CONNECTOR} account to do this.`, { exact: false }),
    ).toHaveClass(/sr-only/);
    await card.scrollIntoViewIfNeeded();
    await bothThemes(s.page, `connect-card-${w}`);
    await expectNoSeriousA11y(s.page, '[data-testid="agent-card"]');
    await s.page.emulateMedia({ colorScheme: "dark" });
    await expectNoSeriousA11y(s.page, '[data-testid="agent-card"]');
    await s.page.emulateMedia({ colorScheme: "light" });
  } finally {
    await s.context.close();
  }
});
