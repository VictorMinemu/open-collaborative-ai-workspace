import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { accountPoolAccounts } from "@ocw/db";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { CLAUDE_OAUTH, claudeSignInKey, openPoolToken, type PoolAccountRow } from "./index";

/**
 * 07.18-19 R3.1: an admin connects a Claude subscription account from Settings with no terminal. The API reproduces
 * `claude setup-token` (Claude Code 2.1.331): it answers the authorize URL, keeps the PKCE verifier in Redis for 10
 * minutes bound to the admin and the organization, and once the admin pastes the code (`code#state`, or the callback
 * address) exchanges it through the egress guard for the long-lived token, sealed exactly like a pasted setup-token.
 * The token endpoint here is an in-process fake reached through `OCW_EGRESS_TEST_HOSTS`; no real Anthropic endpoint
 * is ever called. The response, audit and stream never carry the token, the code or the verifier.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

/** Token-shaped values joined at runtime, so no credential-shaped literal sits whole in the repository. */
const oat = (fill: string) => ["sk", "ant", "oat01", fill.repeat(48)].join("-");
const API_KEY = ["sk", "ant", "api03", "Z".repeat(48)].join("-");

// ---------------------------------------------------------------- the fake token endpoint

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Json | null;
}
type Answer = { status: number; body: unknown };

const fake = { seen: [] as Seen[], next: [] as Answer[] };
let fakeServer: Server;
let fakePort = 0;

function startFake(): Promise<void> {
  fakeServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Json | null = null;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        body = null;
      }
      fake.seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      const answer = fake.next.shift() ?? {
        status: 200,
        body: {
          token_type: "Bearer",
          access_token: oat("F"),
          expires_in: CLAUDE_OAUTH.expiresIn,
          scope: CLAUDE_OAUTH.scope,
        },
      };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  return new Promise((resolve) =>
    fakeServer.listen(0, "127.0.0.1", () => {
      fakePort = (fakeServer.address() as AddressInfo).port;
      resolve();
    }),
  );
}

const tokenAnswer = (token: string): Answer => ({
  status: 200,
  body: {
    token_type: "Bearer",
    access_token: token,
    expires_in: CLAUDE_OAUTH.expiresIn,
    scope: "user:inference",
  },
});

// ---------------------------------------------------------------- the stack

let stack: TestStack;
let su: pg.Client;
let victor: TestClient; // admin of org A
let ada: TestClient; // another admin of org A
let sam: TestClient; // member of org A
let eve: TestClient; // admin of org B
let orgA = "";
let victorId = "";

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}
async function fails(res: Promise<Res>, status: number, code?: string): Promise<Json> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect((r.body?.error as Json | undefined)?.code, JSON.stringify(r.body)).toBe(code);
  return r.body as Json;
}

