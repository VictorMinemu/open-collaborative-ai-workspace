import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../../testing";
import { type AiStack, startAiStack, withoutTitles } from "../../../testing-ai";
import { invite } from "../../../testing-workzone";

/**
 * Per-member "Sign in with ChatGPT – ChatGPT plan usage" (05-05, D-02) against the in-process fake SIWC server:
 * start → authorize (302 to the loopback address) → paste → the API exchanges the code, validates the ID token,
 * checks the plan scope and seals the tokens for that member alone; the member's next AI chat turn uses them.
 * Real PostgreSQL + Redis. No real OpenAI endpoint is ever reached.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let alexId: string;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const START = "/api/v1/me/model-credentials/chatgpt/start";
const COMPLETE = "/api/v1/me/model-credentials/chatgpt/complete";
const STATUS = "/api/v1/me/model-credentials/chatgpt";

/** Every secret-shaped value seen by the test: none may reach a DB column or a log line. */
const secretsSeen = { codes: [] as string[], verifiers: [] as string[], redirects: [] as string[] };

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

const siwc = () => `${stack.fake.baseUrl}/siwc`;
async function scenario(s: Json): Promise<void> {
  const res = await fetch(`${siwc()}/__scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });
  expect(res.status).toBe(200);
}
const stats = async (): Promise<Json> => (await fetch(`${siwc()}/__stats`)).json() as Promise<Json>;

/** POST start, then follow the authorize URL like a browser would (without following the loopback redirect). */
async function startFlow(as: TestClient, body: Json = {}) {
  const start = await ok(as.request("POST", START, body));
  const flow = await stack.built.core.bus.pub.get(`ocw:ai:siwc:${start.flowId}`);
  if (flow) secretsSeen.verifiers.push((JSON.parse(flow) as Json).verifier);
  const res = await fetch(start.authorizeUrl, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code");
  if (code) secretsSeen.codes.push(code);
  secretsSeen.redirects.push(location);
  return { start, res, location };
}

const complete = (as: TestClient, flowId: string, redirectUrl: string) =>
  as.request("POST", COMPLETE, { flowId, redirectUrl });

const credential = async (userId: string) =>
  (await su.query("select * from app.user_model_credentials where user_id = $1", [userId])).rows[0] as
    | Json
    | undefined;
const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const bearerOf = (r: { headers: Record<string, unknown> }) =>
  String(r.headers.authorization ?? "").replace(/^Bearer\s+/u, "");

/** Signs `as` in end to end (start → authorize → complete) and returns the status. */
async function signIn(as: TestClient): Promise<Json> {
  const { start, location } = await startFlow(as);
  return ok(complete(as, start.flowId, location));
}

/** The member's sealed token bundle, opened the way the API does (test-only: never printed). */
async function bundleOf(userId: string): Promise<Json | null> {
  const cred = await credential(userId);
  if (!cred?.secret_id) return null;
  const { core } = stack.built;
  return core.db.withTenant({ organizationId: orgId }, async (tx) =>
    JSON.parse(await core.secrets.revealSealed(tx, cred.secret_id, `${orgId}:${userId}:chatgpt_plan`)),
  );
}

const sendTurn = (as: TestClient, chatId: string, body: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: `cm-${randomUUID()}`,
    body,
    model: PLAN_MODEL,
  });

async function newChat(as: TestClient, body: string): Promise<string> {
  const res = await as.request("POST", "/api/v1/ai-chats", {
    clientMessageId: `cm-${randomUUID()}`,
    body,
    model: PLAN_MODEL,
  });
  if (res.status !== 201) throw new Error(`create chat: ${res.status} ${JSON.stringify(res.body)}`);
  await settled((res.body as Json).generation.id);
  return (res.body as Json).chat.id;
}

/** Every text, varchar, text[] and jsonb value of every app.* and auth.* table, as one string per row. */
async function everyStoredText(): Promise<string> {
  const cols = (
    await su.query(
      `select table_schema, table_name, column_name from information_schema.columns
        where table_schema in ('app','auth')
          and data_type in ('text','character varying','jsonb','json','ARRAY')
          and table_name in (select table_name from information_schema.tables
                              where table_schema = columns.table_schema and table_type = 'BASE TABLE')`,
    )
  ).rows as Array<{ table_schema: string; table_name: string; column_name: string }>;
  const out: string[] = [];
  for (const c of cols) {
    const rows = (
      await su.query(
        `select "${c.column_name}"::text as v from "${c.table_schema}"."${c.table_name}" where "${c.column_name}" is not null`,
      )
    ).rows as Array<{ v: string }>;
    for (const r of rows) out.push(r.v);
  }
  return out.join("\n");
}

beforeAll(async () => {
  stack = await startAiStack();
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
  ({ client: alex, userId: alexId } = await invite(
    stack,
    admin,
    "alex@example.test",
    "Alex Kim",
    "standard",
  ));
  // An organization model (05-04) exists, so "organization rows stay available" below is a real assertion.
  await ok(
    admin.request("POST", "/api/v1/model-providers", {
      provider: "anthropic",
      apiKey: "sk-ant-signin-SECRET-0123456789-z9Yx",
      baseUrl: stack.fake.baseUrl,
      allowedModels: ["claude-sonnet-5-5"],
    }),
  );
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("Sam connects his own ChatGPT plan by pasting the loopback address (D-02)", () => {
  let hostId: string;

  it("start answers an authorize URL on the auth server and a flow that expires in 10 minutes", async () => {
    const before = Date.now();
    const { start, res, location } = await startFlow(sam);
    expect(start.authorizeUrl.startsWith(`${siwc()}/api/accounts/authorize?`)).toBe(true);
    expect(Date.parse(start.expiresAt) - before).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(start.expiresAt) - before).toBeLessThanOrEqual(10 * 60_000 + 1_000);
    const q = new URL(start.authorizeUrl).searchParams;
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(q.get("agent_name_hint")).toBe("Open Collaborative AI Workspace");
    hostId = q.get("ext_agent_host_id") ?? "";
    expect(hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/u);
    const policy = (await su.query("select * from app.ai_chat_policies where organization_id = $1", [orgId]))
      .rows[0];
    expect(policy.chatgpt_host_id).toBe(hostId);

    expect(res.status).toBe(302);
    const loopback = new URL(location);
    expect(loopback.host).toBe("127.0.0.1:1455");
    expect(loopback.pathname).toBe("/auth/callback");

    const done = await ok(complete(sam, start.flowId, location));
    expect(done).toMatchObject({ state: "connected", email: "member@fake-chatgpt.test", planType: "plus" });
    expect(JSON.stringify(done)).not.toMatch(/fake-plan-|fake-refresh-|fake-code-/u);

    // Single use: the same flow cannot be completed twice.
    const again = await complete(sam, start.flowId, location);
    expect(again.status).toBe(404);
    expect(errorOf(again).code).toBe("flow_not_found");
  });

  it("the credential row holds identity metadata only; the tokens are one sealed secret", async () => {
    const cred = await credential(samId);
    expect(cred).toMatchObject({
      status: "connected",
      provider: "chatgpt_plan",
      subject: "fake-chatgpt-user-1",
      email: "member@fake-chatgpt.test",
      plan_type: "plus",
    });
    expect(cred?.issued_client_id).toMatch(/^oaiapp_fake_/u);
    expect(cred?.scopes).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ]);
    const ttl = Date.parse(cred?.access_expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(3_500_000);
    expect(ttl).toBeLessThanOrEqual(3_600_000);
    const secrets = (
      await su.query(
        "select * from app.secrets where organization_id = $1 and kind = 'user_model_credential'",
        [orgId],
      )
    ).rows;
    expect(secrets).toHaveLength(1);
    expect(secrets[0].id).toBe(cred?.secret_id);
  });

  it("no plaintext token, code or verifier exists in any text or jsonb column of app.* or auth.*", async () => {
    const all = await everyStoredText();
    expect(all).not.toContain("fake-plan-");
    expect(all).not.toContain("fake-refresh-");
    for (const v of [...secretsSeen.codes, ...secretsSeen.verifiers]) expect(all).not.toContain(v);
  });

  it("Sam's next AI chat turn on a plan model reaches the provider with his issued token", async () => {
    stack.fake.reset();
    const res = await sam.request("POST", "/api/v1/ai-chats", {
      clientMessageId: `cm-${randomUUID()}`,
      body: "Hello on my own plan",
      model: PLAN_MODEL,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const g = await settled((res.body as Json).generation.id);
    expect(g.status).toBe("completed");
    const calls = withoutTitles(stack.fake.requests("responses"));
    expect(calls.length).toBeGreaterThan(0);
    const token = bearerOf(calls.at(-1) as { headers: Record<string, unknown> });
    expect(token).toMatch(/^fake-plan-/u);
    expect((await stats()).accessTokenHashes).toContain(sha256(token));
  });

  it("a second sign-in reuses the issued client id and keeps the deployment host id", async () => {
    const cred = await credential(samId);
    const { start, location } = await startFlow(sam);
    const q = new URL(start.authorizeUrl).searchParams;
    expect(q.get("client_id")).toBe(cred?.issued_client_id);
    expect(q.has("ext_agent_host_id")).toBe(false);
    await ok(complete(sam, start.flowId, location));
    const policy = (await su.query("select * from app.ai_chat_policies where organization_id = $1", [orgId]))
      .rows[0];
    expect(policy.chatgpt_host_id).toBe(hostId);
    expect((await credential(samId))?.issued_client_id).toBe(cred?.issued_client_id);
    // Alex registers with the same deployment host id.
    const alexStart = await ok(alex.request("POST", START, {}));
    expect(new URL(alexStart.authorizeUrl).searchParams.get("ext_agent_host_id")).toBe(hostId);
  });
});

describe("failure paths: nothing is stored and flows stay bound to their member", () => {
  it("Alex cannot complete Sam's flow (404) and Sam still can", async () => {
    const { start, location } = await startFlow(sam);
    const foreign = await complete(alex, start.flowId, location);
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).code).toBe("flow_not_found");
    expect(await credential(alexId)).toBeUndefined();
    await ok(complete(sam, start.flowId, location));
  });

  it("an unknown flow id is 404", async () => {
    const res = await complete(sam, randomUUID(), "http://127.0.0.1:1455/auth/callback?code=x&state=y");
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("flow_not_found");
  });

  it("another state is 400 state_mismatch and stores nothing", async () => {
    const { start, location } = await startFlow(alex);
    const url = new URL(location);
    url.searchParams.set("state", "forged-state");
    const res = await complete(alex, start.flowId, url.toString());
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("state_mismatch");
    expect(await credential(alexId)).toBeUndefined();
    // The flow is consumed: a mismatch may be an attack.
    const retry = await complete(alex, start.flowId, location);
    expect(retry.status).toBe(404);
  });

  it("error=access_denied is 400 signin_cancelled", async () => {
    await scenario({ deny: true });
    const { start, location } = await startFlow(alex);
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
    const res = await complete(alex, start.flowId, location);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("signin_cancelled");
    expect(await credential(alexId)).toBeUndefined();
    await scenario({});
  });

  it("an auth server outage on the code exchange is 502 chatgpt_unavailable", async () => {
    const { start, location } = await startFlow(alex);
    await scenario({ token_unavailable: true });
    const res = await complete(alex, start.flowId, location);
    expect(res.status).toBe(502);
    expect(errorOf(res).code).toBe("chatgpt_unavailable");
    expect(await credential(alexId)).toBeUndefined();
    await scenario({});
  });

  it("a pasted address that is not the loopback callback is 400 invalid_redirect and the flow survives", async () => {
    const { start, location } = await startFlow(alex);
    const wrongHost = location.replace("127.0.0.1", "localhost");
    const bad = await complete(alex, start.flowId, wrongHost);
    expect(bad.status).toBe(400);
    expect(errorOf(bad).code).toBe("invalid_redirect");
    const garbage = await complete(alex, start.flowId, "hello there");
    expect(errorOf(garbage).code).toBe("invalid_redirect");
    // The real address still completes the same flow.
    await ok(complete(alex, start.flowId, location));
  });

  it("without the plan scope Alex is plan_usage_disabled and the plan rows say why", async () => {
    await scenario({ no_plan_scope: true });
    const { start, location } = await startFlow(alex);
    const done = await ok(complete(alex, start.flowId, location));
    expect(done.state).toBe("plan_usage_disabled");
    const list = await ok(alex.request("GET", "/api/v1/ai-chat/models"));
    const plan = list.models.filter((m: Json) => m.group === "chatgpt_plan");
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((m: Json) => !m.available && m.reason === "plan_usage_disabled")).toBe(true);
    await scenario({});
  });

  it("when the organization turns the plan off, start is 409 disabled_by_org", async () => {
    await su.query(
      "update app.ai_chat_policies set chatgpt_plan_enabled = false where organization_id = $1",
      [orgId],
    );
    const res = await sam.request("POST", START, {});
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("disabled_by_org");
    await su.query("update app.ai_chat_policies set chatgpt_plan_enabled = true where organization_id = $1", [
      orgId,
    ]);
  });

  it("start refuses a redirect port outside the unprivileged range", async () => {
    const res = await sam.request("POST", START, { redirectPort: 80 });
    expect(res.status).toBe(400);
  });
});

describe("refresh is serialized and rotation-safe; failures degrade (Pitfall 2)", () => {
  let chatA: string;
  let chatB: string;

  it("two racing sends refresh an expiring token exactly once and both use the new token", async () => {
    chatA = await newChat(sam, "First chat");
    chatB = await newChat(sam, "Second chat");
    await scenario({ expires_in: 1 });
    await signIn(sam);
    await scenario({});
    const old = await bundleOf(samId);
    expect(Date.parse(old?.expiresAt) - Date.now()).toBeLessThan(5 * 60_000);
    const before = await stats();
    stack.fake.reset();

    const [a, b] = await Promise.all([sendTurn(sam, chatA, "race one"), sendTurn(sam, chatB, "race two")]);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    await settled((a.body as Json).generation.id);
    await settled((b.body as Json).generation.id);

    const after = await stats();
    expect(after.refresh - before.refresh).toBe(1);
    const newest = after.accessTokenHashes.at(-1);
    const bearers = withoutTitles(stack.fake.requests("responses")).map((r) => sha256(bearerOf(r)));
    expect(bearers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(bearers)).toEqual(new Set([newest]));
    expect(bearers).not.toContain(sha256(old?.accessToken));

    const fresh = await bundleOf(samId);
    expect(fresh?.refreshToken).not.toBe(old?.refreshToken);
    expect(fresh?.clientId).toBe(old?.clientId);
    const cred = await credential(samId);
    expect(Date.parse(cred?.access_expires_at) - Date.now()).toBeGreaterThan(3_500_000);
    expect(cred?.status).toBe("connected");

    // The old refresh token was rotated: replaying it is refused by the auth server.
    const replay = await fetch(`${siwc()}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: old?.refreshToken,
        client_id: old?.clientId,
      }),
    });
    expect(((await replay.json()) as Json).error).toBe("refresh_token_reused");
  });

  it("a transient auth outage keeps the tokens and the send answers 503 usage_unavailable", async () => {
    await scenario({ expires_in: 1 });
    await signIn(sam);
    const cred = await credential(samId);
    const bundle = await bundleOf(samId);
    await scenario({ token_unavailable: true });
    const res = await sendTurn(sam, chatA, "during an outage");
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(errorOf(res).code).toBe("usage_unavailable");
    const now = await credential(samId);
    expect(now?.status).toBe("connected");
    expect(now?.secret_id).toBe(cred?.secret_id);
    expect(await bundleOf(samId)).toEqual(bundle);
    await scenario({});
  });

  it("a stale refresh token moves the member to needs_reconnect, deletes the secret and audits the reason", async () => {
    // The token from the previous case is still expiring: one refresh rotates it.
    const cred = await credential(samId);
    const stale = (
      await su.query("select ciphertext, iv, tag from app.secrets where id = $1", [cred?.secret_id])
    ).rows[0];
    await ok(sam.request("GET", "/api/v1/ai-chat/models"));
    const rotated = await credential(samId);
    expect(rotated?.secret_id).not.toBe(cred?.secret_id);
    // Restore the pre-rotation bundle (its refresh token is now a rotated one).
    await su.query("update app.secrets set ciphertext = $2, iv = $3, tag = $4 where id = $1", [
      rotated?.secret_id,
      stale.ciphertext,
      stale.iv,
      stale.tag,
    ]);

    const res = await sendTurn(sam, chatA, "after the rotation race");
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "model_unavailable", details: { reason: "needs_reconnect" } });
    const now = await credential(samId);
    expect(now).toMatchObject({
      status: "needs_reconnect",
      secret_id: null,
      last_error: "refresh_token_reused",
    });
    const gone = await su.query("select 1 from app.secrets where id = $1", [rotated?.secret_id]);
    expect(gone.rowCount).toBe(0);
    const failed = await audit("ai_credential.refresh_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].metadata).toEqual({ provider: "chatgpt_plan", reason: "refresh_token_reused" });
    const me = await ok(sam.request("GET", STATUS));
    expect(me.state).toBe("needs_reconnect");
  });
});

