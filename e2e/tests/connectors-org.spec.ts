import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import { FAKE_MCP_HOST, FAKE_URL } from "../support/bot-tools";
import { ADMIN, shot } from "./env";

/**
 * Phase 07.14 Settings › MCP servers, the organization's account (07.14-11; D-08, D-10, D-11, COA-01, COA-04, PD-12 ›
 * Row). An admin connects an `org_oauth` server once for the whole organization from its row: Connect → the fake
 * provider's authorize endpoint (`infra/fake-model/fake-mcp-oauth.mjs`, auto-approves) → the API's one callback → back
 * on this page with `?connected=<id>`, read once into a focused banner. Plan 13 adds the bot that uses the account.
 *
 * The server is registered as http://fake-mcp:4291/mcp-oauth/mcp, the name the API reaches through its egress guard
 * (`OCW_EGRESS_TEST_HOSTS`, scripts/e2e-isolated.sh) and the browser through Chromium's host resolver rules, so both
 * sides see one issuer.
 */

test.use({ launchOptions: { args: ["--host-resolver-rules=MAP fake-mcp 127.0.0.1"] } });
test.describe.configure({ mode: "serial" });

const FAKE_HOST = FAKE_MCP_HOST;
const OAUTH_MCP_URL = `http://${FAKE_HOST}/mcp-oauth/mcp`;
const ISSUER = `http://${FAKE_HOST}/mcp-oauth`;
/** The fake's pre-registered public client (redirect http://127.0.0.1:4290/api/v1/connectors/oauth/callback). */
const CLIENT_ID = "ocw-e2e";
const DOCS = "Acme Docs";

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

/** Removes the named servers with whatever connection they hold (the API answers 409 otherwise). */
async function removeServers(admin: APIRequestContext, names: readonly string[]) {
  const list = (await (await admin.get("/api/v1/mcp-servers")).json()) as { servers: ServerJson[] };
  for (const s of list.servers.filter((x) => names.includes(x.name))) {
    expect((await admin.delete(`/api/v1/mcp-servers/${s.id}?clearConnections=true`)).ok()).toBe(true);
  }
}

/** A fresh `org_oauth` server on the fake with its pre-registered client: nobody has connected it yet. */
async function orgOAuthServer(admin: APIRequestContext, name: string): Promise<ServerJson> {
  await removeServers(admin, [name]);
  const res = await admin.post("/api/v1/mcp-servers", {
    data: {
      name,
      transport: "streamable-http",
      url: OAUTH_MCP_URL,
      authMode: "org_oauth",
      oauthClient: { issuer: ISSUER, clientId: CLIENT_ID },
    },
  });
  expect(res.ok(), `create ${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as ServerJson;
}

const serverCard = (page: Page, name: string) =>
  page.locator(`[data-testid="mcp-server"][data-name="${name}"]`);

async function bothThemes(page: Page, name: string) {
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  await page.mouse.move(0, 0);
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The card in view with its organization block, for a screenshot of the row. */
async function showRow(card: Locator) {
  await card.getByTestId("mcp-org-connection").scrollIntoViewIfNeeded();
}

/** Row → Connect → the fake's authorize → the callback → back here with the success banner, focused. */
async function connectFromRow(page: Page, card: Locator, server: ServerJson, testId = "mcp-org-connect") {
  const visited: string[] = [];
  const onRequest = (r: { isNavigationRequest(): boolean; url(): string }) => {
    if (r.isNavigationRequest()) visited.push(r.url());
  };
  page.on("request", onRequest);
  await card.getByTestId(testId).click();
  const banner = page.getByTestId("mcp-arrival-banner");
  await expect(banner).toHaveAttribute("data-kind", "success", { timeout: 30_000 });
  page.off("request", onRequest);
  expect(visited.some((u) => u.startsWith(`http://${FAKE_HOST}/mcp-oauth/authorize?`))).toBe(true);
  expect(visited.some((u) => u.includes("/api/v1/connectors/oauth/callback?"))).toBe(true);
  expect(visited.some((u) => u.includes(`/settings/mcp-servers?connected=${server.id}`))).toBe(true);
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner).toBeFocused();
  await expect(page.getByTestId("mcp-arrival-banner-title")).toHaveText(
    `Connected ${server.name} for the organization.`,
  );
  // Read once: the parameters leave the URL, so a reload repeats nothing.
  await expect(page).toHaveURL(/\/settings\/mcp-servers$/);
}

test.afterEach(async () => {
  if (FAKE_URL) await fakeScenario({});
});

test("admin: connect the organization's account from the row, at both widths and themes", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  expect(FAKE_URL, "OCW_E2E_FAKE_URL (the fake OAuth MCP server) is set by scripts/e2e-isolated.sh").not.toBe(
    "",
  );
  const w = info.project.name === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const docs = await orgOAuthServer(admin, DOCS);
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    try {
      await page.goto(`${BASE_URL}/settings/mcp-servers`);
      const card = serverCard(page, DOCS);
      await expect(card.getByTestId("mcp-status")).toHaveText("Waiting for an admin to connect");
      await expect(card.getByTestId("mcp-auth-badge")).toHaveText("Organization sign-in");
      const row = card.getByTestId("mcp-org-connection");
      await expect(row).toHaveAttribute("data-status", "not_connected");
      await expect(row.getByTestId("mcp-org-account")).toHaveText(
        `Not connected. Bots can't use ${DOCS} until an admin connects it.`,
      );
      const connect = row.getByTestId("mcp-org-connect");
      await expect(connect).toBeEnabled();
      if (w === "390") {
        const box = await connect.boundingBox();
        expect(box?.height ?? 0, "44 px target at 390").toBeGreaterThanOrEqual(44);
      }
      await showRow(card);
      await bothThemes(page, `mcp-org-row-not-connected-${w}`);

      // ---- Connect → the provider → back with the banner (COA-01)
      await connectFromRow(page, card, docs);
      await bothThemes(page, `mcp-org-banner-connected-${w}`);

      // ---- the row names the account and the admin who connected it; the server turned Ready with its tools
      await expect(row).toHaveAttribute("data-status", "connected");
      await expect(row.getByTestId("mcp-org-account")).toHaveText(
        new RegExp(`^Connected as sub_[A-Za-z0-9_-]+@fake-mcp\\.test · by ${ADMIN.name} · just now$`),
      );
      await expect(card.getByTestId("mcp-status")).toHaveText("Ready");
      await expect(card).toContainText("3 tools");
      await expectNoSeriousA11y(page, '[data-testid="mcp-server-list"]');
      await showRow(card);
      await bothThemes(page, `mcp-org-row-connected-${w}`);
    } finally {
      await me.context.close();
    }
  } finally {
    await removeServers(admin, [DOCS]);
    await admin.dispose();
  }
});
