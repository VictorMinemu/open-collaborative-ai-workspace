import { expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, shot } from "./env";

/**
 * Slash commands in the Work Zone composer (Phase 03.2 Plan 07, D-13, P-10) with the REAL daemon in fake-runtime
 * mode: `/model <id>` typed by the admin changes the session's model through the policy-checked settings path and
 * shows live on Sam's page; `/config` is refused with a notice. No prompt is queued for either command.
 */

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page).toHaveURL(/\/chat/);
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text });

test("Work Zone slash commands: /model changes the chip for both controllers; /config is refused", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const adminApi = await apiAs(ADMIN);
  await ensureMember(adminApi, SAM, "developer");
  let device: FakeDeviceHandle | null = null;
  let sessionId: string | null = null;
  let sam: Awaited<ReturnType<typeof openAs>> | null = null;

  try {
    device = await startFakeDevice(adminApi, { name: `E2E Slash ${tag}`, projectName: `slash-${tag}` });
    const created = await adminApi.post("/api/v1/work-sessions", {
      data: {
        projectId: device.projectId,
        runtime: "claude-code",
        permissionMode: "plan",
        title: `Slash ${tag}`,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    sessionId = ((await created.json()) as { id: string }).id;

    await signIn(page);
    await page.goto(`/work-zone/${sessionId}`);
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });
    const chip = page.getByTestId("model-chip");
    await expect(chip).toContainText("Claude Opus 5.5", { timeout: 15_000 });

    sam = await openAs(browser, SAM, info.project.name);
    await sam.page.goto(`${BASE_URL}/work-zone/${sessionId}`);
    await expect(sam.page.getByTestId("model-chip")).toContainText("Claude Opus 5.5", { timeout: 15_000 });

    // ---- the admin types `/model sonnet` and presses Enter
    const composer = page.getByTestId("composer");
    await composer.fill("/model sonnet");
    await composer.press("Enter");
    await expect(toast(page, "Model set to Claude Sonnet 5.5 — applies to the next turn")).toBeVisible({
      timeout: 10_000,
    });
    await expect(composer).toHaveValue("");
    await expect(chip).toContainText("Claude Sonnet 5.5", { timeout: 10_000 });
    await expect(sam.page.getByTestId("model-chip")).toContainText("Claude Sonnet 5.5", { timeout: 10_000 });
    // The command never became a prompt.
    await expect(page.getByTestId("prompt-bubble")).toHaveCount(0);
    await expect(sam.page.getByTestId("prompt-bubble")).toHaveCount(0);
    await shot(page, `wz-slash-${tag}`);
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, `wz-slash-${tag}-dark`);
    await page.emulateMedia({ colorScheme: "light" });

    // ---- `/config` would change runtime configuration outside the platform: refused with a notice, nothing runs
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
    await composer.fill("/config");
    await composer.press("Enter");
    await expect(
      toast(page, "/config is not available from the workspace. Use the session controls."),
    ).toBeVisible({ timeout: 10_000 });
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("prompt-bubble")).toHaveCount(0);
    await expect(sam.page.getByTestId("prompt-bubble")).toHaveCount(0);
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle");
    await shot(page, `wz-slash-refused-${tag}`);
  } finally {
    await sam?.context.close();
    if (sessionId) await adminApi.post(`/api/v1/work-sessions/${sessionId}/archive`, { data: {} });
    await device?.stop();
    await adminApi.dispose();
  }
});
