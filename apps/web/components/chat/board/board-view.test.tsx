import type { BoardFieldDef } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOARD, COL, COLUMNS, CONV, card, snapshot } from "@/lib/board-fixtures.test-util";
import { BoardColumn } from "./board-column";
import { BoardView, type BoardViewProps } from "./board-view";
import { CardFields, fieldErrors, parseFieldInput } from "./card-fields";
import { newCardTitlePlaceholder } from "./new-card-dialog";

/**
 * The board view's static pieces (07.1-08, BOARD-02, BOARD-03) against 07.1-UI-SPEC.md: the region and its one polite
 * live region, the lane anatomy and empty box, typed card fields, and the new-card title placeholder.
 */

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

function withQuery(node: ReactNode): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function view(props: Partial<BoardViewProps> = {}): string {
  return withQuery(
    <BoardView
      channel={{ id: CONV, name: "cases" }}
      snapshot={snapshot([card(1), card(2), card(3, { columnId: COL.progress })])}
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

const FIELDS: BoardFieldDef[] = [
  { key: "customer", label: "Customer", type: "text", required: true },
  { key: "amount", label: "Amount", type: "number", required: false },
  { key: "due", label: "Due", type: "date", required: false },
  { key: "priority", label: "Priority", type: "select", required: true, options: ["Low", "High"] },
];

describe("BoardView (UI-SPEC Accessibility Contract)", () => {
  it("is a region named after the channel with exactly one polite live region", () => {
    const html = view();
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="#cases board"');
    expect(html).toContain('data-testid="board-view"');
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it("renders one 272 px lane per column, in order, with its cards in an ordered list", () => {
    const html = view();
    const lanes = [...html.matchAll(/data-testid="board-column" data-column-id="([^"]+)"/g)].map((m) => m[1]);
    expect(lanes).toEqual(COLUMNS.map((c) => c.id));
    expect(html).toContain("w-68");
    expect(html).toContain('aria-label="Backlog cards"');
    expect(html.match(/data-testid="board-card"/g)).toHaveLength(3);
  });

  it("gives posters a grip per card and readers none, nor a lane +", () => {
    expect(view()).toContain('aria-label="Move card Card 1"');
    expect(view()).toContain('aria-label="Add card to Backlog"');
    const ro = view({ canPost: false });
    expect(ro).not.toContain("Move card");
    expect(ro).not.toContain("Add card to");
  });

  it("shows four lane skeletons and an sr-only label while loading, and the error state with Try again", () => {
    const loading = view({ snapshot: undefined, loading: true });
    expect(loading).toContain("Loading board");
    expect(loading.match(/data-testid="board-lane-skeleton"/g)).toHaveLength(4);
    const failed = view({ snapshot: undefined, error: new Error("Boom") });
    expect(text(failed)).toContain("Couldn't load this board");
    expect(text(failed)).toContain("Boom");
    expect(text(failed)).toContain("Try again");
  });

  it("shows No cards yet with New card in the default column of an empty board", () => {
    const html = text(view({ snapshot: snapshot([]) }));
    expect(html).toContain("No cards yet");
    expect(html).toContain(
      "Add one for each case, order or ticket. @mention a bot in a card to get it working.",
    );
    expect(html).toContain("New card");
    expect(text(view({ snapshot: snapshot([]), canPost: false }))).not.toContain("New card");
  });
});

describe("BoardColumn", () => {
  it("renders the dashed No cards box for an empty lane, and Show more cards when more exist", () => {
    const col = COLUMNS[1];
    if (!col) throw new Error("fixture");
    const empty = renderToStaticMarkup(
      <BoardColumn column={col} count={0} hasMore={false} canPost onAdd={() => {}} empty="No cards" />,
    );
    expect(empty).toContain('aria-labelledby="col-');
    expect(empty).toContain("border-dashed");
    expect(text(empty)).toContain("No cards");
    const more = renderToStaticMarkup(
      <BoardColumn
        column={col}
        count={100}
        hasMore
        canPost
        onAdd={() => {}}
        footer={<button type="button">Show more cards</button>}
      >
        <li>tile</li>
      </BoardColumn>,
    );
    expect(text(more)).toContain("100+");
    expect(text(more)).toContain("Show more cards");
    expect(more).not.toContain("border-dashed");
  });
});

describe("CardFields (generic typed inputs)", () => {
  it("renders a text, number, date and select input with labels and aria-required on required ones", () => {
    const html = renderToStaticMarkup(
      <CardFields defs={FIELDS} values={{}} onChange={() => {}} errors={{}} />,
    );
    expect(html).toMatch(/<input[^>]*id="card-field-customer"[^>]*aria-required="true"/);
    expect(html).toMatch(
      /<input[^>]*type="number"[^>]*id="card-field-amount"|id="card-field-amount"[^>]*type="number"/,
    );
    expect(html).toMatch(/type="date"/);
    expect(html).toContain('data-field-type="select"');
    expect(text(html)).toContain("Customer");
    expect(text(html)).toContain("Priority");
    expect(html).not.toMatch(/id="card-field-amount"[^>]*aria-required="true"/);
  });

  it("parses inputs per type and maps schema issues to the UI-SPEC copy", () => {
    expect(
      parseFieldInput({ key: "amount", label: "Amount", type: "number", required: false }, ""),
    ).toBeNull();
    expect(parseFieldInput({ key: "amount", label: "Amount", type: "number", required: false }, "12.5")).toBe(
      12.5,
    );
    expect(fieldErrors(FIELDS, { customer: "", amount: Number.NaN, due: "8/10/2026" })).toEqual({
      customer: "Customer is required",
      amount: "Enter a number",
      due: "Use a date like 2026-10-08",
      priority: "Priority is required",
    });
    expect(fieldErrors(FIELDS, { customer: "Acme", priority: "High" })).toEqual({});
    expect(fieldErrors(FIELDS, { customer: "x".repeat(501), priority: "High" })).toEqual({
      customer: "Keep it under 500 characters",
    });
  });
});

describe("newCardTitlePlaceholder", () => {
  it("previews the naming rule with the next number, or names the description's first line without a rule", () => {
    const s = snapshot([card(1), card(2), card(3, { columnId: COL.progress })]);
    expect(newCardTitlePlaceholder(s, "", {})).toBe("Automatic: EXP-0004 · …");
    expect(newCardTitlePlaceholder(s, "Broken pump\nmore", {})).toBe("Automatic: EXP-0004 · Broken pump");
    const plain = { ...s, board: { ...BOARD, prefix: null, namingRule: null } };
    expect(newCardTitlePlaceholder(plain, "", {})).toBe("First line of the description");
  });
});
