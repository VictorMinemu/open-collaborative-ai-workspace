import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, openAs, userIdOf } from "../support/actors";
import {
  addOrders,
  CAM,
  DAN,
  deleteAutomationsNamed,
  EVA,
  type FanOutBoard,
  type FanOutPeople,
  fanOutAutomationBody,
  runsOf,
  seedAtlasWorkZone,
  seedFanOutBoard,
  TEAM,
  TEAM_HANDLE,
} from "../support/automation-fan-out";
import { addBot, waitBotReady } from "../support/automations";
import { boardColumn, boardSnapshot, cardTile, openBoard } from "../support/board";
import { FAKE_MCP_HOST, FAKE_URL } from "../support/bot-tools";
import { type BotWorkZonePolicy, setWorkZonePolicy } from "../support/bot-work-zone";
import { cellToken } from "../support/cell-token";
import { messageRow } from "../support/chat";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { captureReview, expectNoSidewaysScroll, expectTouchTargets } from "../support/layout";
import { grantErp, registerFakeErp, removeConnector } from "../support/watched";
import { type FakeDeviceHandle, startIsolatedServer } from "../support/work-zone-device";
import { ADMIN, API_URL } from "./env";

/**
 * 07.17-18 (AFO-01 … AFO-05, PD-19, PD-22; ROADMAP success criteria 1–3): the owner's scenario in the browser with the
 * fake cell (e2e/support/fake-cell-plugin.ts: no model, no provider), the fake ERP (infra/fake-model/fake-erp-mcp.mjs)
 * and a REAL local-runtime daemon in fake-runtime mode on an isolated build server (no real runtime).
 *
 *   1. Desktop: the owner creates "Fleet orders" in the automation editor for the team bot Atlas: every 10 minutes, the
 *      `#fleet` board's Backlog, "Open a conversation for each new item" on, Logistics to mention. The phone run creates
 *      the same automation through the API (fanOutAutomationBody) and only opens the editor to check its sections at 390:
 *      the mobile run stays on the board, the threads and the inbox.
 *   2. The fake ERP gets two new orders (`__add`); Run now; the fake cell's run turn lists the ERP and opens one
 *      conversation per order (`ocw_conversation_open`): two cards "Order 1042" and "Order 1043" in Backlog, the run
 *      card "Opened 2 conversations" in the "Fleet orders · Runs" thread. A second Run now opens nothing ("Nothing new").
 *      The item turns are held (the persona's hook awaits a gate) until those states are checked.
 *   3. Each card's item turn moves its card to In progress and starts a Work Zone session through Atlas's 07.16 profile
 *      (`actOnOutsideContent` on: the item is outside content); the daemon holds the turn (`OCW_RUNTIME_FAKE_HOLD_FILE`)
 *      so the live card is seen working; then the turn finishes, the wake reads the session, moves the card to Done and
 *      replies "Done: … @logistics" in the card's thread.
 *   4. Cam (Logistics, reads `#fleet`) gets the team mention in his Mentions ("Atlas mentioned @logistics"); Eva, who
 *      reads `#fleet` from outside the team, gets nothing.
 * Every screen passes axe in light and dark and never scrolls sideways (44 px targets on phones for the editor's
 * sections, the escalation chips and the composer's suggestions); review screenshots `0717-<screen>-<width>` in light
 * and dark when OCW_E2E_SCREENSHOT_DIR is set: editor, board, runs, card-thread, composer-teams, inbox.
 * The spec removes its automation, connector, bot and device, and puts the organization's Work Zone policy back.
 */

test.describe.configure({ mode: "serial" });

const ORDERS = ["1042", "1043"] as const;
const INSTRUCTIONS = "List the new orders in the ERP and open a card for each one. Prepare each shipment.";
const CONNECTOR = "Orders ERP";
const THREAD = '[data-testid="thread-panel"]';
const READ = "ocw_work_session_read";
const START = "ocw_work_session_start";
const ADMIN_HANDLE = ADMIN.email.split("@")[0] as string;

let w = "1440";
let mobile = false;
let name = "";
let admin: APIRequestContext;
let adminId = "";
let cell: FakeCellPlugin;
let device: FakeDeviceHandle | null = null;
let policyBefore: BotWorkZonePolicy | null = null;
let holdDir = "";
let holdFile = "";
let deviceName = "";
let people: FanOutPeople;
let board: FanOutBoard;
let erp: { id: string; name: string; safeName: string };
let atlas: { id: string; name: string; username: string };
let automationId = "";
const createdBots: string[] = [];
/** The item turns wait here until the spec has seen the cards in Backlog and the dedupe (their hook awaits it). */
let releaseItems: () => void = () => undefined;
let itemsGate: Promise<void> = Promise.resolve();

