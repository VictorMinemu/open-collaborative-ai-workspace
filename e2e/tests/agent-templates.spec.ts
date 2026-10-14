import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { bothThemes } from "../support/files";
import { asSuperuser } from "../support/superuser";
import { ADMIN } from "./env";

/**
 * 07.4-08 (CONN-06, D-05, 07.4-UI-SPEC § 4): agent templates end to end, at 1440 and 390.
 *  - The Backend lead writes a template in the editor (unit, instructions, model, capabilities, a personal tool, a tool
 *    of a source not allowed for personal agents, a required per-member connector) and publishes v1.
 *  - A Backend member starts his own agent from it: the Start dialog lists what is left out and the connector to
 *    connect; the new bot's sheet names the template and links Connect to Settings › Connections.
 *  - The lead publishes v2 from the editor; the member's sheet shows "Template updated to v2 · Review and update"; the
 *    dialog lists what changes; Update applies it.
 *  - At the personal-bot cap the Start dialog says so and disables Create; a Frontend member never sees the template.
 *  - The lead archives it (card menu, confirmation); a stale Start answers "This template was archived."; the member's
 *    agent keeps working.
 * axe (no serious or critical) runs on the section, the Start dialog, the editor and the update dialog in both themes;
 * at 390 every control there is at least 44×44. No model is called (mock model; no cell needed). Tool sources and the
 * per-member connector are seeded as the superuser of the isolated database (07.4-06 owns the admin UI for them).
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
const OUTSIDER: Actor = {
  name: "Jade Front",
  email: "jade.templates@ocw.test",
  password: "jade-e2e-password-123",
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

interface Listed {
  id: string;
  scope: string;
  ownerUserId: string | null;
}

/** Deletes `userId`'s personal bots so the cap starts empty (only the owner sees them in GET /agents). */
async function clearPersonalBots(api: APIRequestContext, userId: string) {
  const listed = (await (await api.get("/api/v1/agents")).json()) as { agents: Listed[] };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === userId)) {
    expect((await api.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
}

interface TemplateRow {
  id: string;
  name: string;
  canManage: boolean;
  currentVersion: number;
}

async function templatesOf(api: APIRequestContext): Promise<TemplateRow[]> {
  const res = await api.get("/api/v1/agent-templates");
  expect(res.ok(), "list templates").toBe(true);
  return ((await res.json()) as { templates: TemplateRow[] }).templates;
}

/** Archives live templates named `name` (a template name is unique among a unit's live templates). */
async function archiveNamed(api: APIRequestContext, name: string) {
  for (const t of (await templatesOf(api)).filter((x) => x.name === name && x.canManage)) {
    expect((await api.patch(`/api/v1/agent-templates/${t.id}`, { data: { archived: true } })).ok()).toBe(
      true,
    );
  }
}

/** Seeds one MCP source (and its tools) as the superuser of the isolated database; returns its id. */
async function seedSource(
  orgId: string,
  name: string,
  safe: string,
  opts: { personalAllowed: boolean; perMember?: boolean; tools?: string[] },
): Promise<string> {
  await asSuperuser(
    `insert into app.mcp_servers (organization_id, name, safe_name, transport, url, status, personal_allowed, auth_mode,
       member_header_name)
     values ($1, $2, $3, 'streamable-http', 'https://mcp.example.test/mcp', 'ready', $4, $5, $6)
     on conflict (organization_id, safe_name) do nothing`,
    [
      orgId,
      name,
      safe,
      opts.personalAllowed,
      opts.perMember ? "per_member_secret" : "org_secret",
      opts.perMember ? "authorization" : null,
    ],
  );
  const { rows } = await asSuperuser<{ id: string }>(
    "select id from app.mcp_servers where organization_id = $1 and safe_name = $2",
    [orgId, safe],
  );
  const id = rows[0]?.id as string;
  for (const tool of opts.tools ?? []) {
    await asSuperuser(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, $3, $4, true) on conflict do nothing`,
      [orgId, id, tool, `${safe}__${tool}`],
    );
  }
  return id;
}

async function openBots(page: Page) {
  await page.goto(`${BASE_URL}/bots`);
  await expect(page.getByRole("heading", { name: "Bots", exact: true })).toBeVisible();
  await expect(page.getByTestId("templates-section")).toBeVisible();
}

/**
 * Infinite animations (a Provisioning chip's pulse behind the sheet, left by another spec's bot) never finish, and the
 * axe helper waits for every running animation: stop them first. Finite ones (dialogs fading in) are left alone.
 */
const stopEndlessAnimations = (page: Page) =>
  page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY) a.cancel();
    }
  });

/** Both themes, with the axe gate in each (UI-SPEC Accessibility Contract). */
async function a11yBothThemes(page: Page, selector: string) {
  await stopEndlessAnimations(page);
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "dark" });
  await stopEndlessAnimations(page);
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "light" });
}

/** At 390 every visible control (or the label row it sits in) is at least 44×44 (UI-SPEC Spacing exceptions). */
async function expectTouchTargets(scope: Locator) {
  const small = await scope.evaluate((root) => {
    const out: string[] = [];
    const controls = root.querySelectorAll(
      'button, a[href], input, textarea, [role="combobox"], [role="switch"], [role="checkbox"]',
    );
    for (const el of Array.from(controls)) {
      if (el.closest('[aria-hidden="true"]')) continue;
      const own = el.getBoundingClientRect();
      if (own.width < 2 || own.height < 2) continue;
      const box = (el.closest("label") ?? el).getBoundingClientRect();
      if (box.width < 44 || box.height < 44) {
        const name = (
          el.getAttribute("aria-label") ??
          el.textContent ??
          el.getAttribute("type") ??
          ""
        ).trim();
        out.push(
          `${el.tagName.toLowerCase()} "${name.slice(0, 40)}" ${Math.round(box.width)}×${Math.round(box.height)}`,
        );
      }
    }
    return out;
  });
  expect(small, "controls under 44×44").toEqual([]);
}

/** Toasts would cover the content under review. */
const noToasts = (page: Page) =>
  expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });

/** Picks the option whose label is exactly `label` in an open Select. */
const option = (page: Page, label: string) =>
  page.getByRole("option").filter({ has: page.getByText(label, { exact: true }) });

test.describe.configure({ mode: "serial" });

test("templates: a lead's template becomes a member's own agent; updates fork; caps; archive", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const name = `Expense filer ${tag}`;
  const crmName = `Acme CRM ${tag}`;

  // ---- people, units and tool sources (idempotent across projects and runs)
  const admin = await apiAs(ADMIN);
  const orgId = ((await (await admin.get("/api/v1/me")).json()) as { organization: { id: string } })
    .organization.id;
  const leadId = await ensureMember(admin, LEAD, "lead");
  const memberId = await ensureMember(admin, MEMBER, "standard");
  const outsiderId = await ensureMember(admin, OUTSIDER, "standard");
  const eng = await ensureUnit(admin, "department", "Engineering", null);
  const backend = await ensureUnit(admin, "team", "Backend", eng);
  const frontend = await ensureUnit(admin, "team", "Frontend", eng);
  await ensureUnitMember(admin, backend, leadId, "lead");
  await ensureUnitMember(admin, backend, memberId);
  await ensureUnitMember(admin, frontend, outsiderId);
  await seedSource(orgId, `ERP ${tag}`, mobile ? "m3900e001" : "m1440e001", {
    personalAllowed: true,
    tools: ["read_invoice"],
  });
  await seedSource(orgId, `Admin tools ${tag}`, mobile ? "m3900a001" : "m1440a001", {
    personalAllowed: false,
    tools: ["delete_record"],
  });
  const crm = await seedSource(orgId, crmName, mobile ? "m3900c001" : "m1440c001", {
    personalAllowed: true,
    perMember: true,
  });

  const leadApi = await apiAs(LEAD);
  await archiveNamed(leadApi, name);
  const memberApi = await apiAs(MEMBER);
  await clearPersonalBots(memberApi, memberId);

  // ---- the lead writes the template in the editor and publishes v1
  const l = await openAs(browser, LEAD, project);
  await openBots(l.page);
  await l.page.getByTestId("template-new").click();
  const editor = l.page.getByTestId("template-editor");
  await expect(editor).toBeVisible();
  await editor.getByTestId("template-unit").click();
  await l.page.locator('[data-testid="template-unit-option"][data-unit-name="Backend"]').click();
  await editor.getByTestId("template-name").fill(name);
  await editor.getByTestId("template-description").fill("Files expense reports from receipts you forward.");
  await editor
    .getByTestId("template-instructions")
    .fill("You file expense reports from the receipts people forward.");
  await editor.getByTestId("template-model").click();
  await option(l.page, "Mock model (E2E)").click();
  await editor.getByTestId("template-daily-limit").fill("20");
  await editor
    .locator(`[data-testid="template-tool"][data-tool="read_invoice"][data-source="ERP ${tag}"]`)
    .check();
  await editor
    .locator(`[data-testid="template-tool"][data-tool="delete_record"][data-source="Admin tools ${tag}"]`)
    .check();
  await editor.locator(`[data-testid="template-connector"][data-connector="${crmName}"]`).check();
  await expect(editor.getByText("Not for personal agents").first()).toBeVisible();
  await expect(editor.getByTestId("template-publish")).toHaveText("Publish v1");
  await bothThemes(l.page, `template-editor-${tag}`);
  await a11yBothThemes(l.page, '[data-testid="template-editor"]');
  if (mobile) await expectTouchTargets(editor);
  await editor.getByTestId("template-publish").click();
  await expect(editor).toBeHidden();
  const templateId = (await templatesOf(leadApi)).find((t) => t.name === name)?.id as string;
  expect(templateId, "published template").toBeTruthy();
  const leadCard = l.page.locator(`[data-template-id="${templateId}"]`);
  await expect(leadCard.getByTestId("template-meta")).toHaveText("Backend · v1");
  await leadCard.scrollIntoViewIfNeeded();
  await noToasts(l.page);
  await bothThemes(l.page, `templates-gallery-lead-${tag}`);

  // ---- a Frontend member never sees it
  const outsiderApi = await apiAs(OUTSIDER);
  expect((await templatesOf(outsiderApi)).map((t) => t.id)).not.toContain(templateId);

  // ---- the member starts his own agent: the dialog lists what is left out and what to connect
  const m = await openAs(browser, MEMBER, project);
  await openBots(m.page);
  const section = m.page.getByTestId("templates-section");
  const card = section.locator(`[data-template-id="${templateId}"]`);
  await expect(card.getByTestId("template-needs")).toHaveText(`Needs ${crmName}`);
  await card.scrollIntoViewIfNeeded();
  await bothThemes(m.page, `templates-gallery-${tag}`);
  await a11yBothThemes(m.page, '[data-testid="templates-section"]');
  if (mobile) await expectTouchTargets(section);

  await m.page.getByTestId(`template-start-${templateId}`).click();
  const start = m.page.getByTestId("template-start-dialog");
  await expect(start.getByTestId("template-skipped")).toContainText(
    "delete_record isn't allowed for personal agents.",
  );
  await expect(start).toContainText("Connect to use all of it");
  await expect(start.getByRole("link", { name: `Connect ${crmName}` })).toHaveAttribute(
    "href",
    `/settings/connections?connector=${crm}`,
  );
  await expect(start).toContainText("read_invoice");
  await bothThemes(m.page, `template-start-${tag}`);
  await a11yBothThemes(m.page, '[data-testid="template-start-dialog"]');
  if (mobile) await expectTouchTargets(start);
  await start.getByTestId("template-create").click();

  const sheet = m.page.getByTestId("bot-detail-sheet");
  await expect(sheet.getByTestId("bot-template-line")).toHaveText(`From template ${name} · v1`, {
    timeout: 15_000,
  });
  await expect(sheet.getByRole("link", { name: `Connect ${crmName}` })).toHaveAttribute(
    "href",
    `/settings/connections?connector=${crm}`,
  );
  const botId = (
    (
      (await (await memberApi.get("/api/v1/agents")).json()) as { agents: Array<Listed & { name: string }> }
    ).agents.find((a) => a.scope === "personal" && a.ownerUserId === memberId && a.name === name) as Listed
  ).id;
  // No cell runs in this spec: mark the bot Ready as the cell's ack would, so the sheet under review shows the state a
  // member normally sees.
  await asSuperuser("update app.agents set status = 'ready' where id = $1", [botId]);
  await m.page.keyboard.press("Escape");

  // ---- the lead publishes v2 from the editor (card menu → Edit…)
  await leadCard.getByTestId("template-menu").click();
  await l.page.getByTestId("template-edit").click();
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId("template-editor-version")).toContainText("v1 · published");
  await editor.getByTestId("template-instructions").fill("You file expense reports and flag duplicates.");
  await editor.getByTestId("template-internet").click();
  await expect(editor.getByTestId("template-publish")).toHaveText("Publish v2");
  await editor.getByTestId("template-publish").click();
  await expect(editor).toBeHidden();
  await expect(leadCard.getByTestId("template-meta")).toHaveText("Backend · v2");

  // ---- the member's sheet offers the update; the dialog lists what changes; Update applies it
  await m.page.reload();
  await expect(m.page.getByRole("heading", { name: "Bots", exact: true })).toBeVisible();
  await m.page
    .locator(`[data-testid="bot-card"]`)
    .filter({ hasText: name })
    .getByRole("button", { name })
    .click();
  const banner = sheet.getByTestId("template-update-banner");
  await expect(banner).toContainText("Template updated to v2 · Review and update");
  await banner.getByRole("button", { name: "Review update to v2" }).click();
  const update = m.page.getByTestId("template-update-dialog");
  await expect(update).toContainText(`Update ${name} to v2?`);
  await expect(update.locator('[data-testid="template-update-field"]')).toHaveText([
    /Instructions/,
    /Abilities/,
  ]);
  await expect(update).toContainText("You file expense reports and flag duplicates.");
  await bothThemes(m.page, `template-update-${tag}`);
  await a11yBothThemes(m.page, '[data-testid="template-update-dialog"]');
  if (mobile) await expectTouchTargets(update);
  await update.getByTestId("template-update-apply").click();
  await expect(update).toBeHidden();
  await expect(banner).toHaveCount(0);
  await expect(sheet.getByTestId("bot-template-line")).toHaveText(`From template ${name} · v2`);
  await m.page.keyboard.press("Escape");

  // ---- at the personal-bot cap (3) the Start dialog says so and Create is disabled
  const extras: string[] = [];
  for (const n of [1, 2]) {
    const res = await memberApi.post("/api/v1/agents/personal", { data: { name: `Milo extra ${tag} ${n}` } });
    expect(res.ok(), "extra personal bot").toBe(true);
    extras.push(((await res.json()) as { agent: { id: string } }).agent.id);
  }
  await m.page.getByTestId(`template-start-${templateId}`).click();
  await expect(start.getByTestId("template-cap-reached")).toHaveText(
    "You already have 3 personal bots (the limit is 3).",
  );
  await expect(start.getByTestId("template-create")).toBeDisabled();
  await noToasts(m.page);
  await bothThemes(m.page, `template-start-cap-${tag}`);
  await m.page.keyboard.press("Escape");
  for (const id of extras) expect((await memberApi.delete(`/api/v1/agents/${id}`)).ok()).toBe(true);

  // ---- the lead archives it while the member's Start dialog is open: the stale Start is refused
  await m.page.reload();
  await expect(m.page.getByTestId("templates-section")).toBeVisible();
  await m.page.getByTestId(`template-start-${templateId}`).click();
  await expect(start.getByTestId("template-create")).toBeEnabled();
  await leadCard.getByTestId("template-menu").click();
  await l.page.getByTestId("template-archive").click();
  const confirm = l.page.getByTestId("template-archive-dialog");
  await expect(confirm).toContainText(`Archive “${name}”?`);
  await expect(confirm).toContainText(
    "Nobody can start new agents from it. Agents already started keep working.",
  );
  await confirm.getByTestId("template-archive-confirm").click();
  await expect(l.page.getByText(`${name} archived`)).toBeVisible();
  await expect(leadCard).toHaveCount(0);

  await start.getByTestId("template-create").click();
  await expect(start.getByTestId("template-archived")).toHaveText("This template was archived.");
  await m.page.keyboard.press("Escape");
  await m.page.reload();
  await expect(m.page.getByRole("heading", { name: "Bots", exact: true })).toBeVisible();
  await expect(m.page.locator(`[data-template-id="${templateId}"]`)).toHaveCount(0);
  // The member's agent keeps working.
  const bot = (await (await memberApi.get(`/api/v1/agents/${botId}`)).json()) as { status: string };
  expect(bot.status).not.toBe("disabled");
  await expect(m.page.locator(`[data-testid="bot-card"]`).filter({ hasText: name })).toBeVisible();

  await m.context.close();
  await l.context.close();
  for (const c of [admin, leadApi, memberApi, outsiderApi]) await c.dispose();
});
