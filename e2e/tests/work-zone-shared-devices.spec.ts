import { expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, shot } from "./env";

/**
 * Shared devices (Phase 03.2 Plan 05, D-05, D-06, WZC-05) with the REAL daemon in fake-runtime mode: the owner
 * shares a device with Sam capped at Auto-accept edits from Settings › Devices; Sam starts a session on it with
 * no acceptance step and gets the first assistant message; the owner removes Sam and Sam's session stops. Device
 * cards say whose subscription runs the sessions and show the device's Full access opt-in read-only.
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

test("Shared devices: the owner shares with Sam at a cap, Sam starts a session, removal stops it", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const adminApi = await apiAs(ADMIN);
  const samId = await ensureMember(adminApi, SAM, "developer");
  const deviceName = `E2E Server ${tag}`;
  let device: FakeDeviceHandle | null = null;
  let sessionId: string | null = null;
  let sam: Awaited<ReturnType<typeof openAs>> | null = null;

  try {
    device = await startFakeDevice(adminApi, { name: deviceName, projectName: `shared-${tag}` });

    // ---- the owner adds Sam under "Specific people and teams" and caps them at Auto-accept edits
    await signIn(page);
    await page.goto("/settings/devices");
    const card = page.getByTestId("device-card").filter({ hasText: deviceName });
    await expect(card).toHaveAttribute("data-status", "online", { timeout: 15_000 });
    const sharing = card.getByTestId("device-sharing");
    await expect(sharing).toContainText("Everyone in the organization");
    await expect(sharing.getByTestId("share-everyone")).toBeVisible();
    await sharing.getByTestId("add-grant").click();
    const dialog = page.getByTestId("add-grant-dialog");
    await dialog.getByTestId("add-grant-search").fill("Sam");
    await dialog.locator(`[data-testid="grant-option"][data-principal-id="${samId}"]`).click();
    await expect(dialog).toBeHidden();
    const row = sharing.locator(`[data-testid="grant-row"][data-principal-id="${samId}"]`);
    await expect(row).toContainText(SAM.name);
    await expect(row.getByTestId("grant-mode")).toContainText("Supervised");
    await row.getByTestId("grant-mode").click();
    await page.getByRole("option", { name: /Auto-accept edits/ }).click();
    await expect(row.getByTestId("grant-mode")).toContainText("Auto-accept edits", { timeout: 10_000 });
    const grants = (await (await adminApi.get(`/api/v1/devices/${device.deviceId}/grants`)).json()) as {
      grants: Array<{ principalId: string; maxMode: string }>;
    };
    expect(grants.grants).toEqual([expect.objectContaining({ principalId: samId, maxMode: "acceptEdits" })]);
    await card.scrollIntoViewIfNeeded();
    await bothThemes(page, `wz-shared-device-${tag}`);

    // ---- whose subscription the device uses, and the read-only Full access opt-in (D-06, ADR-0012 §5)
    const subscription = card.getByTestId("device-subscription");
    await expect(subscription).toContainText("Claude Code runs on your Claude login");
    await expect(subscription).toContainText("Codex runs on your ChatGPT login");
    await expect(sharing.getByTestId("share-subscription-note")).toHaveText(
      "People you share with use this subscription.",
    );
    const fullAccess = card.getByTestId("device-full-access");
    await expect(fullAccess).toHaveAttribute("data-enabled", "false");
    await expect(fullAccess).toContainText(
      "Off — enable it on the device (desktop app › Runtime › Allow Full access, or ocw-runtime full-access on)",
    );
    await expect(fullAccess).toContainText("Recommended only on a dedicated machine");
    await expect(fullAccess.getByRole("switch")).toHaveCount(0);
    // Without the device's opt-in, Full access cannot be picked as anyone's maximum.
    await row.getByTestId("grant-mode").click();
    await expect(page.getByRole("option", { name: /Full access/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("option", { name: /Full access/ })).toContainText(
      "Turn on Full access on the device first",
    );
    await page.keyboard.press("Escape");
    await fullAccess.scrollIntoViewIfNeeded();
    await bothThemes(page, `wz-device-settings-${tag}`);

    // ---- Sam sees the device's project and starts a session on it, no acceptance step
    sam = await openAs(browser, SAM, info.project.name);
    await sam.page.goto(`${BASE_URL}/settings/devices`);
    const samCard = sam.page.getByTestId("device-card").filter({ hasText: deviceName });
    await expect(samCard.getByTestId("device-subscription")).toContainText(
      `Claude Code runs on ${ADMIN.name}'s Claude login`,
    );
    await expect(samCard.getByTestId("device-sharing")).toHaveCount(0);
    await sam.page.goto(`${BASE_URL}/work-zone`);
    await sam.page.getByTestId("new-session").click();
    const start = sam.page.getByTestId("new-session-dialog");
    await expect(start).toBeVisible();
    await start
      .getByTestId("project-option")
      .filter({ hasText: `shared-${tag}` })
      .click();
    await start.getByTestId("runtime-claude-code").click();
    await start.getByTestId("mode-acceptEdits").click();
    await start.getByTestId("first-prompt").fill("Add a short CONTRIBUTING guide for new teammates");
    await start.getByTestId("start-session").click();
    await expect(sam.page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    sessionId = sam.page.url().split("/").pop()!;
    await expect(sam.page.getByTestId("assistant-message").first()).toContainText("I'll start by reading", {
      timeout: 30_000,
    });
    await expect(sam.page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });

    // ---- the owner removes Sam: Sam's session on the device stops
    await row.getByTestId("grant-remove").click();
    await page.getByTestId("confirm-remove-grant").click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const res = await adminApi.get(`/api/v1/work-sessions/${sessionId}`);
          return ((await res.json()) as { session?: { status?: string } }).session?.status;
        },
        { timeout: 15_000, message: "Sam's session stops after the removal" },
      )
      .toBe("failed");
  } finally {
    await sam?.context.close();
    if (sessionId) await adminApi.post(`/api/v1/work-sessions/${sessionId}/archive`, { data: {} });
    await device?.stop();
    await adminApi.dispose();
  }
});
