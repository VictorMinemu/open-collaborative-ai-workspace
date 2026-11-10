import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import {
  addBot,
  ageDeliveredRun,
  clearAutomations,
  createAutomation,
  getAutomation,
  makeNeedsAttention,
  runNow,
  saveDigest,
  seedRuns,
  waitBotReady,
  waitRun,
} from "../support/automations";
import { createBoardChannel } from "../support/board";
import { freshPersonalBot, freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { freshChannel } from "../support/chat";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { ADMIN, API_URL } from "./env";

/**
 * 07.6-15 (AUTO-01, AUTO-03, D-07, UI-SPEC Surfaces 1, 2, 5, 8a/8d): Bots › Automations in the browser. Víctor (an
 * admin, the run-as person of his own automations) opens the section from the Bots page, creates "Weekly sales report"
 * for Fridays at 17:00 in Europe/Madrid into a channel, sees it in the list, runs it now and sees Done in its run
 * history, with the run card in the channel. Then every rule of the editor (board and DM targets with their reasons, a
 * personal bot, limits, a too-frequent schedule, a version conflict), needs attention, delete, the manager view of
 * Sam's automations (read-only, Pause and Delete only, never Resume: P-04) and the run card's Running · Done · No reply
 * states. The simulated cell answers runs (no model). Review screenshots per UI-SPEC "Screenshots to take", plan 15.
 */

test.describe.configure({ mode: "serial" });

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

let admin: APIRequestContext;
let sam: APIRequestContext;
let plugin: FakeCellPlugin;
let victorId: string;
let scoutId: string;
let sales: { id: string; name: string };

async function startCell(): Promise<FakeCellPlugin> {
  const p = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true, autoReply: true });
  await p.start();
  return p;
}

