import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { expect, vi } from "vitest";
import {
  createFakeMcpOAuth,
  type FakeMcpOAuth,
  type FakeMcpOAuthOptions,
  type FakeMcpOAuthScenario,
  type FakeMcpOAuthStats,
} from "../../../infra/fake-model/fake-mcp-oauth.mjs";
import { createEgress, type Egress } from "./lib/egress";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";

/**
 * Shared fixture of the per-member connector integration tests (07.4-10): the full API on real PostgreSQL + Redis, the
 * fake OAuth-protected MCP server (07.4-04) in-process on loopback, reached by the API through the egress guard as the
 * test host `fake-mcp`, and two organizations (A: Víctor admin, Sam and Alex standard; B: Eve admin).
 *
 * `globalThis.fetch` is wrapped for the whole file: a call to the `fake-mcp` host through it means an MCP SDK helper or
 * transport ran without the guard's bound fetch (WINDOWS #175). `assertNoGlobalFetch()` fails the test then. The test's
 * own traffic goes to the API on 127.0.0.1 (passed through) or to the fake through its own guarded `browser` egress.
 */

/** The instance URL the stack advertises: loopback http, so member sign-in is offered (D-07 item 4). */
export const PUBLIC_API_URL = "http://localhost:4999";
export const CALLBACK_URL = `${PUBLIC_API_URL}/api/v1/connectors/oauth/callback`;
export const PRE_REGISTERED = "ocw-test";
export const PRE_REGISTERED_CONFIDENTIAL = "ocw-test-confidential";
export const CONFIDENTIAL_SECRET = "CONFIDENTIAL-CLIENT-SECRET-CANARY";
/** The fake's pre-registered client-credentials client (07.14 `org_client_credentials`); no redirect URIs. */
export const PRE_REGISTERED_CC = "ocw-test-cc";
export const CC_SECRET = "CC-CLIENT-SECRET-CANARY";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
export type Json = Record<string, any>;
export type Res = { status: number; body: Json | null };

export interface ConnectorsStack {
  stack: TestStack;
  su: pg.Client;
  appRole: pg.Client;
  fake: FakeMcpOAuth;
  fakePort: number;
  /** `http://fake-mcp:<port>`: the fake as the API (and its issuer URLs) name it. */
  fakeBase: string;
  /** The test's own guarded client for the fake (the "browser"). */
  browser: Egress;
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
  /** Resets every connection to the fake while true (an authorization server that is down). */
  setDown(value: boolean): void;
  /** Global fetch calls that named the fake: must stay empty (#175). */
  globalFakeCalls: string[];
  logs: string[];
  stop(): Promise<void>;
}

export async function ok(res: Promise<Res> | Res, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

export async function fails(res: Promise<Res> | Res, status: number, code?: string): Promise<Json> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect((r.body?.error as Json | undefined)?.code, JSON.stringify(r.body)).toBe(code);
  return r.body as Json;
}

