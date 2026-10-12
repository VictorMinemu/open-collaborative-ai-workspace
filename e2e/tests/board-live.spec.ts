import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { apiAs, ensureMember, openAs } from "../support/actors";
import {
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
 * The live board (07.1-09, BOARD-03 … BOARD-05, D-03, D-05, P-12): two people on one board stay in step through one
 * subscription to the channel stream, simultaneous drops converge on the server's order, an offline client sees why
 * and catches up without reload, and search lands on cards.
 */

test.describe.configure({ mode: "serial" });

interface Person {
  page: Page;
  board: Locator;
  close: () => Promise<void>;
}

async function personOn(browser: Browser, who: typeof ADMIN | typeof ALEX, project: string, convId: string) {
  const { context, page } = await openAs(browser, who, project);
  const board = await openBoard(page, convId);
  return { page, board, context, close: () => context.close() };
}

/** Card menu open with its Move to… / Waiting on… submenu open, so the last click can be timed. */
async function openSubmenu(page: Page, tile: Locator, submenu: "Move to…" | "Waiting on…") {
  await tile.getByTestId("card-menu").click();
  await page.getByRole("menuitem", { name: submenu }).click();
}

async function pick(page: Page, item: string) {
  await page.getByRole("menuitemradio", { name: item, exact: true }).click();
  await expect(page.getByTestId("card-menu-content")).toHaveCount(0);
}

/**
 * Focuses a radio item of the open submenu once the menus stopped animating, so `fire` can choose it without any
 * actionability wait: two pages then send their changes within milliseconds of each other.
 */
async function arm(page: Page, item: string) {
  const radio = page.getByRole("menuitemradio", { name: item, exact: true });
  await expect(radio).toBeVisible();
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  await radio.focus();
  await expect(radio).toBeFocused();
}

const fire = (page: Page) => page.keyboard.press("Enter");

async function menuPick(page: Page, tile: Locator, submenu: "Move to…" | "Waiting on…", item: string) {
  await openSubmenu(page, tile, submenu);
  await pick(page, item);
}

/** Card ids of a column as the API has them now. */
async function apiOrder(api: APIRequestContext, convId: string, colId: string): Promise<string[]> {
  const snap = await boardSnapshot(api, convId);
  return snap.cards.find((c) => c.columnId === colId)?.cards.map((c) => c.messageId) ?? [];
}

/** Waits until every page shows `colId` in the API's order. */
async function expectSameOrder(api: APIRequestContext, convId: string, colId: string, people: Person[]) {
  await expect
    .poll(
      async () => {
        const want = await apiOrder(api, convId, colId);
        const seen = await Promise.all(people.map((p) => columnOrder(p.board, colId)));
        return seen.every((s) => JSON.stringify(s) === JSON.stringify(want))
          ? "same"
          : JSON.stringify({ want, seen });
      },
      { timeout: 10_000 },
    )
    .toBe("same");
}

/** Nothing toasted or announced on this page (other people's changes are silent, UI-SPEC). */
async function expectSilent(page: Page) {
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(page.getByTestId("board-live")).toHaveText(/^\s*$/);
}

async function liveSocket(page: Page) {
  await expect(page.getByTestId("connection-status").first()).toHaveAttribute("data-status", "open");
}

// ---------------------------------------------------------------- Task 1: two people, one board

test("tracer: Víctor and Alex on one board stay in step: live moves, a waiting chip, simultaneous drops converge, a shared conflict settles", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "two browsers at 1440");
  test.setTimeout(150_000);
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  const alexApi = await apiAs(ALEX);
  const { id: convId } = await createBoardChannel(admin, { prefix: "live", members: [alexApi] });
  const backlog = await columnId(admin, convId, "Backlog");
  const progress = await columnId(admin, convId, "In progress");
  const done = await columnId(admin, convId, "Done");
  const cancelled = await columnId(admin, convId, "Cancelled");

  const a = await createCard(admin, convId, { description: "Broken pump\nPump 3 leaks" });
  const b = await createCard(admin, convId, { description: "Invoice 1042 disputed" });
  const c = await createCard(admin, convId, { description: "Valve inspection", columnId: progress });
  const x = await createCard(admin, convId, { description: "Replace filter X" });
  const y = await createCard(alexApi, convId, { description: "Order gasket Y" });
  const z = await createCard(admin, convId, { description: "Calibrate sensor Z" });

  const v = await personOn(browser, ADMIN, "desktop", convId);
  const al = await personOn(browser, ALEX, "desktop", convId);
  await liveSocket(v.page);
  await liveSocket(al.page);

  // ---- Víctor moves A to Done through the menu → Alex sees it there, without reload, toast or announcement.
  await menuPick(v.page, cardTile(v.board, a.messageId), "Move to…", "Done");
  await expect(cardTile(boardColumn(al.board, done), a.messageId)).toBeVisible();
  await expect(cardTile(boardColumn(al.board, backlog), a.messageId)).toHaveCount(0);
  await expectSilent(al.page);

  // ---- Alex sets B to "Waiting on customer" → Víctor sees the chip, silently.
  await menuPick(al.page, cardTile(al.board, b.messageId), "Waiting on…", "Customer");
  await expect(cardTile(v.board, b.messageId).getByTestId("waiting-on-badge")).toHaveText(
    "Waiting on customer",
  );
  await expect(v.page.locator("[data-sonner-toast]")).toHaveCount(0);

  // ---- Both drop a different card into the same slot (after C, the last card of In progress) at once.
  expect(await columnOrder(v.board, progress)).toEqual([c.messageId]);
  await openSubmenu(v.page, cardTile(v.board, x.messageId), "Move to…");
  await arm(v.page, "In progress");
  await openSubmenu(al.page, cardTile(al.board, y.messageId), "Move to…");
  await arm(al.page, "In progress");
  await Promise.all([fire(v.page), fire(al.page)]);
  await expectSameOrder(admin, convId, progress, [v, al]);
  const order = await apiOrder(admin, convId, progress);
  expect(order[0]).toBe(c.messageId);
  expect(order.filter((id) => id === x.messageId)).toHaveLength(1);
  expect(order.filter((id) => id === y.messageId)).toHaveLength(1);
  expect(order).toHaveLength(3);
  await expectSameOrder(admin, convId, backlog, [v, al]);
  await expect(v.page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(al.page.locator("[data-sonner-toast]")).toHaveCount(0);

  // ---- Both move the same card at once (Z: Víctor → Done, Alex → Cancelled): one wins, the other is told and
  // shows the winner's move; both screens end with Z in the same place.
  await openSubmenu(v.page, cardTile(v.board, z.messageId), "Move to…");
  await arm(v.page, "Done");
  await openSubmenu(al.page, cardTile(al.board, z.messageId), "Move to…");
  await arm(al.page, "Cancelled");
  await Promise.all([fire(v.page), fire(al.page)]);
  const conflict = (p: Page) =>
    p
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Someone else changed this card. Showing the latest." });
  await expect.poll(async () => (await conflict(v.page).count()) + (await conflict(al.page).count())).toBe(1);
  const final = (await boardSnapshot(admin, convId)).cards.find((col) =>
    col.cards.some((k) => k.messageId === z.messageId),
  )?.columnId;
  expect([done, cancelled]).toContain(final);
  for (const p of [v, al]) {
    await expect(cardTile(boardColumn(p.board, final ?? ""), z.messageId)).toBeVisible();
    await expect(cardTile(p.board, z.messageId)).toHaveCount(1);
  }
  for (const col of [backlog, progress, done, cancelled]) await expectSameOrder(admin, convId, col, [v, al]);

  await expect(conflict(v.page)).toHaveCount(0, { timeout: 15_000 });
  await expect(conflict(al.page)).toHaveCount(0, { timeout: 15_000 });
  await bothThemes(al.page, "board-live-1440");

  await v.close();
  await al.close();
  await alexApi.dispose();
  await admin.dispose();
});
