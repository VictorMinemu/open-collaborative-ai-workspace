import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { expect } from "vitest";
import {
  createFakeSandboxd,
  type FakeSandboxd,
  type FakeSandboxdStats,
} from "../../../infra/fake-model/fake-sandboxd.mjs";
import type { BrowserBudgets, SandboxBudgets } from "./modules/agent-channel";
import { pushPolicy } from "./modules/sandbox";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";

/**
 * Shared fixture of the bot sandbox integration tests (07.8-05; later 10, 11, 14, 18): the full API on real PostgreSQL
 * and Redis, the in-memory sandboxd (`infra/fake-model/fake-sandboxd.mjs`) in-process on loopback as
 * `OCW_SANDBOX_URL`, and two organizations. Organization A: Víctor (admin), Sam Lee and Alex Kim (standard), the team
 * bot Scout (sandbox switch on) and Sam's DM with it. Organization B: Eve (admin). Turns are real deliveries: a person
 * writes, the mention handler runs `turnPolicy`, and the test reads the `agent.mention.v1` event.
 *
 * Everything started here is stopped in `stop()` whatever fails (P-17 testcontainers hygiene, WINDOWS #213/#225): the
 * database clients, the stack (app, Redis, PostgreSQL) and the fake server.
 */

export const SANDBOX_CELL_TOKEN = "ocw-test-cell-token-sandbox-0123456789abcdef";
export const FAKE_SANDBOXD_TOKEN = "ocw-test-sandboxd-token-0123456789abcdef";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
export type Json = Record<string, any>;
export type Res = { status: number; body: Json | null };

export interface FakeSandboxdServer {
  /** `http://127.0.0.1:<port>`: what the API is configured with. */
  url: string;
  token: string;
  fake: FakeSandboxd;
  /** Call counts per op (and per organization), never bodies. */
  stats(): FakeSandboxdStats;
  stop(): Promise<void>;
}

