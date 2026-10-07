import { randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin, type MentionPayload } from "../../../../../e2e/support/fake-cell-plugin";
import { sha256Hex } from "../../lib/crypto";
import { TEST_SETUP_TOKEN, TestClient, WEB_ORIGIN } from "../../testing";
import {
  type AiStack,
  type ConvSubscription,
  startAiStack,
  subscribeConv,
  subscribeTopic,
} from "../../testing-ai";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import { errorCode, invite } from "../../testing-workzone";

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
 *
 * Phase 6 gate (06-16, P-12, T-06-16-01/02): a shared AI chat (owner with personal instructions, a `chat` grantee on an
 * organization key, a `view` grantee, a revoked grantee, a persona that keeps memory notes, an Agent Card) leaks no
 * private context into any model request, cell delivery, response or frame another participant sees, and no secret
 * anywhere; every Phase 6 route answers 401 anonymously and 404 (403 for a view-only write) to everyone the grants do
 * not cover — admins and other organizations included.
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
/** The operator bootstrap cell token (Agent Channel API scope): never echoed, logged or stored. */
const CELL_TOKEN = `ocw-sweep-cell-token-${randomUUID()}`;
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
const cells: FakeCellPlugin[] = [];

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
  stack = await startAiStack({ env: { ...storage.env, OCW_CELL_TOKEN: CELL_TOKEN } });
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
  for (const p of cells) await p.stop();
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

// ---------------------------------------------------------------- Phase 6 (06-16): a shared chat, swept

/** The owner's personal instructions (D-06) and the persona's memory notes (P-10): never in a shared chat's traffic. */
const SIGIL = `SIGIL${randomUUID().slice(0, 8)}`;
const MEMO = `MEMO${randomUUID().slice(0, 8)}`;
/** Provider-key shapes (the eval key is OpenRouter's): none may appear anywhere the platform writes. */
const KEY_SHAPES = [
  /sk-or-v1-[A-Za-z0-9]{20,}/u,
  /sk-ant-[A-Za-z0-9_-]{20,}/u,
  /sk-proj-[A-Za-z0-9_-]{20,}/u,
];

type Actor = "owner" | "chat" | "view" | "revoked" | "admin" | "orgB";
const ACTORS: Actor[] = ["orgB", "admin", "revoked", "view", "chat", "owner"];

/** Responses the Phase 6 session produced, with who received them. */
const p6Bodies: Array<{ who: Actor | "other"; text: string }> = [];
const p6Subs: ConvSubscription[] = [];
let p6: {
  chatId: string;
  cardId: string;
  fakeFrom: number;
  scribeId: string;
  extraId: string;
  joGrantId: string;
  alexGrantId: string;
  clients: Record<Actor, TestClient>;
  ids: Partial<Record<Actor, string>>;
  orgB: string;
};

async function p6call(who: Actor | "other", as: TestClient, method: string, path: string, body?: unknown) {
  const res = await as.request(method, path, body);
  const text = JSON.stringify(res.body);
  p6Bodies.push({ who, text });
  bodies.push(text);
  return res;
}

/** A member moved into a brand-new organization B, where they are admin (cross-tenant probes). */
async function orgBMember(): Promise<{ client: TestClient; orgB: string }> {
  const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
  const { client: eve, userId: eveId } = await invite(stack, admin, email, "Eve", "standard");
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
  expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
  return { client: eve, orgB };
}

