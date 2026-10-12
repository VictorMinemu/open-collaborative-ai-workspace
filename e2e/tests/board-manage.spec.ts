import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, ensureMember, openAs } from "../support/actors";
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
import { ALEX, messageRow, openMessageActions, postAs } from "../support/chat";
import { bothThemes } from "../support/files";
import { ADMIN } from "./env";

/**
 * Board management in the browser (07.1-11; BOARD-01, BOARD-02, BOARD-05, BOARD-06; D-07, D-08, P-02, P-09): column
 * settings from the board for the channel's owner or an admin, live for every viewer; the card strip at the top of a
 * card's thread; card text edits by the card's author (typed titles kept, search follows); Delete card for the author
 * or a moderator. 1440 and 390, light and dark.
 */

test.describe.configure({ mode: "serial" });

// The tests open their own contexts (two people per board); close them so no page outlives its test and steals focus
// from the specs that run after this one in the same worker.
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

/** Lane names left to right, as the board shows them. */
async function laneNames(board: Locator): Promise<string[]> {
  return board
    .getByTestId("board-column")
    .evaluateAll((els) => els.map((e) => e.querySelector("h2")?.textContent?.trim() ?? ""));
}

async function apiColumnNames(api: APIRequestContext, convId: string): Promise<string[]> {
  return (await boardSnapshot(api, convId)).columns.map((c) => c.name);
}

/** The column ⋯ of a lane (1440) → an item. */
async function columnAction(page: Page, board: Locator, name: string, item: string) {
  await board.getByRole("button", { name: `${name} column actions` }).click();
  await page.getByRole("menuitem", { name: item }).click();
  await expect(page.getByTestId("column-menu-content")).toHaveCount(0);
}

/** A mouse drag from the middle of `from` to `to`, in small steps (dnd-kit needs movement past 5 px). */
async function pointerDrag(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = await from.boundingBox();
  if (!box) throw new Error("no source box");
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

test("tracer: Víctor adds “Waiting for parts”, moves it after In progress and drops a card in it; Alex sees both live", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the tracer runs at 1440");
  test.setTimeout(150_000);
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  const alexApi = await apiAs(ALEX);
  const { id: convId } = await createBoardChannel(admin, { prefix: "cases", members: [alexApi] });
  const a = await createCard(admin, convId, { title: "Pump 3 leaks", description: "Line 3, since Monday" });
  await createCard(admin, convId, { title: "Seal kit order", waitingOn: "us" });

  const { page } = await openAs(browser, ADMIN, "desktop");
  const board = await openBoard(page, convId);
  const { page: alex } = await openAs(browser, ALEX, "desktop");
  const alexBoard = await openBoard(alex, convId);
  await expect(alexBoard.getByTestId("board-column")).toHaveCount(4);

  // ---- the dashed Add column tile after the last lane → the dialog → appended at the end
  const addTile = board.getByTestId("add-column");
  await addTile.scrollIntoViewIfNeeded();
  const tileBox = await addTile.boundingBox();
  expect(tileBox?.width).toBe(272);
  expect(tileBox?.height).toBe(44);
  await addTile.click();
  const dialog = page.getByTestId("column-settings");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Add column" })).toBeVisible();
  await expect(dialog.getByLabel("Name")).toBeFocused();
  await dialog.getByLabel("Name").fill("Waiting for parts");
  await dialog.locator("label", { has: page.getByTestId("column-category-started") }).click();
  await expect(dialog.getByTestId("column-category-started")).toBeChecked();
  await dialog.getByTestId("column-waiting").click();
  await page.getByRole("option", { name: "Waiting on customer" }).click();
  await expect(dialog.getByTestId("column-waiting")).toContainText("Waiting on customer");
  await bothThemes(page, "board-columns-dialog-1440");
  await dialog.getByTestId("column-settings-submit").click();
  await expect(dialog).toBeHidden();
  const expectedEnd = ["Backlog", "In progress", "Done", "Cancelled", "Waiting for parts"];
  await expect.poll(() => laneNames(board)).toEqual(expectedEnd);
  await expect.poll(() => apiColumnNames(admin, convId)).toEqual(expectedEnd);
  // Alex: live, no reload.
  await expect.poll(() => laneNames(alexBoard)).toEqual(expectedEnd);

  // ---- Move left twice → right after In progress, for both
  await columnAction(page, board, "Waiting for parts", "Move left");
  await expect
    .poll(() => laneNames(board))
    .toEqual(["Backlog", "In progress", "Done", "Waiting for parts", "Cancelled"]);
  await columnAction(page, board, "Waiting for parts", "Move left");
  const placed = ["Backlog", "In progress", "Waiting for parts", "Done", "Cancelled"];
  await expect.poll(() => laneNames(board)).toEqual(placed);
  await expect.poll(() => apiColumnNames(admin, convId)).toEqual(placed);
  await expect.poll(() => laneNames(alexBoard)).toEqual(placed);

  // ---- drag card A into it: the column's default waiting state applies
  const parts = await columnId(admin, convId, "Waiting for parts");
  // The Add column tile scrolled the board to its end: back to the first lanes.
  await board.locator('[data-slot="board-scroller"]').evaluate((el) => el.scrollTo({ left: 0 }));
  const lane = boardColumn(board, parts);
  const laneBox = await lane.boundingBox();
  if (!laneBox) throw new Error("no lane box");
  await pointerDrag(page, cardTile(board, a.messageId).locator('[data-slot="card-open"]'), {
    x: laneBox.x + laneBox.width / 2,
    y: laneBox.y + 80,
  });
  await expect(boardColumn(board, parts).locator(`[data-card-id="${a.messageId}"]`)).toBeVisible();
  await expect.poll(async () => (await apiCard(admin, convId, a.messageId)).columnId).toBe(parts);
  await expect(cardTile(board, a.messageId).getByTestId("waiting-on-badge")).toHaveText(
    "Waiting on customer",
  );
  expect((await apiCard(admin, convId, a.messageId)).waitingOn).toBe("customer");
  // Alex sees the card in the new column with its waiting state, live.
  await expect(boardColumn(alexBoard, parts).locator(`[data-card-id="${a.messageId}"]`)).toBeVisible();
  await expect(cardTile(alexBoard, a.messageId).getByTestId("waiting-on-badge")).toHaveText(
    "Waiting on customer",
  );
  await page.mouse.move(0, 0);
  await bothThemes(page, "board-columns-1440");
  await admin.dispose();
  await alexApi.dispose();
});

