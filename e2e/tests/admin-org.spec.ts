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

/**
 * Deepest first, so no delete hits unit_has_children. Personas scoped to a unit (agent-personas.spec) belong to the
 * hierarchy this spec owns: they go first, or the delete answers 409 unit_has_bots.
 */
async function clearUnits(admin: APIRequestContext) {
  const { agents } = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; unitId?: string | null }>;
  };
  for (const a of agents.filter((x) => x.unitId)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok(), `delete unit persona ${a.id}`).toBe(true);
  }
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

/**
 * Review capture (D-09) when OCW_E2E_SCREENSHOT_DIR is set: waits until toasts are gone, then saves the view
 * in light and in dark (`<name>-dark`). A no-op in normal runs.
 */
async function review(page: Page, name: string) {
  if (!process.env.OCW_E2E_SCREENSHOT_DIR) return;
  await page.mouse.move(1, 1);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
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
  await review(page, `org-empty-${project}`);

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
  await review(page, `org-tree-${project}`);

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

const LEAD_HINT = "Only Team Leads or Organization Admins can lead a unit";

/** The detail's own actions menu (the desktop pane or the phone's bottom sheet). */
async function detailMenu(page: Page, item: string | RegExp) {
  await page.getByTestId("unit-detail").getByTestId("unit-menu").click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function closeSheet(page: Page, mobile: boolean) {
  if (!mobile) return;
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("unit-sheet")).toBeHidden();
}

const memberRow = (page: Page, name: string) => page.getByTestId("unit-member").filter({ hasText: name });

test("admin renames, moves, deletes and staffs units; a Team Lead staffs only their subtree", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const admin = await apiAs(ADMIN);
  const it = await unitByName(admin, N.it);
  const backend = await unitByName(admin, N.backend);
  const alpha = await unitByName(admin, N.alpha);
  const marketing = await (
    await admin.post("/api/v1/units", { data: { kind: "department", name: N.marketing, parentId: null } })
  ).json();
  const platform = await (
    await admin.post("/api/v1/units", { data: { kind: "team", name: N.platform, parentId: it.id } })
  ).json();
  const rule = await (
    await admin.post("/api/v1/permission-rules", {
      data: {
        scopeUnitId: it.id,
        subjectKind: "role",
        subjectId: "developer",
        permission: "channel.archive",
        effect: "deny",
      },
    })
  ).json();
  expect(rule.id).toBeTruthy();

  const page = await signIn(browser, ADMIN, project);

  // ---- a deep link opens the unit (in a bottom sheet on phones)
  await page.goto(`${BASE_URL}/settings/organization?unit=${backend.id}`);
  if (mobile) await expect(page.getByTestId("unit-sheet")).toBeVisible();
  await expect(page.getByTestId("unit-detail-name")).toHaveText(N.backend);

  // ---- rename
  const backendApi = N.backend.replace("Backend", "Backend API");
  await detailMenu(page, "Rename…");
  await page.getByTestId("unit-dialog").getByLabel("Name").fill(backendApi);
  await page.getByTestId("unit-dialog").getByTestId("unit-dialog-submit").click();
  await expect(page.getByTestId("unit-dialog")).toBeHidden();
  await expect(page.getByTestId("unit-detail-name")).toHaveText(backendApi);

  // ---- move: top level is disabled for a team, so are Backend itself and its subtree; projects are not parents
  await detailMenu(page, "Move to…");
  const move = page.getByTestId("move-dialog");
  await expect(move).toBeVisible();
  await expect(move.locator('[data-target="root"]')).toBeDisabled();
  await expect(move.locator('[data-target="root"]')).toContainText("Teams cannot be top level");
  await expect(move.locator(`[data-target="${backend.id}"]`)).toBeDisabled();
  await expect(move.locator(`[data-target="${it.id}"]`)).toBeDisabled(); // current location
  await expect(move.locator(`[data-target="${alpha.id}"]`)).toHaveCount(0);
  await expect(move.locator(`[data-target="${platform.id}"]`)).toBeEnabled();
  await move.locator(`[data-target="${marketing.id}"]`).click();
  await expect(move.locator(`[data-target="${marketing.id}"]`)).toHaveAttribute("aria-checked", "true");
  await review(page, `org-move-${project}`);
  await move.getByTestId("move-submit").click();
  await expect(move).toBeHidden();
  await expect(page.getByTestId("unit-detail").getByRole("navigation")).toContainText(N.marketing);
  const after = await listUnits(admin);
  expect(after.find((u) => u.id === backend.id)?.parentId).toBe(marketing.id);
  expect(after.find((u) => u.id === alpha.id)?.path).toEqual([marketing.id, backend.id, alpha.id]);
  await closeSheet(page, mobile);
  await expect(row(page, backendApi)).toHaveAttribute("aria-level", "2");
  await expect(row(page, N.alpha)).toHaveAttribute("aria-level", "3");

  // ---- delete: blocked while a unit holds children; an empty project asks for confirmation
  await row(page, N.marketing).getByTestId("unit-menu").click();
  await expect(page.getByRole("menuitem", { name: /Delete/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("delete-blocked")).toHaveText("Remove its teams and projects first");
  await page.keyboard.press("Escape");
  await row(page, N.alpha).getByTestId("unit-menu").click();
  await expect(page.getByRole("menuitem", { name: /^Add / })).toHaveCount(0); // a project is a leaf
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  await expect(page.getByTestId("delete-unit-dialog")).toBeVisible();
  await page.getByTestId("confirm-delete-unit").click();
  await expect(page.getByTestId("delete-unit-dialog")).toBeHidden();
  await expect(row(page, N.alpha)).toHaveCount(0);

  // ---- staff IT: Add people (search filters by name), Lead toggle, read-only access rules
  await row(page, N.it).click();
  await expect(page.getByTestId("unit-detail-name")).toHaveText(N.it);
  await page.getByTestId("unit-detail").getByTestId("add-people").first().click();
  const addDialog = page.getByTestId("add-people-dialog");
  await expect(addDialog.getByTestId("add-person").filter({ hasText: LENA.name })).toBeVisible();
  await expect(addDialog.getByTestId("add-person").filter({ hasText: ALEX.name })).toBeVisible();
  await review(page, `org-add-people-${project}`);
  // agent-personas.spec adds a "Lena Ortega" to the same stack: search by the whole name so one person matches.
  await addDialog.getByTestId("add-people-search").fill(LENA.name.toLowerCase());
  await expect(addDialog.getByTestId("add-person")).toHaveCount(1);
  await addDialog.getByTestId("add-person").filter({ hasText: LENA.name }).click();
  await expect(addDialog.getByText(/^No one matches/)).toBeVisible();
  await addDialog.getByTestId("add-people-search").fill("alex");
  await addDialog.getByTestId("add-person").filter({ hasText: ALEX.name }).click();
  await addDialog.getByRole("button", { name: "Done" }).click();
  await expect(addDialog).toBeHidden();

  await expect(memberRow(page, LENA.name).getByTestId("unit-role")).toHaveText("Member");
  await expect(memberRow(page, ALEX.name).getByTestId("unit-role")).toHaveText("Member");
  await memberRow(page, LENA.name).getByTestId("lead-switch").click();
  await expect(memberRow(page, LENA.name).getByTestId("unit-role")).toHaveText("Lead");
  await expect(memberRow(page, ALEX.name).getByTestId("lead-switch")).toHaveAttribute("data-disabled", "");
  if (!mobile) {
    await memberRow(page, ALEX.name).getByTestId("lead-switch-wrapper").hover();
    await expect(page.getByText(LEAD_HINT)).toBeVisible();
  }
  const rules = page.getByTestId("unit-rules");
  await expect(rules.getByTestId("unit-rule")).toHaveCount(1);
  await expect(rules.getByTestId("unit-rule")).toContainText("channel.archive");
  await expect(rules.getByTestId("unit-rule")).toContainText("Developer");
  await expect(rules.getByTestId("unit-rule")).toHaveAttribute("data-effect", "deny");
  await review(page, `org-unit-${project}`);

  // ---- the Team Lead (lead of IT) staffs IT and what is inside it, nothing else, and changes no structure
  const lead = await signIn(browser, LENA, project);
  await lead.goto(`${BASE_URL}/settings/organization?unit=${it.id}`);
  await expect(lead.getByTestId("unit-detail-name")).toHaveText(N.it);
  await expect(lead.getByTestId("unit-detail").getByTestId("add-people").first()).toBeVisible();
  await expect(memberRow(lead, ALEX.name).getByTestId("remove-member")).toBeVisible();
  await expect(memberRow(lead, LENA.name).getByTestId("remove-member")).toHaveCount(0);
  await expect(lead.getByTestId("lead-switch")).toHaveCount(0);
  await expect(lead.getByTestId("unit-menu")).toHaveCount(0);
  await expect(lead.getByTestId("unit-rules")).toHaveCount(0);
  await review(lead, `org-lead-view-${project}`);
  await lead.getByTestId("unit-child").filter({ hasText: N.platform }).click();
  await expect(lead.getByTestId("unit-detail-name")).toHaveText(N.platform);
  await expect(lead.getByTestId("unit-detail").getByTestId("add-people").first()).toBeVisible();
  await lead.goto(`${BASE_URL}/settings/organization?unit=${marketing.id}`);
  await expect(lead.getByTestId("unit-detail-name")).toHaveText(N.marketing);
  await expect(lead.getByTestId("add-people")).toHaveCount(0);
  await expect(lead.getByTestId("unit-menu")).toHaveCount(0);

  // ---- the admin removes a member, with confirmation; the Lead sees it live
  await memberRow(page, ALEX.name).getByTestId("remove-member").click();
  await expect(page.getByTestId("remove-member-dialog")).toBeVisible();
  await page.getByTestId("confirm-remove-member").click();
  await expect(memberRow(page, ALEX.name)).toHaveCount(0);
  await expect(page.getByTestId("unit-detail").getByTestId("unit-member")).toHaveCount(1);

  // Rules are org-wide data in the e2e database: leave none behind.
  expect((await admin.delete(`/api/v1/permission-rules/${rule.id}`)).ok()).toBe(true);
  await lead.context().close();
  await page.context().close();
  await admin.dispose();
});
