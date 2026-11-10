import { beforeEach, describe, expect, it } from "vitest";
import {
  type AgentChannelBoardCard,
  type AgentChannelBoardCreateCard,
  type AgentChannelBoardPatchCard,
  type AgentChannelBoardRead,
  type AgentChannelBoardReadResponse,
  BOARD_CARD_DESCRIPTION_MAX,
  BOARD_CARD_TITLE_MAX,
  BOARD_WAITING_ON,
  type TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import {
  BOARD_TOOL_NAME,
  type BoardToolContext,
  registerBoardTool,
  resetBoardToolState,
} from "./board-tool.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import { createToolGuard } from "./tool-guard.js";

const BOARD = { untrustedOutput: false, sideEffecting: true };
const CARD = { untrustedOutput: false, sideEffecting: false };
const WEB = { untrustedOutput: true, sideEffecting: false };
const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const OTHER_BOT = "0199a6f0-0000-7000-8000-00000000a002";
const CHANNEL = "0199a6f0-0000-7000-8000-00000000c001";
/** The card whose thread the turn runs in (the thread root). */
const TURN_CARD = "0199a6f0-0000-7000-8000-00000000d001";
const ASKED = "0199a6f0-0000-7000-8000-00000000d003";
const BACKLOG = "0199a6f0-0000-7000-8000-0000000b0001";
const IN_PROGRESS = "0199a6f0-0000-7000-8000-0000000b0002";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${CHANNEL}:thread:${TURN_CARD}`;

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["web_search", "ocw_agent_card", "ocw_board_card"],
    toolFlags: { web_search: WEB, ocw_agent_card: CARD, ocw_board_card: BOARD },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

function card(over: Partial<AgentChannelBoardCard> = {}): AgentChannelBoardCard {
  return {
    messageId: TURN_CARD,
    conversationId: CHANNEL,
    columnId: BACKLOG,
    rank: "a0",
    waitingOn: "none",
    title: "Broken pump",
    titleSource: "user",
    description: "Customer says the pump is broken",
    number: null,
    fields: {},
    authorKind: "user",
    authorId: "0199a6f0-0000-7000-8000-00000000u001",
    replyCount: 1,
    lastReplyAt: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    movedAt: "2026-10-12T10:00:00.000Z",
    version: 3,
    ...over,
  };
}

const READ: AgentChannelBoardReadResponse = {
  board: {
    conversationId: CHANNEL,
    templateId: null,
    prefix: null,
    namingRule: null,
    fields: [],
    version: 1,
  },
  columns: [
    {
      id: BACKLOG,
      conversationId: CHANNEL,
      name: "Backlog",
      rank: "a0",
      category: "backlog",
      defaultWaitingOn: null,
    },
    {
      id: IN_PROGRESS,
      conversationId: CHANNEL,
      name: "In progress",
      rank: "a1",
      category: "started",
      defaultWaitingOn: null,
    },
  ],
  card: card(),
};

type Tool = {
  name: string;
  description: string;
  parameters: {
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { enum?: string[]; maxLength?: number }>;
  };
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

type Behaviour = {
  read?: (req: AgentChannelBoardRead) => Promise<AgentChannelBoardReadResponse>;
  create?: (req: AgentChannelBoardCreateCard) => Promise<{ card: AgentChannelBoardCard }>;
  patch?: (id: string, req: AgentChannelBoardPatchCard) => Promise<{ card: AgentChannelBoardCard }>;
};

function setup(behaviour: Behaviour = {}) {
  const reads: AgentChannelBoardRead[] = [];
  const creates: AgentChannelBoardCreateCard[] = [];
  const patches: Array<{ id: string; body: AgentChannelBoardPatchCard }> = [];
  const ids = new Map<string, string>();
  let seq = 0;
  const client = {
    boardRead: async (req: AgentChannelBoardRead) => {
      reads.push(req);
      return behaviour.read ? behaviour.read(req) : READ;
    },
    boardCreateCard: async (req: AgentChannelBoardCreateCard) => {
      creates.push(req);
      if (behaviour.create) return behaviour.create(req);
      const known = ids.get(req.idempotencyKey);
      const messageId = known ?? `0199a6f0-0000-7000-8000-0000000ea${String(++seq).padStart(3, "0")}`;
      ids.set(req.idempotencyKey, messageId);
      return {
        card: card({
          messageId,
          title: req.title ?? (req.description ?? "").split("\n")[0] ?? "",
          authorKind: "agent",
          authorId: req.agentId,
          version: 1,
        }),
      };
    },
    boardPatchCard: async (id: string, body: AgentChannelBoardPatchCard) => {
      patches.push({ id, body });
      if (behaviour.patch) return behaviour.patch(id, body);
      return {
        card: card({
          messageId: id,
          columnId: body.move?.columnId ?? BACKLOG,
          waitingOn: body.waitingOn ?? "none",
          version: body.expectedVersion + 1,
        }),
      };
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Array<{ factory: (ctx: BoardToolContext) => unknown; opts: unknown }> = [];
  const api = {
    registerTool: (factory: (ctx: BoardToolContext) => unknown, opts: unknown) =>
      registered.push({ factory, opts }),
  };
  const logs: string[] = [];
  registerBoardTool(api as never, {
    guard,
    client: () => client,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  const tool = (ctx: BoardToolContext = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) }) =>
    registered[0]?.factory(ctx) as Tool;
  const begin = (
    over: Partial<TurnContext> = {},
    eventId = "evt-1",
    threadRootId: string | null = TURN_CARD,
  ) =>
    guard.beginTurn(SESSION, {
      eventId,
      agentId: BOT,
      turn: turn(over),
      conversationId: CHANNEL,
      threadRootId,
      messageId: ASKED,
    });
  return { reads, creates, patches, guard, registered, tool, begin, logs };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("");

const NOT_TAINTED = "Not done: this turn read web or tool content, so it can no longer change the board.";

/** The API's 409 `board_card_version_conflict` with the current card in `error.details.card` (07.17 D-06). */
const conflictAt = (id: string, version: number, cardId = id) =>
  new AgentChannelHttpError(
    409,
    `/board/cards/${id}`,
    "409",
    "board_card_version_conflict",
    undefined,
    undefined,
    undefined,
    card({ messageId: cardId, version }),
  );

beforeEach(() => resetBoardToolState());

describe("ocw_board_card (07.1-13, BOARD-02, D-07, C-01, P-03)", () => {
  it("registers one tool whose JSON schema names no conversation, person or agent and no card text edit", () => {
    const { registered, tool } = setup();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.opts).toEqual({ name: BOARD_TOOL_NAME });
    const t = tool();
    expect(t.name).toBe("ocw_board_card");
    expect(t.parameters.required).toEqual(["action"]);
    expect(t.parameters.additionalProperties).toBe(false);
    expect(Object.keys(t.parameters.properties).sort()).toEqual([
      "action",
      "afterCardId",
      "cardId",
      "columnId",
      "description",
      "title",
      "waitingOn",
    ]);
    expect(t.parameters.properties.action?.enum).toEqual(["read", "create", "move", "set_waiting"]);
    expect(t.parameters.properties.waitingOn?.enum).toEqual([...BOARD_WAITING_ON]);
    expect(t.parameters.properties.title?.maxLength).toBe(BOARD_CARD_TITLE_MAX);
    expect(t.parameters.properties.description?.maxLength).toBe(BOARD_CARD_DESCRIPTION_MAX);
  });

  it("create sends the turn's event and agent with key <eventId>:board:1 and answers the new card id", async () => {
    const { creates, begin, tool, logs } = setup();
    begin();
    const r = await tool().execute("tc-1", { action: "create", description: "Order spare valve" });
    expect(text(r)).toBe("Card created. Card id: 0199a6f0-0000-7000-8000-0000000ea001.");
    expect(r.details).toEqual({ ok: true, cardId: "0199a6f0-0000-7000-8000-0000000ea001", version: 1 });
    expect(creates).toEqual([
      { eventId: "evt-1", agentId: BOT, idempotencyKey: "evt-1:board:1", description: "Order spare valve" },
    ]);
    // Logs carry ids and codes only, never card text.
    expect(logs.join("\n")).toContain("evt-1");
    expect(logs.join("\n")).not.toContain("spare valve");
  });

  it("the next create of the same turn uses :2; an OpenClaw retry of the same call keeps its key; a new turn restarts", async () => {
    const { creates, begin, tool } = setup();
    begin();
    const t = tool();
    await t.execute("tc-1", { action: "create", description: "First" });
    await t.execute("tc-2", { action: "create", title: "Second", columnId: IN_PROGRESS, waitingOn: "us" });
    await t.execute("tc-1", { action: "create", description: "First" });
    expect(creates.map((c) => c.idempotencyKey)).toEqual(["evt-1:board:1", "evt-1:board:2", "evt-1:board:1"]);
    expect(creates[1]).toEqual({
      eventId: "evt-1",
      agentId: BOT,
      idempotencyKey: "evt-1:board:2",
      title: "Second",
      description: "",
      columnId: IN_PROGRESS,
      waitingOn: "us",
    });
    begin({}, "evt-2");
    await tool().execute("tc-1", { action: "create", description: "Third" });
    expect(creates.at(-1)?.idempotencyKey).toBe("evt-2:board:1");
  });

  it("move without cardId reads the turn thread's card version, then moves that card", async () => {
    const { reads, patches, begin, tool } = setup();
    begin();
    const r = await tool().execute("tc-1", { action: "move", columnId: IN_PROGRESS });
    expect(text(r)).toBe("Card moved.");
    expect(reads).toEqual([{ eventId: "evt-1", agentId: BOT }]);
    expect(patches).toEqual([
      {
        id: TURN_CARD,
        body: {
          eventId: "evt-1",
          agentId: BOT,
          expectedVersion: 3,
          move: { columnId: IN_PROGRESS, afterCardId: null },
        },
      },
    ]);
    // The version the API answered is remembered: the next change needs no read.
    const w = await tool().execute("tc-2", { action: "set_waiting", waitingOn: "customer" });
    expect(text(w)).toBe("Waiting state set.");
    expect(reads).toHaveLength(1);
    expect(patches[1]).toEqual({
      id: TURN_CARD,
      body: { eventId: "evt-1", agentId: BOT, expectedVersion: 4, waitingOn: "customer" },
    });
  });

  it("a card the agent created in this conversation can be moved by its id, with the version it got", async () => {
    const { reads, patches, begin, tool } = setup();
    begin();
    const t = tool();
    await t.execute("tc-1", { action: "create", description: "Order spare valve" });
    const cardId = "0199a6f0-0000-7000-8000-0000000ea001";
    const r = await t.execute("tc-2", {
      action: "move",
      cardId,
      columnId: IN_PROGRESS,
      afterCardId: TURN_CARD,
    });
    expect(text(r)).toBe("Card moved.");
    expect(reads).toEqual([]);
    expect(patches[0]?.body).toEqual({
      eventId: "evt-1",
      agentId: BOT,
      expectedVersion: 1,
      move: { columnId: IN_PROGRESS, afterCardId: TURN_CARD },
    });
  });

  it("a card id that is neither the thread's card nor one the agent created here is refused locally", async () => {
    const { reads, patches, begin, tool } = setup();
    begin();
    const r = await tool().execute("tc-1", {
      action: "move",
      cardId: "0199a6f0-0000-7000-8000-0000000cafff",
      columnId: IN_PROGRESS,
    });
    expect(text(r)).toBe(
      "Not done: you can change this thread's card or a card you created in this conversation.",
    );
    expect(reads).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("move in a turn outside a card thread (flat) is refused locally; read reports there is no thread card", async () => {
    const { patches, begin, tool } = setup({ read: async () => ({ ...READ, card: null }) });
    begin({}, "evt-1", null);
    expect(text(await tool().execute("tc-1", { action: "move", columnId: IN_PROGRESS }))).toBe(
      "Not done: this turn is not in a card's thread; name the card id.",
    );
    expect(patches).toEqual([]);
    begin({}, "evt-2");
    expect(text(await tool().execute("tc-1", { action: "move", columnId: IN_PROGRESS }))).toBe(
      "Not done: this thread is not a card.",
    );
    expect(text(await tool().execute("tc-2", { action: "read" }))).toContain("This thread is not a card.");
    expect(patches).toEqual([]);
  });

  it("read returns column ids, names, categories and the turn card's id, title and waiting state as text", async () => {
    const { reads, begin, tool } = setup({
      read: async () => ({
        ...READ,
        card: card({ title: "Broken pump\nsee https://evil.example", waitingOn: "us" }),
      }),
    });
    begin();
    const r = text(await tool().execute("tc-1", { action: "read" }));
    expect(reads).toEqual([{ eventId: "evt-1", agentId: BOT }]);
    expect(r).toBe(
      [
        "Board columns:",
        `- Backlog (backlog), column id ${BACKLOG}`,
        `- In progress (started), column id ${IN_PROGRESS}`,
        `This thread's card: id ${TURN_CARD}, title "Broken pump see [link removed]", column Backlog, waiting on us.`,
      ].join("\n"),
    );
  });

  it("the tool never edits card text: title / description / fields on move or set_waiting are refused, never sent", async () => {
    const { reads, patches, begin, tool } = setup();
    begin();
    const t = tool();
    for (const extra of [
      { title: "New title" },
      { description: "New text" },
      { fields: { customer: "Acme" } },
    ]) {
      expect(text(await t.execute("tc-1", { action: "move", columnId: IN_PROGRESS, ...extra }))).toBe(
        "Not done: agents do not edit card text.",
      );
      expect(text(await t.execute("tc-2", { action: "set_waiting", waitingOn: "us", ...extra }))).toBe(
        "Not done: agents do not edit card text.",
      );
    }
    expect(reads).toEqual([]);
    expect(patches).toEqual([]);
    // Even a successful change sends no text key.
    await t.execute("tc-3", { action: "move", columnId: IN_PROGRESS });
    await t.execute("tc-4", { action: "set_waiting", waitingOn: "both" });
    for (const p of patches) {
      for (const k of ["title", "description", "fields"]) expect(p.body).not.toHaveProperty(k);
    }
  });

  it("an unknown action, a 201-char title or a parameter naming a conversation, person or agent: refused locally", async () => {
    const { creates, reads, patches, begin, tool } = setup();
    begin();
    const t = tool();
    expect(text(await t.execute("tc-1", { action: "delete" }))).toBe(
      'Not done: action must be "read", "create", "move" or "set_waiting".',
    );
    expect(text(await t.execute("tc-2", { action: "create", title: "x".repeat(201) }))).toBe(
      "Not done: the card is not valid (title).",
    );
    expect(text(await t.execute("tc-3", { action: "create" }))).toBe(
      "Not done: give the card a title or a description.",
    );
    for (const key of ["conversationId", "channelId", "userId", "agentId", "eventId", "boardId"]) {
      expect(
        text(
          await t.execute("tc-4", {
            action: "create",
            description: "x",
            [key]: "0199a6f0-0000-7000-8000-00000000c999",
          }),
        ),
        key,
      ).toBe(`Not done: the board is always this conversation's; ${key} is not accepted.`);
    }
    expect(text(await t.execute("tc-5", { action: "read", extra: 1 }))).toBe(
      "Not done: unknown parameter (extra).",
    );
    expect(text(await t.execute("tc-6", { action: "set_waiting", waitingOn: "soon" }))).toBe(
      "Not done: the change is not valid (waitingOn).",
    );
    expect(creates).toEqual([]);
    expect(reads).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("without an active turn, when the turn does not offer it, or for another bot's context: refused, no request", async () => {
    const { creates, begin, tool } = setup();
    expect(text(await tool().execute("tc-1", { action: "create", description: "x" }))).toBe(
      "Not done: there is no active conversation turn.",
    );
    begin({ tools: ["web_search", "ocw_agent_card"], toolFlags: { web_search: WEB, ocw_agent_card: CARD } });
    expect(text(await tool().execute("tc-2", { action: "create", description: "x" }))).toBe(
      "Not done: the board tool is not offered here.",
    );
    begin();
    const other = tool({ sessionKey: SESSION, agentId: openClawAgentIdFor(OTHER_BOT) });
    expect(text(await other.execute("tc-3", { action: "create", description: "x" }))).toBe(
      "Not done: there is no active conversation turn.",
    );
    expect(creates).toEqual([]);
  });

  describe.each([
    [
      "tainted",
      (t: { tainted: boolean; sessionOutputRead: boolean }): void => {
        t.tainted = true;
      },
    ],
    [
      "session-read",
      (t: { tainted: boolean; sessionOutputRead: boolean }): void => {
        t.sessionOutputRead = true;
      },
    ],
  ] as const)(
    "a %s turn (07.17 D-06, D-12, PD-11: the route decides moves; create stays refused here)",
    (_kind, mark) => {
      const restricted = (s: ReturnType<typeof setup>) => {
        s.begin();
        const t = s.guard.activeTurn(SESSION);
        if (!t) throw new Error("no turn");
        mark(t);
        return t;
      };

      it("create and read are refused locally with the tainted sentence, nothing posted; the gate lets the call reach the tool", async () => {
        const s = setup();
        restricted(s);
        for (const params of [{ action: "create", description: "x" }, { action: "read" }]) {
          expect(text(await s.tool().execute("tc-1", params))).toBe(NOT_TAINTED);
        }
        const gate = await s.guard.beforeToolCall(
          { toolName: "ocw_board_card", toolCallId: "tc-9", params: { action: "create" } },
          { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) },
        );
        expect(gate).toBeUndefined();
        expect(s.creates).toEqual([]);
        expect(s.reads).toEqual([]);
        expect(s.patches).toEqual([]);
      });

      it("move of the thread's card posts its PATCH without a read (the read is refused on such a turn), then set_waiting uses the answered version", async () => {
        const s = setup();
        restricted(s);
        expect(text(await s.tool().execute("tc-1", { action: "move", columnId: IN_PROGRESS }))).toBe(
          "Card moved.",
        );
        expect(s.reads).toEqual([]);
        expect(s.patches).toEqual([
          {
            id: TURN_CARD,
            body: {
              eventId: "evt-1",
              agentId: BOT,
              expectedVersion: 1,
              move: { columnId: IN_PROGRESS, afterCardId: null },
            },
          },
        ]);
        expect(text(await s.tool().execute("tc-2", { action: "set_waiting", waitingOn: "us" }))).toBe(
          "Waiting state set.",
        );
        expect(s.patches[1]?.body).toEqual({
          eventId: "evt-1",
          agentId: BOT,
          expectedVersion: 2,
          waitingOn: "us",
        });
      });

      it("a version conflict is retried ONCE with the current version from the 409's details", async () => {
        const s = setup({
          patch: async (id, body) => {
            if (body.expectedVersion !== 5) throw conflictAt(id, 5);
            return { card: card({ messageId: id, waitingOn: "customer", version: 6 }) };
          },
        });
        restricted(s);
        const r = await s.tool().execute("tc-1", { action: "set_waiting", waitingOn: "customer" });
        expect(text(r)).toBe("Waiting state set.");
        expect(r.details).toEqual({ ok: true, cardId: TURN_CARD, version: 6 });
        expect(s.patches.map((p) => p.body.expectedVersion)).toEqual([1, 5]);
        expect(s.reads).toEqual([]);
      });

      it("a second conflict, or one whose details carry no card (or another card), answers the conflict text: never a third PATCH", async () => {
        for (const thrown of [
          (id: string) => conflictAt(id, 7),
          (id: string) =>
            new AgentChannelHttpError(409, `/board/cards/${id}`, "409", "board_card_version_conflict"),
          (id: string) => conflictAt(id, 7, "0199a6f0-0000-7000-8000-0000000cafff"),
        ]) {
          resetBoardToolState();
          let n = 0;
          const s = setup({
            patch: async (id) => {
              n++;
              throw thrown(id);
            },
          });
          restricted(s);
          expect(text(await s.tool().execute("tc-1", { action: "move", columnId: IN_PROGRESS }))).toBe(
            "Not done: the card changed since you last saw it. Try again.",
          );
          expect(n).toBeLessThanOrEqual(2);
          expect(s.reads).toEqual([]);
        }
      });

      it("the route's tainted refusal (no exemption: not this bot's automation card, or no profile flag) reads the tainted sentence", async () => {
        const s = setup({
          patch: async (id) => {
            throw new AgentChannelHttpError(403, `/board/cards/${id}`, "403 secret", "tainted");
          },
        });
        restricted(s);
        expect(text(await s.tool().execute("tc-1", { action: "move", columnId: IN_PROGRESS }))).toBe(
          NOT_TAINTED,
        );
        expect(s.patches).toHaveLength(1);
      });

      it("a card id that is neither the thread's card nor one created here is still refused locally", async () => {
        const s = setup();
        restricted(s);
        const r = await s.tool().execute("tc-1", {
          action: "move",
          cardId: "0199a6f0-0000-7000-8000-0000000cafff",
          columnId: IN_PROGRESS,
        });
        expect(text(r)).toBe(
          "Not done: you can change this thread's card or a card you created in this conversation.",
        );
        expect(s.patches).toEqual([]);
      });
    },
  );

  it("an untainted turn's conflict is not retried, even when the 409 carries the current card (unchanged)", async () => {
    const { patches, reads, begin, tool } = setup({
      patch: async (id) => {
        throw conflictAt(id, 9);
      },
    });
    begin();
    expect(text(await tool().execute("tc-1", { action: "move", columnId: IN_PROGRESS }))).toBe(
      "Not done: the card changed since you last saw it. Try again.",
    );
    expect(patches.map((p) => p.body.expectedVersion)).toEqual([3]);
    expect(reads).toHaveLength(1);
  });

  it("API refusals answer short fixed texts, never the API body; logs carry ids and status codes only", async () => {
    const fail = (status: number, code?: string) => async () => {
      throw new AgentChannelHttpError(
        status,
        "/board/cards",
        `POST /board/cards → ${status} {"error":{"code":"${code ?? ""}","message":"secret detail"}}`,
        code,
      );
    };
    const cases: Array<[number, string | undefined, string]> = [
      [403, "tainted", "Not done: this turn read web or tool content, so it can no longer change the board."],
      [403, "cap_reached", "Not done: this turn reached its tool call limit."],
      [403, "not_in_turn", "Not done: the board tool is not offered here."],
      [403, "no_trigger", "Not done: this conversation turn is no longer active."],
      [403, "not_a_member", "Not done: you may not change this board."],
      [400, "not_a_board", "Not done: this conversation is not a board."],
      [400, "invalid_field_values", "Not done: the workspace did not accept the card."],
      [404, "card_not_in_board", "Not done: that card or column is not on this board."],
      [410, "channel_archived", "Not done: this board is archived."],
      [500, undefined, "Not done: the workspace could not be reached. Try again later."],
    ];
    for (const [status, code, expected] of cases) {
      resetBoardToolState();
      const { begin, tool, logs } = setup({ create: fail(status, code) });
      begin();
      const r = text(await tool().execute("tc-1", { action: "create", description: "x" }));
      expect(r, `${status} ${code}`).toBe(expected);
      expect(r).not.toContain("secret");
      expect(logs.join("\n")).toContain(String(status));
      expect(logs.join("\n")).not.toContain("secret");
    }
  });

  it("a version conflict answers the fixed conflict text and forgets the version (the next move reads again)", async () => {
    let conflict = true;
    const { reads, begin, tool } = setup({
      patch: async (id, body) => {
        if (conflict) {
          conflict = false;
          throw new AgentChannelHttpError(409, `/board/cards/${id}`, "409", "board_card_version_conflict");
        }
        return { card: card({ messageId: id, columnId: IN_PROGRESS, version: body.expectedVersion + 1 }) };
      },
    });
    begin();
    expect(text(await tool().execute("tc-1", { action: "move", columnId: IN_PROGRESS }))).toBe(
      "Not done: the card changed since you last saw it. Try again.",
    );
    expect(text(await tool().execute("tc-2", { action: "move", columnId: IN_PROGRESS }))).toBe("Card moved.");
    expect(reads).toHaveLength(2);
  });
});

describe("Board mirror parity (plugin ↔ packages/contracts/src/board.ts)", () => {
  const contractsPath = new URL("../../../packages/contracts/src/board.ts", import.meta.url).href;

  it("waiting states and the title / description bounds are identical", async () => {
    const c = (await import(contractsPath)) as {
      WaitingOn: { options: string[] };
      BOARD_CARD_TITLE_MAX: number;
      BOARD_CARD_DESCRIPTION_MAX: number;
    };
    expect([...BOARD_WAITING_ON]).toEqual(c.WaitingOn.options);
    expect(BOARD_CARD_TITLE_MAX).toBe(c.BOARD_CARD_TITLE_MAX);
    expect(BOARD_CARD_DESCRIPTION_MAX).toBe(c.BOARD_CARD_DESCRIPTION_MAX);
  });
});