// ---------------------------------------------------------------- Task 2: the rest of column management

async function addColumnApi(
  api: APIRequestContext,
  convId: string,
  body: { name: string; category: string; defaultWaitingOn?: string | null },
): Promise<string> {
  const res = await api.post(`/api/v1/boards/${convId}/columns`, { data: body });
  expect(res.ok(), `add column: ${res.status()} ${await res.text()}`).toBe(true);
  const ev = (await res.json()) as { columns: Array<{ id: string; name: string }> };
  return ev.columns.find((c) => c.name === body.name)?.id ?? "";
}

async function apiColumn(api: APIRequestContext, convId: string, id: string) {
  return (await boardSnapshot(api, convId)).columns.find((c) => c.id === id) as
    | { id: string; name: string; category: string; defaultWaitingOn?: string | null }
    | undefined;
}

test("desktop: rename, recategorise, Keep as is, delete with move, duplicate name; members see no column settings", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "lanes are the 1440 layout");
  test.setTimeout(150_000);
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  const alexApi = await apiAs(ALEX);
  const { id: convId } = await createBoardChannel(admin, { prefix: "cols", members: [alexApi] });
  const parts = await addColumnApi(admin, convId, {
    name: "Waiting for parts",
    category: "started",
    defaultWaitingOn: "customer",
  });
  const done = await columnId(admin, convId, "Done");
  const kept = await createCard(admin, convId, { title: "Gasket swap", waitingOn: "us" });
  const second = await createCard(admin, convId, { title: "Filter order" });
  const doneCard = await createCard(admin, convId, { title: "Old pump", columnId: done });
  const { page } = await openAs(browser, ADMIN, "desktop");
  const board = await openBoard(page, convId);

  // ---- rename + recategorise + Keep as is, in one Edit column
  await columnAction(page, board, "Waiting for parts", "Edit column…");
  const dialog = page.getByTestId("column-settings");
  await expect(dialog.getByRole("heading", { name: "Edit column" })).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("Waiting for parts");
  await expect(dialog.getByTestId("column-category-started")).toBeChecked();
  await expect(dialog.getByTestId("column-waiting")).toContainText("Waiting on customer");
  await dialog.getByLabel("Name").fill("Parts");
  await dialog.locator("label", { has: page.getByTestId("column-category-backlog") }).click();
  await dialog.getByTestId("column-waiting").click();
  const options = page.getByRole("option");
  await expect(options).toHaveText([
    "Keep as is",
    "Waiting on nobody",
    "Waiting on us",
    "Waiting on customer",
    "Waiting on both",
  ]);
  await page.getByRole("option", { name: "Keep as is" }).click();
  await dialog.getByTestId("column-settings-submit").click();
  await expect(dialog).toBeHidden();
  const lane = boardColumn(board, parts);
  await expect(lane.locator("h2")).toHaveText("Parts");
  await expect(lane.locator('[data-slot="column-header"] [data-category]')).toHaveAttribute(
    "data-category",
    "backlog",
  );
  await expect
    .poll(() => apiColumn(admin, convId, parts))
    .toMatchObject({
      name: "Parts",
      category: "backlog",
      defaultWaitingOn: null,
    });

  // ---- Keep as is: a card moved in keeps its waiting state
  await cardTile(board, kept.messageId).getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitemradio", { name: "Parts", exact: true }).click();
  await expect(lane.locator(`[data-card-id="${kept.messageId}"]`)).toBeVisible();
  await expect.poll(async () => (await apiCard(admin, convId, kept.messageId)).columnId).toBe(parts);
  expect((await apiCard(admin, convId, kept.messageId)).waitingOn).toBe("us");
  await expect(cardTile(board, kept.messageId).getByTestId("waiting-on-badge")).toHaveText("Waiting on us");
  await cardTile(board, second.messageId).getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitemradio", { name: "Parts", exact: true }).click();
  await expect.poll(async () => (await apiCard(admin, convId, second.messageId)).columnId).toBe(parts);

  // ---- delete while it holds two cards: a target is required; both land at the bottom of Done, in order
  await columnAction(page, board, "Parts", "Delete column…");
  const del = page.getByTestId("delete-column");
  await expect(del.getByRole("heading", { name: "Delete “Parts”?" })).toBeVisible();
  await expect(del).toContainText(
    "It holds 2 cards. Choose where they go; they're added to the bottom of that column.",
  );
  await expect(del.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(del.getByTestId("delete-column-submit")).toBeDisabled();
  await del.getByTestId("column-move-to").click();
  await expect(page.getByRole("option")).toHaveText(["Backlog", "In progress", "Done", "Cancelled"]);
  await page.getByRole("option", { name: "Done" }).click();
  await expect(del.getByTestId("delete-column-submit")).toBeEnabled();
  await del.getByTestId("delete-column-submit").click();
  await expect(del).toBeHidden();
  await expect(boardColumn(board, parts)).toHaveCount(0);
  await expect
    .poll(() => columnOrder(board, done))
    .toEqual([doneCard.messageId, kept.messageId, second.messageId]);
  expect((await boardSnapshot(admin, convId)).columns.map((c) => c.name)).toEqual([
    "Backlog",
    "In progress",
    "Done",
    "Cancelled",
  ]);

  // ---- a duplicate name, ignoring case, is refused in place
  await board.getByTestId("add-column").click();
  await dialog.getByLabel("Name").fill("done");
  await dialog.getByTestId("column-settings-submit").click();
  await expect(dialog.getByRole("alert")).toHaveText("A column named “done” already exists");
  await expect(dialog.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
  await expectNoSeriousA11y(page, '[data-testid="column-settings"]');
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // ---- the API's own refusal (a name taken meanwhile by someone else) shows in the same place
  await board.getByTestId("add-column").click();
  await dialog.getByLabel("Name").fill("Quality check");
  await addColumnApi(admin, convId, { name: "Quality check", category: "started" });
  // The board.updated frame may already have refreshed the dialog's list: either way the copy is the same.
  await dialog.getByTestId("column-settings-submit").click();
  await expect(dialog.getByRole("alert")).toHaveText("A column named “Quality check” already exists");
  await page.keyboard.press("Escape");

  // ---- Alex, a plain member: no Add column, no column ⋯
  const { page: alex } = await openAs(browser, ALEX, "desktop");
  const alexBoard = await openBoard(alex, convId);
  await expect(alexBoard.getByTestId("board-column")).toHaveCount(5);
  await expect(alexBoard.getByTestId("add-column")).toHaveCount(0);
  await expect(alexBoard.getByRole("button", { name: /column actions$/ })).toHaveCount(0);
  await admin.dispose();
  await alexApi.dispose();
});

