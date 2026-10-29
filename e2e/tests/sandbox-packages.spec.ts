import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { FAKE_URL, freshTeamBot, SHELL } from "../support/bot-tools";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { enableBotSandbox, enableSandboxOrg, fakeSandboxd, resume } from "../support/sandbox";
import { ADMIN } from "./env";

/**
 * Settings › Sandbox & Browser › Sandbox packages (07.8-23; SBX-04, D-03 as refined by D-11, P-12, R12, C-03, UI-SPEC
 * §4.4) against the real API and the fake sandboxd (`scripts/e2e-isolated.sh`; the registries are the fake's
 * deterministic trees, steered through its package controls). An admin adds a pinned package: source, exact name and
 * version → the review sheet (digest, license, publisher, size, install script, dependency count, risk) → Approve; the
 * row reads Installing, and Installed in 1 bot once Scout's sandbox starts. High risk needs the typed acknowledgement,
 * Blocked has no action, and a release that changed upstream between review and approval (its artifact or only a
 * dependency) refreshes the review with a toast. Rows save their switches on toggle (a refused save restores the
 * switch), remove after a confirmation, and a package whose install was refused because its tree changed upstream says
 * so and offers Review…. Someone with `bot.manage` but not `plugin.manage` sees a read-only list. The Marketplace points
 * here, and a native plugin with a shell tool is Blocked with the sandbox-package reason. Every surface passes axe in
 * light and dark, and the UI-SPEC screenshots are captured when OCW_E2E_SCREENSHOT_DIR is set.
 *
 * The spec leaves the organization with no live sandbox package, Sandbox & Browser on and resumed.
 */

test.describe.configure({ mode: "serial" });

type Source = "npm" | "pypi" | "debian" | "clawhub";
type Coords = { source: Source; name: string; version: string };
type Pkg = {
  id: string;
  name: string;
  version: string;
  source: Source;
  enabled: boolean;
  personalAllowed: boolean;
  installedIn: number;
  changedUpstream: boolean;
};

/** Someone who manages bots (an admin) but may not approve packages: a user deny on `plugin.manage`. */
const RITA: Actor = { name: "Rita Gómez", email: "rita@ocw.test", password: "rita-e2e-password-123" };

let admin: APIRequestContext;
const open: BrowserContext[] = [];
let ritaRule: string | null = null;

async function listPackages(): Promise<Pkg[]> {
  const res = await admin.get("/api/v1/sandbox/packages");
  expect(res.ok(), `GET /sandbox/packages: ${res.status()}`).toBe(true);
  return ((await res.json()) as { items: Pkg[] }).items;
}

async function clearPackages(): Promise<void> {
  for (const p of await listPackages()) {
    const res = await admin.delete(`/api/v1/sandbox/packages/${p.id}`);
    expect(res.ok(), `DELETE package ${p.name}: ${res.status()}`).toBe(true);
  }
}