/** A fresh organization bot named `name` (an older one of that name is deleted first), removed after the spec. */
async function freshTeamBot(botName: string): Promise<{ id: string; name: string; username: string }> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === botName)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok(), `delete ${botName}`).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name: botName,
      description: "Prepares fleet orders.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create team bot ${botName}: ${res.status()}`).toBe(true);
  const bot = (await res.json()) as { id: string; name: string; username: string };
  createdBots.push(bot.id);
  return bot;
}

/** Picks the option showing `option` in the Base UI select behind `trigger`. */
async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await expect(trigger).toBeEnabled({ timeout: 15_000 });
  await trigger.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** The automations page, waited until the list or its empty state is there. */
async function openAutomations(page: Page, query: string): Promise<Locator> {
  await page.goto(`${BASE_URL}/bots/automations${query}`);
  const sheet = page.getByTestId("automation-editor");
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  return sheet;
}

/** Opens the thread of `rootId` on the board (a full screen on phones). */
async function openThread(page: Page, rootId: string): Promise<Locator> {
  await page.goto(`${BASE_URL}/chat/${board.id}?thread=${rootId}`);
  const panel = page.locator(THREAD);
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

/** The bot's latest message in `scope` containing every `expected` text. */
function botReply(scope: Page | Locator, ...expected: Array<string | RegExp>): Locator {
  let reply = scope.locator('[data-testid="message"][data-author-kind="agent"]');
  for (const e of expected) reply = reply.filter({ hasText: e });
  return reply.last();
}

/** At 390 the board shows one column at a time: select the tab of `colId` (a no-op on desktop). */
async function showColumn(view: Locator, colId: string): Promise<void> {
  if (!mobile) return;
  await view.locator(`[data-testid="board-tabs"] [role="tab"][data-column-id="${colId}"]`).click();
  await expect(boardColumn(view, colId)).toBeVisible();
}

/** The board's cards by title, as the API has them now (every column). */
async function cardsByTitle(): Promise<Map<string, { messageId: string; columnId: string }>> {
  const snap = await boardSnapshot(admin, board.id);
  return new Map(snap.cards.flatMap((c) => c.cards).map((c) => [c.title, c]));
}

/** The id of the order card titled `Order <id>`. */
async function cardOf(order: string): Promise<string> {
  const card = (await cardsByTitle()).get(`Order ${order}`);
  expect(card, `the card of order ${order}`).toBeTruthy();
  return card?.messageId ?? "";
}

/** The newest run of the automation that matches `pred`, once it does. */
async function waitRunWhere(pred: (r: Awaited<ReturnType<typeof runsOf>>[number]) => boolean, what: string) {
  let hit: Awaited<ReturnType<typeof runsOf>>[number] | undefined;
  await expect
    .poll(
      async () => {
        hit = (await runsOf(admin, automationId)).find(pred);
        return hit !== undefined;
      },
      { timeout: 45_000, message: what },
    )
    .toBe(true);
  return hit as Awaited<ReturnType<typeof runsOf>>[number];
}

/** Every conversation the automation opened so far (each run's `opened`), so a scheduled run in between still adds up. */
async function openedSoFar(): Promise<number> {
  return (await runsOf(admin, automationId)).reduce((n, r) => n + (r.opened ?? 0), 0);
}

/** `POST /automations/:id/run` (Run now) and the run once the bot answered it (the open call answers a fan-out run). */
async function runNowAnswered(): Promise<Awaited<ReturnType<typeof runsOf>>[number]> {
  const res = await admin.post(`/api/v1/automations/${automationId}/run`);
  expect(res.status(), `run ${automationId}: ${await res.text()}`).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  return waitRunWhere((r) => r.id === runId && r.status === "answered", `run ${runId} answered`);
}

/** The member's mention notifications on the board. */
async function boardMentions(api: APIRequestContext) {
  const res = await api.get("/api/v1/notifications?filter=mentions");
  expect(res.ok(), "notifications").toBe(true);
  const list = (await res.json()) as {
    items: Array<{
      kind: string;
      messageId: string;
      conversation: { id: string };
      actor: { kind?: string; id?: string };
      unit?: { handle: string } | null;
      snippet: string;
    }>;
    unreadCount: number;
  };
  return { items: list.items.filter((n) => n.conversation.id === board.id), unreadCount: list.unreadCount };
}

/**
 * The invariants of one screen (PD-19): axe in light and dark on `selector`, no sideways scroll in either theme, and on
 * phones 44 px targets under each of `touch`. The screen's `0717-<screen>-<width>` capture follows each call.
 */
async function checkScreen(
  page: Page,
  screen: string,
  selector: string,
  touch: Array<string | Locator> = [],
) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoSeriousA11y(page, selector);
    await expectNoSidewaysScroll(page, `${screen} ${w} (${theme})`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (mobile) for (const root of touch) await expectTouchTargets(page, root);
}

async function readAll(api: APIRequestContext): Promise<void> {
  expect((await api.post("/api/v1/notifications/read", { data: { all: true } })).ok()).toBe(true);
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixtures argument before testInfo
test.beforeAll(async ({}, info) => {
  test.setTimeout(180_000);
  mobile = info.project.name === "mobile";
  w = mobile ? "390" : "1440";
  name = `Fleet orders ${w}`;
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  adminId = await userIdOf(admin);
  // ADR-0012 and D-15: the organization allows Full access and bot sessions (put back in afterAll).
  policyBefore = await setWorkZonePolicy(admin, { allowFullAccess: true, botSessionsMax: 10 });
  itemsGate = new Promise<void>((resolve) => {
    releaseItems = resolve;
  });
  ({ people, board } = await seedFanOutBoard(admin));
  for (const p of [people.cam, people.dan, people.eva]) await readAll(p.api);

  cell = new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: true,
    userHandles: { [adminId]: ADMIN_HANDLE },
    // The ERP is an organization server rendered in the cell (static headers): the cell calls it itself, after the
    // gate, on the host the API knows as `fake-mcp` (loopback here). The connector proxy refuses such a server.
    mcpHostMap: { [FAKE_MCP_HOST]: FAKE_URL ? new URL(FAKE_URL).host : "" },
    // PD-22: this automation's run lists the ERP and keeps this spec's orders (a persona would keep the status-new
    // ones; the fake ERP's seed orders and other specs' records are not this automation's business).
    fanOutFor: (run) =>
      run.automationRun.automationId === automationId
        ? {
            connector: erp.safeName,
            select: (ids) => ids.filter((id) => (ORDERS as readonly string[]).includes(id)),
          }
        : null,
    // Each card: to In progress, then a Work Zone session on the build server (in Full access: isolated server).
    itemCallsFor: async (item) => {
      if (item.conversation.id !== board.id) return [];
      await itemsGate;
      const order = item.automationItem.item.title.replace(/^Order /u, "");
      return [
        { tool: "ocw_board_card", args: { action: "move", columnId: board.columns.started } },
        {
          tool: START,
          args: {
            projectId: device?.projectId,
            prompt: `Prepare the shipment for order ${order}`,
            permissionMode: "fullAccess",
          },
        },
      ];
    },
    // The wake: read the session (its summary carries no runtime text, WR-01), then the card to Done.
    wakeCallsFor: (wake) => [
      { tool: READ, args: { workSessionId: wake.workSession.workSessionId } },
      { tool: "ocw_board_card", args: { action: "move", columnId: board.columns.done } },
    ],
  });
  await cell.start();

  // The admin's build server: a service with the isolated-server mark and the device's own Full access opt-in. Its
  // turns wait (still "running") until the hold file exists.
  holdDir = mkdtempSync(join(tmpdir(), "ocw-e2e-hold-"));
  holdFile = join(holdDir, "release");
  deviceName = `Fleet server ${w}`;
  const listed = (await (await admin.get("/api/v1/devices")).json()) as {
    devices: Array<{ id: string; name: string }>;
  };
  for (const d of listed.devices.filter((x) => x.name === deviceName)) {
    await admin.delete(`/api/v1/devices/${d.id}`);
  }
  device = await startIsolatedServer(admin, {
    name: deviceName,
    projectName: `fleet-${w}`,
    env: { OCW_ALLOW_FULL_ACCESS: "1", OCW_RUNTIME_FAKE_HOLD_FILE: holdFile },
  });

  atlas = await freshTeamBot("Atlas");
  await waitBotReady(admin, atlas.id);
  await addBot(admin, board.id, atlas.id);
  await seedAtlasWorkZone(admin, device, atlas.id);
  erp = await registerFakeErp(admin, { name: CONNECTOR });
  await grantErp(admin, atlas.id, erp, ["list_records"]);
  await deleteAutomationsNamed(admin, name);
});