test("390: the + tab adds a column full screen, ⋯ on the active-column row, deleting the shown column selects a neighbour", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "mobile", "the 390 column tabs");
  test.setTimeout(150_000);
  const admin = await apiAs(ADMIN);
  const { id: convId } = await createBoardChannel(admin, { prefix: "cols390" });
  await createCard(admin, convId, { title: "Pump inspection", waitingOn: "customer" });
  const { page } = await openAs(browser, ADMIN, "mobile");
  const board = await openBoard(page, convId);
  const tabs = board.getByTestId("board-tabs");

  // ---- the trailing + (44 × 44) opens the dialog full screen
  const plus = board.getByRole("button", { name: "Add column", exact: true });
  const plusBox = await plus.boundingBox();
  expect(plusBox?.width).toBeGreaterThanOrEqual(44);
  expect(plusBox?.height).toBeGreaterThanOrEqual(44);
  await plus.click();
  const dialog = page.getByTestId("column-settings");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  const box = await dialog.boundingBox();
  expect(box?.width).toBe(390);
  expect(box?.height).toBe(844);
  await dialog.getByLabel("Name").fill("Waiting for parts");
  await dialog.getByTestId("column-waiting").click();
  await page.getByRole("option", { name: "Waiting on customer" }).click();
  await bothThemes(page, "board-columns-dialog-390");
  await dialog.getByTestId("column-settings-submit").click();
  await expect(dialog).toBeHidden();
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  const parts = await columnId(admin, convId, "Waiting for parts");
  await createCard(admin, convId, { title: "Seal kit", columnId: parts });
  await createCard(admin, convId, { title: "Valve spares", columnId: parts });

  // ---- its tab; the ⋯ sits on the active-column row (44 × 44); Move left puts it before Cancelled
  await tabs.getByRole("tab", { name: /^Waiting for parts/ }).click();
  await expect(board.getByTestId("board-column-panel").getByTestId("board-card")).toHaveCount(2);
  const row = board.locator('[data-slot="active-column"]');
  const menu = row.getByRole("button", { name: "Waiting for parts column actions" });
  const menuBox = await menu.boundingBox();
  expect(menuBox?.width).toBeGreaterThanOrEqual(44);
  expect(menuBox?.height).toBeGreaterThanOrEqual(44);
  await bothThemes(page, "board-columns-390");
  await menu.click();
  await page.getByRole("menuitem", { name: "Move left" }).click();
  await expect
    .poll(async () => (await boardSnapshot(admin, convId)).columns.map((c) => c.name))
    .toEqual(["Backlog", "In progress", "Done", "Waiting for parts", "Cancelled"]);
  await expect(tabs.getByRole("tab")).toHaveText([
    /^Backlog/,
    /^In progress/,
    /^Done/,
    /^Waiting for parts/,
    /^Cancelled/,
  ]);

  // ---- delete it (two cards → Done): the next tab, Cancelled, is selected
  await row.getByRole("button", { name: "Waiting for parts column actions" }).click();
  await page.getByRole("menuitem", { name: "Delete column…" }).click();
  const del = page.getByTestId("delete-column");
  await expect(del).toContainText("It holds 2 cards.");
  await del.getByTestId("column-move-to").click();
  await page.getByRole("option", { name: "Done" }).click();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await bothThemes(page, "board-column-delete-390");
  await expectNoSeriousA11y(page, '[data-testid="delete-column"]');
  await del.getByTestId("delete-column-submit").click();
  await expect(del).toBeHidden();
  await expect(tabs.getByRole("tab", { name: /^Cancelled/ })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab")).toHaveCount(4);

  // ---- deleting the last column while it is shown selects the previous one
  await row.getByRole("button", { name: "Cancelled column actions" }).click();
  await page.getByRole("menuitem", { name: "Delete column…" }).click();
  await expect(del).toContainText("It's removed for everyone.");
  await del.getByTestId("delete-column-submit").click();
  await expect(del).toBeHidden();
  await expect(tabs.getByRole("tab", { name: /^Done/ })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await admin.dispose();
});

