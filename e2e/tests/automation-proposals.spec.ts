import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { addBot, clearAutomations, waitBotReady } from "../support/automations";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { freshChannel, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL } from "./env";

/**
 * 07.6-23 (AUTO-03, D-03, D-07, UI-SPEC Surface 5, R5, C-03): a bot's natural-language automation proposal in the
 * browser. Ana asks Scout in their DM for a weekly sales report; the simulated cell calls `ocw_automation_propose` for
 * that very turn (no model); the DM shows the platform's card, which only Ana may decide. Edit opens the editor with the
 * draft and its banner; cancelling leaves the card Proposed; changing 17:00 to 09:00 and saving creates the automation
 * and the card reads Created with changes. In #sales, Sam reads "Only Ana Pérez can confirm this automation." with no
 * buttons; Ana confirms through the dialog (Created) and discards a second proposal (Discarded, and Scout hears it); a
 * turn that read outside content proposes nothing. Both sizes, light and dark, axe, and the UI-SPEC screenshots
 * nl-card-proposed, nl-card-created and nl-editor-draft.
 */

test.describe.configure({ mode: "serial" });

const ANA: Actor = { name: "Ana Pérez", email: "ana@ocw.test", password: "ana-e2e-password-123" };
const REPORT = "Weekly sales report";
const ORDER = "Every Friday, summarise this week's closed deals: total, top 3 accounts, anything stuck.";

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

let admin: APIRequestContext;
let ana: APIRequestContext;
let sam: APIRequestContext;
let plugin: FakeCellPlugin;
let scoutId: string;
let dmId: string;
let sales: { id: string; name: string };

type ProposeResponse = { ok: boolean; approvalId?: string; code?: string; sentence: string };

test.beforeAll(async () => {
  test.setTimeout(120_000);
  expect(cellToken(), "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, ANA, "standard");
  await ensureMember(admin, SAM, "developer");
  ana = await apiAs(ANA);
  sam = await apiAs(SAM);
  // No automatic replies: the spec plays the bot, proposing for the turn it was given, then answering it.
  plugin = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true });
  await plugin.start();
  // A fresh Scout per project: its DM with Ana and its cards start empty.
  scoutId = await freshTeamBot(admin, "Scout");
  await waitBotReady(admin, scoutId);
  await clearAutomations(admin);
  sales = await freshChannel(admin, [ana, sam], "sales");
  await addBot(admin, sales.id, scoutId);
  const dm = await ana.post("/api/v1/dms", { data: { participants: [{ kind: "agent", id: scoutId }] } });
  expect(dm.ok(), `Ana's DM with Scout: ${dm.status()}`).toBe(true);
  dmId = ((await dm.json()) as { id: string }).id;
});

test.afterAll(async () => {
  await plugin?.stop();
  await sam?.dispose();
  await ana?.dispose();
  await admin?.dispose();
});

/** The turn the cell received for a person's message (by id, or by its text in a conversation). */
async function turnFor(pred: { messageId?: string; conversationId?: string; text?: string }) {
  const ev = await plugin.waitFor((e) => {
    if (e.type !== "agent.mention.v1") return false;
    const m = e.data as unknown as MentionPayload;
    if (pred.messageId) return m.message.id === pred.messageId;
    return m.conversation.id === pred.conversationId && m.message.text === pred.text;
  }, 20_000);
  return ev.data as unknown as MentionPayload;
}

/** What the real plugin does when the model calls `ocw_automation_propose` on this turn. */
function propose(m: MentionPayload, name: string, over: Record<string, unknown> = {}) {
  return plugin.request<ProposeResponse>("POST", "/automations/propose", {
    eventId: m.eventId,
    agentId: scoutId,
    name,
    instructions: ORDER,
    schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" },
    target: { kind: "here" },
    maxRunsPerDay: 24,
    ...over,
  });
}

