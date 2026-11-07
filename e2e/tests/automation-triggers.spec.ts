import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import {
  clearBasicKeychainItems,
  createKeychainBasicItem,
  IMAP_PORT,
  MAIL_HOST,
  mailEnabled,
  sendTestMail,
  signAndPost,
  webhookEndpoint,
} from "../support/automation-triggers";
import { addBot, clearAutomations, waitBotReady } from "../support/automations";
import { boardColumn, cardTile, createBoardChannel, openBoard } from "../support/board";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { freshChannel } from "../support/chat";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL } from "./env";

/**
 * 07.6-18 (AUTO-02, D-02, D-07, R3, R4, R8, UI-SPEC Surfaces 2-4 and 8b): webhook and mail triggers in the browser.
 * Víctor (an admin; the UI-SPEC's lead Ana, same `automation.webhook` right) creates "Shopify orders": Webhook → What
 * happens (a card in the orders board's Intake column, Ask Ops helper to read it) → the payload mapping → Create → the
 * signing secret, shown once in a dialog that only closes once "I've stored the secret" is ticked. An order signed with
 * that secret becomes a card in Intake whose thread starts with the Received card, and the panel lists the delivery
 * with live mapping values. Then rotation with the 24 h grace, a forged request's notice, a duplicate, Sam (a member)
 * without the webhook right, and (OCW_E2E_MAIL=1) a mailbox signed in through a Keychain item, tested, saved and
 * delivering a mail as a Received card. Canaries prove no secret, password, payload or mail body leaks into the list,
 * toasts or run history. Review screenshots per UI-SPEC "Screenshots to take", plan 18.
 */

test.describe.configure({ mode: "serial" });

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

let admin: APIRequestContext;
let sam: APIRequestContext;
let plugin: FakeCellPlugin;
let opsId: string;
let orders: { id: string; name: string };
let intakeId: string;
let purchasing: { id: string; name: string };

/** State the serial tests share, per project. */
const run: { automationId: string; secret: string; cardMessageId: string } = {
  automationId: "",
  secret: "",
  cardMessageId: "",
};

const PAYLOAD_CANARY = `payload-canary-${Date.now().toString(36)}`;
const MAIL_CANARY = `mail-body-canary-${Date.now().toString(36)}`;
const PASSWORD_CANARY = `mail-pass-canary-${Date.now().toString(36)}`;

const order = (n: number) => ({
  order: { name: `#${1000 + n}`, note: "Deliver before noon", id: String(450_788 + n) },
  internal: PAYLOAD_CANARY,
});

/** An organization-wide template with the EXP prefix: the board numbers its cards EXP-0001… (07.1-07). */
async function expBoard(): Promise<{ id: string; name: string }> {
  const t = await admin.post("/api/v1/record-templates", {
    data: {
      unitId: null,
      name: `Orders ${Date.now().toString(36)}`,
      prefix: "EXP",
      namingRule: "{prefix}-{seq:0000} · {summary}",
      fields: [],
    },
  });
  expect(t.ok(), `template: ${t.status()} ${await t.text()}`).toBe(true);
  const templateId = ((await t.json()) as { id: string }).id;
  const board = await createBoardChannel(admin, { prefix: "orders", templateId, members: [sam] });
  expect((await admin.delete(`/api/v1/record-templates/${templateId}`)).ok()).toBe(true);
  const col = await admin.post(`/api/v1/boards/${board.id}/columns`, {
    data: { name: "Intake", category: "backlog" },
  });
  expect(col.ok(), `Intake column: ${col.status()} ${await col.text()}`).toBe(true);
  const ev = (await col.json()) as { columns: Array<{ id: string; name: string }> };
  intakeId = ev.columns.find((c) => c.name === "Intake")?.id ?? "";
  return board;
}

test.beforeAll(async () => {
  expect(cellToken(), "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  sam = await apiAs(SAM);
  plugin = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true, autoReply: true });
  await plugin.start();
  opsId = await freshTeamBot(admin, "Ops helper");
  await waitBotReady(admin, opsId);
  await clearAutomations(admin);
  orders = await expBoard();
  await addBot(admin, orders.id, opsId);
  purchasing = await freshChannel(admin, [sam], "purchasing");
  await addBot(admin, purchasing.id, opsId);
});

