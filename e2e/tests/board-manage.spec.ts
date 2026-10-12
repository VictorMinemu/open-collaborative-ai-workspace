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
import { ALEX } from "../support/chat";
import { bothThemes } from "../support/files";
import { ADMIN } from "./env";

/**
 * Board management in the browser (07.1-11; BOARD-01, BOARD-02, BOARD-05, BOARD-06; D-07, D-08, P-02, P-09): column
 * settings from the board for the channel's owner or an admin, live for every viewer; the card strip at the top of a
 * card's thread; card text edits by the card's author (typed titles kept, search follows); Delete card for the author
 * or a moderator. 1440 and 390, light and dark.
 */

test.describe.configure({ mode: "serial" });

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

