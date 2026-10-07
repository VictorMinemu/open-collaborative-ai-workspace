import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, withoutTitles } from "../../testing-ai";
import { invite } from "../../testing-workzone";
import { IDENTITY_RULE } from "./build-model-messages";

/**
 * The multiplayer prompt on the wire (06-05, MULTI-03, D-04, D-06): one shared chat (Víctor owner, Alex with chat
 * access) answered once per provider path the product uses, captured by the in-process fake. Every path gets the same
 * instructions and attributed blocks in its native shape: one leading instructions slot (a developer item on the plan,
 * `system` on Anthropic, one system message on chat completions), alternating turns, no system role mid-array and no
 * Anthropic beta header. The instructions are byte-identical whoever triggers the turn; a requester without Web gets
 * no tools and a withheld line. Real PostgreSQL + Redis; no real provider is ever called (P-12).
 */

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let alex: TestClient;
let victorId: string;
let alexId: string;
let orgId: string;
let chatId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const OPENAI_KEY_MODEL = { backend: "org_key", provider: "openai", modelId: "gpt-5" } as const;
const SONNET = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
const OPENROUTER = {
  backend: "org_key",
  provider: "openrouter",
  modelId: "anthropic/claude-sonnet-5.5",
} as const;
const COMPATIBLE = { backend: "org_key", provider: "openai-compatible", modelId: "llama-4-70b" } as const;

/** The fields the ChatGPT plan preview route rejects (infra/fake-model/fake-responses.mjs PLAN_FORBIDDEN_KEYS). */
const PLAN_FORBIDDEN_KEYS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "metadata",
  "user",
  "truncation",
  "previous_response_id",
  "prompt_cache_retention",
  "safety_identifier",
  "background",
  "conversation",
  "max_tool_calls",
];

const cid = () => `cm-${randomUUID()}`;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const send = (as: TestClient, id: string, body: string, model: Json, extra: Json = {}) =>
  as.request("POST", `/api/v1/ai-chats/${id}/messages`, { clientMessageId: cid(), body, model, ...extra });

async function settled(generationId: string, timeoutMs = 20_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Text of a string content or of a list of text-bearing parts (Responses, Anthropic and chat-completions shapes). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Json[]).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
}

