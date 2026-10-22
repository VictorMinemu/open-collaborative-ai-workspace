import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { fakeSandboxd, resume } from "../support/sandbox";
import { ADMIN } from "./env";

/**
 * Settings › Sandbox & Browser (07.8-19; SBX-03, SBX-05, BRW-04, D-09, D-11, D-12, P-02, UI-SPEC §4.1-4.3) against the
 * real API and the fake sandboxd (`scripts/e2e-isolated.sh`). An admin finds the page after Bot policy, reads the
 * isolation the server reports, and turns the organization switch on after a confirmation that carries the isolation
 * sentence; the state comes back from the API on reload. A member has no entry and the direct URL says they can't
 * manage sandboxes. With the sandbox service down the switch can't be turned on and says why. Limits and Network save
 * with the version read (a stale version reloads the current values with a notice), the allowlist editor checks hosts,
 * and the kill switch stops everything with a banner naming who and when; Resume is immediate. Settings › Modules
 * shows Sandbox and Browser after Memory with the D-12 hint, and a unit row locked by the organization says how to get
 * "one team only". Every surface passes axe in light and dark, has named controls, no sideways scroll and 44 px
 * targets at 390, and the UI-SPEC screenshots are captured when OCW_E2E_SCREENSHOT_DIR is set.
 *
 * The fake sandboxd reports gVisor; the hardened and Docker-too-old variants rewrite the isolation of the API's own
 * answer in the browser (the server is the only source of the other fields). The spec leaves the organization's
 * settings, kill state, modules and the fake service as it found them (defaults, resumed, on, up).
 */

test.describe.configure({ mode: "serial" });

const DEFAULT_LIMITS = {
  maxSandboxes: 10,
  maxBrowsers: 3,
  cpuMinutesPerDay: 600,
  diskPerBotMb: 2048,
  diskTotalMb: 51_200,
};

type View = {
  settings: {
    version: number;
    enabled: boolean;
    sandboxEgress: string;
    browserEgress: string;
    allowHosts: string[];
    limits: typeof DEFAULT_LIMITS;
    killed: { at: string; by: { displayName: string } | null } | null;
  };
  isolation: { status: string; runtime: string | null };
};

let admin: APIRequestContext;
const open: BrowserContext[] = [];
let unitId: string | null = null;

async function readView(): Promise<View> {
  const res = await admin.get("/api/v1/sandbox/settings");
  expect(res.ok(), `GET /sandbox/settings: ${res.status()}`).toBe(true);
  return (await res.json()) as View;
}

/** One versioned save through the API (another admin, or another tab). */
async function putSettings(patch: Record<string, unknown>): Promise<void> {
  const { settings } = await readView();
  const res = await admin.put("/api/v1/sandbox/settings", {
    data: { expectedVersion: settings.version, ...patch },
  });
  expect(res.ok(), `PUT /sandbox/settings: ${res.status()} ${await res.text()}`).toBe(true);
}

/** The organization's defaults: switched off, Browser public, Shell allowlist, no hosts, default limits. */
async function resetSettings(): Promise<void> {
  await putSettings({
    enabled: false,
    browserEgress: "public",
    sandboxEgress: "allowlist",
    allowHosts: [],
    limits: DEFAULT_LIMITS,
  });
}

async function setModule(module: "sandbox" | "browser", enabled: boolean): Promise<void> {
  const res = await admin.put("/api/v1/module-access", {
    data: { module, scopeUnitId: null, subject: { kind: "everyone" }, enabled },
  });
  expect(res.ok(), `module ${module} ${enabled}: ${res.status()}`).toBe(true);
}

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await fakeSandboxd().up();
  await resume(admin);
  await resetSettings();
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  if (!admin) return;
  await fakeSandboxd().up();
  await resume(admin);
  await resetSettings();
  await setModule("sandbox", true);
  await setModule("browser", true);
  if (unitId) await admin.delete(`/api/v1/units/${unitId}`);
  await admin.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], project: string, who: Actor = ADMIN) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

async function openSettings(page: Page) {
  await page.goto(`${BASE_URL}/settings/sandbox`);
  await expect(page.getByTestId("sandbox-settings")).toBeVisible({ timeout: 15_000 });
}