/** Scout proposes `name` for Ana's message `m` and answers the turn in one sentence; the approval id. */
async function proposed(m: MentionPayload, name: string): Promise<string> {
  expect(m.turn?.tools ?? [], "the tool is offered on this turn").toContain("ocw_automation_propose");
  const res = await propose(m, name);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok).toBe(true);
  await plugin.reply(m, `I posted “${name}” for you to confirm.`);
  return res.body.approvalId as string;
}

const cardOf = (scope: Page | Locator, name: string): Locator =>
  scope.getByTestId("agent-card").filter({ hasText: `Create “${name}”` });
const editor = (page: Page) => page.getByTestId("automation-editor");
const toast = (page: Page, text: string | RegExp) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text });

/** Named controls, no sideways scroll, 44 px targets below 1024 and no serious axe finding, in light and dark. */
async function review(page: Page, selector: string, name: string, w: string): Promise<void> {
  await expect(page.getByRole("listbox")).toHaveCount(0);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoSeriousA11y(page, selector);
    expect(await unnamedControls(page), `${name} (${theme}): controls without a name`).toEqual([]);
    await expectNoSidewaysScroll(page, `${name} (${theme})`);
    await expectTouchTargets(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator(selector).last().scrollIntoViewIfNeeded();
  await captureReview(page, `${name}-${w}`);
}

/** The pending card's footer at 390: Edit full width, then Create automation and Discard side by side, 44 px. */
async function expectPhoneFooter(card: Locator): Promise<void> {
  const actions = await card.getByTestId("agent-card-actions").boundingBox();
  const edit = await card.getByTestId("agent-card-open").boundingBox();
  const create = await card.getByTestId("agent-card-create").boundingBox();
  const discard = await card.getByTestId("agent-card-discard").boundingBox();
  expect(actions && edit && create && discard, "the footer's three buttons").toBeTruthy();
  if (!actions || !edit || !create || !discard) return;
  expect(edit.width, "Edit is full width").toBeGreaterThanOrEqual(actions.width - 2 * 14 - 1);
  expect(edit.height).toBeGreaterThanOrEqual(43.5);
  expect(create.y, "Create automation is under Edit").toBeGreaterThan(edit.y + edit.height - 1);
  expect(Math.abs(create.y - discard.y), "Create automation and Discard share a row").toBeLessThan(1);
  expect(create.height).toBeGreaterThanOrEqual(43.5);
  expect(discard.height).toBeGreaterThanOrEqual(43.5);
  expect(Math.abs(create.width - discard.width), "two equal halves").toBeLessThan(2);
}

test("Scout proposes “Weekly sales report” to Ana in their DM; Ana edits the time and saves; the card says Created with changes", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const w = widthOf(info.project.name);
  const { context, page } = await openAs(browser, ANA, info.project.name);
  try {
    // ---- Ana asks in the DM; the cell proposes for that turn and answers it
    await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(page.getByTestId("dm-view")).toBeVisible();
    const asked = "Every Friday at 5 pm, send me a weekly sales report here.";
    const box = page.getByTestId("composer");
    await box.click();
    await box.fill(asked);
    await box.press("Enter");
    const turn = await turnFor({ conversationId: dmId, text: asked });
    const approvalId = await proposed(turn, REPORT);

    // ---- the card, live: Proposed, the fields, the line, and Ana's three buttons
    const card = cardOf(page, REPORT);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveAttribute("data-kind", "automation");
    await expect(card.getByTestId("agent-card-status")).toContainText("Proposed");
    const fields = card.getByTestId("agent-card-fields");
    await expect(fields).toContainText("Scout");
    await expect(fields).toContainText("Fridays at 5:00 PM");
    await expect(fields).toContainText("Your DM with Scout");
    await expect(fields).toContainText("Ana Pérez");
    await expect(fields).toContainText("Up to 24 runs a day");
    await expect(card.getByTestId("agent-card-block-value")).toContainText(ORDER);
    await expect(card.getByTestId("agent-card-automation-line")).toHaveText(
      "Scout proposed this. Nothing runs until Ana Pérez confirms.",
    );
    await expect(card.getByTestId("agent-card-open")).toHaveText(/Edit/);
    await expect(card.getByTestId("agent-card-open")).toHaveAttribute(
      "href",
      `/bots/automations?draft=${approvalId}`,
    );
    await expect(card.getByTestId("agent-card-create")).toHaveText("Create automation");
    await expect(card.getByTestId("agent-card-discard")).toHaveText("Discard");
    await expect(card.getByTestId("agent-card-automation-readonly")).toHaveCount(0);
    await expect(page.getByText(`I posted “${REPORT}” for you to confirm.`)).toBeVisible();
    if (w === "390") await expectPhoneFooter(card);
    await review(page, '[data-testid="agent-card"]', "nl-card-proposed-dm", w);

    // ---- Edit → the editor with the draft and its banner; cancelling leaves the card Proposed
    await card.getByTestId("agent-card-open").click();
    await expect(page).toHaveURL(new RegExp(`/bots/automations\\?draft=${approvalId}$`));
    const sheet = editor(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("automation-draft-banner")).toHaveText(
      "From Scout's proposal in your DM. Saving creates it and closes the proposal.",
    );
    await expect(sheet.getByTestId("automation-name-input")).toHaveValue(REPORT);
    await expect(sheet.getByTestId("automation-bot")).toContainText("Scout");
    await expect(sheet.getByTestId("automation-instructions")).toHaveValue(ORDER);
    await expect(sheet.getByTestId("schedule-repeat")).toHaveText(/Every week/);
    await expect(sheet.getByTestId("schedule-day-fri")).toBeChecked();
    await expect(sheet.getByTestId("schedule-time")).toHaveValue("17:00");
    await expect(sheet.getByTestId("schedule-zone")).toHaveValue("Europe/Madrid");
    await expect(sheet.getByTestId("automation-runs-per-day")).toHaveValue("24");
    await expect(sheet.getByTestId("next-run")).toHaveCount(3, { timeout: 10_000 });
    await expect(sheet.getByTestId("automation-run-as")).toContainText("Ana Pérez (you)");
    if (w === "390") {
      const sized = await sheet.boundingBox();
      expect(sized?.width ?? 0, "the editor is full screen at 390").toBeGreaterThanOrEqual(389);
    }
    await review(page, '[data-testid="automation-editor"]', "nl-editor-draft", w);

    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/bots\/automations$/);
    await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(card.getByTestId("agent-card-status")).toContainText("Proposed");
    await expect(card.getByTestId("agent-card-create")).toBeVisible();

    // ---- Edit again, 17:00 → 09:00, save: the automation exists and the proposal is closed with changes
    await card.getByTestId("agent-card-open").click();
    await expect(sheet.getByTestId("automation-draft-banner")).toBeVisible();
    await expect(sheet.getByTestId("schedule-time")).toHaveValue("17:00");
    await sheet.getByTestId("schedule-time").fill("09:00");
    await expect(sheet.getByTestId("next-run").first()).toHaveText(/^Fri, \w{3} \d{1,2}, 9:00 AM/, {
      timeout: 10_000,
    });
    await sheet.getByTestId("automation-submit").click();
    await expect(
      toast(page, /Created “Weekly sales report”\. First run Fri, \w{3} \d{1,2}, 9:00 AM\./),
    ).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/bots\/automations$/);
    await expect(page.getByTestId("automation-row").filter({ hasText: REPORT })).toBeVisible();

    const listed = (await (await ana.get("/api/v1/automations")).json()) as {
      automations: Array<{
        id: string;
        name: string;
        nextRunAt: string | null;
        trigger: { schedule?: { cron: string; timeZone: string } };
        target: { kind: string };
      }>;
    };
    const created = listed.automations.find((a) => a.name === REPORT && a.target.kind === "dm");
    expect(created, "the automation Ana saved").toBeTruthy();
    expect(created?.trigger.schedule).toEqual({ cron: "0 9 * * 5", timeZone: "Europe/Madrid" });
    const next = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(created?.nextRunAt ?? 0));
    expect(next, "the next run is Friday at 09:00 in Madrid").toBe("Fri 09:00");

    // ---- the card: Created with changes, Created by Ana, Open automation; the bot heard it
    await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(card.getByTestId("agent-card-status")).toContainText("Created with changes", {
      timeout: 15_000,
    });
    await expect(card.getByTestId("agent-card-decided")).toContainText("Created by Ana Pérez");
    await expect(card.getByTestId("agent-card-open-automation")).toHaveAttribute(
      "href",
      `/bots/automations?edit=${created?.id}`,
    );
    await expect(card.getByTestId("agent-card-create")).toHaveCount(0);
    await expect(card.getByTestId("agent-card-automation-line")).toHaveCount(0);
    await review(page, '[data-testid="agent-card"]', "nl-card-created-changes", w);

    // ---- the closed proposal no longer opens as a draft; it links to what it created
    await page.goto(`${BASE_URL}/bots/automations?draft=${approvalId}`);
    await expect(sheet.getByText("This proposal is no longer open")).toBeVisible();
    await expect(sheet.getByTestId("automation-draft-banner")).toHaveCount(0);
    await expect(sheet.getByTestId("automation-submit")).toHaveCount(0);
    await expect(sheet.getByRole("link", { name: "Open automation" })).toHaveAttribute(
      "href",
      `/bots/automations?edit=${created?.id}`,
    );
  } finally {
    await context.close();
  }
});

