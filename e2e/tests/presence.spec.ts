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
 * Presence (RT-04, 03-01): two people with the same channel open see each other in the channel header; typing
 * still expires on its own; the person who closes the tab disappears from the header.
 */

test.describe.configure({ mode: "serial" });

const header = (page: Page) => page.getByTestId("channel-view").locator("header").first();

test("presence: who is here now in the channel header", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const adminId = await userIdOf(admin);
  const channelId = await createChannel(admin, `here-${project}-${Date.now().toString(36)}`);
  const samApi = await apiAs(SAM);
  await joinChannel(samApi, channelId);

  const a = await openAs(browser, ADMIN, project);
  const s = await openAs(browser, SAM, project);
  await a.page.goto(`${BASE_URL}/chat/${channelId}`);
  await expect(a.page.getByTestId("channel-title")).toBeVisible();
  // Alone: no stack at all.
  await expect(header(a.page).getByTestId("presence-stack")).toHaveCount(0);

  await s.page.goto(`${BASE_URL}/chat/${channelId}`);
  await expect(s.page.getByTestId("channel-title")).toBeVisible();

  // Each sees the other within 3 s, never themselves.
  const samOnA = header(a.page).locator(`[data-testid="presence-avatar"][data-user-id="${samId}"]`);
  const adminOnS = header(s.page).locator(`[data-testid="presence-avatar"][data-user-id="${adminId}"]`);
  await expect(samOnA).toHaveAttribute("data-state", "online", { timeout: 3000 });
  await expect(adminOnS).toHaveAttribute("data-state", "online", { timeout: 3000 });
  await expect(header(a.page).locator(`[data-user-id="${adminId}"]`)).toHaveCount(0);
  await expect(header(s.page).locator(`[data-user-id="${samId}"]`)).toHaveCount(0);
  await expect(header(a.page).getByTestId("presence-stack")).toHaveAttribute("aria-label", "1 here now");

  // Typing still reaches the other person and expires on its own (Phase 1 behaviour).
  const composer = s.page.getByTestId("composer");
  await composer.click();
  await composer.pressSequentially("quick question");
  const typedAt = Date.now();
  await expect(a.page.getByTestId("typing-indicator")).toContainText("is typing", { timeout: 3000 });
  await expect(a.page.getByTestId("typing-indicator")).not.toContainText("is typing", { timeout: 7000 });
  expect(Date.now() - typedAt).toBeLessThan(7000);
  await composer.fill("");

  // Screenshots of the header with Sam here: light and dark (desktop also shows the tooltip).
  if (project !== "mobile") {
    await header(a.page).getByTestId("presence-stack").hover();
    await expect(a.page.getByText("Here now")).toBeVisible();
  }
  await shot(a.page, `presence-header-${tag}`);
  await a.page.emulateMedia({ colorScheme: "dark" });
  await shot(a.page, `presence-header-${tag}-dark`);
  await a.page.emulateMedia({ colorScheme: "light" });
  await a.page.mouse.move(0, 0);

  // Sam closes the tab: gone from the admin's header within 3 s, and the stack disappears.
  await s.context.close();
  await expect(samOnA).toHaveCount(0, { timeout: 3000 });
  await expect(header(a.page).getByTestId("presence-stack")).toHaveCount(0);

  await a.context.close();
  await samApi.dispose();
  await admin.dispose();
});