/** Rewrites the isolation of the API's own GET answer (the fake sandboxd always reports gVisor). */
async function isolationAs(page: Page, patch: Record<string, unknown>) {
  await page.route(/\/api\/v1\/sandbox\/settings$/u, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = (await res.json()) as View;
    await route.fulfill({ response: res, json: { ...body, isolation: { ...body.isolation, ...patch } } });
  });
}

/** axe (light and dark), named controls, no sideways scroll; 44 px targets below 1024. */
async function checkScreen(page: Page, selectors: readonly string[], label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const selector of selectors) await expectNoSeriousA11y(page, selector);
    expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} ${theme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  for (const selector of selectors) await expectTouchTargets(page, selector);
}

const PAGE_PARTS = [
  '[data-testid="sandbox-settings"]',
  '[data-testid="org-switch"]',
  '[data-testid="isolation-card"]',
  '[data-testid="limits-form"]',
  '[data-testid="egress-form"]',
  '[data-testid="kill-switch"]',
] as const;

// ---------------------------------------------------------------- Task 1: the organization switch (tracer)

test("an admin turns Sandbox & Browser on for the organization after reading the isolation sentence", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the tracer runs at 1440; 390 is proven below");
  const page = await signIn(browser, info.project.name);

  // Settings › Sandbox & Browser, right after Bot policy.
  await page.goto(`${BASE_URL}/settings`);
  const entry = page.getByTestId("settings-nav-sandbox").filter({ visible: true });
  await expect(entry).toHaveText("Sandbox & Browser");
  const entries = await page
    .locator('[data-testid^="settings-nav-"]')
    .filter({ visible: true })
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(entries.indexOf("settings-nav-sandbox")).toBe(entries.indexOf("settings-nav-bot-policy") + 1);
  await entry.click();
  await expect(page).toHaveURL(/\/settings\/sandbox$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Sandbox & Browser" })).toBeVisible();
  await expect(page.getByText("Where bots run commands and browse, and the limits they share")).toBeVisible();

  // Off by default; the isolation the fake reports (gVisor), with the running counts.
  const card = page.getByTestId("org-switch");
  await expect(card).toHaveAttribute("data-enabled", "off");
  await expect(page.getByTestId("isolation-card")).toHaveAttribute("data-runtime", "gvisor");
  await expect(page.getByTestId("isolation-title")).toHaveText("gVisor");
  await expect(page.getByTestId("isolation-running")).toContainText("running now");

  // Turning it on asks first, with the isolation sentence; Cancel keeps it off.
  const toggle = page.getByTestId("org-switch-toggle");
  await toggle.click();
  const dialog = page.getByTestId("org-switch-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Turn on Sandbox & Browser for the organization?");
  await expect(dialog.getByTestId("org-switch-isolation")).toHaveText(
    "Each sandbox is isolated with gVisor.",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toHaveAttribute("data-enabled", "off");
  expect((await readView()).settings.enabled).toBe(false);

  // Turn on → toast, the switch on, and the API holds it across a reload.
  await toggle.click();
  await page.getByTestId("org-switch-confirm").click();
  await expect(page.getByText("Sandbox & Browser is on for the organization")).toBeVisible();
  await expect(card).toHaveAttribute("data-enabled", "on");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect((await readView()).settings.enabled).toBe(true);
  await page.reload();
  await expect(page.getByTestId("org-switch")).toHaveAttribute("data-enabled", "on");

  // Turning it off applies at once.
  await page.getByTestId("org-switch-toggle").click();
  await expect(page.getByText("Sandbox & Browser is off for the organization")).toBeVisible();
  await expect(page.getByTestId("org-switch")).toHaveAttribute("data-enabled", "off");
  expect((await readView()).settings.enabled).toBe(false);
});

test("a member has no Sandbox & Browser entry and the direct URL says they can't manage sandboxes", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "permissions are the same at both widths");
  const page = await signIn(browser, info.project.name, SAM);
  await page.goto(`${BASE_URL}/settings`);
  await expect(page.getByTestId("settings-nav-profile").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("settings-nav-sandbox")).toHaveCount(0);
  await page.goto(`${BASE_URL}/settings/sandbox`);
  await expect(page.getByRole("heading", { name: "You can't manage sandboxes" })).toBeVisible();
  await expect(page.getByTestId("sandbox-settings")).toHaveCount(0);
  await page.getByRole("link", { name: "Back to settings" }).click();
  await expect(page).toHaveURL(/\/settings$/u);
  // The API refuses anyway (T-07.8-19-01).
  const sam = await apiAs(SAM);
  expect((await sam.get("/api/v1/sandbox/settings")).status()).toBe(403);
  await sam.dispose();
});

