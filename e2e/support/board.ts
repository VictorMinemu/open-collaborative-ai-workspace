import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";
import { BASE_URL } from "./actors";

/**
 * Board channel helpers (Phase 07.1, created by 07.1-08; used by 07.1-09/11/12/13). API helpers create through the
 * real routes as the signed-in user of `api`; page helpers locate the board by its test ids (07.1-01 contract).
 */

/** The subset of `BoardCard` the specs read. */
export interface BoardCardDto {
  messageId: string;
  conversationId: string;
  columnId: string;
  rank: string;
  waitingOn: "none" | "us" | "customer" | "both";
  title: string;
  description: string;
  number: number | null;
  replyCount: number;
  version: number;
}

export interface BoardSnapshotDto {
  board: { conversationId: string; prefix: string | null; namingRule: string | null };
  columns: Array<{ id: string; name: string; category: string }>;
  cards: Array<{ columnId: string; cards: BoardCardDto[]; hasMore: boolean }>;
  lastSeq: number;
}

/** A new board channel with a unique name, created by `api` and joined by every `members` context. */
export async function createBoardChannel(
  api: APIRequestContext,
  opts: {
    prefix?: string;
    visibility?: "public" | "private";
    unitId?: string | null;
    members?: APIRequestContext[];
    templateId?: string;
  } = {},
): Promise<{ id: string; name: string }> {
  const name = `${opts.prefix ?? "board"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await api.post("/api/v1/channels", {
    data: {
      name,
      visibility: opts.visibility ?? "public",
      layout: "board",
      ...(opts.unitId !== undefined ? { unitId: opts.unitId } : {}),
      ...(opts.templateId ? { templateId: opts.templateId } : {}),
    },
  });
  expect(res.ok(), `create board ${name}: ${res.status()} ${await res.text()}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  for (const m of opts.members ?? []) {
    const joined = await m.post(`/api/v1/channels/${id}/join`);
    expect(joined.ok(), `join ${name}`).toBe(true);
  }
  return { id, name };
}

/** `GET /boards/:id`. */
export async function boardSnapshot(api: APIRequestContext, convId: string): Promise<BoardSnapshotDto> {
  const res = await api.get(`/api/v1/boards/${convId}`);
  expect(res.ok(), `board ${convId}: ${res.status()}`).toBe(true);
  return (await res.json()) as BoardSnapshotDto;
}

/** The id of the column named `name` on a board. */
export async function columnId(api: APIRequestContext, convId: string, name: string): Promise<string> {
  const col = (await boardSnapshot(api, convId)).columns.find((c) => c.name === name);
  expect(col, `column ${name}`).toBeTruthy();
  return col?.id ?? "";
}

/** Creates a card through `POST /boards/:id/cards` and returns it. */
export async function createCard(
  api: APIRequestContext,
  convId: string,
  input: {
    title?: string;
    description?: string;
    columnId?: string;
    waitingOn?: BoardCardDto["waitingOn"];
    fields?: Record<string, string | number | null>;
  },
): Promise<BoardCardDto> {
  const res = await api.post(`/api/v1/boards/${convId}/cards`, {
    data: {
      description: "",
      ...input,
      clientMessageId: `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
  expect(res.ok(), `create card: ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as BoardCardDto | { card: BoardCardDto };
  return "card" in body ? body.card : body;
}

/** One card as the API has it now. */
export async function apiCard(
  api: APIRequestContext,
  convId: string,
  messageId: string,
): Promise<BoardCardDto> {
  const s = await boardSnapshot(api, convId);
  const card = s.cards.flatMap((c) => c.cards).find((c) => c.messageId === messageId);
  expect(card, `card ${messageId}`).toBeTruthy();
  return card as BoardCardDto;
}

/** Opens a board channel and waits for its board (Board is the default view). */
export async function openBoard(page: Page, convId: string): Promise<Locator> {
  await page.goto(`${BASE_URL}/chat/${convId}`);
  const board = page.getByTestId("board-view");
  await expect(board).toBeVisible();
  await expect(board.getByText("Loading board")).toHaveCount(0);
  return board;
}

/** A card tile on the board. */
export function cardTile(page: Page | Locator, messageId: string): Locator {
  return page.locator(`[data-testid="board-card"][data-card-id="${messageId}"]`);
}

/** The lane (1440) or the column list (390) of a column. */
export function boardColumn(page: Page | Locator, colId: string): Locator {
  return page.locator(`[data-testid="board-column"][data-column-id="${colId}"]`);
}

/** Card ids of a column, in the order the board shows them. */
export async function columnOrder(page: Page | Locator, colId: string): Promise<string[]> {
  return boardColumn(page, colId)
    .locator('[data-testid="board-card"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-card-id") ?? ""));
}