test.afterAll(async () => {
  await cell?.stop();
  if (admin) {
    await deleteAutomationsNamed(admin, name).catch(() => undefined);
    await removeConnector(admin, CONNECTOR).catch(() => undefined);
    for (const id of createdBots.splice(0)) await admin.delete(`/api/v1/agents/${id}`).catch(() => undefined);
    if (policyBefore) await setWorkZonePolicy(admin, policyBefore).catch(() => undefined);
  }
  await device?.stop();
  device = null;
  if (holdDir) rmSync(holdDir, { recursive: true, force: true });
  for (const p of [people?.cam, people?.dan, people?.eva]) await p?.api.dispose();
  await admin?.dispose();
});

// ---------------------------------------------------------------- the automation (AFO-01, AFO-02)

test("desktop: the owner creates the fan-out automation in the editor: every 10 minutes, #fleet's Backlog, a card per new order, @logistics", async ({
  browser,
}) => {
  test.skip(mobile, "the phone run creates it through the API (next test)");
  test.setTimeout(150_000);
  const s = await openAs(browser, ADMIN, "desktop");
  try {
    const sheet = await openAutomations(s.page, "?new=1");
    await sheet.getByTestId("automation-name-input").fill(name);
    await pick(s.page, sheet.getByTestId("automation-bot"), atlas.name);
    await sheet.getByTestId("automation-instructions").fill(INSTRUCTIONS);

    // When: every few minutes → every 10 minutes (07.17-04).
    await pick(s.page, sheet.getByTestId("schedule-repeat"), "Every few minutes");
    await pick(s.page, sheet.getByTestId("schedule-interval"), "Every 10 minutes");
    await sheet.getByTestId("schedule-zone").fill("Europe/Madrid");

    // Deliver to: the board, its first column.
    await sheet.getByTestId("target-kind-board").click();
    await pick(s.page, sheet.getByTestId("target-board"), board.name);
    await expect(sheet.getByTestId("target-column")).toHaveText(/Backlog/);

    // For each new item (07.17-14): on, with the column it opens cards in and the runs thread it lists runs in.
    const fanOut = sheet.getByTestId("automation-fan-out-section");
    await fanOut.scrollIntoViewIfNeeded();
    await expect(fanOut).toContainText("Open a conversation for each new item");
    await expect(fanOut).toContainText(
      "The bot opens a card in Backlog for every item it has not opened before",
    );
    await sheet.getByTestId("automation-fan-out").click();
    await expect(sheet.getByTestId("automation-fan-out")).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByTestId("automation-fan-out-per-run")).toHaveValue("10");
    await expect(sheet.getByTestId("automation-fan-out-per-day")).toHaveValue("100");
    await expect(sheet.getByTestId("automation-fan-out-runs-thread")).toHaveText(
      `Runs are listed in one “${name} · Runs” thread.`,
    );

    // When it needs people: Logistics, from the Teams group.
    const add = sheet.getByTestId("escalation-add");
    await add.scrollIntoViewIfNeeded();
    await add.fill("Log");
    const option = sheet
      .locator('[data-testid="escalation-option"][data-kind="unit"]')
      .filter({ hasText: TEAM });
    await expect(option).toBeVisible();
    await expect(option).toContainText(`@${TEAM_HANDLE}`);
    await option.click();
    const chip = sheet.getByTestId("escalation-chip").filter({ hasText: TEAM });
    await expect(chip).toHaveAttribute("data-kind", "unit");
    await expect(sheet.getByTestId("escalation-picker")).toContainText(
      `They get a notification only if they can read ${board.name}`,
    );
    // The first Escape closes the options (the sheet stays): the review shows the three sections as saved.
    await add.press("Escape");
    await expect(sheet).toBeVisible();
    await fanOut.scrollIntoViewIfNeeded();
    await checkScreen(s.page, "0717-editor", '[data-testid="automation-editor"]');
    await captureReview(s.page, `0717-editor-${w}`);

    await sheet.getByTestId("automation-submit").click();
    await expect(s.page.getByText(new RegExp(`Created “${name}”`))).toBeVisible({ timeout: 15_000 });
    const listed = (await (await admin.get("/api/v1/automations?scope=all")).json()) as {
      automations: Array<{
        id: string;
        name: string;
        fanOut?: { enabled: boolean } | null;
        escalation?: Array<{ kind: string; id: string }>;
      }>;
    };
    const saved = listed.automations.find((a) => a.name === name);
    expect(saved, "the saved automation").toBeTruthy();
    expect(saved?.fanOut).toMatchObject({ enabled: true, perRun: 10, perDay: 100 });
    expect(saved?.escalation).toEqual([expect.objectContaining({ kind: "unit", id: people.logistics.id })]);
    automationId = saved?.id ?? "";
  } finally {
    await s.context.close();
  }
});

