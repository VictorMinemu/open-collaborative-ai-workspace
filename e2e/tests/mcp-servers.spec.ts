import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import {
  ask,
  bothThemes,
  cellToken,
  clearMcpServers,
  clearPlugins,
  ensurePluginInstalled,
  FAKE_MCP_HOST,
  FAKE_MCP_TOKEN,
  FAKE_URL,
  freshPersonalBot,
  freshTeamBot,
  NOTES,
  openTeamBotSheet,
  PLUGIN_TOOLS,
} from "../support/bot-tools";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL } from "./env";

/**
 * Settings › MCP servers (03.1-13; SC6, BOT-08, BOT-10). An admin registers the fake MCP server with a
 * write-only bearer; the simulated cell probes it (through `hostMap`, so `fake-mcp:4291` reaches loopback) and
 * the API records `echo` (read-only) and `write_note` (changes data). The credential never comes back to the
 * browser. A bot manager then enables one tool per bot, and the bot uses it through the real gate; personal bots
 * see the server only once the admin allows it for personal bots.
 */

test.describe.configure({ mode: "serial" });

const MCP_URL = `http://${FAKE_MCP_HOST}/mcp`;

function newCell(token: string) {
  return new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: true,
    hostMap: { [FAKE_MCP_HOST]: FAKE_URL ? new URL(FAKE_URL).host : "" },
    pluginTools: PLUGIN_TOOLS,
    stepMs: 1000,
  });
}

const serverCard = (page: Page, name: string) =>
  page.locator(`[data-testid="mcp-server"][data-name="${name}"]`);

