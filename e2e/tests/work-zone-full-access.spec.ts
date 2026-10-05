import { expect, type Page, test } from "@playwright/test";
import { apiAs } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, shot } from "./env";

/**
 * Full access (Phase 03.2, ADR-0012, D-01, D-02) with the REAL daemon in fake-runtime mode (no model, no bypass of
 * any real runtime): the org policy allows it, device A's owner opted in ON THE DEVICE (`OCW_ALLOW_FULL_ACCESS=1`),
 * so the owner's Full access session runs a writing turn without a single approval prompt. Device B never opted in:
 * the server refuses the same session (403 `device_opt_in`), and the daemon itself refuses any fullAccess request
 * (unit-tested in apps/local-runtime). A real runtime's Full access turn is a manual-only check (03.2-VALIDATION.md).
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

test("Full access: an opted-in device runs the owner's session without prompts; a device without the opt-in is refused", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const tag = info.project.name === "mobile" ? "390" : "1440";
  const adminApi = await apiAs(ADMIN);
  let deviceA: FakeDeviceHandle | null = null;
  let deviceB: FakeDeviceHandle | null = null;
  let sessionId: string | null = null;

  try {
    // ---- the organization allows Full access (default: off)
    const policy = await adminApi.put("/api/v1/work-zone-policy", { data: { allowFullAccess: true } });
    expect(policy.ok(), await policy.text()).toBe(true);

    // ---- device A: its owner opted in locally; device B did not
    deviceA = await startFakeDevice(adminApi, {
      name: `E2E Full access ${tag}`,
      projectName: `full-access-${tag}`,
      env: { OCW_ALLOW_FULL_ACCESS: "1" },
    });
    deviceB = await startFakeDevice(adminApi, {
      name: `E2E No opt-in ${tag}`,
      projectName: `no-opt-in-${tag}`,
      env: { OCW_ALLOW_FULL_ACCESS: "0" },
    });
    await expect
      .poll(
        async () => {
          const { devices } = (await (await adminApi.get("/api/v1/devices")).json()) as {
            devices: Array<{ id: string; fullAccessOptIn: boolean }>;
          };
          return [deviceA, deviceB].map((d) => devices.find((x) => x.id === d?.deviceId)?.fullAccessOptIn);
        },
        { timeout: 15_000, message: "each device reports its own opt-in" },
      )
      .toEqual([true, false]);

    // ---- device B: the server refuses Full access, naming the device layer
    const refused = await adminApi.post("/api/v1/work-sessions", {
      data: {
        projectId: deviceB.projectId,
        runtime: "claude-code",
        permissionMode: "fullAccess",
        title: `No opt-in ${tag}`,
      },
    });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("device_opt_in");

    // ---- device A: the owner starts a Full access session
    const created = await adminApi.post("/api/v1/work-sessions", {
      data: {
        projectId: deviceA.projectId,
        runtime: "claude-code",
        permissionMode: "fullAccess",
        title: `Full access ${tag}`,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    sessionId = ((await created.json()) as { id: string }).id;

    await signIn(page);
    await page.goto(`/work-zone/${sessionId}`);
    const view = page.getByTestId("session-view");
    await expect(view).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
    // The header names the session's mode to every controller.
    await expect(view.getByText(/full ?access/i).first()).toBeVisible();
    // D-04: the composer's permission chip names Full access in the warning tone for every controller.
    const chip = page.getByTestId("permission-chip");
    await expect(chip).toContainText("Full access");
    await expect(chip).toHaveAttribute("data-tone", "warning");
    await expect(page.getByTestId("session-header")).toContainText("Full access");
    await shot(page, `wz-composer-full-access-${tag}`);
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, `wz-composer-full-access-${tag}-dark`);
    await page.emulateMedia({ colorScheme: "light" });

    // ---- a writing turn runs straight through: no approval banner, ever
    await page.getByTestId("composer").fill("Add a CHANGELOG note for the release");
    await page.getByTestId("send-prompt").click();
    const last = page.getByTestId("assistant-message").last();
    await expect(last).toContainText("Done.", { timeout: 30_000 });
    await expect(last).toContainText("Mode: fullAccess");
    await expect(page.getByTestId("approval-banner")).toHaveCount(0);
    await expect(view).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
    const events = (await (await adminApi.get(`/api/v1/work-sessions/${sessionId}/events`)).json()) as {
      events?: Array<{ type: string }>;
    };
    if (events.events) expect(events.events.map((e) => e.type)).not.toContain("approval.requested");

    await shot(page, `wz-full-access-session-${tag}`);
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, `wz-full-access-session-${tag}-dark`);
    await page.emulateMedia({ colorScheme: "light" });
  } finally {
    if (sessionId) await adminApi.post(`/api/v1/work-sessions/${sessionId}/archive`, { data: {} });
    await deviceA?.stop();
    await deviceB?.stop();
    await adminApi.put("/api/v1/work-zone-policy", { data: { allowFullAccess: false } });
    await adminApi.dispose();
  }
});