test("phone: the same automation, created through the API, shows its fan-out and escalation in the editor at 390", async ({
  browser,
}) => {
  test.skip(!mobile, "the desktop run creates it in the editor (previous test)");
  test.setTimeout(150_000);
  const res = await admin.post("/api/v1/automations", {
    data: fanOutAutomationBody({
      name,
      agentId: atlas.id,
      board,
      logisticsId: people.logistics.id,
      instructions: INSTRUCTIONS,
    }),
  });
  expect(res.status(), `create ${name}: ${await res.text()}`).toBe(201);
  automationId = ((await res.json()) as { automation: { id: string } }).automation.id;
  const s = await openAs(browser, ADMIN, "mobile");
  try {
    const sheet = await openAutomations(s.page, `?edit=${automationId}`);
    await expect(sheet.getByTestId("automation-name-input")).toHaveValue(name);
    await expect(sheet.getByTestId("schedule-repeat")).toHaveText(/Every few minutes/);
    await expect(sheet.getByTestId("schedule-interval")).toHaveText(/Every 10 minutes/);
    const fanOut = sheet.getByTestId("automation-fan-out-section");
    await fanOut.scrollIntoViewIfNeeded();
    await expect(sheet.getByTestId("automation-fan-out")).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByTestId("automation-fan-out-runs-thread")).toHaveText(
      `Runs are listed in one “${name} · Runs” thread.`,
    );
    const chip = sheet.getByTestId("escalation-chip").filter({ hasText: TEAM });
    await chip.scrollIntoViewIfNeeded();
    await expect(chip).toHaveAttribute("data-kind", "unit");
    // 44 px: the switch row, the cap inputs' rows, the chip's remove button and the add field (PD-19).
    const remove = chip.getByRole("button", { name: `Remove ${TEAM}` });
    const box = await remove.boundingBox();
    expect(box?.height ?? 0, "the chip's remove button is 44 px tall").toBeGreaterThanOrEqual(43.5);
    await expectTouchTargets(s.page, '[data-testid="escalation-picker"]');
    await fanOut.scrollIntoViewIfNeeded();
    await checkScreen(s.page, "0717-editor", '[data-testid="automation-editor"]', [
      '[data-testid="automation-editor"]',
      '[data-testid="automation-fan-out-section"]',
    ]);
    await captureReview(s.page, `0717-editor-${w}`);
  } finally {
    await s.context.close();
  }
});