async function addServer(page: Page, name: string, bearer: string) {
  await page.getByTestId("mcp-add").first().click();
  const dialog = page.getByTestId("mcp-server-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("mcp-name").fill(name);
  await dialog.getByTestId("mcp-url").fill(MCP_URL);
  await dialog.getByTestId("mcp-add-header").click();
  await expect(dialog.getByTestId("mcp-header-name")).toHaveValue("Authorization");
  await dialog.getByTestId("mcp-header-value").fill(`Bearer ${bearer}`);
  return dialog;
}

async function flip(card: Locator, flag: string, checked: boolean) {
  const sw = card.getByTestId(`mcp-flag-${flag}`);
  await sw.click();
  if (checked) await expect(sw).toBeChecked();
  else await expect(sw).not.toBeChecked();
}

test("admin: register an MCP server with a write-only credential, see its tools, govern it, re-probe, and see a failing one", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake MCP server is not running)");

  const admin = await apiAs(ADMIN);
  await clearMcpServers(admin);
  const sandbox = (
    (await (await admin.get("/api/v1/mcp-servers")).json()) as { sandbox: { available: boolean } }
  ).sandbox;
  const cell = newCell(token);
  await cell.start();
  try {
    const boss = await openAs(browser, ADMIN, project);
    const page = boss.page;
    await page.goto(`${BASE_URL}/settings/mcp-servers`);
    if (!mobile) await expect(page.getByTestId("settings-nav-mcp-servers")).toBeVisible();
    await expect(page.getByTestId("mcp-empty")).toBeVisible();

    // ---- add "Docs" (streamable HTTP + bearer)
    const dialog = await addServer(page, "Docs", FAKE_MCP_TOKEN);
    await expect(dialog.getByTestId("mcp-transport-streamable-http").locator("input")).toBeChecked();
    if (!sandbox.available) {
      await expect(dialog.getByTestId("mcp-transport-sandboxed-stdio")).toContainText(
        "Sandbox not configured",
      );
      await expect(dialog.getByTestId("mcp-transport-sandboxed-stdio").locator("input")).toBeDisabled();
    }
    await expect(dialog).toContainText("HTTPS, or http to an internal service name");
    await bothThemes(page, `mcp-server-dialog-${tag}`);
    await dialog.getByTestId("mcp-save").click();
    await expect(dialog).toBeHidden();

    // ---- the cell probes it: Probing, then Ready with both tools and their effect
    const docs = serverCard(page, "Docs");
    await expect(docs.getByTestId("mcp-status")).toHaveText("Probing");
    await expect(docs.getByTestId("mcp-status")).toHaveText("Ready", { timeout: 15_000 });
    await expect(
      docs.locator('[data-testid="mcp-tool"][data-tool="echo"] [data-testid="tool-effect"]'),
    ).toHaveText("Read-only");
    await expect(
      docs.locator('[data-testid="mcp-tool"][data-tool="write_note"] [data-testid="tool-effect"]'),
    ).toHaveText("Changes data");

    // ---- write-only credential: only "Authorization • set", never the value
    await expect(docs.getByTestId("mcp-header")).toContainText("Authorization");
    await expect(docs.getByTestId("mcp-header")).toContainText("• set");
    expect(await page.content()).not.toContain(FAKE_MCP_TOKEN);
    await docs.getByTestId("mcp-edit").click();
    const edit = page.getByTestId("mcp-server-dialog");
    await expect(edit.getByTestId("mcp-header-name")).toHaveValue("Authorization");
    await expect(edit.getByTestId("mcp-header-value")).toHaveCount(0);
    await expect(edit).toContainText("Value set, hidden");
    expect(await page.content()).not.toContain(FAKE_MCP_TOKEN);
    await page.keyboard.press("Escape");
    await expect(edit).toBeHidden();

    // ---- flags persist (personal bots stays off for the next test)
    await flip(docs, "personalAllowed", true);
    await flip(docs, "trustedChaining", true);
    await page.reload();
    await expect(serverCard(page, "Docs").getByTestId("mcp-flag-personalAllowed")).toBeChecked();
    await expect(serverCard(page, "Docs").getByTestId("mcp-flag-trustedChaining")).toBeChecked();
    await flip(serverCard(page, "Docs"), "personalAllowed", false);
    await flip(serverCard(page, "Docs"), "trustedChaining", false);
    await page.reload();
    await expect(serverCard(page, "Docs").getByTestId("mcp-flag-personalAllowed")).not.toBeChecked();
    await expect(serverCard(page, "Docs").getByTestId("mcp-flag-trustedChaining")).not.toBeChecked();

    // ---- re-probe
    await serverCard(page, "Docs").getByTestId("mcp-reprobe").click();
    await expect(serverCard(page, "Docs").getByTestId("mcp-status")).toHaveText("Probing");
    await expect(serverCard(page, "Docs").getByTestId("mcp-status")).toHaveText("Ready", { timeout: 15_000 });

    // ---- a wrong token: Error with the reason (and still no credential on the page)
    const broken = await addServer(page, "Broken", "wrong-token");
    await broken.getByTestId("mcp-save").click();
    await expect(broken).toBeHidden();
    const bad = serverCard(page, "Broken");
    await expect(bad.getByTestId("mcp-status")).toHaveText("Error", { timeout: 15_000 });
    await expect(bad.getByTestId("mcp-status-detail")).toContainText("refused the credentials (HTTP 401)");
    expect(await page.content()).not.toContain("wrong-token");
    await bad.scrollIntoViewIfNeeded();
    if (!mobile) await bothThemes(page, "mcp-servers-error-1440");

    // ---- delete asks first
    await bad.getByTestId("mcp-delete").click();
    const confirm = page.getByTestId("mcp-delete-dialog");
    await expect(confirm).toContainText("Delete Broken?");
    await confirm.getByTestId("mcp-delete-confirm").click();
    await expect(bad).toHaveCount(0);

    await serverCard(page, "Docs").scrollIntoViewIfNeeded();
    await bothThemes(page, `mcp-servers-${tag}`);
    await boss.context.close();
  } finally {
    await cell.stop();
    await admin.dispose();
  }
});