test.beforeAll(async () => {
  expect(cellToken(), "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  victorId = await userIdOf(admin);
  await ensureMember(admin, SAM, "developer");
  sam = await apiAs(SAM);
  plugin = await startCell();
  // A fresh Scout: deleting the old one deletes every automation it ran (cascade), so each run starts clean.
  scoutId = await freshTeamBot(admin, "Scout");
  await waitBotReady(admin, scoutId);
  await freshPersonalBot(ADMIN, victorId);
  // Bots are deleted softly, so their automations stay: every run starts from no automation at all.
  await clearAutomations(admin);
  sales = await freshChannel(admin, [sam], "sales");
  await addBot(admin, sales.id, scoutId);
});

test.afterAll(async () => {
  await plugin?.stop();
  await sam?.dispose();
  await admin?.dispose();
});

/** The automations page, waited until the list or its empty state is there. */
async function openAutomations(page: Page, query = ""): Promise<void> {
  await page.goto(`${BASE_URL}/bots/automations${query}`);
  await expect(
    page
      .getByTestId("automations-list")
      .or(page.getByText("No automations yet"))
      .or(page.getByText("No automations in this workspace yet.")),
  ).toBeVisible({ timeout: 20_000 });
}

const rowOf = (page: Page, name: string): Locator =>
  page.getByTestId("automation-row").filter({ hasText: name });
const editor = (page: Page) => page.getByTestId("automation-editor");

/** Picks `option` (exact text) from the Base UI select `trigger`. */
async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** Named controls, no sideways scroll, 44 px targets below 768 and no serious axe finding on `selector`. */
async function invariants(page: Page, selector: string, label: string): Promise<void> {
  // A select that just closed is still animating out: measure the settled screen (axe waits for animations first).
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expectNoSeriousA11y(page, selector);
  expect(await unnamedControls(page), `${label}: controls without an accessible name`).toEqual([]);
  await expectNoSidewaysScroll(page, label);
  await expectTouchTargets(page, selector);
}

/** Axe in light and dark, then the light and dark review screenshots. */
async function review(page: Page, selector: string, name: string, w: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await invariants(page, selector, `${name} (${theme})`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await captureReview(page, `${name}-${w}`);
}

test("Víctor opens Bots › Automations, creates “Weekly sales report”, runs it now and sees Done in Runs", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, ADMIN, project);
  try {
    // ---- the section nav under the Bots header; the gallery is still there
    await page.goto(`${BASE_URL}/bots`);
    const nav = page.getByRole("navigation", { name: "Bots sections" });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Bots" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Automations" }).click();
    await expect(page).toHaveURL(/\/bots\/automations$/);
    await expect(nav.getByRole("link", { name: "Automations" })).toHaveAttribute("aria-current", "page");

    // ---- the empty state (this project's Scout is fresh: no automation of Víctor's is left)
    await expect(page.getByText("No automations yet")).toBeVisible();
    await expect(
      page.getByText(
        "Give a bot a standing order: a weekly report, a daily check, or a reply to every new order or email.",
      ),
    ).toBeVisible();
    if (w === "1440") await captureReview(page, `automations-empty-${w}`);

    // ---- the editor: name, Scout, instructions, every week on Friday at 17:00 in Madrid, three next runs, #sales
    await page.getByTestId("new-automation-empty").click();
    await expect(page).toHaveURL(/\?new=1/);
    const sheet = editor(page);
    await expect(sheet.getByTestId("automation-editor-title")).toHaveText("New automation");
    await sheet.getByTestId("automation-name-input").fill("Weekly sales report");
    await pick(page, sheet.getByTestId("automation-bot"), "Scout");
    await sheet
      .getByTestId("automation-instructions")
      .fill(
        "Every Friday, summarise this week's closed deals in #sales: total, top 3 accounts, anything stuck.",
      );
    await expect(sheet.getByTestId("schedule-repeat")).toHaveText(/Every week/);
    await expect(sheet.getByTestId("schedule-day-fri")).toBeChecked();
    await expect(sheet.getByTestId("schedule-time")).toHaveValue("17:00");
    await sheet.getByTestId("schedule-zone").fill("Europe/Madrid");
    await expect(sheet.getByTestId("next-run")).toHaveCount(3, { timeout: 10_000 });
    for (const item of await sheet.getByTestId("next-run").all()) {
      await expect(item).toHaveText(/^Fri, \w{3} \d{1,2}, 5:00 PM/);
    }
    await pick(page, sheet.getByTestId("target-channel"), `#${sales.name}`);
    await expect(sheet.getByText("Each run starts a thread; Scout answers in it.")).toBeVisible();
    await expect(sheet.getByTestId("automation-run-as")).toContainText("Víctor Ruiz (you)");
    await expect(sheet.getByTestId("automation-runs-per-day")).toHaveValue("24");
    if (w === "390") {
      // Full screen, stacked footer with the primary action first, 44 px day chips.
      const box = await sheet.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(389);
      const create = await sheet.getByTestId("automation-submit").boundingBox();
      const cancel = await sheet.getByRole("button", { name: "Cancel" }).boundingBox();
      expect(create && cancel && create.y < cancel.y, "Create automation is stacked above Cancel").toBe(true);
      const chip = await sheet.locator("label", { has: page.getByTestId("schedule-day-mon") }).boundingBox();
      expect(chip?.height ?? 0).toBeGreaterThanOrEqual(43.5);
      expect(chip?.width ?? 0).toBeGreaterThanOrEqual(43.5);
    }
    await review(page, '[data-testid="automation-editor"]', "automation-editor-schedule", w);

    await sheet.getByTestId("automation-submit").click();
    await expect(page.getByText(/Created “Weekly sales report”\. First run Fri, /)).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/bots\/automations$/);

    // ---- the row
    const row = rowOf(page, "Weekly sales report");
    await expect(row).toBeVisible();
    await expect(row.getByTestId("automation-when")).toHaveText("Fridays at 5:00 PM");
    await expect(row.getByTestId("automation-zone")).toHaveText(/^Europe\/Madrid · next /);
    await expect(row.getByTestId("automation-target")).toContainText(`Scout → #${sales.name}`);
    await expect(row.getByTestId("automation-status")).toHaveText("Active");
    await expect(row.getByTestId("automation-last-run")).toHaveText("—");

    // ---- Run now from the row menu → Open runs → Done, with Open to the anchor in #sales
    await row.getByTestId("automation-menu").click();
    await page.getByTestId("automation-menu-run").click();
    const toast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Running “Weekly sales report” now." });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Open runs" }).click();
    await expect(page).toHaveURL(/tab=runs/);
    const history = page.getByTestId("run-history");
    const first = history.getByTestId("run-row").first();
    await expect(first.getByTestId("run-trigger")).toHaveText("Run now");
    await expect(first.getByTestId("run-result")).toHaveText("Done", { timeout: 30_000 });
    await expect(first.getByTestId("run-line")).toHaveText(/^Answered in \d+ (s|min)$/);
    await expect(first.getByTestId("run-open")).toHaveAttribute("aria-label", `Open run in #${sales.name}`);
    await expect(first.getByTestId("run-open")).toHaveAttribute(
      "href",
      new RegExp(`^/chat/${sales.id}\\?thread=`),
    );

    // ---- the run history with every state, one run highlighted by ?run=
    const automationId = page.url().match(/edit=([0-9a-f-]{36})/)?.[1] ?? "";
    expect(automationId).not.toBe("");
    await seedRuns(automationId);
    const seededList = (await (await admin.get(`/api/v1/automations/${automationId}/runs`)).json()) as {
      runs: Array<{ id: string; status: string }>;
    };
    const skipped = seededList.runs.find((r) => r.status === "skipped")?.id ?? "";
    await page.goto(`${BASE_URL}/bots/automations?edit=${automationId}&run=${skipped}`);
    await expect(page.getByTestId("run-row")).toHaveCount(4);
    const highlighted = page.locator(`[data-testid="run-row"][data-run-id="${skipped}"]`);
    await expect(highlighted).toHaveAttribute("data-highlighted", "true");
    await expect(highlighted).toBeFocused();
    await expect(highlighted.getByTestId("run-line")).toHaveText(
      `Scout isn't a member of #${sales.name} any more.`,
    );
    await expect(page.getByTestId("run-outside")).toHaveCount(1);
    await expect(page.getByText("Scout didn't answer within 15 minutes.")).toBeVisible();
    await expect(page.getByText("Scout's daily limit was reached.")).toBeVisible();
    await expect(highlighted.getByTestId("run-open")).toHaveCount(0);
    await review(page, '[data-testid="run-history"]', "automation-runs", w);
  } finally {
    await context.close();
  }
});

