import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { expectNoSidewaysScroll, expectTouchTargets, unnamedControls } from "../support/layout";
import { pollPairingToken, startPairing } from "../support/pairing";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Terminal pairing, the owner's side (Phase 07.12-07, D-01…D-03, D-13, PD-14, HSR-03), on the real stack. A "server"
 * here is this test process doing what `ocw-runtime setup` does (start a pairing anonymously, poll the token route);
 * the owner approves or denies it in Settings › Devices:
 * - from the link the server printed (`?pair=CODE`): compare the code, rename, Approve, "Device connected";
 * - from Add a device › Server: the install command for this workspace, `ocw-runtime setup`, the code field;
 * - Deny, an unknown code, and a signed-out member who keeps the code through sign-in;
 * - New session's "Run sessions on a server" link to Add a device › Server (owner feedback 2026-10-29).
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

/** A signed-out browser sized like the Playwright project (the sizes `openAs` uses). */
async function signedOut(
  browser: Browser,
  project: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const mobile = project === "mobile";
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  return { context, page: await context.newPage() };
}

test("Add a device › Server shows this workspace's commands, takes the code the server shows, and Deny refuses it", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const tag = tagOf(info.project.name);
  const contexts: BrowserContext[] = [];
  try {
    const start = await startPairing(API_URL, { name: `E2E denied ${tag}`, platform: "darwin" });
    const owner = await openAs(browser, ADMIN, info.project.name);
    contexts.push(owner.context);
    const page = owner.page;
    let enrollments = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/api/v1/devices/enrollments")) enrollments += 1;
    });

    // The link a server prints next to its code opens Add a device on the Server tab.
    await page.goto(`${BASE_URL}/settings/devices?add=server`);
    const add = page.getByTestId("add-device-dialog");
    await expect(add.getByTestId("add-device-tab-server")).toHaveAttribute("aria-selected", "true");
    await expect(add.getByTestId("server-install-command")).toContainText(
      `curl -fsSL ${API_URL}/api/v1/runtime/install.sh | sh`,
    );
    await expect(add.getByTestId("server-setup-command")).toContainText("ocw-runtime setup");
    await expect(add).toContainText("Needs Node 24 on the server. Linux or macOS.");
    // No one-time code on this tab, and none was created for it.
    await expect(add.getByTestId("pairing-code")).toHaveCount(0);
    expect(enrollments).toBe(0);
    await expect(add.getByTestId("pair-code-continue")).toBeDisabled();
    await checkState(page, '[data-testid="add-device-dialog"]');
    await bothThemes(page, `headless-add-server-${tag}`);

    // The other tabs keep their one-time code: created once, the first time one of them is shown.
    await add.getByTestId("add-device-tab-desktop").click();
    await expect(add.getByTestId("pairing-code")).toBeVisible();
    await add.getByTestId("add-device-tab-cli").click();
    await expect(add.getByTestId("pairing-code")).toBeVisible();
    expect(enrollments).toBe(1);
    await add.getByTestId("add-device-tab-server").click();
    await expect(add.getByTestId("pairing-code")).toHaveCount(0);

    // Typed the way people do (lower case, no dash): Continue opens the same approve dialog.
    await add.getByTestId("pair-code-input").fill(start.userCode.replace("-", "").toLowerCase());
    await expect(add.getByTestId("pair-code-input")).toHaveValue(start.userCode.replace("-", ""));
    await add.getByTestId("pair-code-continue").click();
    await expect(add).toBeHidden();
    const dialog = page.getByTestId("pair-approve-dialog");
    await expect(dialog.getByTestId("pair-request-code")).toHaveText(start.userCode, { timeout: 15_000 });
    await expect(dialog.getByTestId("pair-request-name")).toHaveValue(`E2E denied ${tag}`);
    await expect(dialog.getByTestId("pair-request-platform")).toHaveText("macOS");

    // ---- Deny: the server's next poll answers access_denied
    await dialog.getByTestId("pair-deny").click();
    await expect(page.getByText("Pairing denied")).toBeVisible();
    await expect(dialog).toBeHidden();
    const polled = await pollPairingToken(API_URL, start.deviceCode, { timeoutMs: 20_000 });
    expect(polled).toEqual({ ok: false, error: "access_denied" });
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
  }
});

