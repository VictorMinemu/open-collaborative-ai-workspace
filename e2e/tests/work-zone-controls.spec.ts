import { expect, type Locator, type Page, test } from "@playwright/test";
// The inventory is code (WZC-06): the spec asserts what the UI offers against it, not against a copy.
import { isExposed } from "../../packages/contracts/src/runtime-controls/index.ts";
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

test("Work Zone reasoning and permission menus (ref): only real options, reasons for the rest, next-turn marker, phone sheets", async ({
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
  const claudeEffort = isExposed("claude-code", "effort");
  const claudeAuto = isExposed("claude-code", "mode.auto");

  try {
    device = await startFakeDevice(adminApi, { name: `E2E Menus ${tag}`, projectName: `menus-${tag}` });
    const created = await adminApi.post("/api/v1/work-sessions", {
      data: {
        projectId: device.projectId,
        runtime: "claude-code",
        permissionMode: "plan",
        title: `Menus ${tag}`,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    sessionId = ((await created.json()) as { id: string }).id;

    await signIn(page);
    await page.goto(`/work-zone/${sessionId}`);
    const view = page.getByTestId("session-view");
    await expect(view).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
    sam = await openAs(browser, SAM, info.project.name);
    await sam.page.goto(`${BASE_URL}/work-zone/${sessionId}`);

    // ---- the bar of ref-1: model · reasoning · permission, attach (disabled, never faked) and send
    const reasoningChip = page.getByTestId("reasoning-chip");
    const permissionChip = page.getByTestId("permission-chip");
    await expect(reasoningChip).toHaveText(claudeEffort ? /Medium · 1M/ : /1M/, { timeout: 15_000 });
    await expect(permissionChip).toContainText("Plan");
    const attach = page.getByTestId("attach");
    await expect(attach).toBeDisabled();
    await expect(attach).toHaveAttribute("aria-label", /Attachments arrive with file uploads/);

    // ---- reasoning menu (ref-2): sections, Default tag, fast mode disabled by the default policy with its cost
    await reasoningChip.click();
    const reasoning = page.getByTestId("reasoning-menu");
    await expectSurface(page, reasoning, mobile);
    await expect(reasoning.getByRole("group", { name: "Reasoning" })).toHaveCount(claudeEffort ? 1 : 0);
    const efforts = reasoning.locator('[data-testid="reasoning-option"][data-kind="effort"]');
    if (claudeEffort) {
      await expect(efforts).toHaveText([/^Low/, /^Medium\s*Default/, /^High/, /^Extra High/, /^Max/]);
      await expect(efforts.nth(1)).toHaveAttribute("aria-selected", "true");
    } else await expect(efforts).toHaveCount(0);
    // Opus 5.5 runs a fixed 1M window: shown read-only, no 200k (D-10).
    await expect(reasoning.getByTestId("context-fixed")).toHaveText(/1M/);
    await expect(reasoning.locator('[data-kind="context"]')).toHaveCount(0);
    const fastOn = reasoning.locator('[data-testid="reasoning-option"][data-kind="fast"][data-value="on"]');
    await expect(fastOn).toHaveAttribute("aria-disabled", "true");
    await expect(fastOn).toContainText("Not allowed by your organization");
    await expect(reasoning).toContainText("paid usage credits");
    await expect(reasoning).not.toContainText(/Ultracode|Ultrathink/i);
    await bothThemes(page, `wz-reasoning-menu-${tag}`);

    if (claudeEffort) {
      await efforts.nth(3).click();
      await expect(reasoning).toBeHidden();
      await expect(reasoningChip).toHaveText(/Extra High · 1M/, { timeout: 10_000 });
      await expect(sam.page.getByTestId("reasoning-chip")).toHaveText(/Extra High · 1M/, { timeout: 10_000 });
    } else await page.keyboard.press("Escape");

    // ---- permission menu (ref-1) plus Plan: descriptions, Full access refused by the org with its reason
    await permissionChip.click();
    const permission = page.getByTestId("permission-menu");
    await expectSurface(page, permission, mobile);
    const modes = permission.getByTestId("permission-option");
    await expect(modes.locator("[data-label]")).toHaveText(
      claudeAuto
        ? ["Supervised", "Auto-accept edits", "Auto", "Full access", "Plan"]
        : ["Supervised", "Auto-accept edits", "Full access", "Plan"],
    );
    await expect(permission).toContainText("Ask before commands and file changes.");
    await expect(permission).toContainText("Allow commands and edits without prompts.");
    const full = permission.locator('[data-testid="permission-option"][data-value="fullAccess"]');
    await expect(full).toHaveAttribute("aria-disabled", "true");
    await expect(full).toContainText("Not allowed by your organization");
    if (claudeAuto) {
      await expect(
        permission.locator('[data-testid="permission-option"][data-value="auto"]'),
      ).toHaveAttribute("aria-disabled", "false");
    }
    await expect(permission.locator('[data-value="plan"]')).toHaveAttribute("aria-selected", "true");
    await bothThemes(page, `wz-permission-menu-${tag}`);

    // ---- Supervised: the fake asks before writing, so the turn waits; a change now applies to the next turn
    await permission.locator('[data-value="default"]').click();
    await expect(permission).toBeHidden();
    await expect(permissionChip).toContainText("Supervised", { timeout: 10_000 });
    await expect(sam.page.getByTestId("permission-chip")).toContainText("Supervised", { timeout: 10_000 });
    await page.getByTestId("composer").fill("Add a short CONTRIBUTING guide for new teammates");
    await page.getByTestId("send-prompt").click();
    const banner = page.getByTestId("approval-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await permissionChip.click();
    await permission.locator('[data-value="acceptEdits"]').click();
    await expect(page.getByTestId("settings-pending")).toHaveText("Applies to the next turn", {
      timeout: 10_000,
    });
    await expect(sam.page.getByTestId("settings-pending")).toBeVisible({ timeout: 10_000 });
    await bothThemes(page, `wz-composer-${tag}-pending`);
    await banner.getByTestId("approve-once").click();
    await expect(view).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
    // The next turn runs with the new mode (the device applies it first and reports it): the marker goes away.
    await page.getByTestId("composer").fill("Then add a changelog entry for the guide");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("Mode: acceptEdits", {
      timeout: 30_000,
    });
    await expect(view).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
    await expect(page.getByTestId("settings-pending")).toHaveCount(0, { timeout: 15_000 });
    await expect(sam.page.getByTestId("settings-pending")).toHaveCount(0, { timeout: 15_000 });
    await expect(permissionChip).toContainText("Auto-accept edits");

    // ---- switching to a model without efforts, windows or fast mode resets the reasoning chip (WZC-02)
    await page.getByTestId("model-chip").click();
    await page.locator('[data-testid="model-option"][data-model-id="haiku"]').click();
    await expect(page.getByTestId("model-chip")).toContainText("Claude Haiku 4.5", { timeout: 10_000 });
    await expect(reasoningChip).toHaveCount(0, { timeout: 10_000 });
    await expect(sam.page.getByTestId("reasoning-chip")).toHaveCount(0, { timeout: 10_000 });
    await bothThemes(page, `wz-composer-${tag}-haiku`);
  } finally {
    await sam?.context.close();
    if (sessionId) await adminApi.post(`/api/v1/work-sessions/${sessionId}/archive`, { data: {} });
    await device?.stop();
    await adminApi.dispose();
  }
});