// ---------------------------------------------------------------- Task 3: card strip, card text edits, delete card

/** A lowercase token unique to this run (letters only, so search tokenises it as one word). */
const uniqueWord = () =>
  `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.replace(/[0-9]/g, (d) =>
    String.fromCharCode(97 + Number(d)),
  );

/** An organization-wide record template with a prefix, a naming rule and two fields (07.1-07 API). */
async function caseTemplate(admin: APIRequestContext): Promise<string> {
  const res = await admin.post("/api/v1/record-templates", {
    data: {
      unitId: null,
      name: `Case file ${uniqueWord()}`,
      prefix: "EXP",
      namingRule: "{prefix}-{seq:0000} · {summary}",
      fields: [
        { key: "customer", label: "Customer", type: "text", required: false },
        { key: "priority", label: "Priority", type: "select", required: false, options: ["Low", "High"] },
      ],
    },
  });
  expect(res.ok(), `template: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A board created from a fresh organization-wide template, which is deleted again at once: the board keeps its
 * snapshot (D-06), and no organization-wide template is left behind for other specs (record-templates expects a unit
 * without templates to say so).
 */
async function caseBoard(
  admin: APIRequestContext,
  opts: { prefix: string; members?: APIRequestContext[] },
): Promise<{ id: string; name: string }> {
  const templateId = await caseTemplate(admin);
  const board = await createBoardChannel(admin, { ...opts, templateId });
  const gone = await admin.delete(`/api/v1/record-templates/${templateId}`);
  expect(gone.ok(), `delete template: ${gone.status()}`).toBe(true);
  return board;
}

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId("search-input")).toBeFocused();
  return palette;
}

