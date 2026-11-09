import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
// The catalog is code (ADR-0024): the spec checks the rows the panel writes against the catalog's patterns.
import { MODULE_CATALOG, type ModuleId } from "../../packages/contracts/src/module-access.ts";
import { type Actor, apiAs, BASE_URL, ensureMember, expectChannelLanding, openAs } from "../support/actors";
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
/** A second organization admin, a plain member of Core: a lead can never change her modules. */
const ADA: Actor = { name: "Ada Stone", email: "ada@ocw.test", password: "ada-e2e-password-123" };

type Unit = { id: string; name: string };
let admin: APIRequestContext;
let miaId = "";
let lenaId = "";
let adaId = "";
let ops: Unit | null = null;
let core: Unit | null = null;
let builtFor = "";
/** A persona of Core (it blocks deleting the unit until it is gone). */
let botId = "";

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

/** Ops (department) › Core (team): Mia and Ada members of Core, Lena its lead. Once per project. */
async function build(project: string): Promise<{ ops: Unit; core: Unit }> {
  if (builtFor !== project || !ops || !core) {
    await teardown();
    const sfx = `${project === "mobile" ? "m" : "d"}${Date.now().toString(36).slice(-4)}`;
    ops = await createUnit("department", `Ops ${sfx}`, null);
    core = await createUnit("team", `Core ${sfx}`, ops.id);
    await addMember(core, miaId, "member");
    await addMember(core, lenaId, "lead");
    await addMember(core, adaId, "member");
    builtFor = project;
  }
  return { ops, core };
}