/** The in-memory sandboxd on a random loopback port. */
export async function startFakeSandboxd(token = FAKE_SANDBOXD_TOKEN): Promise<FakeSandboxdServer> {
  const fake = createFakeSandboxd({ token, namespace: `ocw-test-${randomUUID().slice(0, 8)}` });
  const server: Server = createServer((req, res) => {
    void fake.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    fake,
    stats: () => fake.stats(),
    async stop() {
      // Release any long poll first, then every connection.
      fake.reset();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface SandboxStack {
  stack: TestStack;
  sandboxd: FakeSandboxdServer;
  su: pg.Client;
  orgA: string;
  orgB: string;
  victor: TestClient;
  sam: TestClient;
  alex: TestClient;
  eve: TestClient;
  victorId: string;
  samId: string;
  alexId: string;
  eveId: string;
  /** The team bot Scout (organization A), sandbox switch on. */
  scoutId: string;
  /** Sam's one-person DM with Scout. */
  samDm: string;
  logs: string[];
  /** POST to the Agent Channel with a cell token (organization A's by default). */
  cell(path: string, body: unknown, token?: string): Promise<Res>;
  /** `who` writes in `conversationId`; returns `agentId`'s delivered `agent.mention.v1` payload (its turn). */
  turnOf(who: TestClient, conversationId: string, agentId?: string): Promise<Json>;
  /** Organization A's sandbox policy row (the switch, the cap, the kill state), written directly. */
  setPolicy(p: { enabled?: boolean; maxSandboxes?: number; killed?: boolean }): Promise<void>;
  /** A bot's own sandbox switch (`capabilities.sandbox`), written directly (the PATCH route is 07.8-15's). */
  setBotSandbox(agentId: string, on: boolean): Promise<void>;
  /** A new team bot in organization A, its sandbox switch on, and Sam's DM with it. */
  newBot(name: string): Promise<{ id: string; dm: string }>;
  stop(): Promise<void>;
}

export async function ok(res: Promise<Res> | Res, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

export const codeOf = (r: Res): unknown => (r.body?.error as Json | undefined)?.code;

export async function startSandboxStack(
  opts: {
    env?: Record<string, string>;
    logLevel?: string;
    browserBudgetsMs?: BrowserBudgets;
    sandboxBudgetsMs?: SandboxBudgets;
  } = {},
): Promise<SandboxStack> {
  const sandboxd = await startFakeSandboxd();
  const logs: string[] = [];
  let stack: TestStack;
  try {
    stack = await startTestStack({
      env: {
        OCW_MODEL_PROVIDER: "mock",
        OCW_CELL_TOKEN: SANDBOX_CELL_TOKEN,
        OCW_SANDBOX_URL: sandboxd.url,
        OCW_SANDBOX_TOKEN: sandboxd.token,
        LOG_LEVEL: opts.logLevel ?? "info",
        ...opts.env,
      },
      logStream: { write: (line: string) => void logs.push(line) },
      ...(opts.browserBudgetsMs ? { browserBudgetsMs: opts.browserBudgetsMs } : {}),
      ...(opts.sandboxBudgetsMs ? { sandboxBudgetsMs: opts.sandboxBudgetsMs } : {}),
    });
  } catch (err) {
    await sandboxd.stop();
    throw err;
  }
  const su = new pg.Client({ connectionString: stack.db.superuserUrl });
  try {
    await su.connect();
    return await prepare(stack, sandboxd, su, logs);
  } catch (err) {
    await su.end().catch(() => {});
    try {
      await stack.stop();
    } finally {
      await sandboxd.stop();
    }
    throw err;
  }
}

async function prepare(
  stack: TestStack,
  sandboxd: FakeSandboxdServer,
  su: pg.Client,
  logs: string[],
): Promise<SandboxStack> {
  const victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }) as Promise<Res>,
  );
  const orgA = setup.organization.id as string;
  const victorId = setup.user.id as string;
  const joinAs = async (email: string, name: string) => {
    const inv = await ok(
      victor.request("POST", "/api/v1/invitations", { email, role: "standard" }) as Promise<Res>,
    );
    const c = new TestClient(stack.baseUrl);
    const acc = await ok(
      c.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
        name,
        password: "another-long-password",
      }) as Promise<Res>,
    );
    return [c, acc.user.id as string] as const;
  };
  const [sam, samId] = await joinAs("sam@example.test", "Sam Lee");
  const [alex, alexId] = await joinAs("alex@example.test", "Alex Kim");
  const [eve, eveId] = await joinAs("eve@example.test", "Eve Black");

  // Organization B: Eve moves into her own organization as its admin.
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
  expect((await ok(eve.request("GET", "/api/v1/me/permissions") as Promise<Res>)).role).toBe("admin");

  const setBotSandbox = async (agentId: string, on: boolean) => {
    await su.query(
      "update app.agents set capabilities = capabilities || jsonb_build_object('sandbox', $2::boolean) where id = $1",
      [agentId, on],
    );
  };
  const newBot = async (name: string) => {
    const username = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
    const id = (
      await ok(
        victor.request("POST", "/api/v1/agents", {
          name,
          username,
          instructions: `You are ${name}.`,
          modelProvider: "mock",
          modelId: "mock-1",
        }) as Promise<Res>,
      )
    ).id as string;
    await setBotSandbox(id, true);
    const dm = (
      await ok(sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id }] }) as Promise<Res>)
    ).id as string;
    return { id, dm };
  };
  const scout = await newBot("Scout");

  const cell = async (path: string, body: unknown, token = SANDBOX_CELL_TOKEN): Promise<Res> => {
    const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
  };

  const turnOf = async (who: TestClient, conversationId: string, agentId = scout.id): Promise<Json> => {
    const msg = await ok(
      who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
        body: `please run it ${randomUUID().slice(0, 6)}`,
      }) as Promise<Res>,
    );
    const rows = (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
        [`cell:${orgA}`, msg.id, agentId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    return rows[0].payload as Json;
  };

  const setPolicy = async (p: { enabled?: boolean; maxSandboxes?: number; killed?: boolean }) => {
    await su.query(
      `insert into app.sandbox_policies (organization_id) values ($1) on conflict (organization_id) do nothing`,
      [orgA],
    );
    if (p.enabled !== undefined) {
      await su.query("update app.sandbox_policies set enabled = $2 where organization_id = $1", [
        orgA,
        p.enabled,
      ]);
    }
    if (p.maxSandboxes !== undefined) {
      await su.query("update app.sandbox_policies set max_sandboxes = $2 where organization_id = $1", [
        orgA,
        p.maxSandboxes,
      ]);
    }
    if (p.killed !== undefined) {
      await su.query(
        "update app.sandbox_policies set killed_at = $2, killed_by = $3 where organization_id = $1",
        [orgA, p.killed ? new Date().toISOString() : null, p.killed ? victorId : null],
      );
    }
  };

  // sandboxd holds no default policy. In production the events consumer pushes every organization's policy on its first
  // poll; the app starts none under NODE_ENV=test, so the fixture does that push once here.
  for (const orgId of [orgA, orgB]) await pushPolicy(stack.built.core, stack.built.sandbox.client, orgId);

  return {
    stack,
    sandboxd,
    su,
    orgA,
    orgB,
    victor,
    sam,
    alex,
    eve,
    victorId,
    samId,
    alexId,
    eveId,
    scoutId: scout.id,
    samDm: scout.dm,
    logs,
    cell,
    turnOf,
    setPolicy,
    setBotSandbox,
    newBot,
    async stop() {
      await su.end().catch(() => {});
      // The fake server closes whatever the stack's stop does; the stack's failure is still reported.
      try {
        await stack.stop();
      } finally {
        await sandboxd.stop();
      }
    },
  };
}