test.afterAll(async () => {
  await plugin?.stop();
  await sam?.dispose();
  await admin?.dispose();
});

/**
 * `openAs` with `prefers-reduced-motion: reduce`. The inbound card's status pill re-mounts and fades in when the Ops
 * helper (the fake cell) moves it from Received to Done, which happens on its own clock: an axe run that starts just
 * before the change measures the pill mid-fade (a blend of its text and background, 1.17:1 in the 07.14 gate) after
 * `expectNoSeriousA11y` has already waited for the running animations. The card's pills are `motion-reduce:animate-none`,
 * so with reduced motion every colour axe reads is a final one; `review()`'s colour-scheme switches keep the setting.
 */
async function openStill(...args: Parameters<typeof openAs>): ReturnType<typeof openAs> {
  const opened = await openAs(...args);
  await opened.page.emulateMedia({ reducedMotion: "reduce" });
  return opened;
}

const editor = (page: Page) => page.getByTestId("automation-editor");

async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

async function openAutomations(page: Page, query = ""): Promise<void> {
  await page.goto(`${BASE_URL}/bots/automations${query}`);
  await expect(
    page
      .getByTestId("automations-list")
      .or(page.getByText("No automations yet"))
      .or(page.getByText("Ask an admin if you need automations.")),
  ).toBeVisible({ timeout: 20_000 });
}

/** Scrolls `locator` to the top of its scroll container (review screenshots start at the section). */
const scrollToTop = (locator: Locator) => locator.evaluate((el) => el.scrollIntoView({ block: "start" }));

/** Records every toast's text in the page (the canaries are checked against them). */
async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __toasts: string[] }).__toasts = seen;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll("[data-sonner-toast]")) {
        const t = el.textContent ?? "";
        if (!seen.includes(t)) seen.push(t);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

const toastsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? []);

/** Named controls, no sideways scroll, 44 px targets below 768 and no serious axe finding on `selector`. */
async function invariants(page: Page, selector: string, label: string): Promise<void> {
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expectNoSeriousA11y(page, selector);
  expect(await unnamedControls(page), `${label}: controls without an accessible name`).toEqual([]);
  await expectNoSidewaysScroll(page, label);
  await expectTouchTargets(page, selector);
}

/** Axe in light and dark on every selector, then the light and dark review screenshots. */
async function review(page: Page, selectors: string[], name: string | null): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const s of selectors) await invariants(page, s, `${name ?? s} (${theme})`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (name) await captureReview(page, name);
}