async function teamBot(name: string, username: string): Promise<string> {
  const bot = await ok(
    call(admin, "POST", "/api/v1/agents", {
      name,
      username,
      instructions: `You are ${name}.`,
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  return bot.id as string;
}

const approvalCard = () => ({
  kind: "approval",
  title: "Publish the hiring plan",
  fields: [{ label: "Roles", value: "3 engineers" }],
  status: "pending",
  actions: [
    { kind: "follow", label: "Follow" },
    { kind: "approve", label: "Approve", denyLabel: "Deny" },
  ],
  summary: "Approve publishing the hiring plan?",
});

describe("Phase 6: a shared AI chat leaks no private context and no secret (06-16, T-06-16-01)", () => {
  it("runs a shared session: plan and organization-key turns, grants of every kind, a persona with memory, a card", async () => {
    const { client: riley, userId: rileyId } = await invite(
      stack,
      admin,
      "riley@example.test",
      "Riley Park",
      "developer",
    );
    const { client: robin, userId: robinId } = await invite(
      stack,
      admin,
      "robin@example.test",
      "Robin Lee",
      "standard",
    );
    const { userId: joId } = await invite(stack, admin, "jo@example.test", "Jo Diaz", "standard");
    const eve = await orgBMember();
    const alexId = ((await ok(alex.request("GET", "/api/v1/me"))).user as Json).id as string;
    const clients: Record<Actor, TestClient> = {
      owner: sam,
      chat: alex,
      view: riley,
      revoked: robin,
      admin,
      orgB: eve.client,
    };

    // Sam's personal instructions are on, and he reconnects his own plan (the Phase 5 session disconnected it).
    await ok(
      p6call("owner", sam, "PUT", "/api/v1/me/ai-preferences", {
        instructions: `Sign every answer as ${SIGIL}.`,
      }),
    );
    await connectPlan(sam);

    // A solo chat first (Phase 5: his instructions shape it), titled before anyone else arrives.
    const soloFrom = stack.fake.requests().length;
    const created = await ok(
      p6call("owner", sam, "POST", "/api/v1/ai-chats", {
        clientMessageId: cid(),
        body: "Draft the hiring plan for the platform team",
        model: MODELS.plan,
      }),
      201,
    );
    const chatId = (created.chat as Json).id as string;
    expect((await settled(created.generation.id)).status).toBe("completed");
    expect(
      stack.fake
        .requests()
        .slice(soloFrom)
        .some((r) => JSON.stringify(r.body ?? {}).includes(SIGIL)),
      "the solo turn used the owner's instructions",
    ).toBe(true);
    await until(
      async () =>
        (await su.query("select title_source from app.ai_chats where conversation_id = $1", [chatId])).rows[0]
          ?.title_source === "auto",
      "phase 6 title",
    );
    // From the first grant on, no model request of this chat may carry them.
    const fakeFrom = stack.fake.requests().length;

    const share = (subject: Json, level: "chat" | "view") =>
      ok(p6call("owner", sam, "POST", `/api/v1/ai-chats/${chatId}/grants`, { subject, level }), 201);
    const alexGrant = await share({ kind: "user", id: alexId }, "chat");
    await share({ kind: "user", id: rileyId }, "view");
    const robinGrant = await share({ kind: "user", id: robinId }, "chat");
    const joGrant = await share({ kind: "user", id: joId }, "chat");

    // Personas: @scribe keeps memory notes about Sam and Alex (their DMs would use them); @extra is removed later.
    const scribeId = await teamBot("Scribe", "scribe");
    const extraId = await teamBot("Extra", "extra");
    await ok(call(admin, "PATCH", `/api/v1/agents/${scribeId}/capabilities`, { memory: true }));
    for (const userId of [samId, alexId]) {
      await su.query(
        "insert into app.agent_memories (id, organization_id, agent_id, user_id, text) values ($1, $2, $3, $4, $5)",
        [randomUUID(), orgId, scribeId, userId, `${MEMO}: prefers bullet points`],
      );
    }
    for (const agentId of [scribeId, extraId]) {
      await ok(p6call("owner", sam, "POST", `/api/v1/ai-chats/${chatId}/agents`, { agentId }), 201);
    }

    // Everyone with access listens on the chat; the grantees on their own topics too.
    for (const [who, c] of [
      ["owner", sam],
      ["chat", alex],
      ["view", riley],
    ] as const) {
      const sub = await subscribeConv(stack.baseUrl, c, chatId);
      expect(sub.outcome, `${who} subscribes`).toBe("subscribed");
      p6Subs.push(sub);
    }
    for (const [c, id] of [
      [alex, alexId],
      [riley, rileyId],
    ] as const) {
      const sub = await subscribeTopic(stack.baseUrl, c, `user:${id}`);
      expect(sub.outcome).toBe("subscribed");
      p6Subs.push(sub);
    }
    const cell = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN });
    cells.push(cell);
    await cell.start();

    // Alex asks on the organization's Anthropic key; Sam on his own plan. Both are answered.
    const byAlex = await ok(
      p6call("chat", alex, "POST", `/api/v1/ai-chats/${chatId}/messages`, {
        clientMessageId: cid(),
        body: "What should the interview loop look like?",
        model: MODELS.anthropic,
        askAi: true,
      }),
      201,
    );
    expect((await settled(byAlex.generation.id)).status).toBe("completed");
    const bySam = await ok(
      p6call("owner", sam, "POST", `/api/v1/ai-chats/${chatId}/messages`, {
        clientMessageId: cid(),
        body: "And the budget for it?",
        model: MODELS.plan,
        askAi: true,
      }),
      201,
    );
    expect((await settled(bySam.generation.id)).status).toBe("completed");
    const kinds = new Set(
      stack.fake
        .requests()
        .slice(fakeFrom)
        .map((r) => r.kind),
    );
    expect(kinds.size, "plan and Anthropic requests").toBeGreaterThan(1);

    // Riley reads; Robin reads, then loses access.
    await ok(p6call("view", riley, "GET", `/api/v1/ai-chats/${chatId}`));
    await ok(p6call("revoked", robin, "GET", `/api/v1/ai-chats/${chatId}`));
    expect(
      (await p6call("owner", sam, "DELETE", `/api/v1/ai-chats/${chatId}/grants/${robinGrant.id}`)).status,
    ).toBe(204);

    // Alex mentions @scribe: one flat delivery, no memory; the cell replies and posts an approval card.
    const mention = await p6call("chat", alex, "POST", `/api/v1/ai-chats/${chatId}/messages`, {
      clientMessageId: cid(),
      body: "@scribe write down the plan",
      model: MODELS.anthropic,
    });
    expect(mention.status).toBe(202);
    const mentionId = ((mention.body as Json).userMessage as Json).id as string;
    const delivered = (
      await cell.waitFor(
        (e) => e.type === "agent.mention.v1" && (e.data as Json).message?.id === mentionId,
        15_000,
      )
    ).data as unknown as MentionPayload & Json;
    expect(delivered.conversation).toMatchObject({ id: chatId, kind: "ai_chat" });
    expect(delivered.turn?.memory).toEqual([]);
    await cell.reply(delivered, "Written down.");
    const posted = await cell.request<Json>("POST", "/cards", {
      agentId: scribeId,
      conversationId: chatId,
      threadRootId: null,
      idempotencyKey: `card-${randomUUID()}`,
      card: approvalCard(),
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const cardId = posted.body.messageId as string;
    for (const sub of p6Subs.slice(0, 3)) {
      await sub.waitFor(() =>
        sub.durable("message.created").some((f) => ((f.data as Json).message as Json).id === cardId),
      );
    }

    // Everyone with access reads the people, the grants (owner) and the card.
    await ok(p6call("owner", sam, "GET", `/api/v1/ai-chats/${chatId}/grants`));
    for (const [who, c] of [
      ["owner", sam],
      ["chat", alex],
      ["view", riley],
    ] as const) {
      await ok(p6call(who, c, "GET", `/api/v1/ai-chats/${chatId}/participants`));
      await ok(p6call(who, c, "GET", `/api/v1/ai-chats/${chatId}`));
      await ok(p6call(who, c, "GET", `/api/v1/cards/${cardId}`));
      await ok(p6call(who, c, "GET", "/api/v1/ai-chats?scope=all"));
    }
    await new Promise((r) => setTimeout(r, 500));

    p6 = {
      chatId,
      cardId,
      fakeFrom,
      scribeId,
      extraId,
      joGrantId: joGrant.id as string,
      alexGrantId: alexGrant.id as string,
      clients,
      ids: { owner: samId, chat: alexId, view: rileyId, revoked: robinId },
      orgB: eve.orgB,
    };
  }, 240_000);

  it("no model request of the shared chat carries the owner's personal instructions or a memory note (MULTI-06)", () => {
    const requests = stack.fake.requests().slice(p6.fakeFrom);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const r of requests) {
      const text = JSON.stringify(r.body ?? {});
      expect(text, `${r.kind}: personal instructions`).not.toContain(SIGIL);
      expect(text, `${r.kind}: personal_instructions block`).not.toContain("personal_instructions");
      expect(text, `${r.kind}: memory note`).not.toContain(MEMO);
    }
    // The shared prompt is the multiplayer one (roster), so the absence above is the D-06 rule, not a solo prompt.
    expect(requests.some((r) => JSON.stringify(r.body ?? {}).includes("<participants>"))).toBe(true);
  });

  it("no cell delivery, frame or response another participant receives carries them either", async () => {
    const deliveries = (
      await su.query(
        "select type, payload from app.stream_events where stream_id = $1 and payload->'conversation'->>'id' = $2",
        [`cell:${orgId}`, p6.chatId],
      )
    ).rows as Array<{ type: string; payload: Json }>;
    expect(deliveries.some((d) => d.type === "agent.mention.v1")).toBe(true);
    for (const d of deliveries) {
      const text = JSON.stringify(d.payload);
      expect(text, `${d.type}: personal instructions`).not.toContain(SIGIL);
      expect(text, `${d.type}: memory note`).not.toContain(MEMO);
      if (d.payload.turn) expect(d.payload.turn.memory ?? [], d.type).toEqual([]);
    }
    const frames = JSON.stringify(p6Subs.flatMap((s) => s.frames));
    expect(frames.length).toBeGreaterThan(1_000);
    expect(frames).not.toContain(SIGIL);
    expect(frames).not.toContain(MEMO);
    const others = p6Bodies.filter((b) => b.who !== "owner").map((b) => b.text);
    expect(others.length).toBeGreaterThan(10);
    for (const text of others) {
      expect(text).not.toContain(SIGIL);
      expect(text).not.toContain(MEMO);
    }
  });

  it("the instructions and notes stay in their own rows: no other column of any table holds them", async () => {
    const found = await columnsHolding([SIGIL, MEMO]);
    expect(found.get(SIGIL)).toEqual(["app.ai_user_preferences.instructions"]);
    expect(found.get(MEMO)).toEqual(["app.agent_memories.text"]);
  });

  it("no response, frame, audit row, log line or column carries a plan token, an organization key, the cell token or a provider-key shape", async () => {
    const texts = {
      responses: bodies.join("\n"),
      frames: JSON.stringify([...subscriptions, ...p6Subs].flatMap((s) => s.frames)),
      audit: JSON.stringify((await su.query("select * from app.audit_events")).rows),
      logs: stack.logs.join("\n"),
    };
    expect(flowSecrets).toHaveLength(6);
    for (const [where, text] of Object.entries(texts)) {
      expect(text, `${where}: Anthropic key`).not.toContain(ANTHROPIC_KEY);
      expect(text, `${where}: cell token`).not.toContain(CELL_TOKEN);
      for (const prefix of TOKEN_PREFIXES) expect(text, `${where}: ${prefix} token`).not.toContain(prefix);
      for (const secret of flowSecrets) expect(text, `${where}: sign-in secret`).not.toContain(secret);
      for (const shape of KEY_SHAPES) expect(text, `${where}: ${shape}`).not.toMatch(shape);
    }
    const found = await columnsHolding(
      [ANTHROPIC_KEY, CELL_TOKEN, ...TOKEN_PREFIXES, ...flowSecrets],
      KEY_SHAPES,
    );
    expect([...found.entries()]).toEqual([]);
  });
});

/** For each needle (string or pattern), the `schema.table.column`s of `app`/`auth` whose text holds it. */
async function columnsHolding(
  needles: string[],
  shapes: RegExp[] = [],
): Promise<Map<string | RegExp, string[]>> {
  const cols = (
    await su.query(
      `select table_schema, table_name, column_name from information_schema.columns
        where table_schema in ('app','auth')
          and data_type in ('text','character varying','jsonb','json','ARRAY')
          and table_name in (select table_name from information_schema.tables
                              where table_schema = columns.table_schema and table_type = 'BASE TABLE')`,
    )
  ).rows as Array<{ table_schema: string; table_name: string; column_name: string }>;
  const found = new Map<string | RegExp, string[]>();
  for (const c of cols) {
    const rows = (
      await su.query(
        `select "${c.column_name}"::text as v from "${c.table_schema}"."${c.table_name}" where "${c.column_name}" is not null`,
      )
    ).rows as Array<{ v: string }>;
    const where = `${c.table_schema}.${c.table_name}.${c.column_name}`;
    for (const needle of [...needles, ...shapes]) {
      const hit = rows.some(({ v }) => (typeof needle === "string" ? v.includes(needle) : needle.test(v)));
      if (hit) found.set(needle, [...(found.get(needle) ?? []), where]);
    }
  }
  return found;
}

describe("every Phase 6 route decides by grant: owner, chat, view, revoked, admin, another organization (06-16, T-06-16-02)", () => {
  /** Expected status per actor; a `[status, code]` pair also checks the error code. */
  type Expect = Record<Actor, number | [number, string]>;
  const reader = (ok: number): Expect => ({
    owner: ok,
    chat: ok,
    view: ok,
    revoked: 404,
    admin: 404,
    orgB: 404,
  });
  const ownerOnly = (ok: number): Expect => ({
    owner: ok,
    chat: 404,
    view: 404,
    revoked: 404,
    admin: 404,
    orgB: 404,
  });

  async function probe(
    name: string,
    method: string,
    path: () => string,
    body: unknown | (() => unknown),
    expected: Expect,
  ) {
    const seen: string[] = [];
    const want: string[] = [];
    for (const who of ACTORS) {
      const payload = typeof body === "function" ? (body as () => unknown)() : body;
      const res = await p6call(who, p6.clients[who], method, path(), payload);
      const exp = expected[who];
      const [status, code] = Array.isArray(exp) ? exp : [exp, null];
      want.push(`${who} ${status}${code ? ` ${code}` : ""}`);
      seen.push(`${who} ${res.status}${code ? ` ${errorCode(res)}` : ""}`);
    }
    expect(seen, name).toEqual(want);
  }
  // `path` is lazy: p6 is filled by the session above.
  const route = (fn: () => string) => fn;

  it("grants (list, create, change, revoke) are the owner's alone; everyone else gets the chat's 404", async () => {
    await probe(
      "GET grants",
      "GET",
      route(() => `/api/v1/ai-chats/${p6.chatId}/grants`),
      undefined,
      ownerOnly(200),
    );
    await probe(
      "POST grants (same subject, same level)",
      "POST",
      route(() => `/api/v1/ai-chats/${p6.chatId}/grants`),
      { subject: { kind: "user", id: p6.ids.chat }, level: "chat" },
      ownerOnly(200),
    );
    await probe(
      "PATCH grant",
      "PATCH",
      route(() => `/api/v1/ai-chats/${p6.chatId}/grants/${p6.alexGrantId}`),
      { level: "chat" },
      ownerOnly(200),
    );
    await probe(
      "DELETE grant",
      "DELETE",
      route(() => `/api/v1/ai-chats/${p6.chatId}/grants/${p6.joGrantId}`),
      undefined,
      ownerOnly(204),
    );
  });

  it("participants and agents: readers list them, only the owner adds or removes a persona", async () => {
    await probe(
      "GET participants",
      "GET",
      route(() => `/api/v1/ai-chats/${p6.chatId}/participants`),
      undefined,
      reader(200),
    );
    await probe(
      "POST agents (already a member)",
      "POST",
      route(() => `/api/v1/ai-chats/${p6.chatId}/agents`),
      { agentId: p6.scribeId },
      ownerOnly(200),
    );
    await probe(
      "DELETE agent",
      "DELETE",
      route(() => `/api/v1/ai-chats/${p6.chatId}/agents/${p6.extraId}`),
      undefined,
      ownerOnly(204),
    );
  });

  it("snapshot, page and read marker follow readability; a view grantee's send is 403 ai_chat_view_only", async () => {
    await probe(
      "GET snapshot",
      "GET",
      route(() => `/api/v1/ai-chats/${p6.chatId}`),
      undefined,
      reader(200),
    );
    await probe(
      "GET page",
      "GET",
      route(() => `/api/v1/ai-chats/${p6.chatId}/messages`),
      undefined,
      reader(200),
    );
    await probe(
      "POST read",
      "POST",
      route(() => `/api/v1/ai-chats/${p6.chatId}/read`),
      { seq: 0 },
      reader(204),
    );
    await probe(
      "POST message (not addressed to the model)",
      "POST",
      route(() => `/api/v1/ai-chats/${p6.chatId}/messages`),
      () => ({ clientMessageId: cid(), body: "noted", model: MODELS.anthropic, askAi: false }),
      {
        owner: 202,
        chat: 202,
        view: [403, "ai_chat_view_only"],
        revoked: 404,
        admin: 404,
        orgB: 404,
      },
    );
    // Nobody without access joined the chat by probing it (a read marker must not make a member).
    const members = (
      await su.query(
        "select member_id from app.conversation_members where conversation_id = $1 and member_kind = 'user'",
        [p6.chatId],
      )
    ).rows.map((r) => r.member_id as string);
    expect(members).not.toContain(p6.ids.revoked);
    expect(members).not.toContain(await idOf(admin));
    expect(members).toEqual(expect.arrayContaining([p6.ids.owner, p6.ids.chat]));
  });

  it("cards: readers read and follow; the view grantee may not decide (403); the chat grantee decides once", async () => {
    await probe(
      "GET card",
      "GET",
      route(() => `/api/v1/cards/${p6.cardId}`),
      undefined,
      reader(200),
    );
    await probe(
      "POST follow",
      "POST",
      route(() => `/api/v1/cards/${p6.cardId}/follow`),
      undefined,
      reader(204),
    );
    await probe(
      "DELETE follow",
      "DELETE",
      route(() => `/api/v1/cards/${p6.cardId}/follow`),
      undefined,
      reader(204),
    );
    await probe(
      "POST decision",
      "POST",
      route(() => `/api/v1/cards/${p6.cardId}/decision`),
      { outcome: "approved" },
      {
        orgB: 404,
        admin: 404,
        revoked: 404,
        view: [403, "ai_chat_view_only"],
        chat: 200,
        owner: [409, "card_already_decided"],
      },
    );
    const card = (
      await su.query("select decision, decided_by from app.message_cards where message_id = $1", [p6.cardId])
    ).rows[0];
    expect(card).toEqual({ decision: "approved", decided_by: p6.ids.chat });
  });

  it("the Agent Channel card routes refuse another organization's cell token", async () => {
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [p6.orgB, sha256Hex(tokenB)],
    );
    const foreignAgentId = randomUUID();
    await su.query(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, $2, 'Intruder', 'intruder', 'x', 'mock', 'mock-1', 'ready')`,
      [foreignAgentId, p6.orgB],
    );
    const b = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: tokenB });
    cells.push(b);
    const before = (
      await su.query("select version, status from app.message_cards where message_id = $1", [p6.cardId])
    ).rows[0];
    for (const agentId of [p6.scribeId, foreignAgentId]) {
      const posted = await b.request<Json>("POST", "/cards", {
        agentId,
        conversationId: p6.chatId,
        threadRootId: null,
        idempotencyKey: `card-${randomUUID()}`,
        card: approvalCard(),
      });
      expect(posted.status, `post as ${agentId === p6.scribeId ? "org A's" : "its own"} agent`).toBe(404);
      const patched = await b.request<Json>("PATCH", `/cards/${p6.cardId}`, {
        agentId,
        patch: { expectedVersion: before.version, status: "failed" },
      });
      expect(patched.status).toBe(404);
    }
    expect(
      (await su.query("select version, status from app.message_cards where message_id = $1", [p6.cardId]))
        .rows[0],
    ).toEqual(before);
    const intruderCards = (
      await su.query("select count(*)::int as n from app.message_cards where agent_id = $1", [foreignAgentId])
    ).rows[0].n;
    expect(intruderCards).toBe(0);
  });
});

async function idOf(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

describe("every AI chat route refuses an anonymous caller (T-05-15-02)", () => {
  const AI_PATH =
    /^\/api\/v1\/(ai-|me\/model-credentials\/|me\/model-credentials$|me\/ai-|ai-shares\/|cards\/)/u;

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
      // Phase 6 (06-16): grants, participants, personas, the read marker and Agent Cards.
      "GET /api/v1/ai-chats/{id}/grants",
      "POST /api/v1/ai-chats/{id}/grants",
      "PATCH /api/v1/ai-chats/{id}/grants/{grantId}",
      "DELETE /api/v1/ai-chats/{id}/grants/{grantId}",
      "GET /api/v1/ai-chats/{id}/participants",
      "POST /api/v1/ai-chats/{id}/agents",
      "DELETE /api/v1/ai-chats/{id}/agents/{agentId}",
      "POST /api/v1/ai-chats/{id}/read",
      "GET /api/v1/cards/{messageId}",
      "POST /api/v1/cards/{messageId}/follow",
      "DELETE /api/v1/cards/{messageId}/follow",
      "POST /api/v1/cards/{messageId}/decision",
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

  it("the Agent Channel card routes answer 401 without a cell token, and to a user's session", async () => {
    const paths: Array<[string, string]> = [
      ["POST", "/agent-channel/v1/cards"],
      ["PATCH", `/agent-channel/v1/cards/${randomUUID()}`],
    ];
    const refused: string[] = [];
    for (const [method, path] of paths) {
      for (const auth of [{}, { authorization: "Bearer not-a-cell-token-but-long-enough-0123456789" }]) {
        const r = await fetch(`${stack.baseUrl}${path}`, {
          method,
          headers: { "content-type": "application/json", ...auth },
          body: "{}",
        });
        if (r.status !== 401) refused.push(`${method} ${path} ${JSON.stringify(auth)} → ${r.status}`);
      }
      // A signed-in member's session never reaches the Agent Channel API.
      const asUser = await fetch(`${stack.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie: sam.cookieHeader },
        body: "{}",
      });
      if (asUser.status !== 401) refused.push(`${method} ${path} as a user → ${asUser.status}`);
    }
    expect(refused).toEqual([]);
  });
});