export async function startConnectorsStack(
  opts: {
    /** Extra env vars for the API (e.g. `OCW_CELL_TOKEN` for the Agent Channel proxy tests). */
    env?: Record<string, string>;
    /** Log level of the captured API output (default `info`; the leak sweep reads `debug`). */
    logLevel?: string;
    /** Extra fake options (the leak sweep's canary keychain credentials); the pre-registered clients stay. */
    fake?: Omit<FakeMcpOAuthOptions, "preRegistered">;
  } = {},
): Promise<ConnectorsStack> {
  const fake = createFakeMcpOAuth({
    ...opts.fake,
    preRegistered: [
      { client_id: PRE_REGISTERED, redirect_uris: [CALLBACK_URL] },
      {
        client_id: PRE_REGISTERED_CONFIDENTIAL,
        client_secret: CONFIDENTIAL_SECRET,
        redirect_uris: [CALLBACK_URL],
      },
      { client_id: PRE_REGISTERED_CC, client_secret: CC_SECRET, redirect_uris: [] },
    ],
  });
  let down = false;
  const server: Server = createServer((req, res) => {
    // "The provider is down": every connection is reset before an answer.
    if (down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake-mcp");
    if (!fake.handle(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fakePort = (server.address() as AddressInfo).port;

  const realFetch = globalThis.fetch;
  const globalFakeCalls: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    if (/^https?:\/\/fake-mcp[:/]/u.test(href)) {
      globalFakeCalls.push(href.split("?", 1)[0] ?? href);
      throw new Error("global fetch called: an outbound call skipped the egress guard");
    }
    return realFetch(input, init);
  });

  const logs: string[] = [];
  // Whatever fails from here on, nothing outlives the start (WINDOWS #225): the stubbed fetch, the fake server, and the
  // stack's containers once it is up.
  const closeFake = async () => {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  let stack: TestStack;
  try {
    stack = await startTestStack({
      env: {
        OCW_MODEL_PROVIDER: "mock",
        OCW_PUBLIC_API_URL: PUBLIC_API_URL,
        OCW_EGRESS_TEST_HOSTS: "fake-mcp=127.0.0.1",
        LOG_LEVEL: opts.logLevel ?? "info",
        ...opts.env,
      },
      logStream: { write: (line: string) => void logs.push(line) },
    });
  } catch (err) {
    await closeFake();
    throw err;
  }
  const clients: pg.Client[] = [];
  try {
    return await prepare(stack);
  } catch (err) {
    await Promise.allSettled(clients.map((c) => c.end()));
    await stack.stop().catch(() => {});
    await closeFake();
    throw err;
  }

  async function prepare(stack: TestStack): Promise<ConnectorsStack> {
    const su = new pg.Client({ connectionString: stack.db.superuserUrl });
    clients.push(su);
    await su.connect();
    const appRole = new pg.Client({ connectionString: stack.db.appUrl });
    clients.push(appRole);
    await appRole.connect();

    const victor = new TestClient(stack.baseUrl);
    const setup = await ok(
      victor.request("POST", "/api/v1/setup", {
        token: TEST_SETUP_TOKEN,
        name: "Víctor Ruiz",
        email: "victor@example.test",
        password: "correct-horse-battery",
        orgName: "Autofy Labs",
      }),
    );
    const orgA = setup.organization.id as string;
    const victorId = setup.user.id as string;
    const joinAs = async (email: string, name: string) => {
      const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role: "standard" }));
      const c = new TestClient(stack.baseUrl);
      const acc = await ok(
        c.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
          name,
          password: "another-long-password",
        }),
      );
      return [c, acc.user.id as string] as const;
    };
    const [sam, samId] = await joinAs("sam@example.test", "Sam Lee");
    const [alex, alexId] = await joinAs("alex@example.test", "Alex Kim");
    const [eve, eveId] = await joinAs("eve@example.test", "Eve Black");

    // Org B: Eve moves into her own organization as its admin.
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

    return {
      stack,
      su,
      appRole,
      fake,
      fakePort,
      fakeBase: `http://fake-mcp:${fakePort}`,
      browser: createEgress({ platformHosts: [], testHosts: new Map([["fake-mcp", "127.0.0.1"]]) }),
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
      globalFakeCalls,
      logs,
      setDown(value: boolean) {
        down = value;
      },
      async stop() {
        await appRole.end().catch(() => {});
        await su.end().catch(() => {});
        // The fake server closes whatever the stack's stop does (WINDOWS #225); its failure is still reported.
        try {
          await stack.stop();
        } finally {
          await closeFake();
        }
      },
    };
  }
}

