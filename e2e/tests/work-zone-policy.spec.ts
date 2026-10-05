import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
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

test("admin: governs permission modes, models per runtime, maximum effort and fast mode with one Save", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";

  const admin = await apiAs(ADMIN);
  await resetPolicy(admin);
  let device: FakeDeviceHandle | null = null;
  try {
    // A REAL daemon in fake-runtime mode reports its catalog: the page offers only those models.
    device = await startFakeDevice(admin, { name: `E2E Policy ${tag}`, projectName: `policy-${tag}` });
    // An id saved earlier that no device reports any more stays listed so it can be removed.
    const seeded = await admin.put("/api/v1/work-zone-policy", {
      data: { allowedModels: { "claude-code": ["opus", "claude-retired-3"], codex: [] } },
    });
    expect(seeded.ok(), "seed allowed models").toBe(true);

    const boss = await openAs(browser, ADMIN, project);
    await boss.page.goto(`${BASE_URL}/settings/work-zone-policy`);
    const form = boss.page.getByTestId("work-zone-policy-settings");
    await expect(form).toBeVisible();

    // ---- permission modes: all four allowed by default, each explained
    for (const mode of ["plan", "default", "acceptEdits", "auto"]) {
      await expect(form.getByTestId(`mode-allow-${mode}`)).toBeChecked();
    }
    await expect(form.getByText("Supervised", { exact: true })).toBeVisible();
    await expect(form.getByText("Auto-accept edits", { exact: true })).toBeVisible();

    // ---- models: Claude Code restricted to the chosen list, Codex any model
    const claude = form.getByTestId("models-claude-code");
    await expect(claude.getByRole("radio", { name: "Chosen models" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const claudeOptions = claude.getByTestId("model-option");
    await expect(claudeOptions).toHaveCount(6);
    await expect(claudeOptions.filter({ hasText: "Claude Opus 5.5" }).getByRole("checkbox")).toBeChecked();
    await expect(
      claudeOptions.filter({ hasText: "Claude Sonnet 5.5" }).getByRole("checkbox"),
    ).not.toBeChecked();
    const retired = claudeOptions.filter({ hasText: "claude-retired-3" });
    await expect(retired).toContainText(/not reported by any device/i);
    await expect(retired.getByRole("checkbox")).toBeChecked();
    const codex = form.getByTestId("models-codex");
    await expect(codex.getByRole("radio", { name: "Any model the device reports" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(codex.getByTestId("model-option")).toHaveCount(0);

    // ---- maximum effort: no limit; fast mode off with its cost stated
    await expect(form.getByTestId("max-effort-claude-code")).toContainText("No limit");
    await expect(form.getByTestId("max-effort-codex")).toContainText("No limit");
    await expect(form.getByTestId("allow-fast-mode")).not.toBeChecked();
    await expect(
      form.getByText(
        "Claude: billed from paid usage credits. Codex: uses ChatGPT plan limits at about 2.5x.",
      ),
    ).toBeVisible();

    // ---- review captures: every section, scrolled
    await bothThemes(boss.page, `wz-policy-full-${tag}`);
    await claude.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await bothThemes(boss.page, `wz-policy-full-${tag}-models`);
    // The bottom of the page: maximum effort and fast mode above the sticky Save bar.
    await form.evaluate((el) => el.closest(".overflow-y-auto")?.scrollTo({ top: el.scrollHeight }));
    await bothThemes(boss.page, `wz-policy-full-${tag}-limits`);

    // ---- at least one mode must stay allowed
    const save = form.getByTestId("save-policy");
    for (const mode of ["auto", "plan", "default", "acceptEdits"]) {
      await form.getByTestId(`mode-allow-${mode}`).click();
    }
    await expect(save).toBeDisabled();
    await expect(form.getByText("Keep at least one permission mode allowed.")).toBeVisible();
    for (const mode of ["plan", "default", "acceptEdits"]) {
      await form.getByTestId(`mode-allow-${mode}`).click();
    }
    await expect(form.getByTestId("mode-allow-auto")).not.toBeChecked();

    // ---- remove the retired id, cap Claude at Medium, allow fast mode → one Save
    await retired.getByRole("checkbox").click();
    await form.getByTestId("max-effort-claude-code").click();
    await boss.page.getByRole("option", { name: "Medium", exact: true }).click();
    await expect(form.getByTestId("max-effort-claude-code")).toContainText("Medium");
    await form.getByTestId("allow-fast-mode").click();
    await expect(form.getByTestId("allow-fast-mode")).toBeChecked();
    await save.click();
    await expect(boss.page.getByText("Work Zone policy saved")).toBeVisible();
    await expect(save).toBeDisabled();

    const saved = await readPolicy(admin);
    expect([...saved.allowedPermissionModes].sort()).toEqual(["acceptEdits", "default", "plan"]);
    expect(saved.maxEffort["claude-code"]).toBe("medium");
    expect(saved.maxEffort.codex).toBeNull();
    expect(saved.allowFastMode).toBe(true);
    expect(saved.allowedModels["claude-code"]).toEqual(["opus"]);
    expect(saved.allowedModels.codex).toEqual([]);
    expect(saved.allowFullAccess).toBe(false);

    // ---- the saved policy comes back after a reload; the retired id is gone
    await boss.page.reload();
    await expect(form.getByTestId("mode-allow-auto")).not.toBeChecked();
    await expect(form.getByTestId("max-effort-claude-code")).toContainText("Medium");
    await expect(form.getByTestId("models-claude-code").getByTestId("model-option")).toHaveCount(5);
    await expect(form.getByText("claude-retired-3")).toHaveCount(0);
    await boss.context.close();
  } finally {
    await device?.stop();
    await resetPolicy(admin);
    await admin.dispose();
  }
});
