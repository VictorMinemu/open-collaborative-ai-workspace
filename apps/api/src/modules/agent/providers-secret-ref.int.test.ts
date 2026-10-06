import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ServerFrame, WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FakeCellPlugin, type MentionPayload } from "../../../../../e2e/support/fake-cell-plugin";
import { MissingSecretError } from "../../lib/secret-store";
import { TEST_SETUP_TOKEN, TestClient, WEB_ORIGIN } from "../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeConv, withoutTitles } from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * D-07, AICHAT-01 (05-04): organization provider keys live behind SecretReferences and are resolved ONLY through
 * `secrets.resolve(tx, secret_ref)`; one allowed-models list governs AI chats and bots; the AI chat policy can switch
 * org keys off for chats without touching bots; keys never leak into responses, frames, audit rows or logs; there is
 * no personal API key route. Real PostgreSQL + Redis, the in-process fake model and the fake OpenClaw cell.
 */

const CELL_TOKEN = "ocw-test-cell-token-secretref-0123456789abcdefghij";
const ADMIN_KEY = "sk-ant-secretref-ADMINKEY-0123456789-q1W2";
const ENV_KEY = "sk-ant-secretref-ENVKEY-0123456789-e3R4";
const KEY_A = "sk-ant-secretref-KEYA-0123456789-a5T6";
const KEY_B = "sk-ant-secretref-KEYB-0123456789-b7Y8";
const FOREIGN_KEY = "sk-ant-secretref-FOREIGN-0123456789-f9U0";
const LEGACY_KEY = "sk-or-secretref-LEGACY-0123456789-l1I2";
const ALL_KEYS = [ADMIN_KEY, ENV_KEY, KEY_A, KEY_B, FOREIGN_KEY, LEGACY_KEY];

const SONNET = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
const HAIKU = { backend: "org_key", provider: "anthropic", modelId: "claude-haiku-4-5" } as const;

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let samId: string;
let orgId: string;
let channelId: string;
const plugins: FakeCellPlugin[] = [];
/** Every /api/v1 response body seen by the tests (scanned for keys at the end). */
const bodies: string[] = [];
/** Every WS frame received by Sam's and the admin's sockets. */
const frames: ServerFrame[] = [];
const sockets: WebSocket[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const cid = () => `cm-${randomUUID()}`;
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function call(c: TestClient, method: string, path: string, body?: unknown) {
  const res = await c.request(method, path, body);
  bodies.push(JSON.stringify(res.body));
  return res;
}

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const upsertAnthropic = (allowedModels: string[], extra: Json = {}) =>
  ok(
    call(admin, "POST", "/api/v1/model-providers", {
      provider: "anthropic",
      baseUrl: stack.fake.baseUrl,
      allowedModels,
      ...extra,
    }),
  );

const createChat = (model: Json, body = "Hello") =>
  call(sam, "POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model });

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** One AI chat turn on `model`; returns the `x-api-key` the fake Anthropic endpoint saw. */
async function anthropicKeyOfTurn(model: Json = SONNET): Promise<string | undefined> {
  stack.fake.reset();
  const res = await createChat(model);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const g = await settled((res.body as Json).generation.id);
  expect(g.status, JSON.stringify(g)).toBe("completed");
  const calls = withoutTitles(stack.fake.requests("anthropic"));
  expect(calls).toHaveLength(1);
  return calls[0]?.headers["x-api-key"] as string | undefined;
}

function plugin(opts: Partial<ConstructorParameters<typeof FakeCellPlugin>[0]> = {}) {
  const p = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN, ...opts });
  plugins.push(p);
  return p;
}

const cellSnapshot = () => plugin().fetchCell();

