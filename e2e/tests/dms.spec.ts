import { expect, type Page, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { postAs } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * CHAT-04 (D-06): direct messages between people. The admin opens a DM with a colleague from the New message
 * picker; it appears in both sidebars live and messages flow both ways; "Message" on the colleague's card in the
 * search palette lands in the same conversation.
 */

/** One colleague per project, so desktop and mobile each create their own DM. */
const COLLEAGUE: Record<string, Actor> = {
  desktop: { name: "Rosa Díaz", email: "rosa@ocw.test", password: "rosa-e2e-password-123" },
  mobile: { name: "Theo Park", email: "theo@ocw.test", password: "theo-e2e-password-123" },
};

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Opens the sidebar on phones (it lives in the navigation sheet there). */
async function openNav(page: Page, mobile: boolean) {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
}

async function openPalette(page: Page, mobile: boolean) {
  if (mobile) await page.getByTestId("open-search").click();
  else await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId("search-input")).toBeFocused();
  return palette;
}

test.describe.configure({ mode: "serial" });

test("a member opens a DM with a colleague from New message; both chat live; search opens the same DM", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const colleague = COLLEAGUE[project] ?? (COLLEAGUE.desktop as Actor);

  const admin = await apiAs(ADMIN);
  const colleagueId = await ensureMember(admin, colleague, "developer");

  // The colleague is already in the app, on a channel, when the DM is created.
  const them = await openAs(browser, colleague, project);
  const me = await openAs(browser, ADMIN, project);

  // ---- New message → pick the colleague → Go
  await openNav(me.page, mobile);
  await me.page.getByTestId("dm-section").getByTestId("new-dm").click();
  const dialog = me.page.getByTestId("new-dm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-dm-input")).toBeFocused();
  if (mobile) {
    // A full-height sheet on phones.
    const box = await dialog.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(800);
  }
  await dialog
    .getByTestId("new-dm-input")
    .pressSequentially(colleague.name.split(" ")[0] ?? "", { delay: 20 });
  await dialog.locator(`[data-testid="new-dm-option"][data-name="${colleague.name}"]`).click();
  await expect(dialog.getByTestId("new-dm-chip")).toContainText(colleague.name);
  await expect(dialog.getByTestId("new-dm-hint")).toHaveText("Direct message");
  await bothThemes(me.page, `dm-new-dialog-${tag}`);
  await dialog.getByTestId("new-dm-go").click();

  await expect(me.page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const dmId = me.page.url().match(/\/chat\/dm\/([0-9a-f-]{36})/)?.[1] ?? "";
  await expect(me.page.getByTestId("dm-view")).toHaveAttribute("data-dm-kind", "user");
  await expect(me.page.getByTestId("dm-title")).toHaveText(colleague.name);
  await expect(me.page.getByTestId("new-dm-dialog")).toBeHidden();

  // ---- the colleague's sidebar lists it live (no reload)
  await openNav(them.page, mobile);
  const link = them.page.locator(`[data-testid="dm-link"][href="/chat/dm/${dmId}"]`);
  await expect(link).toBeVisible({ timeout: 5_000 });
  await expect(link).toContainText(ADMIN.name);
  await link.click();
  await expect(them.page.getByTestId("dm-title")).toHaveText(ADMIN.name);

  // ---- a message each way, live
  const word = Date.now().toString(36);
  const box = them.page.getByTestId("composer");
  await box.click();
  await box.fill(`hola ${word}, ¿tienes un minuto?`);
  await box.press("Enter");
  await expect(me.page.getByText(`hola ${word}, ¿tienes un minuto?`)).toBeVisible({ timeout: 10_000 });
  const mine = me.page.getByTestId("composer");
  await mine.click();
  await mine.fill(`Claro ${word}, dime`);
  await mine.press("Enter");
  await expect(them.page.getByText(`Claro ${word}, dime`)).toBeVisible({ timeout: 10_000 });
  await bothThemes(me.page, `dm-human-${tag}`);
  await them.context.close();

  // ---- search palette: the colleague's card → Message → the same DM
  await me.page.goto(`${BASE_URL}/chat`);
  await expect(me.page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(me.page.getByTestId("composer")).toBeVisible();
  const palette = await openPalette(me.page, mobile);
  await palette
    .getByTestId("search-input")
    .pressSequentially(colleague.name.split(" ")[0] ?? "", { delay: 30 });
  const person = palette.locator(`[data-kind="person"][data-person-id="${colleagueId}"]`);
  await expect(person).toBeVisible();
  await person.click();
  await expect(palette.getByTestId("search-profile")).toContainText(colleague.name);
  await palette.getByTestId("search-profile-message").click();
  await expect(palette).toBeHidden();
  await expect(me.page).toHaveURL(new RegExp(`/chat/dm/${dmId}$`));
  await expect(me.page.getByText(`Claro ${word}, dime`)).toBeVisible();
  await me.context.close();

  // Over the API the same pair always resolves to this conversation.
  const again = await admin.post("/api/v1/dms", {
    data: { participants: [{ kind: "user", id: colleagueId }] },
  });
  expect(((await again.json()) as { id: string }).id).toBe(dmId);
  await postAs(admin, dmId, `api ${word}`);
  await admin.dispose();
});
