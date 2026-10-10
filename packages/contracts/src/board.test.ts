import { describe, expect, it } from "vitest";
import {
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_TITLE_MAX,
  BOARD_SUMMARY_MAX,
  BoardCard,
  BoardCardUpsertedEvent,
  BoardColumnRerankedEvent,
  type BoardFieldDef,
  BoardSnapshot,
  BoardUpdatedEvent,
  CreateBoardCardRequest,
  cardMessageBody,
  DEFAULT_BOARD_COLUMNS,
  fieldValuesSchema,
  firstLine,
  parseNamingRule,
  renderCardTitle,
  UpdateBoardCardRequest,
} from "./board";
import { ChannelSummary, CreateChannelRequest, PostMessageRequest } from "./chat";
import { EventTypes } from "./realtime";

const RULE = "{prefix}-{seq:0000} · {field:customer} · {summary}";
const CONV = "0199a000-0000-7000-8000-000000000001";
const COL = "0199a000-0000-7000-8000-000000000002";
const MSG = "0199a000-0000-7000-8000-000000000003";
const USER = "0199a000-0000-7000-8000-000000000004";
const TPL = "0199a000-0000-7000-8000-000000000005";
const NOW = "2026-10-09T10:00:00.000Z";

const DEFS: BoardFieldDef[] = [
  { key: "customer", label: "Customer", type: "text", required: false },
  { key: "priority", label: "Priority", type: "select", required: false, options: ["Low", "High"] },
];

function card(over: Record<string, unknown> = {}) {
  return {
    messageId: MSG,
    conversationId: CONV,
    columnId: COL,
    rank: "a0",
    waitingOn: "none",
    title: "EXP-0007 · Acme · Broken pump",
    titleSource: "heuristic",
    description: "Broken pump\nsecond line",
    number: 7,
    fields: { customer: "Acme", priority: null },
    authorKind: "user",
    authorId: USER,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: NOW,
    movedAt: NOW,
    version: 1,
    ...over,
  };
}

describe("firstLine", () => {
  it("skips blank and whitespace-only lines and trims", () => {
    expect(firstLine("\n   \n\t\n  Broken pump  \nsecond")).toBe("Broken pump");
    expect(firstLine("\r\n\r\nWindows line\r\nnext")).toBe("Windows line");
  });

  it("caps at 80 characters by default and returns empty for blank text", () => {
    expect(firstLine("x".repeat(300))).toHaveLength(BOARD_SUMMARY_MAX);
    expect(firstLine("abcdef", 3)).toBe("abc");
    expect(firstLine("   \n \t ")).toBe("");
  });

  it("never splits a surrogate pair at the cut", () => {
    const out = firstLine(`${"a".repeat(79)}😀tail`);
    expect(out).toBe("a".repeat(79));
  });
});

