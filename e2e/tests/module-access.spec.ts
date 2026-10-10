import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
// The catalog is code (ADR-0024): the spec checks the rows the panel writes against the catalog's patterns.
import { MODULE_CATALOG, type ModuleId } from "../../packages/contracts/src/module-access.ts";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { bothThemes } from "../support/files";
import { ADMIN } from "./env";

/**
 * The Modules panel (07.3-04, ACCESS-02, ACCESS-03, D-02, P-06, P-07): an admin and a unit's lead turn Work Zone, AI
 * chats or Bots off and on for everyone in a unit, or for one person, from Settings › Organization; admins do it for
 * the organization from Settings › Modules. A member's open tab loses and regains the module live. The spec owns two
 * units per run (department "Ops", team "Core") and turns every module it touched back on, then deletes them.
 * Mia Gate is shared with module-gating.spec (serial, one worker): every rule this spec writes is removed in afterAll.
 */

test.describe.configure({ mode: "serial" });

const MIA: Actor = { name: "Mia Gate", email: "mia@ocw.test", password: "mia-e2e-password-123" };
/** Same account as admin-org.spec (an organization Team Lead). */
const LENA: Actor = { name: "Lena Ortiz", email: "lena@ocw.test", password: "lena-e2e-password-123" };

type Unit = { id: string; name: string };
let admin: APIRequestContext;
let miaId = "";
let lenaId = "";
let ops: Unit | null = null;
let core: Unit | null = null;
let builtFor = "";

const sizeOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function createUnit(kind: "department" | "team", name: string, parentId: string | null): Promise<Unit> {
  const res = await admin.post("/api/v1/units", { data: { kind, name, parentId } });
  expect(res.ok(), `create ${kind} ${name}: ${res.status()}`).toBe(true);
  return { id: ((await res.json()) as { id: string }).id, name };
}

async function addMember(unit: Unit, userId: string, role: "member" | "lead") {
  const res = await admin.post(`/api/v1/units/${unit.id}/members`, { data: { userId, role } });
  expect(res.ok(), `add ${userId} to ${unit.name}: ${res.status()}`).toBe(true);
}

/** Ops (department) › Core (team): Mia a member of Core, Lena its lead. Once per project. */
async function build(project: string): Promise<{ ops: Unit; core: Unit }> {
  if (builtFor !== project || !ops || !core) {
    await teardown();
    const sfx = `${project === "mobile" ? "m" : "d"}${Date.now().toString(36).slice(-4)}`;
    ops = await createUnit("department", `Ops ${sfx}`, null);
    core = await createUnit("team", `Core ${sfx}`, ops.id);
    await addMember(core, miaId, "member");
    await addMember(core, lenaId, "lead");
    builtFor = project;
  }
  return { ops, core };
}

/** Every module back on for everyone and for Mia at the organization, then the units go (their rules cascade). */
async function teardown() {
  if (!admin) return;
  for (const module of Object.keys(MODULE_CATALOG) as ModuleId[]) {
    for (const subject of [{ kind: "everyone" }, { kind: "user", userId: miaId }]) {
      await admin.put("/api/v1/module-access", {
        data: { module, scopeUnitId: null, subject, enabled: true },
      });
    }
  }
  for (const u of [core, ops]) if (u) await admin.delete(`/api/v1/units/${u.id}`);
  core = null;
  ops = null;
}

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  miaId = await ensureMember(admin, MIA, "developer");
  lenaId = await ensureMember(admin, LENA, "lead");
});

test.afterAll(async () => {
  // Rules are org-wide data in the e2e database: leave none behind, even after a failure.
  await teardown();
  await admin?.dispose();
});

/** How many `nav-<id>` entries are shown: the rail on desktop, the navigation drawer on phones (closed again). */
async function navEntry(page: Page, mobile: boolean, id: string): Promise<number> {
  if (!mobile) return page.getByTestId(`nav-${id}`).filter({ visible: true }).count();
  await page.getByTestId("mobile-nav-trigger").click();
  await expect(page.getByTestId("nav-chat").filter({ visible: true })).toBeVisible();
  const n = await page.getByTestId(`nav-${id}`).filter({ visible: true }).count();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("nav-chat").filter({ visible: true })).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return n;
}

/** The selected unit's Modules card (the desktop pane or the phone's bottom sheet). */
const modulesCard = (page: Page): Locator => page.getByTestId("module-access").filter({ visible: true });
const moduleSwitch = (scope: Locator, module: ModuleId) => scope.getByTestId(`module-switch-${module}`);

/** Settings › Organization through the settings navigation (the drawer on phones), then the unit's row. */
async function openUnit(page: Page, mobile: boolean, unit: Unit) {
  await page.goto(`${BASE_URL}/settings`);
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  await page.getByTestId("settings-nav-organization").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/settings\/organization/);
  await page.locator(`[data-testid="unit-row"][aria-label^="${unit.name},"]`).click();
  if (mobile) await expect(page.getByTestId("unit-sheet")).toBeVisible();
  await expect(page.getByTestId("unit-detail-name").filter({ visible: true })).toHaveText(unit.name);
}

/** The exact `everyone` deny rows of `module` at `unitId` (admin API). */
async function everyoneRows(unitId: string, module: ModuleId): Promise<string[]> {
  const res = await admin.get("/api/v1/permission-rules");
  expect(res.ok()).toBe(true);
  const { rules } = (await res.json()) as {
    rules: Array<{ scopeUnitId: string | null; subjectKind: string; permission: string; effect: string }>;
  };
  return rules
    .filter((r) => r.scopeUnitId === unitId && r.subjectKind === "everyone" && r.effect === "deny")
    .map((r) => r.permission)
    .filter((p) => MODULE_CATALOG[module].patterns.includes(p))
    .sort();
}

test("an admin turns Bots off for a team from its Modules card and a member's open tab loses Bots live", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const { core: team } = await build(project);

  const m = await openAs(browser, MIA, project);
  const a = await openAs(browser, ADMIN, project);
  try {
    await m.page.goto(`${BASE_URL}/chat`);
    await expect.poll(() => navEntry(m.page, mobile, "bots")).toBe(1);

    await openUnit(a.page, mobile, team);
    const card = modulesCard(a.page);
    await card.scrollIntoViewIfNeeded();
    for (const id of ["work_zone", "ai_chats", "bots"] as const) {
      await expect(moduleSwitch(card, id)).toHaveAttribute("aria-checked", "true");
    }

    // ---- off: one deny row per Bots pattern at Core; Mia's Bots entry leaves within 5 s, no reload
    await moduleSwitch(card, "bots").click();
    await expect(moduleSwitch(card, "bots")).toHaveAttribute("aria-checked", "false");
    await expect(card.locator('[data-module="bots"]')).toHaveAttribute("data-state", "off");
    expect(await everyoneRows(team.id, "bots")).toEqual([...MODULE_CATALOG.bots.patterns].sort());
    await expect.poll(() => navEntry(m.page, mobile, "bots"), { timeout: 5_000 }).toBe(0);
    await card.scrollIntoViewIfNeeded();
    await a.page.mouse.move(1, 1);
    await bothThemes(a.page, `module-access-unit-${sizeOf(project)}`);

    // ---- on again: the rows go and the entry is back, live
    await moduleSwitch(card, "bots").click();
    await expect(moduleSwitch(card, "bots")).toHaveAttribute("aria-checked", "true");
    expect(await everyoneRows(team.id, "bots")).toEqual([]);
    await expect.poll(() => navEntry(m.page, mobile, "bots"), { timeout: 5_000 }).toBe(1);
  } finally {
    await m.context.close();
    await a.context.close();
  }
});
