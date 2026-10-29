import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { expectNoSidewaysScroll, expectTouchTargets, unnamedControls } from "../support/layout";
import {
  type CliHome,
  deviceAs,
  deviceEnv,
  type FakeRegistry,
  makeCliHome,
  ownerRuntimeStatus,
  RUNTIME_PACKAGES,
  startFakeRegistry,
} from "../support/runtime-updates";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, shot } from "./env";

/**
 * Runtime CLI updates in the web (Phase 07.11-10, D-02…D-06, PD-15, RTU-03/05/06/07) on the real stack: the REAL
 * daemon in fake-runtime mode on scratch fake CLIs and a 127.0.0.1 registry stub (PD-19, `support/runtime-updates.ts`).
 * - the owner: Settings › Devices › Runtime updates says Claude Code is behind, "Update now" shows it updating, then up
 *   to date, and the history names the owner;
 * - a member (D-04, D-06): on a shared device reporting Claude Code 2.1.200 the chip says "· older than supported", there
 *   is no runtime updates block, and the new-session dialog keeps the runtime usable with the warning;
 * - an admin (D-02): Settings › Work Zone policy › Runtime updates, saved with the existing Save;
 * - a held turn (D-03): a prompt sent while Claude Code updates shows "Updating Claude Code…", then the new version.
 * Every state passes axe (no serious issue), names every control, never scrolls sideways and keeps 44 px targets below
 * 768, on both projects (1440 and 390) and in light and dark; screenshots go to OCW_E2E_SCREENSHOT_DIR.
 */

test.describe.configure({ mode: "serial" });

const CLAUDE_PKG = RUNTIME_PACKAGES["claude-code"];
const CODEX_PKG = RUNTIME_PACKAGES.codex;

async function ok<R>(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<R> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as R;
}

async function setOrgLevel(api: APIRequestContext, level: "automatic" | "notify" | "off"): Promise<string> {
  const before = await ok<{ runtimeUpdates: string }>(
    await api.get("/api/v1/work-zone-policy"),
    "read policy",
  );
  await ok(
    await api.put("/api/v1/work-zone-policy", { data: { runtimeUpdates: level } }),
    "set runtimeUpdates",
  );
  return before.runtimeUpdates;
}

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The layout and accessibility rules for one state, in the current theme and then in dark. */
async function checkState(page: Page, selector: string, touchRoot: string = selector) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoSeriousA11y(page, selector);
    expect.soft(await unnamedControls(page), `${selector} (${scheme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${selector} (${scheme})`);
    await expectTouchTargets(page, touchRoot);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

interface Setup {
  orgLevel: "automatic" | "notify" | "off";
  registry: { claude: string; codex: string };
  installed: { claude: string; codex: string };
  shared?: boolean;
}

/** One device on scratch CLIs and its own registry; everything stopped, browsers closed and the level restored. */
async function withDevice(
  admin: APIRequestContext,
  name: string,
  setup: Setup,
  body: (ctx: {
    device: FakeDeviceHandle;
    registry: FakeRegistry;
    cli: CliHome;
    contexts: BrowserContext[];
  }) => Promise<void>,
) {
  let previousLevel: string | null = null;
  let registry: FakeRegistry | null = null;
  let cli: CliHome | null = null;
  let device: FakeDeviceHandle | null = null;
  const contexts: BrowserContext[] = [];
  try {
    previousLevel = await setOrgLevel(admin, setup.orgLevel);
    registry = await startFakeRegistry();
    registry.setLatest(CLAUDE_PKG, "latest", setup.registry.claude);
    registry.setLatest(CODEX_PKG, "latest", setup.registry.codex);
    cli = makeCliHome(setup.installed);
    device = await startFakeDevice(admin, {
      name,
      projectName: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      env: deviceEnv(cli.home, registry),
    });
    if (setup.shared) {
      await ok(await admin.patch(`/api/v1/devices/${device.deviceId}`, { data: { shared: true } }), "share");
    }
    await body({ device, registry, cli, contexts });
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    await device?.stop();
    await registry?.stop();
    cli?.remove();
    if (previousLevel !== null) {
      await admin
        .put("/api/v1/work-zone-policy", { data: { runtimeUpdates: previousLevel } })
        .catch(() => undefined);
    }
  }
}

