import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, createChannel, ensureMember, openAs, SAM } from "../support/actors";
import { FAKE_URL } from "../support/bot-tools";
import { bothThemes } from "../support/files";
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
    await expect(page.getByTestId("connections-toast-text")).toHaveText(
      `${CRM} connected. Ask your bot again.`,
      {
        timeout: 30_000,
      },
    );
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

// ---------------------------------------------------------------- Task 2: every state, return, shares, desktop, R6

const ERP = "ERP";
const KEY_CANARY = `e2e-member-key-canary-${Date.now().toString(36)}`;
const PLAIN_MCP_URL = `http://${FAKE_HOST}/mcp`;

/** A fresh `per_member_secret` connector (the member's key is sent as X-Api-Key). */
async function keyConnector(admin: APIRequestContext, name: string): Promise<ServerJson> {
  await removeServers(admin, [name]);
  const res = await admin.post("/api/v1/mcp-servers", {
    data: {
      name,
      transport: "streamable-http",
      url: PLAIN_MCP_URL,
      authMode: "per_member_secret",
      memberHeaderName: "X-Api-Key",
    },
  });
  expect(res.ok(), `create ${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as ServerJson;
}

/** axe on `selector` in light and in dark (the theme switched the way `bothThemes` does). */
async function a11yBothThemes(page: Page, selector: string) {
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "light" });
}

/** At 390 every control is at least 44×44: a control inside a <label> is measured by its label (the hit area). */
async function expectTouchTargets(scope: Locator, what: string) {
  const small = await scope.evaluateAll((roots) => {
    const out: string[] = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), [role="switch"], [role="combobox"], a[href]',
      )) {
        const target = (el.closest("label") as HTMLElement | null) ?? el;
        const r = target.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width < 44 || r.height < 44) {
          out.push(
            `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        }
      }
    }
    return out;
  });
  expect(small, `controls under 44×44 in ${what}`).toEqual([]);
}

/** Opens a row's secondary action: a button at 1440, an item of the `⋯` menu at 390. */
async function secondary(page: Page, id: string, action: "replace" | "disconnect", mobile: boolean) {
  if (mobile) {
    const menu = page.getByTestId(`connector-menu-${id}`);
    await expect(menu).toHaveAttribute("aria-label", /actions$/);
    await menu.click();
  }
  await page.getByTestId(`connector-${action}-${id}`).click();
}

/** Connect through the fake provider and wait for the success banner. */
async function connectInBrowser(page: Page, id: string, name: string, testId = `connector-connect-${id}`) {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId("connections-toast-text")).toHaveText(
    `${name} connected. Ask your bot again.`,
    {
      timeout: 30_000,
    },
  );
}

/** Every API response body the page receives, to prove a secret never comes back (T-07.4-13-01). */
function captureResponses(page: Page): () => Promise<string> {
  const bodies: Array<Promise<string>> = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/v1/")) bodies.push(r.text().catch(() => ""));
  });
  return async () => (await Promise.all(bodies)).join("\n");
}

/** Finds a channel by name (the isolated database is shared by both projects of a run) or creates it. */
async function ensureChannel(api: APIRequestContext, name: string, visibility: "public" | "private") {
  const list = (await (await api.get("/api/v1/channels")).json()) as {
    channels: Array<{ id: string; name: string }>;
  };
  return list.channels.find((c) => c.name === name)?.id ?? (await createChannel(api, name, visibility));
}