// ---------------------------------------------------------------- orders → cards, and dedupe (success criterion 1)

test("two new orders, Run now: two cards in Backlog and “Opened 2 conversations” in the runs thread; a second Run now opens nothing", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  expect(automationId, "the automation from the previous test").not.toBe("");
  await addOrders(ORDERS);

  // ---- Run now (the editor's button on desktop, the API on phones): one call opens a card per order
  const s = await openAs(browser, ADMIN, mobile ? "mobile" : "desktop");
  const { page } = s;
  try {
    if (!mobile) {
      const sheet = await openAutomations(page, `?edit=${automationId}`);
      await sheet.getByTestId("automation-run-now").click();
      await waitRunWhere((r) => r.trigger === "manual" && r.status === "answered", "Run now answered");
    } else {
      await runNowAnswered();
    }
    // A scheduled run may come first (every 10 minutes): together the runs opened the two orders, once each.
    await expect.poll(openedSoFar, { timeout: 30_000, message: "conversations opened" }).toBe(2);
    const first = cell.conversationOpenRequests.find((r) => r.status === 200);
    expect(first?.sent).toEqual({
      eventId: first?.eventId,
      agentId: atlas.id,
      items: ORDERS.map((id) => ({
        externalKey: id,
        title: `Order ${id}`,
        body: `Order ${id} from the ERP.`,
      })),
    });
    const cards = await cardsByTitle();
    expect([...cards.keys()].sort()).toEqual(ORDERS.map((id) => `Order ${id}`));
    for (const id of ORDERS) expect(cards.get(`Order ${id}`)?.columnId).toBe(board.columns.backlog);

    // ---- the board: both cards in Backlog (the item turns wait, so nothing has moved yet)
    const view = await openBoard(page, board.id);
    await showColumn(view, board.columns.backlog);
    const backlog = boardColumn(view, board.columns.backlog);
    for (const id of ORDERS) {
      await expect(cardTile(backlog, await cardOf(id))).toContainText(`Order ${id}`, { timeout: 15_000 });
    }
    await expect(view.getByTestId("board-card")).toHaveCount(2);
    await checkScreen(page, "0717-board", '[data-testid="board-view"]');
    await captureReview(page, `0717-board-${w}`);

    // ---- the "Fleet orders · Runs" thread holds the run card
    const opening = (await runsOf(admin, automationId)).find((r) => (r.opened ?? 0) === 2);
    expect(opening?.anchor, "the opening run's anchor").toBeTruthy();
    const runsRoot = opening?.anchor?.threadRootId as string;
    const panel = await openThread(page, runsRoot);
    await expect(messageRow(panel, runsRoot)).toContainText(`${name} · Runs`, { timeout: 15_000 });
    await expect(panel.getByTestId("agent-card").filter({ hasText: "Opened 2 conversations" })).toHaveCount(
      1,
      {
        timeout: 15_000,
      },
    );

    // ---- a second Run now: the same two orders are already open, so nothing new and still two cards
    const again = await runNowAnswered();
    expect(again.opened).toBe(0);
    expect(again.anchor?.threadRootId).toBe(runsRoot);
    const dedupe = cell.conversationOpenRequests.at(-1);
    expect(dedupe?.body?.results?.map((x: { opened: boolean }) => x.opened)).toEqual([false, false]);
    await expect(
      panel.getByTestId("agent-card").filter({ hasText: "Nothing new" }).first(),
      "the second run's card",
    ).toBeVisible({ timeout: 15_000 });
    await expect(botReply(panel, "Opened 0, existing 2")).toBeVisible({ timeout: 15_000 });
    expect((await cardsByTitle()).size).toBe(2);
    await checkScreen(page, "0717-runs", THREAD);
    await captureReview(page, `0717-runs-${w}`);
  } finally {
    await s.context.close();
  }
});

// ---------------------------------------------------------------- each card's Work Zone session (success criterion 2)