async function cardMenuItems(page: Page, tile: Locator): Promise<string[]> {
  await tile.getByTestId("card-menu").click();
  // The menu has rendered its items once Open thread is there (it is always offered).
  await expect(
    page.getByTestId("card-menu-content").getByRole("menuitem", { name: "Open thread" }),
  ).toBeVisible();
  const items = await page
    .getByTestId("card-menu-content")
    .getByRole("menuitem")
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("card-menu-content")).toHaveCount(0);
  return items;
}

test("desktop: the card strip, author-only text edits that keep a typed title, search follows, 409 Reload card, Delete card", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the 1440 thread panel");
  test.setTimeout(240_000);
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  const alexApi = await apiAs(ALEX);
  const { id: convId } = await caseBoard(admin, { prefix: "edit", members: [alexApi] });
  const oldWord = uniqueWord();
  const newWord = uniqueWord();
  const card = await createCard(admin, convId, {
    title: `Gasket ${oldWord}`,
    description: "Pump 3 leaks since Monday\nSeal kit ordered",
    fields: { customer: "Acme", priority: "High" },
  });
  const progress = await columnId(admin, convId, "In progress");
  const label = `EXP-${String(card.number).padStart(4, "0")}`;

  const { page } = await openAs(browser, ADMIN, "desktop");
  const board = await openBoard(page, convId);
  const { page: alex } = await openAs(browser, ALEX, "desktop");
  const alexBoard = await openBoard(alex, convId);

  // ---- the card strip: number and title, column, waiting state, Edit card, field values; the root says only the description
  await cardTile(board, card.messageId).locator('[data-slot="card-open"]').click();
  const panel = page.getByTestId("thread-panel");
  const strip = panel.getByTestId("card-strip");
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId("card-strip-title")).toHaveText(`${label}Gasket ${oldWord}`);
  await expect(strip.getByTestId("card-strip-column")).toContainText("Backlog");
  await expect(strip.getByTestId("card-strip-waiting")).toHaveText("Waiting on nobody");
  await expect(strip.getByTestId("card-strip-edit")).toBeVisible();
  await expect(strip.getByTestId("card-strip-fields")).toContainText("CustomerAcme");
  await expect(strip.getByTestId("card-strip-fields")).toContainText("PriorityHigh");
  const root = panel.locator(`[data-testid="message"][data-message-id="${card.messageId}"]`).first();
  await expect(root).toContainText("Pump 3 leaks since Monday");
  await expect(root).not.toContainText(`Gasket ${oldWord}`);
  await expect(root).not.toContainText("Customer: Acme");

  // ---- column and waiting state from the strip move the tile on the board
  await strip.getByTestId("card-strip-column").click();
  await page.getByRole("menuitemradio", { name: "In progress" }).click();
  await expect(boardColumn(board, progress).locator(`[data-card-id="${card.messageId}"]`)).toBeVisible();
  await expect.poll(async () => (await apiCard(admin, convId, card.messageId)).columnId).toBe(progress);
  await expect(strip.getByTestId("card-strip-column")).toContainText("In progress");
  await strip.getByTestId("card-strip-waiting").click();
  await page.getByRole("menuitemradio", { name: "Customer" }).click();
  await expect(cardTile(board, card.messageId).getByTestId("waiting-on-badge")).toHaveText(
    "Waiting on customer",
  );
  await expect(strip.getByTestId("card-strip-waiting")).toHaveText("Waiting on customer");
  await expectNoSeriousA11y(page, '[data-testid="card-strip"]');
  await bothThemes(page, "board-thread-strip-1440");
  await panel.getByTestId("close-thread").click();

  // ---- Edit card… from the card menu: the typed title changes, live for Alex
  await cardTile(board, card.messageId).getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: "Edit card…" }).click();
  const editor = page.getByTestId("card-edit");
  await expect(editor).toBeVisible();
  const title = editor.getByLabel("Title");
  await expect(title).toHaveValue(`Gasket ${oldWord}`);
  await expect(editor).toContainText("Typed titles are never changed automatically.");
  await expect(editor.getByTestId("card-edit-submit")).toBeDisabled();
  await title.fill(`Pump 3 replaced ${newWord}`);
  await expect(editor.getByTestId("card-edit-submit")).toBeEnabled();
  await expectNoSeriousA11y(page, '[data-testid="card-edit"]');
  await bothThemes(page, "board-card-edit-1440");
  await editor.getByTestId("card-edit-submit").click();
  await expect(editor).toBeHidden();
  await expect(cardTile(board, card.messageId)).toContainText(`Pump 3 replaced ${newWord}`);
  await expect(cardTile(alexBoard, card.messageId)).toContainText(`Pump 3 replaced ${newWord}`);

  // ---- search follows the title: the new word finds the card, the old one finds nothing
  let palette = await openPalette(page);
  await palette.getByTestId("search-input").pressSequentially(newWord, { delay: 20 });
  const hit = palette.locator(`[data-kind="message"][data-message-id="${card.messageId}"]`);
  await expect(hit).toBeVisible();
  await expect(hit).toContainText("replaced");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  // A card hit opens the card's thread over the board (07.1-09).
  await expect(page).toHaveURL(new RegExp(`/chat/${convId}\\?(.*&)?thread=${card.messageId}`));
  palette = await openPalette(page);
  await palette.getByTestId("search-input").pressSequentially(oldWord, { delay: 20 });
  await expect(palette.getByTestId("search-empty")).toBeVisible();
  await expect(palette.locator(`[data-message-id="${card.messageId}"]`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openBoard(page, convId);

  // ---- a description edit from the strip keeps the typed title
  await cardTile(board, card.messageId).locator('[data-slot="card-open"]').click();
  await strip.getByTestId("card-strip-edit").click();
  await expect(editor).toBeVisible();
  await editor.getByLabel("Description").fill("Pump 3 replaced on Tuesday\nSeal kit fitted");
  await editor.getByTestId("card-edit-submit").click();
  await expect(editor).toBeHidden();
  await expect(root).toContainText("Pump 3 replaced on Tuesday");
  await expect
    .poll(async () => (await apiCard(admin, convId, card.messageId)).description)
    .toContain("Seal kit fitted");
  const afterDescription = (await boardSnapshot(admin, convId)).cards
    .flatMap((c) => c.cards)
    .find((c) => c.messageId === card.messageId) as { title: string; titleSource?: string } | undefined;
  expect(afterDescription?.title).toBe(`Pump 3 replaced ${newWord}`);
  expect(afterDescription?.titleSource).toBe("user");
  await expect(strip.getByTestId("card-strip-title")).toHaveText(`${label}Pump 3 replaced ${newWord}`);

  // ---- the root's own Edit opens the card editor, not the message editor
  let actions = await openMessageActions(page, card.messageId, "desktop");
  await actions.getByTestId("edit-message").click();
  await expect(editor).toBeVisible();
  await expect(root.getByTestId("message-editor")).toHaveCount(0);
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();

  // ---- an edit against a stale version: another tab changed the text first → 409 → Reload card
  await strip.getByTestId("card-strip-edit").click();
  await expect(editor).toBeVisible();
  const current = await apiCard(admin, convId, card.messageId);
  const other = await admin.patch(`/api/v1/boards/${convId}/cards/${card.messageId}`, {
    data: { expectedVersion: current.version, title: `Pump 3 replaced ${newWord} (tab 2)` },
  });
  expect(other.ok(), `other tab: ${other.status()}`).toBe(true);
  await editor.getByLabel("Description").fill("Edited in the stale tab");
  await editor.getByTestId("card-edit-submit").click();
  const alert = editor.getByTestId("card-edit-error");
  await expect(alert).toContainText("This card changed while you were editing.");
  await alert.getByRole("button", { name: "Reload card" }).click();
  await expect(editor.getByLabel("Title")).toHaveValue(`Pump 3 replaced ${newWord} (tab 2)`);
  await expect(editor.getByLabel("Description")).toHaveValue("Pump 3 replaced on Tuesday\nSeal kit fitted");
  await expect(alert).toHaveCount(0);
  await editor.getByRole("button", { name: "Cancel" }).click();

  // ---- a reply in the card thread keeps the normal message editor
  const composer = page.getByTestId("thread-composer");
  await composer.click();
  await composer.fill("Fitted the new seal");
  await composer.press("Enter");
  const reply = panel.getByTestId("message").filter({ hasText: "Fitted the new seal" });
  await expect(reply).toHaveCount(1);
  await expect(reply).toHaveAttribute("data-message-id", /.+/);
  const replyId = (await reply.getAttribute("data-message-id")) ?? "";
  actions = await openMessageActions(page, replyId, "desktop");
  await actions.getByTestId("edit-message").click();
  await expect(reply.getByTestId("edit-input")).toBeVisible();
  await expect(editor).toHaveCount(0);
  await reply.getByTestId("edit-cancel").click();
  await expect(reply.getByTestId("edit-input")).toHaveCount(0);
  await panel.getByTestId("close-thread").click();

  // ---- Alex: no Edit card… or Delete card… on Víctor's card, and no Edit card in its strip
  const alexItems = await cardMenuItems(alex, cardTile(alexBoard, card.messageId));
  expect(alexItems).not.toContain("Edit card…");
  expect(alexItems).not.toContain("Delete card…");
  await cardTile(alexBoard, card.messageId).locator('[data-slot="card-open"]').click();
  const alexStrip = alex.getByTestId("card-strip");
  await expect(alexStrip).toBeVisible();
  await expect(alexStrip.getByTestId("card-strip-column")).toBeVisible();
  await expect(alexStrip.getByTestId("card-strip-edit")).toHaveCount(0);
  await alex.getByTestId("close-thread").click();

  // ---- Víctor deletes his card: Delete card… → confirmation → gone for both
  const items = await cardMenuItems(page, cardTile(board, card.messageId));
  expect(items.slice(-2)).toEqual(["Edit card…", "Delete card…"]);
  await cardTile(board, card.messageId).getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: "Delete card…" }).click();
  const confirm = page.getByTestId("delete-card");
  await expect(confirm.getByRole("heading", { name: "Delete this card?" })).toBeVisible();
  await expect(confirm).toContainText(
    `“Pump 3 replaced ${newWord} (tab 2)” is removed from the board for everyone. This can't be undone.`,
  );
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectNoSeriousA11y(page, '[data-testid="delete-card"]');
  await confirm.getByRole("button", { name: "Delete card" }).click();
  await expect(confirm).toBeHidden();
  await expect(cardTile(board, card.messageId)).toHaveCount(0);
  await expect(cardTile(alexBoard, card.messageId)).toHaveCount(0);

  // ---- an admin (message.delete_any) deletes Alex's card; Edit card… is still not offered to him
  const alexCard = await createCard(alexApi, convId, { title: "Alex's spare parts list" });
  await expect(cardTile(board, alexCard.messageId)).toBeVisible();
  const adminItems = await cardMenuItems(page, cardTile(board, alexCard.messageId));
  expect(adminItems).toContain("Delete card…");
  expect(adminItems).not.toContain("Edit card…");
  await cardTile(board, alexCard.messageId).getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: "Delete card…" }).click();
  await confirm.getByRole("button", { name: "Delete card" }).click();
  await expect(cardTile(board, alexCard.messageId)).toHaveCount(0);
  await expect(cardTile(alexBoard, alexCard.messageId)).toHaveCount(0);
  await admin.dispose();
  await alexApi.dispose();
});