/** Every module back on for everyone and for Mia at the organization, then the units go (their rules cascade). */
async function teardown() {
  if (!admin) return;
  if (botId) await admin.delete(`/api/v1/agents/${botId}`);
  botId = "";
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
  adaId = await ensureMember(admin, ADA, "admin");
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

/** The exact `everyone` deny rows of `module` at `unitId` (`null` = the organization; admin API). */
async function everyoneRows(unitId: string | null, module: ModuleId): Promise<string[]> {
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

/** The admin turns `module` off or on for everyone in a scope (`null` = the organization) through the API. */
async function setForEveryone(scopeUnitId: string | null, module: ModuleId, enabled: boolean) {
  const res = await admin.put("/api/v1/module-access", {
    data: { module, scopeUnitId, subject: { kind: "everyone" }, enabled },
  });
  expect(res.ok(), `${module} ${enabled ? "on" : "off"} at ${scopeUnitId ?? "org"}: ${res.status()}`).toBe(
    true,
  );
}

/** The chat sidebar's AI chats section: a column on desktop, the navigation drawer on phones (opened when closed). */
async function aiChatsSection(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile && !(await page.getByTestId("channel-list").filter({ visible: true }).count())) {
    await page.getByTestId("mobile-nav-trigger").click();
  }
  await expect(page.getByTestId("channel-list").filter({ visible: true }).first()).toBeVisible();
  return page.getByTestId("sidebar-ai-chats");
}

/** The settings navigation (the drawer on phones), once a permission-gated entry proves `/me/permissions` loaded. */
async function settingsNav(page: Page, mobile: boolean): Promise<Locator> {
  await page.goto(`${BASE_URL}/settings`);
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  await expect(page.getByTestId("settings-nav-organization").filter({ visible: true })).toBeVisible();
  return page.locator("body");
}

/** Opens a unit by its deep link (the bottom sheet on phones). */
async function openUnitLink(page: Page, mobile: boolean, unit: Unit) {
  await page.goto(`${BASE_URL}/settings/organization?unit=${unit.id}`);
  if (mobile) await expect(page.getByTestId("unit-sheet")).toBeVisible();
  await expect(page.getByTestId("unit-detail-name").filter({ visible: true })).toHaveText(unit.name);
}

/** "Add person" → pick `name` → the "Modules for <name>" dialog. */
async function pickPerson(page: Page, scope: Locator, name: string): Promise<Locator> {
  await scope.getByTestId("module-add-person").click();
  const add = page.getByTestId("module-add-person-dialog");
  await expect(add).toBeVisible();
  await add.getByTestId("module-person-search").fill(name.toLowerCase());
  await add.getByTestId("module-pick-person").filter({ hasText: name }).click();
  const dialog = page.getByTestId("module-person-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText(`Modules for ${name}`);
  return dialog;
}

async function closeDialog(page: Page, dialog: Locator) {
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await page.mouse.move(1, 1);
}

test("a lead manages modules for people of the team she leads; an admin's modules and an ancestor's rule stay read-only", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = sizeOf(project);
  const { ops: dept, core: team } = await build(project);

  const m = await openAs(browser, MIA, project);
  const l = await openAs(browser, LENA, project);
  try {
    await m.page.goto(`${BASE_URL}/chat`);
    await expect((await aiChatsSection(m.page, mobile)).filter({ visible: true })).toBeVisible();

    // ---- the card shows on the unit Lena leads, not on the department above it
    await openUnitLink(l.page, mobile, dept);
    await expect(l.page.getByTestId("unit-members").filter({ visible: true })).toBeVisible();
    await expect(l.page.getByTestId("module-access")).toHaveCount(0);
    await openUnitLink(l.page, mobile, team);
    const card = modulesCard(l.page);
    await expect(card).toBeVisible();

    // ---- Lena turns AI chats off for Mia only: her open tab loses the section live
    let person = await pickPerson(l.page, card, MIA.name);
    await person.getByTestId("person-module-switch-ai_chats").click();
    await expect(person.getByTestId("person-module-switch-ai_chats")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(m.page.getByTestId("sidebar-ai-chats")).toHaveCount(0, { timeout: 5_000 });
    await bothThemes(l.page, `module-access-person-${size}`);
    await closeDialog(l.page, person);
    const miaRow = card.getByTestId("module-person").filter({ hasText: MIA.name });
    await expect(miaRow.getByTestId("module-chip")).toHaveText(["AI chats off"]);

    // ---- her Settings lose the account entry "AI chat"; its page shows the off state
    if (mobile) await m.page.keyboard.press("Escape");
    const nav = await settingsNav(m.page, mobile);
    await expect(nav.getByTestId("settings-nav-profile").filter({ visible: true })).toBeVisible();
    await expect(nav.getByTestId("settings-nav-ai-chat")).toHaveCount(0);
    await m.page.goto(`${BASE_URL}/settings/ai-chat`);
    await expect(m.page.getByTestId("module-off")).toHaveAttribute("data-module", "ai_chats");
    await m.page.goto(`${BASE_URL}/chat`);
    await expectChannelLanding(m.page);

    // ---- an organization admin in the team: listed, switches disabled, and why
    const ada = await pickPerson(l.page, card, ADA.name);
    for (const id of ["work_zone", "ai_chats", "bots"] as const) {
      await expect(ada.getByTestId(`person-module-switch-${id}`)).toHaveAttribute("aria-disabled", "true");
    }
    await expect(ada).toContainText("Only an organization admin can change modules for an admin.");
    await closeDialog(l.page, ada);

    // ---- what the department above turned off: read-only on Core, with the reason and no link for Lena
    await setForEveryone(dept.id, "work_zone", false);
    const wz = card.locator('[data-module="work_zone"]');
    await expect(wz.getByTestId("module-inherited")).toHaveText(`Off for everyone in ${dept.name}`, {
      timeout: 5_000,
    });
    await expect(moduleSwitch(card, "work_zone")).toHaveAttribute("aria-disabled", "true");
    await expect(moduleSwitch(card, "work_zone")).toHaveAttribute("aria-checked", "false");
    await expect(wz.getByRole("link", { name: "Change" })).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await l.page.mouse.move(1, 1);
    await bothThemes(l.page, `module-access-lead-${size}`);
    await setForEveryone(dept.id, "work_zone", true);
    await expect(wz.getByTestId("module-inherited")).toHaveCount(0, { timeout: 5_000 });

    // ---- Lena turns AI chats back on for Mia: it returns live and the exception leaves the list
    await miaRow.getByTestId("module-person-edit").click();
    person = l.page.getByTestId("module-person-dialog");
    await person.getByTestId("person-module-switch-ai_chats").click();
    await expect(person.getByTestId("person-module-switch-ai_chats")).toHaveAttribute("aria-checked", "true");
    await closeDialog(l.page, person);
    await expect(miaRow).toHaveCount(0);
    await expect((await aiChatsSection(m.page, mobile)).filter({ visible: true })).toBeVisible({
      timeout: 5_000,
    });

    // ---- a team with its own bot: the Bots row warns, and turning Bots off asks first with the same sentence
    const created = await admin.post("/api/v1/agents", {
      data: {
        name: `Core helper ${project}`,
        instructions: "Answer briefly.",
        modelProvider: "mock",
        modelId: "mock-1",
        unitId: team.id,
      },
    });
    expect(created.ok(), `Core persona: ${created.status()}`).toBe(true);
    botId = ((await created.json()) as { id: string }).id;
    await openUnitLink(l.page, mobile, team);
    const warning = `${team.name} has 1 bot. Turning Bots off also stops them for everyone, admins included.`;
    await expect(modulesCard(l.page).getByTestId("module-bots-warning")).toHaveText(warning);
    await modulesCard(l.page).locator('[data-module="bots"]').scrollIntoViewIfNeeded();
    await l.page.mouse.move(1, 1);
    await bothThemes(l.page, `module-access-bots-${size}`);
    await moduleSwitch(modulesCard(l.page), "bots").click();
    const confirm = l.page.getByTestId("module-confirm");
    await expect(confirm.getByRole("heading")).toHaveText(`Turn Bots off for everyone in ${team.name}?`);
    await expect(confirm).toContainText(warning);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(moduleSwitch(modulesCard(l.page), "bots")).toHaveAttribute("aria-checked", "true");
    expect(await everyoneRows(team.id, "bots")).toEqual([]);
  } finally {
    if (botId) await admin.delete(`/api/v1/agents/${botId}`);
    botId = "";
    await setForEveryone(dept.id, "work_zone", true);
    await m.context.close();
    await l.context.close();
  }
});

test("Settings › Modules: admins only; the organization-wide switch asks first; units with something off link to them; an exception for one person applies live", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = sizeOf(project);
  const { ops: dept } = await build(project);
  await setForEveryone(dept.id, "bots", false);

  const m = await openAs(browser, MIA, project);
  const l = await openAs(browser, LENA, project);
  const a = await openAs(browser, ADMIN, project);
  try {
    // ---- the entry: admins only (decided by the API's organization-scope unit.modules.manage)
    for (const page of [l.page, m.page]) {
      const nav = await settingsNav(page, mobile);
      await expect(nav.getByTestId("settings-nav-modules")).toHaveCount(0);
    }
    await m.page.goto(`${BASE_URL}/chat`);
    await expect.poll(() => navEntry(m.page, mobile, "work-zone")).toBe(1);

    const nav = await settingsNav(a.page, mobile);
    await nav.getByTestId("settings-nav-modules").filter({ visible: true }).click();
    await expect(a.page).toHaveURL(/\/settings\/modules$/);
    const panel = a.page.getByTestId("module-access").filter({ visible: true });
    await expect(moduleSwitch(panel, "ai_chats")).toHaveAttribute("aria-checked", "true");

    // ---- units with something off, each a link to it
    const override = panel.getByTestId("module-override").filter({ hasText: dept.name });
    await expect(override).toContainText("Bots off");

    // ---- turning a module off for everyone asks first; Cancel leaves it on and writes nothing
    await moduleSwitch(panel, "ai_chats").click();
    const confirm = a.page.getByTestId("module-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("heading")).toHaveText("Turn AI chats off for everyone?");
    await expect(confirm).toContainText(
      "Everyone in the organization loses AI chats right away, admins included. Turning it back on restores it.",
    );
    await a.page.mouse.move(1, 1);
    await bothThemes(a.page, `module-access-confirm-${size}`);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(moduleSwitch(panel, "ai_chats")).toHaveAttribute("aria-checked", "true");
    expect(await everyoneRows(null, "ai_chats")).toEqual([]);

    // ---- an organization exception for Mia: Work Zone off, her open tab loses it live
    const person = await pickPerson(a.page, panel, MIA.name);
    await person.getByTestId("person-module-switch-work_zone").click();
    await expect(person.getByTestId("person-module-switch-work_zone")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await closeDialog(a.page, person);
    await expect(panel.getByTestId("module-person").filter({ hasText: MIA.name })).toContainText(
      "Work Zone off",
    );
    await expect.poll(() => navEntry(m.page, mobile, "work-zone"), { timeout: 5_000 }).toBe(0);
    await bothThemes(a.page, `module-access-org-${size}`);

    // ---- the override opens that unit in Settings › Organization
    await override.click();
    await expect(a.page).toHaveURL(new RegExp(`/settings/organization\\?unit=${dept.id}`));
    await expect(a.page.getByTestId("unit-detail-name").filter({ visible: true })).toHaveText(dept.name);
  } finally {
    await setForEveryone(dept.id, "bots", true);
    await admin.put("/api/v1/module-access", {
      data: {
        module: "work_zone",
        scopeUnitId: null,
        subject: { kind: "user", userId: miaId },
        enabled: true,
      },
    });
    await m.context.close();
    await l.context.close();
    await a.context.close();
  }
});
