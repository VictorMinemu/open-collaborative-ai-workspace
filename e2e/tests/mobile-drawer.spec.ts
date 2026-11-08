import { expect, test } from "@playwright/test";
import { expectChannelLanding } from "../support/actors";
import { ADMIN } from "./env";

/**
 * The phone navigation drawer closes after a navigation the person starts while it is open (an item in it, or
 * back), never after one they did not start. `/chat` shows the shell first and then redirects to the default channel
 * once the channel list loads; a tap on the menu inside that window used to open the drawer and see the redirect shut
 * it at once (07.2 gate, smoke.spec on mobile). The channel list is held here so the tap always lands in the window.
 */
test("the drawer opened before /chat's redirect stays open; a navigation from it, or back, closes it", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "the drawer is the phone navigation");

  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expectChannelLanding(page);

  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(
    (url) => url.pathname === "/api/v1/channels",
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await page.goto("/chat");
  await expect(page.getByTestId("app-shell")).toBeVisible();

  const trigger = page.getByTestId("mobile-nav-trigger");
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/\/chat$/);

  // The channel list arrives and /chat redirects to #general behind the open drawer.
  release();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  // Rendered by a later commit than the redirect's, so the route-change effects have run by now.
  await expect(page.getByText("Welcome to #general", { exact: true })).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toBeVisible();
  await page.unroute((url) => url.pathname === "/api/v1/channels");

  // An item of the section sidebar portalled into the drawer: the navigation is the person's, the drawer closes.
  await drawer.getByTestId("view-threads").click();
  await expect(page).toHaveURL(/\/chat\/threads$/);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toBeHidden();

  // Back with the drawer open closes it too.
  await trigger.click();
  await expect(drawer).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toBeHidden();
});