test("with the sandbox service down the card says how to start it and the switch can't be turned on", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "one width is enough for the variant");
  const page = await signIn(browser, info.project.name);
  const fake = fakeSandboxd();
  await fake.down();
  try {
    await openSettings(page);
    const iso = page.getByTestId("isolation-card");
    await expect(iso).toHaveAttribute("data-runtime", "down");
    await expect(iso).toContainText("The sandbox service isn't running");
    await expect(iso.locator("code")).toHaveText("docker compose --profile sandbox up -d");
    await expect(page.getByTestId("org-switch-reason")).toHaveText(
      "The sandbox service isn't running on this server.",
    );
    await expect(page.getByTestId("org-switch-toggle")).toHaveAttribute("aria-disabled", "true");
    // Saving limits and network rules waits for the service, with the same reason.
    await expect(page.getByTestId("limits-disabled")).toHaveText(
      "The sandbox service isn't running on this server.",
    );
  } finally {
    await fake.up();
  }
  await page.reload();
  await expect(page.getByTestId("isolation-card")).toHaveAttribute("data-runtime", "gvisor");
  await expect(page.getByTestId("org-switch-reason")).toHaveCount(0);
});

test("hardened containers and an old Docker are said as reported, in the card and in the turn-on dialog", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "settings-sandbox-hardened-1440 is a desktop screenshot");
  const page = await signIn(browser, info.project.name);
  await isolationAs(page, { runtime: "hardened-runc", browserSandbox: "container-only" });
  await openSettings(page);
  const iso = page.getByTestId("isolation-card");
  await expect(iso).toHaveAttribute("data-runtime", "hardened");
  await expect(page.getByTestId("isolation-title")).toHaveText("Hardened containers (no gVisor)");
  await expect(iso).toContainText("A kernel flaw could let a bot reach the server.");
  await expect(page.getByTestId("isolation-browser")).toBeVisible();
  await checkScreen(page, ['[data-testid="isolation-card"]'], "hardened");
  await captureReview(page, "settings-sandbox-hardened-1440");

  await page.getByTestId("org-switch-toggle").click();
  const dialog = page.getByTestId("org-switch-dialog");
  await expect(dialog.getByTestId("org-switch-isolation")).toHaveText(
    "This server has no gVisor, so sandboxes use hardened containers that share the server's kernel.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await page.unroute(/\/api\/v1\/sandbox\/settings$/u);
  await isolationAs(page, { status: "docker_too_old" });
  await page.reload();
  await expect(page.getByTestId("isolation-card")).toHaveAttribute("data-runtime", "docker_old");
  await expect(page.getByTestId("isolation-title")).toHaveText("Docker Engine 26 or later is needed");
  await expect(page.getByTestId("org-switch-reason")).toHaveText(
    "This server needs Docker Engine 26 or later.",
  );
});

// ---------------------------------------------------------------- Task 2: limits, network, kill switch, modules

