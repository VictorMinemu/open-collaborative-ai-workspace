import { expect, test } from "@playwright/test";
import { ADMIN, API_URL, SETUP_TOKEN, shot } from "./env";

test("first-run setup creates the organization and its admin", async ({ page, request }) => {
  const status = await (await request.get(`${API_URL}/api/v1/setup/status`)).json();
  test.skip(
    status.setupComplete,
    "stack already set up — run against a fresh stack (docker compose down -v)",
  );
  expect(SETUP_TOKEN, "OCW_SETUP_TOKEN (env or .env)").not.toBe("");

  await page.goto("/setup");
  await expect(page.getByTestId("setup-form")).toBeVisible();
  await shot(page, "setup-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "setup-390");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByLabel("Organization name").fill(ADMIN.orgName);
  await page.getByLabel("Your name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("setup-form")
    .getByRole("button", { name: /create|set up|continue/i })
    .click();

  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("org-name").first()).toHaveText(ADMIN.orgName);
});