describe("disconnect revokes at the auth server and erases the member's tokens", () => {
  it("Alex's disconnect never touches Sam's connection", async () => {
    await signIn(sam);
    const samCred = await credential(samId);
    await ok(alex.request("DELETE", STATUS));
    expect(await credential(alexId)).toBeUndefined();
    expect((await credential(samId))?.secret_id).toBe(samCred?.secret_id);
  });

  it("DELETE revokes the refresh and access tokens, deletes the secret and the row, and audits", async () => {
    const cred = await credential(samId);
    const before = await stats();
    const status = await ok(sam.request("DELETE", STATUS));
    expect(status).toMatchObject({ state: "not_connected", email: null, planType: null });
    const after = await stats();
    expect(after.revoke - before.revoke).toBe(2);
    expect(after.revokedRefreshTokens - before.revokedRefreshTokens).toBe(1);
    expect(after.revokedAccessTokens - before.revokedAccessTokens).toBe(1);
    expect(await credential(samId)).toBeUndefined();
    expect((await su.query("select 1 from app.secrets where id = $1", [cred?.secret_id])).rowCount).toBe(0);
    const disconnected = await audit("ai_credential.disconnected");
    expect(disconnected.at(-1)?.metadata).toEqual({ provider: "chatgpt_plan" });
    expect(disconnected.at(-1)?.user_id).toBe(samId);

    const list = await ok(sam.request("GET", "/api/v1/ai-chat/models"));
    const plan = list.models.filter((m: Json) => m.group === "chatgpt_plan");
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((m: Json) => !m.available && m.reason === "not_connected")).toBe(true);
    // Disconnecting the plan never touches the organization's models (05-04 merged: this is no longer vacuous).
    const org = list.models.filter((m: Json) => m.group === "organization");
    expect(org.map((m: Json) => m.ref)).toEqual([
      { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" },
    ]);
    expect(list.models.filter((m: Json) => m.group !== "chatgpt_plan").every((m: Json) => m.available)).toBe(
      true,
    );
    expect(list.defaultRef).toEqual({
      backend: "org_key",
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });

    const send = await sam.request("POST", "/api/v1/ai-chats", {
      clientMessageId: `cm-${randomUUID()}`,
      body: "after disconnect",
      model: PLAN_MODEL,
    });
    expect(send.status).toBe(409);
    expect(errorOf(send).details.reason).toBe("not_connected");
  });

  it("disconnecting without a connection is idempotent and calls nothing", async () => {
    const before = await stats();
    const status = await ok(sam.request("DELETE", STATUS));
    expect(status.state).toBe("not_connected");
    expect((await stats()).revoke).toBe(before.revoke);
  });
});

describe("audit and logs carry no secret", () => {
  it("signin_started and connected audits carry {provider, state} only", async () => {
    const started = await audit("ai_credential.signin_started");
    const connected = await audit("ai_credential.connected");
    expect(started.length).toBeGreaterThanOrEqual(3);
    expect(connected.length).toBeGreaterThanOrEqual(3);
    for (const row of [...started, ...connected]) {
      expect(Object.keys(row.metadata ?? {}).sort()).toEqual(["provider", "state"]);
      expect(row.metadata.provider).toBe("chatgpt_plan");
    }
    expect(connected.map((r) => r.metadata.state)).toContain("plan_usage_disabled");
  });

  it("no log line contains a code, a verifier, a token or the pasted address", () => {
    expect(stack.logs.length).toBeGreaterThan(0);
    const all = stack.logs.join("\n");
    expect(all).not.toContain("fake-plan-");
    expect(all).not.toContain("fake-refresh-");
    expect(all).not.toContain("fake-code-");
    expect(all).not.toContain("/auth/callback");
    for (const v of [...secretsSeen.codes, ...secretsSeen.verifiers, ...secretsSeen.redirects].filter(
      Boolean,
    ))
      expect(all).not.toContain(v);
  });
});
