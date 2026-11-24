import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import {
  addClaudeAccountInUi,
  fakeSetupToken,
  poolAccount,
  poolAs,
  poolRow,
  resetPool,
} from "../support/account-pool";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { shareDevice } from "../support/work-zone-projects";
import { ADMIN } from "./env";

/**
 * Subscription account pool in the browser (Phase 07.18-16; D-04, D-05, D-07, D-08, D-10, D-11, D-15), on the REAL
 * daemon in fake-runtime mode: no model, no real account, fake setup-tokens only.
 * - Claude: an admin adds two accounts in Settings › Account pool ("limited-a", then "b"). Sam, a member, opens the
 *   new-session dialog for a device he may use: it says "Account: pool (failover)" and asks him nothing (D-15). The
 *   device runs with `OCW_RUNTIME_FAKE_LIMIT_PREFIX=limited-`, so the first turn on limited-a hits a five-hour limit
 *   (as a Claude subscription does); the platform cools it and re-runs the same turn on b: the timeline says "Switched
 *   to account b: limited-a reached its limit until <time>", the answer comes from b, the header reads "Account: b",
 *   and Settings shows limited-a cooling.
 * Every account is removed again in `finally`, so later specs on the stack run on the device's own login.
 */

test.describe.configure({ mode: "serial" });

/** The fake runtime limits every account whose label starts with this (apps/local-runtime/src/fake/fake-runtime.ts). */
const LIMIT_PREFIX = "limited-";
const LIMITED = `${LIMIT_PREFIX}a`;
const NEXT = "b";

async function signInAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 });
}

async function openPoolSettings(page: Page): Promise<void> {
  await page.goto("/settings/account-pool");
  await expect(page.getByTestId("account-pool-settings")).toBeVisible({ timeout: 15_000 });
}

test("Claude pool: a member's session moves to the next account when the first one reaches its limit", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const adminApi: APIRequestContext = await apiAs(ADMIN);
  const samId = await ensureMember(adminApi, SAM, "developer");
  let device: FakeDeviceHandle | null = null;
  let sam: Awaited<ReturnType<typeof openAs>> | null = null;
  const tokens = [fakeSetupToken(1), fakeSetupToken(2)];

  try {
    await resetPool(adminApi);
    device = await startFakeDevice(adminApi, {
      name: `E2E Pool ${tag}`,
      projectName: `pool-${tag}`,
      env: { OCW_RUNTIME_FAKE_LIMIT_PREFIX: LIMIT_PREFIX },
    });
    // Sam may use the admin's device (ADR-0012 grant); he gets no pool rights: only admins write the pool (PD-19).
    await shareDevice(adminApi, device.deviceId, samId);

    // ---- the admin adds two Claude accounts with their setup-tokens (D-02, D-10)
    await signInAdmin(page);
    await openPoolSettings(page);
    await expect(page.getByTestId("pool-empty-claude")).toBeVisible();
    await addClaudeAccountInUi(page, LIMITED, tokens[0] as string);
    await addClaudeAccountInUi(page, NEXT, tokens[1] as string);
    for (const label of [LIMITED, NEXT]) {
      await expect(poolRow(page, "claude", label).getByTestId("pool-account-status")).toHaveText("Ready");
      await expect(poolRow(page, "claude", label)).toContainText("Sealed on the server");
    }
    const view = await poolAs(adminApi);
    // The order is the order they were added in: failover takes limited-a first (D-04).
    expect(view.claude.accounts.map((a) => a.label)).toEqual([LIMITED, NEXT]);
    expect(view.claude.policy.strategy).toBe("failover");
    // Sealed on the server, never sent back (D-13): no response and no page carries a token.
    const viewText = JSON.stringify(view);
    for (const t of tokens) {
      expect(viewText).not.toContain(t);
      expect(await page.content()).not.toContain(t);
    }

    // ---- Sam starts a session: the dialog only says which account it will use (D-11, D-15)
    sam = await openAs(browser, SAM, info.project.name);
    const s = sam.page;
    await s.goto(`${BASE_URL}/work-zone`);
    await s.getByTestId("new-session").click();
    const dialog = s.getByTestId("new-session-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("project-option").filter({ hasText: device.projectName }).click();
    await dialog.getByTestId("runtime-claude-code").click();
    await expect(dialog.getByTestId("new-session-account")).toHaveText("Account: pool (failover)", {
      timeout: 15_000,
    });
    // Plan mode: the fake answers without asking to write a file, so the turn runs straight through.
    await dialog.getByTestId("new-session-settings-toggle").click();
    await dialog.getByTestId("mode-plan").click();
    await expect(dialog.getByTestId("mode-plan")).toHaveAttribute("aria-checked", "true");
    await dialog.getByTestId("new-session-settings-toggle").click();
    await dialog.getByTestId("first-prompt").fill("Summarise the README for a new teammate");
    await dialog.getByTestId("start-session").click();
    await expect(s).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/, { timeout: 15_000 });

    // ---- limited-a reaches its limit on the first turn; the same turn finishes on b (D-07, D-08)
    const switchLine = s.getByTestId("account-switch-line");
    await expect(switchLine).toBeVisible({ timeout: 45_000 });
    await expect(switchLine).toContainText(`Switched to account ${NEXT}: ${LIMITED} reached its limit until`);
    // … and a time: the reset the runtime reported, in Sam's own clock.
    await expect(switchLine).toHaveText(/reached its limit until .*\d/);
    await expect(s.getByTestId("assistant-message").last()).toContainText(`(account: ${NEXT})`, {
      timeout: 30_000,
    });
    await expect(s.getByTestId("assistant-message").filter({ hasText: `(account: ${LIMITED})` })).toHaveCount(
      0,
    );
    await expect(s.getByTestId("session-account")).toContainText(`Account: ${NEXT}`);

    // ---- back in Settings, limited-a cools down until its reset (D-08, D-10)
    await openPoolSettings(page);
    await expect(poolRow(page, "claude", LIMITED).getByTestId("pool-account-status")).toContainText(
      "Cooling until",
      { timeout: 15_000 },
    );
    await expect(poolRow(page, "claude", NEXT).getByTestId("pool-account-status")).toHaveText("Ready");
    const limited = await poolAccount(adminApi, "claude", LIMITED);
    expect(limited.status).toBe("cooling");
    expect(limited.limitReason).toBe("five_hour");
    expect(Date.parse(limited.cooldownUntil ?? "")).toBeGreaterThan(Date.now());
    expect((await poolAccount(adminApi, "claude", NEXT)).status).toBe("ready");
  } finally {
    await sam?.context.close().catch(() => undefined);
    await resetPool(adminApi).catch(() => undefined);
    await device?.stop().catch(() => undefined);
    await adminApi.dispose();
  }
});
