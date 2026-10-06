import { randomUUID } from "node:crypto";
import { EventTypes, estimateCostMicros } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeModelRequest } from "../../../../../infra/fake-model/server.mjs";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeTopic } from "../../testing-ai";
import { invite } from "../../testing-workzone";
import { heuristicTitle } from "./titles";

/**
 * Automatic AI chat titles (05-10, AICHAT-04, D-06, ADR-0014 semantics): after the FIRST completed answer, while the
 * title is still the first-line heuristic, one small-model call on the SAME backend and the chat OWNER's credential
 * makes a 2-5 word title, normalized (`normalizeSessionTitle`) and validated (`SessionTitle`), stored with one
 * conditional update (`title_source = 'heuristic'`), metered as a `title` usage record and announced as
 * `ai_chat.updated` on `user:<owner>`. A typed title is never replaced; a failure keeps the heuristic title.
 * Real PostgreSQL + Redis and the in-process fake model; the title deadline is shortened to 1.5 s.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let samId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const OPUS = { backend: "org_key", provider: "anthropic", modelId: "claude-opus-5-5" } as const;
const MOCK = { backend: "mock", provider: "mock", modelId: "mock-1" } as const;
const TITLE_TIMEOUT_MS = 1_500;

const cid = () => `cm-${randomUUID()}`;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (body: string, model: Json) =>
  ok(sam.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model }), 201);
const send = (chatId: string, body: string, model: Json) =>
  ok(sam.request("POST", `/api/v1/ai-chats/${chatId}/messages`, { clientMessageId: cid(), body, model }), 201);

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const chatRow = async (chatId: string) =>
  (
    await su.query(
      `select c.name, a.title_source from app.conversations c
       join app.ai_chats a on a.conversation_id = c.id where c.id = $1`,
      [chatId],
    )
  ).rows[0] as { name: string; title_source: string };

async function waitFor<T>(read: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (pred(v)) return v;
    if (Date.now() > until) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Model requests whose instructions ask for a short title (the API's title prompt). */
const isTitle = (r: FakeModelRequest) => JSON.stringify(r.body ?? {}).includes("short title");
const titleRequests = (needle: string) =>
  stack.fake.requests().filter((r) => isTitle(r) && JSON.stringify(r.body).includes(needle));
const chatRequests = (needle: string) =>
  stack.fake.requests().filter((r) => !isTitle(r) && r.body && JSON.stringify(r.body).includes(needle));

const titleUsage = async (generationId: string) =>
  (await su.query("select * from app.ai_usage_records where generation_id = $1 and kind = 'title'", [generationId]))
    .rows as Json[];