/** Toasts fade out on their own; screenshots wait for them so nothing covers the screen under review. */
async function noToasts(page: Page) {
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const fixtureId = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

/** The five states of UI-SPEC § 2 at once (the screenshot); each state is also reached for real in these tests. */
function everyStateFixture() {
  const base = {
    scopes: [],
    oauthStatus: null,
    secretHeaderName: null,
    secretHeaderPrefix: null,
    accountLabel: null,
    reconnectReason: null,
    connectedAt: null,
    lastUsedAt: null,
  };
  return {
    connectors: [
      {
        ...base,
        serverId: fixtureId(1),
        name: "Acme CRM",
        safeName: "acme_crm",
        authMode: "per_member_oauth",
        status: "not_connected",
      },
      {
        ...base,
        serverId: fixtureId(2),
        name: "Jira",
        safeName: "jira",
        authMode: "per_member_oauth",
        status: "connected",
        accountLabel: "ana@acme.com",
        connectedAt: iso(11 * 86_400_000),
        lastUsedAt: iso(5 * 60_000),
      },
      {
        ...base,
        serverId: fixtureId(3),
        name: "ERP",
        safeName: "erp",
        authMode: "per_member_secret",
        status: "connected",
        secretHeaderName: "X-Api-Key",
        connectedAt: iso(60_000),
      },
      {
        ...base,
        serverId: fixtureId(4),
        name: "HubSpot",
        safeName: "hubspot",
        authMode: "per_member_oauth",
        status: "needs_reconnect",
        reconnectReason: "expired",
        connectedAt: iso(30 * 86_400_000),
      },
      {
        ...base,
        serverId: fixtureId(5),
        name: "Drive",
        safeName: "drive",
        authMode: "per_member_oauth",
        status: "needs_reconnect",
        reconnectReason: "revoked",
        connectedAt: iso(3 * 86_400_000),
      },
      {
        ...base,
        serverId: fixtureId(6),
        name: "Tickets",
        safeName: "tickets",
        authMode: "per_member_oauth",
        status: "not_connected",
        oauthStatus: "needs_client",
      },
    ],
    shares: [
      {
        id: fixtureId(9),
        conversationId: fixtureId(10),
        conversationName: "#ops",
        resourceKind: "connector",
        resourceId: fixtureId(2),
        resourceName: "Jira",
        readersAtGrant: 5,
        grantedAt: iso(5 * 86_400_000),
      },
    ],
  };
}

test("member: a key connector, revoked and expired sign-ins, errors as fixed sentences, the HTTPS notice and every state at a glance", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const crm = await oauthConnector(admin, CRM);
  const erp = await keyConnector(admin, ERP);
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    const responses = captureResponses(page);
    let routeMode: "real" | "https" | "expired" | "every" | "empty" = "real";
    await page.route("**/api/v1/connectors", async (route) => {
      if (route.request().method() !== "GET" || routeMode === "real") return route.fallback();
      const res = await route.fetch();
      const json = (await res.json()) as {
        connectors: Array<Record<string, unknown>>;
        oauth: { oauthAvailable: boolean };
      };
      if (routeMode === "https") json.oauth.oauthAvailable = false;
      if (routeMode === "expired") {
        for (const c of json.connectors) {
          if (c.serverId === crm.id)
            Object.assign(c, { status: "needs_reconnect", reconnectReason: "expired" });
        }
      }
      if (routeMode === "every") json.connectors = everyStateFixture().connectors;
      if (routeMode === "empty") json.connectors = [];
      await route.fulfill({ response: res, json });
    });
    await page.route("**/api/v1/member-account-shares", async (route) => {
      if (route.request().method() !== "GET" || routeMode !== "every") return route.fallback();
      await route.fulfill({ json: { shares: everyStateFixture().shares } });
    });
    await page.goto(`${BASE_URL}/settings/connections`);

    // ---- a key connector: the dialog says where the key goes; Save key → Connected; the value never comes back
    await expect(page.getByTestId(`connector-meta-${erp.id}`)).toHaveText(
      "Add your own key. It's never shown again.",
    );
    await page.getByTestId(`connector-connect-${erp.id}`).click();
    const keyDialog = page.getByTestId("connect-secret-dialog");
    await expect(keyDialog).toContainText(`Add your ${ERP} key`);
    await expect(keyDialog).toContainText("Sent as X-Api-Key.");
    await expect(keyDialog.getByTestId("connect-secret-value")).toHaveAttribute("type", "password");
    await expect(keyDialog.getByTestId("connect-secret-value")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    await keyDialog.getByTestId("connect-secret-save").click();
    await expect(keyDialog).toContainText("Enter your key");
    await keyDialog.getByTestId("connect-secret-value").fill(KEY_CANARY);
    await noToasts(page);
    await bothThemes(page, `connections-key-dialog-${tag}`);
    await a11yBothThemes(page, '[data-testid="connect-secret-dialog"]');
    if (mobile) await expectTouchTargets(keyDialog.locator("form"), "the key dialog");
    await keyDialog.getByTestId("connect-secret-save").click();
    await expect(keyDialog).toBeHidden();
    await expect(page.getByTestId(`connector-status-${erp.id}`)).toHaveText("Connected");
    await expect(page.getByTestId(`connector-meta-${erp.id}`)).toHaveText(
      "Key set · since today · never used",
    );
    // Replace key: the field starts empty; the stored value is never fetched or shown.
    await secondary(page, erp.id, "replace", mobile);
    await expect(keyDialog).toContainText(`Replace your ${ERP} key`);
    await expect(keyDialog.getByTestId("connect-secret-value")).toHaveValue("");
    await expect(keyDialog.getByTestId("connect-secret-save")).toHaveText("Replace key");
    await page.keyboard.press("Escape");
    await expect(keyDialog).toBeHidden();
    expect(await page.content()).not.toContain(KEY_CANARY);

    // ---- disconnect asks first (focus on Cancel), then the row is Not connected again
    await secondary(page, erp.id, "disconnect", mobile);
    const disconnect = page.getByTestId("connections-disconnect-dialog");
    await expect(disconnect).toContainText(`Disconnect ${ERP}?`);
    await expect(disconnect).toContainText("Your key is deleted from this workspace.");
    await expect(disconnect.getByRole("button", { name: "Cancel" })).toBeFocused();
    await noToasts(page);
    await bothThemes(page, `connections-disconnect-${tag}`);
    await disconnect.getByTestId("connections-disconnect-confirm").click();
    await expect(disconnect).toBeHidden();
    await expect(page.getByTestId(`connector-status-${erp.id}`)).toHaveText("Not connected");

    // ---- the provider says no: one fixed sentence, Try again, and never the provider's own text
    await fakeScenario({ deny: true });
    await page.getByTestId(`connector-connect-${crm.id}`).click();
    const banner = page.getByTestId("connections-toast");
    await expect(page.getByTestId("connections-toast-text")).toHaveText(
      `You didn't allow access at ${CRM}.`,
      {
        timeout: 30_000,
      },
    );
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(banner.getByTestId("connections-try-again")).toBeVisible();
    expect(await page.content()).not.toContain("the user denied the request");
    await expect(page).not.toHaveURL(/error=/);
    await noToasts(page);
    await bothThemes(page, `connections-error-${tag}`);
    if (mobile) await expectTouchTargets(banner, "the error banner");
    await fakeScenario({});
    await page.goto(`${BASE_URL}/settings/connections?error=session_mismatch&connector=${crm.id}`);
    await expect(page.getByTestId("connections-toast-text")).toHaveText(
      "This sign-in was started from another account. Try again.",
    );

    // ---- revoked at the provider (R2): the token expires, the provider revokes every grant, a probe finds out
    await fakeScenario({ expires_in: 1 });
    await page.goto(`${BASE_URL}/settings/connections`);
    await connectInBrowser(page, crm.id, CRM);
    await fakeScenario({ revoke_all: true });
    await page.waitForTimeout(2_000);
    const probe = await admin.post(`/api/v1/connectors/${crm.id}/probe`);
    expect(probe.status(), "the probe finds the grant revoked").toBe(409);
    await fakeScenario({});
    await page.goto(`${BASE_URL}/settings/connections`);
    await expect(row(page, crm.id)).toHaveAttribute("data-status", "revoked");
    await expect(page.getByTestId(`connector-status-${crm.id}`)).toHaveText("Access revoked");
    await expect(page.getByTestId(`connector-meta-${crm.id}`)).toHaveText(
      `Access was revoked at ${CRM}. Reconnect to use it again.`,
    );
    await connectInBrowser(page, crm.id, CRM, `connector-reconnect-${crm.id}`);
    await expect(page.getByTestId(`connector-status-${crm.id}`)).toHaveText("Connected");

    // ---- an expired sign-in (routed reason): Needs reconnect with the spec's meta
    routeMode = "expired";
    await page.goto(`${BASE_URL}/settings/connections`);
    await expect(page.getByTestId(`connector-status-${crm.id}`)).toHaveText("Needs reconnect");
    await expect(page.getByTestId(`connector-meta-${crm.id}`)).toHaveText(
      "Your sign-in expired. Bots can't use it until you reconnect.",
    );
    await expect(page.getByTestId(`connector-reconnect-${crm.id}`)).toBeEnabled();

    // ---- no HTTPS: the notice, Connect disabled with the reason in the meta line; key rows still work
    routeMode = "https";
    await secondary(page, crm.id, "disconnect", mobile);
    await page.getByTestId("connections-disconnect-confirm").click();
    await page.goto(`${BASE_URL}/settings/connections`);
    const notice = page.getByTestId("connections-https-required");
    await expect(notice).toHaveText(
      "Signing in to connectors needs HTTPS on this workspace. Ask an admin to set it up. Key connectors still work.",
    );
    await expect(notice).toHaveAttribute("role", "note");
    await expect(page.getByTestId(`connector-connect-${crm.id}`)).toBeDisabled();
    await expect(page.getByTestId(`connector-meta-${crm.id}`)).toHaveText(
      "Sign-in needs HTTPS on this workspace.",
    );
    await expect(page.getByTestId(`connector-connect-${erp.id}`)).toBeEnabled();
    await noToasts(page);
    await bothThemes(page, `connections-https-required-${tag}`);

    // ---- every state at once, and the empty page
    routeMode = "every";
    await page.goto(`${BASE_URL}/settings/connections`);
    for (const [n, status] of [
      [1, "not_connected"],
      [2, "connected"],
      [3, "connected"],
      [4, "needs_reconnect"],
      [5, "revoked"],
      [6, "unavailable"],
    ] as const) {
      await expect(row(page, fixtureId(n))).toHaveAttribute("data-status", status);
    }
    await expect(page.getByTestId(`connector-meta-${fixtureId(2)}`)).toHaveText(
      /^as ana@acme\.com · since [A-Z][a-z]{2} \d{1,2} · last used 5 minutes ago$/,
    );
    await expect(page.getByTestId(`connector-meta-${fixtureId(6)}`)).toHaveText(
      "Not ready yet. An admin has to finish setting up Tickets.",
    );
    await expect(page.getByTestId(`connector-connect-${fixtureId(6)}`)).toBeDisabled();
    await expect(page.getByTestId("shares-list")).toContainText("Jira in #ops");
    await noToasts(page);
    await bothThemes(page, `connections-${tag}`);
    await a11yBothThemes(page, '[data-testid="connections-list"]');
    if (mobile) await expectTouchTargets(page.getByTestId("connections-list"), "the connections list");
    routeMode = "empty";
    await page.goto(`${BASE_URL}/settings/connections`);
    await expect(page.getByTestId("connections-empty")).toContainText("No accounts to connect yet");
    await expect(page.getByTestId("connections-empty")).toContainText("Add one in MCP servers");
    await noToasts(page);
    await bothThemes(page, `connections-empty-${tag}`);

    expect(await responses()).not.toContain(KEY_CANARY);
    await me.context.close();
  } finally {
    await removeServers(admin, [CRM, ERP]).catch(() => undefined);
    await admin.dispose();
  }
});

