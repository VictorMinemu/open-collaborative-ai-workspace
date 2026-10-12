import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import {
  apiCard,
  boardColumn,
  boardSnapshot,
  cardTile,
  columnId,
  columnOrder,
  createBoardChannel,
  createCard,
  openBoard,
} from "../support/board";
import { ALEX } from "../support/chat";
import { bothThemes } from "../support/files";
import { ADMIN } from "./env";

/**
 * Board channels in the browser (07.1-08, BOARD-01 … BOARD-03, D-04, P-05, P-12): create a board from the dialog, add
 * cards, move them by keyboard, pointer, menu and touch, open their threads, and the board's states, gating and
 * accessibility at 1440 and 390, light and dark.
 */

test.describe.configure({ mode: "serial" });

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function newUnit(admin: APIRequestContext, name: string): Promise<string> {
  const res = await admin.post("/api/v1/units", { data: { kind: "department", name, parentId: null } });
  expect(res.ok(), `create unit ${name}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function signedIn(browser: Browser, project: string): Promise<Page> {
  const { page } = await openAs(browser, ADMIN, project);
  return page;
}

/** Waits until the API has the card in `col` (the PATCH of a drop or menu move landed). */
async function expectCardIn(api: APIRequestContext, convId: string, messageId: string, col: string) {
  await expect.poll(async () => (await apiCard(api, convId, messageId)).columnId).toBe(col);
}

test("tracer: Víctor creates #cases as a board, adds a card, moves it with the keyboard, reloads and opens its thread", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the keyboard tracer runs at 1440");
  test.setTimeout(120_000);
  const admin = await apiAs(ADMIN);
  const unitName = `Ops ${tag()}`;
  const unitId = await newUnit(admin, unitName);
  const page = await signedIn(browser, "desktop");

  // ---- the dialog: Name → Topic → Belongs to → Layout → Visibility; Board
  await page.getByTestId("create-channel").filter({ visible: true }).first().click();
  const dialog = page.getByTestId("create-channel-dialog");
  await expect(dialog).toBeVisible();
  const fields = await dialog
    .locator("form label[for], form legend")
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
  expect(fields.map((f) => f.split(" (")[0])).toEqual([
    "Name",
    "Topic",
    "Belongs to",
    "Layout",
    "Visibility",
  ]);
  await expect(dialog.getByTestId("layout-text")).toBeChecked();
  const name = `cases-${tag()}`;
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByTestId("channel-unit-select").click();
  await page.getByRole("option", { name: unitName }).click();
  await dialog.locator("label", { has: page.getByTestId("layout-board") }).click();
  await expect(dialog.getByTestId("layout-board")).toBeChecked();
  await dialog.getByTestId("create-channel-submit").click();

  // ---- lands on the board: toolbar (Board selected, New card), four 272 px lanes, the board glyph in the sidebar
  await expect(page.getByTestId("channel-title")).toHaveText(name);
  const convId = page.url().match(/\/chat\/([0-9a-f-]{36})/)?.[1] ?? "";
  expect(convId).toBeTruthy();
  const toolbar = page.getByTestId("board-toolbar");
  await expect(toolbar.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
  await expect(toolbar.getByRole("tablist", { name: "Channel view" })).toBeVisible();
  await expect(toolbar.getByTestId("new-card-button")).toBeVisible();
  const board = page.getByTestId("board-view");
  await expect(board.getByTestId("board-column")).toHaveCount(4);
  for (const box of await board
    .getByTestId("board-column")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))) {
    expect(box).toBe(272);
  }
  await expect(
    page.locator(
      `[data-testid="sidebar-section"][data-unit-id="${unitId}"] [data-testid="channel-link"][data-channel-name="${name}"] [data-layout="board"]`,
    ),
  ).toBeVisible();

  const backlog = await columnId(admin, convId, "Backlog");
  const progress = await columnId(admin, convId, "In progress");

  // ---- New card: lands at the bottom of Backlog
  await toolbar.getByTestId("new-card-button").click();
  const newCard = page.getByTestId("new-card");
  await expect(newCard).toBeVisible();
  await expect(newCard.getByLabel(/Title/)).toHaveAttribute("placeholder", "First line of the description");
  await newCard.getByLabel("Description").fill("Broken pump\nPump 3 leaks");
  await newCard.getByTestId("new-card-submit").click();
  await expect(newCard).toBeHidden();
  const tile = board.getByTestId("board-card").filter({ hasText: "Broken pump" });
  await expect(tile).toHaveCount(1);
  const cardId = (await tile.getAttribute("data-card-id")) ?? "";
  expect((await columnOrder(board, backlog)).at(-1)).toBe(cardId);

  // ---- keyboard: grip, Space, ArrowRight, Space → In progress, announced by dnd-kit's live region
  const grip = tile.locator('[data-slot="card-grip-button"]');
  await expect(grip).toHaveAttribute("aria-label", "Move card Broken pump");
  await expect(grip).toHaveAttribute("aria-roledescription", "draggable card");
  await grip.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(boardColumn(board, progress).locator(`[data-card-id="${cardId}"]`)).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect(page.locator("#dnd-kit-announcement-board")).toHaveText(
    "“Broken pump” dropped in In progress, position 1 of 1.",
  );
  await expectCardIn(admin, convId, cardId, progress);

  // ---- reload: still in In progress
  await page.reload();
  await expect(boardColumn(page, progress).locator(`[data-card-id="${cardId}"]`)).toBeVisible();

  // A few more cards so the board reads like real work (screenshots).
  const done = await columnId(admin, convId, "Done");
  await createCard(admin, convId, {
    description: "Leaking seal on line 2\nSeal kit ordered",
    waitingOn: "customer",
  });
  await createCard(admin, convId, { description: "Quote for spare filters", waitingOn: "us" });
  await createCard(admin, convId, {
    description: "Valve replacement at the Acme plant, line 3 and the backup valve on the cooling loop",
    columnId: progress,
    waitingOn: "both",
  });
  await createCard(admin, convId, { description: "Filter swap", columnId: done });
  await page.reload();
  await openBoard(page, convId);
  await expect(board.getByTestId("board-card")).toHaveCount(5);
  await bothThemes(page, "board-1440");

  // ---- clicking the tile opens its thread; the tile is current; a reply counts; closing returns focus
  const open = cardTile(page, cardId).locator('[data-slot="card-open"]');
  await open.click();
  const panel = page.getByTestId("thread-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Pump 3 leaks")).toBeVisible();
  await expect(open).toHaveAttribute("aria-current", "true");
  const composer = page.getByTestId("thread-composer");
  await composer.click();
  await composer.fill("On it");
  await composer.press("Enter");
  await expect(cardTile(page, cardId).getByTestId("card-replies")).toHaveText("1");
  await bothThemes(page, "board-thread-1440");
  await panel.getByTestId("close-thread").click();
  await expect(panel).toBeHidden();
  await expect(open).toBeFocused();
  await expect(open).not.toHaveAttribute("aria-current", "true");

  const snap = await boardSnapshot(admin, convId);
  expect(snap.cards.find((c) => c.columnId === progress)?.cards.map((c) => c.messageId)).toContain(cardId);
});

// ---------------------------------------------------------------- Task 2: every way to move a card

/** Card menu → submenu item (Move to… / Waiting on…) → radio item. */
async function menuPick(page: Page, tile: Locator, submenu: "Move to…" | "Waiting on…", item: string) {
  await tile.getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: submenu }).click();
  await page.getByRole("menuitemradio", { name: item, exact: true }).click();
  await expect(page.getByTestId("card-menu-content")).toHaveCount(0);
}

async function menuItem(page: Page, tile: Locator, item: "Move to top" | "Move to bottom") {
  await tile.getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: item }).click();
  await expect(page.getByTestId("card-menu-content")).toHaveCount(0);
}

/** A mouse drag from the middle of `from` (the title area, away from the menu) to `to`, in small steps. */
async function pointerDrag(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = await from.boundingBox();
  if (!box) throw new Error("no source box");
  // A previous drop animates for 250 ms; a press during it is ignored by dnd-kit.
  await page.waitForTimeout(400);
  const sx = box.x + box.width * 0.4;
  const sy = box.y + box.height * 0.5;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 4, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 24 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

async function centerOf(l: Locator): Promise<{ x: number; y: number; top: number; bottom: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.y, bottom: b.y + b.height };
}

test("desktop: pointer drag across and within lanes, Escape cancels, card menu moves and waiting state, lane +", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "pointer drag and lanes are the 1440 layout");
  test.setTimeout(150_000);
  const admin = await apiAs(ADMIN);
  const { id: convId } = await createBoardChannel(admin, { prefix: "moves" });
  const backlog = await columnId(admin, convId, "Backlog");
  const progress = await columnId(admin, convId, "In progress");
  const done = await columnId(admin, convId, "Done");
  const cancelled = await columnId(admin, convId, "Cancelled");
  const a = await createCard(admin, convId, { title: "Alpha order", columnId: done });
  const b = await createCard(admin, convId, { title: "Bravo order", columnId: done });
  const c = await createCard(admin, convId, { title: "Charlie order", description: "Needs a quote" });
  const d = await createCard(admin, convId, { title: "Delta order" });
  const e = await createCard(admin, convId, { title: "Echo order" });
  const page = await signedIn(browser, "desktop");
  const board = await openBoard(page, convId);
  const patches: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes(`/boards/${convId}/cards/`)) patches.push(r.url());
  });

  // ---- C from Backlog to between A and B in Done
  const bBox = await centerOf(cardTile(board, b.messageId));
  await pointerDrag(page, cardTile(board, c.messageId).locator('[data-slot="card-open"]'), {
    x: bBox.x,
    y: bBox.top + 8,
  });
  await expect.poll(() => columnOrder(board, done)).toEqual([a.messageId, c.messageId, b.messageId]);
  await expectCardIn(admin, convId, c.messageId, done);
  await page.reload();
  await openBoard(page, convId);
  expect(await columnOrder(board, done)).toEqual([a.messageId, c.messageId, b.messageId]);

  // ---- within Backlog: E above D
  const dBox = await centerOf(cardTile(board, d.messageId));
  await pointerDrag(page, cardTile(board, e.messageId).locator('[data-slot="card-open"]'), {
    x: dBox.x,
    y: dBox.top + 8,
  });
  await expect.poll(() => columnOrder(board, backlog)).toEqual([e.messageId, d.messageId]);
  await expect
    .poll(async () =>
      (await boardSnapshot(admin, convId)).cards
        .find((x) => x.columnId === backlog)
        ?.cards.map((x) => x.messageId),
    )
    .toEqual([e.messageId, d.messageId]);

  // ---- Escape during a drag: back where it was, no request
  const sent = patches.length;
  const dTile = cardTile(board, d.messageId).locator('[data-slot="card-open"]');
  const start = await centerOf(dTile);
  const pBox = await centerOf(boardColumn(board, progress));
  await page.waitForTimeout(400);
  await page.mouse.move(start.x - 40, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 20, start.y + 6, { steps: 4 });
  await page.mouse.move(pBox.x, pBox.y, { steps: 16 });
  await expect(page.locator("#dnd-kit-announcement-board")).toContainText("Delta order");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => columnOrder(board, backlog)).toEqual([e.messageId, d.messageId]);
  await page.waitForTimeout(400);
  expect(patches.length).toBe(sent);
  await expect(page.locator("#dnd-kit-announcement-board")).toHaveText(
    "Move cancelled. “Delta order” is back in Backlog.",
  );

  // ---- menu: Move to… Cancelled (bottom), announced; focus stays on the moved card's menu trigger
  const live = board.getByTestId("board-live");
  await menuPick(page, cardTile(board, e.messageId), "Move to…", "Cancelled");
  await expect.poll(() => columnOrder(board, cancelled)).toEqual([e.messageId]);
  await expect(live).toContainText("Moved “Echo order” to Cancelled.");
  await expect(cardTile(board, e.messageId).getByTestId("card-menu")).toBeFocused();
  await expectCardIn(admin, convId, e.messageId, cancelled);

  // ---- Move to top / Move to bottom in Done (A, C, B)
  await menuItem(page, cardTile(board, b.messageId), "Move to top");
  await expect.poll(() => columnOrder(board, done)).toEqual([b.messageId, a.messageId, c.messageId]);
  await expect(live).toContainText("Moved “Bravo order” to the top of Done.");
  await menuItem(page, cardTile(board, a.messageId), "Move to bottom");
  await expect.poll(() => columnOrder(board, done)).toEqual([b.messageId, c.messageId, a.messageId]);
  await expect(live).toContainText("Moved “Alpha order” to the bottom of Done.");
  await expect
    .poll(async () =>
      (await boardSnapshot(admin, convId)).cards
        .find((x) => x.columnId === done)
        ?.cards.map((x) => x.messageId),
    )
    .toEqual([b.messageId, c.messageId, a.messageId]);

  // ---- Waiting on… Customer, then Nobody
  const cTile = cardTile(board, c.messageId);
  await menuPick(page, cTile, "Waiting on…", "Customer");
  await expect(cTile.getByTestId("waiting-on-badge")).toHaveText("Waiting on customer");
  await expect(live).toContainText("“Charlie order” is now waiting on the customer.");
  await expect.poll(async () => (await apiCard(admin, convId, c.messageId)).waitingOn).toBe("customer");

  // Screenshot: the menu open with its Move to… submenu.
  await cardTile(board, c.messageId).getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Cancelled" })).toBeVisible();
  await bothThemes(page, "board-menu-1440");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("card-menu-content")).toHaveCount(0);

  await menuPick(page, cTile, "Waiting on…", "Nobody");
  await expect(cTile.getByTestId("waiting-on-badge")).toHaveCount(0);
  await expect.poll(async () => (await apiCard(admin, convId, c.messageId)).waitingOn).toBe("none");

  // ---- a lane's + opens New card in that lane; the card lands at its bottom
  await board.getByRole("button", { name: "Add card to In progress" }).click();
  const dialog = page.getByTestId("new-card");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-card-column")).toHaveText(/In progress/);
  await dialog.getByLabel("Description").fill("Call the supplier about the gasket\nThey promised Friday");
  await bothThemes(page, "board-new-card-1440");
  await dialog.getByTestId("new-card-submit").click();
  await expect(dialog).toBeHidden();
  const added = board.getByTestId("board-card").filter({ hasText: "Call the supplier" });
  await expect(added).toHaveCount(1);
  expect((await columnOrder(board, progress)).at(-1)).toBe(await added.getAttribute("data-card-id"));
});

test.describe("390", () => {
  test.use({ hasTouch: true });

  test("mobile: column tabs, long-press reorder by touch, menu moves, thread full screen and back, New card", async ({
    browser,
  }, info) => {
    test.skip(info.project.name !== "mobile", "the 390 layout");
    test.setTimeout(150_000);
    const admin = await apiAs(ADMIN);
    const { id: convId } = await createBoardChannel(admin, { prefix: "phone" });
    const backlog = await columnId(admin, convId, "Backlog");
    const progress = await columnId(admin, convId, "In progress");
    const a = await createCard(admin, convId, { title: "Pump inspection", waitingOn: "customer" });
    const b = await createCard(admin, convId, { title: "Seal kit order", description: "Two kits" });
    const c = await createCard(admin, convId, { title: "Filter quote", waitingOn: "us" });
    const page = await signedIn(browser, "mobile");
    const board = await openBoard(page, convId);

    // ---- underline tabs with counts, one column visible, no horizontal page scroll
    const tabs = board.getByTestId("board-tabs");
    await expect(tabs.getByRole("tab", { name: "Backlog, 3 cards" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tabs.getByRole("tab", { name: "In progress, 0 cards" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Backlog, 3 cards" })).toContainText("Backlog3");
    expect(await columnOrder(board, backlog)).toEqual([a.messageId, b.messageId, c.messageId]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await bothThemes(page, "board-390");

    await tabs.getByRole("tab", { name: "In progress, 0 cards" }).click();
    await expect(page).toHaveURL(new RegExp(`col=${progress}`));
    await expect(board.getByText("No cards")).toBeVisible();
    await tabs.getByRole("tab", { name: "Backlog, 3 cards" }).click();
    await expect(page).toHaveURL(new RegExp(`col=${backlog}`));

    // ---- long-press reorder: B held 300 ms, moved below C in small steps, released
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const bAt = await centerOf(cardTile(board, b.messageId));
    const cAt = await centerOf(cardTile(board, c.messageId));
    const x = bAt.x - 60;
    await touch("touchStart", x, bAt.y);
    await page.waitForTimeout(300);
    const target = cAt.y + 12;
    for (let i = 1; i <= 20; i++) {
      await touch("touchMove", x, bAt.y + ((target - bAt.y) * i) / 20);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(150);
    await touch("touchEnd");
    await expect.poll(() => columnOrder(board, backlog)).toEqual([a.messageId, c.messageId, b.messageId]);
    await expect
      .poll(async () =>
        (await boardSnapshot(admin, convId)).cards
          .find((k) => k.columnId === backlog)
          ?.cards.map((k) => k.messageId),
      )
      .toEqual([a.messageId, c.messageId, b.messageId]);
    await page.reload();
    await openBoard(page, convId);
    expect(await columnOrder(board, backlog)).toEqual([a.messageId, c.messageId, b.messageId]);

    // ---- a quick tap still opens the thread, full screen; closing returns to the same tab, focus on the card
    await tabs.getByRole("tab", { name: "In progress, 0 cards" }).click();
    await tabs.getByRole("tab", { name: "Backlog, 3 cards" }).click();
    await expect(page).toHaveURL(new RegExp(`col=${backlog}`));
    await cardTile(board, a.messageId).locator('[data-slot="card-open"]').tap();
    const panel = page.getByTestId("thread-panel");
    await expect(panel).toBeVisible();
    const pb = await panel.boundingBox();
    expect(pb?.width).toBeGreaterThanOrEqual(388);
    await bothThemes(page, "board-thread-390");
    await panel.getByTestId("close-thread").click();
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`col=${backlog}`));
    await expect(cardTile(board, a.messageId).locator('[data-slot="card-open"]')).toBeFocused();

    // ---- menu: Move to… In progress (the tab count follows); Move to top
    await menuPick(page, cardTile(board, b.messageId), "Move to…", "In progress");
    await expect(tabs.getByRole("tab", { name: "In progress, 1 card" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Backlog, 2 cards" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Backlog, 2 cards" })).toBeFocused();
    await expectCardIn(admin, convId, b.messageId, progress);
    await menuItem(page, cardTile(board, c.messageId), "Move to top");
    await expect.poll(() => columnOrder(board, backlog)).toEqual([c.messageId, a.messageId]);

    // Screenshot: the card menu with its Move to… submenu at 390.
    await cardTile(board, a.messageId).getByTestId("card-menu").click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Done" })).toBeVisible();
    await bothThemes(page, "board-menu-390");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // ---- New card, full screen
    await page.getByTestId("new-card-button").click();
    const dialog = page.getByTestId("new-card");
    await expect(dialog).toBeVisible();
    const db = await dialog.boundingBox();
    expect(db?.width).toBeGreaterThanOrEqual(388);
    expect(db?.height).toBeGreaterThanOrEqual(800);
    await dialog.getByLabel("Description").fill("Replace the gauge on tank 4");
    await bothThemes(page, "board-new-card-390");
    await dialog.getByTestId("new-card-submit").click();
    await expect(dialog).toBeHidden();
    await expect(board.getByTestId("board-card").filter({ hasText: "Replace the gauge" })).toBeVisible();
  });
});

// ---------------------------------------------------------------- Task 3: states, gating, accessibility

const boardUrl = (convId: string) => new RegExp(`/api/v1/boards/${convId}$`);
const cardPatch = (convId: string) => new RegExp(`/api/v1/boards/${convId}/cards/[0-9a-f-]{36}$`);

test("desktop: loading, load error, empty board, Show more cards, rollback and conflict, axe in both themes", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the 1440 states");
  test.setTimeout(240_000);
  const admin = await apiAs(ADMIN);
  const page = await signedIn(browser, "desktop");

  // ---- loading: four lane skeletons while the snapshot is held
  const { id: convId, name } = await createBoardChannel(admin, { prefix: "states" });
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(boardUrl(convId), async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${BASE_URL}/chat/${convId}`);
  const board = page.getByTestId("board-view");
  await expect(board.getByTestId("board-lane-skeleton")).toHaveCount(4);
  await expect(board.getByText("Loading board")).toHaveCount(1);
  await bothThemes(page, "board-loading-1440");
  release();

  // ---- empty board: No cards yet in the default column, with New card
  await expect(board.getByText("No cards yet")).toBeVisible();
  await page.unroute(boardUrl(convId));
  await expect(
    board.getByText("Add one for each case, order or ticket. @mention a bot in a card to get it working."),
  ).toBeVisible();
  await expect(board.getByRole("button", { name: "New card" })).toBeVisible();
  await expect(board.getByText("No cards", { exact: true })).toHaveCount(3);

  // ---- load error, then Try again recovers
  await page.route(boardUrl(convId), (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: "internal_error", message: "The board service is unavailable" } },
    }),
  );
  await page.reload();
  await expect(board.getByText("Couldn't load this board")).toBeVisible({ timeout: 15_000 });
  await expect(board.getByText("The board service is unavailable")).toBeVisible();
  await page.unroute(boardUrl(convId));
  await board.getByRole("button", { name: "Try again" }).click();
  await expect(board.getByText("No cards yet")).toBeVisible();

  // ---- more than 100 cards in a lane: 100+ and Show more cards
  const { id: bigId } = await createBoardChannel(admin, { prefix: "big" });
  for (let i = 0; i < 101; i += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, 101 - i) }, (_, k) =>
        createCard(admin, bigId, { title: `Order ${String(i + k + 1).padStart(3, "0")}` }),
      ),
    );
  }
  const big = await openBoard(page, bigId);
  const bigBacklog = await columnId(admin, bigId, "Backlog");
  const lane = boardColumn(big, bigBacklog);
  await expect(lane.locator('[data-slot="column-count"]')).toHaveText("100+");
  await expect(lane.getByTestId("board-card")).toHaveCount(100);
  await lane.getByTestId("show-more-cards").click();
  await expect(lane.getByTestId("board-card")).toHaveCount(101);
  await expect(lane.locator('[data-slot="column-count"]')).toHaveText("101");
  await expect(lane.getByTestId("show-more-cards")).toHaveCount(0);

  // ---- rollback: a 500 on the PATCH snaps the card back, toasts and announces
  const backlog = await columnId(admin, convId, "Backlog");
  const progress = await columnId(admin, convId, "In progress");
  const pump = await createCard(admin, convId, { title: "Broken pump" });
  const valve = await createCard(admin, convId, { title: "Valve replacement", waitingOn: "customer" });
  await createCard(admin, convId, { title: "Quote for spares", columnId: progress, waitingOn: "both" });
  await openBoard(page, convId);
  const live = board.getByTestId("board-live");
  await page.route(cardPatch(convId), (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: "internal_error", message: "Database unavailable" } },
    }),
  );
  await menuPick(page, cardTile(board, pump.messageId), "Move to…", "In progress");
  await expect(page.getByText("Couldn't move “Broken pump”. It's back in Backlog.")).toBeVisible();
  await expect(live).toContainText("“Broken pump” couldn't be moved and is back in Backlog.");
  await expect.poll(() => columnOrder(board, backlog)).toEqual([pump.messageId, valve.messageId]);
  await page.unroute(cardPatch(convId));

  // ---- conflict: someone else changed the card; the 409 carries the current card, which the board applies
  const changed = await admin.patch(`/api/v1/boards/${convId}/cards/${valve.messageId}`, {
    data: { expectedVersion: valve.version, waitingOn: "us" },
  });
  expect(changed.ok()).toBe(true);
  const current = await apiCard(admin, convId, valve.messageId);
  await expect(cardTile(board, valve.messageId).getByTestId("waiting-on-badge")).toHaveText("Waiting on us");
  await page.route(cardPatch(convId), (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "board_card_version_conflict",
          message: "This card changed",
          details: { card: current },
        },
      },
    }),
  );
  await menuPick(page, cardTile(board, valve.messageId), "Move to…", "Done");
  await expect(page.getByText("Someone else changed this card. Showing the latest.")).toBeVisible();
  await expect(live).toContainText("Someone else changed “Valve replacement”. Showing the latest.");
  await expect.poll(() => columnOrder(board, backlog)).toEqual([pump.messageId, valve.messageId]);
  await expect(cardTile(board, valve.messageId).getByTestId("waiting-on-badge")).toHaveText("Waiting on us");
  await page.unroute(cardPatch(convId));

  // ---- axe: the board, the open card menu with its Move to… submenu, the create-channel dialog with Board
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 15_000 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoSeriousA11y(page, '[data-testid="board-view"]');
    await cardTile(board, pump.messageId).getByTestId("card-menu").click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Cancelled" })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "Backlog" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expectNoSeriousA11y(page, '[role="menu"]');
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("card-menu-content")).toHaveCount(0);
    await page.getByTestId("create-channel").filter({ visible: true }).first().click();
    const dialog = page.getByTestId("create-channel-dialog");
    await dialog.locator("label", { has: page.getByTestId("layout-board") }).click();
    await expectNoSeriousA11y(page, '[data-testid="create-channel-dialog"]');
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
  await page.emulateMedia({ colorScheme: "light" });
  expect(name).toBeTruthy();
});

