import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import { ADMIN, shot } from "./env";

/**
 * CHAT-02 (D-08): the chat sidebar grouped by department and team. Channels belong to the organization or to a unit
 * (chosen on create, moved later by the owner or an admin); one collapsible section per department, the member's own
 * first, team channels nested with a sub-label; collapse state survives reloads. Then the views.
 */

type Unit = { id: string; name: string; parentId: string | null };

/** Get-or-create a unit (sibling names are unique, and both projects share one stack). */
async function ensureUnit(
  admin: APIRequestContext,
  kind: "department" | "team",
  name: string,
  parentId: string | null,
): Promise<string> {
  const { units } = (await (await admin.get("/api/v1/units")).json()) as { units: Unit[] };
  const found = units.find((u) => u.name === name && u.parentId === parentId);
  if (found) return found.id;
  const res = await admin.post("/api/v1/units", { data: { kind, name, parentId } });
  expect(res.ok(), `create ${kind} ${name}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function addToUnit(admin: APIRequestContext, unitId: string, userId: string) {
  const res = await admin.post(`/api/v1/units/${unitId}/members`, { data: { userId, role: "member" } });
  // 409: already a member (both projects share one stack).
  expect(res.ok() || res.status() === 409, `add ${userId} to ${unitId}: ${res.status()}`).toBe(true);
}

async function channelIn(
  api: APIRequestContext,
  name: string,
  unitId: string | null,
  joiners: APIRequestContext[] = [],
): Promise<string> {
  const res = await api.post("/api/v1/channels", { data: { name, visibility: "public", unitId } });
  expect(res.ok(), `create #${name}`).toBe(true);
  const id = ((await res.json()) as { id: string }).id;
  for (const j of joiners) expect((await j.post(`/api/v1/channels/${id}/join`)).ok()).toBe(true);
  return id;
}

/** The sidebar: a column on desktop, the navigation drawer on phones. */
async function openSidebar(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const list = page.getByTestId("channel-list").filter({ visible: true }).first();
  await expect(list).toBeVisible();
  return list;
}

const section = (scope: Page | Locator, unitId: string) =>
  scope.locator(`[data-testid="sidebar-section"][data-unit-id="${unitId}"]`).first();
const channelLink = (scope: Page | Locator, name: string) =>
  scope.locator(`[data-testid="channel-link"][data-channel-name="${name}"]`).first();

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe.configure({ mode: "serial" });

test("channels are grouped by department; a new Product channel reaches Product members live; collapse persists", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const tag = `${project}-${Date.now().toString(36)}`;

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const samApi = await apiAs(SAM);
  const product = await ensureUnit(admin, "department", "Product", null);
  const mobileTeam = await ensureUnit(admin, "team", "Mobile", product);
  const finance = await ensureUnit(admin, "department", "Finance", null);
  await addToUnit(admin, product, samId);

  const mobileDev = `mobile-dev-${tag}`;
  const budget = `budget-${tag}`;
  await channelIn(admin, mobileDev, mobileTeam, [samApi]);
  await channelIn(admin, budget, finance, [samApi]);

  // ---- Sam's sidebar: Organization (#general), Product (#mobile-dev with a "Mobile" sub-label), Finance
  const sam = await openAs(browser, SAM, project);
  let list = await openSidebar(sam.page, mobile);
  await expect(section(list, product)).toBeVisible();
  const order = await list
    .locator('[data-testid="sidebar-section"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-unit-id")));
  expect(order.filter((id) => id === "org" || id === product || id === finance)).toEqual([
    "org",
    product,
    finance,
  ]);
  await expect(channelLink(section(list, "org"), "general")).toBeVisible();
  const dev = channelLink(section(list, product), mobileDev);
  await expect(dev).toBeVisible();
  await expect(dev.getByTestId("channel-sublabel")).toHaveText("Mobile");
  await expect(channelLink(section(list, finance), budget)).toBeVisible();
  await bothThemes(sam.page, `sidebar-grouped-${size}`);

  // ---- the admin creates #design in Product through the dialog's "Belongs to"
  const design = `design-${tag}`;
  const a = await openAs(browser, ADMIN, project);
  if (mobile) await a.page.getByTestId("mobile-nav-trigger").click();
  await a.page.getByTestId("create-channel").filter({ visible: true }).first().click();
  const dialog = a.page.getByTestId("create-channel-dialog");
  await dialog.getByLabel("Name").fill(design);
  await dialog.getByTestId("channel-unit-select").click();
  await a.page.getByRole("option", { name: "Product", exact: true }).click();
  await expect(dialog.getByTestId("channel-unit-select")).toHaveText(/^Product$/);
  await bothThemes(a.page, `channel-create-unit-${size}`);
  await dialog.getByTestId("create-channel-submit").click();
  await expect(a.page.getByTestId("channel-title")).toHaveText(design);

  // ---- Sam's Product section shows it within 5 s, without reloading (a suggestion until he joins)
  const live = channelLink(section(list, product), design);
  await expect(live).toBeVisible({ timeout: 5_000 });
  await expect(live).toHaveAttribute("data-joined", "false");

  // ---- collapsing Finance survives a reload
  await section(list, finance).getByTestId("section-toggle").click();
  await expect(section(list, finance)).toHaveAttribute("data-collapsed", "true");
  await expect(channelLink(section(list, finance), budget)).toHaveCount(0);
  await sam.page.reload();
  list = await openSidebar(sam.page, mobile);
  await expect(section(list, finance)).toHaveAttribute("data-collapsed", "true");
  await expect(channelLink(section(list, finance), budget)).toHaveCount(0);
  // The other project's Finance channel is there too (one shared stack).
  await expect(section(list, finance).getByTestId("section-count")).toHaveText(/^[1-9]\d*$/);
  // Expand again so later runs (and screenshots) start from the default state.
  await section(list, finance).getByTestId("section-toggle").click();
  await expect(channelLink(section(list, finance), budget)).toBeVisible();

  await a.context.close();
  await sam.context.close();
  await samApi.dispose();
  await admin.dispose();
});