test("each card's turn moves it to In progress and starts its session; the turn finishes; the wake moves it to Done and says Done @logistics", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const roots = await Promise.all(ORDERS.map(cardOf));
  releaseItems();
  await cell.waitUntil(
    () => roots.every((root) => cell.itemTurns.some((t) => t.rootMessageId === root)),
    60_000,
  );
  for (const root of roots) {
    const turn = cell.itemTurns.find((t) => t.rootMessageId === root);
    expect(turn?.lines, JSON.stringify(turn)).toEqual([
      "Tool ocw_board_card: moved",
      `Tool ${START}: started fleet-${w} (fullAccess)`,
    ]);
  }
  const started = cell.workSessionRequests.filter((r) => r.tool === START && r.status === 200);
  const sessions = started.map((r) => String(r.body?.workSessionId));
  expect(sessions).toHaveLength(2);
  for (const id of ORDERS)
    expect((await cardsByTitle()).get(`Order ${id}`)?.columnId).toBe(board.columns.started);

  const s = await openAs(browser, ADMIN, mobile ? "mobile" : "desktop");
  const { page } = s;
  try {
    // ---- the board: both cards in In progress
    const view = await openBoard(page, board.id);
    await showColumn(view, board.columns.started);
    for (const root of roots) {
      await expect(cardTile(boardColumn(view, board.columns.started), root)).toBeVisible({ timeout: 15_000 });
    }
    await expectNoSeriousA11y(page, '[data-testid="board-view"]');
    await expectNoSidewaysScroll(page, `board in progress ${w}`);

    // ---- 1042's thread: the bot's answer and its live card, working (the daemon holds the turn)
    const panel = await openThread(page, roots[0] as string);
    await expect(panel.getByTestId("card-strip-column")).toContainText("In progress");
    await expect(
      botReply(panel, "Tool ocw_board_card: moved", `started fleet-${w} (fullAccess)`),
      "the item turn's answer",
    ).toBeVisible({ timeout: 20_000 });
    const live = panel.getByTestId("agent-card").filter({ has: page.locator("[data-live-session]") });
    await expect(live.getByTestId("wz-live-step")).toContainText("Working", { timeout: 30_000 });
    await expect(live.getByTestId("wz-live-device")).toContainText(deviceName);

    // ---- the runtime finishes both turns; each wake reads its session, moves its card to Done and mentions Logistics
    writeFileSync(holdFile, "release");
    await cell.waitUntil(
      () => sessions.every((id) => cell.workSessionWakes.some((x) => x.workSessionId === id && x.lines)),
      90_000,
    );
    for (const id of sessions) {
      const wake = cell.workSessionWakes.find((x) => x.workSessionId === id && x.lines);
      expect(wake?.transition).toBe("turn_done");
      expect(wake?.text).toBe(`Done: Mode: fullAccess @${TEAM_HANDLE}`);
      expect(wake?.lines).toEqual([
        `Tool ${READ}: read idle: Mode: fullAccess`,
        "Tool ocw_board_card: moved",
      ]);
      expect(
        cell.workSessionRequests.some(
          (r) => r.tool === READ && r.sent.workSessionId === id && r.status === 200,
        ),
        "the wake read the session before replying",
      ).toBe(true);
    }
    for (const id of ORDERS)
      expect((await cardsByTitle()).get(`Order ${id}`)?.columnId).toBe(board.columns.done);

    await expect(live.getByTestId("wz-live-step")).toContainText("Turn 1 done", { timeout: 60_000 });
    await expect(panel.getByTestId("card-strip-column")).toContainText("Done", { timeout: 15_000 });
    const done = botReply(panel, "Done: Mode: fullAccess", `@${TEAM_HANDLE}`);
    await expect(done).toBeVisible({ timeout: 30_000 });
    const unit = done.locator('[data-testid="mention"][data-mention-kind="unit"]');
    await expect(unit).toContainText(`@${TEAM_HANDLE}`);
    await expect(unit).toHaveAttribute("title", `${TEAM} · team`);
    await done.scrollIntoViewIfNeeded();
    await checkScreen(page, "0717-card-done", THREAD);
  } finally {
    await s.context.close();
  }
});

// ---------------------------------------------------------------- the team mention reaches Logistics only (criterion 3)