/** Waits until the owner sees the device's report, then has the device ask the registry. */
async function reported(admin: APIRequestContext, device: FakeDeviceHandle, claude: string) {
  await expect
    .poll(async () => (await ownerRuntimeStatus(admin, device.deviceId, "claude-code"))?.installedVersion, {
      timeout: 60_000,
      message: "the owner sees the scratch Claude Code",
    })
    .toBe(claude);
  await device.runtimeCli(["updates", "check"]);
}

const tagOf = (project: string) => (project === "mobile" ? "390" : "1440");

test("the owner sees Claude Code behind, presses Update now, watches it update and opens the history", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const tag = tagOf(info.project.name);
  const admin = await apiAs(ADMIN);
  const name = `E2E Updates ${tag} ${Date.now().toString(36)}`;
  await withDevice(
    admin,
    name,
    {
      orgLevel: "notify",
      registry: { claude: "2.1.300", codex: "0.165.0" },
      installed: { claude: "2.1.290", codex: "0.165.0" },
    },
    async ({ device, cli, contexts }) => {
      // Long enough to see "Updating…" in the browser.
      cli.setNextUpdate("claude-code", { next: "2.1.300", delayMs: 4000 });
      await reported(admin, device, "2.1.290");
      await expect
        .poll(async () => (await ownerRuntimeStatus(admin, device.deviceId, "claude-code"))?.advisory, {
          timeout: 30_000,
          message: "Claude Code is behind",
        })
        .toBe("behind");

      const owner = await openAs(browser, ADMIN, info.project.name);
      contexts.push(owner.context);
      const page = owner.page;
      await page.goto(`${BASE_URL}/settings/devices`);
      const card = page.getByTestId("device-card").filter({ hasText: name });
      const block = card.getByTestId("runtime-updates");
      const claude = block.locator('[data-testid="runtime-update-row"][data-runtime="claude-code"]');
      const codex = block.locator('[data-testid="runtime-update-row"][data-runtime="codex"]');
      await expect(claude.getByTestId("runtime-update-status")).toHaveText("2.1.300 available", {
        timeout: 15_000,
      });
      await expect(claude).toContainText("2.1.290");
      await expect(claude).toContainText("Native installer · ~/.local/bin");
      await expect(codex.getByTestId("runtime-update-status")).toHaveText("Up to date");
      await expect(block.getByTestId("runtime-update-level")).toContainText(
        "Organization: Notify only · This device: Automatic",
      );
      await expect(block).toContainText("New versions are reported; install them with Update now.");

      await block.scrollIntoViewIfNeeded();
      await checkState(page, '[data-testid="runtime-updates"]');
      await bothThemes(page, `devices-runtime-updates-${tag}`);

      // ---- Update now (D-05): updating, then up to date on the new version
      await claude.getByTestId("runtime-update-now").click();
      await expect(claude.getByTestId("runtime-update-now")).toContainText("Updating…");
      await expect(claude.getByTestId("runtime-update-now")).toBeDisabled();
      await expect(claude.getByTestId("runtime-update-status")).toHaveText("Up to date", { timeout: 60_000 });
      await expect(claude.getByTestId("runtime-update-version")).toHaveText("2.1.300");
      await expect(claude).toContainText("Updated 2.1.290 → 2.1.300");
      await expect(claude.getByTestId("runtime-update-now")).toContainText("Update now", { timeout: 15_000 });
      expect(cli.version("claude-code")).toBe("2.1.300 (Claude Code)");

      // ---- History: the run, requested by the owner, succeeded
      await claude.getByTestId("runtime-update-history").click();
      const sheet = page.getByTestId("runtime-update-history-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(`${name} · Runtime updates`);
      const run = sheet.getByTestId("runtime-update-run").first();
      await expect(run).toHaveAttribute("data-state", "succeeded", { timeout: 15_000 });
      await expect(run).toContainText(`By ${ADMIN.name}`);
      await expect(run).toContainText("2.1.290 → 2.1.300");
      await expect(run).toContainText("Succeeded");
      await checkState(page, '[data-testid="runtime-update-history-sheet"]');
      await bothThemes(page, `devices-runtime-history-${tag}`);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    },
  );
});

