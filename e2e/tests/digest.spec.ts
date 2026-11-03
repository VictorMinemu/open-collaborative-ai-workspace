import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { ADMIN } from "./env";

/**
 * Settings › Digest in the browser (07.6-16, AUTO-05; D-05, D-07; UI-SPEC Surface 6, R6; C-03) on the real stack and the
 * harness's fake model, at 1440 and 390, light and dark:
 * - tracer: Víctor finds Digest after Notifications, sees a first digest (off, weekdays, his browser's zone, every
 *   section, skip-empty, Scout preselected), turns it on for weekdays at 08:00, saves (toast and `Next:` line),
 *   previews the unsaved form (the exact Markdown, with the DM the admin just sent him), sends a test and opens it in
 *   his DM with Scout;
 * - the AI summary: off by default; on, an organization model shows METERED and who pays (never saved here);
 * - no bot: Sam, with no personal bot and no team bot he can DM, sees the dashed box, a disabled Save with its reason,
 *   and creates his personal bot from the page;
 * - axe on the page and the preview in both themes; at 390 the buttons stack (Save last), every control is 44 px and
 *   nothing scrolls sideways.
 * Every member is new to this run (a test send is one of the digest's 5 runs a day); what the spec adds is removed in
 * `afterAll`.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-key-not-real-0000";

let admin: APIRequestContext;
let tag = "";
let VICTOR: Actor;
let SAM: Actor;
let victorId = "";
let samId = "";
let scoutId = "";
let addedProvider = false;

/** A personal bot named `name` for `who`, recreated so the run starts from one personal bot. */
async function personalBot(who: Actor, userId: string, name: string): Promise<string> {
  const api = await apiAs(who);
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === userId)) {
    expect((await api.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await api.post("/api/v1/agents/personal", {
    data: { name, instructions: "Answer briefly.", modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), `create ${name}: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { agent: { id: string } };
  await api.dispose();
  return body.agent.id;
}

async function deletePersonalBots(who: Actor, userId: string): Promise<void> {
  const api = await apiAs(who);
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === userId)) {
    await api.delete(`/api/v1/agents/${a.id}`).catch(() => undefined);
  }
  await api.dispose();
}

async function openDigest(browser: Browser, who: Actor, project: string): Promise<Page> {
  const { page } = await openAs(browser, who, project);
  await page.goto(`${BASE_URL}/settings/digest`);
  await expect(page.getByTestId("digest-settings")).toBeVisible({ timeout: 30_000 });
  return page;
}

/** Review captures wait for toasts to leave; a pointer resting on one (Save sits near the toaster) pauses it. */
async function review(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1);
  await captureReview(page, name);
}

/** axe on `selector` in light and dark (serious and critical fail). */
async function axeBothThemes(page: Page, selector: string): Promise<void> {
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "light" });
}

/** At 390: every control is ≥ 44 px, nothing scrolls sideways, every control is named, the buttons stack Save last. */
async function checkPhone(page: Page): Promise<void> {
  await expectTouchTargets(page, '[data-testid="digest-settings"]');
  await expectNoSidewaysScroll(page, "digest settings");
  expect(await unnamedControls(page)).toEqual([]);
  const boxes = await Promise.all(
    ["digest-preview-button", "digest-test", "digest-save"].map((id) => page.getByTestId(id).boundingBox()),
  );
  const [preview, testSend, save] = boxes;
  expect(preview && testSend && save, "the three buttons are laid out").toBeTruthy();
  if (!preview || !testSend || !save) return;
  expect(testSend.y).toBeGreaterThan(preview.y);
  expect(save.y).toBeGreaterThan(testSend.y);
  for (const b of [preview, testSend, save]) {
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    expect(b.width).toBeGreaterThan(300);
  }
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  const run = `${tag}-${Date.now().toString(36)}`;
  VICTOR = { name: "Víctor Sanz", email: `vic-digest-${run}@ocw.test`, password: "vic-digest-password-123" };
  SAM = { name: "Sam Rivera", email: `sam-digest-${run}@ocw.test`, password: "sam-digest-password-123" };
  admin = await apiAs(ADMIN);
  victorId = await ensureMember(admin, VICTOR, "developer");
  samId = await ensureMember(admin, SAM, "developer");
  scoutId = await personalBot(VICTOR, victorId, "Scout");

  // The organization's models include a METERED one on the harness fake (07.6-22's setup), for the summary select.
  if (FAKE_URL) {
    const providers = (await (await admin.get("/api/v1/model-providers")).json()) as {
      providers: Array<{ provider: string }>;
    };
    if (!providers.providers.some((p) => p.provider === "anthropic")) {
      const res = await admin.post("/api/v1/model-providers", {
        data: {
          provider: "anthropic",
          apiKey: FAKE_ANTHROPIC_KEY,
          baseUrl: FAKE_URL,
          allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
          enabled: true,
        },
      });
      expect(res.ok(), `configure Anthropic: ${res.status()} ${await res.text()}`).toBe(true);
      addedProvider = true;
    }
  }
});

test.afterAll(async () => {
  if (VICTOR) await deletePersonalBots(VICTOR, victorId).catch(() => undefined);
  if (SAM) await deletePersonalBots(SAM, samId).catch(() => undefined);
  if (addedProvider) await admin?.delete("/api/v1/model-providers/anthropic").catch(() => undefined);
  await admin?.dispose();
});

test("Víctor turns on a weekday 08:00 digest from Scout, previews it and opens the test in his DM", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const mobile = info.project.name === "mobile";
  // Something new for the digest: the admin writes to Víctor (an unread DM is listed under Unread mentions).
  const dm = (await (
    await admin.post("/api/v1/dms", { data: { participants: [{ kind: "user", id: victorId }] } })
  ).json()) as { id: string };
  const sent = await admin.post(`/api/v1/conversations/${dm.id}/messages`, {
    data: { body: "Can you check the **launch plan** before Friday?" },
  });
  expect(sent.ok(), "admin writes to Víctor").toBe(true);

  const { page } = await openAs(browser, VICTOR, info.project.name);
  await page.goto(`${BASE_URL}/settings/notifications`);
  // Settings › Account lists Digest right after Notifications (drawer on phones).
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.getByTestId("settings-nav-digest")).toBeVisible();
  const ids = await nav
    .getByRole("group", { name: "Account" })
    .locator('[data-testid^="settings-nav-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(ids.indexOf("settings-nav-digest")).toBe(ids.indexOf("settings-nav-notifications") + 1);
  await nav.getByTestId("settings-nav-digest").click();
  await expect(page).toHaveURL(/\/settings\/digest$/u);
  const root = page.getByTestId("digest-settings");
  await expect(root).toBeVisible({ timeout: 30_000 });

  // A first digest: off, weekdays, this browser's zone, every section, skip-empty on, Scout preselected.
  await expect(page.getByTestId("digest-enabled")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("digest-status")).toHaveText("Off. Nothing is sent.");
  for (const day of ["mon", "tue", "wed", "thu", "fri"])
    await expect(page.getByTestId(`digest-day-${day}`)).toHaveAttribute("data-checked", "true");
  for (const day of ["sat", "sun"])
    await expect(page.getByTestId(`digest-day-${day}`)).not.toHaveAttribute("data-checked", "true");
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect(page.getByTestId("digest-zone")).toHaveValue(zone);
  await expect(page.getByTestId("digest-zone-hint")).toHaveText("Detected from this browser.");
  for (const s of ["decisions", "follows", "mentions", "work_zone"])
    await expect(page.getByTestId(`digest-section-${s}`)).toBeChecked();
  await expect(page.getByTestId("digest-skip-empty")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId(`digest-bot-${scoutId}`)).toBeChecked();
  await expect(root.getByText("Scout · your personal bot")).toBeVisible();
  await expect(page.getByTestId("digest-summary-enabled")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("digest-test")).toBeDisabled();
  await expect(page.getByTestId("digest-test-reason")).toHaveText("Save first.");
  if (mobile) await checkPhone(page);

  // On, Every day then Weekdays, 08:00, save.
  await page.getByTestId("digest-enabled").click();
  await expect(page.getByTestId("digest-enabled")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("digest-every-day").click();
  await expect(page.getByTestId("digest-day-sun")).toHaveAttribute("data-checked", "true");
  await page.getByTestId("digest-weekdays").click();
  await expect(page.getByTestId("digest-day-sun")).not.toHaveAttribute("data-checked", "true");
  await page.getByTestId("digest-time").fill("08:00");
  await page.getByTestId("digest-save").click();
  await expect(page.getByText(/^Digest saved\. Next one .+, 8:00 AM\.$/u)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("digest-status")).toHaveText(/^Next: .+, 8:00 AM$/u);
  await expect(page.getByTestId("digest-save")).toBeDisabled();
  await expect(page.getByTestId("digest-test")).toBeEnabled();
  await axeBothThemes(page, '[data-testid="digest-settings"]');
  // The page from the top: the switch row with its Next line, When, What to include.
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="digest-settings"]');
    let el = root?.parentElement ?? null;
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
    el?.scrollTo({ top: 0 });
  });
  await review(page, `digest-settings-${tag}`);

  // Preview: the exact Markdown for the form as it is now (the admin's DM is listed).
  await page.getByTestId("digest-preview-button").click();
  const preview = page.getByTestId("digest-preview");
  await expect(preview.getByTestId("digest-preview-body")).toContainText("Your digest", { timeout: 15_000 });
  await expect(preview.getByTestId("digest-preview-body")).toContainText("Unread mentions (1)");
  await axeBothThemes(page, '[data-testid="digest-preview"]');
  await preview.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await review(page, `digest-preview-${tag}`);

  // Send a test now: the saved digest lands in his DM with Scout; Open goes there.
  await page.getByTestId("digest-test").click();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Sent to your DM with Scout." });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await toast.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}\?m=[0-9a-f-]{36}/u);
  await expect(
    page.locator('[data-testid="message"]').filter({ hasText: "Your digest" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Change what's included in").first()).toBeVisible();
  await page.context().close();
});

test("the AI summary is off by default; on, an organization model shows METERED and who pays", async ({
  browser,
}, info) => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (no organization model to pick)");
  test.setTimeout(90_000);
  const mobile = info.project.name === "mobile";
  const page = await openDigest(browser, VICTOR, info.project.name);
  const toggle = page.getByTestId("digest-summary-enabled");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("digest-summary-on")).toHaveCount(0);
  await toggle.click();
  const on = page.getByTestId("digest-summary-on");
  await expect(on).toBeVisible();
  await page.getByTestId("digest-summary-model").click();
  await page.getByRole("option", { name: /Haiku/u }).first().click();
  await expect(on.getByTestId("provider-metered")).toBeVisible();
  await expect(page.getByTestId("digest-summary-notice")).toHaveText(
    "Each summary is one AI request billed to the organization and counts against your AI chat limits. The list itself is never written by AI.",
  );
  // A change: Send a test now waits for it to be saved.
  await expect(page.getByTestId("digest-test")).toBeDisabled();
  await expect(page.getByTestId("digest-test-reason")).toHaveText("Save first.");
  await axeBothThemes(page, '[data-testid="digest-settings"]');
  if (mobile) await checkPhone(page);
  await page.getByTestId("digest-summary").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await review(page, `digest-summary-on-${tag}`);
  await page.context().close();
});

test("validation: no day, no section and a zone not in the list each say so and block Save", async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const page = await openDigest(browser, VICTOR, info.project.name);
  const save = page.getByTestId("digest-save");
  for (const day of ["mon", "tue", "wed", "thu", "fri"]) await page.getByTestId(`digest-day-${day}`).click();
  await expect(page.getByText("Pick at least one day")).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByTestId("digest-weekdays").click();
  await expect(page.getByText("Pick at least one day")).toHaveCount(0);

  for (const s of ["decisions", "follows", "mentions", "work_zone"])
    await page.getByTestId(`digest-section-${s}`).uncheck();
  await expect(page.getByText("Pick at least one", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByTestId("digest-section-mentions").check();

  const zoneField = page.getByTestId("digest-zone");
  await zoneField.fill("Europe/Atlantis");
  await zoneField.blur();
  await expect(page.getByText("Pick a time zone from the list")).toBeVisible();
  await expect(zoneField).toHaveAttribute("aria-invalid", "true");
  await expect(save).toBeDisabled();
  await zoneField.fill("Europe/Madrid");
  await expect(page.getByText("Pick a time zone from the list")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await page.context().close();
});

test("no bot: Sam sees the dashed box, Save explains why it is off, and he creates his personal bot here", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const { page } = await openAs(browser, SAM, info.project.name);
  // Sam has no personal bot. Team bots made by other specs on a shared stack are readable by every developer, so the
  // page is shown the API's own answer without them: the no-bot state is what Sam would see in a workspace with none.
  await page.route(/\/api\/v1\/digest$/u, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as { bots: Array<{ personal: boolean }> };
    await route.fulfill({ response: res, json: { ...body, bots: body.bots.filter((b) => b.personal) } });
  });
  await page.goto(`${BASE_URL}/settings/digest`);
  const box = page.getByTestId("digest-no-bot");
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box).toContainText("You need a bot to deliver it.");
  await expect(page.getByTestId("digest-save")).toBeDisabled();
  await expect(page.getByTestId("digest-save-reason")).toHaveText("Pick a bot to deliver it.");
  await axeBothThemes(page, '[data-testid="digest-settings"]');
  if (mobile) await checkPhone(page);
  await box.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await review(page, `digest-no-bot-${tag}`);

  // Create a personal bot (the existing flow): it is listed, preselected, and Save turns on.
  await box.getByTestId("digest-create-bot").click();
  const sams = page.locator('[data-testid^="digest-bot-"]');
  await expect(sams).toHaveCount(1, { timeout: 15_000 });
  await expect(sams.first()).toBeChecked();
  await expect(page.getByTestId("digest-no-bot")).toHaveCount(0);
  await expect(page.getByTestId("digest-save")).toBeEnabled();
  await page.context().close();
});