test("390: the card strip wraps with 44 px controls; Edit card is full screen", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile", "the 390 thread sheet");
  test.setTimeout(150_000);
  const admin = await apiAs(ADMIN);
  const { id: convId } = await caseBoard(admin, { prefix: "strip390" });
  const card = await createCard(admin, convId, {
    description: "Broken pump at the Acme plant, line 3\nPump 3 leaks since Monday.",
    waitingOn: "customer",
    fields: { customer: "Acme Industrial Supplies", priority: "High" },
  });
  const { page } = await openAs(browser, ADMIN, "mobile");
  const board = await openBoard(page, convId);
  await cardTile(board, card.messageId).locator('[data-slot="card-open"]').click();
  const strip = page.getByTestId("card-strip");
  await expect(strip).toBeVisible();
  // An automatic title is made of what the thread shows: the strip has the number, the root the description, and
  // the description's first line appears once in the whole thread.
  const panel = page.getByTestId("thread-panel");
  await expect(strip.getByTestId("card-strip-title")).toHaveText(/^EXP-\d{4}$/);
  const root = panel.locator(`[data-testid="message"][data-message-id="${card.messageId}"]`).first();
  await expect(root).toContainText("Pump 3 leaks since Monday.");
  expect(((await panel.textContent()) ?? "").split("Broken pump at the Acme plant").length - 1).toBe(1);
  for (const id of ["card-strip-column", "card-strip-waiting", "card-strip-edit"]) {
    const b = await strip.getByTestId(id).boundingBox();
    expect(b?.height, `${id} height`).toBeGreaterThanOrEqual(44);
    expect((b?.x ?? 0) + (b?.width ?? 0), `${id} inside 390`).toBeLessThanOrEqual(390);
  }
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoSeriousA11y(page, '[data-testid="card-strip"]');
  }
  await page.emulateMedia({ colorScheme: "light" });
  await bothThemes(page, "board-thread-strip-390");

  await strip.getByTestId("card-strip-edit").click();
  const editor = page.getByTestId("card-edit");
  await expect(editor).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  const box = await editor.boundingBox();
  expect(box?.width).toBe(390);
  expect(box?.height).toBe(844);
  await expect(editor).toContainText("Automatic title, updates with the description and fields.");
  await expect(editor.getByLabel("Title")).toHaveValue("");
  await expect(editor.getByLabel("Title")).toHaveAttribute(
    "placeholder",
    /^Automatic: EXP-\d{4} · Broken pump at the Acme plant, line 3$/,
  );
  await editor.getByLabel("Description").fill("Seal kit fitted on line 3\nPump 3 back in service.");
  await expect(editor.getByLabel("Title")).toHaveAttribute(
    "placeholder",
    /^Automatic: EXP-\d{4} · Seal kit fitted on line 3$/,
  );
  await expectNoSeriousA11y(page, '[data-testid="card-edit"]');
  await bothThemes(page, "board-card-edit-390");
  await editor.getByTestId("card-edit-submit").click();
  await expect(editor).toBeHidden();
  await expect(root).toContainText("Seal kit fitted on line 3");
  await expect(root).toContainText("Pump 3 back in service.");
  await expect(cardTile(board, card.messageId)).toContainText("Seal kit fitted on line 3");
  await admin.dispose();
});