/** One turn by `as` on `model`; returns the single non-title request of `kind` it produced. */
async function turnOn(
  as: TestClient,
  model: Json,
  kind: "responses" | "anthropic" | "openai",
  body: string,
  extra: Json = {},
) {
  stack.fake.reset();
  const res = await ok(send(as, chatId, body, model, extra), 201);
  const g = await settled(res.generation.id);
  expect(g.status, JSON.stringify(g)).toBe("completed");
  const calls = withoutTitles(stack.fake.requests(kind));
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

/** Instructions and the conversation of a Responses body (plan and org key). */
function responsesShape(body: Json) {
  const input = body.input as Json[];
  const slots = input.filter((i) => i.role === "developer" || i.role === "system");
  const instructions = typeof body.instructions === "string" ? body.instructions : textOf(slots[0]?.content);
  const turns = input.filter((i) => i.role === "user" || i.role === "assistant");
  return {
    input,
    slots,
    instructions,
    turns: turns.map((t) => ({ role: t.role as string, text: textOf(t.content) })),
  };
}

const NAME_COLON = /(^|\n)\s*(Víctor Ruiz|Alex Kim)\s*:/u;

/** Every path: both people's attributed blocks, no plain-text name prefix, the turn context last, alternating turns. */
function expectAttributed(turns: Array<{ role: string; text: string }>) {
  const all = turns.map((t) => t.text).join("\n");
  expect(all).toContain(`<message from="Víctor Ruiz" user_id="${victorId}"`);
  expect(all).toContain(`<message from="Alex Kim" user_id="${alexId}"`);
  for (const t of turns) expect(t.text).not.toMatch(NAME_COLON);
  expect(turns[0]?.role).toBe("user");
  for (let i = 1; i < turns.length; i++) expect(turns[i]?.role, `turn ${i}`).not.toBe(turns[i - 1]?.role);
  const last = turns.at(-1)!;
  expect(last.role).toBe("user");
  expect(last.text.trimEnd().endsWith("</turn_context>")).toBe(true);
  return last;
}

const instructionsSeen: Record<string, string> = {};

beforeAll(async () => {
  stack = await startAiStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  victorId = ((await ok(victor.request("GET", "/api/v1/me"))).user as Json).id;
  ({ client: alex, userId: alexId } = await invite(
    stack,
    victor,
    "alex@example.test",
    "Alex Kim",
    "developer",
  ));
  await seedPlan(victor);
  await seedPlan(alex);
  // Organization keys, pointed at the fake (test strings, never real keys).
  const providers: Json[] = [
    {
      provider: "openai",
      apiKey: "sk-openai-matrix-0123456789",
      baseUrl: `${stack.fake.baseUrl}/v1`,
      allowedModels: ["gpt-5"],
    },
    {
      provider: "anthropic",
      apiKey: "sk-ant-matrix-0123456789",
      baseUrl: stack.fake.baseUrl,
      allowedModels: ["claude-sonnet-5-5"],
    },
    {
      provider: "openrouter",
      apiKey: "sk-or-matrix-0123456789",
      baseUrl: `${stack.fake.baseUrl}/v1`,
      allowedModels: ["anthropic/claude-sonnet-5.5"],
    },
    {
      provider: "openai-compatible",
      apiKey: "compat-matrix-0123456789",
      baseUrl: `${stack.fake.baseUrl}/v1`,
      allowedModels: ["llama-4-70b"],
    },
  ];
  for (const p of providers) await ok(victor.request("POST", "/api/v1/model-providers", p));
  // Víctor's personal instructions are on: they never reach the shared chat (D-06).
  await ok(
    victor.request("PUT", "/api/v1/me/ai-preferences", { instructions: "Always answer in pirate speak." }),
  );

  const created = await ok(
    victor.request("POST", "/api/v1/ai-chats", {
      clientMessageId: cid(),
      body: "Propose an architecture.",
      model: PLAN,
    }),
    201,
  );
  chatId = created.chat.id;
  await settled(created.generation.id);
  await ok(
    victor.request("POST", `/api/v1/ai-chats/${chatId}/grants`, {
      subject: { kind: "user", id: alexId },
      level: "chat",
    }),
    201,
  );
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("every provider path gets the same attributed prompt in its native shape (MULTI-03, D-04)", () => {
  it("(a) Alex's ChatGPT plan: instructions as the developer item, no system item, no preview key, turn context last", async () => {
    const call = await turnOn(alex, PLAN, "responses", "But we need multi-tenancy.");
    expect(call.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${alexId}-`));
    const body = call.body as Json;
    for (const key of PLAN_FORBIDDEN_KEYS) expect(body[key], key).toBeUndefined();
    const { input, slots, instructions, turns } = responsesShape(body);
    expect(input.some((i) => i.role === "system")).toBe(false);
    expect(slots).toHaveLength(1);
    expect(input[0]).toMatchObject({ role: "developer" });
    expect(instructions).toContain("<participants>");
    expect(instructions).toContain(IDENTITY_RULE);
    expect(instructions).not.toContain("pirate");
    const last = expectAttributed(turns);
    expect(last.text).toContain(`<responding_to name="Alex Kim" user_id="${alexId}"/>`);
    instructionsSeen.planAlex = instructions;
  });

  it("the instructions on Víctor's turn are byte-identical to those on Alex's (cached prefix stable)", async () => {
    const call = await turnOn(victor, PLAN, "responses", "We also need audit.");
    expect(call.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${victorId}-`));
    const { instructions, turns } = responsesShape(call.body as Json);
    expect(instructions).toBe(instructionsSeen.planAlex);
    expect(expectAttributed(turns).text).toContain(
      `<responding_to name="Víctor Ruiz" user_id="${victorId}"/>`,
    );
  });

  it("(b) an org OpenAI key (Responses): one developer/system slot first, same instructions and blocks", async () => {
    const call = await turnOn(alex, OPENAI_KEY_MODEL, "responses", "Which database?");
    const body = call.body as Json;
    const { input, slots, instructions, turns } = responsesShape(body);
    if (typeof body.instructions === "string") expect(slots).toHaveLength(0);
    else {
      expect(slots).toHaveLength(1);
      expect(["developer", "system"]).toContain(input[0]?.role);
    }
    expect(instructions).toBe(instructionsSeen.planAlex);
    expectAttributed(turns);
  });

  it("(c) an org Anthropic key: system holds the instructions, messages start with user and alternate, no mid-conversation beta", async () => {
    const call = await turnOn(alex, SONNET, "anthropic", "And the queue?");
    const body = call.body as Json;
    expect(textOf(body.system)).toBe(instructionsSeen.planAlex);
    const messages = body.messages as Json[];
    expect(messages.some((m) => m.role === "system")).toBe(false);
    expect(messages[0]?.role).toBe("user");
    expectAttributed(messages.map((m) => ({ role: m.role, text: textOf(m.content) })));
    const beta = call.headers["anthropic-beta"];
    expect(String(beta ?? "")).not.toContain("mid-conversation");
  });

  for (const [label, model] of [
    ["(d) an org OpenRouter key", OPENROUTER],
    ["(d) an org OpenAI-compatible key", COMPATIBLE],
  ] as const) {
    it(`${label} (chat completions): exactly one system message, first, then alternating user/assistant`, async () => {
      const call = await turnOn(alex, model, "openai", `Ping from ${model.provider}.`);
      const messages = (call.body as Json).messages as Json[];
      const system = messages.filter((m) => m.role === "system" || m.role === "developer");
      expect(system).toHaveLength(1);
      expect(messages[0]).toBe(system[0]);
      expect(textOf(messages[0]?.content)).toBe(instructionsSeen.planAlex);
      expectAttributed(messages.slice(1).map((m) => ({ role: m.role, text: textOf(m.content) })));
    });
  }
});

describe("tools are decided for the requester (D-06, MULTI-05): no tools and a withheld line for a human without Web", () => {
  it("with Web on, Víctor's turn carries the search tool; with a deny rule on ai_chat.web, Alex's has none and says why", async () => {
    const mine = await turnOn(victor, PLAN, "responses", "Search the latest release notes.", {
      tools: { web: true },
    });
    const myTools = ((mine.body as Json).tools ?? []) as Json[];
    expect(myTools.map((t) => t.type)).toContain("web_search");

    const rule = await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: alexId,
        permission: "ai_chat.web",
        effect: "deny",
      }),
    );
    try {
      const theirs = await turnOn(alex, PLAN, "responses", "Search it for me too.");
      const body = theirs.body as Json;
      expect(body.tools ?? []).toEqual([]);
      const { instructions, turns } = responsesShape(body);
      expect(instructions).not.toContain("web_search tool");
      const last = expectAttributed(turns);
      expect(last.text).toContain('<withheld tool="web" reason="denied"/>');
      expect(last.text.indexOf("<withheld")).toBeGreaterThan(last.text.indexOf("<responding_to"));
    } finally {
      await ok(victor.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
    await ok(victor.request("PATCH", `/api/v1/ai-chats/${chatId}`, { settings: { tools: { web: false } } }));
  });
});

describe("persisted persona and notice rows reach the prompt through turn.ts (P-06, research pitfall 3)", () => {
  it("a persona row is an attributed agent block in a user item and a newer notice closes the turn context", async () => {
    const agentId = randomUUID();
    await su.query(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, $2, 'Backend bot', 'backend', 'x', 'mock', 'mock-1', 'ready')`,
      [agentId, orgId],
    );
    await su.query(
      `insert into app.conversation_members (organization_id, conversation_id, member_kind, member_id)
       values ($1, $2, 'agent', $3)`,
      [orgId, chatId, agentId],
    );
    // Rows written as 06-10 (persona) and 06-04 (notice) will write them: the next seqs of the conversation stream.
    for (const [kind, author, body] of [
      ["agent", agentId, "I checked the API: the tenant filter is missing."],
      ["system", null, "Víctor Ruiz added Backend bot to this chat"],
    ] as const) {
      const { rows } = await su.query(
        "update app.streams set last_seq = last_seq + 1 where id = $1 returning last_seq",
        [`conv:${chatId}`],
      );
      await su.query(
        `insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body, status)
         values ($1, $2, $3, $4, $5, $6, 'sent')`,
        [orgId, chatId, rows[0].last_seq, kind, author, body],
      );
    }

    const call = await turnOn(alex, PLAN, "responses", "Can you fix it?");
    const { instructions, turns } = responsesShape(call.body as Json);
    expect(instructions).toContain(
      `- name="@backend" agent_id="${agentId}" kind="agent" display="Backend bot"`,
    );
    const last = expectAttributed(turns);
    expect(last.text).toContain(`<message from="@backend" agent_id="${agentId}" kind="agent"`);
    expect(last.text).toContain("<notice>Víctor Ruiz added Backend bot to this chat</notice>");
    for (const t of turns.filter((x) => x.role === "assistant"))
      expect(t.text).not.toContain("tenant filter");
    // An older notice (before an answer) is history: it is not repeated on the next turn.
    const next = await turnOn(alex, PLAN, "responses", "Thanks.");
    const after = responsesShape(next.body as Json).turns.at(-1)!;
    expect(after.text).not.toContain("<notice>");
  });
});

describe("a solo chat keeps the Phase 5 shape on the plan path (P-05)", () => {
  it("no roster, no attributed blocks, the viewer named in the instructions", async () => {
    stack.fake.reset();
    const created = await ok(
      alex.request("POST", "/api/v1/ai-chats", {
        clientMessageId: cid(),
        body: "Just me here.",
        model: PLAN,
      }),
      201,
    );
    await settled(created.generation.id);
    const [call] = withoutTitles(stack.fake.requests("responses"));
    const { instructions, turns } = responsesShape(call?.body as Json);
    expect(instructions).not.toContain("<participants>");
    expect(instructions).toContain("You are chatting with Alex Kim in Autofy Labs.");
    expect(turns).toEqual([{ role: "user", text: "Just me here." }]);
  });
});