test("a member sees the compatibility flag on a shared device with an old Claude Code, and the new-session dialog warns", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const tag = tagOf(info.project.name);
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const name = `E2E Old CLI ${tag} ${Date.now().toString(36)}`;
  await withDevice(
    admin,
    name,
    {
      orgLevel: "automatic",
      // The registry has nothing newer: nothing installs, the device keeps reporting 2.1.200 (older than 2.1.287).
      registry: { claude: "2.1.200", codex: "0.165.0" },
      installed: { claude: "2.1.200", codex: "0.165.0" },
      shared: true,
    },
    async ({ device, contexts }) => {
      await reported(admin, device, "2.1.200");
      await expect
        .poll(async () => (await deviceAs(sam, device.deviceId))?.runtimeCompatibility?.["claude-code"], {
          timeout: 30_000,
          message: "Sam sees Claude Code as unsupported",
        })
        .toBe("unsupported");

      // ---- the owner: the row says the version is unsupported, the tile is amber
      const owner = await openAs(browser, ADMIN, info.project.name);
      contexts.push(owner.context);
      await owner.page.goto(`${BASE_URL}/settings/devices`);
      const ownerCard = owner.page.getByTestId("device-card").filter({ hasText: name });
      await expect(
        ownerCard.locator('[data-testid="runtime-update-row"][data-runtime="claude-code"]'),
      ).toContainText("Unsupported version", { timeout: 15_000 });
      await expect(ownerCard.getByTestId("runtime-compat-flag")).toHaveText("· older than supported");

      // ---- Sam: the chip's flag, no runtime updates block (D-06: only the owner and admins)
      const member = await openAs(browser, SAM, info.project.name);
      contexts.push(member.context);
      const page = member.page;
      await page.goto(`${BASE_URL}/settings/devices`);
      const card = page.getByTestId("device-card").filter({ hasText: name });
      await expect(card.getByTestId("runtime-compat-flag")).toHaveText("· older than supported", {
        timeout: 15_000,
      });
      await expect(card.getByTestId("runtime-compat-flag")).toHaveCount(1);
      await expect(card.getByTestId("runtime-updates")).toHaveCount(0);
      await expect(card.getByTestId("runtime-update-now")).toHaveCount(0);
      await card.scrollIntoViewIfNeeded();
      await checkState(page, '[data-testid="device-card"]');
      await bothThemes(page, `devices-member-flag-${tag}`);

      // ---- the new-session dialog on that device: usable, with the warning (D-04, PD-13)
      await page.goto(`${BASE_URL}/work-zone`);
      await page.getByTestId("new-session").click();
      const dialog = page.getByTestId("new-session-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("project-option").filter({ hasText: device.projectName }).click();
      const claude = dialog.getByTestId("runtime-claude-code");
      await expect(claude.getByTestId("runtime-compat-note")).toHaveText(
        `2.1.200 is older than supported · ask ${ADMIN.name} to update`,
      );
      await expect(claude).toBeEnabled();
      await claude.click();
      await expect(claude).toHaveAttribute("aria-checked", "true");
      await expect(dialog.getByTestId("start-session")).toBeEnabled();
      await claude.scrollIntoViewIfNeeded();
      await checkState(
        page,
        '[data-testid="new-session-dialog"]',
        '[data-testid="new-session-dialog"] [role="radiogroup"][aria-label="Agent"]',
      );
      await bothThemes(page, `new-session-unsupported-${tag}`);
    },
  );
});