test("Messages view: Edit message on a card root opens the card editor; a plain message keeps the inline editor", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  const { id: convId } = await createBoardChannel(admin, { prefix: "msgedit" });
  const card = await createCard(admin, convId, { description: "Pump 3 leaks\nLine 3, since Monday" });
  const plain = await postAs(admin, convId, "Standup moves to 10:00");
  const { context, page } = await openAs(browser, ADMIN, project);
  await openBoard(page, convId);
  await page.getByTestId("view-messages").click();
  await expect(page).toHaveURL(/view=messages/);
  const list = page.getByTestId("channel-scroll");

  // ---- the card root: Edit message → the card editor (the generic edit would answer 400 board_card_use_board)
  const root = messageRow(list, card.messageId);
  const actions = await openMessageActions(page, card.messageId, project);
  await actions.getByTestId("edit-message").click();
  const editor = page.getByTestId("card-edit");
  await expect(editor).toBeVisible();
  await expect(root.getByTestId("edit-input")).toHaveCount(0);
  await editor.getByLabel("Description").fill("Pump 3 replaced\nSeal kit fitted on Tuesday");
  await editor.getByTestId("card-edit-submit").click();
  await expect(editor).toBeHidden();
  await expect(page.getByText("Edit this card from the board")).toHaveCount(0);
  await expect
    .poll(async () => (await apiCard(admin, convId, card.messageId)).description)
    .toBe("Pump 3 replaced\nSeal kit fitted on Tuesday");
  await expect(root).toContainText("Seal kit fitted on Tuesday");

  // ---- a plain message of the board: the normal inline editor, saved through PATCH /messages/:id
  const row = messageRow(list, plain.id);
  const plainActions = await openMessageActions(page, plain.id, project);
  await plainActions.getByTestId("edit-message").click();
  await expect(row.getByTestId("edit-input")).toBeVisible();
  await expect(editor).toHaveCount(0);
  await row.getByTestId("edit-cancel").click();
  await expect(row.getByTestId("edit-input")).toHaveCount(0);

  await context.close();
  await admin.dispose();
});