test("limits save with the version read; an invalid value and a stale version are said inline", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "save behaviour is the same at both widths");
  const page = await signIn(browser, info.project.name);
  await openSettings(page);
  const form = page.getByTestId("limits-form");
  const save = page.getByTestId("limits-save");
  await expect(save).toBeDisabled();

  // Out of range: the row says the range and Save stays off.
  const sandboxes = page.getByTestId("limit-input-maxSandboxes");
  await sandboxes.fill("101");
  await expect(form.getByTestId("limit-error")).toHaveText("Use a whole number from 0 to 100");
  await expect(save).toBeDisabled();

  // A valid change saves with a toast; the API holds it.
  await sandboxes.fill("12");
  await expect(form.getByTestId("limit-error")).toHaveCount(0);
  await save.click();
  await expect(page.getByText("Limits saved")).toBeVisible();
  expect((await readView()).settings.limits.maxSandboxes).toBe(12);
  await expect(save).toBeDisabled();

  // Another tab saves first: this page's save is refused, the current values load with a notice.
  await putSettings({ limits: { ...(await readView()).settings.limits, maxBrowsers: 4 } });
  await page.getByTestId("limit-input-cpuMinutesPerDay").fill("700");
  await page.getByTestId("limits-save").click();
  await expect(page.getByTestId("limits-notice")).toContainText("Someone else saved these settings first.");
  await expect(page.getByTestId("limit-input-maxBrowsers")).toHaveValue("4");
  await expect(page.getByTestId("limit-input-cpuMinutesPerDay")).toHaveValue("600");
  expect((await readView()).settings.limits.cpuMinutesPerDay).toBe(600);
  // Saving again from the current values works.
  await page.getByTestId("limit-input-cpuMinutesPerDay").fill("700");
  await expect(page.getByTestId("limits-notice")).toHaveCount(0);
  await page.getByTestId("limits-save").click();
  // The first save's toast may still be up: the API's answer is the proof.
  await expect(page.getByTestId("limits-save")).toBeDisabled();
  await expect
    .poll(async () => (await readView()).settings.limits)
    .toEqual({
      ...DEFAULT_LIMITS,
      maxSandboxes: 12,
      maxBrowsers: 4,
      cpuMinutesPerDay: 700,
    });
  await putSettings({ limits: DEFAULT_LIMITS });
});

test("network rules: defaults, the allowlist editor's checks, package registries and the save", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "save behaviour is the same at both widths");
  const page = await signIn(browser, info.project.name);
  await openSettings(page);
  await expect(page.getByTestId("egress-browser-public")).toBeChecked();
  await expect(page.getByTestId("egress-shell-allowlist")).toBeChecked();
  const list = page.getByTestId("egress-allowlist");
  await expect(list).toBeVisible();

  const input = page.getByTestId("egress-host-input");
  await input.fill("https://x/y");
  await page.getByTestId("egress-host-add").click();
  await expect(page.getByTestId("egress-host-error")).toHaveText(
    "Use a host like api.example.com or *.example.com, with an optional :port",
  );
  await input.fill("api.example.com:8443");
  await input.press("Enter");
  await input.fill("*.example.com");
  await page.getByTestId("egress-host-add").click();
  await input.fill("api.example.com:8443");
  await page.getByTestId("egress-host-add").click();
  await expect(page.getByTestId("egress-host-error")).toHaveText("Already listed");
  await page.getByTestId("egress-registries").click();
  await expect(page.getByText("Added 4 registries")).toBeVisible();
  await expect(list.getByTestId("egress-host-chip")).toHaveCount(6);
  await list.getByRole("button", { name: "Remove *.example.com" }).click();
  await expect(list.getByTestId("egress-host-chip")).toHaveCount(5);

  // With neither part on Allowlist the editor hides (the hosts stay in the draft).
  await page.getByTestId("egress-shell-public").check();
  await expect(list).toBeHidden();
  await page.getByTestId("egress-shell-allowlist").check();
  await expect(list).toBeVisible();

  await page.getByTestId("egress-save").click();
  await expect(page.getByText("Network rules saved")).toBeVisible();
  const { settings } = await readView();
  expect(settings.allowHosts).toEqual([
    "api.example.com:8443",
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "deb.debian.org",
  ]);
  expect(settings.browserEgress).toBe("public");
  expect(settings.sandboxEgress).toBe("allowlist");
});

