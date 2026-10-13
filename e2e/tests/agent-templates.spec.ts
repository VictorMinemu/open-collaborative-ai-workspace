import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { bothThemes } from "../support/files";
import { ADMIN } from "./env";

/**
 * 07.4-08 (CONN-06, D-05): agent templates. A Backend lead publishes a template; a Backend member starts his own
 * agent from it in Bots (Start dialog, preview first) and lands on the new bot's sheet, which names the template and
 * its version. No model is called (mock model; no cell needed).
 */

// Names used by no other spec (the isolated e2e database is shared by every spec of a run).
const LEAD: Actor = {
  name: "Tess Lead",
  email: "tess.templates@ocw.test",
  password: "tess-e2e-password-123",
};
const MEMBER: Actor = {
  name: "Milo Reyes",
  email: "milo.templates@ocw.test",
  password: "milo-e2e-password-123",
};

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

/** Deletes `who`'s personal bots so the cap starts empty (only the owner sees them in GET /agents). */
async function clearPersonalBots(api: APIRequestContext, userId: string) {
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === userId)) {
    expect((await api.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
}

/** Archives live templates named `name` (re-runnable: a template name is unique among a unit's live templates). */
async function archiveNamed(api: APIRequestContext, name: string) {
  const list = (await (await api.get("/api/v1/agent-templates")).json()) as {
    templates: Array<{ id: string; name: string; canManage: boolean }>;
  };
  for (const t of list.templates.filter((x) => x.name === name && x.canManage)) {
    expect((await api.patch(`/api/v1/agent-templates/${t.id}`, { data: { archived: true } })).ok()).toBe(
      true,
    );
  }
}

const versionBody = (extra: Record<string, unknown> = {}) => ({
  instructions: "You file expense reports from the receipts people forward.",
  modelProvider: "mock",
  modelId: "mock-1",
  capabilities: { internet: false, memory: true, dailyLimit: 20 },
  toolGrants: [],
  requiredConnectorIds: [],
  unitVaultItemIds: [],
  ...extra,
});

async function openBots(page: Page) {
  await page.goto(`${BASE_URL}/bots`);
  await expect(page.getByRole("heading", { name: "Bots", exact: true })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("templates: a lead's template becomes a member's own agent in two clicks", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const name = `Expense filer ${tag}`;

  // ---- people and units (idempotent across projects and runs)
  const admin = await apiAs(ADMIN);
  const leadId = await ensureMember(admin, LEAD, "lead");
  const memberId = await ensureMember(admin, MEMBER, "standard");
  const eng = await ensureUnit(admin, "department", "Engineering", null);
  const backend = await ensureUnit(admin, "team", "Backend", eng);
  await ensureUnitMember(admin, backend, leadId, "lead");
  await ensureUnitMember(admin, backend, memberId);

  const lead = await apiAs(LEAD);
  await archiveNamed(lead, name);
  const created = await lead.post("/api/v1/agent-templates", {
    data: {
      unitId: backend,
      name,
      description: "Files expense reports from receipts you forward.",
      version: versionBody(),
    },
  });
  expect(created.status(), "lead publishes v1").toBe(201);
  const templateId = ((await created.json()) as { id: string }).id;

  const memberApi = await apiAs(MEMBER);
  await clearPersonalBots(memberApi, memberId);

  // ---- the member sees the Templates section with the lead's template
  const m = await openAs(browser, MEMBER, project);
  await openBots(m.page);
  const section = m.page.getByTestId("templates-section");
  await expect(section).toBeVisible();
  const card = section.locator(`[data-template-id="${templateId}"]`);
  await expect(card).toContainText(name);
  await expect(card.getByTestId("template-meta")).toHaveText("Backend · v1");
  await card.scrollIntoViewIfNeeded();
  await bothThemes(m.page, `templates-gallery-${tag}`);

  // ---- Start from template → the Start dialog previews what his agent gets
  await m.page.getByTestId(`template-start-${templateId}`).click();
  const dialog = m.page.getByTestId("template-start-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Start from “${name}”`);
  await expect(dialog).toContainText("Your agent gets");
  await expect(dialog).toContainText("Memory on · Internet off · 20 replies a day");
  await expect(dialog.getByTestId("template-create")).toBeEnabled();
  await bothThemes(m.page, `template-start-${tag}`);
  await dialog.getByTestId("template-create").click();

  // ---- lands on the new bot's detail sheet, which names the template and its version
  const sheet = m.page.getByTestId("bot-detail-sheet");
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByTestId("bot-template-line")).toHaveText(`From template ${name} · v1`);

  // ---- the DM opens from there
  await sheet.getByTestId("bot-message").click();
  await expect(m.page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(m.page.getByTestId("dm-title")).toHaveText(name);

  await m.context.close();
  await lead.dispose();
  await memberApi.dispose();
  await admin.dispose();
});
