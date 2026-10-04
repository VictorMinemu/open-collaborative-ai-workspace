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
 * Presence (RT-04, 03-01, 03-03): two people with the same channel open see each other in the channel header and
 * in the members dialog (present people first); typing still expires on its own; the person who closes the tab
 * disappears from both.
 */

/** A member of the channel who never opens the app (local to this spec; actors.ts is frozen). */
const RIO = { name: "Rio Alvarez", email: "rio@ocw.test", password: "rio-e2e-password-123" };

test.describe.configure({ mode: "serial" });

const header = (page: Page) => page.getByTestId("channel-view").locator("header").first();

test("presence: who is here now in the channel header", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const adminId = await userIdOf(admin);
  const rioId = await ensureMember(admin, RIO, "developer");
  const channelId = await createChannel(admin, `here-${project}-${Date.now().toString(36)}`);
  // Rio joins before Sam, so "present first" has to move Sam above Rio in the members dialog.
  const addRio = await admin.post(`/api/v1/channels/${channelId}/members`, {
    data: { kind: "user", id: rioId },
  });
  expect(addRio.ok(), "add Rio to the channel").toBe(true);
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

  // Members dialog (03-03, D-08): Sam is Active and listed before Rio, who is not here; "1 here now".
  await a.page.getByTestId("channel-members-button").click();
  const dialog = a.page.getByTestId("members-dialog");
  const row = (id: string) => dialog.locator(`[data-testid="member-presence"][data-user-id="${id}"]`);
  await expect(row(samId)).toHaveAttribute("data-state", "online", { timeout: 3000 });
  await expect(row(rioId)).toHaveAttribute("data-state", "offline");
  await expect(row(adminId)).toHaveAttribute("data-state", "online");
  const order = await dialog
    .getByTestId("member-presence")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-user-id")));
  expect(order.indexOf(samId)).toBeGreaterThanOrEqual(0);
  expect(order.indexOf(samId)).toBeLessThan(order.indexOf(rioId));
  await expect(dialog.getByTestId("members-here-now")).toHaveText("· 1 here now");
  await expect(row(samId).getByTestId("presence-dot")).toBeVisible();
  await expect(row(rioId).getByTestId("presence-dot")).toHaveCount(0);
  await shot(a.page, `presence-members-${tag}`);
  await a.page.emulateMedia({ colorScheme: "dark" });
  await shot(a.page, `presence-members-${tag}-dark`);
  await a.page.emulateMedia({ colorScheme: "light" });

  // Sam closes the tab: offline in the dialog and gone from the admin's header within 3 s.
  await s.context.close();
  await expect(row(samId)).toHaveAttribute("data-state", "offline", { timeout: 3000 });
  await expect(dialog.getByTestId("members-here-now")).toHaveCount(0);
  await expect(samOnA).toHaveCount(0, { timeout: 3000 });
  await expect(header(a.page).getByTestId("presence-stack")).toHaveCount(0);

  await a.context.close();
  await samApi.dispose();
  await admin.dispose();
});
