import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { ADMIN, shot } from "./env";

/**
 * 06-07 (AGENT-01, D-07): bots become scoped personas. The admin creates a Team persona for Backend with Lena (the
 * plan's Riley) as owner; Lena (lead of Backend) sees New bot with only her units and creates one; Jo (Frontend) sees
 * neither in the gallery. In the detail, the persona shows "Team · Backend" and its owner; Lena reassigns the owner to
 * Kai (the plan's Alex, a Backend member) and Kai sees it live; a viewer without bot.configure sees no editor; a Phase 1 bot shows "Organization" and keeps
 * its controls. No model is called (mock model; no cell needed).
 */

// Names used by no other spec (the isolated e2e database is shared by every spec of a run).
const RILEY: Actor = {
  name: "Lena Ortega",
  email: "lena.persona@ocw.test",
  password: "lena-e2e-password-123",
};
const ALEX: Actor = { name: "Kai Moreno", email: "kai.persona@ocw.test", password: "kai-e2e-password-1234" };
const JO: Actor = { name: "Jo Diaz", email: "jo.diaz@ocw.test", password: "jo-e2e-password-1234" };

interface Unit {
  id: string;
  name: string;
  kind: string;
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

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function openBots(page: Page) {
  await page.goto(`${BASE_URL}/bots`);
  await expect(page.getByRole("heading", { name: "Bots", exact: true })).toBeVisible();
}

const cardOf = (page: Page, name: string) => page.getByTestId("bot-card").filter({ hasText: name }).first();
/** A unit option of the persona unit picker, by unit name (options also show their parent trail). */
const unitOption = (page: Page, name: string) =>
  page.locator(`[data-testid="persona-unit-option"][data-unit-name="${name}"]`);
/** A select option whose label is exactly `label`. */
const option = (page: Page, label: string) =>
  page.getByRole("option").filter({ has: page.getByText(label, { exact: true }) });

test.describe.configure({ mode: "serial" });

test("personas: admin and lead create scoped personas; scope decides who sees them; owner managed in place", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";

  // ---- people, units and a Phase 1 bot (idempotent across projects and runs)
  const admin = await apiAs(ADMIN);
  const rileyId = await ensureMember(admin, RILEY, "lead");
  const alexId = await ensureMember(admin, ALEX, "standard");
  const joId = await ensureMember(admin, JO, "standard");
  const eng = await ensureUnit(admin, "department", "Engineering", null);
  const backend = await ensureUnit(admin, "team", "Backend", eng);
  const frontend = await ensureUnit(admin, "team", "Frontend", eng);
  await ensureUnitMember(admin, backend, rileyId, "lead");
  await ensureUnitMember(admin, backend, alexId);
  await ensureUnitMember(admin, frontend, joId);

  const adminPersona = `Deploy helper ${tag}`;
  const rileyPersona = `Ship bot ${tag}`;
  const phase1 = `Archie ${tag}`;
  const existing = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of existing.agents.filter((x) => [adminPersona, rileyPersona, phase1].includes(x.name))) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const created = await admin.post("/api/v1/agents", {
    data: { name: phase1, instructions: "You are Archie.", modelProvider: "mock", modelId: "mock-1" },
  });
  expect(created.ok(), "Phase 1 bot").toBe(true);

  // ---- the admin creates a Team persona for Backend, owned by Lena
  const a = await openAs(browser, ADMIN, project);
  await openBots(a.page);
  await a.page.getByTestId("new-bot").click();
  const sheet = a.page.getByTestId("new-bot-sheet");
  await sheet.getByTestId("preset-product-manager").click();
  const placement = sheet.getByTestId("persona-placement");
  await expect(placement).toBeVisible();
  for (const sc of ["organization", "department", "team", "project"]) {
    await expect(placement.getByTestId(`persona-scope-${sc}`)).toBeVisible();
  }
  // Personal stays the one-click owner-only flow: it is never offered here.
  await expect(placement.getByText("Personal")).toHaveCount(0);
  await expect(placement.getByTestId("persona-scope-organization")).toHaveAttribute("aria-checked", "true");
  await placement.getByTestId("persona-scope-team").click();
  await placement.getByTestId("persona-unit").click();
  // The unit picker lists teams only.
  await expect(unitOption(a.page, "Backend")).toBeVisible();
  await expect(unitOption(a.page, "Frontend")).toBeVisible();
  await expect(unitOption(a.page, "Engineering")).toHaveCount(0);
  await unitOption(a.page, "Backend").click();
  await placement.getByTestId("persona-owner").click();
  await option(a.page, "Lena Ortega").click();
  await expect(placement.getByTestId("persona-audience")).toContainText("Only members of Backend");
  await sheet.getByTestId("bot-name").fill(adminPersona);
  await sheet.getByTestId("bot-model").click();
  await a.page.getByRole("option", { name: /Mock model/ }).click();
  await placement.scrollIntoViewIfNeeded();
  await bothThemes(a.page, `personas-new-${tag}`);
  await sheet.getByTestId("create-bot").click();
  await expect(sheet).toBeHidden();
  const adminCard = cardOf(a.page, adminPersona);
  await expect(adminCard.getByTestId("bot-scope")).toHaveText("Team · Backend");

