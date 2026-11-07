import { randomUUID } from "node:crypto";
import { ConnectorAuthFailure } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.4 (D-01, D-03, D-04, D-05): the rules a bug in the API must never break are enforced by PostgreSQL itself.
 * Runs as ocw_migrator (no RLS in the way) on a fresh database with every migration applied; tenant isolation of the
 * same tables is proven in rls-isolation.int.test.ts.
 */

let tdb: TestDatabase;
let db: pg.Client;
/** Phase 07.14: the app role (no RLS bypass), for the tenant cases. */
let app: pg.Client;

const CHECK = "23514";
const UNIQUE = "23505";
const FOREIGN_KEY = "23503";

interface Org {
  id: string;
  user: string;
  unit: string;
  conv: string;
  agent: string;
}

async function seedOrg(): Promise<Org> {
  const o: Org = {
    id: randomUUID(),
    user: randomUUID(),
    unit: randomUUID(),
    conv: randomUUID(),
    agent: randomUUID(),
  };
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [o.id, `o-${o.id}`]);
  await db.query("insert into auth.user (id, name, email) values ($1, 'U', $2)", [
    o.user,
    `${o.user}@example.test`,
  ]);
  await db.query(
    "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'team', 'Sales', ARRAY[$1]::uuid[])",
    [o.unit, o.id],
  );
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name, slug, created_by) values ($1, $2, 'channel', 'general', $3, $4)",
    [o.conv, o.id, `general-${o.conv}`, o.user],
  );
  await db.query(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id) values ($1, $2, 'Mine', $3, 'x', 'mock', 'mock-1', 'personal', $4)",
    [o.agent, o.id, `mine-${o.agent.slice(0, 8)}`, o.user],
  );
  return o;
}

