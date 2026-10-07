import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, withoutTitles } from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * Tools and instructions of AI chats (05-11, AICHAT-05/06, D-04). Web is the only working toggle: the member's
 * ChatGPT plan gets the plan's hosted `web_search` tool; organization keys and the mock get the API-executed
 * SearXNG `web_search` function tool (never a provider-hosted, metered search). Every disabled state carries its
 * reason. Real PostgreSQL + Redis, the in-process fake (Responses API, chat completions, Anthropic, SearXNG).
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;

const cid = () => `cm-${randomUUID()}`;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (as: TestClient, body: string, extra: Json = {}) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: PLAN_MODEL, ...extra });
const send = (as: TestClient, chatId: string, body: string, extra: Json = {}) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
    ...extra,
  });

const generation = async (id: string) =>
  (await su.query("select * from app.ai_generations where id = $1", [id])).rows[0] as Json;

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = await generation(generationId);
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

/** The chat's own model requests of one kind since `from` (auto titles left out). */
const requestsSince = (kind: "responses" | "openai" | "anthropic", from: number) =>
  withoutTitles(stack.fake.requests(kind)).slice(from);
const count = (kind: "responses" | "openai" | "anthropic") => withoutTitles(stack.fake.requests(kind)).length;

const toolTypes = (body: Json | null) => ((body?.tools ?? []) as Json[]).map((t) => t.type);
const stateOf = (detail: Json, key: string) => (detail.tools as Json[]).find((t) => t.key === key);
const snapshot = (as: TestClient, chatId: string) => ok(as.request("GET", `/api/v1/ai-chats/${chatId}`));

beforeAll(async () => {
  stack = await startAiStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: alex } = await invite(stack, admin, "alex@example.test", "Alex Kim", "standard"));
  await seedPlan(sam);
  await seedPlan(alex);
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("Web on a ChatGPT-plan model: the plan's hosted web search, with sources (D-04, AICHAT-06)", () => {
  let chatId: string;

  it("sends one hosted web_search tool and no function tool; the answer records its source domain", async () => {
    const before = count("responses");
    const created = await ok(createChat(sam, "news [[web ocw release]]", { tools: { web: true } }), 201);
    chatId = created.chat.id;
    const g = await settled(created.generation.id);
    expect(g.status).toBe("completed");
    const [req] = requestsSince("responses", before);
    expect(toolTypes(req?.body as Json)).toEqual(["web_search"]);
    expect(JSON.stringify(req?.body)).not.toContain('"function"');
    // The model is told it may search and must cite (its instructions travel as a developer item on the plan).
    expect(JSON.stringify(req?.body)).toContain("web search");
    expect(g.web_used).toBe(true);
    expect(g.source_domains).toEqual(["example.com"]);

    const snap = await snapshot(sam, chatId);
    const answer = (snap.messages as Json[]).at(-1);
    expect(answer?.generation).toMatchObject({ webUsed: true, sourceDomains: ["example.com"] });
    expect(answer?.body).toContain("https://example.com/ocw-fake/ocw-release");
    // Sticky per chat: the send's Web choice is the chat's setting now.
    expect(snap.chat.settings.tools).toEqual({ web: true });
    expect(stateOf(snap.chat, "web")).toMatchObject({ available: true, enabled: true, reason: null });

    const used = await audit("ai_generation.web_used");
    expect(used).toHaveLength(1);
    expect(used[0].metadata).toEqual({ generationId: g.id, domains: ["example.com"], searches: 1 });
    expect(used[0].user_id).toBe(samId);
  });

  it("the other three toggles are present but never available", async () => {
    const snap = await snapshot(sam, chatId);
    expect((snap.chat.tools as Json[]).map((t) => t.key)).toEqual(["web", "companyKnowledge", "mcp", "skills"]);
    for (const key of ["companyKnowledge", "mcp", "skills"]) {
      expect(stateOf(snap.chat, key)).toMatchObject({ available: false, enabled: false, reason: "not_available_yet" });
    }
  });

  it("the setting stays on for the next send; a send with Web off sends no tools and turns it off", async () => {
    let before = count("responses");
    const sticky = await ok(send(sam, chatId, "again [[web ocw release]]"), 201);
    await settled(sticky.generation.id);
    expect(toolTypes(requestsSince("responses", before)[0]?.body as Json)).toEqual(["web_search"]);

    before = count("responses");
    const off = await ok(send(sam, chatId, "no search [[web ocw release]]", { tools: { web: false } }), 201);
    const g = await settled(off.generation.id);
    const [req] = requestsSince("responses", before);
    expect((req?.body as Json).tools ?? []).toEqual([]);
    expect(g.web_used).toBe(false);
    expect(g.source_domains).toEqual([]);
    expect((await snapshot(sam, chatId)).chat.settings.tools).toEqual({ web: false });
  });

  it("a plan that refuses web_search fails the turn and marks that model as unable to search, for Sam only", async () => {
    const failed = await ok(send(sam, chatId, "hi [[plan:unsupported:web_search]]", { tools: { web: true } }), 201);
    const g = await settled(failed.generation.id);
    expect(g.status).toBe("failed");
    expect(g.error_code).toBe("unsupported_capability");
    expect(g.error_param).toBe("web_search");

    const mine = await ok(sam.request("GET", "/api/v1/ai-chat/models"));
    const astra = (mine.models as Json[]).find((m) => m.ref.modelId === "gpt-6-astra");
    const luna = (mine.models as Json[]).find((m) => m.ref.modelId === "gpt-5.6-luna");
    expect(astra?.caps.webSearch).toBe("none");
    expect(luna?.caps.webSearch).toBe("hosted");
    const theirs = await ok(alex.request("GET", "/api/v1/ai-chat/models"));
    expect((theirs.models as Json[]).find((m) => m.ref.modelId === "gpt-6-astra")?.caps.webSearch).toBe("hosted");

    // That model can't search on Sam's plan: a chat asking for Web on it sends no tool, and Web says why.
    // (A fresh chat: the failed turn's directive would otherwise travel again in the merged user turn.)
    const before = count("responses");
    const plain = await ok(createChat(sam, "plain [[web ocw release]]", { tools: { web: true } }), 201);
    const p = await settled(plain.generation.id);
    expect(p.status).toBe("completed");
    expect((requestsSince("responses", before)[0]?.body as Json).tools ?? []).toEqual([]);
    expect(p.web_used).toBe(false);
    const snap = await snapshot(sam, plain.chat.id);
    expect(stateOf(snap.chat, "web")).toMatchObject({ available: false, enabled: false, reason: "not_supported_by_model" });
  });
});
