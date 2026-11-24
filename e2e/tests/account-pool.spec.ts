import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { poolProfileId } from "../../packages/contracts/src/agent-channel.ts";
import {
  addClaudeAccountInUi,
  fakeSetupToken,
  poolAccount,
  poolAs,
  poolRow,
  resetPool,
} from "../support/account-pool";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { startFakeDeviceAuthServer } from "../support/fake-device-auth-server";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { shareDevice } from "../support/work-zone-projects";
import { ADMIN, API_URL } from "./env";

/**
 * Subscription account pool in the browser (Phase 07.18-16; D-02 … D-05, D-07, D-08, D-10 … D-12, D-15), on the REAL
 * daemon in fake-runtime mode and a FAKE OpenClaw cell: no model, no real account, fake setup-tokens and a fake
 * device-code server only.
 * - Claude: an admin adds two accounts in Settings › Account pool ("limited-a", then "b"). Sam, a member, opens the
 *   new-session dialog for a device he may use: it says "Account: pool (failover)" and asks him nothing (D-15). The
 *   device runs with `OCW_RUNTIME_FAKE_LIMIT_PREFIX=limited-`, so the first turn on limited-a hits a five-hour limit
 *   (as a Claude subscription does); the platform cools it and re-runs the same turn on b: the timeline says "Switched
 *   to account b: limited-a reached its limit until <time>", the answer comes from b, the header reads "Account: b",
 *   and Settings shows limited-a cooling.
 * - ChatGPT for bots: the organization's existing ChatGPT sign-in (Settings › Models) is the pool's first account
 *   (adopted, E14), also after the cell restarts and lists the profiles it holds; the admin adds "bots-2" for bots with
 *   the device code; removing it signs out only its profile in the cell, and the adopted one stays (E15).
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

/** The fake OAuth device-authorization server's account (the existing sign-in and "bots-2" both approve as it). */
const CHATGPT = { email: "ops@autofylabs.test", planType: "pro" };
/** The profile OpenClaw stores a sign-in under when none is asked for (apps/openclaw-channel/src/openclaw-auth.ts). */
const EXISTING_PROFILE = `openai:${CHATGPT.email}`;
const BOTS_2 = "bots-2";

