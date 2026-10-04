import { type APIRequestContext, type Browser, expect, type Page, request, test } from "@playwright/test";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Settings › Organization (ORG-04, ORG-01, ORG-02): an admin builds Department → Team → Project from the empty
 * state, rearranges and staffs it; a Developer browses read-only; a Team Lead staffs only their own subtree.
 * The spec owns the hierarchy of the e2e database: it starts from an empty tree in each project.
 */

const BASE_URL = process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000";
type User = { name: string; email: string; password: string; role: "developer" | "lead" };
/** Same account as chat.spec.ts (whichever spec runs first creates it). */
const ALEX: User = {
  name: "Alex Kim",
  email: "alex@ocw.test",
  password: "alex-e2e-password-123",
  role: "developer",
};
const LENA: User = {
  name: "Lena Ortiz",
  email: "lena@ocw.test",
  password: "lena-e2e-password-123",
  role: "lead",
};

async function apiAs(user: { email: string; password: string }): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await ctx.post("/api/auth/sign-in/email", {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok(), `sign in ${user.email}`).toBe(true);
  return ctx;
}

/** Invite + accept through the API when the account does not exist yet. */
async function ensureUser(admin: APIRequestContext, user: User) {
  const members = (await (await admin.get("/api/v1/members")).json()).members as Array<{ email: string }>;
  if (members.some((m) => m.email === user.email)) return;
  const inv = await (
    await admin.post("/api/v1/invitations", { data: { email: user.email, role: user.role } })
  ).json();
  const anon = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await anon.post(`/api/v1/invitations/${inv.id}/accept`, {
    data: { name: user.name, password: user.password },
  });
  expect(res.ok(), `accept invitation for ${user.email}`).toBe(true);
  await anon.dispose();
}

type ApiUnit = { id: string; name: string; kind: string; path: string[]; parentId: string | null };

async function listUnits(api: APIRequestContext): Promise<ApiUnit[]> {
  return (await (await api.get("/api/v1/units")).json()).units as ApiUnit[];
}

async function unitByName(api: APIRequestContext, name: string): Promise<ApiUnit> {
  const unit = (await listUnits(api)).find((u) => u.name === name);
  expect(unit, `unit ${name}`).toBeTruthy();
  return unit as ApiUnit;
}

/** Deepest first, so no delete hits unit_has_children. */
async function clearUnits(admin: APIRequestContext) {
  const units = (await listUnits(admin)).sort((a, b) => b.path.length - a.path.length);
  for (const u of units) expect((await admin.delete(`/api/v1/units/${u.id}`)).ok()).toBe(true);
}

async function signIn(browser: Browser, user: { email: string; password: string }, project: string) {
  const mobile = project === "mobile";
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page).toHaveURL(/\/chat/);
  return page;
}

/** Through the settings navigation (the drawer on phones). */
async function openOrganization(page: Page, mobile: boolean) {
  await page.goto(`${BASE_URL}/settings`);
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  await page.getByTestId("settings-nav-organization").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/settings\/organization/);
}

const row = (page: Page, name: string) => page.locator(`[data-testid="unit-row"][aria-label^="${name},"]`);

async function rowMenu(page: Page, name: string, item: string | RegExp) {
  await row(page, name).getByTestId("unit-menu").click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function submitUnitDialog(page: Page, name: string) {
  const dialog = page.getByTestId("unit-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByTestId("unit-dialog-submit").click();
}

async function createUnit(page: Page, name: string) {
  await submitUnitDialog(page, name);
  await expect(page.getByTestId("unit-dialog")).toBeHidden();
  await expect(row(page, name)).toBeVisible();
}

test.describe.configure({ mode: "serial" });

const names = (project: string) => {
  const sfx = `${project === "mobile" ? "m" : "d"}${Date.now().toString(36).slice(-4)}`;
  return {
    it: `IT ${sfx}`,
    backend: `Backend ${sfx}`,
    alpha: `Alpha ${sfx}`,
    marketing: `Marketing ${sfx}`,
    platform: `Platform ${sfx}`,
  };
};
let N: ReturnType<typeof names>;

test("admin builds Department → Team → Project from the empty state; a Developer browses read-only", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  N = names(project);
  const admin = await apiAs(ADMIN);
  await ensureUser(admin, ALEX);
  await ensureUser(admin, LENA);
  await clearUnits(admin);

  const page = await signIn(browser, ADMIN, project);
  await openOrganization(page, mobile);
  await expect(page.getByText("Mirror how your company is organised")).toBeVisible();
  await expect(page.getByTestId("new-department").filter({ visible: true })).toBeInViewport();
  await shot(page, `org-empty-${project}`);

  // Department, then a team inside it, then a project inside the team.
  await page.getByTestId("new-department").filter({ visible: true }).first().click();
  await createUnit(page, N.it);
  await rowMenu(page, N.it, "Add team");
  await createUnit(page, N.backend);
  await rowMenu(page, N.backend, "Add project");
  await createUnit(page, N.alpha);

  await expect(row(page, N.it)).toHaveAttribute("data-kind", "department");
  await expect(row(page, N.it)).toHaveAttribute("aria-level", "1");
  await expect(row(page, N.backend)).toHaveAttribute("data-kind", "team");
  await expect(row(page, N.backend)).toHaveAttribute("aria-level", "2");
  await expect(row(page, N.alpha)).toHaveAttribute("data-kind", "project");
  await expect(row(page, N.alpha)).toHaveAttribute("aria-level", "3");

  // A duplicate sibling name: the server's answer, inline in the dialog.
  await page.getByTestId("new-department").filter({ visible: true }).first().click();
  await submitUnitDialog(page, N.it.toLowerCase());
  await expect(page.getByTestId("unit-dialog").getByRole("alert")).toHaveText(
    "A unit with this name already exists here",
  );
  await page.getByTestId("unit-dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("unit-dialog")).toBeHidden();
  await shot(page, `org-tree-${project}`);

  // A Developer sees the same tree without any create or edit control.
  const dev = await signIn(browser, ALEX, project);
  await openOrganization(dev, mobile);
  await expect(row(dev, N.alpha)).toBeVisible();
  await expect(dev.getByTestId("unit-row")).toHaveCount(3);
  await expect(dev.getByTestId("new-department")).toHaveCount(0);
  await expect(dev.getByTestId("unit-menu")).toHaveCount(0);

  await dev.context().close();
  await page.context().close();
  await admin.dispose();
});