/** An MCP server; `authMode` omitted = the column default (what every pre-07.4 server gets). */
async function server(org: string, transport: string, authMode?: string): Promise<string> {
  const id = randomUUID();
  const stdio = transport === "sandboxed-stdio";
  await db.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, sandbox_server${authMode ? ", auth_mode" : ""})
     values ($1, $2, 'S', $3, $4, $5, $6${authMode ? ", $7" : ""})`,
    [
      id,
      org,
      `m${id.replace(/-/g, "").slice(0, 8)}`,
      transport,
      stdio ? null : "https://mcp.example.test",
      stdio ? "filesystem" : null,
      ...(authMode ? [authMode] : []),
    ],
  );
  return id;
}

async function secret(org: string, kind: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 's', $3, 'c', 'i', 't')",
    [id, org, kind],
  );
  return id;
}

/** The SQLSTATE a statement fails with, or null when it succeeds. */
async function sqlState(text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await db.query(text, values);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A valid, random handle: `k_` + 10 base32 chars. */
function nextHandle(): string {
  let out = "k_";
  for (let i = 0; i < 10; i++) out += BASE32[Math.floor(Math.random() * BASE32.length)];
  return out;
}

function vaultInsert(
  org: Org,
  over: {
    scope?: string;
    owner?: string | null;
    unit?: string | null;
    handle?: string;
    hosts?: string[];
    ref?: unknown;
  },
) {
  const ref = over.ref ?? { provider: "db", secretId: randomUUID(), organizationId: org.id };
  return sqlState(
    `insert into app.vault_items (organization_id, scope, owner_user_id, unit_id, name, handle, kind, injection, allowed_hosts, secret_ref)
     values ($1, $2, $3, $4, 'Key', $5, 'api_key', '{"header":"Authorization","scheme":"bearer"}', $6, $7::jsonb)`,
    [
      org.id,
      over.scope ?? "personal",
      over.owner === undefined ? org.user : over.owner,
      over.unit === undefined ? null : over.unit,
      over.handle ?? nextHandle(),
      over.hosts ?? ["erp.example.test"],
      JSON.stringify(ref),
    ],
  );
}

let a: Org;
let b: Org;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = new pg.Client({ connectionString: tdb.migratorUrl });
  await db.connect();
  app = new pg.Client({ connectionString: tdb.appUrl });
  await app.connect();
  a = await seedOrg();
  b = await seedOrg();
});

afterAll(async () => {
  await app?.end();
  await db?.end();
  await tdb?.stop();
});

describe("Phase 07.4 schema constraints", () => {
  it("every server is org_secret unless set; a per-member mode needs an HTTP transport, never the stdio sandbox", async () => {
    const http = await server(a.id, "streamable-http");
    const stdio = await server(a.id, "sandboxed-stdio");
    const modes = await db.query(
      "select auth_mode from app.mcp_servers where id = any($1) order by auth_mode",
      [[http, stdio]],
    );
    expect(modes.rows).toEqual([{ auth_mode: "org_secret" }, { auth_mode: "org_secret" }]);

    for (const mode of ["per_member_oauth", "per_member_secret"]) {
      expect(
        await sqlState("update app.mcp_servers set auth_mode = $1 where id = $2", [mode, stdio]),
        mode,
      ).toBe(CHECK);
      await expect(server(a.id, "sandboxed-stdio", mode)).rejects.toMatchObject({ code: CHECK });
      await expect(server(a.id, "streamable-http", mode)).resolves.toBeTypeOf("string");
      await expect(server(a.id, "sse", mode)).resolves.toBeTypeOf("string");
    }
    expect(await sqlState("update app.mcp_servers set auth_mode = 'per_member' where id = $1", [http])).toBe(
      CHECK,
    );
    expect(await sqlState("update app.mcp_servers set oauth_status = 'unknown' where id = $1", [http])).toBe(
      CHECK,
    );
    expect(
      await sqlState("update app.mcp_servers set oauth_status = 'needs_client' where id = $1", [http]),
    ).toBe(null);
  });

  it("a probed tool's input schema is capped at 16 KB", async () => {
    const srv = await server(a.id, "streamable-http");
    const ins = (schema: unknown) =>
      sqlState(
        "insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, input_schema) values ($1, $2, $3, 'x', $4::jsonb)",
        [a.id, srv, randomUUID(), JSON.stringify(schema)],
      );
    expect(await ins({ type: "object", properties: { q: { type: "string" } } })).toBe(null);
    expect(await ins({ type: "object", description: "x".repeat(16_384) })).toBe(CHECK);
    expect(
      await sqlState(
        "insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name) values ($1, $2, 'legacy', 'x')",
        [a.id, srv],
      ),
    ).toBe(null);
  });

  it("a personal key has an owner and no unit; a unit key has no owner (unit null = the organization)", async () => {
    expect(await vaultInsert(a, { scope: "personal", owner: null })).toBe(CHECK);
    expect(await vaultInsert(a, { scope: "personal", unit: a.unit })).toBe(CHECK);
    expect(await vaultInsert(a, { scope: "unit", owner: a.user, unit: a.unit })).toBe(CHECK);
    expect(await vaultInsert(a, { scope: "unit", owner: a.user, unit: null })).toBe(CHECK);
    expect(await vaultInsert(a, { scope: "team", owner: null })).toBe(CHECK);
    expect(await vaultInsert(a, { scope: "personal" })).toBe(null);
    expect(await vaultInsert(a, { scope: "unit", owner: null, unit: a.unit })).toBe(null);
    expect(await vaultInsert(a, { scope: "unit", owner: null, unit: null })).toBe(null);
    // A unit with keys cannot be deleted out from under them.
    expect(await sqlState("delete from app.org_units where id = $1", [a.unit])).toBe("23001"); // restrict_violation
  });

  it("a key allows 1 to 16 hosts, has a well-formed handle unique per organization, and references its value", async () => {
    expect(await vaultInsert(a, { hosts: [] })).toBe(CHECK);
    expect(await vaultInsert(a, { hosts: Array.from({ length: 17 }, (_, i) => `h${i}.example.test`) })).toBe(
      CHECK,
    );
    expect(await vaultInsert(a, { hosts: Array.from({ length: 16 }, (_, i) => `h${i}.example.test`) })).toBe(
      null,
    );

    expect(await vaultInsert(a, { handle: "k_shared0001" })).toBe(CHECK); // 0 and 1 are not base32
    expect(await vaultInsert(a, { handle: "erp-key" })).toBe(CHECK);
    expect(await vaultInsert(a, { handle: "k_sharedhndl" })).toBe(null);
    expect(await vaultInsert(a, { handle: "k_sharedhndl" })).toBe(UNIQUE);
    expect(await vaultInsert(b, { handle: "k_sharedhndl" })).toBe(null);

    // A reference, never a value: a bare string (a pasted key) or an object without a provider is refused.
    expect(await vaultInsert(a, { ref: "sk-live-plaintext" })).toBe(CHECK);
    expect(await vaultInsert(a, { ref: { value: "sk-live-plaintext" } })).toBe(CHECK);
    expect(await vaultInsert(a, { ref: { provider: "env", key: "ERP_KEY" } })).toBe(null);

    const fresh = await db.query(
      "select value_updated_at is not null as set, value_updated_at = created_at as at_create from app.vault_items where handle = 'k_sharedhndl' and organization_id = $1",
      [a.id],
    );
    expect(fresh.rows).toEqual([{ set: true, at_create: true }]);
  });

  it("one connection per (organization, member, connector); label and error are optional and bounded", async () => {
    const srv = await server(a.id, "streamable-http", "per_member_oauth");
    const conn = (org: Org, user: string, extra = "", values: unknown[] = []) =>
      sqlState(
        `insert into app.connector_connections (organization_id, user_id, server_id, status${extra ? `, ${extra}` : ""}) values ($1, $2, $3, 'connected'${values.map((_, i) => `, $${i + 4}`).join("")})`,
        [org.id, user, srv, ...values],
      );
    expect(await conn(a, a.user)).toBe(null);
    expect(await conn(a, a.user)).toBe(UNIQUE);
    expect(await conn(a, randomUUID(), "account_label, last_error", [null, null])).toBe(null);
    expect(await conn(a, randomUUID(), "account_label", ["x".repeat(201)])).toBe(CHECK);
    expect(await conn(a, randomUUID(), "last_error", ["x".repeat(65)])).toBe(CHECK);
    expect(
      await sqlState(
        "update app.connector_connections set status = 'revoked' where user_id = $1 and server_id = $2",
        [a.user, srv],
      ),
    ).toBe(CHECK);
    const row = await db.query(
      "select account_label, scopes, connected_at is not null as connected from app.connector_connections where user_id = $1 and server_id = $2",
      [a.user, srv],
    );
    expect(row.rows).toEqual([{ account_label: null, scopes: [], connected: true }]);
  });

  it("one ACTIVE share per (member, conversation, resource); a revoke frees the slot", async () => {
    const resource = randomUUID();
    const share = (kind = "connector") =>
      sqlState(
        "insert into app.member_account_shares (organization_id, user_id, conversation_id, resource_kind, resource_id, readers_at_grant) values ($1, $2, $3, $4, $5, 4)",
        [a.id, a.user, a.conv, kind, resource],
      );
    expect(await share()).toBe(null);
    expect(await share()).toBe(UNIQUE);
    expect(await share("vault_item")).toBe(null); // another resource kind is another share
    expect(await share("channel")).toBe(CHECK);
    await db.query(
      "update app.member_account_shares set revoked_at = now() where user_id = $1 and resource_id = $2 and resource_kind = 'connector'",
      [a.user, resource],
    );
    expect(await share()).toBe(null);
    const rows = await db.query(
      "select count(*)::int as n, count(revoked_at)::int as revoked from app.member_account_shares where resource_id = $1 and resource_kind = 'connector'",
      [resource],
    );
    expect(rows.rows).toEqual([{ n: 2, revoked: 1 }]);
  });

  it("deleting a connector removes its connections and OAuth clients but leaves their sealed secrets to the API", async () => {
    const srv = await server(a.id, "streamable-http", "per_member_oauth");
    const connSecret = await secret(a.id, "connector_credential");
    const clientSecret = await secret(a.id, "mcp_credential");
    await db.query(
      "insert into app.connector_connections (organization_id, user_id, server_id, status, secret_id) values ($1, $2, $3, 'connected', $4)",
      [a.id, a.user, srv, connSecret],
    );
    await db.query(
      "insert into app.connector_oauth_clients (organization_id, server_id, issuer, client_id, client_secret_id, method) values ($1, $2, 'https://as.example.test', 'ocw', $3, 'pre_registered')",
      [a.id, srv, clientSecret],
    );
    expect(
      await sqlState(
        "insert into app.connector_oauth_clients (organization_id, server_id, issuer, client_id, method) values ($1, $2, 'https://as.example.test', 'other', 'dcr')",
        [a.id, srv],
      ),
    ).toBe(UNIQUE);
    expect(
      await sqlState(
        "insert into app.connector_oauth_clients (organization_id, server_id, issuer, client_id, method) values ($1, $2, 'https://as2.example.test', 'other', 'magic')",
        [a.id, srv],
      ),
    ).toBe(CHECK);

    await db.query("delete from app.mcp_servers where id = $1", [srv]);
    const left = await db.query(
      `select (select count(*)::int from app.connector_connections where server_id = $1) as connections,
              (select count(*)::int from app.connector_oauth_clients where server_id = $1) as clients,
              (select count(*)::int from app.secrets where id = any($2)) as secrets`,
      [srv, [connSecret, clientSecret]],
    );
    expect(left.rows).toEqual([{ connections: 0, clients: 0, secrets: 2 }]);

    // The other way round: deleting a secret only unlinks it.
    const srv2 = await server(a.id, "streamable-http", "per_member_secret");
    const s2 = await secret(a.id, "connector_credential");
    await db.query(
      "insert into app.connector_connections (organization_id, user_id, server_id, status, secret_id) values ($1, $2, $3, 'connected', $4)",
      [a.id, a.user, srv2, s2],
    );
    await db.query("delete from app.secrets where id = $1", [s2]);
    const unlinked = await db.query("select secret_id from app.connector_connections where server_id = $1", [
      srv2,
    ]);
    expect(unlinked.rows).toEqual([{ secret_id: null }]);
  });

  it("tool calls record keychain requests as source `vault`; private egress hosts are bounded", async () => {
    const call = (kind: string) =>
      sqlState(
        "insert into app.agent_tool_calls (organization_id, event_id, agent_id, user_id, tool, source_kind, decision) values ($1, $2, $3, $4, 'ocw_http_request', $5, 'allowed')",
        [a.id, randomUUID(), a.agent, a.user, kind],
      );
    expect(await call("vault")).toBe(null);
    for (const kind of ["builtin", "mcp", "plugin"]) expect(await call(kind), kind).toBe(null);
    expect(await call("secret")).toBe(CHECK);

    await db.query("insert into app.bot_policies (organization_id) values ($1)", [a.id]);
    const policy = await db.query(
      "select egress_private_hosts from app.bot_policies where organization_id = $1",
      [a.id],
    );
    expect(policy.rows).toEqual([{ egress_private_hosts: [] }]);
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `erp${i}.lan:8443`);
    const set = (n: number) =>
      sqlState("update app.bot_policies set egress_private_hosts = $1 where organization_id = $2", [
        hosts(n),
        a.id,
      ]);
    expect(await set(64)).toBe(null);
    expect(await set(65)).toBe(CHECK);
  });

  it("templates: versions are unique and >= 1, a started bot links its template, deleting a template unlinks it", async () => {
    const tpl = randomUUID();
    await db.query(
      "insert into app.agent_templates (id, organization_id, unit_id, name, current_version) values ($1, $2, $3, 'Sales', 1)",
      [tpl, a.id, a.unit],
    );
    const version = (v: number, extra = "", values: unknown[] = []) =>
      sqlState(
        `insert into app.agent_template_versions (organization_id, template_id, version, instructions, model_provider, model_id, capabilities${extra ? `, ${extra}` : ""}) values ($1, $2, $3, 'Help', 'mock', 'mock-1', '{}'${values.map((_, i) => `, $${i + 4}`).join("")})`,
        [a.id, tpl, v, ...values],
      );
    expect(await version(1)).toBe(null);
    expect(await version(1)).toBe(UNIQUE);
    expect(await version(0)).toBe(CHECK);
    expect(await version(2, "tool_grants", ['{"sourceKind":"mcp"}'])).toBe(CHECK); // an array, not an object
    expect(await version(2, "required_connector_ids", [Array.from({ length: 17 }, () => randomUUID())])).toBe(
      CHECK,
    );
    expect(await version(2, "tool_grants, unit_vault_item_ids", ["[]", [randomUUID()]])).toBe(null);
    expect(await sqlState("update app.agent_templates set current_version = 0 where id = $1", [tpl])).toBe(
      CHECK,
    );
    expect(await sqlState("update app.agent_templates set name = '' where id = $1", [tpl])).toBe(CHECK);

    await db.query("update app.agents set template_id = $1, template_version = 2 where id = $2", [
      tpl,
      a.agent,
    ]);
    expect(await sqlState("update app.agents set template_version = 0 where id = $1", [a.agent])).toBe(CHECK);
    const tplKey = randomUUID();
    await db.query(
      `insert into app.vault_items (id, organization_id, scope, unit_id, name, handle, kind, injection, allowed_hosts, secret_ref)
       values ($1, $2, 'unit', $3, 'Shared', $4, 'api_key', '{"header":"X-Api-Key","scheme":"raw"}', '{api.example.test}', $5::jsonb)`,
      [
        tplKey,
        a.id,
        a.unit,
        nextHandle(),
        JSON.stringify({ provider: "db", secretId: randomUUID(), organizationId: a.id }),
      ],
    );
    await db.query(
      "insert into app.agent_vault_grants (organization_id, agent_id, vault_item_id) values ($1, $2, $3)",
      [a.id, a.agent, tplKey],
    );
    expect(
      await sqlState(
        "insert into app.agent_vault_grants (organization_id, agent_id, vault_item_id) values ($1, $2, $3)",
        [a.id, a.agent, tplKey],
      ),
    ).toBe(UNIQUE);

    await db.query("delete from app.agent_templates where id = $1", [tpl]);
    const bot = await db.query("select template_id, template_version from app.agents where id = $1", [
      a.agent,
    ]);
    expect(bot.rows).toEqual([{ template_id: null, template_version: 2 }]);
    const versions = await db.query(
      "select count(*)::int as n from app.agent_template_versions where template_id = $1",
      [tpl],
    );
    expect(versions.rows[0].n).toBe(0);

    // Deleting a key removes its grants; the bot stays.
    await db.query("delete from app.vault_items where id = $1", [tplKey]);
    const grants = await db.query(
      "select count(*)::int as n from app.agent_vault_grants where vault_item_id = $1",
      [tplKey],
    );
    expect(grants.rows[0].n).toBe(0);
  });
});

/** Runs `fn` as ocw_app inside `org`'s tenant transaction (the `withTenant()` set_config), then rolls back. */
async function inTenant<T>(org: string, fn: () => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query("select set_config('app.organization_id', $1, true)", [org]);
    return await fn();
  } finally {
    await app.query("rollback");
  }
}

/** One organization connection row (07.14 D-06); `extra` names more columns, `values` their values. */
function orgConn(org: string, serverId: string, extra = "", values: unknown[] = []) {
  return sqlState(
    `insert into app.connector_org_connections (organization_id, server_id, method, status${extra ? `, ${extra}` : ""}) values ($1, $2, 'oauth', 'connected'${values.map((_, i) => `, $${i + 3}`).join("")})`,
    [org, serverId, ...values],
  );
}

describe("Phase 07.14 organization connections", () => {
  it("the two organization modes are storable on a remote transport, never on the stdio sandbox; an unknown mode is refused", async () => {
    for (const mode of ["org_oauth", "org_client_credentials"]) {
      await expect(server(a.id, "streamable-http", mode), mode).resolves.toBeTypeOf("string");
      await expect(server(a.id, "sse", mode), mode).resolves.toBeTypeOf("string");
      await expect(server(a.id, "sandboxed-stdio", mode), mode).rejects.toMatchObject({ code: CHECK });
      const stdio = await server(a.id, "sandboxed-stdio");
      expect(
        await sqlState("update app.mcp_servers set auth_mode = $1 where id = $2", [mode, stdio]),
        mode,
      ).toBe(CHECK);
    }
    await expect(server(a.id, "streamable-http", "nope")).rejects.toMatchObject({ code: CHECK });
  });

  it("auth_failure is null by default and holds only one of the eight closed codes, never provider text", async () => {
    const srv = await server(a.id, "streamable-http", "org_oauth");
    const fresh = await db.query("select auth_failure from app.mcp_servers where id = $1", [srv]);
    expect(fresh.rows).toEqual([{ auth_failure: null }]);
    expect(ConnectorAuthFailure.options).toHaveLength(8);
    for (const code of ConnectorAuthFailure.options) {
      expect(
        await sqlState("update app.mcp_servers set auth_failure = $1 where id = $2", [code, srv]),
        code,
      ).toBe(null);
    }
    expect(
      await sqlState("update app.mcp_servers set auth_failure = 'provider said no' where id = $1", [srv]),
    ).toBe(CHECK);
    expect(await sqlState("update app.mcp_servers set auth_failure = null where id = $1", [srv])).toBe(null);
  });

  it("one organization connection per (organization, server); status, method and the text columns are closed or bounded", async () => {
    const srv = await server(a.id, "streamable-http", "org_oauth");
    expect(await orgConn(a.id, srv)).toBe(null);
    expect(await orgConn(a.id, srv)).toBe(UNIQUE);

    const other = await server(a.id, "streamable-http", "org_client_credentials");
    const bad: Array<[string, unknown]> = [
      ["account_label", "x".repeat(201)],
      ["last_error", "x".repeat(65)],
      ["client_id", "x".repeat(257)],
      ["token_endpoint", `https://as.example.test/${"x".repeat(2000)}`],
    ];
    for (const [col, value] of bad) expect(await orgConn(a.id, other, col, [value]), col).toBe(CHECK);
    expect(
      await sqlState(
        "insert into app.connector_org_connections (organization_id, server_id, method, status) values ($1, $2, 'oauth', 'revoked')",
        [a.id, other],
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(
        "insert into app.connector_org_connections (organization_id, server_id, method, status) values ($1, $2, 'password', 'connected')",
        [a.id, other],
      ),
    ).toBe(CHECK);
    expect(
      await orgConn(a.id, other, "account_label, last_error, client_id, token_endpoint", [
        "x".repeat(200),
        "x".repeat(64),
        "x".repeat(256),
        "https://as.example.test/token",
      ]),
    ).toBe(null);
    expect(
      await sqlState(
        "update app.connector_org_connections set method = 'client_credentials', status = 'needs_reconnect' where server_id = $1",
        [other],
      ),
    ).toBe(null);
    const row = await db.query(
      "select scopes, secret_id, connected_by, connected_at is not null as connected from app.connector_org_connections where server_id = $1",
      [srv],
    );
    expect(row.rows).toEqual([{ scopes: [], secret_id: null, connected_by: null, connected: true }]);
  });

  it("deleting the server deletes its organization connection; deleting the sealed secret only unlinks it", async () => {
    const srv = await server(a.id, "streamable-http", "org_oauth");
    const sealed = await secret(a.id, "connector_credential");
    expect(await orgConn(a.id, srv, "secret_id", [sealed])).toBe(null);
    await db.query("delete from app.secrets where id = $1", [sealed]);
    const unlinked = await db.query(
      "select secret_id from app.connector_org_connections where server_id = $1",
      [srv],
    );
    expect(unlinked.rows).toEqual([{ secret_id: null }]);

    await db.query("delete from app.mcp_servers where id = $1", [srv]);
    const left = await db.query(
      "select count(*)::int as n from app.connector_org_connections where server_id = $1",
      [srv],
    );
    expect(left.rows).toEqual([{ n: 0 }]);
  });

  it("as the app role in organization B, organization A's connection is invisible, unchangeable, and B cannot point at A's server", async () => {
    // The organization's table: RLS forced, the tenant policy alone (no owner-only policy, PD-05).
    const rls = await db.query(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as force,
              array(select polname::text from pg_policy where polrelid = c.oid order by 1) as policies
         from pg_class c where c.oid = 'app.connector_org_connections'::regclass`,
    );
    expect(rls.rows).toEqual([{ rls: true, force: true, policies: ["tenant_isolation"] }]);

    const srv = await server(a.id, "streamable-http", "org_oauth");
    expect(await orgConn(a.id, srv, "account_label", ["ops@a.example.test"])).toBe(null);

    await inTenant(b.id, async () => {
      expect(
        (await app.query("select * from app.connector_org_connections where server_id = $1", [srv])).rowCount,
      ).toBe(0);
      expect(
        (
          await app.query(
            "update app.connector_org_connections set status = 'needs_reconnect', last_error = 'revoked' where server_id = $1",
            [srv],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await app.query("delete from app.connector_org_connections where server_id = $1", [srv])).rowCount,
      ).toBe(0);
    });

    // A row of organization B naming A's server passes B's tenant policy but fails the composite foreign key.
    const forged = await inTenant(b.id, () =>
      app
        .query(
          "insert into app.connector_org_connections (organization_id, server_id, method, status) values ($1, $2, 'oauth', 'connected')",
          [b.id, srv],
        )
        .then(
          () => null,
          (err: { code?: string }) => err.code ?? "unknown",
        ),
    );
    expect(forged).toBe(FOREIGN_KEY);

    // A's own tenant sees its row; the migrator confirms it is unchanged.
    const own = await inTenant(a.id, () =>
      app.query("select count(*)::int as n from app.connector_org_connections where server_id = $1", [srv]),
    );
    expect(own.rows).toEqual([{ n: 1 }]);
    const after = await db.query(
      "select status, last_error, account_label from app.connector_org_connections where server_id = $1",
      [srv],
    );
    expect(after.rows).toEqual([
      { status: "connected", last_error: null, account_label: "ops@a.example.test" },
    ]);
  });
});
