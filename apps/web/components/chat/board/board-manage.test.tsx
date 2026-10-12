import type { BoardFieldDef } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { AUTHOR, BOARD, COL, COLUMNS, CONV, card, id, snapshot } from "@/lib/board-fixtures.test-util";
import {
  COLUMN_COPY,
  cardEditRequest,
  cardRootKind,
  columnErrorMessage,
  columnNameError,
  draftOf,
  neighbourMove,
  removeCard,
} from "@/lib/board-manage-queries";
import { BoardView, type BoardViewProps } from "./board-view";
import { automaticTitlePreview, titleHint } from "./card-edit-dialog";
import { cardMenuModel, menuColumns } from "./card-menu";
import { CardStrip, cardRootView, stripFields } from "./card-strip";
import {
  COLUMN_WAITING_CHOICES,
  columnMenuModel,
  DeleteColumnForm,
  deleteColumnModel,
} from "./column-settings-dialog";
import { deleteCardBody } from "./delete-card-dialog";

/**
 * Board management pieces (07.1-11; BOARD-01, P-09) against 07.1-UI-SPEC.md: column gating, the column menu, the
 * delete-with-move confirmation and the column dialog's options; card text editing and deletion (Task 3) below.
 */

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

function withQuery(node: ReactNode): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function view(props: Partial<BoardViewProps> = {}): string {
  return withQuery(
    <BoardView
      channel={{ id: CONV, name: "cases" }}
      snapshot={snapshot([card(1), card(2, { columnId: COL.progress })])}
      loading={false}
      error={null}
      onRetry={() => {}}
      canPost
      authorOf={() => ({ name: "Víctor Ruiz" })}
      onOpenCard={() => {}}
      selectedCardId={null}
      onAddCard={() => {}}
      activeColumnId={null}
      onActiveColumnChange={() => {}}
      {...props}
    />,
  );
}

describe("column settings gating (channel.update)", () => {
  it("shows no column ⋯ and no Add column without channel.update", () => {
    const html = view({ canManage: false });
    expect(html).not.toContain("column actions");
    expect(html).not.toContain("Add column");
  });

  it("gives managers a ⋯ per lane and the dashed Add column tile after the last lane", () => {
    const html = view({ canManage: true });
    for (const c of COLUMNS) expect(html).toContain(`aria-label="${c.name} column actions"`);
    expect(html).toContain('data-testid="add-column"');
    expect(html).toContain("border-dashed");
    expect(text(html)).toContain("Add column");
    // The tile comes after every lane.
    expect(html.lastIndexOf('data-testid="board-column"')).toBeLessThan(
      html.indexOf('data-testid="add-column"'),
    );
  });
});

describe("column menu", () => {
  it("disables Move left on the first column and Move right on the last", () => {
    expect(columnMenuModel(COLUMNS, COL.backlog)).toMatchObject({
      moveLeft: { disabled: true },
      moveRight: { disabled: false },
      deleteColumn: { disabled: false, reason: null },
    });
    expect(columnMenuModel(COLUMNS, COL.cancelled)).toMatchObject({
      moveLeft: { disabled: false },
      moveRight: { disabled: true },
    });
  });

  it("disables Delete column on the last remaining column with the reason as its description", () => {
    const only = [COLUMNS[0]].filter((c) => c !== undefined);
    expect(columnMenuModel(only, COL.backlog).deleteColumn).toEqual({
      disabled: true,
      reason: "A board needs at least one column",
    });
  });

  it("moves one place: left after the column two to the left (null = first), right after the next one", () => {
    expect(neighbourMove(COLUMNS, COL.done, "left")).toEqual({ afterColumnId: COL.backlog });
    expect(neighbourMove(COLUMNS, COL.progress, "left")).toEqual({ afterColumnId: null });
    expect(neighbourMove(COLUMNS, COL.backlog, "left")).toBeUndefined();
    expect(neighbourMove(COLUMNS, COL.done, "right")).toEqual({ afterColumnId: COL.cancelled });
    expect(neighbourMove(COLUMNS, COL.cancelled, "right")).toBeUndefined();
  });
});