test("gating: a non-member previews a public board read-only; an archived board is read-only for everyone", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  const { id: convId, name } = await createBoardChannel(admin, { prefix: "preview" });
  const card = await createCard(admin, convId, {
    title: "Pump inspection",
    description: "Line 3",
    waitingOn: "us",
  });
  const { page } = await openAs(browser, ALEX, project);
  const board = await openBoard(page, convId);

  const tile = cardTile(board, card.messageId);
  await expect(tile).toBeVisible();
  await expect(board.locator('[data-slot="card-grip-button"]')).toHaveCount(0);
  await expect(board.getByRole("button", { name: /^Add card to/ })).toHaveCount(0);
  await expect(page.getByTestId("new-card-button")).toHaveCount(0);
  await tile.getByTestId("card-menu").click();
  await expect(page.getByTestId("card-menu-content").getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Open thread" })).toBeVisible();
  await page.keyboard.press("Escape");
  const banner = page.getByTestId("join-banner");
  await expect(banner).toContainText(`You're previewing #${name}`);
  await expect(banner).toContainText("Join to add cards, move them and reply in their threads.");
  await expect(banner.getByRole("button", { name: "Join channel" })).toBeVisible();
  await tile.locator('[data-slot="card-open"]').click();
  await expect(page.getByTestId("thread-panel")).toBeVisible();
  await expect(page.getByTestId("thread-panel").getByText("Line 3")).toBeVisible();
  await page.getByTestId("close-thread").click();
  await expectNoSeriousA11y(page, '[data-testid="board-view"]');

  // ---- archived: read-only for everyone, archived banner with the board copy
  const archived = await admin.post(`/api/v1/channels/${convId}/archive`, { data: {} });
  expect(archived.ok(), `archive: ${archived.status()}`).toBe(true);
  const { page: own } = await openAs(browser, ADMIN, project);
  for (const p of [own, page]) {
    const b = await openBoard(p, convId);
    await expect(p.getByTestId("archived-banner")).toContainText(
      new RegExp(`#${name} was archived on .+\\. Its cards stay readable\\.`),
    );
    await expect(b.locator('[data-slot="card-grip-button"]')).toHaveCount(0);
    await expect(b.getByRole("button", { name: /^Add card to/ })).toHaveCount(0);
    await expect(p.getByTestId("new-card-button")).toHaveCount(0);
    await expect(cardTile(b, card.messageId)).toBeVisible();
  }
});