test("Cam (Logistics) gets “Atlas mentioned @logistics” in his Mentions; Eva, outside the team, gets nothing", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const roots = await Promise.all(ORDERS.map(cardOf));
  // Two "Done … @logistics" replies, one per card: a team_mention each for Cam, nothing for Eva.
  await expect
    .poll(
      async () =>
        (await boardMentions(people.cam.api)).items.filter(
          (n) => n.kind === "team_mention" && n.actor.id === atlas.id && n.unit?.handle === TEAM_HANDLE,
        ).length,
      { timeout: 30_000, message: "Cam's team mentions from Atlas" },
    )
    .toBe(2);
  const eva = await boardMentions(people.eva.api);
  expect(eva.items, "Eva is not in Logistics").toEqual([]);
  expect(eva.unreadCount).toBe(0);

  const cam = await openAs(browser, CAM, mobile ? "mobile" : "desktop");
  try {
    await cam.page.goto(`${BASE_URL}/chat/mentions`);
    const inbox = cam.page.getByTestId("inbox");
    await expect(inbox).toBeVisible({ timeout: 15_000 });
    // A retry of this spec's earlier tests adds rows of its own board: either proves it.
    const row = inbox.getByTestId("inbox-item").filter({ hasText: "Done: Mode: fullAccess" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("mentioned @logistics");
    await expect(row.getByTestId("inbox-actor")).toHaveText(atlas.name);
    await expectNoSeriousA11y(cam.page, '[data-testid="inbox"]');
    // It opens the card's thread (the permalink names the card as the thread root).
    const href = (await row.getAttribute("href")) ?? "";
    expect(href, href).toContain(`/chat/${board.id}`);
    expect(
      roots.some((root) => href.includes(root)),
      href,
    ).toBe(true);

    // His Mentions count rose (the views are in the navigation drawer on phones).
    if (mobile) await cam.page.getByTestId("mobile-nav-trigger").click();
    const views = cam.page.getByTestId(mobile ? "views-segmented" : "views-list").filter({ visible: true });
    await expect(views.getByTestId("view-mentions").getByTestId("view-count")).toHaveText(/^[1-9]\d*$/u, {
      timeout: 15_000,
    });
  } finally {
    await cam.context.close();
  }

  // Eva's badge never moved.
  const e = await openAs(browser, EVA, mobile ? "mobile" : "desktop");
  try {
    await e.page.goto(`${BASE_URL}/chat/mentions`);
    await expect(e.page.getByTestId("inbox")).toBeVisible({ timeout: 15_000 });
    await expect(e.page.getByTestId("inbox-item").filter({ hasText: "Done: Mode: fullAccess" })).toHaveCount(
      0,
    );
    if (mobile) await e.page.getByTestId("mobile-nav-trigger").click();
    const views = e.page.getByTestId(mobile ? "views-segmented" : "views-list").filter({ visible: true });
    await expect(views.getByTestId("view-mentions")).toBeVisible();
    await expect(views.getByTestId("view-mentions").getByTestId("view-count")).toHaveCount(0);
    await expectNoSidewaysScroll(e.page, `Eva's mentions ${w}`);
  } finally {
    await e.context.close();
  }
});

// ---------------------------------------------------------------- a person mentions the team (AFO-04, D-07, PD-14)

const BRAKES = "can someone check the brakes?";

test("Dan types @log in Order 1043's thread, picks Logistics from Teams and sends: the unit chip; Cam's count rises by one, Eva's does not", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const root43 = await cardOf("1043");
  const camBefore = (await boardMentions(people.cam.api)).unreadCount;
  const evaBefore = (await boardMentions(people.eva.api)).unreadCount;

  const dan = await openAs(browser, DAN, mobile ? "mobile" : "desktop");
  let messageId = "";
  try {
    const panel = await openThread(dan.page, root43);
    await expect(panel.getByTestId("card-strip")).toHaveAttribute("data-card-id", root43);
    const composer = dan.page.getByTestId("thread-composer");
    await composer.click();
    await composer.pressSequentially("@log");
    const suggestions = dan.page.getByTestId("mention-suggestions");
    await expect(suggestions).toBeVisible();
    await expect(suggestions).toContainText("Teams");
    const option = suggestions.locator(`[data-testid="mention-option-unit"][data-handle="${TEAM_HANDLE}"]`);
    await expect(option).toBeVisible();
    await expect(option).toContainText(TEAM);
    await expect(option).toContainText("@logistics");
    await expect(option).toContainText("Team · 2");
    await checkScreen(dan.page, "0717-composer-teams", THREAD, ['[data-testid="mention-suggestions"]']);
    await captureReview(dan.page, `0717-composer-teams-${w}`);
    await expect(suggestions).toBeVisible();
    await option.click();
    await expect(composer).toHaveValue("@logistics ");
    await composer.pressSequentially(BRAKES);
    await composer.press("Enter");
    // Two people are reached: below the 20 that ask first, so it sends at once.
    await expect(dan.page.getByTestId("team-mention-confirm")).toHaveCount(0);

    const sent = panel
      .locator('[data-testid="message"][data-author-kind="user"]')
      .filter({ hasText: BRAKES })
      .last();
    await expect(sent).toBeVisible({ timeout: 15_000 });
    messageId = (await sent.getAttribute("data-message-id")) ?? "";
    const chip = sent.locator('[data-testid="mention"][data-mention-kind="unit"]');
    await expect(chip).toContainText("@logistics");
    await expect(chip).toHaveAttribute("title", `${TEAM} · team`);
    // The card's thread as the team sees it: the bot's "Done … @logistics" above Dan's own mention.
    await expect(botReply(panel, "Done: Mode: fullAccess", "@logistics")).toBeVisible();
    await sent.scrollIntoViewIfNeeded();
    await checkScreen(dan.page, "0717-card-thread", THREAD);
    await captureReview(dan.page, `0717-card-thread-${w}`);
  } finally {
    await dan.context.close();
  }

  // Cam (Logistics, reads #fleet): one more unread, a team_mention naming Logistics. Eva: nothing at all.
  await expect
    .poll(async () => (await boardMentions(people.cam.api)).unreadCount, {
      timeout: 15_000,
      message: "Cam's unread count",
    })
    .toBe(camBefore + 1);
  const camItem = (await boardMentions(people.cam.api)).items.find((n) => n.messageId === messageId);
  expect(camItem).toMatchObject({ kind: "team_mention", unit: { handle: TEAM_HANDLE } });
  const eva = await boardMentions(people.eva.api);
  expect(eva.unreadCount).toBe(evaBefore);
  expect(eva.items.some((n) => n.messageId === messageId)).toBe(false);
  // Dan wrote it: a team mention never notifies its own author.
  expect((await boardMentions(people.dan.api)).items.some((n) => n.messageId === messageId)).toBe(false);
});