beforeAll(async () => {
  stack = await startAiStack({ env: { OCW_AI_TITLE_TIMEOUT_MS: String(TITLE_TIMEOUT_MS) } });
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
  await seedPlan(sam);
  await ok(
    admin.request("POST", "/api/v1/model-providers", {
      provider: "anthropic",
      apiKey: "sk-ant-titles-SECRET-0123456789-t1Ab",
      baseUrl: stack.fake.baseUrl,
      allowedModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
    }),
  );
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("heuristicTitle (the title a chat starts with)", () => {
  it("first non-empty line, ADR-0014 shape when possible, else cut to 32 characters on a word; 'New chat' when empty", () => {
    expect(heuristicTitle("Plan the quarterly offsite agenda")).toBe("Plan the quarterly offsite");
    expect(heuristicTitle("\n\n  Fix the login redirect\nmore text")).toBe("Fix the login redirect");
    expect(heuristicTitle("Hello")).toBe("Hello");
    expect(heuristicTitle("   ")).toBe("New chat");
    expect(heuristicTitle("x".repeat(50)).length).toBeLessThanOrEqual(32);
  });
});

describe("the first answer titles the chat on its own backend (AICHAT-04, D-06)", () => {
  let chatId: string;

  it("plan chat: heuristic first, then a luna title on Sam's own token, metered, announced on user:<sam>", async () => {
    const user = await subscribeTopic(stack.baseUrl, sam, `user:${samId}`);
    const created = await createChat("Plan the quarterly offsite agenda", PLAN);
    chatId = created.chat.id;
    expect(created.chat).toMatchObject({ title: "Plan the quarterly offsite", titleSource: "heuristic" });
    const g = await settled(created.generation.id);
    expect(g.status).toBe("completed");

    const row = await waitFor(
      () => chatRow(chatId),
      (r) => r.title_source === "auto",
    );
    expect(row.name).toBe("Plan the quarterly");

    // Same backend, the owner's own credential, the plan's small model.
    const [title] = titleRequests("Plan the quarterly offsite agenda");
    const [chat] = chatRequests("Plan the quarterly offsite agenda");
    expect(title?.kind).toBe("responses");
    expect(title?.body.model).toBe("gpt-5.6-luna");
    expect(title?.body.store).toBe(false);
    expect(title?.body.stream).toBe(true);
    expect(title?.body.tools ?? []).toEqual([]);
    expect(title?.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${samId}-`, "u"));
    expect(title?.headers.authorization).toBe(chat?.headers.authorization);

    // Metered on the same generation, kind 'title', on the title model (plan: no organization cost).
    const usage = await waitFor(
      () => titleUsage(created.generation.id),
      (u) => u.length === 1,
    );
    expect(usage[0]).toMatchObject({
      backend: "chatgpt_plan",
      provider: "openai",
      model_id: "gpt-5.6-luna",
      requester_user_id: samId,
      conversation_id: chatId,
      cost_micros_usd: null,
    });

    await user.waitFor(() =>
      user
        .durable(EventTypes.aiChatUpdated)
        .some((f) => (f.data as Json).chat.id === chatId && (f.data as Json).chat.titleSource === "auto"),
    );
    const last = user
      .durable(EventTypes.aiChatUpdated)
      .filter((f) => (f.data as Json).chat.id === chatId)
      .at(-1);
    expect((last?.data as Json).chat).toMatchObject({ title: "Plan the quarterly", titleSource: "auto" });
    user.close();

    // The snapshot agrees.
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.chat).toMatchObject({ title: "Plan the quarterly", titleSource: "auto" });
  });

  it("a second answer makes no title call", async () => {
    const before = stack.fake.requests().filter(isTitle).length;
    const sent = await send(chatId, "And the budget for it?", PLAN);
    await settled(sent.generation.id);
    await sleep(500);
    expect(stack.fake.requests().filter(isTitle).length).toBe(before);
    expect(await titleUsage(sent.generation.id)).toEqual([]);
    expect((await chatRow(chatId)).name).toBe("Plan the quarterly");
  });

  it("a title Sam typed before the first answer is kept and no title call is made", async () => {
    const created = await createChat("Rename me before the answer arrives [[slow]]", PLAN);
    await su.query("update app.ai_chats set title_source = 'user' where conversation_id = $1", [created.chat.id]);
    await su.query("update app.conversations set name = 'My own title' where id = $1", [created.chat.id]);
    await settled(created.generation.id);
    await sleep(800);
    expect(titleRequests("Rename me before the answer")).toEqual([]);
    expect(await chatRow(created.chat.id)).toEqual({ name: "My own title", title_source: "user" });
    expect(await titleUsage(created.generation.id)).toEqual([]);
  });

  it("an org-key chat titles on the cheapest allowed model of its provider, else policy.titleModels", async () => {
    const created = await createChat("Summarize the incident review notes", OPUS);
    await settled(created.generation.id);
    await waitFor(
      () => chatRow(created.chat.id),
      (r) => r.title_source === "auto",
    );
    expect((await chatRow(created.chat.id)).name).toBe("Summarize the incident");
    const [title] = titleRequests("Summarize the incident review notes");
    expect(title?.kind).toBe("anthropic");
    expect(title?.body.model).toBe("claude-haiku-4-5");
    const [usage] = await waitFor(
      () => titleUsage(created.generation.id),
      (u) => u.length === 1,
    );
    expect(usage).toMatchObject({ backend: "org_key", provider: "anthropic", model_id: "claude-haiku-4-5" });
    const expected = estimateCostMicros("org_key", "anthropic", "claude-haiku-4-5", {
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cachedInputTokens: usage?.cached_input_tokens,
    });
    expect(usage?.cost_micros_usd).toBe(expected.costMicrosUsd);
    expect(usage?.cost_micros_usd).toBeGreaterThan(0);

    await ok(admin.request("PUT", "/api/v1/ai-chat/policy", { titleModels: { anthropic: "claude-sonnet-5-5" } }));
    const second = await createChat("Draft the hiring plan for Q3", OPUS);
    await settled(second.generation.id);
    await waitFor(
      () => chatRow(second.chat.id),
      (r) => r.title_source === "auto",
    );
    expect(titleRequests("Draft the hiring plan for Q3")[0]?.body.model).toBe("claude-sonnet-5-5");
    await ok(admin.request("PUT", "/api/v1/ai-chat/policy", { titleModels: {} }));
  });

  it("titles the fake returns as one word or 40 characters are refused: the heuristic title stays", async () => {
    for (const forced of ["Supercalifragilisticexpialidocious", "Reconfigurationalists hyperparameterized"]) {
      const text = `Check this title rule [[title:${forced}]]`;
      const created = await createChat(text, MOCK);
      const heuristic = created.chat.title as string;
      await settled(created.generation.id);
      await waitFor(
        async () => titleRequests(forced).length,
        (n) => n === 1,
      );
      await sleep(500);
      expect(await chatRow(created.chat.id)).toEqual({ name: heuristic, title_source: "heuristic" });
      // The call happened and cost tokens: it is metered even though its answer was refused.
      expect(await titleUsage(created.generation.id)).toHaveLength(1);
    }
  });

  it("a title call past the deadline leaves the heuristic title and records no title usage", async () => {
    const created = await createChat("Slow title please [[slow]]", MOCK);
    const heuristic = created.chat.title as string;
    await settled(created.generation.id, 20_000);
    await waitFor(
      async () => titleRequests("Slow title please").length,
      (n) => n === 1,
    );
    await sleep(TITLE_TIMEOUT_MS + 1_000);
    expect(await chatRow(created.chat.id)).toEqual({ name: heuristic, title_source: "heuristic" });
    expect(await titleUsage(created.generation.id)).toEqual([]);
    // The failure is logged as a code only: never the prompt.
    const failed = stack.logs.filter((l) => l.includes("ai title failed"));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.join("\n")).not.toContain("Slow title please");
  });
});