test("In #sales only Ana decides: Sam reads who can confirm, Ana creates one and discards another, a tainted turn proposes nothing", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const w = widthOf(info.project.name);
  const project = info.project.name;
  const mention = { mentions: [{ kind: "agent", id: scoutId }] };

  // ---- Ana mentions Scout in #sales; the card replies in her message's thread
  const asked = await postAs(
    ana,
    sales.id,
    "@Scout every Friday at 5 pm, a sales report here please",
    mention,
  );
  const approvalId = await proposed(await turnFor({ messageId: asked.id }), REPORT);
  const thread = `${BASE_URL}/chat/${sales.id}?thread=${asked.id}`;

  // ---- Sam: the same card, no buttons, who can confirm it
  const samView = await openAs(browser, SAM, project);
  try {
    await samView.page.goto(thread);
    const panel = samView.page.getByTestId("thread-panel");
    const card = cardOf(panel, REPORT);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("agent-card-status")).toContainText("Proposed");
    await expect(card.getByTestId("agent-card-fields")).toContainText(`#${sales.name}`);
    await expect(card.getByTestId("agent-card-automation-readonly")).toHaveText(
      "Only Ana Pérez can confirm this automation.",
    );
    await expect(card.getByTestId("agent-card-create")).toHaveCount(0);
    await expect(card.getByTestId("agent-card-discard")).toHaveCount(0);
    await expect(card.getByTestId("agent-card-open")).toHaveCount(0);
    // The API agrees: Sam may not decide, nor even read the request.
    expect((await sam.get(`/api/v1/approvals/${approvalId}`)).status()).toBe(404);
    await review(
      samView.page,
      '[data-testid="thread-panel"] [data-testid="agent-card"]',
      "nl-card-proposed-channel",
      w,
    );
  } finally {
    await samView.context.close();
  }

  const { context, page } = await openAs(browser, ANA, project);
  try {
    // ---- Ana confirms through the dialog: Created, by her, with Open automation
    await page.goto(thread);
    const panel = page.getByTestId("thread-panel");
    const card = cardOf(panel, REPORT);
    await expect(card.getByTestId("agent-card-create")).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("agent-card-open")).toHaveAttribute(
      "href",
      `/bots/automations?draft=${approvalId}`,
    );
    if (w === "390") await expectPhoneFooter(card);
    await card.getByTestId("agent-card-create").click();
    const dialog = page.getByTestId("agent-card-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toHaveText(`Create “${REPORT}”?`);
    await expect(dialog).toContainText(
      /It runs as you from Fri, \w{3} \d{1,2}, 5:00 PM, with your permissions\./,
    );
    await expect(dialog).toContainText("You can pause or delete it in Bots › Automations.");
    await expectNoSeriousA11y(page, '[data-testid="agent-card-confirm"]');
    await dialog.getByTestId("agent-card-confirm-submit").click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, /Created “Weekly sales report”\. First run Fri, /)).toBeVisible();
    await expect(card.getByTestId("agent-card-status")).toContainText("Created", { timeout: 15_000 });
    await expect(card.getByTestId("agent-card-status")).not.toContainText("with changes");
    await expect(card.getByTestId("agent-card-decided")).toContainText("Created by Ana Pérez");
    await expect(card.getByTestId("agent-card-open-automation")).toHaveAttribute(
      "href",
      /^\/bots\/automations\?edit=[0-9a-f-]{36}$/,
    );
    await expect(card.getByTestId("agent-card-create")).toHaveCount(0);
    const listed = (await (await ana.get("/api/v1/automations")).json()) as {
      automations: Array<{ name: string; target: { kind: string; conversationId?: string } }>;
    };
    expect(
      listed.automations.some((a) => a.name === REPORT && a.target.conversationId === sales.id),
      "the confirmed automation delivers to #sales",
    ).toBe(true);
    await review(page, '[data-testid="thread-panel"] [data-testid="agent-card"]', "nl-card-created", w);

    // ---- a second proposal, discarded: Discarded by Ana, and Scout hears it
    const pipeline = "Daily pipeline check";
    const again = await postAs(ana, sales.id, "@Scout and a daily pipeline check, please", mention);
    await proposed(await turnFor({ messageId: again.id }), pipeline);
    await page.goto(`${BASE_URL}/chat/${sales.id}?thread=${again.id}`);
    const second = cardOf(page.getByTestId("thread-panel"), pipeline);
    await expect(second.getByTestId("agent-card-discard")).toBeVisible({ timeout: 15_000 });
    await second.getByTestId("agent-card-discard").click();
    await expect(dialog.getByRole("heading")).toHaveText(`Discard “${pipeline}”?`);
    await expect(dialog).toContainText("Nothing is created. Scout is told you discarded it.");
    await dialog.getByTestId("agent-card-confirm-submit").click();
    await expect(toast(page, "Discarded.")).toBeVisible();
    await expect(second.getByTestId("agent-card-status")).toContainText("Discarded", { timeout: 15_000 });
    await expect(second.getByTestId("agent-card-decided")).toContainText("Discarded by Ana Pérez");
    await expect(second.getByTestId("agent-card-open-automation")).toHaveCount(0);
    const cardMessageId = await second
      .locator('xpath=ancestor::*[@data-testid="message"][1]')
      .getAttribute("data-message-id");
    await plugin.waitFor((e) => {
      const a = (e.data as { cardAction?: { messageId?: string; outcome?: string } }).cardAction;
      return e.type === "agent.card_action.v1" && a?.messageId === cardMessageId && a.outcome === "denied";
    }, 15_000);

    // ---- a turn that read outside content: refused for the bot to explain, no draft and no card
    const tainted = await postAs(
      ana,
      sales.id,
      "@Scout turn that pasted invoice into an automation",
      mention,
    );
    const taintedTurn = await turnFor({ messageId: tainted.id });
    await asSuperuser("update app.agent_turns set tainted = true where event_id = $1", [taintedTurn.eventId]);
    const refused = await propose(taintedTurn, "Invoice forwarder");
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body).toMatchObject({ ok: false, code: "tainted" });
    await plugin.reply(taintedTurn, refused.body.sentence);
    const drafts = await asSuperuser("select id from app.automation_drafts where event_id = $1", [
      taintedTurn.eventId,
    ]);
    expect(drafts.rowCount, "no draft for a tainted turn").toBe(0);
    await page.goto(`${BASE_URL}/chat/${sales.id}?thread=${tainted.id}`);
    const taintedPanel = page.getByTestId("thread-panel");
    await expect(taintedPanel.getByText(refused.body.sentence)).toBeVisible({ timeout: 15_000 });
    await expect(taintedPanel.getByTestId("agent-card")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