test("Cam's inbox reads “Dan mentioned @logistics” and opens Order 1043's thread on the message", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const root43 = await cardOf("1043");
  const cam = await openAs(browser, CAM, mobile ? "mobile" : "desktop");
  try {
    await cam.page.goto(`${BASE_URL}/chat/mentions`);
    const inbox = cam.page.getByTestId("inbox");
    await expect(inbox).toBeVisible({ timeout: 15_000 });
    // A retry adds a second row (the earlier attempt's message, on its own board): the newest is this attempt's.
    const row = inbox.getByTestId("inbox-item").filter({ hasText: BRAKES }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("mentioned @logistics");
    await expect(row.getByTestId("inbox-actor")).toHaveText(DAN.name);
    await expect(row.getByTestId("inbox-snippet").getByTestId("mention")).toContainText("@logistics");
    await expect(
      inbox.getByTestId("inbox-item").filter({ hasText: "Done: Mode: fullAccess" }).first(),
    ).toContainText("mentioned @logistics");
    await checkScreen(cam.page, "0717-inbox", '[data-testid="inbox"]');
    await captureReview(cam.page, `0717-inbox-${w}`);
    await row.click();
    await expect(cam.page).toHaveURL(new RegExp(`/chat/${board.id}\\?thread=${root43}&m=`), {
      timeout: 15_000,
    });
    const panel = cam.page.locator(THREAD);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId("card-strip")).toHaveAttribute("data-card-id", root43);
    const target = panel.locator('[data-testid="message"]').filter({ hasText: BRAKES }).last();
    await expect(target).toHaveAttribute("data-highlighted", "true");
  } finally {
    await cam.context.close();
  }
});

// ---------------------------------------------------------------- dedupe holds (D-03)

test("a third Run now opens nothing: the board keeps its two cards; the runs list one “Opened 2 conversations” and the rest “Nothing new”", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const third = await runNowAnswered();
  expect(third.opened).toBe(0);
  const cards = await cardsByTitle();
  expect([...cards.keys()].sort()).toEqual(ORDERS.map((id) => `Order ${id}`));
  for (const id of ORDERS) expect(cards.get(`Order ${id}`)?.columnId).toBe(board.columns.done);

  // Every 10 minutes a scheduled run may add one more "Nothing new": count from the runs, never a fixed number.
  const runs = (await runsOf(admin, automationId)).filter((r) => r.status === "answered");
  expect(runs.filter((r) => r.opened === 2)).toHaveLength(1);
  const nothing = runs.filter((r) => r.opened === 0);
  expect(nothing.length).toBeGreaterThanOrEqual(2);
  const runsRoot = third.anchor?.threadRootId as string;
  expect(new Set(runs.map((r) => r.anchor?.threadRootId))).toEqual(new Set([runsRoot]));

  const s = await openAs(browser, ADMIN, mobile ? "mobile" : "desktop");
  try {
    const panel = await openThread(s.page, runsRoot);
    const cardsIn = panel.getByTestId("agent-card");
    await expect(cardsIn.filter({ hasText: "Opened 2 conversations" })).toHaveCount(1, { timeout: 15_000 });
    await expect
      .poll(async () => cardsIn.filter({ hasText: "Nothing new" }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(nothing.length);

    // The editor's Runs tab says the same per run (07.17-14's chip).
    const sheet = await openAutomations(s.page, `?edit=${automationId}`);
    await sheet.getByTestId("automation-tab-runs").click();
    const chips = sheet.getByTestId("run-opened");
    await expect(chips.filter({ hasText: "Opened 2 conversations" })).toHaveCount(1, { timeout: 15_000 });
    await expect
      .poll(async () => chips.filter({ hasText: "Nothing new" }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
  } finally {
    await s.context.close();
  }
});