test("member: a card-started connect comes back to the chat; a return outside the app never shows the button", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const crm = await oauthConnector(admin, CRM);
  try {
    const dm = await admin.post("/api/v1/dms", { data: { participants: [{ kind: "user", id: samId }] } });
    expect(dm.ok(), "open a DM").toBe(true);
    const dmId = ((await dm.json()) as { id: string }).id;
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;

    // ---- the connect card's target (07.4-12, R8): the row is highlighted and its Connect has the focus
    await page.goto(
      `${BASE_URL}/settings/connections?connector=${crm.id}&return=${encodeURIComponent(`/chat/dm/${dmId}`)}`,
    );
    await expect(row(page, crm.id)).toHaveAttribute("data-highlighted", "true");
    await expect(page.getByTestId(`connector-connect-${crm.id}`)).toBeFocused();
    await page.getByTestId(`connector-connect-${crm.id}`).click();
    await expect(page.getByTestId("connections-toast-text")).toHaveText(
      `${CRM} connected. Ask your bot again.`,
      {
        timeout: 30_000,
      },
    );
    const back = page.getByTestId("connections-back-to-chat");
    await expect(back).toBeVisible();
    await noToasts(page);
    await bothThemes(page, `connections-connected-${tag}`);
    await a11yBothThemes(page, '[data-testid="connections-toast"]');
    if (mobile) await expectTouchTargets(page.getByTestId("connections-toast"), "the success banner");
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/chat/dm/${dmId}$`));

    // ---- a template's Connect link (07.4-08) lands on the row by its id, and the safe name works too
    await page.goto(`${BASE_URL}/settings/connections?connector=${crm.safeName}`);
    await expect(row(page, crm.id)).toHaveAttribute("data-highlighted", "true");
    await expect(
      page.getByTestId(`connector-disconnect-${crm.id}`).or(page.getByTestId(`connector-menu-${crm.id}`)),
    ).toBeFocused();

    // ---- an absolute URL is not an app route: after the round trip there is no Back to chat
    await secondary(page, crm.id, "disconnect", mobile);
    await page.getByTestId("connections-disconnect-confirm").click();
    await expect(page.getByTestId(`connector-status-${crm.id}`)).toHaveText("Not connected");
    await page.goto(
      `${BASE_URL}/settings/connections?connector=${crm.id}&return=${encodeURIComponent("https://evil.example/chat")}`,
    );
    await connectInBrowser(page, crm.id, CRM);
    await expect(page.getByTestId("connections-back-to-chat")).toHaveCount(0);
    await me.context.close();
  } finally {
    await removeServers(admin, [CRM]).catch(() => undefined);
    await admin.dispose();
  }
});

test("member: allow an account or a key in one conversation after seeing who reads it, list it, revoke it", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const crm = await oauthConnector(admin, CRM);
  const ops = "ops";
  const opsId = await ensureChannel(admin, ops, "private");
  const added = await admin.post(`/api/v1/channels/${opsId}/members`, { data: { kind: "user", id: samId } });
  expect(added.ok() || added.status() === 409, "Sam reads #ops").toBe(true);
  // #general is public: every member reads it, and anyone who joins later.
  const generalId = await ensureChannel(admin, "general", "public");
  const dm = await admin.post("/api/v1/dms", { data: { participants: [{ kind: "user", id: samId }] } });
  const dmId = ((await dm.json()) as { id: string }).id;
  const key = await admin.post("/api/v1/keychain", {
    data: {
      kind: "api_key",
      scope: "personal",
      name: "CRM",
      value: KEY_CANARY,
      allowedHosts: ["api.crm.example"],
    },
  });
  expect(key.ok(), `create a personal key: ${await key.text()}`).toBe(true);
  const keyId = ((await key.json()) as { id: string }).id;
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    const responses = captureResponses(page);
    const shareUrl = (conv: string, q: string) => `${BASE_URL}/settings/connections?share=${conv}&${q}`;

    // ---- not connected yet: connect first, and the dialog comes back after the round trip
    await page.goto(shareUrl(opsId, `connector=${crm.id}`));
    const dialog = page.getByTestId("shared-use-dialog");
    await expect(dialog).toContainText(`Connect ${CRM} first, then allow it here.`);
    await dialog.getByTestId("shared-use-connect").click();
    await expect(page.getByTestId("connections-toast-text")).toHaveText(
      `${CRM} connected. Ask your bot again.`,
      {
        timeout: 30_000,
      },
    );

    // ---- bounded: the reader count is in the dialog before Allow is enabled
    await expect(dialog).toContainText(`Use your ${CRM} account in #${ops}?`);
    await expect(dialog.getByTestId("shared-use-readers")).toHaveText("2 people can read results here");
    await expect(dialog.getByTestId("shared-use-unbounded")).toHaveCount(0);
    await expect(dialog.getByTestId("shared-use-confirm")).toBeEnabled();
    await expect(dialog.getByTestId("shared-use-confirm")).toHaveText(`Allow in #${ops}`);
    await noToasts(page);
    await bothThemes(page, `connections-share-${tag}`);
    await a11yBothThemes(page, '[data-testid="shared-use-dialog"]');
    if (mobile) await expectTouchTargets(dialog, "the shared-use dialog");
    await dialog.getByTestId("shared-use-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/share=/);
    const list = page.getByTestId("shares-list");
    await expect(list).toContainText(`${CRM} in #${ops}`);
    await expect(list).toContainText("2 people could read · allowed today");

    // ---- by safe name, in a DM (which the API leaves unnamed): the member's own label for it; Cancel records nothing
    await page.goto(shareUrl(dmId, `connector=${crm.safeName}`));
    await expect(dialog).toContainText(`Use your ${CRM} account in your DM with ${SAM.name}?`);
    await expect(dialog.getByTestId("shared-use-readers")).toHaveText("2 people can read results here");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/share=/);
    expect(
      ((await (await admin.get("/api/v1/member-account-shares")).json()) as { shares: unknown[] }).shares,
    ).toHaveLength(1);

    // ---- a public channel: everyone, and anyone added later
    await page.goto(shareUrl(generalId, `connector=${crm.id}`));
    await expect(dialog.getByTestId("shared-use-readers")).toHaveText(
      "Everyone in the organization can read results here",
    );
    await expect(dialog.getByTestId("shared-use-unbounded")).toHaveText(
      "Anyone added later will see new results too.",
    );
    await noToasts(page);
    await bothThemes(page, `connections-share-unbounded-${tag}`);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // ---- a personal key in the DM: the key variant; the share row names the DM
    await page.goto(shareUrl(dmId, `key=${keyId}`));
    await expect(dialog).toContainText(`Use your CRM key in your DM with ${SAM.name}?`);
    await dialog.getByTestId("shared-use-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(list).toContainText(`CRM in your DM with ${SAM.name}`);
    await expect(list).not.toContainText("a conversation you can no longer open");

    // ---- already allowed: no dialog, the row is highlighted
    await page.goto(shareUrl(opsId, `connector=${crm.id}`));
    await expect(page.getByTestId("connections-toast-text")).toHaveText(
      `${CRM} is already allowed in #${ops}.`,
    );
    await expect(dialog).toHaveCount(0);

    // ---- a conversation the member cannot read: no dialog, the fixed sentence
    await page.goto(shareUrl("00000000-0000-4000-8000-00000000abcd", `connector=${crm.id}`));
    await expect(page.getByTestId("connections-toast-text")).toHaveText(
      "That conversation isn't available to you.",
    );
    await expect(dialog).toHaveCount(0);

    // ---- disconnect lists where the account stops being used; revoke is immediate
    await secondary(page, crm.id, "disconnect", mobile);
    await expect(page.getByTestId("connections-disconnect-shares")).toHaveText(
      `It stops being used in #${ops}.`,
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    const shares = (await (await admin.get("/api/v1/member-account-shares")).json()) as {
      shares: Array<{ id: string; resourceName: string }>;
    };
    const crmShare = shares.shares.find((s) => s.resourceName === CRM);
    expect(crmShare).toBeTruthy();
    if (mobile) await expectTouchTargets(list, "the shares list");
    await page.getByTestId(`share-revoke-${crmShare?.id}`).click();
    await expect(page.getByTestId(`share-row-${crmShare?.id}`)).toHaveCount(0);
    await expect(page.getByText(`${CRM} is no longer used in #${ops}.`)).toBeVisible();

    expect(await responses()).not.toContain(KEY_CANARY);
    expect(await page.content()).not.toContain(KEY_CANARY);
    await me.context.close();
  } finally {
    await admin.delete(`/api/v1/keychain/${keyId}`).catch(() => undefined);
    await removeServers(admin, [CRM]).catch(() => undefined);
    await admin.dispose();
  }
});

test("desktop app: Connect opens the web page in the system browser, which starts the sign-in once", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const admin = await apiAs(ADMIN);
  const crm = await oauthConnector(admin, CRM);
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    await page.addInitScript(() => {
      (window as unknown as { ocwDesktop: unknown }).ocwDesktop = {
        isDesktop: true,
        platform: "darwin",
        status: async () => ({
          state: "online",
          label: "Online",
          paired: true,
          deviceName: "Mac",
          projects: 0,
        }),
        addProject: async () => ({ ok: false, canceled: true }),
        listProjects: async () => [],
        onStatus: () => () => undefined,
      };
    });
    await page.goto(`${BASE_URL}/settings/connections`);
    const link = page.getByTestId(`connector-connect-${crm.id}`);
    await expect(link).toHaveText("Connect in browser");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("href", `${BASE_URL}/settings/connections?connect=${crm.id}`);
    await expect(page.getByTestId(`connector-desktop-hint-${crm.id}`)).toHaveText(
      "Opens your browser, where you're signed in to OCW.",
    );

    // The system browser (no desktop bridge) opens the link: the flow starts once and comes back Connected.
    const web = await me.context.browser()?.newContext();
    expect(web).toBeTruthy();
    await web?.addCookies(await me.context.cookies());
    const tab = await web?.newPage();
    if (!tab) throw new Error("no page");
    await tab.goto(`${BASE_URL}/settings/connections?connect=${crm.id}`);
    await expect(tab.getByTestId("connections-toast-text")).toHaveText(
      `${CRM} connected. Ask your bot again.`,
      {
        timeout: 30_000,
      },
    );
    await expect(tab).not.toHaveURL(/connect=/);
    await tab.reload();
    await expect(tab.getByTestId("connections-toast")).toHaveCount(0);
    await expect(tab.getByTestId(`connector-status-${crm.id}`)).toHaveText("Connected");
    await web?.close();
    await me.context.close();
  } finally {
    await removeServers(admin, [CRM]).catch(() => undefined);
    await admin.dispose();
  }
});

