import { randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient, WEB_ORIGIN } from "../../testing";
import { type AiStack, type ConvSubscription, startAiStack, subscribeTopic } from "../../testing-ai";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import { invite } from "../../testing-workzone";

/**
 * Phase 5 gate (05-15, P-10, T-05-15-01/02): one whole AI chat session per backend (the member's own ChatGPT plan
 * connected through the fake "Sign in with ChatGPT" server, an organization Anthropic key, the mock) — send, stream,
 * stop, regenerate, an image, the auto title, a share a colleague reads, and the usage reports — while every HTTP
 * response body, every WS frame (durable and ephemeral, on `conv:`, `user:` and `org:`), every audit row, every log
 * line and finally every text/jsonb column of every `app.*` and `auth.*` table is collected. None of them may carry
 * the Anthropic key, a ChatGPT access or refresh token, the authorization code, the PKCE verifier or the pasted
 * redirect address; no audit row and no usage row (records or daily counters) may carry prompt or answer text, and
 * no log line may either. Then every AI route of the OpenAPI document must refuse an anonymous caller with 401.
 * Real PostgreSQL + Redis + Garage, the in-process fake model; no real provider is ever called. A failure here is a
 * real leak: fix the module that leaks, never the scan.
 */

let storage: TestStorage;
let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const ANTHROPIC_KEY = `sk-ant-sweep-SECRET-${randomUUID()}`;
const MODELS = {
  plan: { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" },
  anthropic: { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" },
  mock: { backend: "mock", provider: "mock", modelId: "mock-1" },
} as const;
type Backend = keyof typeof MODELS;

/** Every HTTP response body the test saw (Sam, Alex and the admin), as text. */
const bodies: string[] = [];
/** Secret-shaped values handed out during the flow: the authorization code, the PKCE verifier, the pasted address. */
const flowSecrets: string[] = [];
/** One marker per backend, put into every prompt of that backend: its answers echo it back. */
const markers: Record<Backend, string> = {
  plan: `zqplan${randomUUID().slice(0, 8)}`,
  anthropic: `zqclaude${randomUUID().slice(0, 8)}`,
  mock: `zqmock${randomUUID().slice(0, 8)}`,
};
/** Token prefixes the fake SIWC issues (`fake-plan-…` access, `fake-refresh-…` refresh): never stored or shown. */
const TOKEN_PREFIXES = ["fake-plan-", "fake-refresh-"];
const subscriptions: ConvSubscription[] = [];

async function call(as: TestClient, method: string, path: string, body?: unknown) {
  const res = await as.request(method, path, body);
  bodies.push(JSON.stringify(res.body));
  return res;
}

async function ok(
  res: Promise<{ status: number; body: Record<string, unknown> | null }>,
  status = 200,
): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const cid = () => `cm-${randomUUID()}`;

async function settled(generationId: string, timeoutMs = 20_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function until(pred: () => Promise<boolean>, what: string, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The member connects their own ChatGPT plan: start → authorize (302 to the loopback address) → paste → complete. */
async function connectPlan(as: TestClient): Promise<Json> {
  const start = await ok(call(as, "POST", "/api/v1/me/model-credentials/chatgpt/start", {}));
  const flow = await stack.built.core.bus.pub.get(`ocw:ai:siwc:${start.flowId}`);
  expect(flow, "the sign-in flow is in Redis").toBeTruthy();
  const verifier = (JSON.parse(flow as string) as Json).verifier as string;
  expect(verifier.length).toBeGreaterThan(30);
  flowSecrets.push(verifier);
  const res = await fetch(start.authorizeUrl, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code") ?? "";
  expect(code).toMatch(/^fake-code-/u);
  flowSecrets.push(code, location);
  const status = await ok(
    call(as, "POST", "/api/v1/me/model-credentials/chatgpt/complete", {
      flowId: start.flowId,
      redirectUrl: location,
    }),
  );
  expect(status.state).toBe("connected");
  return status;
}

const png = () =>
  sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .png()
    .toBuffer();

/** presign → PUT straight to Garage → complete, into the given AI chat: the attachment id. */
async function upload(as: TestClient, chatId: string, filename: string): Promise<string> {
  const bytes = await png();
  const p = await ok(
    call(as, "POST", `/api/v1/conversations/${chatId}/attachments`, {
      filename,
      contentType: "image/png",
      size: bytes.length,
    }),
  );
  const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: bytes });
  expect(put.status).toBe(200);
  await ok(call(as, "POST", `/api/v1/attachments/${p.attachment.id}/complete`));
  return p.attachment.id as string;
}

/**
 * One whole session on one backend: first answer (title follows), a slow answer stopped mid-stream, a regenerate,
 * an image turn, a share Alex reads, Sam's own usage. Returns the chat id.
 */
async function session(backend: Backend): Promise<string> {
  const model = MODELS[backend];
  const marker = markers[backend];
  const created = await ok(
    call(sam, "POST", "/api/v1/ai-chats", {
      clientMessageId: cid(),
      body: `${marker} plan the quarterly offsite for the team`,
      model,
    }),
    201,
  );
  const chatId = created.chat.id as string;
  const conv = await subscribeTopic(stack.baseUrl, sam, `conv:${chatId}`);
  expect(conv.outcome).toBe("subscribed");
  subscriptions.push(conv);
  expect((await settled(created.generation.id)).status).toBe("completed");
  // The auto title lands after the first answer (05-10).
  await until(
    async () =>
      (await su.query("select title_source from app.ai_chats where conversation_id = $1", [chatId])).rows[0]
        ?.title_source === "auto",
    `${backend} title`,
  );

  // A slow answer, stopped while it streams: the partial text is kept.
  const slow = await ok(
    call(sam, "POST", `/api/v1/ai-chats/${chatId}/messages`, {
      clientMessageId: cid(),
      body: `${marker} count to forty [[slow]]`,
      model,
    }),
    201,
  );
  await conv.waitFor(() => conv.deltas().length > 2, 10_000);
  await ok(call(sam, "POST", `/api/v1/ai-chats/${chatId}/generations/${slow.generation.id}/stop`), 202);
  expect((await settled(slow.generation.id)).status).toBe("stopped");

  // Regenerate the stopped answer on the same backend.
  const regen = await ok(
    call(sam, "POST", `/api/v1/ai-chats/${chatId}/regenerate`, {
      messageId: slow.assistantMessage.id,
      model,
    }),
    201,
  );
  expect((await settled(regen.generation.id, 30_000)).status).toBe("completed");

  // An image turn: the API reads the bytes from Garage and sends them inline.
  const fileId = await upload(sam, chatId, `${backend}-chart.png`);
  const withImage = await ok(
    call(sam, "POST", `/api/v1/ai-chats/${chatId}/messages`, {
      clientMessageId: cid(),
      body: `${marker} what does this chart show?`,
      model,
      attachmentIds: [fileId],
    }),
    201,
  );
  expect((await settled(withImage.generation.id)).status).toBe("completed");
  const answer = (
    await su.query("select body from app.messages where id = $1", [withImage.assistantMessage.id])
  ).rows[0].body as string;
  expect(answer).toContain("[images:1]");
  // The fake Responses API (the plan) echoes the prompt, so the marker is answer text too; the fake Anthropic and
  // chat-completions endpoints answer "Hi <name>!".
  if (backend === "plan") expect(answer).toContain(marker);

  // Snapshot, pages, rename, share; Alex reads the share and its image.
  await ok(call(sam, "GET", `/api/v1/ai-chats/${chatId}`));
  await ok(call(sam, "GET", `/api/v1/ai-chats/${chatId}/messages`));
  await ok(call(sam, "PATCH", `/api/v1/ai-chats/${chatId}`, { title: `Offsite on ${backend}` }));
  const share = await ok(call(sam, "POST", `/api/v1/ai-chats/${chatId}/shares`, {}), 201);
  await ok(call(sam, "GET", `/api/v1/ai-chats/${chatId}/shares`));
  const read = await ok(call(alex, "GET", `/api/v1/ai-shares/${share.id}`));
  expect(JSON.stringify(read)).toContain(marker);
  const preview = await fetch(`${stack.baseUrl}/api/v1/ai-shares/${share.id}/attachments/${fileId}/preview`, {
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: alex.cookieHeader },
  });
  expect(preview.status).toBe(302);
  return chatId;
}

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startAiStack({ env: storage.env });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: alex } = await invite(stack, admin, "alex@example.test", "Alex Kim", "standard"));
  for (let i = 0; i < 100; i++) {
    const cfg = await ok(sam.request("GET", "/api/v1/attachments/config"));
    if (cfg.enabled) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}, 240_000);