/** Opens `/ws` as `client` and subscribes to `topics`; every frame lands in `frames`. */
async function watch(client: TestClient, topics: string[]) {
  const token = await client.token();
  const socket = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  sockets.push(socket);
  socket.on("message", (m) => frames.push(JSON.parse(String(m)) as ServerFrame));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  for (const topic of topics) socket.send(JSON.stringify({ op: "sub", topic }));
  const until = Date.now() + 5_000;
  while (
    !topics.every((t) =>
      frames.some((f) => (f.op === "subscribed" || f.op === "err") && (f as { topic?: string }).topic === t),
    )
  ) {
    if (Date.now() > until) throw new Error(`subscribe timed out: ${topics.join(", ")}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Seals `value` as org `organizationId`'s provider key through the secrets service; returns the secret id. */
async function sealFor(organizationId: string, value: string): Promise<string> {
  const { core } = stack.built;
  return core.db.withTenant({ organizationId }, (tx) =>
    core.secrets.put(tx, { name: "test key", kind: "provider_api_key", provider: "anthropic", value }),
  );
}

const setRef = (provider: string, secretRef: Json | null, secretId: string | null = null) =>
  su.query("update app.model_providers set secret_ref = $2, secret_id = $3 where provider = $1", [
    provider,
    secretRef === null ? null : JSON.stringify(secretRef),
    secretId,
  ]);

/** The `*_provider_secret_refs` backfill statement exactly as shipped (05-01). */
function backfillSql(): string {
  const dir = join(import.meta.dirname, "../../../../../packages/db/drizzle");
  const found = readdirSync(dir).filter((d) => d.endsWith("_provider_secret_refs"));
  expect(found).toHaveLength(1);
  return readFileSync(join(dir, found[0] as string, "migration.sql"), "utf8");
}

beforeAll(async () => {
  stack = await startAiStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_TEST_PROVIDER_KEY: ENV_KEY },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    call(admin, "POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  await seedPlan(sam);
  channelId = (await ok(call(admin, "POST", "/api/v1/channels", { name: "models" }))).id;
  await watch(admin, [`org:${orgId}`, `user:${setup.user.id}`]);
  await watch(sam, [`org:${orgId}`, `user:${samId}`]);
  await upsertAnthropic(["claude-sonnet-5-5", "claude-haiku-4-5"], { apiKey: ADMIN_KEY });
});

afterAll(async () => {
  for (const p of plugins) await p.stop();
  for (const s of sockets) s.close();
  await su?.end();
  await stack?.stop();
});

describe("one allowed-models list governs AI chats and bots (D-07)", () => {
  it("before: Haiku answers an AI chat and a bot may use it", async () => {
    expect(await anthropicKeyOfTurn(HAIKU)).toBe(ADMIN_KEY);
    const bot = await call(admin, "POST", "/api/v1/agents", {
      name: "Haiku bot",
      instructions: "Short answers.",
      modelProvider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    expect(bot.status, JSON.stringify(bot.body)).toBe(200);
    expect((await call(admin, "DELETE", `/api/v1/agents/${(bot.body as Json).id}`)).status).toBe(200);
  });

  it("after the admin removes Haiku: AI chats refuse it (409 not_allowed) and so do bots (create and update)", async () => {
    await upsertAnthropic(["claude-sonnet-5-5"]);
    const res = await createChat(HAIKU);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "model_unavailable", details: { reason: "not_allowed" } });
    const list = await ok(call(sam, "GET", "/api/v1/ai-chat/models"));
    expect(list.models.some((m: Json) => m.ref.modelId === "claude-haiku-4-5")).toBe(false);

    const bot = { name: "Sonnet bot", instructions: "Helpful.", modelProvider: "anthropic" };
    expect(
      (await call(admin, "POST", "/api/v1/agents", { ...bot, modelId: "claude-haiku-4-5" })).status,
    ).toBe(400);
    const created = await ok(call(admin, "POST", "/api/v1/agents", { ...bot, modelId: "claude-sonnet-5-5" }));
    expect(
      (await call(admin, "PATCH", `/api/v1/agents/${created.id}`, { modelId: "claude-haiku-4-5" })).status,
    ).toBe(400);
    expect((await call(admin, "DELETE", `/api/v1/agents/${created.id}`)).status).toBe(200);
  });

  it("the live update reached the browsers: model_providers.updated on org:<id>", () => {
    expect(
      frames.some((f) => f.op === "ev" && (f as { type?: string }).type === "model_providers.updated"),
    ).toBe(true);
  });
});

describe("the AI chat policy switches org keys off for AI chats only", () => {
  it("orgKeysEnabled = false: every organization row is org_keys_disabled and sends are refused; bots keep working", async () => {
    await su.query(
      "insert into app.ai_chat_policies (organization_id, org_keys_enabled) values ($1, false)",
      [orgId],
    );
    try {
      const list = await ok(call(sam, "GET", "/api/v1/ai-chat/models"));
      const org = list.models.filter((m: Json) => m.group === "organization");
      expect(org.length).toBeGreaterThan(0);
      for (const m of org)
        expect(m).toMatchObject({ available: false, reason: "org_keys_disabled", metered: true });
      const res = await createChat(SONNET);
      expect(res.status).toBe(409);
      expect(errorOf(res).details).toEqual({ reason: "org_keys_disabled" });

      // Bots never read ai_chat_policies: the model stays allowed and the cell keeps the key.
      const models = await ok(call(admin, "GET", "/api/v1/models"));
      expect(
        models.models.some((m: Json) => m.provider === "anthropic" && m.modelId === "claude-sonnet-5-5"),
      ).toBe(true);
      const created = await ok(
        call(admin, "POST", "/api/v1/agents", {
          name: "Policy bot",
          instructions: "Helpful.",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-5-5",
        }),
      );
      expect((await call(admin, "DELETE", `/api/v1/agents/${created.id}`)).status).toBe(200);
      const cell = await cellSnapshot();
      expect(cell.providers.find((p) => p.id === "anthropic")?.apiKey).toBe(ADMIN_KEY);
    } finally {
      await su.query("delete from app.ai_chat_policies where organization_id = $1", [orgId]);
    }
    expect(await anthropicKeyOfTurn()).toBe(ADMIN_KEY);
  });
});

describe("keys are resolved only through secret_ref (D-07, P-10)", () => {
  let adminRef: Json;

  beforeAll(async () => {
    adminRef = (
      await su.query("select secret_ref, secret_id from app.model_providers where provider = 'anthropic'")
    ).rows[0];
  });

  afterAll(async () => {
    await setRef("anthropic", adminRef.secret_ref, adminRef.secret_id);
  });

  it("an operator `env` reference serves an AI chat turn and the cell with the env value", async () => {
    await setRef("anthropic", { provider: "env", key: "OCW_TEST_PROVIDER_KEY" });
    const dto = (await ok(call(admin, "GET", "/api/v1/model-providers"))).providers.find(
      (p: Json) => p.provider === "anthropic",
    );
    expect(dto.hasKey).toBe(true);
    expect(await anthropicKeyOfTurn()).toBe(ENV_KEY);
    const cell = await cellSnapshot();
    expect(cell.providers.find((p) => p.id === "anthropic")?.apiKey).toBe(ENV_KEY);
  });

  it("secret_id → A while secret_ref → B: the AI chat and the cell get B, never A", async () => {
    const a = await sealFor(orgId, KEY_A);
    const b = await sealFor(orgId, KEY_B);
    await setRef("anthropic", { provider: "db", secretId: b, organizationId: orgId }, a);
    expect(await anthropicKeyOfTurn()).toBe(KEY_B);
    const cell = await cellSnapshot();
    expect(cell.providers.find((p) => p.id === "anthropic")?.apiKey).toBe(KEY_B);
    expect(JSON.stringify(cell)).not.toContain(KEY_A);
  });

  it("secret_id set and secret_ref null (the rolled-back state): hasKey false, no_key for AI chats, absent from the cell", async () => {
    await setRef("anthropic", null, adminRef.secret_id);
    const dto = (await ok(call(admin, "GET", "/api/v1/model-providers"))).providers.find(
      (p: Json) => p.provider === "anthropic",
    );
    expect(dto).toMatchObject({ hasKey: false, keyHint: null });
    const list = await ok(call(sam, "GET", "/api/v1/ai-chat/models"));
    for (const m of list.models.filter((x: Json) => x.ref.provider === "anthropic")) {
      expect(m).toMatchObject({ available: false, reason: "no_key" });
    }
    stack.fake.reset();
    const res = await createChat(SONNET);
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toEqual({ reason: "no_key" });
    expect(withoutTitles(stack.fake.requests("anthropic"))).toHaveLength(0);
    const cell = await cellSnapshot();
    expect(cell.providers.some((p) => p.id === "anthropic")).toBe(false);
  });

  it("a `db` reference naming another organization never resolves to that organization's key", async () => {
    const orgB = randomUUID();
    await su.query(
      "insert into auth.organization (id, name, slug, created_at) values ($1, 'Other', 'other-b', now())",
      [orgB],
    );
    const foreign = await sealFor(orgB, FOREIGN_KEY);
    const { core } = stack.built;

    // The service refuses outright, whichever organization the reference claims.
    await core.db.withTenant({ organizationId: orgId }, async (tx) => {
      await expect(
        core.secrets.resolve(tx, { provider: "db", secretId: foreign, organizationId: orgB }),
      ).rejects.toBeInstanceOf(MissingSecretError);
      await expect(
        core.secrets.resolve(tx, { provider: "db", secretId: foreign, organizationId: orgId }),
      ).rejects.toBeInstanceOf(MissingSecretError);
    });

    for (const ref of [
      { provider: "db", secretId: foreign, organizationId: orgB },
      { provider: "db", secretId: foreign, organizationId: orgId },
    ]) {
      await setRef("anthropic", ref);
      stack.fake.reset();
      const res = await createChat(SONNET);
      expect(res.status).toBe(409);
      expect(errorOf(res).details).toEqual({ reason: "no_key" });
      expect(withoutTitles(stack.fake.requests("anthropic"))).toHaveLength(0);
      const cell = await cellSnapshot();
      expect(cell.providers.some((p) => p.id === "anthropic")).toBe(false);
      expect(JSON.stringify(cell)).not.toContain(FOREIGN_KEY);
    }
  });
});

describe("a provider migrated by the 05-01 backfill still serves its bots", () => {
  it("legacy row (secret_id only) + team bot → backfill SQL → the cell gets the key and the bot answers a mention", async () => {
    const secretId = await sealFor(orgId, LEGACY_KEY);
    await su.query(
      `insert into app.model_providers (organization_id, provider, secret_id, secret_ref, key_hint, base_url, allowed_models, enabled)
       values ($1, 'openrouter', $2, null, 'l1I2', $3, '{openai/gpt-5}', true)`,
      [orgId, secretId, `${stack.fake.baseUrl}/v1`],
    );
    const botId = randomUUID();
    await su.query(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, scope)
       values ($1, $2, 'Legacy', 'legacy', 'You answer briefly.', 'openrouter', 'openai/gpt-5', 'provisioning', 'team')`,
      [botId, orgId],
    );
    // Before the backfill the new reference-only code does not see the key.
    expect((await cellSnapshot()).providers.some((p) => p.id === "openrouter")).toBe(false);

    await su.query(backfillSql());
    const row = (await su.query("select * from app.model_providers where provider = 'openrouter'")).rows[0];
    expect(row.secret_ref).toEqual({ provider: "db", secretId, organizationId: orgId });

    const p = plugin({ autoAck: true, autoReply: true });
    await p.start();
    const cell = p.snapshot!;
    expect(cell.providers.find((x) => x.id === "openrouter")).toMatchObject({
      apiKey: LEGACY_KEY,
      models: ["openai/gpt-5"],
    });
    expect(cell.agents.find((a) => a.id === botId)).toMatchObject({ modelRef: "openrouter/openai/gpt-5" });

    const posted = await ok(
      call(admin, "POST", `/api/v1/conversations/${channelId}/messages`, {
        body: "@legacy are you there?",
        mentions: [{ kind: "agent", id: botId }],
      }),
    );
    const ev = await p.waitFor(
      (e) => e.type === "agent.mention.v1" && (e.data as unknown as MentionPayload).message.id === posted.id,
    );
    expect((ev.data as unknown as MentionPayload).agent.id).toBe(botId);
    await p.waitUntil(() => p.replies.length > 0);
    expect(p.replies[0]?.mention.agent.id).toBe(botId);
  });
});