test("the run card: Running, Done and No reply with its notice, in the channel (UI-SPEC 8a)", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const a = await createAutomation(admin, {
    name: "Pipeline check",
    agentId: scoutId,
    conversationId: sales.id,
  });
  // Done: the cell answers.
  const done = await runNow(admin, a.id);
  await waitRun(admin, a.id, done, (r) => r.status === "answered");
  // Running (and, at 1440, No reply): nobody answers while the cell is away.
  await plugin.stop();
  let silent: string | null = null;
  try {
    if (w === "1440") {
      silent = await runNow(admin, a.id);
      await waitRun(admin, a.id, silent, (r) => r.status === "delivered");
      await ageDeliveredRun(silent);
    }
    const running = await runNow(admin, a.id);
    await waitRun(admin, a.id, running, (r) => r.status === "delivered");
    if (silent) {
      // The scheduler's next tick (every minute) turns the aged run into No reply.
      await waitRun(admin, a.id, silent, (r) => r.status === "no_reply", 100_000);
    }

    const { context, page } = await openAs(browser, ADMIN, project);
    try {
      await page.goto(`${BASE_URL}/chat/${sales.id}`);
      const card = (runId: string) =>
        page.locator('[data-testid="agent-card"][data-kind="automation"]').filter({
          has: page.locator(`a[href*="run=${runId}"]`),
        });
      await expect(card(running).getByTestId("agent-card-status")).toHaveAttribute(
        "aria-label",
        "Status: Running",
      );
      await expect(card(done).getByTestId("agent-card-status")).toHaveAttribute("aria-label", "Status: Done");
      await expect(card(done).getByTestId("agent-card-workspace")).toBeVisible();
      await expect(card(done)).toContainText("Fridays at 5:00 PM · Europe/Madrid");
      if (silent) {
        const noReply = card(silent);
        await expect(noReply.getByTestId("agent-card-status")).toHaveAttribute(
          "aria-label",
          "Status: No reply",
        );
        await expect(noReply.getByTestId("agent-card-notice")).toHaveText(
          "Scout didn't answer within 15 minutes.",
        );
      }
      await card(running).scrollIntoViewIfNeeded();
      if (w === "390") {
        for (const control of await card(running).locator("button, a[href]").all()) {
          expect(
            (await control.boundingBox())?.height ?? 0,
            "44 px card actions at 390",
          ).toBeGreaterThanOrEqual(44);
        }
      }
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expectNoSeriousA11y(page, '[data-testid="agent-card"][data-kind="automation"]');
      }
      await page.emulateMedia({ colorScheme: "light" });
      await expectNoSidewaysScroll(page, "run cards");
      await captureReview(page, `run-card-states-${w}`);
      if (w === "1440") {
        await card(done).scrollIntoViewIfNeeded();
        await captureReview(page, `run-card-states-done-${w}`);
      }

      // Open automation → the editor on this run.
      await card(done).getByTestId("agent-card-open").click();
      await expect(page).toHaveURL(new RegExp(`/bots/automations\\?edit=${a.id}&run=${done}`));
      await expect(page.locator(`[data-testid="run-row"][data-run-id="${done}"]`)).toHaveAttribute(
        "data-highlighted",
        "true",
      );
    } finally {
      await context.close();
    }
  } finally {
    plugin = await startCell();
  }
});