afterAll(async () => {
  for (const s of subscriptions) s.close();
  await su?.end();
  await stack?.stop();
  await storage?.stop();
});

describe("a whole AI chat session on every backend leaks no secret and no prompt (P-10, T-05-15-01)", () => {
  it("runs the session on the plan, an organization Anthropic key and the mock while everything is recorded", async () => {
    // Sam listens on his user topic and the organization topic for the whole session.
    for (const topic of [`user:${samId}`, `org:${orgId}`]) {
      const sub = await subscribeTopic(stack.baseUrl, sam, topic);
      expect(sub.outcome, topic).toBe("subscribed");
      subscriptions.push(sub);
    }
    // The admin configures Anthropic (the key goes in once, write-only) and reads the policy.
    await ok(
      call(admin, "POST", "/api/v1/model-providers", {
        provider: "anthropic",
        apiKey: ANTHROPIC_KEY,
        baseUrl: stack.fake.baseUrl,
        allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
      }),
    );
    await ok(call(admin, "GET", "/api/v1/model-providers"));
    await ok(call(admin, "GET", "/api/v1/ai-chat/policy"));

    // Sam connects his own ChatGPT plan through the fake "Sign in with ChatGPT" server.
    await connectPlan(sam);
    await ok(call(sam, "GET", "/api/v1/me/model-credentials/chatgpt"));
    await ok(call(sam, "POST", "/api/v1/me/model-credentials/chatgpt/welcome-seen", {}));
    const models = await ok(call(sam, "GET", "/api/v1/ai-chat/models"));
    for (const m of Object.values(MODELS)) {
      const row = (models.models as Json[]).find(
        (x) => x.ref.backend === m.backend && x.ref.provider === m.provider && x.ref.modelId === m.modelId,
      );
      expect(row?.available, `${m.backend}/${m.modelId} available`).toBe(true);
    }

    for (const backend of Object.keys(MODELS) as Backend[]) await session(backend);

    // Every backend's prompts really reached its own endpoint of the fake.
    const kinds = new Set(stack.fake.requests().map((r) => r.kind));
    expect(kinds.size).toBeGreaterThan(1);

    // Usage: Sam's own today and report, the organization report by member and by model, the chat list, search.
    await ok(call(sam, "GET", "/api/v1/me/ai-usage/today"));
    await ok(call(sam, "GET", "/api/v1/me/ai-usage/report?days=30"));
    await ok(call(admin, "GET", "/api/v1/ai-usage/report?days=30&groupBy=user"));
    await ok(call(admin, "GET", "/api/v1/ai-usage/report?days=30&groupBy=model"));
    await ok(call(sam, "GET", "/api/v1/ai-chats"));
    // Search by a title word (the search query itself is a request URL, logged like any other: not prompt text).
    await ok(call(sam, "GET", "/api/v1/search?q=offsite"));
    // Sam disconnects at the end: the refresh and access tokens are revoked at the auth server.
    await ok(call(sam, "DELETE", "/api/v1/me/model-credentials/chatgpt"));
    // In-flight frames land.
    await new Promise((r) => setTimeout(r, 500));
  }, 240_000);

  it("no response body, WS frame, audit row or log line carries a key, token, code, verifier or pasted address", async () => {
    const frames = JSON.stringify(subscriptions.flatMap((s) => s.frames));
    const responses = bodies.join("\n");
    const audit = JSON.stringify((await su.query("select * from app.audit_events")).rows);
    const logs = stack.logs.join("\n");
    // The sweep saw a real session: answers streamed as ephemeral deltas and durable events on every topic kind.
    const subs = subscriptions;
    expect(subs.some((s) => s.deltas().length > 0)).toBe(true);
    expect(subs.some((s) => s.durable("message.updated").length > 0)).toBe(true);
    expect(subs.some((s) => s.durable("ai_chat.updated").length > 0)).toBe(true);
    expect(responses.length).toBeGreaterThan(10_000);
    expect(stack.logs.length).toBeGreaterThan(50);
    expect(flowSecrets).toHaveLength(3);

    for (const [where, text] of Object.entries({ responses, frames, audit, logs })) {
      expect(text, `${where}: Anthropic key`).not.toContain(ANTHROPIC_KEY);
      for (const prefix of TOKEN_PREFIXES) expect(text, `${where}: ${prefix} token`).not.toContain(prefix);
      for (const secret of flowSecrets) expect(text, `${where}: sign-in secret`).not.toContain(secret);
    }
  });

  it("no audit row, usage record, daily counter or log line carries prompt or answer text", async () => {
    const audit = JSON.stringify((await su.query("select * from app.audit_events")).rows);
    const records = JSON.stringify((await su.query("select * from app.ai_usage_records")).rows);
    const daily = JSON.stringify((await su.query("select * from app.ai_usage_daily")).rows);
    const logs = stack.logs.join("\n");
    expect((await su.query("select count(*)::int as n from app.ai_usage_records")).rows[0].n).toBeGreaterThan(
      8,
    );
    for (const [backend, marker] of Object.entries(markers)) {
      // The marker is real conversation text (it is in the stored messages), so its absence below means something.
      const stored = await su.query("select count(*)::int as n from app.messages where body like $1", [
        `%${marker}%`,
      ]);
      expect(stored.rows[0].n, `${backend} messages`).toBeGreaterThanOrEqual(backend === "plan" ? 6 : 3);
      for (const [where, text] of Object.entries({ audit, records, daily, logs })) {
        expect(text, `${where}: ${backend} prompt/answer text`).not.toContain(marker);
      }
    }
    for (const phrase of ["plan the quarterly offsite", "count to forty", "what does this chart show"]) {
      expect(audit, `audit: "${phrase}"`).not.toContain(phrase);
      expect(records + daily, `usage: "${phrase}"`).not.toContain(phrase);
      expect(logs, `logs: "${phrase}"`).not.toContain(phrase);
    }
  });

  it("no text or jsonb column of any app.* or auth.* table holds a key, token, code, verifier or pasted address", async () => {
    const cols = (
      await su.query(
        `select table_schema, table_name, column_name from information_schema.columns
          where table_schema in ('app','auth')
            and data_type in ('text','character varying','jsonb','json','ARRAY')
            and table_name in (select table_name from information_schema.tables
                                where table_schema = columns.table_schema and table_type = 'BASE TABLE')`,
      )
    ).rows as Array<{ table_schema: string; table_name: string; column_name: string }>;
    expect(cols.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const c of cols) {
      const rows = (
        await su.query(
          `select "${c.column_name}"::text as v from "${c.table_schema}"."${c.table_name}" where "${c.column_name}" is not null`,
        )
      ).rows as Array<{ v: string }>;
      for (const { v } of rows) {
        const hit = [ANTHROPIC_KEY, ...TOKEN_PREFIXES, ...flowSecrets].find((s) => v.includes(s));
        if (hit) found.push(`${c.table_schema}.${c.table_name}.${c.column_name}`);
      }
    }
    expect(found).toEqual([]);
    // The sealed secrets exist (the Anthropic key and, until the disconnect, Sam's plan tokens): ciphertext only.
    const sealed = await su.query("select kind from app.secrets where organization_id = $1", [orgId]);
    expect(sealed.rows.length).toBeGreaterThan(0);
  });
});