// The lookup, approve and deny routes share 10 calls a minute per member (07.12-02): the admin's approvals and denials
// above use 4 per project, so the next two cases run as Sam (a developer, who may pair his own devices).
async function asSam() {
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await admin.dispose();
}

test("an unknown or expired code says so and offers another try", async ({ browser }, info) => {
  const tag = tagOf(info.project.name);
  await asSam();
  const owner = await openAs(browser, SAM, info.project.name);
  try {
    const page = owner.page;
    await page.goto(`${BASE_URL}/settings/devices?pair=ZZZZ-ZZZZ`);
    const dialog = page.getByTestId("pair-approve-dialog");
    await expect(dialog.getByTestId("pair-error")).toHaveText(
      "This code is not valid or has expired. Check the code on the server, or run the command again.",
      { timeout: 15_000 },
    );
    await expect(dialog.getByTestId("pair-code-input")).toBeVisible();
    await expect(dialog.getByTestId("pair-approve")).toHaveCount(0);
    await checkState(page, '[data-testid="pair-approve-dialog"]');
    await bothThemes(page, `headless-pair-error-${tag}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(`${BASE_URL}/settings/devices`);
  } finally {
    await owner.context.close();
  }
});

test("a signed-out member keeps the code through sign-in", async ({ browser }, info) => {
  const tag = tagOf(info.project.name);
  await asSam();
  const start = await startPairing(API_URL, { name: `E2E login ${tag}`, platform: "linux" });
  const { context, page } = await signedOut(browser, info.project.name);
  try {
    await page.goto(start.verificationUriComplete);
    const next = encodeURIComponent(`/settings/devices?pair=${start.userCode}`);
    await expect(page).toHaveURL(`${BASE_URL}/login?next=${next}`);
    await page.getByLabel("Email").fill(SAM.email);
    await page.getByLabel("Password", { exact: true }).fill(SAM.password);
    await page
      .getByTestId("login-form")
      .getByRole("button", { name: /sign in|log in/i })
      .click();
    await expect(page).toHaveURL(start.verificationUriComplete);
    const dialog = page.getByTestId("pair-approve-dialog");
    await expect(dialog.getByTestId("pair-request-code")).toHaveText(start.userCode, { timeout: 15_000 });
    await expect(dialog.getByTestId("pair-request-name")).toHaveValue(`E2E login ${tag}`);
    // Closing without a decision leaves the request pending on the server and the code out of the address bar.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(`${BASE_URL}/settings/devices`);
  } finally {
    await context.close();
  }
});

test("New session points to Add a device › Server", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const tag = tagOf(info.project.name);
  const admin = await apiAs(ADMIN);
  let device: FakeDeviceHandle | null = null;
  const contexts: BrowserContext[] = [];
  try {
    device = await startFakeDevice(admin, { name: `E2E laptop ${tag}`, projectName: `pairing-${tag}` });
    const owner = await openAs(browser, ADMIN, info.project.name);
    contexts.push(owner.context);
    const page = owner.page;
    await page.goto(`${BASE_URL}/work-zone`);
    await page.getByTestId("new-session").click();
    const dialog = page.getByTestId("new-session-dialog");
    const link = dialog.getByTestId("new-session-add-server");
    await expect(link).toHaveText("Run sessions on a server");
    await expect(link).toHaveAttribute("href", "/settings/devices?add=server");
    await link.scrollIntoViewIfNeeded();
    await expectNoSeriousA11y(page, '[data-testid="new-session-dialog"]');
    await expectTouchTargets(page, link);
    await bothThemes(page, `headless-new-session-link-${tag}`);
    await link.click();
    await expect(page).toHaveURL(`${BASE_URL}/settings/devices?add=server`);
    await expect(page.getByTestId("add-device-dialog").getByTestId("add-device-tab-server")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    const id = device?.deviceId;
    await device?.stop();
    if (id) await admin.delete(`/api/v1/devices/${id}`).catch(() => undefined);
    await admin.dispose();
  }
});