test("Víctor creates “Shopify orders”, copies the secret once, and a signed order arrives as a card in Intake", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const w = widthOf(info.project.name);
  const { context, page } = await openStill(browser, ADMIN, info.project.name);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  await recordToasts(page);
  try {
    await openAutomations(page, "?new=1");
    const sheet = editor(page);
    await expect(sheet.getByTestId("automation-editor-title")).toHaveText("New automation");
    await sheet.getByTestId("automation-name-input").fill("Shopify orders");
    await pick(page, sheet.getByTestId("automation-bot"), "Ops helper");
    await sheet
      .getByTestId("automation-instructions")
      .fill("Check each new order and say if anything is missing.");

    // ---- WHEN: Webhook. Before the save, the URL line and the mapping.
    await sheet.getByTestId("trigger-kind-webhook").click();
    await expect(sheet.getByTestId("trigger-kind-webhook").locator("input")).toBeChecked();
    await expect(
      sheet.getByText("The URL and signing secret appear after you create the automation."),
    ).toBeVisible();
    await sheet.getByTestId("mapping-title").fill("order/name");
    await sheet.getByTestId("automation-submit").click();
    await expect(sheet.getByText("Use a JSON pointer like /order/name")).toBeVisible();
    await sheet.getByTestId("mapping-title").fill("/order/name");
    await sheet.getByTestId("mapping-body").fill("/order/note");
    await sheet.getByTestId("mapping-thread-key").fill("/order/id");
    await expect(sheet.getByText("Send a test event to preview values.")).toBeVisible();

    // ---- DELIVER TO the orders board's Intake column; What happens follows it
    await sheet.getByTestId("target-kind-board").click();
    await pick(page, sheet.getByTestId("target-board"), orders.name);
    await pick(page, sheet.getByTestId("target-column"), "Intake");
    const what = sheet.getByTestId("what-happens");
    await expect(what.getByTestId("inbound-action-board_card").locator("input")).toBeChecked();
    await expect(what).toContainText("Create a board card");
    await expect(what).toContainText("Ask Ops helper to read it");
    await expect(what.getByTestId("inbound-ask-bot")).toHaveAttribute("aria-checked", "true");
    await sheet.getByTestId("trigger-step").scrollIntoViewIfNeeded();
    await review(page, ['[data-testid="trigger-step"]'], null);

    // ---- Create: the reveal dialog, which Escape cannot close until the box is ticked
    await sheet.getByTestId("automation-submit").click();
    const reveal = page.getByTestId("secret-reveal");
    await expect(reveal).toBeVisible();
    await expect(reveal.getByText("Copy your signing secret")).toBeVisible();
    await expect(reveal.getByTestId("secret-reveal-copy")).toBeFocused();
    const secret = await reveal.getByTestId("secret-reveal-value").inputValue();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{32,}$/);
    run.secret = secret;
    await page.keyboard.press("Escape");
    await expect(reveal).toBeVisible();
    await expect(reveal.getByText("Tick the box to close.")).toBeVisible();
    // Done is aria-disabled until the box is ticked: a click (forced past Playwright's check) closes nothing.
    await expect(reveal.getByTestId("secret-reveal-done")).toHaveAttribute("aria-disabled", "true");
    await reveal.getByTestId("secret-reveal-done").click({ force: true });
    await expect(reveal).toBeVisible();
    await reveal.getByTestId("secret-reveal-copy").click();
    await expect(reveal.getByTestId("secret-reveal-copy")).toHaveText(/Copied/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
    await review(page, ['[data-testid="secret-reveal"]'], `webhook-secret-reveal-${w}`);
    await reveal.getByTestId("secret-reveal-stored").check();
    await expect(reveal.getByText("Tick the box to close.")).toHaveCount(0);
    await captureReview(page, `webhook-secret-reveal-ticked-${w}`);
    await reveal.getByTestId("secret-reveal-done").click();
    await expect(reveal).toBeHidden();

    // ---- The sheet stayed open on the new automation: its endpoint panel, the secret gone from the page
    await expect(page).toHaveURL(/\?edit=[0-9a-f-]{36}/);
    run.automationId = new URL(page.url()).searchParams.get("edit") ?? "";
    const panel = sheet.getByTestId("webhook-panel");
    await expect(panel.getByTestId("webhook-url")).toHaveValue(/\/api\/v1\/hooks\/[0-9A-Za-z]{26}$/);
    await expect(panel.getByTestId("webhook-secret-line")).toHaveText(/^Set \w{3} \d{1,2} · shown once$/);
    expect(await page.content()).not.toContain(secret);
    const url = await panel.getByTestId("webhook-url").inputValue();

    // ---- A signed order → a card in Intake whose thread starts with the Received card
    const sent = await signAndPost(url, secret, order(1));
    expect(sent.status, sent.body).toBe(202);
    let cardMessageId = "";
    await expect
      .poll(
        async () => {
          const ep = await webhookEndpoint(admin, run.automationId);
          cardMessageId = ep.deliveries.find((d) => d.link?.cardNumber)?.link?.messageId ?? "";
          return cardMessageId;
        },
        { timeout: 30_000, message: "the order became a board card" },
      )
      .not.toBe("");
    run.cardMessageId = cardMessageId;

    await panel.getByTestId("webhook-refresh").click();
    const row = panel.getByTestId("webhook-delivery").filter({ hasText: "Accepted" }).first();
    await expect(row.getByTestId("webhook-delivery-text")).toHaveText(
      new RegExp(`^Created card EXP-\\d{4} in ${orders.name}$`),
    );
    await expect(row.getByRole("link")).toHaveAttribute("href", `/chat/${orders.id}?thread=${cardMessageId}`);
    await expect(panel.getByTestId("mapping-title-value")).toHaveText("→ “#1001”");
    await expect(panel.getByTestId("mapping-body-value")).toHaveText("→ “Deliver before noon”");
    // The payload's other fields are never rendered.
    expect(await page.content()).not.toContain(PAYLOAD_CANARY);

    // ---- Reopening the editor never shows the secret
    await openAutomations(page, `?edit=${run.automationId}`);
    await expect(editor(page).getByTestId("webhook-url")).toBeVisible();
    await expect(page.getByTestId("secret-reveal")).toHaveCount(0);
    expect(await page.content()).not.toContain(secret);

    // ---- The board: the card in Intake, its thread led by the Received card (warning first)
    const board = await openBoard(page, orders.id);
    // At 390 the board shows one column at a time, behind its tab.
    if (w === "390")
      await board
        .getByTestId("board-tabs")
        .getByRole("tab", { name: /^Intake, / })
        .click();
    await expect(cardTile(boardColumn(board, intakeId), cardMessageId)).toBeVisible();
    await page.goto(`${BASE_URL}/chat/${orders.id}?thread=${cardMessageId}`);
    const thread = page.getByTestId("thread-panel");
    const inbound = thread.locator('[data-testid="agent-card"][data-kind="automation"]').first();
    await expect(inbound).toBeVisible({ timeout: 20_000 });
    await expect(inbound.getByTestId("agent-card-status")).toHaveAttribute(
      "aria-label",
      /^Status: (Received|Done)$/,
    );
    await expect(inbound.getByTestId("agent-card-notice").first()).toHaveText(
      /^Outside content from Webhook/,
    );
    await expect(inbound).toContainText("#1001");
    await inbound.scrollIntoViewIfNeeded();
    await review(
      page,
      ['[data-testid="thread-panel"] [data-testid="agent-card"][data-kind="automation"]'],
      null,
    );
    await captureReview(page, `inbound-board-card-${w}`);

    // ---- Canaries: the list, the toasts and the run history never carry the secret or the payload
    await openAutomations(page);
    let html = await page.content();
    expect(html).not.toContain(secret);
    expect(html).not.toContain(PAYLOAD_CANARY);
    await openAutomations(page, `?edit=${run.automationId}&tab=runs`);
    await expect(page.getByTestId("automation-editor")).toBeVisible();
    html = await page.content();
    expect(html).not.toContain(secret);
    expect(html).not.toContain(PAYLOAD_CANARY);
    for (const t of await toastsOf(page)) {
      expect(t).not.toContain(secret);
      expect(t).not.toContain(PAYLOAD_CANARY);
    }
  } finally {
    await context.close();
  }
});