describe("every AI chat route refuses an anonymous caller (T-05-15-02)", () => {
  const AI_PATH = /^\/api\/v1\/(ai-|me\/model-credentials\/|me\/model-credentials$|me\/ai-|ai-shares\/)/u;

  it("each AI path of the OpenAPI document answers 401 without a session", async () => {
    const res = await fetch(`${stack.baseUrl}/docs/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    const operations: Array<{ method: string; path: string }> = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (!AI_PATH.test(path)) continue;
      for (const method of Object.keys(ops)) {
        if (["get", "post", "put", "patch", "delete"].includes(method)) operations.push({ method, path });
      }
    }
    // The document lists the whole Phase 5 surface (a route missing from it would escape this sweep).
    const listed = new Set(operations.map((o) => `${o.method.toUpperCase()} ${o.path}`));
    for (const expected of [
      "GET /api/v1/ai-chat/models",
      "GET /api/v1/ai-chat/policy",
      "PUT /api/v1/ai-chat/policy",
      "POST /api/v1/ai-chats",
      "GET /api/v1/ai-chats",
      "POST /api/v1/ai-chats/drafts",
      "GET /api/v1/ai-chats/{id}",
      "PATCH /api/v1/ai-chats/{id}",
      "GET /api/v1/ai-chats/{id}/messages",
      "POST /api/v1/ai-chats/{id}/messages",
      "POST /api/v1/ai-chats/{id}/generations/{gid}/stop",
      "POST /api/v1/ai-chats/{id}/regenerate",
      "POST /api/v1/ai-chats/{id}/shares",
      "GET /api/v1/ai-chats/{id}/shares",
      "GET /api/v1/ai-shares/{shareId}",
      "DELETE /api/v1/ai-shares/{shareId}",
      "GET /api/v1/ai-shares/{shareId}/attachments/{attachmentId}/preview",
      "GET /api/v1/ai-shares/{shareId}/attachments/{attachmentId}/large",
      "GET /api/v1/ai-shares/{shareId}/attachments/{attachmentId}/download",
      "GET /api/v1/ai-usage/report",
      "GET /api/v1/me/ai-usage/today",
      "GET /api/v1/me/ai-usage/report",
      "GET /api/v1/me/ai-preferences",
      "PUT /api/v1/me/ai-preferences",
      "GET /api/v1/me/model-credentials/chatgpt",
      "DELETE /api/v1/me/model-credentials/chatgpt",
      "POST /api/v1/me/model-credentials/chatgpt/start",
      "POST /api/v1/me/model-credentials/chatgpt/complete",
      "POST /api/v1/me/model-credentials/chatgpt/welcome-seen",
    ]) {
      expect(listed.has(expected), `OpenAPI lists ${expected}`).toBe(true);
    }

    const refused: string[] = [];
    for (const { method, path } of operations) {
      const url = path.replace(/\{[^}]+\}/gu, () => randomUUID());
      const withBody = ["post", "put", "patch"].includes(method);
      const r = await fetch(`${stack.baseUrl}${url}`, {
        method: method.toUpperCase(),
        redirect: "manual",
        headers: { origin: WEB_ORIGIN, ...(withBody ? { "content-type": "application/json" } : {}) },
        body: withBody ? "{}" : undefined,
      });
      if (r.status !== 401) refused.push(`${method.toUpperCase()} ${path} → ${r.status}`);
    }
    expect(refused).toEqual([]);
  });
});