async function joinAs(email: string, name: string, role = "standard") {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const START = "/api/v1/account-pool/claude/sign-ins";
const COMPLETE = "/api/v1/account-pool/claude/sign-ins/complete";

const start = (as: TestClient, body: Json = {}) => as.request("POST", START, body);
const complete = (as: TestClient, body: Json) => as.request("POST", COMPLETE, body);

/** The flow's server-side record (verifier and state live only there). */
async function flowOf(flowId: string): Promise<Json | null> {
  const raw = await stack.built.core.bus.pub.get(claudeSignInKey(flowId));
  return raw ? (JSON.parse(raw) as Json) : null;
}

/** Starts a sign-in and returns what Anthropic's page would show: `code#state` for the flow. */
async function begin(as: TestClient = victor, body: Json = {}) {
  const started = await ok(start(as, body));
  const flow = await flowOf(started.flowId);
  if (!flow) throw new Error("no flow record");
  const code = `ac_${randomUUID().replaceAll("-", "")}`;
  return { started, flow, code, pasted: `${code}#${flow.state}` };
}

const auditRows = async (actions: string[]) =>
  (
    await su.query(
      "select action, resource_id, user_id, metadata from app.audit_events where organization_id = $1 and action = any($2) order by occurred_at, id",
      [orgA, actions],
    )
  ).rows as Json[];

const inOrgA = <T>(fn: Parameters<TestStack["built"]["core"]["db"]["withTenant"]>[1]) =>
  stack.built.core.db.withTenant({ organizationId: orgA, userId: null }, fn) as Promise<T>;

async function tokenOf(accountId: string): Promise<string | null> {
  const [row] = await inOrgA<PoolAccountRow[]>((tx) =>
    tx.select().from(accountPoolAccounts).where(eq(accountPoolAccounts.id, accountId)),
  );
  if (!row) return null;
  return inOrgA((tx) => openPoolToken(tx, stack.built.core.secrets, row));
}

/** Everything persisted or published that a token, code or verifier could leak into. */
async function persistedText(): Promise<string> {
  const audit = (await su.query("select metadata from app.audit_events")).rows;
  const stream = (await su.query("select payload from app.stream_events")).rows;
  const accounts = (await su.query("select * from app.account_pool_accounts")).rows;
  return JSON.stringify([audit, stream, accounts]);
}

beforeAll(async () => {
  await startFake();
  stack = await startTestStack({
    env: {
      OCW_EGRESS_TEST_HOSTS: "fake-anthropic=127.0.0.1",
      OCW_CLAUDE_OAUTH_TOKEN_URL: `http://fake-anthropic:${fakePort}/v1/oauth/token`,
    },
  });
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
  orgA = setup.organization.id;
  victorId = setup.user.id;
  [sam] = await joinAs("sam@example.test", "Sam Lee");
  [ada] = await joinAs("ada@example.test", "Ada King", "admin");
  let eveId: string;
  [eve, eveId] = await joinAs("eve@example.test", "Eve Black");
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
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
  await new Promise((r) => fakeServer?.close(r));
});

beforeEach(() => {
  fake.seen = [];
  fake.next = [];
});

describe("Connect a Claude account (R3.1): the claude setup-token flow, run by the API", () => {
  it("answers the setup-token authorize URL; the verifier and state stay in Redis for 10 minutes, bound to the admin", async () => {
    const res = await fetch(`${stack.baseUrl}${START}`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3999",
        cookie: victor.cookieHeader,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const started = JSON.parse(text) as Json;
    expect(Object.keys(started).sort()).toEqual(["authorizeUrl", "expiresAt", "flowId"]);

    const flow = await flowOf(started.flowId);
    expect(flow).toMatchObject({ organizationId: orgA, userId: victorId, accountId: null });
    expect(flow?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow?.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = await stack.built.core.bus.pub.ttl(claudeSignInKey(started.flowId));
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(Date.parse(started.expiresAt) - Date.now()).toBeGreaterThan(590_000);

    // Exactly what `claude setup-token` opens (claude.ai login, the manual code page, inference only, PKCE S256).
    const url = new URL(started.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.com/cai/oauth/authorize");
    expect([...url.searchParams.keys()]).toEqual([
      "code",
      "client_id",
      "response_type",
      "redirect_uri",
      "scope",
      "code_challenge",
      "code_challenge_method",
      "state",
    ]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: "true",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      response_type: "code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      scope: "user:inference",
      code_challenge: createHash("sha256").update(flow?.verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: flow?.state,
    });
    expect(text).not.toContain(flow?.verifier);
    expect(fake.seen).toEqual([]);

    const audit = await auditRows(["account_pool.sign_in_started"]);
    expect(audit.at(-1)).toMatchObject({
      user_id: victorId,
      metadata: { provider: "claude", replacing: false },
    });
  });

  it("the pasted code#state is exchanged once, as setup-token does, and the token is sealed like a pasted one", async () => {
    const { started, flow, code, pasted } = await begin();
    const token = oat("G");
    fake.next.push(tokenAnswer(token));

    const res = await fetch(`${stack.baseUrl}${COMPLETE}`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3999",
        cookie: victor.cookieHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({ flowId: started.flowId, code: `  ${pasted}\n`, label: "ana@acme" }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const account = JSON.parse(text) as Json;
    expect(account).toMatchObject({ provider: "claude", kind: "token", label: "ana@acme", status: "ready" });
    expect(text).not.toContain(token);

    // The token endpoint got exactly the setup-token exchange: JSON body, the manual redirect, a one-year token.
    expect(fake.seen).toHaveLength(1);
    const call = fake.seen[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v1/oauth/token");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toEqual({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code_verifier: flow.verifier,
      state: flow.state,
      expires_in: 31_536_000,
    });
    expect(Object.keys(call.body ?? {})).toEqual([
      "grant_type",
      "code",
      "redirect_uri",
      "client_id",
      "code_verifier",
      "state",
      "expires_in",
    ]);

    // Single use: the verifier is gone, a second paste reads as expired and calls nobody.
    expect(await flowOf(started.flowId)).toBeNull();
    await fails(
      complete(victor, { flowId: started.flowId, code: pasted, label: "ana@acme" }),
      404,
      "sign_in_expired",
    );
    expect(fake.seen).toHaveLength(1);

    // Sealed exactly like a pasted setup-token (the same add path: AAD bound to this account).
    expect(await tokenOf(account.id)).toBe(token);
    const pool = await ok(victor.request("GET", "/api/v1/account-pool"));
    expect((pool.claude.accounts as Json[]).map((a) => a.id)).toContain(account.id);

    const audit = await auditRows(["account_pool.account_added", "account_pool.signed_in"]);
    const mine = audit.filter((a) => a.resource_id === account.id);
    expect(mine.map((a) => a.action)).toEqual(["account_pool.account_added", "account_pool.signed_in"]);
    expect(mine[1]).toMatchObject({ user_id: victorId, metadata: { provider: "claude", label: "ana@acme" } });
    const persisted = await persistedText();
    for (const secret of [token, code, flow.verifier, flow.state]) expect(persisted).not.toContain(secret);
  });

  it("the callback address works too; a paste that is not a code keeps the flow, with a plain sentence", async () => {
    const { started, flow, code } = await begin();
    const wrong = await fails(
      complete(victor, { flowId: started.flowId, code: "1234-5678", label: "b@acme" }),
      400,
      "invalid_code",
    );
    expect(wrong.error.message).toBe(
      "That doesn't look like the code. Copy all of it from Anthropic's page, including the # in the middle.",
    );
    await fails(
      complete(victor, {
        flowId: started.flowId,
        code: `http://localhost:54545/callback?code=${code}`,
        label: "b@acme",
      }),
      400,
      "invalid_code",
    );
    expect(await flowOf(started.flowId)).not.toBeNull();
    expect(fake.seen).toEqual([]);

    const callback = `https://platform.claude.com/oauth/code/callback?code=${code}&state=${flow.state}`;
    fake.next.push(tokenAnswer(oat("H")));
    const account = await ok(complete(victor, { flowId: started.flowId, code: callback, label: "b@acme" }));
    expect(account).toMatchObject({ kind: "token", label: "b@acme" });
    expect(fake.seen[0]?.body).toMatchObject({ code, state: flow.state });
  });

  it("a code of another sign-in is refused and the flow is used up; nothing is exchanged", async () => {
    const { started, code } = await begin();
    const res = await fails(
      complete(victor, { flowId: started.flowId, code: `${code}#not-this-flows-state`, label: "c@acme" }),
      400,
      "state_mismatch",
    );
    expect(res.error.message).toBe(
      "That code belongs to another sign-in. Start again and paste the newest code.",
    );
    expect(fake.seen).toEqual([]);
    expect(await flowOf(started.flowId)).toBeNull();
  });

  it("Anthropic refusing the code, being unreachable, or answering an API key: clear words and no account", async () => {
    const count = async () =>
      (
        await su.query(
          "select count(*)::int as n from app.account_pool_accounts where organization_id = $1",
          [orgA],
        )
      ).rows[0].n as number;
    const before = await count();

    const a = await begin();
    fake.next.push({
      status: 400,
      body: { error: "invalid_grant", error_description: `bad code ${a.code}` },
    });
    const refused = await fails(
      complete(victor, { flowId: a.started.flowId, code: a.pasted, label: "d@acme" }),
      400,
      "code_refused",
    );
    expect(refused.error.message).toBe(
      "Anthropic didn't accept this code. It may have expired or been used already. Start again.",
    );
    expect(JSON.stringify(refused)).not.toContain(a.code);

    const b = await begin();
    fake.next.push({ status: 503, body: { error: "overloaded" } });
    const down = await fails(
      complete(victor, { flowId: b.started.flowId, code: b.pasted, label: "d@acme" }),
      502,
      "claude_unavailable",
    );
    expect(down.error.message).toBe(
      "Anthropic's sign-in isn't answering right now. Try again shortly, or paste a setup-token instead.",
    );

    const c = await begin();
    fake.next.push(tokenAnswer(API_KEY));
    await fails(
      complete(victor, { flowId: c.started.flowId, code: c.pasted, label: "d@acme" }),
      502,
      "claude_unavailable",
    );

    expect(await count()).toBe(before);
    const persisted = await persistedText();
    for (const secret of [a.code, b.code, c.code, API_KEY]) expect(persisted).not.toContain(secret);
  });

  it("Connect again on a token account replaces its token in place (same row, same order)", async () => {
    const added = await ok(
      victor.request("POST", "/api/v1/account-pool/claude/accounts", { label: "e@acme", token: oat("J") }),
    );
    const { started, pasted } = await begin(victor, { accountId: added.id });
    expect((await flowOf(started.flowId))?.accountId).toBe(added.id);
    const fresh = oat("K");
    fake.next.push(tokenAnswer(fresh));
    const replaced = await ok(complete(victor, { flowId: started.flowId, code: pasted }));
    expect(replaced).toMatchObject({ id: added.id, label: "e@acme", status: "ready" });
    expect(await tokenOf(added.id)).toBe(fresh);
    const updated = (await auditRows(["account_pool.account_updated"])).filter(
      (r) => r.resource_id === added.id,
    );
    expect(updated.at(-1)?.metadata).toMatchObject({ tokenReplaced: true });
    expect(JSON.stringify(updated)).not.toContain(fresh);

    // A new account needs its label; a missing one keeps the flow.
    const next = await begin();
    await fails(complete(victor, { flowId: next.started.flowId, code: next.pasted }), 400, "label_required");
    expect(await flowOf(next.started.flowId)).not.toBeNull();
    // Only a live token account can be connected again.
    await fails(start(victor, { accountId: randomUUID() }), 404);
  });

  it("only provider.manage admins; a flow is bound to the admin who started it and to their organization", async () => {
    await fails(start(sam), 403);
    await fails(complete(sam, { flowId: randomUUID(), code: "x#y", label: "s@acme" }), 403);

    const { started, pasted } = await begin(victor);
    // Another admin of the same organization, or another organization's admin: as if it did not exist, kept intact.
    await fails(
      complete(ada, { flowId: started.flowId, code: pasted, label: "f@acme" }),
      404,
      "sign_in_expired",
    );
    await fails(
      complete(eve, { flowId: started.flowId, code: pasted, label: "f@acme" }),
      404,
      "sign_in_expired",
    );
    expect(fake.seen).toEqual([]);
    expect(await flowOf(started.flowId)).not.toBeNull();
    fake.next.push(tokenAnswer(oat("L")));
    await ok(complete(victor, { flowId: started.flowId, code: pasted, label: "f@acme" }));
  });

  it("an API key pasted in the code field is not echoed", async () => {
    const { started } = await begin();
    const r = await complete(victor, { flowId: started.flowId, code: API_KEY, label: "g@acme" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(API_KEY);
  });
});