describe("delete column confirmation", () => {
  const three = snapshot([card(1), card(2), card(3)]);

  it("asks where a column's cards go, offering every other column with its category", () => {
    const model = deleteColumnModel(three, COL.backlog);
    expect(model.count).toBe(3);
    expect(model.needsTarget).toBe(true);
    expect(model.body).toBe(
      "It holds 3 cards. Choose where they go; they're added to the bottom of that column.",
    );
    expect(model.targets.map((t) => [t.name, t.category])).toEqual([
      ["In progress", "started"],
      ["Done", "done"],
      ["Cancelled", "cancelled"],
    ]);
  });

  it("says one card, and says an empty column is simply removed", () => {
    expect(deleteColumnModel(snapshot([card(1)]), COL.backlog).body).toBe(
      "It holds 1 card. Choose where they go; they're added to the bottom of that column.",
    );
    const empty = deleteColumnModel(three, COL.done);
    expect(empty.needsTarget).toBe(false);
    expect(empty.body).toBe("It's removed for everyone.");
  });

  it("keeps Delete column disabled until a target is chosen", () => {
    const model = deleteColumnModel(three, COL.backlog);
    const none = renderToStaticMarkup(
      <DeleteColumnForm
        model={model}
        target={null}
        onTarget={() => {}}
        pending={false}
        error={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(text(none)).toContain("Move its cards to");
    expect(text(none)).toContain("Choose a column");
    expect(none).toMatch(
      /<button[^>]*disabled=""[^>]*data-testid="delete-column-submit"|<button[^>]*data-testid="delete-column-submit"[^>]*disabled=""/,
    );
    const chosen = renderToStaticMarkup(
      <DeleteColumnForm
        model={model}
        target={COL.done}
        onTarget={() => {}}
        pending={false}
        error={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(chosen).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="delete-column-submit"/);
    expect(chosen).not.toMatch(/data-testid="delete-column-submit"[^>]*disabled=""/);
  });
});

describe("column dialog", () => {
  it("offers exactly five default waiting states in UI-SPEC order, Keep as is = null", () => {
    expect(COLUMN_WAITING_CHOICES.map((c) => [c.label, c.value])).toEqual([
      ["Keep as is", null],
      ["Waiting on nobody", "none"],
      ["Waiting on us", "us"],
      ["Waiting on customer", "customer"],
      ["Waiting on both", "both"],
    ]);
  });

  it("validates the name in place: required, 60 characters, unique per board ignoring case", () => {
    expect(columnNameError("  ", COLUMNS, null)).toBe("Give the column a name");
    expect(columnNameError("x".repeat(61), COLUMNS, null)).toBe("Keep it under 60 characters");
    expect(columnNameError("done", COLUMNS, null)).toBe("A column named “done” already exists");
    expect(columnNameError("Done", COLUMNS, COL.done)).toBeNull();
    expect(columnNameError("Waiting for parts", COLUMNS, null)).toBeNull();
  });

  it("maps API refusals to the UI-SPEC copy", () => {
    expect(columnErrorMessage(new ApiRequestError(409, "board_column_exists", "x"), "done")).toBe(
      "A column named “done” already exists",
    );
    expect(columnErrorMessage(new ApiRequestError(409, "board_columns_limit", "x"), "n")).toBe(
      COLUMN_COPY.limit,
    );
    expect(COLUMN_COPY.limit).toBe("A board can have up to 20 columns");
    expect(columnErrorMessage(new ApiRequestError(500, "boom", "Server down"), "n")).toBe("Server down");
  });
});

describe("removeCard", () => {
  it("drops a deleted card root from its column and leaves others alone", () => {
    const s = snapshot([card(1), card(2)]);
    const next = removeCard(s, card(1).messageId);
    expect(next.cards[0]?.cards.map((c) => c.title)).toEqual(["Card 2"]);
    expect(removeCard(s, "missing")).toBe(s);
  });
});

describe("cardRootKind (the Messages view's editor for a top-level message of a board)", () => {
  const msg = (id: string, threadId: string | null = null) => ({ id, threadId });
  const complete = snapshot([card(1), card(2)]);
  const partial = {
    ...complete,
    cards: complete.cards.map((c, i) => (i === 0 ? { ...c, hasMore: true } : c)),
  };

  it("a card in the loaded board is a card", () => {
    expect(cardRootKind(complete, msg(card(1).messageId))).toBe("card");
    expect(cardRootKind(partial, msg(card(2).messageId))).toBe("card");
  });

  it("a message the loaded board does not hold is a plain message only when every column is fully loaded", () => {
    expect(cardRootKind(complete, msg(id(90)))).toBe("message");
    // A column with more cards than its first page may hold it: ask the API (GET /boards/:id/cards/:messageId).
    expect(cardRootKind(partial, msg(id(90)))).toBe("unknown");
    expect(cardRootKind(undefined, msg(id(90)))).toBe("unknown");
  });

  it("a reply is never a card", () => {
    expect(cardRootKind(partial, msg(id(91), card(1).messageId))).toBe("message");
    expect(cardRootKind(undefined, msg(id(91), card(1).messageId))).toBe("message");
  });
});

// ---------------------------------------------------------------- Task 3: card text and delete (P-02)

const FIELDS: BoardFieldDef[] = [
  { key: "customer", label: "Customer", type: "text", required: false },
  { key: "priority", label: "Priority", type: "select", required: false, options: ["Low", "High"] },
  { key: "due", label: "Due", type: "date", required: false },
];
const FIELD_BOARD = { ...BOARD, fields: FIELDS };
const OTHER = id(21);

describe("card menu: Edit card… and Delete card…", () => {
  const s = snapshot([card(1)]);
  const cols = menuColumns(s);
  const mine = card(1);

  it("offers Edit card… only to the card's human author who can post", () => {
    expect(cardMenuModel(mine, cols, { canPost: true, viewerId: AUTHOR }).editCard).toBe(true);
    expect(cardMenuModel(mine, cols, { canPost: true, viewerId: OTHER }).editCard).toBe(false);
    expect(cardMenuModel(mine, cols, { canPost: true, viewerId: OTHER, canDeleteAny: true }).editCard).toBe(
      false,
    );
    expect(cardMenuModel(mine, cols, { canPost: false, viewerId: AUTHOR }).editCard).toBe(false);
    // An agent's card has no human author, whoever looks.
    const agents = card(2, { authorKind: "agent", authorId: AUTHOR });
    expect(cardMenuModel(agents, cols, { canPost: true, viewerId: AUTHOR }).editCard).toBe(false);
  });

  it("offers Delete card… to the author or message.delete_any, never on an archived board", () => {
    expect(cardMenuModel(mine, cols, { canPost: true, viewerId: AUTHOR }).deleteCard).toBe(true);
    expect(cardMenuModel(mine, cols, { canPost: true, viewerId: OTHER }).deleteCard).toBe(false);
    expect(
      cardMenuModel(mine, cols, { canPost: false, viewerId: OTHER, canDeleteAny: true }).deleteCard,
    ).toBe(true);
    expect(
      cardMenuModel(mine, cols, { canPost: false, viewerId: AUTHOR, canDeleteAny: true, readOnly: true })
        .deleteCard,
    ).toBe(false);
  });

  it("confirms with the UI-SPEC copy", () => {
    expect(deleteCardBody("Pump 3 replaced")).toBe(
      "“Pump 3 replaced” is removed from the board for everyone. This can't be undone.",
    );
  });
});

describe("card edit", () => {
  const typed = card(1, {
    title: "Pump 3 replaced",
    titleSource: "user",
    description: "Pump 3 leaks",
    fields: { customer: "Acme", priority: "High" },
    version: 4,
  });
  const automatic = card(2, {
    title: "EXP-0002 · Broken pump",
    titleSource: "auto",
    description: "Broken pump",
  });

  it("hints which title the card has", () => {
    expect(titleHint("user")).toBe("Typed titles are never changed automatically.");
    expect(titleHint("heuristic")).toBe("Automatic title, updates with the description and fields.");
    expect(titleHint("auto")).toBe("Automatic title, updates with the description and fields.");
  });

  it("starts a typed title filled in and an automatic one empty, previewing what the server will compute", () => {
    expect(draftOf(typed).title).toBe("Pump 3 replaced");
    expect(draftOf(automatic).title).toBe("");
    const draft = { ...draftOf(automatic), description: "Seal kit fitted\nLine 3" };
    expect(automaticTitlePreview(FIELD_BOARD, automatic, draft)).toBe(
      "Automatic: EXP-0002 · Seal kit fitted",
    );
  });

  it("sends only what changed, with expectedVersion; nothing changed = no request", () => {
    expect(cardEditRequest(typed, draftOf(typed), FIELDS)).toBeNull();
    expect(
      cardEditRequest(typed, { ...draftOf(typed), description: "Pump 3 replaced on Tuesday" }, FIELDS),
    ).toEqual({ expectedVersion: 4, description: "Pump 3 replaced on Tuesday" });
    expect(
      cardEditRequest(typed, { ...draftOf(typed), values: { customer: "Acme", priority: null } }, FIELDS),
    ).toEqual({ expectedVersion: 4, fields: { priority: null } });
    expect(cardEditRequest(typed, { ...draftOf(typed), title: "  New title " }, FIELDS)).toEqual({
      expectedVersion: 4,
      title: "New title",
    });
  });

  it("never turns an automatic title into a typed one unless a title is typed", () => {
    const req = cardEditRequest(automatic, { ...draftOf(automatic), description: "Seal kit" }, FIELDS);
    expect(req).toEqual({ expectedVersion: 1, description: "Seal kit" });
    expect(req).not.toHaveProperty("title");
  });
});

describe("CardStrip (07.1-UI-SPEC Thread panel: card strip)", () => {
  const theCard = card(7, {
    title: "EXP-0007 · Broken pump",
    titleSource: "user",
    columnId: COL.progress,
    waitingOn: "customer",
    description: "Broken pump\nPump 3 leaks",
    fields: { customer: "Acme", priority: "High" },
  });
  const s = snapshot([theCard], { board: FIELD_BOARD });
  const strip = (over: { canPost?: boolean; isAuthor?: boolean; card?: typeof theCard } = {}) =>
    withQuery(
      <CardStrip
        convId={CONV}
        card={over.card ?? theCard}
        board={FIELD_BOARD}
        columns={menuColumns(s)}
        canPost={over.canPost ?? true}
        isAuthor={over.isAuthor ?? true}
        onEdit={() => {}}
      />,
    );

  it("shows the number and a typed title, the column and waiting chip as buttons, Edit card and the field values", () => {
    const html = strip();
    expect(html).toContain('data-testid="card-strip"');
    expect(html).toContain("bg-muted/30");
    expect(html).toContain("dark:bg-white/[0.02]");
    expect(text(html)).toContain("EXP-0007 Broken pump");
    expect(html).toMatch(/<button[^>]*data-testid="card-strip-column"/);
    expect(html).toMatch(/data-testid="card-strip-column"[\s\S]*data-category="started"[\s\S]*In progress/);
    expect(html).toMatch(/<button[^>]*data-testid="card-strip-waiting"/);
    expect(text(html)).toContain("Waiting on customer");
    expect(html).toContain('data-testid="card-strip-edit"');
    expect(html).toMatch(/<dl[^>]*data-testid="card-strip-fields"/);
    expect(html).toMatch(/<dt[^>]*>Customer<\/dt><dd[^>]*>Acme<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>Priority<\/dt><dd[^>]*>High<\/dd>/);
    expect(html).not.toContain(">Due<");
  });

  it("leaves an automatic title out: the number, fields and description already say it", () => {
    const html = strip({ card: { ...theCard, title: "EXP-0007 · Broken pump", titleSource: "auto" } });
    expect(html).toMatch(/data-testid="card-strip-title"[^>]*>(<span[^>]*>EXP-0007<\/span>)<\/h3>/);
    expect(text(html)).not.toContain("Broken pump");
  });

  it("offers Edit card to the author only", () => {
    expect(strip({ isAuthor: false })).not.toContain("card-strip-edit");
  });

  it("is static text for a viewer who cannot post", () => {
    const html = strip({ canPost: false, isAuthor: true });
    expect(html).not.toMatch(/<button[^>]*data-testid="card-strip-column"/);
    expect(html).toMatch(/<span[^>]*data-testid="card-strip-column"/);
    expect(html).not.toContain("card-strip-waiting");
    expect(html).toContain('data-testid="waiting-on-badge"');
    expect(html).not.toContain("card-strip-edit");
    expect(html).not.toContain("<button");
  });

  it("lists filled fields in definition order", () => {
    expect(stripFields(FIELDS, { priority: "High", customer: "Acme", due: null })).toEqual([
      { key: "customer", label: "Customer", value: "Acme" },
      { key: "priority", label: "Priority", value: "High" },
    ]);
  });

  it("leaves the root message the description only (the strip has the title and fields)", () => {
    const root = {
      id: theCard.messageId,
      body: "EXP-0007 · Broken pump\n\nBroken pump\nPump 3 leaks\n\nCustomer: Acme",
    };
    const shown = cardRootView(root as unknown as Parameters<typeof cardRootView>[0], theCard);
    expect(shown.body).toBe("Broken pump\nPump 3 leaks");
    expect(shown.id).toBe(theCard.messageId);
  });

  it("shows the card's title in the root when the description is empty, never an empty body", () => {
    const root = { id: theCard.messageId, body: "EXP-0007 · Broken pump\n\nCustomer: Acme" };
    for (const description of ["", "  \n "]) {
      const shown = cardRootView(root as unknown as Parameters<typeof cardRootView>[0], {
        ...theCard,
        description,
      });
      expect(shown.body).toBe("EXP-0007 · Broken pump");
    }
  });
});
