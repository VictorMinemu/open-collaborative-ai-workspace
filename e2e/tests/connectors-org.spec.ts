import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, createChannel, ensureMember, openAs, SAM } from "../support/actors";
import { FAKE_MCP_HOST, FAKE_URL } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { apiRequests, finishedBodies } from "../support/responses";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Phase 07.14 Settings › MCP servers, the organization's account (07.14-11; D-08, D-10, D-11, COA-01, COA-04, PD-12 ›
 * Row). An admin connects an `org_oauth` server once for the whole organization from its row: Connect → the fake
 * provider's authorize endpoint (`infra/fake-model/fake-mcp-oauth.mjs`, auto-approves) → the API's one callback → back
 * on this page with `?connected=<id>`, read once into a focused banner. Plan 13 adds the bot that uses the account.
 *
 * The server is registered as http://fake-mcp:4291/mcp-oauth/mcp, the name the API reaches through its egress guard
 * (`OCW_EGRESS_TEST_HOSTS`, scripts/e2e-isolated.sh) and the browser through Chromium's host resolver rules, so both
 * sides see one issuer.
 *
 * 07.14-13 adds the bot: a member's team bot uses the organization's account in a channel, through the simulated cell
 * (`FakeCellPlugin`, which calls `POST /agent-channel/v1/connectors/call` exactly like apps/openclaw-channel), and
 * stops when the admin disconnects it (COA-01, COA-02, D-04, D-08, PD-10).
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
  const banner = page.getByTestId("mcp-arrival-banner");
  // A banner from an earlier return would satisfy the wait below before the browser even leaves.
  if (await banner.isVisible()) await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
  page.on("request", onRequest);
  await card.getByTestId(testId).click();
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

async function fakeRevocations(): Promise<number> {
  const res = await fetch(`${FAKE_URL}/mcp-oauth/__stats`);
  return ((await res.json()) as { revocations: number }).revocations;
}

/** axe on the server list in light and dark (07.4 Accessibility contract, 07.14 D-11). */
async function a11yBothThemes(page: Page) {
  await expectNoSeriousA11y(page, '[data-testid="mcp-server-list"]');
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, '[data-testid="mcp-server-list"]');
  await page.emulateMedia({ colorScheme: "light" });
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

