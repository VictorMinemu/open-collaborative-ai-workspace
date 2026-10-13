import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import {
  boardColumn,
  boardSnapshot,
  cardTile,
  columnId,
  columnOrder,
  createBoardChannel,
  openBoard,
} from "../support/board";
import { cellToken } from "../support/cell-token";
import { ALEX, freshChannel, messageRow, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { bothThemes } from "../support/files";
import { ADMIN, API_URL } from "./env";

/**
 * Agents on boards (07.1-13, BOARD-02, D-07, C-01, P-03, C-03). The fake OpenClaw cell answers mentions and runs
 * `[[call ocw_board_card …]]` the way the real plugin tool does: only the turn's event and agent travel, the API reads
 * the board and the human from the stored turn. In the browser: a bot mentioned in a new card answers in that card's
 * thread (opened by clicking the tile, the card strip on top) and the tile counts the reply; the bot creates a card
 * that appears live for Víctor and Alex with the bot as author; it moves the thread's card and sets its waiting state,
 * live; a text channel's turn keeps its tool list (no `ocw_board_card`). 1440 and 390, light and dark.
 */

test.describe.configure({ mode: "serial" });

const BOT_NAME = "Clerk";
const BOT_HANDLE = "clerk";

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** The team bot @clerk on the never-metered mock model (created once; both projects share it). */
async function ensureClerk(admin: APIRequestContext): Promise<string> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  const found = listed.agents.find((a) => a.name === BOT_NAME);
  if (found) return found.id;
  const res = await admin.post("/api/v1/agents", {
    data: {
      name: BOT_NAME,
      username: BOT_HANDLE,
      description: "Keeps the board tidy.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create @${BOT_HANDLE}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function addBot(api: APIRequestContext, channelId: string, agentId: string) {
  const res = await api.post(`/api/v1/channels/${channelId}/members`, {
    data: { kind: "agent", id: agentId },
  });
  expect(res.ok(), `add @${BOT_HANDLE}: ${res.status()}`).toBe(true);
}

/** The `[turn tools: …]` list the fake cell appends to a reply. */
const toolsOf = (text: string) => /\[turn tools: ([^\]]*)\]/u.exec(text)?.[1]?.split(",") ?? [];

/** The delivery of a message to the bot (its turn tools say what the API offered). */
async function deliveryOf(cell: FakeCellPlugin, messageId: string): Promise<MentionPayload> {
  const ev = await cell.waitFor(
    (e) =>
      e.type === "agent.mention.v1" && (e.data as { message?: { id?: string } }).message?.id === messageId,
    15_000,
  );
  return ev.data as unknown as MentionPayload;
}

/** Sends `text` from the open thread's composer and waits for the bot's reply in the thread that contains `expected`. */
async function askInThread(page: Page, text: string, expected: string) {
  const panel = page.getByTestId("thread-panel");
  const composer = page.getByTestId("thread-composer");
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
  await expect(
    panel.locator('[data-testid="message"][data-author-kind="agent"]').filter({ hasText: expected }).last(),
  ).toBeVisible({ timeout: 20_000 });
}

/** At 390 the board shows one column at a time: select the tab of `colId`. */
async function showColumn(board: Locator, project: string, colId: string) {
  if (project !== "mobile") return;
  await board.locator(`[data-testid="board-tabs"] [role="tab"][data-column-id="${colId}"]`).click();
  await expect(boardColumn(board, colId)).toBeVisible();
}

async function personOn(
  browser: Browser,
  who: { email: string; password: string },
  project: string,
  convId: string,
) {
  const { context, page } = await openAs(browser, who, project);
  const board = await openBoard(page, convId);
  await expect(page.getByTestId("connection-status").first()).toHaveAttribute("data-status", "open");
  return { context, page, board };
}

let admin: APIRequestContext;
let cell: FakeCellPlugin;
let clerkId: string;

test.beforeAll(async () => {
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, ALEX, "developer");
  clerkId = await ensureClerk(admin);
  cell = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await cell.start();
});

test.afterAll(async () => {
  await cell?.stop();
  await admin?.dispose();
});

test("@clerk answers in a card's thread, creates a card and moves the thread's card live for everyone; a text channel keeps its tools", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const alexApi = await apiAs(ALEX);
  const { id: convId } = await createBoardChannel(admin, { prefix: "agents", members: [alexApi] });
  await addBot(admin, convId, clerkId);
  const backlog = await columnId(admin, convId, "Backlog");
  const progress = await columnId(admin, convId, "In progress");

  const v = await personOn(browser, ADMIN, project, convId);
  const a = await personOn(browser, ALEX, project, convId);
  try {
    // ---- Víctor creates a card that mentions @clerk: the bot answers in the card's own thread
    await v.page.getByTestId("new-card-button").click();
    const dialog = v.page.getByTestId("new-card");
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Description")
      .fill(`Broken pump on line 3\n@${BOT_HANDLE} can you take this one?`);
    await dialog.getByTestId("new-card-submit").click();
    await expect(dialog).toBeHidden();
    const tile = v.board.getByTestId("board-card").filter({ hasText: "Broken pump on line 3" });
    await expect(tile).toHaveCount(1);
    const cardId = (await tile.getAttribute("data-card-id")) ?? "";
    const delivered = await deliveryOf(cell, cardId);
    expect(delivered.thread.rootMessageId).toBe(cardId);
    const boardTools = delivered.turn?.tools ?? [];
    expect(boardTools).toContain("ocw_board_card");
    // The reply counts on the tile, live, on both pages.
    for (const p of [v, a]) {
      await expect(cardTile(p.board, cardId).getByTestId("card-replies")).toHaveText("1", {
        timeout: 20_000,
      });
    }

    // ---- clicking the tile opens the thread: the card strip on top, the bot's reply below it
    await cardTile(v.board, cardId).locator('[data-slot="card-open"]').click();
    const panel = v.page.getByTestId("thread-panel");
    await expect(panel).toBeVisible();
    const strip = panel.getByTestId("card-strip");
    await expect(strip).toBeVisible();
    // A rule-less title is the description's first line: the strip leaves it to the card message below (UI-SPEC).
    await expect(strip).toHaveAttribute("data-card-id", cardId);
    await expect(panel.getByTestId("message").first()).toContainText("Broken pump on line 3");
    const reply = panel.locator('[data-testid="message"][data-author-kind="agent"]').first();
    await expect(reply).toContainText(`Asked by ${ADMIN.name}`);
    await expect(reply.getByTestId("message-author")).toHaveText(BOT_NAME);
    await expect(reply.getByTestId("bot-badge")).toBeVisible();
    // The strip sits above the conversation.
    const stripBox = await strip.boundingBox();
    const replyBox = await reply.boundingBox();
    expect((stripBox?.y ?? 0) + (stripBox?.height ?? 0)).toBeLessThanOrEqual(replyBox?.y ?? 0);
    await bothThemes(v.page, `board-agent-thread-${w}`);

    // ---- in the card's thread @clerk creates a card: it lands at the bottom of Backlog, live, authored by the bot
    await askInThread(
      v.page,
      `@${BOT_HANDLE} please log the part [[call ocw_board_card {"action":"create","description":"Order spare valve"}]]`,
      "Tool ocw_board_card: created",
    );
    const created = (await boardSnapshot(admin, convId)).cards
      .flatMap((c) => c.cards)
      .find((c) => c.title === "Order spare valve");
    expect(created, "the bot's card").toBeTruthy();
    const newId = created?.messageId ?? "";
    expect(created?.columnId).toBe(backlog);
    const raw = (await (await admin.get(`/api/v1/boards/${convId}`)).json()) as {
      cards: Array<{ cards: Array<{ messageId: string; authorKind: string; authorId: string }> }>;
    };
    expect(raw.cards.flatMap((c) => c.cards).find((c) => c.messageId === newId)).toMatchObject({
      authorKind: "agent",
      authorId: clerkId,
    });
    for (const p of [a, ...(project === "mobile" ? [] : [v])]) {
      const t = cardTile(p.board, newId);
      await expect(t).toBeVisible({ timeout: 10_000 });
      await expect(t.locator('[data-slot="bot-avatar"]')).toBeVisible();
      await expect(t.locator(`[title="${BOT_NAME}"]`)).toBeVisible();
      await expect.poll(async () => (await columnOrder(p.board, backlog)).at(-1)).toBe(newId);
    }

    // ---- @clerk moves the thread's card to In progress: live on Alex's board
    await askInThread(
      v.page,
      `@${BOT_HANDLE} starting now [[call ocw_board_card {"action":"move","columnId":"${progress}"}]]`,
      "Tool ocw_board_card: moved",
    );
    await expect(strip.getByTestId("card-strip-column")).toContainText("In progress");
    await showColumn(a.board, project, progress);
    await expect(cardTile(boardColumn(a.board, progress), cardId)).toBeVisible({ timeout: 10_000 });
    await expect(cardTile(boardColumn(a.board, backlog), cardId)).toHaveCount(0);

    // ---- @clerk sets it waiting on the customer: the chip shows on the tile and in the strip
    await askInThread(
      v.page,
      `@${BOT_HANDLE} we need the customer's sign-off [[call ocw_board_card {"action":"set_waiting","waitingOn":"customer"}]]`,
      "Tool ocw_board_card: waiting set",
    );
    await expect(strip.getByTestId("card-strip-waiting")).toHaveText("Waiting on customer");
    await expect(cardTile(a.board, cardId).getByTestId("waiting-on-badge")).toHaveText(
      "Waiting on customer",
      {
        timeout: 10_000,
      },
    );
    // Every call was bound to the turn: the board routes answered, nothing was refused.
    expect(cell.boardRequests.filter((r) => r.status >= 400)).toEqual([]);

    // ---- the board with the bot's card (at 390 the thread is a full-screen sheet: back to the board, Backlog)
    if (project === "mobile") {
      await v.page.getByTestId("close-thread").click();
      await showColumn(v.board, project, backlog);
      const t = cardTile(v.board, newId);
      await expect(t).toBeVisible();
      await expect(t.locator('[data-slot="bot-avatar"]')).toBeVisible();
      await t.scrollIntoViewIfNeeded();
    }
    await bothThemes(v.page, `board-agent-card-${w}`);

    // ---- a text channel: the same bot's turn has no ocw_board_card; the rest of its list is the board turn's
    const victorApi = await apiAs(ADMIN);
    const text = await freshChannel(victorApi, [alexApi], "agents-text");
    await addBot(victorApi, text.id, clerkId);
    const asked = await postAs(victorApi, text.id, `@${BOT_HANDLE} what's on today?`);
    const textTurn = await deliveryOf(cell, asked.id);
    expect(textTurn.turn?.tools ?? []).not.toContain("ocw_board_card");
    expect([...(textTurn.turn?.tools ?? [])].sort()).toEqual(
      boardTools.filter((t) => t !== "ocw_board_card").sort(),
    );
    await cell.waitUntil(() => cell.replies.some((r) => r.mention.eventId === textTurn.eventId), 15_000);
    const textReply = cell.replies.find((r) => r.mention.eventId === textTurn.eventId);
    // The reply sits in the mention's thread, like every channel answer.
    await v.page.goto(`${BASE_URL}/chat/${text.id}?thread=${asked.id}`);
    const row = messageRow(v.page.getByTestId("thread-panel"), textReply?.messageId ?? "");
    await expect(row).toBeVisible({ timeout: 10_000 });
    const shown = toolsOf(await row.innerText());
    expect(shown).not.toContain("ocw_board_card");
    expect(shown).toContain("ocw_agent_card");
    await victorApi.dispose();
  } finally {
    await v.context.close();
    await a.context.close();
    await alexApi.dispose();
  }
});
