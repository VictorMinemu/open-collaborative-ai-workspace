import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, userIdOf } from "../support/actors";
import { chatIdOf, lastAssistant, openNewAiChat, seedPlan, sendAi, VICTOR } from "../support/ai-chat";
import { ALEX } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * MULTI-01 complete in the browser (06-12, D-03, D-08, P-13): PRD §17's progression "Shared with Alex → Shared with
 * Backend Team". Víctor's chat is already shared with Alex; from the share dialog he widens it to the Backend team,
 * makes the team view-only, is asked to confirm before the whole organization would see it (and cancels), then removes
 * Alex. Riley (Backend) finds the chat on the AI chats page under "Shared with me"; every change reaches the other
 * pages live. The header shows who is here (presence) and how widely the chat is shared, and its participants list
 * names each person's access. The fake model only (P-12).
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";

/** A Backend member local to this spec (a name no other spec uses). */
const RILEY: Actor = {
  name: "Riley Quinn",
  email: "riley.share@ocw.test",
  password: "riley-e2e-password-123",
};

/** P-13, verbatim. */
const DISCLOSURE_FIRST = "the whole conversation, including earlier messages and answers";

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

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

let admin: APIRequestContext;
let alexId: string;
let rileyId: string;

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, VICTOR, "admin");
  alexId = await ensureMember(admin, ALEX, "developer");
  rileyId = await ensureMember(admin, RILEY, "developer");
  const engineering = await ensureUnit(admin, "department", "Engineering", null);
  const backend = await ensureUnit(admin, "team", "Backend", engineering);
  const joined = await admin.post(`/api/v1/units/${backend}/members`, {
    data: { userId: rileyId, role: "member" },
  });
  expect(joined.ok() || joined.status() === 409, "Riley in Backend").toBe(true);
  for (const actor of [VICTOR, ALEX, RILEY]) {
    const api = await apiAs(actor);
    await seedPlan(api);
    await api.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
    await api.dispose();
  }
});

test.afterAll(async () => {
  await admin?.dispose();
});

