import { expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, shot } from "./env";

/**
 * Work Zone session controls (Phase 03.2, D-07, D-08, D-14) with the REAL daemon in fake-runtime mode: the
 * admin changes the model of a live session from the composer chip, Sam (developer) watching the same session
 * sees it live without reloading, and the next turn runs on the new model (the fake says `Model: <id>`).
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

test("Work Zone controls: a model change by one controller shows live to another and runs the next turn", async ({
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
    device = await startFakeDevice(adminApi, {
      name: `E2E Controls ${tag}`,
      projectName: `controls-${tag}`,
    });
    // Plan mode: the fake never asks for approval, so the turn runs straight through.
    const created = await adminApi.post("/api/v1/work-sessions", {
      data: {
        projectId: device.projectId,
        runtime: "claude-code",
        permissionMode: "plan",
        title: `Controls ${tag}`,
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
    // The device's runtime reported its catalog: the default model is shown, never a hard-coded name.
    await expect(chip).toContainText("Claude Opus 5.5", { timeout: 15_000 });
    await expect(chip).toBeEnabled();

    sam = await openAs(browser, SAM, info.project.name);
    await sam.page.goto(`${BASE_URL}/work-zone/${sessionId}`);
    await expect(sam.page.getByTestId("session-view")).toBeVisible();
    await expect(sam.page.getByTestId("model-chip")).toContainText("Claude Opus 5.5", { timeout: 15_000 });

    // ---- the admin opens the chip: only the catalog's models, the current one checked
    await chip.click();
    const options = page.getByTestId("model-option");
    await expect(options).toHaveCount(5);
    await expect(options.nth(1)).toHaveAttribute("data-model-id", "sonnet");
    const menuBox = await options.last().boundingBox();
    expect(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= page.viewportSize()!.width).toBe(true);
    await shot(page, `wz-controls-model-${tag}`);
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, `wz-controls-model-${tag}-dark`);
    await page.emulateMedia({ colorScheme: "light" });

    // ---- picks the second catalog model; both controllers see it within 10 s
    await options.nth(1).click();
    await expect(chip).toContainText("Claude Sonnet 5.5", { timeout: 10_000 });
    await expect(sam.page.getByTestId("model-chip")).toContainText("Claude Sonnet 5.5", { timeout: 10_000 });
    await expect(sam.page.getByTestId("model-chip")).toHaveAttribute("data-pending", "false", {
      timeout: 10_000,
    });
    await shot(sam.page, `wz-controls-model-live-${tag}`);

    // ---- the next turn runs on the new model
    await page.getByTestId("composer").fill("Summarise the README for a new teammate");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("Model: sonnet", {
      timeout: 30_000,
    });
    await expect(sam.page.getByTestId("assistant-message").last()).toContainText("Model: sonnet", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });
    await shot(page, `wz-controls-model-turn-${tag}`);
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, `wz-controls-model-turn-${tag}-dark`);
    await page.emulateMedia({ colorScheme: "light" });
  } finally {
    await sam?.context.close();
    if (sessionId) await adminApi.post(`/api/v1/work-sessions/${sessionId}/archive`, { data: {} });
    await device?.stop();
    await adminApi.dispose();
  }
});
