import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { apiAs, openAs } from "../support/actors";
import {
  apiCard,
  boardColumn,
  boardSnapshot,
  cardTile,
  columnId,
  columnOrder,
  createCard,
  openBoard,
} from "../support/board";
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