async function openShareDialog(page: Page): Promise<Locator> {
  await page.getByTestId("ai-chat-menu-button").click();
  await page.getByTestId("ai-chat-menu-share").filter({ visible: true }).click();
  const dialog = page.getByTestId("ai-share-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Searches the subject picker and returns the options shown. */
async function search(people: Locator, text: string): Promise<Locator> {
  const input = people.getByTestId("ai-share-person-input");
  await input.fill(text);
  return people.getByTestId("ai-share-person-option");
}

/** Opens the level menu of one grant row (by its label) and picks an item. */
async function grantAction(page: Page, people: Locator, label: string, item: string) {
  const row = people.getByTestId("ai-share-grant").filter({ hasText: label });
  await row.getByTestId("ai-share-grant-level").click();
  await page.getByTestId(item).filter({ visible: true }).click();
}

test("Víctor widens his chat from Alex to the Backend team, makes it view-only, then removes Alex", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);
  const owner = await openAs(browser, VICTOR, project);
  const alexCtx = await openAs(browser, ALEX, project);
  const rileyCtx = await openAs(browser, RILEY, project);
  const victorApi = await apiAs(VICTOR);
  try {
    const page = owner.page;
    const victorId = await userIdOf(victorApi);
    await openNewAiChat(page);
    await sendAi(page, "Draft the Q3 platform roadmap");
    await expect(page).toHaveURL(/\/chat\/ai\/[0-9a-f-]{36}$/);
    await expect(lastAssistant(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    const chatId = chatIdOf(page);

    // Already shared with Alex (PRD §17 "Shared with Alex"); Alex has it open.
    const shared = await victorApi.post(`/api/v1/ai-chats/${chatId}/grants`, {
      data: { subject: { kind: "user", id: alexId }, level: "chat" },
    });
    expect(shared.status(), "share with Alex").toBe(201);
    const alex = alexCtx.page;
    await alex.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(alex.getByTestId("ai-composer")).toBeVisible();

    // ---- Share → People and teams: the disclosure above the picker; Alex listed at Can chat.
    const dialog = await openShareDialog(page);
    const people = dialog.getByTestId("ai-share-people");
    const disclosure = people.getByTestId("ai-share-disclosure");
    await expect(disclosure).toContainText(DISCLOSURE_FIRST);
    const above =
      ((await disclosure.boundingBox())?.y ?? 0) <
      ((await people.getByTestId("ai-share-person-input").boundingBox())?.y ?? 0);
    expect(above, "the disclosure stays above the subject picker").toBe(true);
    await expect(people.getByTestId("ai-share-grant").filter({ hasText: ALEX.name })).toContainText(
      "Can chat",
    );

    // ---- the picker offers people, teams, departments and the whole organization.
    let options = await search(people, "Backend");
    const backendOption = options.filter({ hasText: "Backend" }).first();
    await expect(backendOption).toHaveAttribute("data-subject-kind", "unit");
    await expect(backendOption).toContainText("Team");
    await expect(backendOption.getByTestId("ai-share-unit-icon")).toBeVisible();
    options = await search(people, "Engineering");
    await expect(options.filter({ hasText: "Engineering" }).first()).toContainText("Department");
    options = await search(people, "Everyone");
    await expect(options.filter({ hasText: `Everyone at ${ADMIN.orgName}` })).toHaveCount(1);
    options = await search(people, RILEY.name);
    await expect(options.filter({ hasText: RILEY.name })).toHaveAttribute("data-subject-kind", "user");

    // ---- share with Backend at Can chat.
    options = await search(people, "Backend");
    await options.filter({ hasText: "Backend" }).first().click();
    await people.getByRole("radio", { name: "Can chat" }).click();
    await people.getByTestId("ai-share-submit").click();
    const backendRow = people.getByTestId("ai-share-grant").filter({ hasText: "Backend" });
    await expect(backendRow).toContainText("Can chat");
    await expect(backendRow).toHaveAttribute("data-subject-kind", "unit");
    await bothThemes(page, `share-people-${w}`);

    // Riley (Backend) finds it on the AI chats page under "Shared with me", with the owner's name, and opens it.
    const riley = rileyCtx.page;
    await riley.goto(`${BASE_URL}/chat/ai`);
    const sharedGroup = riley.getByTestId("ai-chats-shared");
    const rileyRow = sharedGroup.locator(`[data-testid="ai-chat-shared-row"][data-chat-id="${chatId}"]`);
    await expect(rileyRow).toBeVisible({ timeout: 15_000 });
    await expect(rileyRow).toContainText(VICTOR.name);
    await bothThemes(riley, `share-people-shared-with-me-${w}`);
    await rileyRow.getByRole("link").first().click();
    await expect(riley).toHaveURL(new RegExp(`/chat/ai/${chatId}$`, "u"));
    await expect(riley.getByTestId("ai-composer")).toBeVisible();

    // ---- Backend → Can view: Riley's composer turns into the read-only notice, live.
    await grantAction(page, people, "Backend", "ai-share-grant-level-view");
    await expect(backendRow).toContainText("Can view");
    await expect(riley.getByTestId("ai-view-only-notice")).toBeVisible({ timeout: 15_000 });
    await expect(riley.getByTestId("ai-composer")).toHaveCount(0);

    // ---- Everyone at <org>: an explicit confirmation; Cancel shares nothing.
    options = await search(people, "Everyone");
    await options.filter({ hasText: `Everyone at ${ADMIN.orgName}` }).click();
    await people.getByTestId("ai-share-submit").click();
    const confirm = people.getByTestId("ai-share-org-confirm");
    await expect(confirm).toContainText(`Everyone in ${ADMIN.orgName} will see this whole conversation`);
    await page.mouse.move(0, 0);
    await shot(page, `share-org-confirm-${w}`);
    await confirm.getByTestId("ai-share-org-cancel").click();
    await expect(confirm).toHaveCount(0);
    await expect(people.getByTestId("ai-share-grant").filter({ hasText: "Everyone" })).toHaveCount(0);
    const grants = (await (await victorApi.get(`/api/v1/ai-chats/${chatId}/grants`)).json()) as {
      grants: Array<{ subject: { kind: string } }>;
    };
    expect(grants.grants.map((g) => g.subject.kind).sort()).toEqual(["unit", "user"]);

    // ---- remove Alex, after a confirmation: his open page loses the chat at once.
    await grantAction(page, people, ALEX.name, "ai-share-grant-remove");
    const removal = people.getByTestId("ai-share-remove-confirm");
    await expect(removal).toContainText(ALEX.name);
    await removal.getByTestId("ai-share-remove-confirm-submit").click();
    await expect(people.getByTestId("ai-share-grant").filter({ hasText: ALEX.name })).toHaveCount(0);
    await expect(alex.getByText("You no longer have access to this chat.")).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // ---- the header: who is here (Riley, with a presence dot) and how widely it is shared.
    const header = page.getByTestId("ai-chat-header");
    const here = header.locator(`[data-testid="presence-avatar"][data-user-id="${rileyId}"]`);
    await expect(here).toBeVisible({ timeout: 15_000 });
    await expect(here.getByTestId("presence-dot")).toBeVisible();
    const audience = header.getByTestId("ai-chat-audience");
    await expect(audience).toHaveText("Shared with Backend");
    await audience.click();
    const list = page.getByTestId("ai-chat-participants-list").filter({ visible: true });
    await expect(list).toBeVisible();
    const row = (id: string) => list.locator(`[data-testid="ai-chat-participant"][data-id="${id}"]`);
    await expect(row(victorId)).toContainText("Owner");
    await expect(row(rileyId)).toContainText("Can view");
    await expect(row(alexId)).toHaveCount(0);
    await expect(list.getByTestId("ai-chat-participants-scope")).toContainText("Backend");
    await bothThemes(page, `participants-${w}`);
    await page.keyboard.press("Escape");

    // Riley sees the same people and the same scope, without owner controls.
    const rileyAudience = riley.getByTestId("ai-chat-header").getByTestId("ai-chat-audience");
    await expect(rileyAudience).toBeVisible();
    await rileyAudience.click();
    const rileyList = riley.getByTestId("ai-chat-participants-list").filter({ visible: true });
    await expect(
      rileyList.locator(`[data-testid="ai-chat-participant"][data-id="${victorId}"]`),
    ).toContainText("Owner");
    await expect(rileyList.getByTestId("ai-chat-add-agent")).toHaveCount(0);
    if (mobile) await shot(riley, `participants-${w}-riley`);
    await riley.keyboard.press("Escape");
  } finally {
    await victorApi.dispose();
    await owner.context.close();
    await alexCtx.context.close();
    await rileyCtx.context.close();
  }
});