test("admin: Re-probe a per-member connector with your own connection, or be sent to Connections first", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const admin = await apiAs(ADMIN);
  const crm = await oauthConnector(admin, CRM);
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    await page.goto(`${BASE_URL}/settings/mcp-servers`);
    const card = page.locator(`[data-testid="mcp-server"][data-name="${CRM}"]`);
    const reprobe = card.getByTestId("mcp-reprobe");
    await expect(reprobe).toBeVisible();
    const probes: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/probe")) probes.push(new URL(r.url()).pathname);
    });
    await reprobe.click();
    await expect(page.getByText(`Connect your own ${CRM} account first`)).toBeVisible();
    expect(probes).toEqual([`/api/v1/connectors/${crm.id}/probe`]);
    await page.getByRole("button", { name: "Open Connections" }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/connections\\?connector=${crm.id}$`));
    await expect(row(page, crm.id)).toHaveAttribute("data-highlighted", "true");
    await connectInBrowser(page, crm.id, CRM);

    // With the admin's own connection the probe lists the tools again.
    await page.goto(`${BASE_URL}/settings/mcp-servers`);
    await card.getByTestId("mcp-reprobe").click();
    await expect(card.getByTestId("mcp-status")).toHaveText("Ready");
    await expect(card.locator('[data-testid="mcp-tool"][data-tool="whoami"]')).toBeVisible();
    expect(probes.at(-1)).toBe(`/api/v1/connectors/${crm.id}/probe`);
    await me.context.close();
  } finally {
    await removeServers(admin, [CRM]).catch(() => undefined);
    await admin.dispose();
  }
});