test("390: axe in both themes and every board control at least 44 × 44", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile", "the 390 hit areas");
  test.setTimeout(120_000);
  const admin = await apiAs(ADMIN);
  const { id: convId } = await createBoardChannel(admin, { prefix: "touch" });
  await createCard(admin, convId, { title: "Pump inspection", waitingOn: "customer" });
  await createCard(admin, convId, { title: "Seal kit order", waitingOn: "both" });
  const page = await signedIn(browser, "mobile");
  const board = await openBoard(page, convId);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoSeriousA11y(page, '[data-testid="board-view"]');
  }
  await page.emulateMedia({ colorScheme: "light" });
  const controls = page.locator(
    '[data-testid="board-view"] button, [data-testid="board-view"] [role="tab"], [data-testid="new-card-button"]',
  );
  const boxes = await controls.evaluateAll((els) =>
    els
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { name: e.getAttribute("aria-label") ?? e.textContent?.trim() ?? "", w: r.width, h: r.height };
      })
      .filter((b) => b.w > 0 && b.h > 0),
  );
  expect(boxes.length).toBeGreaterThan(6);
  for (const b of boxes) {
    expect(b.w, `${b.name} width`).toBeGreaterThanOrEqual(44);
    expect(b.h, `${b.name} height`).toBeGreaterThanOrEqual(44);
  }
  // Same check through Playwright's boundingBox on the first card's menu trigger and the toolbar CTA.
  for (const l of [board.getByTestId("card-menu").first(), page.getByTestId("new-card-button")]) {
    const box = await l.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});