/** Invites a standard member into org A (Víctor's organization). */
export async function join(
  s: ConnectorsStack,
  email: string,
  name: string,
): Promise<readonly [TestClient, string]> {
  const inv = await ok(s.victor.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const c = new TestClient(s.stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

/** The fake's counters (hashes and counts only). */
export async function fakeStats(s: ConnectorsStack): Promise<FakeMcpOAuthStats> {
  const res = await s.browser.fetch(`${s.fakeBase}/mcp-oauth/__stats`);
  return (await res.json()) as FakeMcpOAuthStats;
}

export function scenario(s: ConnectorsStack, sc: FakeMcpOAuthScenario): void {
  s.fake.setScenario(sc);
}

/** The admin registers a per-member connector on the fake (pre-registered client `ocw-test` unless told otherwise). */
export async function registerConnector(
  s: ConnectorsStack,
  extra: Json = {},
  as: TestClient = s.victor,
): Promise<Json> {
  return ok(
    as.request("POST", "/api/v1/mcp-servers", {
      name: `CRM ${randomUUID().slice(0, 6)}`,
      transport: "streamable-http",
      url: `${s.fakeBase}/mcp-oauth/mcp`,
      authMode: "per_member_oauth",
      oauthClient: { issuer: `${s.fakeBase}/mcp-oauth`, clientId: PRE_REGISTERED },
      ...extra,
    }),
  );
}

/**
 * The admin registers an organization sign-in server (`org_oauth`, 07.14) on the fake, with the pre-registered public
 * client `ocw-test` unless told otherwise.
 */
export async function registerOrgConnector(
  s: ConnectorsStack,
  extra: Json = {},
  as: TestClient = s.victor,
): Promise<Json> {
  return registerConnector(
    s,
    { name: `Drive ${randomUUID().slice(0, 6)}`, authMode: "org_oauth", ...extra },
    as,
  );
}

/**
 * The admin registers an organization client-credentials server (`org_client_credentials`, 07.14 D-03) on the fake's
 * MCP URL, scopes empty unless told otherwise.
 */
export async function registerCcConnector(
  s: ConnectorsStack,
  extra: Json = {},
  as: TestClient = s.victor,
): Promise<Json> {
  return ok(
    as.request("POST", "/api/v1/mcp-servers", {
      name: `Ledger ${randomUUID().slice(0, 6)}`,
      transport: "streamable-http",
      url: `${s.fakeBase}/mcp-oauth/mcp`,
      authMode: "org_client_credentials",
      ...extra,
    }),
  );
}

/**
 * `PUT /connectors/:id/org-connection/client-credentials` as `as`, with the fake's pre-registered client-credentials
 * client unless another body is given. Returns the raw response (`ok()` / `fails()` read it).
 */
export async function saveCc(
  _s: ConnectorsStack,
  as: TestClient,
  serverId: string,
  body: Json = { clientId: PRE_REGISTERED_CC, clientSecret: CC_SECRET },
): Promise<Res> {
  return as.request("PUT", `/api/v1/connectors/${serverId}/org-connection/client-credentials`, body);
}

/** POST org-connection/connect → authorize → callback with the same admin's session; returns the final redirect. */
export async function connectOrgOAuth(
  s: ConnectorsStack,
  as: TestClient,
  serverId: string,
): Promise<{ status: number; location: string }> {
  const start = await ok(as.request("POST", `/api/v1/connectors/${serverId}/org-connection/connect`));
  return callback(s, await authorize(s, start.authorizeUrl), as);
}

/** The organization's connection row of a server (superuser read). */
export const orgConnectionRow = async (s: ConnectorsStack, orgId: string, serverId: string) =>
  (
    await s.su.query(
      "select * from app.connector_org_connections where organization_id = $1 and server_id = $2",
      [orgId, serverId],
    )
  ).rows[0] as Json | undefined;

/** The organization's sealed bundle of a server, opened with the organization AAD (test-only: never printed). */
export async function orgBundleOf(s: ConnectorsStack, orgId: string, serverId: string): Promise<Json | null> {
  const row = await orgConnectionRow(s, orgId, serverId);
  if (!row?.secret_id) return null;
  const { core } = s.stack.built;
  return core.db.withTenant({ organizationId: orgId }, async (tx) =>
    JSON.parse(await core.secrets.revealSealed(tx, row.secret_id, `${orgId}:org:connector:${serverId}`)),
  );
}

/** Plays the browser at the authorization server: follows the authorize URL once, returns the redirect. */
export async function authorize(s: ConnectorsStack, authorizeUrl: string): Promise<string> {
  const res = await s.browser.fetch(authorizeUrl, {}, { privateAllow: [`fake-mcp:${s.fakePort}`] });
  await res.body?.cancel();
  expect(res.status, `authorize answered ${res.status}`).toBe(302);
  return res.headers.get("location") ?? "";
}

/** Plays the browser at the API's callback with `as`'s session cookie (or none), never following the redirect. */
export async function callback(
  s: ConnectorsStack,
  location: string,
  as: TestClient | null,
): Promise<{ status: number; location: string }> {
  const target = new URL(location);
  const res = await fetch(`${s.stack.baseUrl}${target.pathname}${target.search}`, {
    redirect: "manual",
    headers: as?.cookies.size ? { cookie: as.cookieHeader } : {},
  });
  await res.body?.cancel();
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

/** POST connect → authorize → callback with the same member's session; returns the final redirect. */
export async function connectOAuth(
  s: ConnectorsStack,
  as: TestClient,
  serverId: string,
): Promise<{ status: number; location: string }> {
  const start = await ok(as.request("POST", `/api/v1/connectors/${serverId}/connect`));
  return callback(s, await authorize(s, start.authorizeUrl), as);
}

/** The member's sealed connection bundle, opened the way the API does (test-only: never printed). */
export async function bundleOf(
  s: ConnectorsStack,
  orgId: string,
  userId: string,
  serverId: string,
): Promise<Json | null> {
  const row = (
    await s.su.query(
      "select secret_id from app.connector_connections where organization_id = $1 and user_id = $2 and server_id = $3",
      [orgId, userId, serverId],
    )
  ).rows[0] as Json | undefined;
  if (!row?.secret_id) return null;
  const { core } = s.stack.built;
  return core.db.withTenant({ organizationId: orgId }, async (tx) =>
    JSON.parse(
      await core.secrets.revealSealed(tx, row.secret_id, `${orgId}:${userId}:connector:${serverId}`),
    ),
  );
}

export const connectionRow = async (s: ConnectorsStack, userId: string, serverId: string) =>
  (
    await s.su.query("select * from app.connector_connections where user_id = $1 and server_id = $2", [
      userId,
      serverId,
    ])
  ).rows[0] as Json | undefined;

export const auditRows = async (s: ConnectorsStack, orgId: string, actions: string[]) =>
  (
    await s.su.query(
      "select action, resource_id, user_id, metadata from app.audit_events where organization_id = $1 and action = any($2) order by occurred_at",
      [orgId, actions],
    )
  ).rows as Json[];

/** Fails when an MCP SDK call fell back to the global fetch (#175). */
export function assertNoGlobalFetch(s: ConnectorsStack): void {
  expect(s.globalFakeCalls).toEqual([]);
}
