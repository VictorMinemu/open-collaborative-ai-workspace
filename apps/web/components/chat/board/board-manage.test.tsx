import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { COL, COLUMNS, CONV, card, snapshot } from "@/lib/board-fixtures.test-util";
import {
  COLUMN_COPY,
  columnErrorMessage,
  columnNameError,
  neighbourMove,
  removeCard,
} from "@/lib/board-manage-queries";
import { BoardView, type BoardViewProps } from "./board-view";
import {
  COLUMN_WAITING_CHOICES,
  columnMenuModel,
  DeleteColumnForm,
  deleteColumnModel,
} from "./column-settings-dialog";

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
