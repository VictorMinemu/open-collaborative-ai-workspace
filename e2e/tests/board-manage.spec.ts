import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs } from "../support/actors";
import {
  apiCard,
  boardColumn,
  boardSnapshot,
  cardTile,
  columnId,
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