describe("no personal API key path and no leak (T-05-04-01, T-05-04-03)", () => {
  it("a standard member cannot upsert or delete a provider (403)", async () => {
    const upsert = await call(sam, "POST", "/api/v1/model-providers", {
      provider: "anthropic",
      apiKey: "sk-ant-member-attempt-0000",
      allowedModels: ["claude-sonnet-5-5"],
    });
    expect(upsert.status).toBe(403);
    expect((await call(sam, "DELETE", "/api/v1/model-providers/anthropic")).status).toBe(403);
  });

  it("the OpenAPI document has exactly one request body with an apiKey property, under /model-providers", async () => {
    const res = await fetch(`${stack.baseUrl}/docs/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, Json>> };
    const withKey: string[] = [];
    const hasApiKey = (v: unknown): boolean => {
      if (Array.isArray(v)) return v.some(hasApiKey);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (o.properties && typeof o.properties === "object" && "apiKey" in (o.properties as object))
          return true;
        return Object.values(o).some(hasApiKey);
      }
      return false;
    };
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (op && typeof op === "object" && hasApiKey((op as Json).requestBody)) {
          withKey.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(withKey).toHaveLength(1);
    expect(withKey[0]).toMatch(/^POST \/api\/v1\/model-providers$/u);
  });

  it("no key appears in any API response, WS frame, audit row or log line of this file", async () => {
    // Give in-flight frames a moment to land.
    await new Promise((r) => setTimeout(r, 300));
    const responses = bodies.join("\n");
    const ws = JSON.stringify(frames);
    const audit = JSON.stringify(
      (await su.query("select action, metadata, resource_type from app.audit_events")).rows,
    );
    const logs = stack.logs.join("\n");
    expect(frames.length).toBeGreaterThan(0);
    for (const key of ALL_KEYS) {
      expect(responses, "responses").not.toContain(key);
      expect(ws, "ws frames").not.toContain(key);
      expect(audit, "audit rows").not.toContain(key);
      expect(logs, "logs").not.toContain(key);
    }
    // The conversation stream of an org-key chat carries no key either.
    const chat = await ok(createChat(SONNET, "one more"), 201);
    const conv = await subscribeConv(stack.baseUrl, sam, chat.chat.id);
    await settled(chat.generation.id);
    await new Promise((r) => setTimeout(r, 200));
    for (const key of ALL_KEYS) expect(JSON.stringify(conv.frames)).not.toContain(key);
    conv.close();
  });
});
