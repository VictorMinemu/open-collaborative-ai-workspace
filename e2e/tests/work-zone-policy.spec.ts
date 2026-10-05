import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { ADMIN, shot } from "./env";

/**
 * Settings › Work Zone policy (Phase 03.2, D-02, D-11; WZC-03, WZC-04). An organization admin governs what
 * every Work Zone session of the organization may use: Full access (off by default, and only one of the three
 * legs of ADR-0012), the permission modes, the models per runtime, a maximum effort per runtime and fast mode.
 * One Save; the API (Plan 04) stores, audits and enforces it. Members without `work_zone.manage` do not see the
 * section and get a read-only notice at its URL.
 */

/** What an organization without a policy row gets (`DEFAULT_WORK_ZONE_POLICY`). */
const DEFAULT_POLICY = {
  allowedPermissionModes: ["plan", "default", "acceptEdits", "auto"],
  allowFullAccess: false,
  allowedModels: { "claude-code": [], codex: [] },
  maxEffort: { "claude-code": null, codex: null },
  allowFastMode: false,
};

interface PolicyView {
  allowedPermissionModes: string[];
  allowFullAccess: boolean;
  allowedModels: Record<"claude-code" | "codex", string[]>;
  maxEffort: Record<"claude-code" | "codex", string | null>;
  allowFastMode: boolean;
  updatedAt: string | null;
}

async function resetPolicy(admin: APIRequestContext) {
  const res = await admin.put("/api/v1/work-zone-policy", { data: DEFAULT_POLICY });
  expect(res.ok(), "reset the Work Zone policy").toBe(true);
}

async function readPolicy(admin: APIRequestContext): Promise<PolicyView> {
  const res = await admin.get("/api/v1/work-zone-policy");
  expect(res.ok(), "read the Work Zone policy").toBe(true);
  return (await res.json()) as PolicyView;
}

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Opens the settings navigation (the drawer on phones). */
async function openSettingsNav(page: Page, mobile: boolean) {
  await page.goto(`${BASE_URL}/settings`);
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  await expect(page.getByTestId("settings-nav-profile").filter({ visible: true }).first()).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("admin: Settings › Work Zone policy turns Full access on with one Save, the API returns it, a developer cannot", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await resetPolicy(admin);
  try {
    // ---- the admin: Settings → Work Zone policy through the navigation
    const boss = await openAs(browser, ADMIN, project);
    await openSettingsNav(boss.page, mobile);
    const entry = boss.page.getByTestId("settings-nav-work-zone-policy").filter({ visible: true }).first();
    await expect(entry).toHaveText("Work Zone policy");
    await entry.click();
    await expect(boss.page).toHaveURL(/\/settings\/work-zone-policy$/);

    const form = boss.page.getByTestId("work-zone-policy-settings");
    await expect(form).toBeVisible();
    const fullAccess = form.getByTestId("allow-full-access");
    await expect(fullAccess).not.toBeChecked();
    await expect(
      form.getByText(
        "Runs Claude Code and Codex in their bypass mode, with no approval prompts. It also needs the device owner to enable it on the device and the member to have Full access on that device.",
      ),
    ).toBeVisible();
    const save = form.getByTestId("save-policy");
    await expect(save).toBeDisabled();
    await bothThemes(boss.page, `wz-policy-${tag}`);

    // ---- Full access on → one Save → toast; the API returns it
    await fullAccess.click();
    await expect(fullAccess).toBeChecked();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(boss.page.getByText("Work Zone policy saved")).toBeVisible();
    await expect(save).toBeDisabled();
    const saved = await readPolicy(admin);
    expect(saved.allowFullAccess).toBe(true);
    expect(saved.updatedAt).not.toBeNull();

    // ---- it survives a reload
    await boss.page.reload();
    await expect(boss.page.getByTestId("allow-full-access")).toBeChecked();
    await boss.context.close();

    // ---- Sam (developer): no entry, and a read-only notice at the URL
    const dev = await openAs(browser, SAM, project);
    await openSettingsNav(dev.page, mobile);
    await expect(dev.page.getByTestId("settings-nav-work-zone-policy")).toHaveCount(0);
    await dev.page.goto(`${BASE_URL}/settings/work-zone-policy`);
    await expect(dev.page.getByText("Only workspace admins can change the Work Zone policy.")).toBeVisible();
    await expect(dev.page.getByTestId("work-zone-policy-settings")).toHaveCount(0);
    await shot(dev.page, `wz-policy-denied-${tag}`);
    await dev.context.close();
  } finally {
    await resetPolicy(admin);
    await admin.dispose();
  }
});