test("admin: reconnect, disconnect, failures and delete, at both widths and themes", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  expect(FAKE_URL, "OCW_E2E_FAKE_URL (the fake OAuth MCP server) is set by scripts/e2e-isolated.sh").not.toBe(
    "",
  );
  const w = info.project.name === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const docs = await orgOAuthServer(admin, DOCS);
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    try {
      await page.goto(`${BASE_URL}/settings/mcp-servers`);
      const card = serverCard(page, DOCS);
      const row = card.getByTestId("mcp-org-connection");

      // ---- needs reconnect (D-08): a short-lived token whose grant the provider revoked; Re-probe tries to refresh
      await fakeScenario({ expires_in: 1 });
      await connectFromRow(page, card, docs);
      await expect(row).toHaveAttribute("data-status", "connected");
      await page.getByTestId("mcp-arrival-banner").getByRole("button", { name: "Dismiss" }).click();
      await fakeScenario({ revoke_all: true });
      await card.getByTestId("mcp-reprobe").click();
      await expect(row).toHaveAttribute("data-status", "needs_reconnect", { timeout: 15_000 });
      await expect(row.getByTestId("mcp-org-status")).toHaveText("Needs reconnect");
      await expect(row.getByTestId("mcp-org-account")).toHaveText("Access was revoked at the provider.");
      await expect(row.getByTestId("mcp-org-disconnect")).toBeVisible();
      await showRow(card);
      await bothThemes(page, `mcp-org-row-needs-reconnect-${w}`);
      await a11yBothThemes(page);

      // ---- Reconnect goes through the provider again and comes back with the banner
      await fakeScenario({});
      await connectFromRow(page, card, docs, "mcp-org-reconnect");
      await expect(row).toHaveAttribute("data-status", "connected");

      // ---- Disconnect asks first (focus on Cancel), then signs out at the provider and forgets the account
      const revokedBefore = await fakeRevocations();
      await row.getByTestId("mcp-org-disconnect").click();
      const dialog = page.getByTestId("mcp-org-disconnect-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`Disconnect ${DOCS}?`);
      await expect(dialog).toContainText(
        `Bots stop using the organization's account on ${DOCS}. OCW also signs it out at the provider when it can.`,
      );
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await bothThemes(page, `mcp-org-disconnect-${w}`);
      await dialog.getByTestId("mcp-org-disconnect-confirm").click();
      await expect(dialog).toBeHidden();
      await expect(row).toHaveAttribute("data-status", "not_connected");
      await expect(row.getByTestId("mcp-org-account")).toHaveText(
        `Not connected. Bots can't use ${DOCS} until an admin connects it.`,
      );
      expect(await fakeRevocations()).toBeGreaterThan(revokedBefore);

      // ---- the provider refuses: a coded arrival (D-10), alert, fixed sentence only
      await fakeScenario({ deny: true });
      await row.getByTestId("mcp-org-connect").click();
      const banner = page.getByTestId("mcp-arrival-banner");
      await expect(banner).toHaveAttribute("data-kind", "error", { timeout: 30_000 });
      await expect(banner).toHaveAttribute("role", "alert");
      await expect(banner).toBeFocused();
      await expect(page.getByTestId("mcp-arrival-banner-title")).toHaveText(`${DOCS} didn't allow access.`);
      await expect(page).toHaveURL(/\/settings\/mcp-servers$/);

      await fakeScenario({ invalid_scope_at_authorize: true });
      await row.getByTestId("mcp-org-connect").click();
      await expect(page.getByTestId("mcp-arrival-banner-title")).toHaveText(
        `Couldn't connect ${DOCS}: Token.`,
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("mcp-arrival-banner-body")).toHaveText(
        "The provider refused the requested scopes. Clear Scopes to use the server's own, or enter scopes it accepts.",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await bothThemes(page, `mcp-org-banner-error-${w}`);

      // ---- a refused start records the failing step on the row (D-10), with its fix line and Test sign-in
      await page.getByTestId("mcp-arrival-banner").getByRole("button", { name: "Dismiss" }).click();
      await fakeScenario({ no_pkce_meta: true });
      await row.getByTestId("mcp-org-connect").click();
      await expect(page.locator("[data-sonner-toast]").first()).toContainText(
        `Couldn't connect ${DOCS}: PKCE (S256).`,
      );
      await page.reload();
      const failure = card.getByTestId("mcp-auth-failure");
      await expect(failure).toHaveAttribute("data-code", "pkce_unsupported");
      await expect(failure).toHaveAttribute("role", "note");
      await expect(failure).toContainText("Last sign-in failed: PKCE (S256).");
      await expect(failure).toContainText(
        `${DOCS}'s sign-in doesn't offer PKCE (S256), which OCW requires. Use Client credentials or Organization headers.`,
      );
      await showRow(card);
      await failure.scrollIntoViewIfNeeded();
      await bothThemes(page, `mcp-org-row-failure-${w}`);
      await a11yBothThemes(page);
      await failure.getByTestId("mcp-auth-failure-test").click();
      await expect(page.getByTestId("mcp-server-dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("mcp-server-dialog")).toBeHidden();

      // ---- a success clears the recorded failure
      await fakeScenario({});
      await connectFromRow(page, card, docs);
      await expect(row).toHaveAttribute("data-status", "connected");
      await expect(card.getByTestId("mcp-auth-failure")).toHaveCount(0);
    } finally {
      await me.context.close();
    }

    // ---- a member's Settings › Connections lists no organization-mode server (COA-05)
    const sam = await openAs(browser, SAM, info.project.name);
    try {
      await sam.page.goto(`${BASE_URL}/settings/connections`);
      await expect(sam.page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
      await expect(sam.page.getByTestId(`connector-row-${docs.id}`)).toHaveCount(0);
      await expect(sam.page.getByText(DOCS)).toHaveCount(0);
    } finally {
      await sam.context.close();
    }

    // ---- Delete names the organization's sign-in and confirms it (PD-11)
    const again = await openAs(browser, ADMIN, info.project.name);
    try {
      const page = again.page;
      await page.goto(`${BASE_URL}/settings/mcp-servers`);
      const card = serverCard(page, DOCS);
      await expect(card.getByTestId("mcp-org-connection")).toHaveAttribute("data-status", "connected");
      await card.getByTestId("mcp-delete").click();
      const dialog = page.getByTestId("mcp-delete-dialog");
      await expect(dialog).toContainText(`The organization's sign-in to ${DOCS} is deleted too.`);
      await expect(dialog.getByTestId("mcp-delete-confirm")).toHaveText("Delete and disconnect");
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await dialog.getByTestId("mcp-delete-confirm").click();
      await expect(dialog).toBeHidden();
      await expect(card).toHaveCount(0);
    } finally {
      await again.context.close();
    }
  } finally {
    await removeServers(admin, [DOCS]);
    await admin.dispose();
  }
});

// ---------------------------------------------------------------- 07.14-13: the bot uses the organization's account

const CRM = "Company CRM";
const BILLING = "Billing API";
const BOT = "Relay";
/** The e2e fake's pre-registered confidential client (infra/fake-model/server.mjs). */
const CC_CLIENT = "ocw-e2e-cc";
const CC_SECRET = "e2e-cc-secret-canary";
/** Every token, refresh token and code the fake issues starts with one of these (fake-mcp-oauth.mjs). */
const FAKE_SECRETS = /fakeat_|fakert_|fakecode_/u;
const SUBJECT = /"subject":"(sub_[A-Za-z0-9_-]+)"/u;

/** The team bot Relay on the never-metered mock model (the journey's; created once, shared by both projects). */
async function ensureRelay(api: APIRequestContext): Promise<string> {
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  const found = listed.agents.find((a) => a.name === BOT);
  if (found) return found.id;
  const res = await api.post("/api/v1/agents", {
    data: {
      name: BOT,
      username: "relay",
      description: "Looks things up in the pipeline.",
      instructions: "You are Relay.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create Relay: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** The organization's client-credentials server, saved in the dialog exactly as 12's test does: one Save. */
async function saveCcInDialog(page: Page, name: string) {
  await page.getByTestId("mcp-add").first().click();
  const dialog = page.getByTestId("mcp-server-dialog");
  await dialog.getByTestId("mcp-name").fill(name);
  await dialog.getByTestId("mcp-url").fill(OAUTH_MCP_URL);
  await dialog.getByTestId("mcp-auth-mode-org_client_credentials").click();
  const fields = dialog.getByTestId("mcp-cc-fields");
  await fields.getByTestId("mcp-cc-client-id").fill(CC_CLIENT);
  await fields.getByTestId("mcp-cc-client-secret").fill(CC_SECRET);
  await dialog.getByTestId("mcp-save").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

test("a member's bot uses the organization's account in a channel; Disconnect stops it", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  expect(FAKE_URL, "OCW_E2E_FAKE_URL (the fake OAuth MCP server) is set by scripts/e2e-isolated.sh").not.toBe(
    "",
  );
  const w = info.project.name === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const relayId = await ensureRelay(admin);
  await removeServers(admin, [CRM, BILLING]);
  const servers: Record<string, ServerJson> = {};

  /** Relay's decisions, as the real model would make them: the CRM's or the billing API's `whoami`. */
  const toolCallsFor = (m: MentionPayload) => {
    if (m.agent.id !== relayId) return [];
    const target = /crm/iu.test(m.message.text)
      ? servers[CRM]
      : /billing/iu.test(m.message.text)
        ? servers[BILLING]
        : undefined;
    return target
      ? [{ tool: "ocw_connector_call", args: { connector: target.safeName, tool: "whoami", arguments: {} } }]
      : [];
  };
  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true, toolCallsFor });
  await plugin.start();
  try {
    // ---- the admin: Company CRM connected from its row, Billing API saved in the dialog; both Ready
    let crmSubject = "";
    const boss = await openAs(browser, ADMIN, info.project.name);
    try {
      const page = boss.page;
      const crmServer = await orgOAuthServer(admin, CRM);
      servers[CRM] = crmServer;
      await page.goto(`${BASE_URL}/settings/mcp-servers`);
      const crm = serverCard(page, CRM);
      await connectFromRow(page, crm, crmServer);
      const account = (await crm.getByTestId("mcp-org-account").textContent()) ?? "";
      crmSubject = /Connected as (sub_[A-Za-z0-9_-]+)@fake-mcp\.test/u.exec(account)?.[1] ?? "";
      expect(crmSubject, "the organization grant's subject").toMatch(/^sub_/);
      await expect(crm.getByTestId("mcp-status")).toHaveText("Ready");

      await saveCcInDialog(page, BILLING);
      const billing = serverCard(page, BILLING);
      await expect(billing.getByTestId("mcp-status")).toHaveText("Ready");
      await expect(billing.getByTestId("mcp-org-connection")).toHaveAttribute("data-status", "connected");
    } finally {
      await boss.context.close();
    }
    const list = (await (await admin.get("/api/v1/mcp-servers")).json()) as { servers: ServerJson[] };
    const billingServer = list.servers.find((s) => s.name === BILLING);
    expect(billingServer, BILLING).toBeTruthy();
    if (billingServer) servers[BILLING] = billingServer;

    // ---- Relay may use each server's read-only `whoami` (the bot's tool choice; the account stays the organization's)
    const granted = await admin.patch(`/api/v1/agents/${relayId}/capabilities`, {
      data: {
        tools: [CRM, BILLING].map((n) => ({
          sourceKind: "mcp",
          sourceId: servers[n]?.id,
          tool: `${servers[n]?.safeName}__whoami`,
        })),
      },
    });
    expect(granted.ok(), `grant whoami to Relay: ${granted.status()}`).toBe(true);

    // ---- the cell never sees the organization's servers, their tokens or the client secret (D-04)
    const snapshot = await plugin.fetchCell();
    const cellServers = (snapshot.mcpServers ?? []).map((s) => s.id);
    expect(cellServers).not.toContain(servers[CRM]?.id);
    expect(cellServers).not.toContain(servers[BILLING]?.id);
    expect(JSON.stringify(snapshot)).not.toMatch(FAKE_SECRETS);
    expect(JSON.stringify(snapshot)).not.toContain(CC_SECRET);

    // ---- #sales: Sam (a member, not an admin), Víctor and Relay
    const sales = `sales-${w}-${Date.now().toString(36)}`;
    const salesId = await createChannel(admin, sales, "private");
    for (const member of [
      { kind: "user", id: samId },
      { kind: "agent", id: relayId },
    ]) {
      const added = await admin.post(`/api/v1/channels/${salesId}/members`, { data: member });
      expect(added.ok(), `add ${member.kind} to #${sales}`).toBe(true);
    }

    const sam = await openAs(browser, SAM, info.project.name);
    try {
      const page = sam.page;
      const bodies = finishedBodies(page, apiRequests());
      /** Sam @mentions Relay from #sales' composer; returns Relay's reply, opened in its thread. */
      const ask = async (text: string): Promise<Locator> => {
        await page.goto(`${BASE_URL}/chat/${salesId}`);
        const before = plugin.replies.length;
        const box = page.getByTestId("composer");
        await box.click();
        await box.pressSequentially("@rel");
        await page.getByTestId("mention-option").filter({ hasText: BOT }).first().click();
        await expect(box).toHaveValue("@relay ");
        await box.pressSequentially(text);
        await box.press("Enter");
        await plugin.waitUntil(() => plugin.replies.length > before, 20_000);
        const last = plugin.replies.at(-1);
        expect(last?.mention.message.author.id, "the turn is Sam's").toBe(samId);
        await page.goto(
          `${BASE_URL}/chat/${salesId}?thread=${last?.mention.thread.rootMessageId}&m=${last?.messageId}`,
        );
        const reply = page
          .getByTestId("thread-panel")
          .locator(`[data-testid="message"][data-message-id="${last?.messageId}"]`);
        await expect(reply).toBeVisible({ timeout: 15_000 });
        return reply;
      };

      // ---- the organization's sign-in: Relay answers Sam with the account the admin connected (COA-01, COA-02)
      const crmReply = await ask("who are we in the CRM?");
      await expect(crmReply).toContainText(`Tool ocw_connector_call: {"subject":"${crmSubject}"`);
      await expect(page.getByTestId("agent-card")).toHaveCount(0);
      await crmReply.scrollIntoViewIfNeeded();
      await bothThemes(page, `connectors-org-bot-${w}`);

      // ---- the organization's client credentials: the client's own subject
      const billingReply = await ask("which billing account is this?");
      await expect(billingReply).toContainText(`Tool ocw_connector_call: {"subject":"sub_cc_${CC_CLIENT}"`);
      await expect(page.getByTestId("agent-card")).toHaveCount(0);
      expect(SUBJECT.exec((await billingReply.textContent()) ?? "")?.[1]).not.toBe(crmSubject);

      // ---- Sam's own pages: neither server among his accounts, no token or secret in anything he received (COA-05)
      await page.goto(`${BASE_URL}/settings/connections`);
      await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
      for (const n of [CRM, BILLING]) {
        await expect(page.getByTestId(`connector-row-${servers[n]?.id}`)).toHaveCount(0);
        await expect(page.getByText(n)).toHaveCount(0);
      }
      const received = (await bodies()).join("\n");
      expect(received).not.toMatch(FAKE_SECRETS);
      expect(received).not.toContain(CC_SECRET);
      expect(await page.content()).not.toMatch(FAKE_SECRETS);

      // ---- the admin disconnects Company CRM from its row
      const again = await openAs(browser, ADMIN, info.project.name);
      try {
        await again.page.goto(`${BASE_URL}/settings/mcp-servers`);
        const row = serverCard(again.page, CRM).getByTestId("mcp-org-connection");
        await row.getByTestId("mcp-org-disconnect").click();
        const dialog = again.page.getByTestId("mcp-org-disconnect-dialog");
        await dialog.getByTestId("mcp-org-disconnect-confirm").click();
        await expect(dialog).toBeHidden();
        await expect(row).toHaveAttribute("data-status", "not_connected");
      } finally {
        await again.context.close();
      }

      // ---- Sam asks again: refused with the admin sentence (PD-10), and still no connect card for him
      const refused = await ask("and now, who are we in the CRM?");
      await expect(refused).toContainText("Tool ocw_connector_call: refused (not_connected)");
      await expect(refused).not.toContainText(crmSubject);
      const call = plugin.connectorRequests.filter((r) => r.route === "/connectors/call").at(-1);
      expect(call?.status).toBe(409);
      expect(call?.body).toMatchObject({
        error: {
          code: "not_connected",
          message: `The organization hasn't connected ${CRM} yet. An admin can connect it in Settings › MCP servers.`,
        },
      });
      await expect(page.getByTestId("agent-card")).toHaveCount(0);
      expect((await bodies()).join("\n")).not.toMatch(FAKE_SECRETS);
    } finally {
      await sam.context.close();
    }

    // ---- nothing the cell received carries a token or the secret
    for (const seen of [plugin.events, plugin.connectorRequests]) {
      expect(JSON.stringify(seen)).not.toMatch(FAKE_SECRETS);
      expect(JSON.stringify(seen)).not.toContain(CC_SECRET);
    }
  } finally {
    await plugin.stop();
    await removeServers(admin, [CRM, BILLING]);
    await admin.dispose();
  }
});