test("the editor explains every rule: board column, not a member, personal bot DM only, limits, frequency, conflicts", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const board = await createBoardChannel(admin, { prefix: "orders" });
  await addBot(admin, board.id, scoutId);
  const quiet = await freshChannel(admin, [], "marketing");
  const personal = await freshPersonalBot(ADMIN, victorId);
  await waitBotReady(admin, personal.id);
  const { context, page } = await openAs(browser, ADMIN, project);
  try {
    await openAutomations(page, "?new=1");
    const sheet = editor(page);
    await sheet.getByTestId("automation-name-input").fill("Orders intake");
    await pick(page, sheet.getByTestId("automation-bot"), "Scout");
    await sheet.getByTestId("automation-instructions").fill("Add the week's open orders as a card.");
    await sheet.getByTestId("schedule-zone").fill("Europe/Madrid");

    // ---- a channel Scout is not in is listed, disabled, with the reason in its text
    await sheet.getByTestId("target-channel").click();
    const notMember = page.getByRole("option", { name: `#${quiet.name} · Scout isn't a member` });
    await expect(notMember).toBeVisible();
    await expect(notMember).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: `#${sales.name}`, exact: true }).click();

    // ---- a board and its column, with the hint
    await sheet.getByTestId("target-kind-board").click();
    await pick(page, sheet.getByTestId("target-board"), board.name);
    await expect(sheet.getByTestId("target-column")).toHaveText(/Backlog/);
    await expect(
      sheet.getByText("Each run adds a card to Backlog; Scout answers in its thread."),
    ).toBeVisible();
    await sheet.getByTestId("target-picker").scrollIntoViewIfNeeded();
    await review(page, '[data-testid="automation-editor"]', "automation-editor-board", w);

    // ---- limits: 289 runs a day is over the workspace's 288 (Phase 07.17, D-11)
    await sheet.getByTestId("automation-runs-per-day").fill("289");
    await sheet.getByTestId("automation-submit").click();
    await expect(sheet.getByText("Use a whole number from 1 to 288")).toBeVisible();
    await sheet.getByTestId("automation-runs-per-day").fill("24");

    // ---- a custom schedule more often than every 5 minutes (Phase 07.17, D-01)
    await pick(page, sheet.getByTestId("schedule-repeat"), "Custom");
    await sheet.getByTestId("schedule-cron").fill("*/4 * * * *");
    await expect(sheet.getByTestId("next-runs-error")).toHaveText(
      "Runs can be at most every 5 minutes in this workspace.",
    );
    await sheet.getByTestId("schedule-cron").fill("15 8,12 * * 1-5");
    await expect(sheet.getByTestId("next-run")).toHaveCount(3);

    await sheet.getByTestId("automation-submit").click();
    await expect(page.getByText(/Created “Orders intake”/)).toBeVisible();
    const boardRow = rowOf(page, "Orders intake");
    await expect(boardRow.getByTestId("automation-when")).toHaveText("Custom schedule (15 8,12 * * 1-5)");
    await expect(boardRow.getByTestId("automation-target")).toContainText(board.name);

    // ---- Víctor's personal bot: only his DM; Channel and Board are disabled and say why
    await page.locator('[data-testid="new-automation"]:visible').click();
    await pick(page, sheet.getByTestId("automation-bot"), /your personal bot/);
    for (const kind of ["channel", "board"]) {
      const card = sheet.getByTestId(`target-kind-${kind}`);
      await expect(card.locator("input")).toBeDisabled();
      await expect(card).toContainText("Personal bots deliver only to your DMs.");
    }
    await expect(sheet.getByTestId("target-kind-dm").locator("input")).toBeChecked();
    await expect(sheet.getByTestId("target-dm")).toContainText("Delivered in your direct messages with");
    await sheet.getByTestId("automation-name-input").fill("Morning plan");
    await sheet.getByTestId("target-picker").scrollIntoViewIfNeeded();
    await review(page, '[data-testid="automation-editor"]', "automation-editor-dm-personal", w);
    // Closing with changes asks first.
    await sheet.getByRole("button", { name: "Cancel" }).click();
    const discard = page.getByTestId("automation-discard");
    await expect(discard.getByText("Discard changes?")).toBeVisible();
    await discard.getByRole("button", { name: "Discard" }).click();
    await expect(sheet).toBeHidden();

    // ---- someone saved first: 409 → the banner and Reload
    const own = await createAutomation(admin, {
      name: "Friday wrap-up",
      agentId: scoutId,
      conversationId: sales.id,
    });
    await page.goto(`${BASE_URL}/bots/automations?edit=${own.id}`);
    await expect(sheet.getByTestId("automation-editor-title")).toHaveText("Edit “Friday wrap-up”");
    await sheet.getByTestId("automation-name-input").fill("Friday wrap-up (mine)");
    const patched = await admin.patch(`/api/v1/automations/${own.id}`, {
      data: { expectedVersion: own.version, name: "Friday wrap-up v2" },
    });
    expect(patched.ok()).toBe(true);
    await sheet.getByTestId("automation-submit").click();
    await expect(sheet.getByTestId("automation-conflict")).toContainText(
      "This automation changed while you were editing.",
    );
    await sheet.getByTestId("automation-conflict").getByRole("button", { name: "Reload" }).click();
    await expect(sheet.getByTestId("automation-name-input")).toHaveValue("Friday wrap-up v2");
    await expect(sheet.getByTestId("automation-conflict")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("needs attention: the owner reads why and resumes; delete asks first and removes the row", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const lonely = await freshChannel(admin, [], "ops");
  await addBot(admin, lonely.id, scoutId);
  const broken = await createAutomation(admin, {
    name: "Ops digest",
    agentId: scoutId,
    conversationId: lonely.id,
  });
  await makeNeedsAttention(admin, admin, broken.id, lonely.id, scoutId);
  const doomed = await createAutomation(admin, {
    name: "Old reminder",
    agentId: scoutId,
    conversationId: sales.id,
  });
  const { context, page } = await openAs(browser, ADMIN, project);
  try {
    await openAutomations(page);
    const row = rowOf(page, "Ops digest");
    await expect(row.getByTestId("automation-status")).toHaveText("Needs attention");
    await expect(row.getByTestId("automation-reason")).toHaveText("Paused after 3 failed runs.");
    await row.getByTestId("automation-open").click();
    const sheet = editor(page);
    const banner = sheet.getByTestId("automation-status-banner");
    await expect(banner).toContainText(
      `Paused after 3 failed runs. Last reason: Scout isn't a member of #${lonely.name} any more.`,
    );
    await expect(banner.getByTestId("automation-banner-resume")).toBeVisible();
    await review(page, '[data-testid="automation-editor"]', "automation-needs-attention", w);
    await banner.getByTestId("automation-banner-resume").click();
    await expect(page.getByText(/Resumed “Ops digest”\. Next run /)).toBeVisible();
    await expect(sheet.getByTestId("automation-status-banner")).toHaveCount(0);
    await expect.poll(async () => (await getAutomation(admin, broken.id)).status).toBe("active");
    await sheet.getByRole("button", { name: "Cancel" }).click();

    // ---- delete from the row menu: the confirmation, then the row is gone
    const old = rowOf(page, "Old reminder");
    await old.getByTestId("automation-menu").click();
    await page.getByTestId("automation-menu-delete").click();
    const dialog = page.getByTestId("automation-delete-dialog");
    await expect(dialog.getByText("Delete “Old reminder”?")).toBeVisible();
    await expect(
      dialog.getByText("It stops running and its run history is deleted. Messages it already posted stay."),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    if (w === "390") await captureReview(page, `automation-delete-${w}`);
    await dialog.getByTestId("automation-delete-confirm").click();
    await expect(page.getByText("Deleted “Old reminder”.")).toBeVisible();
    await expect(old).toHaveCount(0);
    expect((await admin.get(`/api/v1/automations/${doomed.id}`)).status()).toBe(404);
  } finally {
    await context.close();
  }
});

test("a manager sees everyone's automations and governs Sam's read-only: Pause and Delete, never Resume (P-04)", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const project = info.project.name;
  const w = widthOf(project);
  // Sam's: one active, one that paused itself.
  const samsChannel = await freshChannel(admin, [sam], "support");
  await addBot(admin, samsChannel.id, scoutId);
  const samActive = await createAutomation(sam, {
    name: "Support queue summary",
    agentId: scoutId,
    conversationId: sales.id,
    cron: "0 9 * * 1-5",
  });
  const samBroken = await createAutomation(sam, {
    name: "Escalations check",
    agentId: scoutId,
    conversationId: samsChannel.id,
    cron: "30 * * * *",
  });
  await makeNeedsAttention(admin, sam, samBroken.id, samsChannel.id, scoutId);
  // Víctor's own list: a schedule, a paused one and his digest (with his personal bot).
  const personal = await freshPersonalBot(ADMIN, victorId);
  await waitBotReady(admin, personal.id);
  await saveDigest(admin, personal.id);
  const paused = await createAutomation(admin, {
    name: "Monthly invoices",
    agentId: scoutId,
    conversationId: sales.id,
    cron: "0 18 L * *",
  });
  expect((await admin.post(`/api/v1/automations/${paused.id}/pause`)).ok()).toBe(true);
  const inbox = await freshChannel(admin, [], "purchasing");
  await addBot(admin, inbox.id, scoutId);
  const attention = await createAutomation(admin, {
    name: "Supplier check",
    agentId: scoutId,
    conversationId: inbox.id,
    cron: "0 * * * *",
  });
  await makeNeedsAttention(admin, admin, attention.id, inbox.id, scoutId);

  const { context, page } = await openAs(browser, ADMIN, project);
  try {
    // ---- Mine: rows with the digest, the paused one, the usage line
    await openAutomations(page);
    await expect(page.getByTestId("automations-usage")).toHaveText(/^\d+ of 10 automations used$/);
    await expect(rowOf(page, "Monthly invoices").getByTestId("automation-when")).toHaveText(
      "Monthly on the last day at 6:00 PM",
    );
    await expect(rowOf(page, "Monthly invoices").getByTestId("automation-status")).toHaveText("Paused");
    await expect(rowOf(page, "Supplier check").getByTestId("automation-status")).toHaveText(
      "Needs attention",
    );
    const digest = page
      .getByTestId("automation-row")
      .filter({ has: page.getByText("Digest", { exact: true }) });
    await expect(digest.getByTestId("automation-when")).toHaveText("Weekdays at 8:00 AM");
    await expect(digest.getByTestId("automation-target")).toContainText("your DM");
    await review(page, '[data-testid="automations-list"]', "automations-list", w);

    // ---- loading state (1440): skeleton rows while the list is on its way
    if (w === "1440") {
      const mine = /\/api\/v1\/automations\?scope=mine$/;
      await page.route(
        mine,
        async (route) => {
          await new Promise((r) => setTimeout(r, 2500));
          await route.continue().catch(() => undefined);
        },
        { times: 1 },
      );
      await page.goto(`${BASE_URL}/bots/automations`);
      await expect(page.getByTestId("automations-loading")).toBeVisible();
      await captureReview(page, `automations-loading-${w}`);
      await page.unroute(mine);
    }

    // ---- Everyone: Sam's too, needs attention first
    await openAutomations(page, "?scope=all");
    await expect(page.getByTestId("automations-scope-all")).toHaveAttribute("aria-selected", "true");
    const samRow = rowOf(page, "Support queue summary");
    await expect(samRow.getByTestId("automation-target")).toContainText("· for Sam Lee");
    await expect(page.getByTestId("automation-row").first()).toHaveAttribute(
      "data-status",
      "needs_attention",
    );
    if (w === "1440") await review(page, '[data-testid="automations-list"]', "automations-everyone", w);

    // Row menu on Sam's active one: Open · Pause · Delete… only.
    await samRow.getByTestId("automation-menu").click();
    const menu = page.getByTestId("automation-menu-content");
    await expect(menu.getByRole("menuitem")).toHaveText(["Open", "Pause", "Delete…"]);
    await menu.getByRole("menuitem", { name: "Open" }).click();
    const sheet = editor(page);
    await expect(sheet).toHaveAttribute("data-mode", "readonly");
    await expect(sheet.getByTestId("automation-editor-title")).toHaveText("“Support queue summary”");
    await expect(sheet.getByTestId("automation-run-as")).toContainText(
      "Runs as Sam Lee. Admins can pause or delete it, not run it as someone else.",
    );
    await expect(sheet.getByTestId("automation-name-input")).toBeDisabled();
    await expect(sheet.getByTestId("automation-instructions")).toBeDisabled();
    const footer = sheet.getByTestId("automation-footer");
    await expect(footer.getByRole("button")).toHaveText(["Pause", "Delete…"]);
    if (w === "1440")
      await review(page, '[data-testid="automation-editor"]', "automation-editor-readonly", w);
    await footer.getByTestId("automation-pause").click();
    await expect(page.getByText("Paused “Support queue summary”.")).toBeVisible();
    // Paused by a manager: the banner says who; still no Resume for him.
    await expect(sheet.getByTestId("automation-status-banner")).toContainText("Paused by Víctor Ruiz on ");
    await expect(sheet.getByRole("button", { name: "Resume" })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Close" }).click();

    // Sam's needs-attention one: the reason, no Resume anywhere for the manager.
    const brokenRow = rowOf(page, "Escalations check");
    await brokenRow.getByTestId("automation-menu").click();
    await expect(page.getByTestId("automation-menu-content").getByRole("menuitem")).toHaveText([
      "Open",
      "Delete…",
    ]);
    await page.getByTestId("automation-menu-content").getByRole("menuitem", { name: "Open" }).click();
    await expect(sheet.getByTestId("automation-status-banner")).toContainText("Paused after 3 failed runs.");
    await expect(sheet.getByRole("button", { name: "Resume" })).toHaveCount(0);
    await expect(sheet.getByTestId("automation-footer").getByRole("button")).toHaveText(["Delete…"]);
    // The API agrees: a manager may not resume it.
    expect((await admin.post(`/api/v1/automations/${samBroken.id}/resume`)).status()).toBe(403);
    expect((await getAutomation(sam, samActive.id)).status).toBe("paused");
  } finally {
    await context.close();
  }
});

test("Sam, without automation.webhook, sees the Webhook trigger disabled with its reason", async ({
  browser,
}, info) => {
  const { context, page } = await openAs(browser, SAM, info.project.name);
  try {
    await openAutomations(page, "?new=1");
    const webhook = editor(page).getByTestId("trigger-kind-webhook");
    await expect(webhook.locator("input")).toBeDisabled();
    await expect(webhook).toContainText("Only team leads and admins can create webhooks.");
    await expect(page.getByTestId("automations-scope-all")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
