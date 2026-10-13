import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
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
import { ALEX, messageRow, postAs } from "../support/chat";
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
  await al.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await al.board.locator('[data-slot="board-scroller"]').evaluate((el) => el.scrollTo({ left: 0 }));
  await bothThemes(al.page, "board-live-1440");

  await v.close();
  await al.close();
  await alexApi.dispose();
  await admin.dispose();
});

// ---------------------------------------------------------------- Task 2: offline, search, Messages view

/** Moves a card through the API as the signed-in user of `api` (to the bottom of `colId`). */
async function apiMove(api: APIRequestContext, convId: string, messageId: string, colId: string) {
  const { version } = await apiCard(api, convId, messageId);
  const order = await apiOrder(api, convId, colId);
  const res = await api.patch(`/api/v1/boards/${convId}/cards/${messageId}`, {
    data: { expectedVersion: version, move: { columnId: colId, afterCardId: order.at(-1) ?? null } },
  });
  expect(res.ok(), `move ${messageId}: ${res.status()} ${await res.text()}`).toBe(true);
}

const RECONNECTING = "Reconnecting… Changes from others will show up when you're back.";
const OFFLINE = "You're offline. Changes from others will show up when you reconnect.";

test("offline: Alex's board says it is offline after 3 s, then catches up on reconnect without reload", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  const alexApi = await apiAs(ALEX);
  const { id: convId } = await createBoardChannel(admin, { prefix: "offline", members: [alexApi] });
  const backlog = await columnId(admin, convId, "Backlog");
  const progress = await columnId(admin, convId, "In progress");
  const done = await columnId(admin, convId, "Done");
  const cancelled = await columnId(admin, convId, "Cancelled");
  const p1 = await createCard(admin, convId, { description: "Broken pump\nPump 3 leaks" });
  const p2 = await createCard(admin, convId, { description: "Invoice 1042 disputed", waitingOn: "customer" });
  const p3 = await createCard(alexApi, convId, { description: "Valve inspection", columnId: progress });

  const al = await personOn(browser, ALEX, project, convId);
  await liveSocket(al.page);
  await al.page.evaluate(() => {
    (window as { __boardStayed?: boolean }).__boardStayed = true;
  });
  const banner = al.page.getByTestId("board-connection-banner");
  await expect(banner).toHaveCount(0);

  // ---- offline: after about 3 s a status banner under the toolbar says so
  await al.context.setOffline(true);
  const t0 = Date.now();
  await expect(banner).toBeVisible({ timeout: 20_000 });
  expect(Date.now() - t0, "the banner waits about 3 s").toBeGreaterThanOrEqual(2_900);
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner).toHaveText(new RegExp(`^(${RECONNECTING}|${OFFLINE})$`));
  // It sits right under the toolbar, above the board.
  const toolbarBox = await al.page.getByTestId("board-toolbar").boundingBox();
  const bannerBox = await banner.boundingBox();
  expect(Math.round(bannerBox?.y ?? 0)).toBe(Math.round((toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0)));
  expect(bannerBox?.height ?? 0).toBeGreaterThanOrEqual(32);
  expect((bannerBox?.y ?? 0) + (bannerBox?.height ?? 0)).toBeLessThanOrEqual(
    (await al.board.boundingBox())?.y ?? 0,
  );

  // ---- meanwhile Víctor creates one card and moves two
  const n = await createCard(admin, convId, { description: "Leak under sink 4" });
  await apiMove(admin, convId, p1.messageId, done);
  await apiMove(admin, convId, p3.messageId, cancelled);
  await expect(cardTile(al.board, n.messageId)).toHaveCount(0);
  await bothThemes(al.page, `board-offline-${size}`);
  await expectNoSeriousA11y(al.page, '[data-testid="board-connection-banner"]');
  await al.page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(al.page, '[data-testid="board-connection-banner"]');
  await al.page.emulateMedia({ colorScheme: "light" });

  // ---- back online: the banner goes and the three changes are there, without reload (cursor replay)
  await al.context.setOffline(false);
  await expect(banner).toHaveCount(0, { timeout: 20_000 });
  await liveSocket(al.page);
  await expect(cardTile(al.board, n.messageId)).toBeVisible();
  if (project === "mobile") {
    // Backlog is the visible tab: P1 left it; the tab counts carry the other columns.
    await expect(cardTile(al.board, p1.messageId)).toHaveCount(0);
    const tabs = al.board.getByTestId("board-tabs");
    await expect(tabs.getByRole("tab", { name: "Backlog, 2 cards" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "In progress, 0 cards" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Done, 1 card" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Cancelled, 1 card" })).toBeVisible();
    await expect.poll(() => columnOrder(al.board, backlog)).toEqual(await apiOrder(admin, convId, backlog));
  } else {
    for (const col of [backlog, progress, done, cancelled]) {
      await expect.poll(() => columnOrder(al.board, col)).toEqual(await apiOrder(admin, convId, col));
    }
    await expect(cardTile(boardColumn(al.board, done), p1.messageId)).toBeVisible();
    await expect(cardTile(boardColumn(al.board, cancelled), p3.messageId)).toBeVisible();
  }
  await expect(cardTile(al.board, p2.messageId).getByTestId("waiting-on-badge")).toHaveText(
    "Waiting on customer",
  );
  expect(await al.page.evaluate(() => (window as { __boardStayed?: boolean }).__boardStayed)).toBe(true);
  await expectSilent(al.page);

  await al.close();
  await alexApi.dispose();
  await admin.dispose();
});