describe("renderCardTitle", () => {
  const ctx = {
    prefix: "EXP",
    number: 7,
    description: "Broken pump\nsecond line",
    fields: { customer: "Acme" },
  };

  it("renders every token of the rule deterministically", () => {
    expect(renderCardTitle(RULE, ctx)).toBe("EXP-0007 · Acme · Broken pump");
    expect(renderCardTitle(RULE, ctx)).toBe(renderCardTitle(RULE, { ...ctx }));
  });

  it("drops an empty segment together with its separator", () => {
    expect(renderCardTitle(RULE, { ...ctx, fields: { customer: "" } })).toBe("EXP-0007 · Broken pump");
    expect(renderCardTitle(RULE, { ...ctx, fields: {} })).toBe("EXP-0007 · Broken pump");
    expect(renderCardTitle(RULE, { ...ctx, fields: { customer: "   " } })).toBe("EXP-0007 · Broken pump");
  });

  it("pads only when the rule asks for it", () => {
    expect(renderCardTitle("{prefix}-{seq} · {summary}", ctx)).toBe("EXP-7 · Broken pump");
  });

  it("drops the seq segment when the card has no number", () => {
    expect(renderCardTitle(RULE, { ...ctx, number: null })).toBe("EXP · Acme · Broken pump");
    expect(renderCardTitle("{seq:000} · {summary}", { ...ctx, number: null })).toBe("Broken pump");
  });

  it("never starts with a separator when the leading segments are empty", () => {
    expect(renderCardTitle(RULE, { ...ctx, prefix: null, number: null })).toBe("Acme · Broken pump");
  });

  it("renders number field values and never more than 200 characters", () => {
    expect(renderCardTitle("{field:amount} · {summary}", { ...ctx, fields: { amount: 42 } })).toBe(
      "42 · Broken pump",
    );
    const long = renderCardTitle(RULE, {
      ...ctx,
      description: "y".repeat(300),
      fields: { customer: "z".repeat(500) },
    });
    expect(long.length).toBeLessThanOrEqual(BOARD_CARD_TITLE_MAX);
    const summaryOnly = renderCardTitle("{summary}", { ...ctx, description: "y".repeat(300) });
    expect(summaryOnly).toBe("y".repeat(BOARD_SUMMARY_MAX));
  });

  it("falls back to the summary, then to Untitled, never empty", () => {
    expect(renderCardTitle("{field:customer}", { ...ctx, fields: {} })).toBe("Broken pump");
    expect(renderCardTitle("{field:customer}", { ...ctx, description: "", fields: {} })).toBe("Untitled");
    expect(renderCardTitle(null, ctx)).toBe("Broken pump");
    expect(renderCardTitle(null, { ...ctx, description: "  \n " })).toBe("Untitled");
  });

  it("keeps field values on one line", () => {
    expect(renderCardTitle("{field:customer}", { ...ctx, fields: { customer: "Acme\nplant  3" } })).toBe(
      "Acme plant 3",
    );
  });
});

