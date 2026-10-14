import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import { freshPersonalBot } from "../support/bot-tools";
import { bothThemes } from "../support/files";
import { ADMIN, shot } from "./env";

/**
 * Settings › Keychain (07.4-13; D-04, CONN-05, SC3; 07.4-UI-SPEC § 3, R3) and the organization's private network hosts
 * on Settings › MCP servers (§ 1, R5). A key's value is write-only: after saving, the page and every API response the
 * browser receives never contain it; rows say `Value set · updated {date}` and editing only offers to replace it.
 */

test.describe.configure({ mode: "serial" });

/** A unit lead used by no other spec (the isolated database is shared by every spec of a run). */
const LEAD: Actor = { name: "Noa Vidal", email: "noa.keys@ocw.test", password: "noa-e2e-password-1234" };
const CANARY = `e2e-vault-canary-${Date.now().toString(36)}`;

interface Unit {
  id: string;
  name: string;
  parentId: string | null;
}

async function ensureUnit(admin: APIRequestContext, kind: string, name: string, parentId: string | null) {
  const list = (await (await admin.get("/api/v1/units")).json()) as { units: Unit[] };
  const found = list.units.find((u) => u.name === name && u.parentId === parentId);
  if (found) return found.id;
  const res = await admin.post("/api/v1/units", { data: { kind, name, parentId } });
  expect(res.ok(), `create unit ${name}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function ensureUnitMember(admin: APIRequestContext, unitId: string, userId: string, role = "member") {
  const res = await admin.post(`/api/v1/units/${unitId}/members`, { data: { userId, role } });
  expect(res.ok() || res.status() === 409, `unit membership ${userId}`).toBe(true);
}

interface ItemJson {
  id: string;
  name: string;
  scope: string;
  valueUpdatedAt: string;
  allowedHosts: string[];
}

/** Deletes every key `api` can see (personal and unit), so each test starts from its own state. */
async function clearKeys(api: APIRequestContext) {
  const list = (await (await api.get("/api/v1/keychain")).json()) as {
    personal: ItemJson[];
    unit: ItemJson[];
  };
  for (const i of [...list.personal, ...list.unit]) {
    expect((await api.delete(`/api/v1/keychain/${i.id}`)).ok()).toBe(true);
  }
}

async function itemNamed(api: APIRequestContext, name: string): Promise<ItemJson> {
  const list = (await (await api.get("/api/v1/keychain")).json()) as {
    personal: ItemJson[];
    unit: ItemJson[];
  };
  const found = [...list.personal, ...list.unit].find((i) => i.name === name);
  expect(found, name).toBeTruthy();
  return found as ItemJson;
}

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
        // Not a touch target: a select's native input that Base UI keeps visually hidden for forms.
        if (el.closest('[aria-hidden="true"]')) continue;
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

/** Toasts fade out on their own; screenshots wait for them so nothing covers the screen under review. */
async function noToasts(page: Page) {
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

function captureResponses(page: Page): () => Promise<string> {
  const bodies: Array<Promise<string>> = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/v1/")) bodies.push(r.text().catch(() => ""));
  });
  return async () => (await Promise.all(bodies)).join("\n");
}

async function addHost(dialog: Locator, host: string) {
  await dialog.getByTestId("vault-host-input").fill(host);
  await dialog.getByTestId("vault-host-input").press("Enter");
}

async function openMenu(
  page: Page,
  row: Locator,
  item: "vault-edit" | "vault-replace-value" | "vault-delete",
) {
  await row.getByRole("button", { name: /actions$/ }).click();
  await page.getByTestId(item).click();
}

test("member: personal keys are write-only, sent only to their hosts, given to bots, edited and deleted", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const adminId = await userIdOf(admin);
  await clearKeys(admin);
  const bot = await freshPersonalBot(ADMIN, adminId);
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    const responses = captureResponses(page);
    await page.goto(`${BASE_URL}/settings/keychain`);
    if (!mobile)
      await expect(page.getByTestId("settings-nav-keychain")).toHaveAttribute("aria-current", "page");
    // The private-host list is not here (R5): it is an organization policy on Settings › MCP servers.
    await expect(page.getByTestId("mcp-private-hosts")).toHaveCount(0);

    // ---- empty
    await expect(page.getByTestId("keychain-empty")).toContainText("No keys yet");
    await noToasts(page);
    await bothThemes(page, `keychain-empty-${tag}`);

    // ---- add an API key: write-only value, a host, a bot
    await page.getByTestId("keychain-empty-add").click();
    const dialog = page.getByTestId("vault-item-dialog");
    await expect(dialog).toContainText("Add a key");
    await expect(dialog.getByTestId("vault-kind-api_key").locator("input")).toBeChecked();
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toContainText("Give the key a name");
    await expect(dialog).toContainText("Add at least one host");
    await dialog.getByTestId("vault-name").fill("CRM");
    await expect(dialog.getByTestId("vault-value")).toHaveAttribute("type", "password");
    await dialog.getByTestId("vault-value").fill(CANARY);
    // A private literal is refused for a personal key and blocks save.
    await addHost(dialog, "10.0.0.5");
    await expect(dialog.getByTestId("vault-hosts-error")).toHaveText(
      "Private network addresses aren't allowed for personal keys",
    );
    await expect(dialog.getByTestId("vault-host-chip")).toHaveCount(0);
    await addHost(dialog, "API.CRM.example");
    await expect(
      dialog.locator('[data-testid="vault-host-chip"][data-host="api.crm.example"]'),
    ).toBeVisible();
    await dialog.getByTestId(`vault-agent-${bot.id}`).check();
    await expect(dialog.getByTestId("vault-agents")).toContainText("your personal bot");
    await dialog.getByTestId("vault-advanced").click();
    await expect(dialog.getByTestId("vault-header")).toHaveValue("Authorization");
    await noToasts(page);
    await bothThemes(page, `keychain-dialog-${tag}`);
    await a11yBothThemes(page, '[data-testid="vault-item-dialog"]');
    if (mobile) {
      await expectTouchTargets(dialog.locator("form"), "the key dialog");
      // Full screen at 390 with the footer reachable.
      const box = await dialog.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(840);
      await expect(dialog.getByTestId("vault-save")).toBeInViewport();
    }
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toBeHidden();

    const crm = await itemNamed(admin, "CRM");
    const row = page.getByTestId(`vault-row-${crm.id}`);
    await expect(row).toContainText("CRM");
    await expect(row.getByTestId("vault-kind-label")).toHaveText("API key");
    await expect(row.getByTestId("vault-handle")).toHaveText(/^k_[a-z2-7]{10}$/);
    await expect(row.getByRole("button", { name: /^Copy handle k_/ })).toBeVisible();
    await expect(row.getByRole("list", { name: "Allowed hosts" })).toContainText("api.crm.example");
    await expect(row.getByTestId("vault-value-state")).toHaveText("Value set · updated today");
    await expect(row.getByTestId("vault-bots")).toHaveText("1 bot");
    await expect(row.getByTestId("vault-last-used")).toHaveText("never used");
    expect(await page.content()).not.toContain(CANARY);
    await a11yBothThemes(page, '[data-testid="keychain-personal"]');
    if (mobile) await expectTouchTargets(page.getByTestId("keychain-personal"), "the key list");

    // ---- edit: the locked value line; a host-only edit keeps valueUpdatedAt, Replace value moves it (R3)
    await openMenu(page, row, "vault-edit");
    await expect(dialog).toContainText("Edit CRM");
    await expect(dialog.getByTestId("vault-value-state")).toHaveText("Value set · updated today");
    await expect(dialog.getByTestId("vault-value")).toHaveCount(0);
    await expect(dialog.getByTestId("vault-kind-basic").locator("input")).toBeDisabled();
    await expect(dialog.getByTestId("vault-save")).toBeDisabled();
    await noToasts(page);
    await bothThemes(page, `keychain-dialog-edit-${tag}`);
    await a11yBothThemes(page, '[data-testid="vault-item-dialog"]');
    await addHost(dialog, "*.crm.example");
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toBeHidden();
    const afterHosts = await itemNamed(admin, "CRM");
    expect(afterHosts.allowedHosts).toEqual(["api.crm.example", "*.crm.example"]);
    expect(afterHosts.valueUpdatedAt).toBe(crm.valueUpdatedAt);

    await openMenu(page, row, "vault-replace-value");
    await expect(dialog.getByTestId("vault-value")).toHaveValue("");
    await expect(dialog).toContainText("New API key");
    await dialog.getByTestId("vault-value").fill(`${CANARY}-2`);
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toBeHidden();
    const afterReplace = await itemNamed(admin, "CRM");
    expect(Date.parse(afterReplace.valueUpdatedAt)).toBeGreaterThan(Date.parse(crm.valueUpdatedAt));

    // ---- Username & password and OAuth client keys save (the OAuth token URL is never contacted here)
    await page.getByTestId("keychain-add").click();
    await dialog.getByTestId("vault-kind-basic").click();
    await dialog.getByTestId("vault-name").fill("Billing");
    await dialog.getByTestId("vault-username").fill("billing-user");
    await dialog.getByTestId("vault-password").fill(`${CANARY}-pw`);
    await addHost(dialog, "billing.example.com:8443");
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toBeHidden();

    await page.getByTestId("keychain-add").click();
    await dialog.getByTestId("vault-kind-oauth").click();
    await dialog.getByTestId("vault-name").fill("Ledger API");
    await expect(dialog).toContainText("Its host must be one of the allowed hosts.");
    await dialog.getByTestId("vault-client-id").fill("ledger-client");
    await dialog.getByTestId("vault-client-secret").fill(`${CANARY}-cs`);
    await dialog.getByTestId("vault-oauth-scope").fill("ledger.read");
    await dialog.getByTestId("vault-token-url").fill("http://auth.ledger.example/token");
    await addHost(dialog, "api.ledger.example");
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toContainText("The token URL must use HTTPS");
    await dialog.getByTestId("vault-token-url").fill("https://auth.ledger.example/token");
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toContainText("The token URL's host must be one of the allowed hosts");
    await addHost(dialog, "auth.ledger.example");
    await noToasts(page);
    await bothThemes(page, `keychain-dialog-oauth-${tag}`);
    await a11yBothThemes(page, '[data-testid="vault-item-dialog"]');
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toBeHidden();
    const ledger = (await (
      await admin.get(`/api/v1/keychain/${(await itemNamed(admin, "Ledger API")).id}`)
    ).json()) as {
      scope: string;
      kind: string;
      tokenUrl: string;
    };
    expect(ledger).toMatchObject({
      scope: "personal",
      kind: "oauth",
      tokenUrl: "https://auth.ledger.example/token",
    });
    await expect(page.getByTestId("keychain-personal").locator("li[data-testid^='vault-row-']")).toHaveCount(
      3,
    );

    // ---- delete asks first
    await openMenu(page, row, "vault-delete");
    const del = page.getByTestId("vault-delete-dialog");
    await expect(del).toContainText("Delete “CRM”?");
    await expect(del.getByRole("button", { name: "Cancel" })).toBeFocused();
    await del.getByTestId("vault-delete-confirm").click();
    await expect(row).toHaveCount(0);

    const seen = await responses();
    expect(seen).not.toContain(CANARY);
    expect(await page.content()).not.toContain(CANARY);
    await me.context.close();
  } finally {
    await clearKeys(admin).catch(() => undefined);
    await admin.dispose();
  }
});

test("lead: unit keys for the units you lead, with the private-network hint; a member without a unit sees none", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const leadId = await ensureMember(admin, LEAD, "lead");
  await ensureMember(admin, SAM, "developer");
  const eng = await ensureUnit(admin, "department", "Engineering", null);
  const backend = await ensureUnit(admin, "team", "Backend", eng);
  await ensureUnitMember(admin, backend, leadId, "lead");
  const lead = await apiAs(LEAD);
  await clearKeys(lead);
  try {
    // A personal key so the page shows both sections.
    const personal = await lead.post("/api/v1/keychain", {
      data: {
        kind: "api_key",
        scope: "personal",
        name: "My CRM",
        value: CANARY,
        allowedHosts: ["api.crm.example"],
      },
    });
    expect(personal.ok()).toBe(true);

    const l = await openAs(browser, LEAD, info.project.name);
    const page = l.page;
    await page.goto(`${BASE_URL}/settings/keychain`);
    const unitSection = page.getByTestId("keychain-unit-section");
    await expect(unitSection).toContainText("Unit keys");
    await expect(unitSection).toContainText("Only leads and admins of Backend manage them.");
    await expect(page.getByTestId("keychain-unit-select")).toContainText("Backend");
    await page.getByTestId("keychain-unit-select").click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Escape");

    await page.getByTestId("keychain-unit-add").click();
    const dialog = page.getByTestId("vault-item-dialog");
    await expect(dialog).toContainText("Add a unit key");
    await expect(dialog.getByTestId("vault-unit")).toContainText("Backend");
    await dialog.getByTestId("vault-name").fill("ERP service");
    await dialog.getByTestId("vault-value").fill(`${CANARY}-unit`);
    await addHost(dialog, "erp.lan:8443");
    await expect(dialog.getByTestId("vault-private-hint")).toHaveText(
      "erp.lan:8443 is on a private network. It works only if an admin lists it in Private network hosts.",
    );
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toBeHidden();
    const unitKey = page.getByTestId("keychain-unit");
    await expect(unitKey).toContainText("ERP service");
    await expect(unitKey).toContainText("Private network");
    await noToasts(page);
    await bothThemes(page, `keychain-${tag}`);
    if (mobile) {
      await expectTouchTargets(unitSection, "the unit keys section");
      await expectTouchTargets(page.getByTestId("keychain-personal"), "the personal keys");
    }
    await l.context.close();

    // ---- Sam leads nothing: no Unit keys section
    const s = await openAs(browser, SAM, info.project.name);
    await s.page.goto(`${BASE_URL}/settings/keychain`);
    await expect(s.page.getByRole("heading", { name: "Your keys" })).toBeVisible();
    await expect(s.page.getByTestId("keychain-unit-section")).toHaveCount(0);
    await s.context.close();
  } finally {
    await clearKeys(lead).catch(() => undefined);
    await lead.dispose();
    await admin.dispose();
  }
});

test("admin: private network hosts live on Settings › MCP servers; members never see them", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  expect(
    (await admin.put("/api/v1/keychain/private-hosts", { data: { hosts: ["crm.internal"] } })).ok(),
  ).toBe(true);
  try {
    const me = await openAs(browser, ADMIN, info.project.name);
    const page = me.page;
    await page.goto(`${BASE_URL}/settings/mcp-servers`);
    const card = page.getByTestId("mcp-private-hosts");
    await expect(card).toContainText("Private network hosts");
    await expect(card).toContainText("OCW's own services are always refused, even if listed.");
    await expect(card.locator('[data-testid="private-host-chip"][data-host="crm.internal"]')).toBeVisible();
    await expect(card.getByTestId("private-hosts-save")).toBeDisabled();
    // Enter adds the chip; an invalid entry keeps its text and says why.
    await card.getByTestId("private-hosts-input").fill("erp.lan:8443");
    await card.getByTestId("private-hosts-input").press("Enter");
    await expect(card.locator('[data-testid="private-host-chip"][data-host="erp.lan:8443"]')).toBeVisible();
    await card.getByTestId("private-hosts-input").fill("http://bad host/");
    await card.getByTestId("private-hosts-add").click();
    await expect(card).toContainText("Use a host name or IP with an optional port, like erp.lan:8443");
    await expect(card.getByTestId("private-hosts-input")).toHaveValue("http://bad host/");
    await card.getByTestId("private-hosts-input").fill("crm.internal");
    await card.getByTestId("private-hosts-add").click();
    await expect(card).toContainText("Already listed");
    await card.getByTestId("private-hosts-input").fill("");
    await card.scrollIntoViewIfNeeded();
    await noToasts(page);
    await bothThemes(page, `mcp-private-hosts-${tag}`);
    await a11yBothThemes(page, '[data-testid="mcp-private-hosts"]');
    if (mobile) await expectTouchTargets(card, "the private hosts section");
    await card.getByTestId("private-hosts-save").click();
    await expect(page.getByText("Private network hosts saved")).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByTestId("mcp-private-hosts")
        .locator('[data-testid="private-host-chip"][data-host="erp.lan:8443"]'),
    ).toBeVisible();
    expect(
      ((await (await admin.get("/api/v1/keychain/private-hosts")).json()) as { hosts: string[] }).hosts,
    ).toEqual(["crm.internal", "erp.lan:8443"]);
    await me.context.close();

    const s = await openAs(browser, SAM, info.project.name);
    await s.page.goto(`${BASE_URL}/settings/mcp-servers`);
    await expect(s.page.getByTestId("mcp-admin-only")).toBeVisible();
    await expect(s.page.getByTestId("mcp-private-hosts")).toHaveCount(0);
    await s.context.close();
  } finally {
    await admin.put("/api/v1/keychain/private-hosts", { data: { hosts: [] } }).catch(() => undefined);
    await admin.dispose();
  }
});

/** A member used by no other spec: Bots is turned off for them alone. */
const KEEPER: Actor = { name: "Ines Mora", email: "ines.keys@ocw.test", password: "ines-e2e-password-1234" };

test("member with Bots off: Keychain stays in Settings while they have keys, so they find and delete them (07.4 verification)", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const keeperId = await ensureMember(admin, KEEPER, "standard");
  const bots = (enabled: boolean) =>
    admin.put("/api/v1/module-access", {
      data: { module: "bots", scopeUnitId: null, subject: { kind: "user", userId: keeperId }, enabled },
    });
  const keeper = await apiAs(KEEPER);
  try {
    expect((await bots(true)).ok(), "Bots on").toBe(true);
    await clearKeys(keeper);
    const created = await keeper.post("/api/v1/keychain", {
      data: {
        scope: "personal",
        kind: "api_key",
        name: "Old CRM key",
        value: CANARY,
        allowedHosts: ["api.crm.example"],
      },
    });
    expect(created.ok(), "create a personal key").toBe(true);
    const key = (await created.json()) as ItemJson;
    expect((await bots(false)).ok(), "Bots off for the member").toBe(true);

    const s = await openAs(browser, KEEPER, info.project.name);
    const page = s.page;
    // Desktop: the settings column; phone: the same sections inside the navigation drawer.
    const nav = mobile
      ? page.getByRole("dialog", { name: "Navigation" })
      : page.getByTestId("section-sidebar");
    const openNav = async () => {
      await page.goto(`${BASE_URL}/settings/profile`);
      if (mobile) await page.getByTestId("mobile-nav-trigger").click();
      await expect(nav.getByTestId("settings-nav-profile")).toBeVisible();
    };
    await openNav();
    await expect(nav.getByTestId("settings-nav-notifications")).toBeVisible();
    await noToasts(page);
    await page.waitForLoadState("networkidle");
    await shot(page, `keychain-nav-bots-off-${tag}`);
    const entry = nav.getByTestId("settings-nav-keychain");
    await expect(entry).toBeVisible();
    // Connections has nothing of theirs to withdraw, so it stays out (#196 rule, unchanged).
    await expect(nav.getByTestId("settings-nav-connections")).toHaveCount(0);

    await entry.click();
    await expect(page).toHaveURL(/\/settings\/keychain$/);
    const row = page.getByTestId(`vault-row-${key.id}`);
    await expect(row).toBeVisible();
    await openMenu(page, row, "vault-delete");
    await page.getByTestId("vault-delete-dialog").getByTestId("vault-delete-confirm").click();
    await expect(row).toHaveCount(0);
    expect((await (await keeper.get("/api/v1/keychain")).json()).personal).toEqual([]);

    // Nothing left to manage: the entry leaves, like every other Bots entry.
    await openNav();
    await expect(nav.getByTestId("settings-nav-keychain")).toHaveCount(0);
    await s.context.close();
  } finally {
    await bots(true).catch(() => undefined);
    await clearKeys(keeper).catch(() => undefined);
    await keeper.dispose();
    await admin.dispose();
  }
});
