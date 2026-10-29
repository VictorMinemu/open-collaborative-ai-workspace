import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import { expectNoSidewaysScroll, expectTouchTargets, unnamedControls } from "../support/layout";
import { pollPairingToken, startPairing } from "../support/pairing";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Terminal pairing, the owner's side (Phase 07.12-07, D-01…D-03, D-13, PD-14, HSR-03), on the real stack. A "server"
 * here is this test process doing what `ocw-runtime setup` does (start a pairing anonymously, poll the token route);
 * the owner approves or denies it in Settings › Devices:
 * - from the link the server printed (`?pair=CODE`): compare the code, rename, Approve, "Device connected";
 * - from Add a device › Server: the install command for this workspace, `ocw-runtime setup`, the code field;
 * - Deny, an unknown code, and a signed-out owner who keeps the code through sign-in.
 * Every state passes axe (no serious issue), names every control, never scrolls sideways and keeps 44 px targets below
 * 1024, on both projects (1440 and 390) and in light and dark; screenshots go to OCW_E2E_SCREENSHOT_DIR.
 */

test.describe.configure({ mode: "serial" });

const tagOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The layout and accessibility rules for one state, in light and in dark. */
async function checkState(page: Page, selector: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoSeriousA11y(page, selector);
    expect.soft(await unnamedControls(page), `${selector} (${scheme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${selector} (${scheme})`);
    await expectTouchTargets(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("an owner approves a server from the link it printed and sees it connect", async ({ browser }, info) => {
  test.setTimeout(150_000);
  const tag = tagOf(info.project.name);
  const admin = await apiAs(ADMIN);
  const contexts: BrowserContext[] = [];
  let deviceId: string | null = null;
  try {
    const start = await startPairing(API_URL, {
      name: `E2E rack ${tag}`,
      platform: "linux",
      runtimeVersion: "0.12.0",
    });
    expect(start.verificationUriComplete).toBe(`${BASE_URL}/settings/devices?pair=${start.userCode}`);

    const owner = await openAs(browser, ADMIN, info.project.name);
    contexts.push(owner.context);
    const page = owner.page;
    await page.goto(start.verificationUriComplete);
    const dialog = page.getByTestId("pair-approve-dialog");
    await expect(dialog.getByTestId("pair-request-code")).toHaveText(start.userCode, { timeout: 15_000 });
    await expect(dialog).toContainText("Pair a server");
    await expect(dialog.getByTestId("pair-request-name")).toHaveValue(`E2E rack ${tag}`);
    await expect(dialog.getByTestId("pair-request-platform")).toHaveText("Linux");
    await expect(dialog.getByTestId("pair-request-ip")).not.toBeEmpty();
    await expect(dialog.getByTestId("pair-request-age")).toHaveText(/just now|min ago/);
    await expect(dialog).toContainText(
      "Only approve a code you started yourself, on a computer you control.",
    );
    await checkState(page, '[data-testid="pair-approve-dialog"]');
    await bothThemes(page, `headless-pair-request-${tag}`);

    // ---- Approve under another name: the server is told on its next poll, then the device appears
    const name = `E2E server ${tag}`;
    await dialog.getByTestId("pair-request-name").fill(name);
    await dialog.getByTestId("pair-approve").click();
    await expect(dialog.getByTestId("pair-approved")).toContainText("Approved · waiting for the server");
    await checkState(page, '[data-testid="pair-approve-dialog"]');
    await bothThemes(page, `headless-pair-approved-${tag}`);

    const polled = await pollPairingToken(API_URL, start.deviceCode, { timeoutMs: 30_000 });
    expect(polled.ok, `token: ${JSON.stringify(polled)}`).toBe(true);
    if (!polled.ok) return;
    deviceId = polled.token.deviceId;
    expect(polled.token.deviceToken).toMatch(/^ocwd_/);
    expect(polled.token.name).toBe(name);

    await expect(dialog.getByTestId("pair-connected")).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText("Device connected");
    await expect(dialog.getByTestId("pair-connected-name")).toHaveText(name);
    await expect(dialog).toContainText("Share it with members and teams from its card.");
    await checkState(page, '[data-testid="pair-approve-dialog"]');
    await bothThemes(page, `headless-pair-connected-${tag}`);

    await dialog.getByTestId("pair-done").click();
    await expect(dialog).toBeHidden();
    // The code leaves the address bar so a reload does not reopen the dialog.
    await expect(page).toHaveURL(`${BASE_URL}/settings/devices`);
    await expect(page.getByTestId("device-card").filter({ hasText: name })).toBeVisible();
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    if (deviceId) await admin.delete(`/api/v1/devices/${deviceId}`).catch(() => undefined);
    await admin.dispose();
  }
});
