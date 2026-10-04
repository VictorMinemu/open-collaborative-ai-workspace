import { expect, type Page, test } from "@playwright/test";
import {
  apiAs,
  BASE_URL,
  createChannel,
  ensureMember,
  joinChannel,
  openAs,
  SAM,
  userIdOf,
} from "../support/actors";
import { ADMIN, shot } from "./env";

/**
 * Away (RT-04, 03-02 D-04): when Sam hides the tab, the admin (same channel open) sees Sam turn Away (amber dot,
 * dimmed avatar, "Away" in the tooltip); when Sam comes back and moves the mouse, Sam is Active again.
 */

test.describe.configure({ mode: "serial" });

const header = (page: Page) => page.getByTestId("channel-view").locator("header").first();

/** Headless tabs are always visible: fake the Page Visibility API and announce the change like a real switch. */
async function setTabHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (h ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("presence: a hidden tab shows its owner as Away, coming back shows Active", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const adminId = await userIdOf(admin);
  const channelId = await createChannel(admin, `away-${project}-${Date.now().toString(36)}`);
  const samApi = await apiAs(SAM);
  await joinChannel(samApi, channelId);

  const a = await openAs(browser, ADMIN, project);
  const s = await openAs(browser, SAM, project);
  await a.page.goto(`${BASE_URL}/chat/${channelId}`);
  await expect(a.page.getByTestId("channel-title")).toBeVisible();
  await s.page.goto(`${BASE_URL}/chat/${channelId}`);
  await expect(s.page.getByTestId("channel-title")).toBeVisible();

  const samOnA = header(a.page).locator(`[data-testid="presence-avatar"][data-user-id="${samId}"]`);
  const adminOnS = header(s.page).locator(`[data-testid="presence-avatar"][data-user-id="${adminId}"]`);
  await expect(samOnA).toHaveAttribute("data-state", "online", { timeout: 3000 });
  await expect(adminOnS).toHaveAttribute("data-state", "online", { timeout: 3000 });

  // Sam switches away from the tab: Away for the admin within 2 s; the admin stays Active for Sam.
  const hiddenAt = Date.now();
  await setTabHidden(s.page, true);
  await expect(samOnA).toHaveAttribute("data-state", "away", { timeout: 2000 });
  const awayMs = Date.now() - hiddenAt;
  await expect(samOnA.getByTestId("presence-dot")).toHaveAttribute("aria-label", "Away");
  await expect(adminOnS).toHaveAttribute("data-state", "online");

  // Screenshots with Sam away: light and dark (desktop also shows the tooltip).
  if (project !== "mobile") {
    await header(a.page).getByTestId("presence-stack").hover();
    await expect(a.page.getByText("Here now")).toBeVisible();
    await expect(a.page.getByText("Away", { exact: true })).toBeVisible();
  }
  await shot(a.page, `presence-away-${tag}`);
  await a.page.emulateMedia({ colorScheme: "dark" });
  await shot(a.page, `presence-away-${tag}-dark`);
  await a.page.emulateMedia({ colorScheme: "light" });
  await a.page.mouse.move(0, 0);

  // Sam comes back and moves the mouse: Active again within 2 s.
  const backAt = Date.now();
  await setTabHidden(s.page, false);
  await s.page.mouse.move(200, 300);
  await expect(samOnA).toHaveAttribute("data-state", "online", { timeout: 2000 });
  const onlineMs = Date.now() - backAt;
  await expect(samOnA.getByTestId("presence-dot")).toHaveAttribute("aria-label", "Active");
  console.info(`[${project}] away propagation ${awayMs} ms, online propagation ${onlineMs} ms`);

  await s.context.close();
  await a.context.close();
  await samApi.dispose();
  await admin.dispose();
});