test("ChatGPT for bots: the existing sign-in is the pool's first account; one added and removed in the cell", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  const adminApi = await apiAs(ADMIN);
  const cell = (await (await adminApi.get("/api/v1/agent-cell")).json()) as { connected: boolean };
  test.skip(cell.connected, "another OpenClaw cell is connected; the fake one must own the sign-ins");

  const deviceAuth = await startFakeDeviceAuthServer(CHATGPT);
  // A 07.18 cell: one profile per sign-in, profile ids on `connected`, the profile list in credential state reports.
  const newCell = () =>
    new FakeCellPlugin({
      apiUrl: API_URL,
      token,
      autoAck: true,
      deviceAuth: { serverUrl: deviceAuth.url, pollMs: 150, profiles: true },
    });
  let plugin = newCell();
  /** The device code the fake cell reported for `flowId`, once it did. */
  const codeOf = async (flowId: string) => {
    const pending = () =>
      plugin.authReports.find(
        (r) => r.body.flowId === flowId && r.body.state === "pending" && r.status === 200,
      );
    await plugin.waitUntil(() => pending() !== undefined, 15_000);
    return String(pending()?.body.userCode);
  };

  try {
    // Re-runnable: no sign-in, connection or pool account left by a previous run.
    await adminApi.delete("/api/v1/model-providers/openai-codex/auth");
    await adminApi.delete("/api/v1/model-providers/openai-codex");
    await resetPool(adminApi);
    await plugin.start();

    // ---- the organization's ChatGPT sign-in from Settings › Models joins the pool as its first account (D-03, E14)
    const started = await adminApi.post("/api/v1/model-providers/openai-codex/auth", { data: {} });
    expect(started.ok(), await started.text()).toBe(true);
    const flowId = ((await started.json()) as { flowId: string }).flowId;
    expect(deviceAuth.approve(await codeOf(flowId))).toBe(true);
    await plugin.waitUntil(
      () => plugin.authReports.some((r) => r.body.flowId === flowId && r.body.state === "connected"),
      15_000,
    );
    await expect
      .poll(async () => (await poolAs(adminApi)).chatgpt.accounts.map((a) => [a.label, a.kind, a.origin]), {
        timeout: 15_000,
      })
      .toEqual([[CHATGPT.email, "cell_profile", "adopted"]]);

    // The cell restarts with the same auth store and lists what it holds: still that one account, no duplicate.
    await plugin.stop();
    plugin = newCell();
    plugin.holdProfile("openai-codex", EXISTING_PROFILE, CHATGPT);
    await plugin.start();
    expect(
      plugin.authReports.find((r) => r.body.flowId === null && Array.isArray(r.body.profiles)),
      "the profile list reported at start",
    ).toMatchObject({ status: 200, body: { profiles: [{ profileId: EXISTING_PROFILE, usable: true }] } });
    const adopted = (await poolAs(adminApi)).chatgpt.accounts;
    expect(adopted.map((a) => a.label)).toEqual([CHATGPT.email]);

    // ---- Settings › Account pool lists it under ChatGPT, in the bots runtime
    await signInAdmin(page);
    await openPoolSettings(page);
    const existingRow = poolRow(page, "chatgpt", CHATGPT.email);
    await expect(existingRow).toContainText("Bots runtime");
    await expect(existingRow.getByTestId("pool-account-status")).toHaveText("Ready");

    // ---- the admin adds "bots-2" for bots: the device code, then Connected (D-02, D-10)
    await page.getByTestId("pool-add-chatgpt").click();
    const dialog = page.getByTestId("add-chatgpt-account-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("chatgpt-where-bots").click();
    await dialog.getByTestId("chatgpt-account-label").fill(BOTS_2);
    await dialog.getByTestId("chatgpt-account-start").click();
    await expect(dialog.getByTestId("chatgpt-sign-in-pending")).toBeVisible({ timeout: 15_000 });
    const shownCode = (await dialog.getByTestId("chatgpt-user-code").textContent())?.trim() ?? "";
    expect(shownCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{6}$/);
    await expect(dialog.getByTestId("chatgpt-verification-url")).toHaveAttribute(
      "href",
      `${deviceAuth.url}/codex/device`,
    );
    expect(deviceAuth.approve(shownCode)).toBe(true);
    await expect(dialog.getByTestId("chatgpt-sign-in-connected")).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    const bots2 = await poolAccount(adminApi, "chatgpt", BOTS_2);
    expect([bots2.kind, bots2.origin]).toEqual(["cell_profile", "admin"]);
    // The cell signed it in under the profile the API asked for (PD-12).
    expect(plugin.profiles("openai-codex").map((p) => p.profileId)).toEqual([
      EXISTING_PROFILE,
      poolProfileId(bots2.id),
    ]);
    const chatgptRows = page.getByTestId("pool-section-chatgpt").getByTestId("pool-account");
    await expect(chatgptRows).toHaveCount(2);
    await expect(chatgptRows.filter({ hasText: "Bots runtime" })).toHaveCount(2);
    await expect(poolRow(page, "chatgpt", BOTS_2).getByTestId("pool-account-status")).toHaveText("Ready");

    // ---- removing bots-2 signs out only its profile in the cell; the adopted account stays (PD-25, E15)
    const revokesBefore = plugin.revokes.length;
    await poolRow(page, "chatgpt", BOTS_2)
      .getByRole("button", { name: `Remove ${BOTS_2}` })
      .click();
    const confirm = page.getByRole("dialog").filter({ hasText: `Remove ${BOTS_2}?` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(confirm).toBeHidden({ timeout: 10_000 });
    await plugin.waitUntil(() => plugin.revokes.length > revokesBefore, 15_000);
    expect(plugin.revokes.slice(revokesBefore)).toEqual([
      { provider: "openai-codex", profileIds: [poolProfileId(bots2.id)] },
    ]);
    expect(plugin.profiles("openai-codex").map((p) => p.profileId)).toEqual([EXISTING_PROFILE]);
    await expect(chatgptRows).toHaveCount(1);
    await expect(poolRow(page, "chatgpt", CHATGPT.email)).toBeVisible();
    expect((await poolAs(adminApi)).chatgpt.accounts.map((a) => [a.label, a.origin])).toEqual([
      [CHATGPT.email, "adopted"],
    ]);
  } finally {
    await resetPool(adminApi).catch(() => undefined);
    await adminApi.delete("/api/v1/model-providers/openai-codex/auth").catch(() => undefined);
    await adminApi.delete("/api/v1/model-providers/openai-codex").catch(() => undefined);
    await plugin.stop().catch(() => undefined);
    await deviceAuth.close().catch(() => undefined);
    await adminApi.dispose();
  }
});