  // The Phase 1 bot shows "Organization" in its detail and keeps its controls.
  await cardOf(a.page, phase1).getByRole("button", { name: phase1 }).click();
  const adminDetail = a.page.getByTestId("bot-detail-sheet");
  await expect(adminDetail.getByTestId("bot-scope")).toHaveText("Organization");
  await expect(adminDetail.getByTestId("bot-enabled")).toBeVisible();
  await expect(adminDetail.getByTestId("delete-bot")).toBeVisible();
  await a.page.keyboard.press("Escape");
  await expect(adminDetail).toBeHidden();

  // ---- Lena (lead of Backend) sees New bot with only her units and creates one
  const r = await openAs(browser, RILEY, project);
  await openBots(r.page);
  await r.page.getByTestId("new-bot").click();
  const rSheet = r.page.getByTestId("new-bot-sheet");
  await rSheet.getByTestId("preset-support").click();
  const rPlacement = rSheet.getByTestId("persona-placement");
  await expect(rPlacement.getByTestId("persona-scope-team")).toHaveAttribute("aria-checked", "true");
  await expect(rPlacement.getByTestId("persona-scope-organization")).toBeDisabled();
  await expect(rPlacement.getByTestId("persona-scope-department")).toBeDisabled();
  await rPlacement.getByTestId("persona-unit").click();
  await expect(unitOption(r.page, "Backend")).toBeVisible();
  await expect(unitOption(r.page, "Frontend")).toHaveCount(0);
  await unitOption(r.page, "Backend").click();
  await expect(rPlacement.getByTestId("persona-owner")).toContainText("Lena Ortega");
  await rSheet.getByTestId("bot-name").fill(rileyPersona);
  await rSheet.getByTestId("bot-model").click();
  await r.page.getByRole("option", { name: /Mock model/ }).click();
  await rSheet.getByTestId("create-bot").click();
  await expect(rSheet).toBeHidden();
  await expect(cardOf(r.page, rileyPersona).getByTestId("bot-scope")).toHaveText("Team · Backend");
  // Lena sees the admin's Backend persona too (it is in her unit).
  await expect(cardOf(r.page, adminPersona)).toBeVisible();

  // ---- Jo (Frontend) sees neither Backend persona; the Phase 1 bot is there
  const j = await openAs(browser, JO, project);
  await openBots(j.page);
  await expect(cardOf(j.page, phase1)).toBeVisible();
  await expect(j.page.getByTestId("bot-card").filter({ hasText: adminPersona })).toHaveCount(0);
  await expect(j.page.getByTestId("bot-card").filter({ hasText: rileyPersona })).toHaveCount(0);
  await expect(j.page.getByTestId("new-bot")).toHaveCount(0);
  await shot(j.page, `personas-gallery-${tag}`);
  await j.context.close();
  await openBots(a.page);
  await expect(adminCard).toBeVisible();
  await shot(a.page, `personas-gallery-admin-${tag}`);

  // ---- Kai (Backend, standard) opens the persona: read-only, owner Lena
  const x = await openAs(browser, ALEX, project);
  await openBots(x.page);
  await cardOf(x.page, adminPersona).getByRole("button", { name: adminPersona }).click();
  const alexDetail = x.page.getByTestId("bot-detail-sheet");
  await expect(alexDetail.getByTestId("bot-scope")).toHaveText("Team · Backend");
  await expect(alexDetail.getByTestId("bot-owner")).toHaveText("Owner: Lena Ortega");
  await expect(alexDetail.getByTestId("persona-placement")).toHaveCount(0);
  await expect(alexDetail.getByTestId("save-bot")).toHaveCount(0);

  // ---- Lena reassigns the owner to Kai in place
  await cardOf(r.page, adminPersona).getByRole("button", { name: adminPersona }).click();
  const rDetail = r.page.getByTestId("bot-detail-sheet");
  await expect(rDetail.getByTestId("bot-scope")).toHaveText("Team · Backend");
  await expect(rDetail.getByTestId("bot-owner")).toHaveText("Owner: Lena Ortega");
  await bothThemes(r.page, `personas-detail-${tag}`);
  await rDetail.getByTestId("persona-owner").click();
  await option(r.page, "Kai Moreno").click();
  await rDetail.getByTestId("save-bot").click();
  await expect(rDetail.getByTestId("bot-owner")).toHaveText("Owner: Kai Moreno");

  // Kai sees the change without a reload (agent.updated on his user topic).
  await expect(alexDetail.getByTestId("bot-owner")).toHaveText("Owner: Kai Moreno", { timeout: 10_000 });
  await shot(x.page, `personas-detail-viewer-${tag}`);

  await x.context.close();
  await r.context.close();
  await a.context.close();
  await admin.dispose();
});