describe("parseNamingRule", () => {
  it("accepts the documented grammar", () => {
    expect(parseNamingRule(RULE, ["customer"])).toEqual({ ok: true });
    expect(parseNamingRule("{seq} {summary}", [])).toEqual({ ok: true });
    expect(parseNamingRule("{prefix}-{seq:00000000}", [])).toEqual({ ok: true });
  });

  it.each([
    ["{nope}", "Unknown token {nope}"],
    ["{field:missing} {summary}", 'Unknown field "missing"'],
    ["{seq:000000000} {summary}", "Unknown token {seq:000000000}"],
    ["{prefix}-{seq", "Unclosed {"],
    ["{summary}}", "Unmatched }"],
    [`{summary}${"x".repeat(120)}`, "at most 120 characters"],
    ["plain text", "at least one token"],
    ["{summary}\n{seq}", "one line"],
  ])("refuses %j with a readable error", (rule, message) => {
    const result = parseNamingRule(rule, ["customer"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe("cardMessageBody", () => {
  it("projects title, description and non-empty field values as plain text", () => {
    expect(
      cardMessageBody({
        title: "Broken pump",
        description: "Pump 3 leaks",
        fields: { customer: "Acme", priority: null },
        defs: DEFS,
      }),
    ).toBe("Broken pump\n\nPump 3 leaks\n\nCustomer: Acme");
  });

  it("omits an empty description and empty values, labels from the definitions", () => {
    expect(cardMessageBody({ title: "T", description: "  ", fields: { priority: "High" }, defs: DEFS })).toBe(
      "T\n\nPriority: High",
    );
    expect(cardMessageBody({ title: "T", description: "", fields: { customer: "" }, defs: DEFS })).toBe("T");
  });

  it("ignores values without a definition", () => {
    expect(cardMessageBody({ title: "T", description: "", fields: { secret: "x" }, defs: DEFS })).toBe("T");
  });

  it("always fits the chat message body limit", () => {
    const body = cardMessageBody({ title: "T", description: "d".repeat(30_000), fields: {}, defs: DEFS });
    expect(body.length).toBeLessThanOrEqual(BOARD_CARD_BODY_MAX);
    expect(PostMessageRequest.safeParse({ body }).success).toBe(true);
    expect(PostMessageRequest.safeParse({ body: "x".repeat(BOARD_CARD_BODY_MAX + 1) }).success).toBe(false);
  });
});

describe("fieldValuesSchema", () => {
  const defs: BoardFieldDef[] = [
    { key: "customer", label: "Customer", type: "text", required: true },
    { key: "amount", label: "Amount", type: "number", required: false },
    { key: "due", label: "Due", type: "date", required: false },
    { key: "priority", label: "Priority", type: "select", required: false, options: ["Low", "High"] },
  ];
  const schema = fieldValuesSchema(defs);

  it("accepts typed values and omitted optional ones", () => {
    expect(
      schema.safeParse({ customer: "Acme", amount: 3.5, due: "2026-10-09", priority: "High" }).success,
    ).toBe(true);
    expect(schema.safeParse({ customer: "Acme", amount: null }).success).toBe(true);
  });

  it.each([
    ["a missing required field", {}],
    ["an empty required field", { customer: "  " }],
    ["a null required field", { customer: null }],
    ["an unknown key", { customer: "Acme", other: "x" }],
    ["a non-number", { customer: "Acme", amount: "3" }],
    ["an infinite number", { customer: "Acme", amount: Number.POSITIVE_INFINITY }],
    ["a bad date", { customer: "Acme", due: "09/10/2026" }],
    ["an unknown option", { customer: "Acme", priority: "Urgent" }],
    ["an over-long text", { customer: "x".repeat(501) }],
  ])("refuses %s", (_label, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe("board schemas", () => {
  it("parses a card and refuses out-of-bound values", () => {
    expect(BoardCard.safeParse(card()).success).toBe(true);
    expect(BoardCard.safeParse(card({ waitingOn: "nobody" })).success).toBe(false);
    expect(BoardCard.safeParse(card({ title: "x".repeat(201) })).success).toBe(false);
    expect(BoardCard.safeParse(card({ version: -1 })).success).toBe(false);
    expect(BoardCard.safeParse(card({ titleSource: "model" })).success).toBe(false);
    expect(BoardCard.safeParse(card({ authorKind: "system" })).success).toBe(false);
  });

  it("a card needs a title or a description", () => {
    expect(
      CreateBoardCardRequest.safeParse({ title: "", description: "", clientMessageId: "c1" }).success,
    ).toBe(false);
    expect(CreateBoardCardRequest.safeParse({ description: "   ", clientMessageId: "c1" }).success).toBe(
      false,
    );
    expect(
      CreateBoardCardRequest.safeParse({ description: "Broken pump", clientMessageId: "c1" }).success,
    ).toBe(true);
    expect(CreateBoardCardRequest.safeParse({ title: "Broken pump", clientMessageId: "c1" }).success).toBe(
      true,
    );
    expect(CreateBoardCardRequest.safeParse({ title: "Broken pump" }).success).toBe(false);
  });

  it("a card update needs a change besides the expected version", () => {
    expect(UpdateBoardCardRequest.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(UpdateBoardCardRequest.safeParse({ expectedVersion: 1, waitingOn: "us" }).success).toBe(true);
    expect(
      UpdateBoardCardRequest.safeParse({ expectedVersion: 1, move: { columnId: COL, afterCardId: null } })
        .success,
    ).toBe(true);
    expect(UpdateBoardCardRequest.safeParse({ waitingOn: "us" }).success).toBe(false);
  });

  it("ships the four default columns, one per category", () => {
    expect(DEFAULT_BOARD_COLUMNS.map((c) => [c.name, c.category])).toEqual([
      ["Backlog", "backlog"],
      ["In progress", "started"],
      ["Done", "done"],
      ["Cancelled", "cancelled"],
    ]);
  });

  it("a snapshot bounds its column pages", () => {
    const snapshot = {
      board: {
        conversationId: CONV,
        templateId: null,
        prefix: null,
        namingRule: null,
        fields: [],
        version: 1,
      },
      columns: [
        {
          id: COL,
          conversationId: CONV,
          name: "Backlog",
          rank: "a0",
          category: "backlog",
          defaultWaitingOn: null,
        },
      ],
      cards: [{ columnId: COL, cards: [card()], hasMore: false }],
      lastSeq: 12,
    };
    expect(BoardSnapshot.safeParse(snapshot).success).toBe(true);
    const tooMany = {
      ...snapshot,
      cards: [{ columnId: COL, cards: Array.from({ length: 101 }, () => card()), hasMore: true }],
    };
    expect(BoardSnapshot.safeParse(tooMany).success).toBe(false);
  });
});

describe("channels gain a layout (older payloads still parse)", () => {
  it("a create request without layout is a text channel", () => {
    const parsed = CreateChannelRequest.parse({ name: "ops" });
    expect(parsed.layout).toBe("text");
    expect(CreateChannelRequest.parse({ name: "ops", layout: "board", templateId: TPL }).templateId).toBe(
      TPL,
    );
    expect(CreateChannelRequest.safeParse({ name: "ops", layout: "text", templateId: TPL }).success).toBe(
      false,
    );
    expect(CreateChannelRequest.safeParse({ name: "ops", layout: "voice" }).success).toBe(false);
  });

  it("a channel summary without layout parses", () => {
    const summary = {
      id: CONV,
      organizationId: USER,
      kind: "channel",
      name: "ops",
      slug: "ops",
      topic: null,
      visibility: "public",
      parentConversationId: null,
      rootMessageId: null,
      createdBy: USER,
      archivedAt: null,
      createdAt: NOW,
      isMember: true,
      memberCount: 1,
      latestMessageSeq: 0,
      lastReadSeq: 0,
      lastMessageAt: null,
      isDefault: false,
    };
    expect(ChannelSummary.parse(summary).layout).toBeUndefined();
    expect(ChannelSummary.parse({ ...summary, layout: "board" }).layout).toBe("board");
  });
});

describe("one card's contract round-trips (tracer)", () => {
  it("description and fields → title and body → BoardCard → board.card_upserted", () => {
    const description = "Broken pump\nsecond line";
    const fields = fieldValuesSchema(DEFS).parse({ customer: "Acme", priority: null });
    const title = renderCardTitle(RULE, { prefix: "EXP", number: 7, description, fields });
    const body = cardMessageBody({ title, description, fields, defs: DEFS });
    expect(body).toBe("EXP-0007 · Acme · Broken pump\n\nBroken pump\nsecond line\n\nCustomer: Acme");
    expect(PostMessageRequest.safeParse({ body }).success).toBe(true);
    const parsed = BoardCard.parse(card({ title, description, fields }));
    const event = BoardCardUpsertedEvent.parse({ card: parsed });
    expect(event.card.title).toBe("EXP-0007 · Acme · Broken pump");
  });

  it("the board event names and payloads", () => {
    expect(EventTypes.boardCardUpserted).toBe("board.card_upserted");
    expect(EventTypes.boardUpdated).toBe("board.updated");
    expect(EventTypes.boardColumnReranked).toBe("board.column_reranked");
    expect(
      BoardUpdatedEvent.safeParse({
        conversationId: CONV,
        board: {
          conversationId: CONV,
          templateId: TPL,
          prefix: "EXP",
          namingRule: RULE,
          fields: DEFS,
          version: 2,
        },
        columns: [],
      }).success,
    ).toBe(true);
    expect(
      BoardColumnRerankedEvent.safeParse({
        conversationId: CONV,
        columnId: COL,
        ranks: [{ messageId: MSG, rank: "a1" }],
      }).success,
    ).toBe(true);
  });
});