test("rotation with its grace line, a forged request's notice, a duplicate, and the panel's layout", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  expect(run.automationId, "the first test created the automation").not.toBe("");
  const w = widthOf(info.project.name);
  const { context, page } = await openStill(browser, ADMIN, info.project.name);
  await recordToasts(page);
  try {
    const ep = await webhookEndpoint(admin, run.automationId);
    // A duplicate (same webhook-id) and a forged request, after one more accepted order.
    const second = await signAndPost(ep.url, run.secret, order(2));
    expect(second.status).toBe(202);
    const dup = await signAndPost(ep.url, run.secret, order(2), { id: second.id });
    expect(dup.status, dup.body).toBe(200);
    const forged = await signAndPost(ep.url, run.secret, order(3), { forge: true });
    expect(forged.status).toBe(401);

    await openAutomations(page, `?edit=${run.automationId}`);
    const sheet = editor(page);
    const panel = sheet.getByTestId("webhook-panel");
    await expect(panel.getByTestId("webhook-url")).toBeVisible();
    await expect(panel.locator('[data-testid="webhook-delivery"][data-result="duplicate"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="webhook-delivery"][data-result="duplicate"]')).toContainText(
      "Already received; nothing new",
    );
    await expect(panel.getByTestId("webhook-rejection")).toHaveText(
      /^Last rejected .+: the signature didn't match\. Check that the sender uses the current secret\.$/,
    );

    // ---- the review: How to send open, mapping with live values, deliveries and the notice
    await panel.getByTestId("webhook-howto-toggle").click();
    await expect(panel.getByTestId("webhook-howto-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByTestId("webhook-howto")).toContainText("Uses Standard Webhooks");
    if (w === "390") {
      // URL and copy on one row, Rotate full width under the secret line, 44 px controls.
      const input = await panel.getByTestId("webhook-url").boundingBox();
      const copy = await panel.getByTestId("webhook-url-copy").boundingBox();
      expect(input && copy && Math.abs(input.y + input.height / 2 - (copy.y + copy.height / 2)) < 4).toBe(
        true,
      );
      expect(copy?.height ?? 0).toBeGreaterThanOrEqual(43.5);
      const rotate = await panel.getByTestId("webhook-rotate").boundingBox();
      const box = await panel.boundingBox();
      expect(rotate?.height ?? 0).toBeGreaterThanOrEqual(43.5);
      expect((rotate?.width ?? 0) + 2).toBeGreaterThanOrEqual(box?.width ?? 0);
    }
    await scrollToTop(sheet.getByTestId("trigger-step"));
    await review(page, ['[data-testid="webhook-panel"]'], `webhook-panel-${w}`);
    await panel.getByTestId("webhook-deliveries").scrollIntoViewIfNeeded();
    await captureReview(page, `webhook-panel-deliveries-${w}`);

    // ---- Rotate: confirmation (focus on Cancel), the new secret once, then the grace line
    await panel.getByTestId("webhook-rotate").click();
    const confirm = page.getByTestId("webhook-rotate-dialog");
    await expect(confirm.getByText("Rotate the signing secret?")).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    if (w === "390") await review(page, ['[data-testid="webhook-rotate-dialog"]'], `webhook-rotate-${w}`);
    await confirm.getByTestId("webhook-rotate-confirm").click();
    const reveal = page.getByTestId("secret-reveal");
    await expect(reveal).toBeVisible();
    const fresh = await reveal.getByTestId("secret-reveal-value").inputValue();
    expect(fresh).toMatch(/^whsec_/);
    expect(fresh).not.toBe(run.secret);
    await page.keyboard.press("Escape");
    await expect(reveal.getByText("Tick the box to close.")).toBeVisible();
    await reveal.getByTestId("secret-reveal-stored").check();
    await reveal.getByTestId("secret-reveal-done").click();
    await expect(reveal).toBeHidden();
    await expect(panel.getByTestId("webhook-grace")).toHaveText(
      /^Previous secret also valid until \w{3} \d{1,2}, /,
    );
    expect(await page.content()).not.toContain(fresh);
    // Both secrets verify during the grace.
    expect((await signAndPost(ep.url, run.secret, order(4))).status).toBe(202);
    expect((await signAndPost(ep.url, fresh, order(5))).status).toBe(202);
    for (const t of await toastsOf(page)) {
      expect(t).not.toContain(fresh);
      expect(t).not.toContain(run.secret);
    }
    run.secret = fresh;
  } finally {
    await context.close();
  }
});

test("Sam (a member) sees Webhook disabled with its reason", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const w = widthOf(info.project.name);
  const { context, page } = await openStill(browser, SAM, info.project.name);
  try {
    await openAutomations(page, "?new=1");
    const card = editor(page).getByTestId("trigger-kind-webhook");
    await expect(card.locator("input")).toBeDisabled();
    await expect(card).toContainText("Only team leads and admins can create webhooks.");
    if (w === "1440") await review(page, ['[data-testid="trigger-step"]'], `webhook-no-permission-${w}`);
  } finally {
    await context.close();
  }
});