test("bot manager: enable one MCP tool on a team bot and use it; personal bots get it once the admin allows the server", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake MCP server is not running)");

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const cell = newCell(token);
  await cell.start();
  const samApi = await apiAs(SAM);
  try {
    // Docs from the previous test (registered through the API when this test runs alone).
    let list = (await (await admin.get("/api/v1/mcp-servers")).json()) as {
      servers: Array<{ id: string; name: string; safeName: string; status: string }>;
    };
    if (!list.servers.some((s) => s.name === "Docs")) {
      const res = await admin.post("/api/v1/mcp-servers", {
        data: {
          name: "Docs",
          transport: "streamable-http",
          url: MCP_URL,
          headers: [{ name: "Authorization", value: `Bearer ${FAKE_MCP_TOKEN}` }],
        },
      });
      expect(res.ok(), "register Docs").toBe(true);
    }
    await expect
      .poll(
        async () => {
          list = (await (await admin.get("/api/v1/mcp-servers")).json()) as typeof list;
          return list.servers.find((s) => s.name === "Docs")?.status;
        },
        { timeout: 20_000 },
      )
      .toBe("ready");
    const docs = list.servers.find((s) => s.name === "Docs") as (typeof list.servers)[number];
    expect(
      (await admin.patch(`/api/v1/mcp-servers/${docs.id}`, { data: { personalAllowed: false } })).ok(),
    ).toBe(true);
    const echo = `${docs.safeName}__echo`;
    const writeNote = `${docs.safeName}__write_note`;
    // A plugin too, so the bot's list shows two sources.
    await ensurePluginInstalled(admin, NOTES, "1.0.0");

    const teamName = mobile ? "Archivist" : "Librarian";
    const teamId = await freshTeamBot(admin, teamName);
    const dmId = ((await (await samApi.post(`/api/v1/agents/${teamId}/dm`)).json()) as { dmId: string }).dmId;

    // ---- the admin enables echo (only) on the team bot
    const boss = await openAs(browser, ADMIN, project);
    const sheet = await openTeamBotSheet(boss.page, teamName);
    const tools = sheet.getByTestId("tools-section");
    await expect(tools.locator('[data-testid="tool-source"][data-source="Docs"]')).toContainText(
      "MCP server",
    );
    await expect(tools.locator(`[data-testid="tool-source"][data-source="${NOTES}"]`)).toContainText(
      "Plugin",
    );
    const echoRow = tools.locator(`[data-testid="tool-row"][data-tool="${echo}"]`);
    const noteRow = tools.locator(`[data-testid="tool-row"][data-tool="${writeNote}"]`);
    await expect(echoRow.getByTestId("tool-effect")).toHaveText("Read-only");
    await expect(noteRow.getByTestId("tool-effect")).toHaveText("Changes data");
    await echoRow.getByTestId("tool-switch").click();
    await expect(echoRow.getByTestId("tool-switch")).toBeChecked();
    await expect(noteRow.getByTestId("tool-switch")).not.toBeChecked();
    await tools.scrollIntoViewIfNeeded();
    await bothThemes(boss.page, `bot-tools-${tag}`);
    await boss.page.keyboard.press("Escape");

    // ---- Sam asks the team bot to call echo: allowed by the real gate; write_note was never in the turn
    const sam = await openAs(browser, SAM, project);
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await ask(
      sam.page,
      'say hi [[call echo {"text":"hi"}]]',
      `Tool ${echo}: allowed`,
      `[turn tools: ${echo},ocw_agent_card]`,
    );

    // ---- Sam's personal bot: Docs is listed but off for personal bots
    const personal = await freshPersonalBot(SAM, samId);
    await sam.page.goto(`${BASE_URL}/chat/dm/${personal.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await sam.page.getByTestId("bot-settings").click();
    let mine = sam.page.getByTestId("bot-settings-sheet").getByTestId("tools-section");
    let myEcho = mine.locator(`[data-testid="tool-row"][data-tool="${echo}"]`);
    await expect(myEcho.getByTestId("tool-switch")).toBeDisabled();
    await expect(
      mine.locator('[data-testid="tool-source"][data-source="Docs"]').getByTestId("tool-source-reason"),
    ).toHaveText("Turned off for personal bots by your organization");
    // Sam manages his own bot but not the registry: no admin link.
    await expect(mine.getByRole("link", { name: /Manage/ })).toHaveCount(0);
    await myEcho.scrollIntoViewIfNeeded();
    await bothThemes(sam.page, `bot-tools-personal-${tag}`);
    await sam.page.keyboard.press("Escape");

    // ---- the admin allows Docs for personal bots
    await boss.page.goto(`${BASE_URL}/settings/mcp-servers`);
    await flip(serverCard(boss.page, "Docs"), "personalAllowed", true);

    // ---- Sam enables echo himself and uses it in his DM
    await sam.page.reload();
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await sam.page.getByTestId("bot-settings").click();
    mine = sam.page.getByTestId("bot-settings-sheet").getByTestId("tools-section");
    myEcho = mine.locator(`[data-testid="tool-row"][data-tool="${echo}"]`);
    // Docs is allowed now; the notes plugin is still off for personal bots.
    await expect(
      mine.locator('[data-testid="tool-source"][data-source="Docs"]').getByTestId("tool-source-reason"),
    ).toHaveCount(0);
    await expect(
      mine.locator(`[data-testid="tool-source"][data-source="${NOTES}"]`).getByTestId("tool-source-reason"),
    ).toBeVisible();
    await expect(myEcho.getByTestId("tool-switch")).toBeEnabled();
    await myEcho.getByTestId("tool-switch").click();
    await expect(myEcho.getByTestId("tool-switch")).toBeChecked();
    await sam.page.keyboard.press("Escape");
    await ask(sam.page, 'and here [[call echo {"text":"me"}]]', `Tool ${echo}: allowed`);

    await sam.context.close();
    await boss.context.close();
  } finally {
    await clearPlugins(admin, cell).catch(() => undefined);
    await clearMcpServers(admin).catch(() => undefined);
    await cell.stop();
    const listed = (await (await samApi.get("/api/v1/agents")).json()) as {
      agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
    };
    for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === samId)) {
      await samApi.delete(`/api/v1/agents/${a.id}`);
    }
    await samApi.dispose();
    await admin.dispose();
  }
});

test("member: no MCP servers entry, and the page asks for an admin", async ({ browser }, info) => {
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await admin.dispose();
  const dev = await openAs(browser, SAM, project);
  await dev.page.goto(`${BASE_URL}/settings/mcp-servers`);
  await expect(dev.page.getByTestId("mcp-admin-only")).toBeVisible();
  await expect(dev.page.getByTestId("mcp-add")).toHaveCount(0);
  if (project !== "mobile") await expect(dev.page.getByTestId("settings-nav-mcp-servers")).toHaveCount(0);
  await dev.context.close();
});

// ---------------------------------------------------------------- 07.4-06: connector auth modes (D-01, CONN-01)

const CRM = "Acme CRM";
const CLIENT_CANARY = "e2e-client-secret-canary";

/** Removes the named servers, disconnecting any member (per-member connectors answer 409 otherwise). */
async function removeServers(admin: APIRequestContext, names: readonly string[]) {
  const list = (await (await admin.get("/api/v1/mcp-servers")).json()) as {
    servers: Array<{ id: string; name: string }>;
  };
  for (const s of list.servers.filter((x) => names.includes(x.name))) {
    expect((await admin.delete(`/api/v1/mcp-servers/${s.id}?clearConnections=true`)).ok()).toBe(true);
  }
}

test("admin: register a connector where each member signs in, with a pre-registered client; the list shows its mode", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  await removeServers(admin, [CRM]);
  try {
    const boss = await openAs(browser, ADMIN, project);
    const page = boss.page;
    await page.goto(`${BASE_URL}/settings/mcp-servers`);
    await page.getByTestId("mcp-add").first().click();
    const dialog = page.getByTestId("mcp-server-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("mcp-name").fill(CRM);
    await dialog.getByTestId("mcp-url").fill("https://mcp.acme.example/mcp");
    await expect(dialog.getByTestId("mcp-auth-mode-org_secret").locator("input")).toBeChecked();
    await dialog.getByTestId("mcp-auth-mode-per_member_oauth").click();
    await expect(dialog.getByTestId("mcp-auth-mode-per_member_oauth").locator("input")).toBeChecked();
    // Member sign-in: no organization headers; the redirect URI to register at the provider.
    await expect(dialog.getByTestId("mcp-add-header")).toHaveCount(0);
    await expect(dialog.getByTestId("mcp-redirect-uri")).toHaveValue(
      /\/api\/v1\/connectors\/oauth\/callback$/,
    );
    await expect(dialog.getByTestId("mcp-auth-explanation")).toContainText("Settings › Connections");
    await dialog.getByTestId("mcp-oauth-client-toggle").click();
    await dialog.getByTestId("mcp-oauth-issuer").fill("https://auth.acme.example");
    await dialog.getByTestId("mcp-oauth-client-id").fill("ocw-production");
    await dialog.getByTestId("mcp-oauth-client-secret").fill(CLIENT_CANARY);
    await dialog.getByTestId("mcp-oauth-scopes").fill("crm.read crm.write");
    await dialog.getByTestId("mcp-save").click();
    await expect(dialog).toBeHidden();

    const card = serverCard(page, CRM);
    await expect(card.getByTestId("mcp-auth-badge")).toHaveText("Member sign-in");
    await expect(card.getByTestId("mcp-member-count")).toHaveText("No members connected yet");
    expect(await page.content()).not.toContain(CLIENT_CANARY);

    const list = (await (await admin.get("/api/v1/mcp-servers")).json()) as {
      servers: Array<{
        name: string;
        authMode: string;
        oauthScopes: string[] | null;
        oauthClients: unknown[];
      }>;
    };
    const saved = list.servers.find((s) => s.name === CRM);
    expect(saved).toMatchObject({
      authMode: "per_member_oauth",
      oauthScopes: ["crm.read", "crm.write"],
      oauthClients: [{ issuer: "https://auth.acme.example", clientId: "ocw-production", hasSecret: true }],
    });
    expect(JSON.stringify(list)).not.toContain(CLIENT_CANARY);
    await boss.context.close();
  } finally {
    await removeServers(admin, [CRM]).catch(() => undefined);
    await admin.dispose();
  }
});