test("Stop everything asks first, shows who stopped it and when, and Resume brings it back at once", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the kill dialog at 390 is proven below");
  const page = await signIn(browser, info.project.name);
  await openSettings(page);
  await expect(page.getByTestId("kill-switch-banner")).toHaveCount(0);

  await page.getByTestId("kill-switch-stop").click();
  const dialog = page.getByTestId("kill-switch-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Stop all sandboxes and browsers?");
  await expect(dialog).toContainText("including anyone signing in");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.getByTestId("kill-switch-confirm").click();
  await expect(dialog).toBeHidden();

  const banner = page.getByTestId("kill-switch-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner).toContainText("All sandboxes and browsers are stopped");
  await expect(page.getByTestId("kill-switch-by")).toHaveText(
    new RegExp(`^Stopped by ${ADMIN.name} · [A-Z][a-z]{2} \\d{1,2}, \\d{2}:\\d{2}$`, "u"),
  );
  await expect(page.getByTestId("kill-switch-stop")).toHaveCount(0);
  await expect(page.getByTestId("kill-switch-card-resume")).toBeVisible();
  expect((await readView()).settings.killed).not.toBeNull();
  await checkScreen(page, ['[data-testid="kill-switch-banner"]', '[data-testid="kill-switch"]'], "killed");
  // The banner sits at the top of the page (the click on Stop scrolled to the bottom).
  await banner.scrollIntoViewIfNeeded();
  await captureReview(page, "settings-sandbox-killed-1440");

  await page.getByTestId("kill-switch-resume").click();
  await expect(page.getByText("Sandboxes and browsers are back on")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("kill-switch-stop")).toBeVisible();
  expect((await readView()).settings.killed).toBeNull();
});

test("Settings › Modules: Sandbox and Browser after Memory with the D-12 hint; a unit locked by the organization says how to get one team", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "modules-*-1440 are desktop screenshots");
  const page = await signIn(browser, info.project.name);
  try {
    await page.goto(`${BASE_URL}/settings/modules`);
    const rows = page.getByTestId("module-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-module")))).toEqual([
      "work_zone",
      "ai_chats",
      "bots",
      "memory",
      "sandbox",
      "browser",
    ]);
    const sandbox = page.locator('[data-testid="module-row"][data-module="sandbox"]');
    const browserRow = page.locator('[data-testid="module-row"][data-module="browser"]');
    await expect(sandbox.locator("svg.lucide-container")).toHaveCount(1);
    await expect(browserRow.locator("svg.lucide-monitor-play")).toHaveCount(1);
    for (const row of [sandbox, browserRow]) {
      await expect(row.getByTestId("module-org-hint")).toHaveText(
        "Runs only when Sandbox & Browser is on for the organization.",
      );
    }
    await expect(
      page.locator('[data-testid="module-row"][data-module="memory"]').getByTestId("module-org-hint"),
    ).toHaveCount(0);
    await checkScreen(page, ['[data-testid="module-access"]'], "modules");
    await sandbox.scrollIntoViewIfNeeded();
    await captureReview(page, "modules-sandbox-browser-1440");

    // Off at the organization uses the existing confirmation; on needs none (P-02).
    await page.getByTestId("module-switch-sandbox").click();
    const confirm = page.getByTestId("module-confirm");
    await expect(confirm.getByRole("heading")).toHaveText("Turn Sandbox off for everyone?");
    await page.getByTestId("module-confirm-off").click();
    await expect(sandbox).toHaveAttribute("data-state", "off");

    // A unit under the organization's off: the inherited line and the one-team hint.
    const name = `Field ${Date.now().toString(36).slice(-4)}`;
    const res = await admin.post("/api/v1/units", { data: { kind: "department", name, parentId: null } });
    expect(res.ok(), `create unit: ${res.status()}`).toBe(true);
    unitId = ((await res.json()) as { id: string }).id;
    await page.goto(`${BASE_URL}/settings/organization`);
    await page.locator(`[data-testid="unit-row"][aria-label^="${name},"]`).click();
    await expect(page.getByTestId("unit-detail-name").filter({ visible: true })).toHaveText(name);
    const unitCard = page.getByTestId("module-access").filter({ visible: true });
    const unitSandbox = unitCard.locator('[data-testid="module-row"][data-module="sandbox"]');
    await expect(unitSandbox.getByTestId("module-inherited")).toContainText("Off for the whole organization");
    await expect(unitSandbox.getByRole("link", { name: "Change" })).toBeVisible();
    await expect(unitSandbox.getByTestId("module-unit-hint")).toHaveText(
      "To turn it on for one team, turn it on for the organization, then off for the teams that shouldn't have it.",
    );
    await expect(unitSandbox.getByTestId("module-switch-sandbox")).toHaveAttribute("aria-disabled", "true");
    await expect(
      unitCard.locator('[data-testid="module-row"][data-module="browser"]').getByTestId("module-unit-hint"),
    ).toHaveCount(0);
    await checkScreen(page, ['[data-testid="module-access"]'], "unit modules");
    await unitSandbox.scrollIntoViewIfNeeded();
    await captureReview(page, "modules-unit-locked-1440");

    // Back on at the organization, without a dialog.
    await page.goto(`${BASE_URL}/settings/modules`);
    await page.getByTestId("module-switch-sandbox").click();
    await expect(page.getByTestId("module-confirm")).toHaveCount(0);
    await expect(page.locator('[data-testid="module-row"][data-module="sandbox"]')).toHaveAttribute(
      "data-state",
      "on",
    );
  } finally {
    await setModule("sandbox", true);
    if (unitId) await admin.delete(`/api/v1/units/${unitId}`);
    unitId = null;
  }
});

