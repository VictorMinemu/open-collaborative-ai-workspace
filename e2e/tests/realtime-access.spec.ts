import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  request,
  test,
} from "@playwright/test";
import { BASE_URL, createChannel, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Live access (RT-01, 03-04 D-05): someone removed from a private channel loses its live stream at once. Their
 * open tab says they no longer have access, and the others see them leave the header. Leaving a channel yourself
 * is quiet: no "no access" message, no error.
 */

test.describe.configure({ mode: "serial" });

const header = (page: Page) => page.getByTestId("channel-view").locator("header").first();

/** An API context on a signed-in browser's session cookie (no extra sign-in). */
async function apiFrom(context: BrowserContext): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState: await context.storageState(),
  });
}

async function addMember(admin: APIRequestContext, channelId: string, userId: string) {
  const res = await admin.post(`/api/v1/channels/${channelId}/members`, {
    data: { kind: "user", id: userId },
  });
  expect(res.ok(), "add Sam to the channel").toBe(true);
}

test("access: removed from a private channel, the open tab loses it; leaving yourself is quiet", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const a = await openAs(browser, ADMIN, project);
  const admin = await apiFrom(a.context);
  const samId = await ensureMember(admin, SAM, "developer");
  const adminId = await userIdOf(admin);
  const suffix = `${project}-${Date.now().toString(36)}`;
  const name = `roadmap-${suffix}`;
  const privateId = await createChannel(admin, name, "private");
  const otherId = await createChannel(admin, `offsite-${suffix}`, "private");
  await addMember(admin, privateId, samId);
  await addMember(admin, otherId, samId);

  const s = await openAs(browser, SAM, project);
  await a.page.goto(`${BASE_URL}/chat/${privateId}`);
  await s.page.goto(`${BASE_URL}/chat/${privateId}`);
  await expect(a.page.getByTestId("channel-title")).toHaveText(name);
  await expect(s.page.getByTestId("channel-title")).toHaveText(name);
  const samOnA = header(a.page).locator(`[data-testid="presence-avatar"][data-user-id="${samId}"]`);
  await expect(samOnA).toBeVisible({ timeout: 3000 });
  await expect(
    header(s.page).locator(`[data-testid="presence-avatar"][data-user-id="${adminId}"]`),
  ).toBeVisible({ timeout: 3000 });

  // The admin removes Sam: Sam's tab says so within 3 s, and Sam leaves the admin's header.
  const t0 = Date.now();
  const removed = await admin.delete(`/api/v1/channels/${privateId}/members/user/${samId}`);
  expect(removed.ok(), "remove Sam").toBe(true);
  const lost = s.page.getByTestId("channel-access-lost");
  await expect(lost).toBeVisible({ timeout: 3000 });
  console.info(`access-lost shown after ${Date.now() - t0} ms (${project})`);
  await expect(lost).toContainText(`You no longer have access to #${name}`);
  await expect(s.page.getByTestId("composer")).toHaveCount(0);
  await expect(samOnA).toHaveCount(0, { timeout: 3000 });
  const back = lost.getByRole("link", { name: "Back to channels" });
  await expect(back).toBeInViewport();

  await shot(s.page, `access-lost-channel-${tag}`);
  await s.page.emulateMedia({ colorScheme: "dark" });
  await shot(s.page, `access-lost-channel-${tag}-dark`);
  await s.page.emulateMedia({ colorScheme: "light" });

  // Sam leaves another private channel from its menu: back on /chat, no access-lost message, no error toast.
  await s.page.goto(`${BASE_URL}/chat/${otherId}`);
  await expect(s.page.getByTestId("channel-title")).toHaveText(`offsite-${suffix}`);
  await expect(s.page.getByTestId("composer")).toBeVisible();
  await s.page.getByTestId("channel-menu").click();
  await s.page.getByRole("menuitem", { name: "Leave channel" }).click();
  await expect(s.page).not.toHaveURL(new RegExp(otherId), { timeout: 5000 });
  await expect(s.page).toHaveURL(/\/chat/);
  await s.page.waitForTimeout(1000);
  await expect(s.page.getByTestId("channel-access-lost")).toHaveCount(0);
  await expect(s.page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);

  await s.context.close();
  await a.context.close();
  await admin.dispose();
});