test("mail through Keychain: test, save, a mail arrives as a Received card; failures and no keys", async ({
  browser,
}, info) => {
  test.skip(!mailEnabled(), "needs OCW_E2E_MAIL=1 (GreenMail)");
  test.setTimeout(300_000);
  const w = widthOf(info.project.name);
  const address = `purchasing-${info.project.name}-${Date.now().toString(36)}@ocw.test`;
  await clearBasicKeychainItems(admin);
  const key = await createKeychainBasicItem(admin, {
    name: "Purchasing mailbox",
    hosts: [`${MAIL_HOST}:${IMAP_PORT}`],
    username: address,
    password: PASSWORD_CANARY,
  });
  const { context, page } = await openStill(browser, ADMIN, info.project.name);
  await recordToasts(page);
  try {
    await openAutomations(page, "?new=1");
    const sheet = editor(page);
    await sheet.getByTestId("automation-name-input").fill("Supplier inbox");
    await pick(page, sheet.getByTestId("automation-bot"), "Ops helper");
    await sheet.getByTestId("automation-instructions").fill("Summarise each supplier mail in one line.");
    await sheet.getByTestId("trigger-kind-mail").click();
    const panel = sheet.getByTestId("mailbox-panel");
    await pick(page, panel.getByTestId("mailbox-key"), /^Purchasing mailbox/);
    await panel.getByTestId("mailbox-host").fill("imap.other.test");
    // ---- a server outside the key's hosts: the inline error with the Keychain link, and the API agrees
    await expect(panel.getByTestId("mailbox-host-mismatch")).toHaveText(
      /Add imap\.other\.test to the allowed hosts of “Purchasing mailbox” in Keychain\./,
    );
    await expect(panel.getByTestId("mailbox-host-mismatch").getByRole("link")).toHaveAttribute(
      "href",
      "/settings/keychain",
    );
    await panel.getByTestId("mailbox-test").click();
    await expect(panel.getByTestId("mailbox-test-result")).toHaveText(
      "imap.other.test isn't an allowed host for “Purchasing mailbox”.",
    );

    // ---- the right server: Test connection never saves; it connects
    await panel.getByTestId("mailbox-host").fill(MAIL_HOST);
    await panel.getByTestId("mailbox-port").fill(String(IMAP_PORT));
    await expect(panel.getByTestId("mailbox-folder")).toHaveValue("INBOX");
    await pick(page, panel.getByTestId("mailbox-every"), "5 minutes");
    await panel.getByTestId("mailbox-test").click();
    await expect(panel.getByTestId("mailbox-test-result")).toHaveText(
      /^Connected\. INBOX has \d+ messages\.$/,
      {
        timeout: 20_000,
      },
    );
    const before = await admin.get("/api/v1/automations");
    expect(
      ((await before.json()) as { automations: Array<{ name: string }> }).automations.map((a) => a.name),
    ).not.toContain("Supplier inbox");
    await pick(page, sheet.getByTestId("target-channel"), `#${purchasing.name}`);
    await expect(sheet.getByTestId("what-happens")).toContainText("Post it in a thread");
    await scrollToTop(sheet.getByTestId("trigger-step"));
    await review(
      page,
      ['[data-testid="mailbox-panel"]', '[data-testid="trigger-step"]'],
      `mailbox-panel-${w}`,
    );

    await sheet.getByTestId("automation-submit").click();
    await expect(page.getByText("Created “Supplier inbox”.")).toBeVisible();
    await expect(sheet).toBeHidden();
    const list = (await (await admin.get("/api/v1/automations")).json()) as {
      automations: Array<{ id: string; name: string }>;
    };
    const mailId = list.automations.find((a) => a.name === "Supplier inbox")?.id ?? "";
    expect(mailId).not.toBe("");
    // The save answers before its baseline poll ends (07.6 review A MD-04): mail is new once the baseline is taken.
    await expect
      .poll(
        async () =>
          (
            await asSuperuser(
              "select 1 from app.mailboxes where automation_id = $1 and last_polled_at is not null",
              [mailId],
            )
          ).rowCount,
        { timeout: 30_000, intervals: [250], message: "the mailbox baseline was taken" },
      )
      .toBe(1);

    // ---- a mail arrives: polled on the next tick (the e2e moves the next poll to now)
    const body = `Hello, please deliver order 1001 before noon. ${MAIL_CANARY} ${"Details follow. ".repeat(40)}`;
    await sendTestMail(address, { subject: "Order 1001 · deliver before noon", text: body });
    await asSuperuser("update app.mailboxes set next_poll_at = now() where automation_id = $1", [mailId]);
    let anchor: { conversationId: string; messageId: string } | null = null;
    await expect
      .poll(
        async () => {
          const res = await admin.get(`/api/v1/automations/${mailId}/runs`);
          const runs = (
            (await res.json()) as {
              runs: Array<{ trigger: string; anchor: { conversationId: string; messageId: string } | null }>;
            }
          ).runs;
          anchor = runs.find((r) => r.trigger === "mail" && r.anchor)?.anchor ?? null;
          return anchor !== null;
        },
        { timeout: 120_000, intervals: [2_000], message: "the mail became a Received card" },
      )
      .toBe(true);
    const a = anchor as unknown as { conversationId: string; messageId: string };

    // ---- the Received card is the thread root in #purchasing; the full text is its first reply
    await page.goto(`${BASE_URL}/chat/${purchasing.id}?thread=${a.messageId}`);
    const thread = page.getByTestId("thread-panel");
    const card = thread.locator('[data-testid="agent-card"][data-kind="automation"]').first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("agent-card-notice").first()).toHaveText(/^Outside content from Mail/);
    await expect(card).toContainText("Order 1001 · deliver before noon");
    await expect(thread.getByText("Full message")).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await review(
      page,
      ['[data-testid="thread-panel"] [data-testid="agent-card"][data-kind="automation"]'],
      null,
    );
    await captureReview(page, `inbound-thread-${w}`);

    // ---- the saved panel: the status line
    await openAutomations(page, `?edit=${mailId}`);
    const saved = editor(page).getByTestId("mailbox-panel");
    await expect(saved.getByTestId("mailbox-status")).toHaveText(/Checked .+ · 1 new message$/, {
      timeout: 20_000,
    });

    // ---- a failed sign-in: the test line and the saved status (GreenMail here accepts any password, so the API's
    // auth_failed answer is replayed for the test, and the status is set as the poller sets it)
    await page.route("**/api/v1/mailboxes/test", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"ok":false,"code":"auth_failed"}',
      }),
    );
    await asSuperuser(
      `update app.mailboxes set status = 'auth_failed', last_error_code = 'auth_failed',
              next_poll_at = now() + interval '1 hour' where automation_id = $1`,
      [mailId],
    );
    await page.reload();
    const failed = editor(page).getByTestId("mailbox-panel");
    await failed.getByTestId("mailbox-test").click();
    await expect(failed.getByTestId("mailbox-test-result")).toHaveText(
      "Sign-in failed. Check the username and app password in Keychain.",
    );
    await expect(failed.getByTestId("mailbox-status")).toHaveText(
      /Sign-in failed .+\. Update the password in Keychain\.$/,
    );
    // The failed test line and the failed status, centred (at 390 they sit under the fields).
    await failed.getByTestId("mailbox-test-result").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await review(page, ['[data-testid="mailbox-panel"]'], `mailbox-failed-${w}`);
    await page.unroute("**/api/v1/mailboxes/test");

    // ---- canaries: no password, mail body or secret in the list, the run history or any toast
    for (const q of ["", `?edit=${mailId}&tab=runs`]) {
      await openAutomations(page, q);
      const html = await page.content();
      for (const c of [PASSWORD_CANARY, MAIL_CANARY, PAYLOAD_CANARY, run.secret].filter(Boolean)) {
        expect(html).not.toContain(c);
      }
    }
    for (const t of await toastsOf(page)) {
      expect(t).not.toContain(PASSWORD_CANARY);
      expect(t).not.toContain(MAIL_CANARY);
    }
    expect(key.id).toBeTruthy();
  } finally {
    await context.close();
  }
});

test("Sam has no username and password keys: the panel sends him to Keychain", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const w = widthOf(info.project.name);
  await clearBasicKeychainItems(sam);
  const { context, page } = await openStill(browser, SAM, info.project.name);
  try {
    await openAutomations(page, "?new=1");
    const sheet = editor(page);
    await sheet.getByTestId("trigger-kind-mail").click();
    const none = sheet.getByTestId("mailbox-no-keys");
    await expect(none).toContainText("You have no username and password keys.");
    await expect(none.getByRole("link", { name: "Add one in Keychain" })).toHaveAttribute(
      "href",
      "/settings/keychain",
    );
    await none.scrollIntoViewIfNeeded();
    await review(page, ['[data-testid="mailbox-panel"]'], w === "390" ? `mailbox-no-keys-${w}` : null);
  } finally {
    await context.close();
  }
});