/** Review and approve through the API (setup for the row tests). */
async function approveByApi(c: Coords): Promise<Pkg> {
  const review = await admin.post("/api/v1/sandbox/packages/review", { data: c });
  expect(review.ok(), `review ${c.name}: ${review.status()} ${await review.text()}`).toBe(true);
  const { reviewToken, risk } = (await review.json()) as { reviewToken: string; risk: string };
  const res = await admin.post("/api/v1/sandbox/packages", {
    data: { reviewToken, ...(risk === "high" ? { acknowledge: "install anyway" } : {}) },
  });
  expect(res.ok(), `approve ${c.name}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as Pkg;
}

/** Scout's sandbox starts (the people's restart route): the API brings its packages up to date. */
async function startSandbox(agentId: string): Promise<void> {
  const res = await admin.post(`/api/v1/agents/${agentId}/sandbox/restart`);
  expect(res.ok(), `restart: ${res.status()} ${await res.text()}`).toBe(true);
}

async function scoutBot(name: string): Promise<string> {
  const id = await freshTeamBot(admin, name);
  await enableBotSandbox(admin, id, { sandbox: true });
  return id;
}

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  await fakeSandboxd().up();
  await enableSandboxOrg(admin);
  await resume(admin);
  await clearPackages();
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  if (!admin) return;
  if (ritaRule) await admin.delete(`/api/v1/permission-rules/${ritaRule}`);
  await clearPackages();
  await admin.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], project: string, who: Actor = ADMIN) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

async function openPackages(page: Page) {
  await page.goto(`${BASE_URL}/settings/sandbox`);
  const section = page.getByTestId("sandbox-packages");
  await expect(section).toBeVisible({ timeout: 15_000 });
  await expect(section.locator('[aria-busy="true"]')).toHaveCount(0);
  return section;
}

const rowOf = (page: Page, name: string) =>
  page.locator(`[data-testid^="package-row-"][data-package="${name}"]`);

/** Add → source, name, version → Review: the sheet with its review. */
async function reviewInSheet(page: Page, c: Coords) {
  await page.getByTestId("package-add").first().click();
  const dialog = page.getByTestId("add-package-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("package-name")).toBeFocused();
  await dialog.getByTestId(`package-source-${c.source}`).check();
  await dialog.getByTestId("package-name").fill(c.name);
  await dialog.getByTestId("package-version").fill(c.version);
  await dialog.getByTestId("package-review").click();
  await expect(dialog).toBeHidden();
  const sheet = page.getByTestId("package-review-sheet");
  await expect(sheet.getByTestId("package-facts")).toBeVisible();
  return sheet;
}

/** axe (light and dark), named controls, no sideways scroll; 44 px targets below 1024. */
async function checkScreen(page: Page, selector: string, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoSeriousA11y(page, selector);
    expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} ${theme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expectTouchTargets(page, selector);
}

const DIGEST = /^sha256:[0-9a-f]{12}$/u;

// ---------------------------------------------------------------- Task 1: approve a pinned package (tracer)

test("an admin approves a pinned package from the settings page and it installs at the bot's next start", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the tracer runs at 1440; 390 is proven below");
  const scout = await scoutBot("Scout");
  const page = await signIn(browser, info.project.name);
  const section = await openPackages(page);

  // Empty: the dashed box with Add package.
  await expect(section.getByTestId("packages-empty")).toContainText(
    "No sandbox packages yet. Approve one so every bot's sandbox has it ready.",
  );

  // Add → PyPI, pandas, 2.3.1 → the review sheet.
  const sheet = await reviewInSheet(page, { source: "pypi", name: "pandas", version: "2.3.1" });
  await expect(sheet.getByRole("heading", { name: "pandas" })).toBeVisible();
  await expect(sheet.getByTestId("package-review-version")).toHaveText("2.3.1");
  await expect(sheet.getByTestId("package-facts")).toContainText("PyPI");
  await expect(sheet.getByTestId("package-license")).toHaveText("MIT");
  await expect(sheet.getByTestId("package-publisher")).toHaveText("fake-publisher");
  await expect(sheet.getByTestId("package-facts")).toContainText(/\d+(\.\d)? KB/u);
  await expect(sheet.getByTestId("package-digest-value")).toHaveText(DIGEST);
  await expect(sheet.getByTestId("package-digest-copy")).toHaveText("Copy digest");
  await expect(sheet.getByTestId("package-dependencies")).toHaveText("1 dependency, pinned by hash");
  await expect(sheet.getByTestId("package-install-script")).toHaveText("No install script");
  await expect(sheet.getByTestId("package-risk")).toHaveAttribute("data-risk", "low");
  await expect(sheet.getByTestId("package-trust-note")).toContainText("when it next starts");

  // Approve → toast and the row, Installing until a sandbox starts.
  const approve = sheet.getByTestId("package-approve");
  await expect(approve).toHaveText("Approve pandas@2.3.1");
  await approve.click();
  await expect(
    page.getByText("pandas 2.3.1 approved. It installs in each bot's sandbox when it next starts."),
  ).toBeVisible();
  await expect(sheet).toBeHidden();
  const row = rowOf(page, "pandas");
  await expect(row.getByTestId("package-status")).toHaveText("Installing");
  await expect(row).toContainText("2.3.1");
  await expect(row).toContainText("PyPI");
  await expect(row.getByTestId("risk-low")).toBeVisible();

  // Scout's sandbox starts: the API installs the pinned tree, and the row says where it is.
  await startSandbox(scout);
  await expect(row.getByTestId("package-status")).toHaveText("Installed in 1 bot", { timeout: 20_000 });
  expect((await listPackages()).find((p) => p.name === "pandas")?.installedIn).toBe(1);
});

test("high risk needs the typed acknowledgement, Blocked has no action, a missing package stays in the form", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the review flows run at 1440");
  const fake = fakeSandboxd();
  const risky = { source: "npm", name: "ocw-unlicensed", version: "1.0.0" } as const;
  const blocked = { source: "npm", name: "ocw-sha1-tree", version: "0.4.2" } as const;
  await fake.setPackage(risky, { license: null });
  await fake.setPackage(blocked, { sha1: true });
  const page = await signIn(browser, info.project.name);
  await openPackages(page);

  // Not in any registry: the form says so and stays open.
  await page.getByTestId("package-add").first().click();
  const dialog = page.getByTestId("add-package-dialog");
  await dialog.getByTestId("package-review").click();
  await expect(dialog.getByTestId("add-package-error")).toHaveText("Enter a package name");
  await dialog.getByTestId("package-name").fill("ocw-missing-thing");
  await dialog.getByTestId("package-version").fill("^1.0");
  await dialog.getByTestId("package-review").click();
  await expect(dialog.getByTestId("add-package-error")).toContainText("not a range");
  await dialog.getByTestId("package-version").fill("1.0.0");
  await dialog.getByTestId("package-review").click();
  await expect(dialog.getByTestId("add-package-error")).toHaveText(
    "No package called “ocw-missing-thing” on npm.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // High risk (no license): Approve only after typing "install anyway".
  let sheet = await reviewInSheet(page, risky);
  await expect(sheet.getByTestId("package-risk")).toHaveAttribute("data-risk", "high");
  await expect(sheet.getByTestId("package-license")).toHaveText("Not declared");
  const approve = sheet.getByTestId("package-approve");
  await expect(approve).toBeDisabled();
  await sheet.getByTestId("package-ack").fill("install anyway");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByText("ocw-unlicensed 1.0.0 approved.", { exact: false })).toBeVisible();
  await expect(rowOf(page, "ocw-unlicensed").getByTestId("risk-high")).toBeVisible();

  // Refused (a dependency pinned by sha1 only): Blocked with its reason, no action.
  sheet = await reviewInSheet(page, blocked);
  await expect(sheet.getByTestId("risk-refuse")).toHaveText("Blocked");
  await expect(sheet.getByTestId("package-risk")).toHaveAttribute("data-risk", "refuse");
  await expect(sheet.getByTestId("risk-reason").first()).toBeVisible();
  await expect(sheet.getByTestId("package-blocked")).toBeVisible();
  await expect(sheet.getByTestId("package-approve")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  expect((await listPackages()).map((p) => p.name)).not.toContain("ocw-sha1-tree");
});

test("a release that changed upstream between review and approval refreshes the review (artifact or one dependency)", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the review flows run at 1440");
  const fake = fakeSandboxd();
  const page = await signIn(browser, info.project.name);
  await openPackages(page);

  // The artifact was republished after the review: the toast, and the sheet shows the new digest.
  const moving = { source: "npm", name: "ocw-moving", version: "3.1.0" } as const;
  let sheet = await reviewInSheet(page, moving);
  const before = await sheet.getByTestId("package-digest-value").textContent();
  await fake.setPackage(moving, { topChanged: true });
  await sheet.getByTestId("package-approve").click();
  await expect(page.getByText("This version changed upstream")).toBeVisible();
  await expect(page.getByText("The review was refreshed. Check it again before approving.")).toBeVisible();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("package-digest-value")).toHaveText(DIGEST);
  await expect(sheet.getByTestId("package-digest-value")).not.toHaveText(before ?? "");
  // The refreshed review approves.
  await sheet.getByTestId("package-approve").click();
  await expect(page.getByText("ocw-moving 3.1.0 approved.", { exact: false })).toBeVisible();
  await expect(sheet).toBeHidden();

  // Only a dependency changed: the same toast, and the refreshed review (same top digest) approves.
  // Sonner pauses a toast while the pointer rests on it (the sheet closed under the cursor): move it away first.
  await page.mouse.move(0, 0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 15_000 });
  const deps = { source: "pypi", name: "ocw-deps", version: "0.9.0" } as const;
  sheet = await reviewInSheet(page, deps);
  const top = await sheet.getByTestId("package-digest-value").textContent();
  await fake.setPackage(deps, { depChanged: true });
  await sheet.getByTestId("package-approve").click();
  await expect(page.getByText("This version changed upstream")).toBeVisible();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("package-digest-value")).toHaveText(top ?? "");
  await expect(sheet.getByTestId("package-dependencies")).toHaveText("1 dependency, pinned by hash");
  await sheet.getByTestId("package-approve").click();
  await expect(page.getByText("ocw-deps 0.9.0 approved.", { exact: false })).toBeVisible();
  await expect(rowOf(page, "ocw-deps")).toBeVisible();
});

// ---------------------------------------------------------------- Task 2: rows, read-only, Marketplace, both widths

test("row switches save on toggle and come back after a refusal; Remove… asks first", async ({
  browser,
}, info) => {
  const tag = info.project.name;
  const name = `ocw-flags-${tag}`;
  const pkg = await approveByApi({ source: "npm", name, version: "1.2.0" });
  const page = await signIn(browser, info.project.name);
  await openPackages(page);
  const row = rowOf(page, name);
  await expect(row).toBeVisible();

  // "Bots can use it" off: PATCH, and it stays off after a reload.
  const enabled = row.getByTestId("package-flag-enabled");
  await expect(enabled).toBeChecked();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/v1/sandbox/packages/${pkg.id}`) && r.request().method() === "PATCH",
  );
  await enabled.click();
  expect((await saved).ok()).toBe(true);
  await expect(enabled).not.toBeChecked();
  await expect(row.getByTestId("package-status")).toHaveText("Off");
  await page.reload();
  await expect(rowOf(page, name).getByTestId("package-flag-enabled")).not.toBeChecked();
  expect((await listPackages()).find((p) => p.id === pkg.id)?.enabled).toBe(false);

  // A refused save: the toast, and the switch is back where it was.
  await page.route(`**/api/v1/sandbox/packages/${pkg.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 500,
          json: { error: { code: "internal", message: "The server could not save this change" } },
        })
      : route.fallback(),
  );
  const personal = rowOf(page, name).getByTestId("package-flag-personalAllowed");
  await expect(personal).not.toBeChecked();
  await personal.click();
  await expect(page.getByText("Could not change the package")).toBeVisible();
  await expect(personal).not.toBeChecked();
  await page.unroute(`**/api/v1/sandbox/packages/${pkg.id}`);
  expect((await listPackages()).find((p) => p.id === pkg.id)?.personalAllowed).toBe(false);

  // Remove… → the confirmation (focus on Cancel) → Remove package → gone.
  await rowOf(page, name).getByTestId("package-menu").click();
  await page.getByTestId("package-menu-remove").click();
  const dialog = page.getByTestId("package-remove-dialog");
  await expect(dialog.getByRole("heading")).toHaveText(`Remove ${name}?`);
  await expect(dialog).toContainText(
    "It's removed from every bot's sandbox the next time each one starts. Files bots made with it stay.",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.getByTestId("package-remove-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(rowOf(page, name)).toHaveCount(0);
  expect((await listPackages()).map((p) => p.id)).not.toContain(pkg.id);
});

test("a package whose tree changed upstream after approval says so and offers Review…", async ({
  browser,
}, info) => {
  const tag = info.project.name;
  const coords = { source: "pypi", name: `ocw-drift-${tag}`, version: "4.0.0" } as const;
  const bot = await scoutBot(`Drift ${tag}`);
  await approveByApi(coords);
  // A dependency is republished after the approval: the next start refuses the install and marks the package.
  await fakeSandboxd().setPackage(coords, { depChanged: true });
  await startSandbox(bot);
  await expect
    .poll(async () => (await listPackages()).find((p) => p.name === coords.name)?.changedUpstream)
    .toBe(true);

  const page = await signIn(browser, info.project.name);
  await openPackages(page);
  const row = rowOf(page, coords.name);
  await expect(row.getByTestId("package-status")).toHaveText("Changed upstream");
  await expect(row.getByTestId("package-status-hint")).toHaveText(
    "A dependency changed after approval. Review it again.",
  );
  await checkScreen(page, '[data-testid="sandbox-packages"]', `packages ${tag}`);

  // Review… opens a fresh review of the same release; approving it again replaces the row.
  await row.getByTestId("package-review-again").click();
  const sheet = page.getByTestId("package-review-sheet");
  await expect(sheet.getByTestId("package-facts")).toBeVisible();
  await expect(sheet.getByTestId("package-review-version")).toHaveText("4.0.0");
  await sheet.getByTestId("package-approve").click();
  await expect(page.getByText(`${coords.name} 4.0.0 approved.`, { exact: false })).toBeVisible();
  await expect(rowOf(page, coords.name).getByTestId("package-status")).not.toHaveText("Changed upstream");
  expect((await listPackages()).find((p) => p.name === coords.name)?.changedUpstream).toBe(false);
});

test("without plugin.manage the list is read-only", async ({ browser }, info) => {
  const tag = info.project.name;
  const name = `ocw-visible-${tag}`;
  await approveByApi({ source: "debian", name, version: "7.1.2-1" });
  const ritaId = await ensureMember(admin, RITA, "admin");
  if (!ritaRule) {
    const rules = (await (await admin.get("/api/v1/permission-rules")).json()) as {
      rules: Array<{ id: string; subjectId: string | null; permission: string; effect: string }>;
    };
    ritaRule =
      rules.rules.find(
        (r) => r.subjectId === ritaId && r.permission === "plugin.manage" && r.effect === "deny",
      )?.id ?? null;
  }
  if (!ritaRule) {
    const res = await admin.post("/api/v1/permission-rules", {
      data: { subjectKind: "user", subjectId: ritaId, permission: "plugin.manage", effect: "deny" },
    });
    expect(res.ok(), `deny plugin.manage: ${res.status()} ${await res.text()}`).toBe(true);
    ritaRule = ((await res.json()) as { id: string }).id;
  }

  const page = await signIn(browser, info.project.name, RITA);
  const section = await openPackages(page);
  const row = rowOf(page, name);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Debian");
  await expect(section.getByTestId("packages-read-only")).toHaveText(
    "Only workspace admins can approve packages.",
  );
  await expect(section.getByTestId("package-add")).toHaveCount(0);
  await expect(section.getByRole("switch")).toHaveCount(0);
  await expect(section.getByTestId("package-menu")).toHaveCount(0);
  // The API agrees: no review for Rita.
  const rita = await apiAs(RITA);
  const res = await rita.post("/api/v1/sandbox/packages/review", {
    data: { source: "npm", name: "left-pad", version: "1.3.0" },
  });
  expect(res.status()).toBe(403);
  await rita.dispose();
});

test("the Marketplace points to sandbox packages, and a native shell plugin is Blocked with the R12 reason", async ({
  browser,
}, info) => {
  const page = await signIn(browser, info.project.name);
  await page.goto(`${BASE_URL}/settings/marketplace`);
  const pointer = page.getByTestId("marketplace-sandbox-pointer");
  await expect(pointer).toHaveText("Packages for bot sandboxes are in Settings › Sandbox & Browser.");
  await expect(pointer.getByRole("link")).toHaveAttribute("href", "/settings/sandbox");

  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake ClawHub is not running)");
  await page.getByTestId("marketplace-search").fill("shell");
  const entry = page.locator(`[data-testid="marketplace-entry"][data-package="${SHELL}"]`);
  await expect(entry).toBeVisible();
  await entry.click();
  const sheet = page.getByTestId("plugin-review-sheet");
  await expect(sheet.getByTestId("risk-refuse")).toHaveText("Blocked");
  await expect(sheet.locator('[data-testid="risk-reason"][data-code="dangerous_tool"]')).toContainText(
    "Runs inside the bot runtime, not a sandbox. Use a sandbox package instead.",
  );
  await expect(sheet.getByTestId("plugin-install")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await pointer.getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/sandbox$/u);
  await expect(page.getByTestId("sandbox-packages")).toBeVisible({ timeout: 15_000 });
});

test("the packages at this width: axe in light and dark, the dialog and sheet, the review screenshots", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  const w = mobile ? "390" : "1440";
  const tag = info.project.name;
  const fake = fakeSandboxd();
  // A representative list (installed, installing, changed upstream), so the review frames show the section itself.
  await clearPackages();
  // Reviewed (medium risk: a maintainer script) but not approved, so the sheet shows its Approve button.
  const shown = { source: "debian", name: "ffmpeg", version: "7:7.1.2-1" } as const;
  await fake.setPackage(shown, { hasInstallScript: true });
  // One drift release per project: the fake's registry state outlives the first project's run.
  const drift = { source: "pypi", name: "requests", version: mobile ? "2.32.4" : "2.32.3" } as const;
  const bot = await scoutBot(`Lens ${tag}`);
  await approveByApi({ source: "pypi", name: "polars", version: "1.9.0" });
  await approveByApi(drift);
  await fake.setPackage(drift, { depChanged: true });
  await startSandbox(bot);
  await approveByApi({ source: "npm", name: "csv-parse", version: "5.6.0" });
  const page = await signIn(browser, info.project.name);
  const section = await openPackages(page);
  await expect(rowOf(page, "polars").getByTestId("package-status")).toHaveText("Installed in 1 bot");
  await expect(rowOf(page, "requests").getByTestId("package-status")).toHaveText("Changed upstream");
  await expect(rowOf(page, "csv-parse").getByTestId("package-status")).toHaveText("Installing");
  // The section's title at the top of the view (below the sticky page header).
  await section.evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    let box = el.parentElement;
    while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
    (box ?? document.scrollingElement)?.scrollBy(0, -88);
  });
  await checkScreen(page, '[data-testid="sandbox-packages"]', `packages ${w}`);
  if (mobile) {
    // Rows stack: the two switches one under the other, the ⋯ a 44 px target in the top-right corner.
    const row = rowOf(page, "polars");
    const [a, b] = [
      await row.getByTestId("package-flag-enabled").boundingBox(),
      await row.getByTestId("package-flag-personalAllowed").boundingBox(),
    ];
    expect(a && b && b.y > a.y + 20).toBe(true);
    const menu = await row.getByTestId("package-menu").boundingBox();
    expect(menu?.width ?? 0).toBeGreaterThanOrEqual(43.5);
  }
  await captureReview(page, `settings-packages-${w}`);

  // The Add dialog: full screen at 390.
  await page.getByTestId("package-add").first().click();
  const dialog = page.getByTestId("add-package-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("package-source-debian").check();
  await dialog.getByTestId("package-name").fill(shown.name);
  await dialog.getByTestId("package-version").fill("7:7.1.2-2");
  await checkScreen(page, '[data-testid="add-package-dialog"]', `add dialog ${w}`);
  if (mobile) {
    const box = await dialog.boundingBox();
    expect(box && box.width >= 389 && box.height >= 843).toBe(true);
  }
  await captureReview(page, `settings-packages-add-${w}`);

  // The review sheet (medium risk: a maintainer script).
  await dialog.getByTestId("package-version").fill(shown.version);
  await dialog.getByTestId("package-review").click();
  const sheet = page.getByTestId("package-review-sheet");
  await expect(sheet.getByTestId("package-risk")).toHaveAttribute("data-risk", "medium");
  await expect(sheet.getByTestId("package-install-script")).toHaveText(
    "Runs an install script inside the sandbox",
  );
  await expect(sheet.getByTestId("package-approve")).toHaveText(`Approve ${shown.name}@${shown.version}`);
  await checkScreen(page, '[data-testid="package-review-sheet"]', `review sheet ${w}`);
  await captureReview(page, `settings-packages-review-${w}`);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