test("an admin sets the organization's runtime updates level in Settings › Work Zone policy", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const tag = tagOf(info.project.name);
  const admin = await apiAs(ADMIN);
  const previous = await setOrgLevel(admin, "automatic");
  const contexts: BrowserContext[] = [];
  try {
    const owner = await openAs(browser, ADMIN, info.project.name);
    contexts.push(owner.context);
    const page = owner.page;
    await page.goto(`${BASE_URL}/settings/work-zone-policy`);
    const select = page.getByTestId("policy-runtime-updates");
    await expect(select).toContainText("Automatic");
    await select.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("work-zone-policy-settings")).toContainText(
      "A device owner can lower this on the device",
    );
    await select.click();
    const notify = page.getByRole("option", { name: /Notify only/ });
    await expect(notify).toBeVisible();
    await expect(notify).toContainText("the device owner or an admin presses Update now");
    await checkState(page, '[role="listbox"]', '[data-testid="policy-runtime-updates"]');
    await bothThemes(page, `policy-runtime-updates-${tag}`);

    await notify.click();
    await expect(select).toContainText("Notify only");
    await page.getByTestId("save-policy").click();
    await expect
      .poll(
        async () =>
          (await ok<{ runtimeUpdates: string }>(await admin.get("/api/v1/work-zone-policy"), "read policy"))
            .runtimeUpdates,
        { timeout: 10_000, message: "the policy is saved with runtimeUpdates notify" },
      )
      .toBe("notify");
    await checkState(
      page,
      '[data-testid="work-zone-policy-settings"]',
      '[data-testid="policy-runtime-updates"]',
    );
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    await admin
      .put("/api/v1/work-zone-policy", { data: { runtimeUpdates: previous } })
      .catch(() => undefined);
  }
});

test("a prompt sent while Claude Code updates says it waits, then which version it runs on", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const tag = tagOf(info.project.name);
  const admin = await apiAs(ADMIN);
  const name = `E2E Held ${tag} ${Date.now().toString(36)}`;
  await withDevice(
    admin,
    name,
    {
      orgLevel: "notify",
      registry: { claude: "2.1.300", codex: "0.165.0" },
      installed: { claude: "2.1.290", codex: "0.165.0" },
    },
    async ({ device, cli, contexts }) => {
      // Long enough for a prompt to be sent while it runs (09: the update runs on an idle device at once).
      cli.setNextUpdate("claude-code", { next: "2.1.300", delayMs: 8000 });
      await reported(admin, device, "2.1.290");
      const claude = () => ownerRuntimeStatus(admin, device.deviceId, "claude-code");
      await expect
        .poll(async () => (await claude())?.advisory, { timeout: 30_000, message: "Claude Code is behind" })
        .toBe("behind");

      const session = await ok<{ id: string }>(
        await admin.post("/api/v1/work-sessions", {
          data: {
            projectId: device.projectId,
            runtime: "claude-code",
            permissionMode: "plan",
            title: `Held ${tag}`,
          },
        }),
        "start the session",
      );
      await expect
        .poll(
          async () =>
            (
              await ok<{ session: { status: string } }>(
                await admin.get(`/api/v1/work-sessions/${session.id}`),
                "session",
              )
            ).session.status,
          { timeout: 30_000, message: "the session is ready" },
        )
        .toBe("idle");

      await ok(
        await admin.post(`/api/v1/devices/${device.deviceId}/runtimes/claude-code/update`),
        "Update now",
      );
      await expect
        .poll(async () => (await claude())?.state, {
          timeout: 15_000,
          intervals: [200],
          message: "Claude Code is updating",
        })
        .toBe("running");
      await ok(
        await admin.post(`/api/v1/work-sessions/${session.id}/prompts`, { data: { body: "Now plan it" } }),
        "prompt",
      );

      const owner = await openAs(browser, ADMIN, info.project.name);
      contexts.push(owner.context);
      const page = owner.page;
      await page.goto(`${BASE_URL}/work-zone/${session.id}`);
      const lines = page.getByTestId("runtime-update-line");
      await expect(lines.first()).toHaveText("Updating Claude Code… your turn starts when it finishes", {
        timeout: 20_000,
      });
      await expect(lines.nth(1)).toHaveText("Claude Code updated to 2.1.300", { timeout: 60_000 });
      await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
        timeout: 30_000,
      });
      await lines.first().scrollIntoViewIfNeeded();
      await checkState(page, '[data-testid="session-view"]', '[data-testid="runtime-update-line"]');
      await bothThemes(page, `session-updating-${tag}`);
    },
  );
});
