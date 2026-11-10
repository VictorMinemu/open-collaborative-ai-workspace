import { describe, expect, it } from "vitest";
import {
  AgentChannelBoardCardResponse,
  AgentChannelBoardCreateCard,
  AgentChannelBoardPatchCard,
  AgentChannelBoardRead,
  AgentChannelBoardReadResponse,
} from "./agent-channel";
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
  CreateBoardColumnRequest,
  CreateRecordTemplateRequest,
  cardMessageBody,
  DEFAULT_BOARD_COLUMNS,
  DeleteBoardColumnQuery,
  fieldValuesSchema,
  firstLine,
  parseNamingRule,
  RecordTemplate,
  RecordTemplateList,
  RecordTemplateListQuery,
  renderCardTitle,
  UpdateBoardCardRequest,
  UpdateBoardColumnRequest,
  UpdateRecordTemplateRequest,
} from "./board";
import { BUILTIN_TOOLS, isDangerousToolName } from "./bot-capabilities";
import { ChannelSummary, CreateChannelRequest, extractMentionHandles, PostMessageRequest } from "./chat";
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

  it("07.17-16 (P2): keeps the word joiner that defuses a mention in a bot-written title; other format characters go", () => {
    const body = cardMessageBody({ title: "⁠@sam urgent‮", description: "", fields: {}, defs: DEFS });
    expect(body).toBe("⁠@sam urgent");
    expect(extractMentionHandles(body)).toEqual([]);
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

  it("column requests: bounded names, Keep as is by default, a change required, moveCardsTo optional", () => {
    expect(CreateBoardColumnRequest.parse({ name: " Review ", category: "started" })).toEqual({
      name: "Review",
      category: "started",
      defaultWaitingOn: null,
    });
    expect(CreateBoardColumnRequest.safeParse({ name: "x".repeat(61), category: "started" }).success).toBe(
      false,
    );
    expect(CreateBoardColumnRequest.safeParse({ name: "Review", category: "archived" }).success).toBe(false);
    expect(UpdateBoardColumnRequest.safeParse({}).success).toBe(false);
    expect(UpdateBoardColumnRequest.parse({ defaultWaitingOn: null })).toEqual({ defaultWaitingOn: null });
    expect(UpdateBoardColumnRequest.parse({ afterColumnId: null })).toEqual({ afterColumnId: null });
    expect(DeleteBoardColumnQuery.parse({})).toEqual({});
    expect(DeleteBoardColumnQuery.safeParse({ moveCardsTo: "not-an-id" }).success).toBe(false);
    expect(DeleteBoardColumnQuery.parse({ moveCardsTo: COL })).toEqual({ moveCardsTo: COL });
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

describe("record templates", () => {
  const template = {
    name: "Case files",
    description: "Customer case files",
    prefix: "EXP",
    namingRule: RULE,
    fields: [{ key: "customer", label: "Customer", type: "text", required: true }],
    columns: [
      { name: "Intake", category: "backlog" },
      { name: "Waiting for customer", category: "started", defaultWaitingOn: "customer" },
      { name: "Closed", category: "done" },
    ],
  };

  it("parses a complete template and defaults to organization-wide", () => {
    const parsed = CreateRecordTemplateRequest.parse(template);
    expect(parsed.unitId).toBeNull();
    expect(parsed.columns[0]?.defaultWaitingOn).toBeNull();
    expect(parsed.columns[1]?.defaultWaitingOn).toBe("customer");
    expect(CreateRecordTemplateRequest.parse({ ...template, unitId: TPL }).unitId).toBe(TPL);
  });

  it("without columns a template gets the default set", () => {
    const { columns: _omit, ...rest } = template;
    expect(CreateRecordTemplateRequest.parse(rest).columns.map((c) => c.name)).toEqual(
      DEFAULT_BOARD_COLUMNS.map((c) => c.name),
    );
  });

  const sixtyChars = "x".repeat(60);
  it.each([
    ["a lowercase prefix", { prefix: "exp" }],
    ["a prefix over 8 characters", { prefix: "TOOLONGPREFIX" }],
    [
      "duplicate field keys",
      {
        fields: [
          { key: "customer", label: "Customer", type: "text" },
          { key: "customer", label: "Client", type: "text" },
        ],
      },
    ],
    ["a select field without options", { fields: [{ key: "customer", label: "Customer", type: "select" }] }],
    [
      "options on a text field",
      { fields: [{ key: "customer", label: "Customer", type: "text", options: ["a"] }] },
    ],
    ["zero columns", { columns: [] }],
    [
      "21 columns",
      { columns: Array.from({ length: 21 }, (_, i) => ({ name: `Column ${i}`, category: "backlog" })) },
    ],
    [
      "duplicate column names (case-insensitive)",
      {
        columns: [
          { name: "Intake", category: "backlog" },
          { name: "intake ", category: "started" },
        ],
      },
    ],
    ["a column name over 60 characters", { columns: [{ name: `${sixtyChars}x`, category: "backlog" }] }],
    ["a rule naming an undefined field", { namingRule: "{field:priority} · {summary}" }],
    ["a rule with an unknown token", { namingRule: "{nope}" }],
    ["a {prefix} rule without a prefix", { prefix: null }],
    ["an empty name", { name: "  " }],
    ["a name over 80 characters", { name: "n".repeat(81) }],
    ["a description over 500 characters", { description: "d".repeat(501) }],
  ])("refuses %s", (_label, over) => {
    expect(CreateRecordTemplateRequest.safeParse({ ...template, ...over }).success).toBe(false);
  });

  it("a template without prefix or rule is valid (typed titles, no numbering)", () => {
    expect(
      CreateRecordTemplateRequest.safeParse({ ...template, prefix: null, namingRule: null }).success,
    ).toBe(true);
  });

  it("an update names the version it saw and changes something", () => {
    expect(UpdateRecordTemplateRequest.safeParse({ name: "Orders" }).success).toBe(false);
    expect(UpdateRecordTemplateRequest.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(UpdateRecordTemplateRequest.safeParse({ expectedVersion: 1, name: "Orders" }).success).toBe(true);
    expect(UpdateRecordTemplateRequest.safeParse({ expectedVersion: 1, prefix: "exp" }).success).toBe(false);
    expect(UpdateRecordTemplateRequest.safeParse({ expectedVersion: 1, columns: [] }).success).toBe(false);
  });

  it("an update checks the rule against the fields it carries, the grammar alone otherwise", () => {
    expect(
      UpdateRecordTemplateRequest.safeParse({
        expectedVersion: 1,
        namingRule: "{field:customer}",
        fields: [],
      }).success,
    ).toBe(false);
    expect(
      UpdateRecordTemplateRequest.safeParse({ expectedVersion: 1, namingRule: "{field:customer}" }).success,
    ).toBe(true);
    expect(UpdateRecordTemplateRequest.safeParse({ expectedVersion: 1, namingRule: "{nope}" }).success).toBe(
      false,
    );
  });

  it("a stored template and the list parse", () => {
    const stored = {
      ...CreateRecordTemplateRequest.parse(template),
      id: TPL,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(RecordTemplate.safeParse(stored).success).toBe(true);
    expect(RecordTemplateList.safeParse({ templates: [stored], canManage: false }).success).toBe(true);
    expect(RecordTemplateListQuery.parse({})).toEqual({});
    expect(RecordTemplateListQuery.safeParse({ unitId: "nope" }).success).toBe(false);
  });
});

describe("Agent Channel board schemas (D-07, P-03)", () => {
  const AGENT = "0199a000-0000-7000-8000-0000000000a1";
  const EVENT = "0199a000-0000-7000-8000-0000000000e1";

  it("create: idempotency key required, bounded title, conversation and human never taken from the body", () => {
    const ok = {
      eventId: EVENT,
      agentId: AGENT,
      idempotencyKey: `${EVENT}:board:1`,
      description: "Broken pump",
    };
    expect(AgentChannelBoardCreateCard.safeParse(ok).success).toBe(true);
    const { idempotencyKey: _k, ...noKey } = ok;
    expect(AgentChannelBoardCreateCard.safeParse(noKey).success).toBe(false);
    expect(AgentChannelBoardCreateCard.safeParse({ ...ok, idempotencyKey: "k".repeat(121) }).success).toBe(
      false,
    );
    expect(AgentChannelBoardCreateCard.safeParse({ ...ok, title: "x".repeat(201) }).success).toBe(false);
    expect(AgentChannelBoardCreateCard.safeParse({ ...ok, description: "", title: undefined }).success).toBe(
      false,
    );
    const parsed = AgentChannelBoardCreateCard.parse({ ...ok, conversationId: CONV, userId: USER });
    expect(parsed).not.toHaveProperty("conversationId");
    expect(parsed).not.toHaveProperty("userId");
  });

  it("patch: refuses no change, accepts a move to the top", () => {
    const base = { eventId: EVENT, agentId: AGENT, expectedVersion: 3 };
    expect(AgentChannelBoardPatchCard.safeParse(base).success).toBe(false);
    expect(
      AgentChannelBoardPatchCard.safeParse({ ...base, move: { columnId: COL, afterCardId: null } }).success,
    ).toBe(true);
    expect(AgentChannelBoardPatchCard.safeParse({ ...base, waitingOn: "customer" }).success).toBe(true);
    expect(AgentChannelBoardPatchCard.safeParse({ ...base, waitingOn: "nobody" }).success).toBe(false);
    const parsed = AgentChannelBoardPatchCard.parse({ ...base, waitingOn: "us", title: "renamed" });
    expect(parsed).not.toHaveProperty("title");
  });

  it("read and responses", () => {
    expect(AgentChannelBoardRead.safeParse({ eventId: EVENT, agentId: AGENT }).success).toBe(true);
    expect(AgentChannelBoardRead.safeParse({ agentId: AGENT }).success).toBe(false);
    const board = {
      conversationId: CONV,
      templateId: null,
      prefix: null,
      namingRule: null,
      fields: [],
      version: 1,
    };
    expect(AgentChannelBoardReadResponse.safeParse({ board, columns: [], card: null }).success).toBe(true);
    expect(AgentChannelBoardCardResponse.safeParse({ card: card() }).success).toBe(true);
  });
});

describe("ocw_board_card", () => {
  it("is a built-in tool name and never dangerous", () => {
    expect(BUILTIN_TOOLS.boardCard).toBe("ocw_board_card");
    expect(isDangerousToolName(BUILTIN_TOOLS.boardCard)).toBe(false);
  });
});
