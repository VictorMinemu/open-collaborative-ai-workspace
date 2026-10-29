import { expect, test } from "@playwright/test";
import { ADMIN, shot } from "./env";

test("login → app shell → navigate → sign out", async ({ page }, info) => {
  const tag = info.project.name === "mobile" ? "390" : "1440";
  const mobile = info.project.name === "mobile";

  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId("login-form")).toBeVisible();
  await shot(page, `login-${tag}`);

  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();

  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("connection-status").first()).toBeAttached();
  await shot(page, `shell-chat-${tag}`);
  // `/chat` opens the default channel once the channel list loads; navigate only after that redirect settled, or the
  // redirect lands after the Settings click and wins.
  await expect(async () => {
    const opened = /\/chat\/[^/?#]+/.test(page.url());
    const empty = await page.getByText("Start the first conversation").isVisible();
    expect(opened || empty).toBe(true);
  }).toPass();

  if (mobile) {
    await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, `shell-drawer-${tag}`);
  }
  await page.getByTestId("nav-settings").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByText(ADMIN.email).first()).toBeVisible();
  await shot(page, `settings-${tag}`);

  // Session survives a reload (cookie session).
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();

  for (const [id, path] of [
    ["nav-bots", /\/bots/],
    ["nav-work-zone", /\/work-zone/],
  ] as const) {
    if (mobile) await page.getByTestId("mobile-nav-trigger").click();
    await page.getByTestId(id).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(path);
  }
  await shot(page, `work-zone-${tag}`);
});
