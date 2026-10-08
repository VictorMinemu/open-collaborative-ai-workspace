import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_CARD_KINDS,
  AGENT_CARD_ROUTE_PREFIXES,
  AGENT_CARD_STATUSES,
  type AgentChannelPatchCard,
  type AgentChannelPostCard,
  type AgentChannelPostCardResponse,
  isAgentCardRoute,
  type TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import { CARD_TOOL_NAME, type CardToolContext, registerCardTool, resetCardToolState } from "./card-tool.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import { createToolGuard } from "./tool-guard.js";

const CARD = { untrustedOutput: false, sideEffecting: false };
const WEB = { untrustedOutput: true, sideEffecting: false };
const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const OTHER_BOT = "0199a6f0-0000-7000-8000-00000000a002";
const CHANNEL = "0199a6f0-0000-7000-8000-00000000c001";
const ROOT = "0199a6f0-0000-7000-8000-00000000d001";
const ASKED = "0199a6f0-0000-7000-8000-00000000d003";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${CHANNEL}:thread:${ROOT}`;

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["web_search", "ocw_agent_card"],
    toolFlags: { web_search: WEB, ocw_agent_card: CARD },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

const deployCard = (over: Record<string, unknown> = {}) => ({
  kind: "deployment",
  title: "Deploy api v2.3",
  fields: [{ label: "Environment", value: "production" }],
  status: "running",
  actions: [
    { kind: "open", label: "Open", target: "/work-zone" },
    { kind: "follow", label: "Follow" },
  ],
  summary: "Deploying api v2.3 to production",
  ...over,
});

type Tool = {
  name: string;
  description: string;
  parameters: {
    required: string[];
    properties: {
      action: { enum: string[] };
      cardId: { maxLength: number };
      card: {
        required: string[];
        properties: {
          kind: { enum: string[] };
          title: { maxLength: number };
          summary: { maxLength: number };
          fields: { maxItems: number };
          actions: { maxItems: number };
          status: { enum: string[] };
        };
      };
      patch: { properties: Record<string, unknown> };
    };
  };
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

type Behaviour = {
  post?: (req: AgentChannelPostCard) => Promise<AgentChannelPostCardResponse>;
  patch?: (id: string, req: AgentChannelPatchCard) => Promise<{ messageId: string; version: number }>;
};

function setup(behaviour: Behaviour = {}) {
  const posts: AgentChannelPostCard[] = [];
  const patches: Array<{ id: string; body: AgentChannelPatchCard }> = [];
  const ids = new Map<string, string>();
  let seq = 0;
  const client = {
    postCard: async (req: AgentChannelPostCard) => {
      posts.push(req);
      if (behaviour.post) return behaviour.post(req);
      const known = ids.get(req.idempotencyKey);
      const messageId = known ?? `0199a6f0-0000-7000-8000-0000000ca${String(++seq).padStart(3, "0")}`;
      ids.set(req.idempotencyKey, messageId);
      return { messageId, created: !known, version: 1 };
    },
    patchCard: async (id: string, body: AgentChannelPatchCard) => {
      patches.push({ id, body });
      if (behaviour.patch) return behaviour.patch(id, body);
      return { messageId: id, version: body.patch.expectedVersion + 1 };
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Array<{ factory: (ctx: CardToolContext) => unknown; opts: unknown }> = [];
  const api = {
    registerTool: (factory: (ctx: CardToolContext) => unknown, opts: unknown) =>
      registered.push({ factory, opts }),
  };
  const logs: string[] = [];
  registerCardTool(api as never, {
    guard,
    client: () => client,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  const tool = (ctx: CardToolContext = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) }) =>
    registered[0]?.factory(ctx) as Tool;
  const begin = (over: Partial<TurnContext> = {}, eventId = "evt-1", agentId = BOT) =>
    guard.beginTurn(SESSION, {
      eventId,
      agentId,
      turn: turn(over),
      conversationId: CHANNEL,
      threadRootId: ROOT,
      messageId: ASKED,
    });
  return { posts, patches, guard, registered, tool, begin, logs };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("");

beforeEach(() => resetCardToolState());

describe("ocw_agent_card (06-14, D-07, AGENT-04)", () => {
  it("every schema pattern compiles as a Unicode regex, as the cell's JSON-schema validator compiles it", () => {
    const patterns: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object")
        for (const [k, v] of Object.entries(node)) {
          if (k === "pattern" && typeof v === "string") patterns.push(v);
          else walk(v);
        }
    };
    walk(setup().tool().parameters);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const re = new RegExp(pattern, "u");
      expect(re.test("/work-zone/abc")).toBe(true);
      expect(re.test("https://evil.example/work-zone")).toBe(false);
    }
  });

  it("registers one tool whose JSON schema mirrors the AgentCardInput bounds", () => {
    const { registered, tool } = setup();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.opts).toEqual({ name: CARD_TOOL_NAME });
    const t = tool();
    expect(t.name).toBe("ocw_agent_card");
    expect(t.description).toMatch(/card/i);
    const p = t.parameters.properties;
    expect(t.parameters.required).toEqual(["action"]);
    expect(p.action.enum).toEqual(["create", "update"]);
    expect(p.card.required).toEqual(["kind", "title", "fields", "status", "actions", "summary"]);
    expect(p.card.properties.kind.enum).toEqual([
      "work_zone",
      "approval",
      "report",
      "artifact",
      "automation",
      "deployment",
      "pr",
      "generic",
    ]);
    expect(p.card.properties.status.enum).toEqual([
      "info",
      "pending",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]);
    expect(p.card.properties.title.maxLength).toBe(200);
    expect(p.card.properties.summary.maxLength).toBe(2000);
    expect(p.card.properties.fields.maxItems).toBe(12);
    expect(p.card.properties.actions.maxItems).toBe(4);
    expect(Object.keys(p.patch.properties).sort()).toEqual(["fields", "status", "summary", "title"]);
  });

  it("create posts with the trusted turn's agent, conversation, thread and message, never the params' ids", async () => {
    const { posts, begin, tool, logs } = setup();
    begin();
    const r = await tool().execute("tc-1", {
      action: "create",
      card: deployCard(),
      // Whatever the model adds is ignored: the schema has no such fields and the binding comes from the turn.
      conversationId: "0199a6f0-0000-7000-8000-00000000c999",
      agentId: OTHER_BOT,
    });
    expect(text(r)).toMatch(/^Card posted\./);
    expect(text(r)).toContain("0199a6f0-0000-7000-8000-0000000ca001");
    expect(posts).toEqual([
      {
        agentId: BOT,
        conversationId: CHANNEL,
        threadRootId: ROOT,
        inReplyToMessageId: ASKED,
        idempotencyKey: "evt-1:card:0",
        card: deployCard(),
      },
    ]);
    // Logs carry ids and codes only, never card content.
    expect(logs.join("\n")).not.toContain("Deploy api");
    expect(logs.join("\n")).not.toContain("production");
  });

  it("a second call in the turn posts a second card (n+1); an OpenClaw retry of the same call reuses its key", async () => {
    const { posts, begin, tool } = setup();
    begin();
    const t = tool();
    await t.execute("tc-1", { action: "create", card: deployCard() });
    await t.execute("tc-2", { action: "create", card: deployCard({ title: "Second" }) });
    const retried = await t.execute("tc-1", { action: "create", card: deployCard() });
    expect(posts.map((p) => p.idempotencyKey)).toEqual(["evt-1:card:0", "evt-1:card:1", "evt-1:card:0"]);
    expect(text(retried)).toMatch(/^Card posted\./);
    // A new turn starts counting again under its own event id.
    begin({}, "evt-2");
    await tool().execute("tc-1", { action: "create", card: deployCard() });
    expect(posts.at(-1)?.idempotencyKey).toBe("evt-2:card:0");
  });

  it("update sends the last version this cell saw and answers Card updated.", async () => {
    const { patches, begin, tool } = setup();
    begin();
    const t = tool();
    await t.execute("tc-1", { action: "create", card: deployCard() });
    const cardId = "0199a6f0-0000-7000-8000-0000000ca001";
    const r1 = await t.execute("tc-2", { action: "update", cardId, patch: { status: "succeeded" } });
    expect(text(r1)).toBe("Card updated.");
    // A later turn of the same bot in the same conversation continues from version 2.
    begin({}, "evt-2");
    const r2 = await tool().execute("tc-1", {
      action: "update",
      cardId,
      patch: { summary: "Deployed api v2.3", expectedVersion: 99 },
    });
    expect(text(r2)).toBe("Card updated.");
    expect(patches).toEqual([
      { id: cardId, body: { agentId: BOT, patch: { status: "succeeded", expectedVersion: 1 } } },
      { id: cardId, body: { agentId: BOT, patch: { summary: "Deployed api v2.3", expectedVersion: 2 } } },
    ]);
  });

  it("a 409 version conflict answers with the fixed conflict text, never the API body", async () => {
    const { begin, tool } = setup({
      patch: async () => {
        throw new AgentChannelHttpError(
          409,
          "/cards/x",
          'PATCH /cards/x → 409 {"error":{"code":"card_version_conflict","message":"secret detail"}}',
          "card_version_conflict",
        );
      },
    });
    begin();
    const t = tool();
    await t.execute("tc-1", { action: "create", card: deployCard() });
    const r = text(
      await t.execute("tc-2", {
        action: "update",
        cardId: "0199a6f0-0000-7000-8000-0000000ca001",
        patch: { status: "failed" },
      }),
    );
    expect(r).toBe("The card changed since you last saw it; not updated.");
    expect(r).not.toContain("secret");
  });

  it("refuses locally, with no request, an update of a card this bot did not post in this conversation", async () => {
    const { posts, patches, begin, guard, tool } = setup();
    begin();
    const r = await tool().execute("tc-1", {
      action: "update",
      cardId: "0199a6f0-0000-7000-8000-0000000cafff",
      patch: { status: "failed" },
    });
    expect(text(r)).toMatch(/^Not updated/);
    // A card posted in another conversation cannot be updated from this one.
    await tool().execute("tc-2", { action: "create", card: deployCard() });
    guard.beginTurn(SESSION, {
      eventId: "evt-9",
      agentId: BOT,
      turn: turn(),
      conversationId: "0199a6f0-0000-7000-8000-00000000c009",
      threadRootId: null,
      messageId: "0199a6f0-0000-7000-8000-00000000d009",
    });
    const elsewhere = await tool().execute("tc-1", {
      action: "update",
      cardId: "0199a6f0-0000-7000-8000-0000000ca001",
      patch: { status: "failed" },
    });
    expect(text(elsewhere)).toMatch(/^Not updated/);
    expect(posts).toHaveLength(1);
    expect(patches).toEqual([]);
  });

  it("without an active turn, when the turn does not offer it, or for another bot's context: refused, no request", async () => {
    const { posts, begin, tool } = setup();
    expect(text(await tool().execute("tc-1", { action: "create", card: deployCard() }))).toMatch(
      /^Not posted/,
    );
    begin({ tools: ["web_search"], toolFlags: { web_search: WEB } });
    expect(text(await tool().execute("tc-2", { action: "create", card: deployCard() }))).toMatch(
      /^Not posted/,
    );
    begin();
    const other = tool({ sessionKey: SESSION, agentId: openClawAgentIdFor(OTHER_BOT) });
    expect(text(await other.execute("tc-3", { action: "create", card: deployCard() }))).toMatch(
      /^Not posted/,
    );
    expect(posts).toEqual([]);
  });

  it("an external Open target (or any URL-like target) is refused locally with a fixed text", async () => {
    const { posts, begin, tool } = setup();
    begin();
    for (const target of [
      "https://evil.example/login",
      "//evil.example",
      "/chat/../../evil",
      "javascript:alert(1)",
    ]) {
      const r = await tool().execute("tc-1", {
        action: "create",
        card: deployCard({ actions: [{ kind: "open", label: "Open", target }] }),
      });
      expect(text(r), target).toBe(
        "Not posted: an Open action can only lead to a page of this workspace, never to an external link.",
      );
    }
    expect(posts).toEqual([]);
  });

  it("an invalid card or patch is refused locally with the field path only", async () => {
    const { posts, patches, begin, tool } = setup();
    begin();
    const t = tool();
    expect(text(await t.execute("tc-1", { action: "create", card: deployCard({ title: "" }) }))).toBe(
      "Not posted: the card is not valid (card.title).",
    );
    expect(text(await t.execute("tc-2", { action: "create" }))).toBe(
      "Not posted: the card is not valid (card).",
    );
    expect(text(await t.execute("tc-3", { action: "update", cardId: "x", patch: {} }))).toBe(
      "Not updated: the change is not valid (patch).",
    );
    expect(text(await t.execute("tc-4", { action: "delete" }))).toMatch(/^Not done/);
    expect(posts).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("API refusals on create become short fixed texts; logs carry ids and status codes only", async () => {
    const { begin, tool, logs } = setup({
      post: async () => {
        throw new AgentChannelHttpError(
          403,
          "/cards",
          'POST /cards → 403 {"error":{"code":"forbidden","message":"secret detail"}}',
          "forbidden",
        );
      },
    });
    begin();
    const r = text(await tool().execute("tc-1", { action: "create", card: deployCard() }));
    expect(r).toBe("Not posted: you may not post in this conversation.");
    expect(logs.join("\n")).toContain("403");
    expect(logs.join("\n")).not.toContain("secret");
  });
});

describe("Agent Card mirror parity (plugin ↔ packages/contracts/src/agent-cards.ts)", () => {
  // Non-literal specifier: the contracts package lives outside this package (and is not type-checked from here).
  const contractsPath = new URL("../../../packages/contracts/src/agent-cards.ts", import.meta.url).href;

  it("kinds, statuses, route prefixes and the internal-route rule are identical", async () => {
    const c = (await import(contractsPath)) as {
      AGENT_CARD_ROUTE_PREFIXES: readonly string[];
      AgentCardKind: { options: string[] };
      AgentCardStatus: { options: string[] };
      isAgentCardRoute: (v: string) => boolean;
    };
    expect([...AGENT_CARD_ROUTE_PREFIXES]).toEqual([...c.AGENT_CARD_ROUTE_PREFIXES]);
    expect([...AGENT_CARD_KINDS]).toEqual(c.AgentCardKind.options);
    expect([...AGENT_CARD_STATUSES]).toEqual(c.AgentCardStatus.options);
    for (const v of [
      "/work-zone",
      "/chat/abc?x=1#y",
      "/settings/",
      "/chatty",
      "/chat/../x",
      "/chat/%2e%2e/x",
      "//evil.example",
      "/chat\\evil",
      "https://evil.example",
      "javascript:alert(1)",
      "/share\u0000x",
      `/chat/${"a".repeat(600)}`,
      "",
    ]) {
      expect(isAgentCardRoute(v), v).toBe(c.isAgentCardRoute(v));
    }
  });
});