// ---------------------------------------------------------------- Task 3: both widths, both themes, screenshots

test("the page at this width: axe in light and dark, named controls, 44 px targets, the review screenshots", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  const w = mobile ? "390" : "1440";
  const page = await signIn(browser, info.project.name);
  await resetSettings();
  await openSettings(page);
  await expect(page.getByTestId("isolation-card")).toHaveAttribute("data-runtime", "gvisor");
  await checkScreen(page, PAGE_PARTS, `settings ${w}`);
  if (mobile) {
    // Stacked rows: full-width inputs and save buttons at 390.
    const input = page.getByTestId("limit-input-maxSandboxes");
    const form = page.getByTestId("limits-form");
    const [ib, fb] = [await input.boundingBox(), await form.boundingBox()];
    expect(ib && fb && ib.width > fb.width - 64).toBe(true);
    expect((await page.getByTestId("limits-save").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  }
  await captureReview(page, `settings-sandbox-${w}`);

  // The organization switch's dialog (P-02: the turn-on confirmation moved here from the module rows).
  await page.getByTestId("org-switch-toggle").click();
  const dialog = page.getByTestId("org-switch-dialog");
  await expect(dialog).toBeVisible();
  await checkScreen(page, ['[data-testid="org-switch-dialog"]'], `turn-on dialog ${w}`);
  if (mobile) await captureReview(page, "modules-turn-on-dialog-390");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // The kill switch's confirmation.
  await page.getByTestId("kill-switch-stop").scrollIntoViewIfNeeded();
  await page.getByTestId("kill-switch-stop").click();
  const kill = page.getByTestId("kill-switch-dialog");
  await expect(kill).toBeVisible();
  await expect(kill.getByRole("button", { name: "Cancel" })).toBeFocused();
  await checkScreen(page, ['[data-testid="kill-switch-dialog"]'], `kill dialog ${w}`);
  if (mobile) await captureReview(page, "settings-sandbox-kill-dialog-390");
  await kill.getByRole("button", { name: "Cancel" }).click();
  await expect(kill).toBeHidden();
  expect((await readView()).settings.killed).toBeNull();

  if (mobile) {
    // The banner at 390: Resume full width, 44 px.
    await page.getByTestId("kill-switch-stop").click();
    await page.getByTestId("kill-switch-confirm").click();
    await expect(page.getByTestId("kill-switch-banner")).toBeVisible();
    await page.getByTestId("kill-switch-banner").scrollIntoViewIfNeeded();
    await checkScreen(page, ['[data-testid="kill-switch-banner"]'], "killed 390");
    await page.getByTestId("kill-switch-resume").click();
    await expect(page.getByText("Sandboxes and browsers are back on")).toBeVisible();
    await expect(page.getByTestId("kill-switch-banner")).toHaveCount(0);
  }
});
