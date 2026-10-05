import { expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, shot } from "./env";

/**
 * Work Zone session controls (Phase 03.2, D-07 … D-16) with the REAL daemon in fake-runtime mode. The composer
 * follows the owner's reference (`reference/ref-1..3.png`): the model picker (search, favorites, provider rail,
 * ⌘1–⌘5, Legacy models), and every option comes from the catalog the device's runtime reported. The admin
 * changes the model of a live session, Sam (developer) watching the same session sees it live without
 * reloading, and the next turn runs on the new model (the fake says `Model: <id>`).
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

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** On a phone every composer menu is a bottom sheet; on a desktop a popover above its chip (D-16). */
async function expectSurface(page: Page, surface: Locator, mobile: boolean) {
  await expect(surface).toBeVisible();
  const vp = page.viewportSize()!;
  // A sheet slides up: measure once the open transition has settled at the bottom edge.
  if (mobile) {
    await expect
      .poll(async () => {
        const b = await surface.boundingBox();
        return b ? Math.round(b.y + b.height) : -1;
      })
      .toBe(vp.height);
  }
  const box = (await surface.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  if (mobile) {
    await expect(surface).toHaveAttribute("data-surface", "sheet");
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 1);
  } else {
    await expect(surface).toHaveAttribute("data-surface", "popover");
  }
}

test("Work Zone model picker (ref): search, favorites, provider rail, shortcuts and Legacy models drive a live model change", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
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
    await expect(chip.locator("[data-runtime-mark]")).toBeVisible();
    await expect(chip.locator("[data-chevron]")).toBeVisible();
    await bothThemes(page, `wz-composer-${tag}`);

    sam = await openAs(browser, SAM, info.project.name);
    await sam.page.goto(`${BASE_URL}/work-zone/${sessionId}`);
    await expect(sam.page.getByTestId("session-view")).toBeVisible();
    await expect(sam.page.getByTestId("model-chip")).toContainText("Claude Opus 5.5", { timeout: 15_000 });

    // ---- the picker: search box, rail (favorites + both runtimes), current models with shortcuts, Legacy row
    await chip.click();
    const picker = page.getByTestId("model-picker");
    await expectSurface(page, picker, mobile);
    await expect(picker.getByTestId("model-search")).toBeVisible();
    await expect(picker.getByTestId("model-rail-favorites")).toBeVisible();
    await expect(picker.getByTestId("model-rail-claude-code")).toHaveAttribute("aria-pressed", "true");
    await expect(picker.getByTestId("model-rail-codex")).toHaveAttribute("aria-pressed", "false");
    const options = picker.getByTestId("model-option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveAttribute("data-model-id", "opus");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(1)).toHaveAttribute("data-model-id", "sonnet");
    await expect(picker.getByTestId("model-favorite")).toHaveCount(4);
    await expect(picker.getByTestId("model-shortcut")).toHaveCount(mobile ? 0 : 4);
    if (!mobile) await expect(picker.getByTestId("model-shortcut").first()).toHaveText(/^(⌘|Ctrl)\s?1$/);
    const legacy = picker.getByTestId("legacy-models");
    await expect(legacy).toContainText("Legacy models");
    await expect(legacy).toContainText("1 model");
    // The fake Claude catalog carries no badge: no NEW is ever invented (D-08).
    await expect(picker.getByText("NEW", { exact: true })).toHaveCount(0);
    await bothThemes(page, `wz-model-picker-${tag}`);

    await legacy.click();
    await expect(options).toHaveCount(5);
    await expect(options.last()).toHaveAttribute("data-model-id", "claude-opus-4-6");
    await bothThemes(page, `wz-model-picker-${tag}-legacy`);

    // ---- search filters the rows
    await picker.getByTestId("model-search").fill("son");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("Claude Sonnet 5.5");
    await picker.getByTestId("model-search").fill("");
    await expect(options).toHaveCount(5);

    // ---- the other runtime is listed, disabled, with the D-08 sentence
    await picker.getByTestId("model-rail-codex").click();
    await expect(picker.getByTestId("model-provider-note")).toHaveText(
      "Switching provider inside a chat is not available yet",
    );
    await expect(options.first()).toContainText("GPT-6.1 Sol");
    await expect(options.first()).toHaveAttribute("aria-disabled", "true");
    await bothThemes(page, `wz-model-picker-${tag}-codex`);
    await picker.getByTestId("model-rail-claude-code").click();
    await expect(options.first()).toHaveAttribute("data-model-id", "opus");

    // ---- ⌘2 / Ctrl+2 (desktop) or a tap (phone) picks the second model; both controllers see it within 10 s
    if (mobile) await options.nth(1).click();
    else await page.keyboard.press("ControlOrMeta+2");
    await expect(picker).toBeHidden();
    await expect(chip).toContainText("Claude Sonnet 5.5", { timeout: 10_000 });
    await expect(sam.page.getByTestId("model-chip")).toContainText("Claude Sonnet 5.5", { timeout: 10_000 });
    await expect(sam.page.getByTestId("model-chip")).toHaveAttribute("data-pending", "false", {
      timeout: 10_000,
    });
    await shot(sam.page, `wz-controls-model-live-${tag}`);

    // ---- favorites: star Sonnet, the star filter shows only favorites, and it survives a reload
    await chip.click();
    await expect(picker).toBeVisible();
    await picker
      .locator('[data-testid="model-option"][data-model-id="sonnet"]')
      .getByTestId("model-favorite")
      .click();
    await picker.getByTestId("model-rail-favorites").click();
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveAttribute("data-model-id", "sonnet");
    await page.reload();
    await expect(chip).toContainText("Claude Sonnet 5.5", { timeout: 15_000 });
    await chip.click();
    await picker.getByTestId("model-rail-favorites").click();
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveAttribute("data-model-id", "sonnet");
    await bothThemes(page, `wz-model-picker-${tag}-favorites`);
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();

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
    await bothThemes(page, `wz-controls-model-turn-${tag}`);
  } finally {
    await sam?.context.close();
    if (sessionId) await adminApi.post(`/api/v1/work-sessions/${sessionId}/archive`, { data: {} });
    await device?.stop();
    await adminApi.dispose();
  }
});