/** A lowercase token unique to this run (letters only, so search tokenises it as one word). */
const uniqueWord = () =>
  `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.replace(/[0-9]/g, (d) =>
    String.fromCharCode(97 + Number(d)),
  );

async function searchAndOpen(page: Page, project: string, word: string, messageId: string) {
  if (project === "mobile") await page.getByTestId("open-search").click();
  else await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId("search-input")).toBeFocused();
  await palette.getByTestId("search-input").pressSequentially(word, { delay: 20 });
  const hit = palette.locator(`[data-kind="message"][data-message-id="${messageId}"]`);
  await expect(hit).toBeVisible();
  await expect(palette.locator('[data-kind="message"]')).toHaveCount(1);
  await hit.click();
  await expect(palette).toBeHidden();
}

test("search → card: a word of a card's description opens its thread over the board; a reply hit highlights the reply; a plain message opens in Messages", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  const { id: convId, name } = await createBoardChannel(admin, { prefix: "found" });
  const progress = await columnId(admin, convId, "In progress");
  const inCard = uniqueWord();
  const inReply = uniqueWord();
  const inMessage = uniqueWord();
  for (let i = 1; i <= 3; i++) await createCard(admin, convId, { description: `Routine check ${i}` });
  const card = await createCard(admin, convId, {
    description: `Pump station audit\nThe ${inCard} gasket on pump 3 is worn`,
    columnId: progress,
  });
  const reply = await postAs(admin, convId, `Ordered a new ${inReply} gasket`, {
    threadRootId: card.messageId,
  });
  const plain = await postAs(admin, convId, `Standup moves to 10:00 ${inMessage}`);

  const { context, page } = await openAs(browser, ADMIN, project);

  // ---- a word only in the card's description → the board with that card's thread open and the tile selected
  await searchAndOpen(page, project, inCard, card.messageId);
  await expect(page).toHaveURL(new RegExp(`/chat/${convId}\\?(.*&)?thread=${card.messageId}`));
  expect(new URL(page.url()).searchParams.get("m")).toBeNull();
  await expect(page.getByTestId("channel-title")).toHaveText(name);
  const panel = page.getByTestId("thread-panel");
  await expect(panel).toBeVisible();
  await expect(messageRow(panel, card.messageId)).toContainText(inCard);
  await expect(page.getByTestId("view-board")).toHaveAttribute("aria-selected", "true");
  if (project === "mobile") {
    // The thread is a full-screen sheet; closing it shows the card's column with the card.
    await page.getByTestId("close-thread").click();
    await expect(page.getByTestId("board-tabs").getByRole("tab", { selected: true })).toHaveAttribute(
      "data-column-id",
      progress,
    );
    await expect(cardTile(page.getByTestId("board-view"), card.messageId)).toBeVisible();
  } else {
    const tile = cardTile(page.getByTestId("board-view"), card.messageId);
    await expect(tile).toBeInViewport();
    await expect(tile.locator('[aria-current="true"]')).toHaveCount(1);
  }

  // ---- a hit on a reply inside the card thread → the same thread, the reply highlighted
  await searchAndOpen(page, project, inReply, reply.id);
  await expect(page).toHaveURL(new RegExp(`/chat/${convId}\\?thread=${card.messageId}&m=${reply.id}`));
  await expect(panel).toBeVisible();
  await expect(messageRow(panel, reply.id)).toHaveAttribute("data-highlighted", "true");
  await expect(page.getByTestId("board-view")).toBeAttached();
  await expect(page.getByTestId("view-board")).toHaveAttribute("aria-selected", "true");
  if (project === "mobile") await page.getByTestId("close-thread").click(); // the sheet covers the nav at 390

  // ---- a plain top-level message of the board → the Messages view, highlighted like a text channel
  await searchAndOpen(page, project, inMessage, plain.id);
  await expect(page.getByTestId("view-messages")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`m=${plain.id}`));
  const row = messageRow(page.getByTestId("channel-scroll"), plain.id);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-highlighted", "true");

  await context.close();
  await admin.dispose();
});

test("Messages view: card roots and other top-level messages in today's list; back on Board the tab and scroll are kept", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  const { id: convId } = await createBoardChannel(admin, { prefix: "views" });
  const progress = await columnId(admin, convId, "In progress");
  const cards = [];
  for (let i = 1; i <= 14; i++) {
    cards.push(await createCard(admin, convId, { description: `Work order ${i}`, columnId: progress }));
  }
  const plain = await postAs(admin, convId, "Standup moves to 10:00");
  const { context, page } = await openAs(browser, ADMIN, project);
  const board = await openBoard(page, convId);

  // Scroll somewhere: the column panel at 390 (on a non-default tab), the board and a lane at 1440.
  const scroller =
    project === "mobile"
      ? board.getByTestId("board-column-panel")
      : board.locator('[data-slot="board-scroller"]');
  if (project === "mobile") {
    await board.getByTestId("board-tabs").getByRole("tab", { name: "In progress, 14 cards" }).click();
    await expect(page).toHaveURL(new RegExp(`col=${progress}`));
  }
  await scroller.evaluate((el) => el.scrollTo({ top: 300, left: 200 }));
  const before = await scroller.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }));
  expect(before.top + before.left).toBeGreaterThan(0);

  // ---- Messages: card roots and the plain message, in the normal list
  await page.getByTestId("view-messages").click();
  await expect(page).toHaveURL(/view=messages/);
  const list = page.getByTestId("channel-scroll");
  await expect(messageRow(list, plain.id)).toBeVisible();
  await expect(messageRow(list, cards[13]?.messageId ?? "")).toContainText("Work order 14");
  await expect(messageRow(list, cards[0]?.messageId ?? "")).toBeAttached();
  await expect(board).toBeHidden();

  // ---- back on Board: same tab (390), same scroll
  await page.getByTestId("view-board").click();
  await expect(board).toBeVisible();
  if (project === "mobile") {
    await expect(board.getByTestId("board-tabs").getByRole("tab", { selected: true })).toHaveAttribute(
      "data-column-id",
      progress,
    );
  }
  const after = await scroller.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }));
  expect(after).toEqual(before);

  await context.close();
  await admin.dispose();
});
