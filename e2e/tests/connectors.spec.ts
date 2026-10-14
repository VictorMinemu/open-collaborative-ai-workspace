import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import { FAKE_URL } from "../support/bot-tools";
import { ADMIN } from "./env";

/**
 * Settings › Connections (07.4-13; D-01, D-03, CONN-01, CONN-03; 07.4-UI-SPEC § 2). A member connects their own
 * account on a per-member connector in a real browser: Connect → the fake provider's authorize endpoint
 * (`infra/fake-model/fake-mcp-oauth.mjs`, auto-approves) → the API's callback → back here Connected.
 *
 * The connector is registered as http://fake-mcp:4291/mcp-oauth/mcp, the name the API reaches through its egress guard
 * (`OCW_EGRESS_TEST_HOSTS=fake-mcp=127.0.0.1`, exported only by scripts/e2e-isolated.sh); the browser reaches the same
 * name through Chromium's host resolver rules, so both sides see one issuer.
 */

test.use({ launchOptions: { args: ["--host-resolver-rules=MAP fake-mcp 127.0.0.1"] } });
test.describe.configure({ mode: "serial" });

const FAKE_HOST = "fake-mcp:4291";
const OAUTH_MCP_URL = `http://${FAKE_HOST}/mcp-oauth/mcp`;
const ISSUER = `http://${FAKE_HOST}/mcp-oauth`;
/** The fake's pre-registered public client (redirect http://127.0.0.1:4290/api/v1/connectors/oauth/callback). */
const CLIENT_ID = "ocw-e2e";
const CRM = "Acme CRM";

interface ServerJson {
  id: string;
  name: string;
  safeName: string;
}

async function fakeScenario(s: Record<string, unknown>) {
  const res = await fetch(`${FAKE_URL}/mcp-oauth/__scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });
  expect(res.ok, "fake scenario").toBe(true);
}

/** Removes the named servers, disconnecting any member (per-member connectors answer 409 otherwise). */
async function removeServers(admin: APIRequestContext, names: readonly string[]) {
  const list = (await (await admin.get("/api/v1/mcp-servers")).json()) as { servers: ServerJson[] };
  for (const s of list.servers.filter((x) => names.includes(x.name))) {
    expect((await admin.delete(`/api/v1/mcp-servers/${s.id}?clearConnections=true`)).ok()).toBe(true);
  }
}

/** A fresh `per_member_oauth` connector on the fake, with its pre-registered client. */
async function oauthConnector(admin: APIRequestContext, name: string): Promise<ServerJson> {
  await removeServers(admin, [name]);
  const res = await admin.post("/api/v1/mcp-servers", {
    data: {
      name,
      transport: "streamable-http",
      url: OAUTH_MCP_URL,
      authMode: "per_member_oauth",
      oauthClient: { issuer: ISSUER, clientId: CLIENT_ID },
    },
  });
  expect(res.ok(), `create ${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as ServerJson;
}

const row = (page: Page, id: string) => page.getByTestId(`connector-row-${id}`);

test.afterEach(async () => {
  if (FAKE_URL) await fakeScenario({});
});

test("member: connect your own account from Settings in a real browser and come back Connected", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  expect(FAKE_URL, "OCW_E2E_FAKE_URL (the fake OAuth MCP server) is set by scripts/e2e-isolated.sh").not.toBe(
    "",
  );
  const admin = await apiAs(ADMIN);
  const crm = await oauthConnector(admin, CRM);
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    const visited: string[] = [];
    page.on("request", (r) => {
      if (r.isNavigationRequest()) visited.push(r.url());
    });
    await page.goto(`${BASE_URL}/settings/connections`);
    if (info.project.name !== "mobile") {
      await expect(page.getByTestId("settings-nav-connections")).toBeVisible();
      await expect(page.getByTestId("settings-nav-keychain")).toBeVisible();
    }

    const r = row(page, crm.id);
    await expect(r).toHaveAttribute("data-status", "not_connected");
    await expect(page.getByTestId(`connector-status-${crm.id}`)).toHaveText("Not connected");
    await expect(page.getByTestId(`connector-meta-${crm.id}`)).toHaveText(
      "Sign in once. Bots use it only when you ask.",
    );

    // ---- Connect: the whole page goes to the provider's sign-in and comes back through the API's callback
    await page.getByTestId(`connector-connect-${crm.id}`).click();
    const banner = page.getByTestId("connections-toast");
    await expect(banner).toHaveText(`${CRM} connected. Ask your bot again.`, { timeout: 30_000 });
    await expect(banner).toHaveAttribute("role", "status");
    await expect(banner).toBeFocused();
    expect(visited.some((u) => u.startsWith(`http://${FAKE_HOST}/mcp-oauth/authorize?`))).toBe(true);
    expect(visited.some((u) => u.includes("/api/v1/connectors/oauth/callback?"))).toBe(true);

    // ---- R10: the pill and the meta line are separate; R1: the account it is connected as
    await expect(r).toHaveAttribute("data-status", "connected");
    await expect(page.getByTestId(`connector-status-${crm.id}`)).toHaveText("Connected");
    await expect(page.getByTestId(`connector-meta-${crm.id}`)).toHaveText(
      /^as sub_[\w-]+@fake-mcp\.test · since today · never used$/,
    );
    // The one-time parameter is gone, so a reload shows the state and no banner.
    await expect(page).not.toHaveURL(/connected=/);
    await page.reload();
    await expect(page.getByTestId(`connector-status-${crm.id}`)).toHaveText("Connected");
    await expect(page.getByTestId("connections-toast")).toHaveCount(0);
    await me.context.close();
  } finally {
    await removeServers(admin, [CRM]).catch(() => undefined);
    await admin.dispose();
  }
});
