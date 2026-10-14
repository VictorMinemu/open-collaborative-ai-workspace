import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { invite } from "../../testing-workzone";
import { claimToolCall } from "../agent-channel/claim";
import { createPermissionService } from "../organization";
import { currentTurnTools, memberAccountAllowed } from "./index";

/**
 * 07.4-11 Task 2 (D-03, D-07, C-01; CONN-03, SC2): tools that act with a member's own account (per-member connectors,
 * personal keys) follow the audience rule on every delivery. They are offered in that member's DM with the bot (exactly
 * one human), in an AI chat nobody else reads, or where the member shared that resource with that conversation;
 * elsewhere they are withheld as `member_account`, one entry per connector or key with its resource (UI-SPEC R7), and
 * the rule is re-decided at call time so revoking a share bites mid-turn. The cell-wide view (`/cell` alsoAllow) carries
 * the three static tool names only, never a per-member logical name. Real PostgreSQL + Redis, the in-process fake model.
 */

const CELL_TOKEN = "ocw-test-cell-token-connectors-turn-0123456789";
const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const CRM = "m0a1b2c3d";
const DOCS = "m4e5f6a7b";
const WHOAMI = `${CRM}__whoami`;
const CREATE = `${CRM}__create_record`;
const ECHO = `${DOCS}__echo`;
const STATIC = ["ocw_connector_list", "ocw_connector_call", "ocw_http_request"];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let orgId = "";
let victorId = "";
let samId = "";
let scoutId = "";
let victorBot = "";
let crmId = "";
let docsId = "";
let personalKey: Json;
let dmId = "";
let groupDmId = "";
let channelId = "";

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function cellCall(method: "GET" | "POST", path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${CELL_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const cid = () => `cm-${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The single `agent.mention.v1` the API appended for one message. */
async function deliveryOf(messageId: string): Promise<Json> {
  const rows = (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2",
      [`cell:${orgId}`, messageId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

/** `who` mentions Scout in a chat conversation; returns the delivered event. */
async function turnIn(who: TestClient, conversationId: string, text = "@scout who am I on the CRM?") {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: text,
      mentions: [{ kind: "agent", id: scoutId }],
    }),
  );
  return deliveryOf(msg.id as string);
}

async function settled(generationId: string): Promise<void> {
  const until = Date.now() + 20_000;
  for (;;) {
    const g = (await su.query("select status from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await sleep(50);
  }
}

/** `who` mentions Scout in an AI chat; returns the delivered event. */
async function turnInAiChat(who: TestClient, chatId: string): Promise<Json> {
  const r = await who.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body: "@scout who am I on the CRM?",
    model: PLAN_MODEL,
  });
  expect([201, 202], JSON.stringify(r.body)).toContain(r.status);
  return deliveryOf(((r.body as Json).userMessage as Json).id as string);
}

const share = async (
  userId: string,
  conversationId: string,
  kind: "connector" | "vault_item",
  id: string,
) => {
  const shareId = randomUUID();
  await su.query(
    `insert into app.member_account_shares (id, organization_id, user_id, conversation_id, resource_kind, resource_id, readers_at_grant)
     values ($1, $2, $3, $4, $5, $6, 2)`,
    [shareId, orgId, userId, conversationId, kind, id],
  );
  return async () => {
    await su.query("update app.member_account_shares set revoked_at = now() where id = $1", [shareId]);
  };
};

const crmWithheld = () => ({
  tool: expect.stringMatching(new RegExp(`^${CRM}__`)),
  reason: "member_account",
  resource: { kind: "connector", id: crmId, name: "Acme CRM" },
});
const keyWithheld = () => ({
  tool: "ocw_http_request",
  reason: "member_account",
  resource: { kind: "vault_item", id: personalKey.id, name: "Víctor CRM key" },
});

beforeAll(async () => {
  stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
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
  orgId = setup.organization.id;
  victorId = setup.user.id;
  ({ client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Rivera",
    "standard",
  ));
  await seedPlan(victor);

  scoutId = (
    await ok(
      victor.request("POST", "/api/v1/agents", {
        name: "Scout",
        username: "scout",
        instructions: "You are Scout.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;
  victorBot = (await ok(victor.request("POST", "/api/v1/agents/personal", {}))).agent.id;

  // A per-member sign-in connector (Víctor's own CRM account) and an organization-credential one, both probed.
  crmId = randomUUID();
  docsId = randomUUID();
  for (const [id, name, safe, mode] of [
    [crmId, "Acme CRM", CRM, "per_member_oauth"],
    [docsId, "Docs", DOCS, "org_secret"],
  ] as const) {
    await su.query(
      `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
       values ($1, $2, $3, $4, 'streamable-http', $5, 'ready', $6)`,
      [id, orgId, name, safe, `https://${safe}.example.test/mcp`, mode],
    );
  }
  for (const [server, name, safe, readOnly] of [
    [crmId, "whoami", CRM, true],
    [crmId, "create_record", CRM, false],
    [docsId, "echo", DOCS, true],
  ] as const) {
    await su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, $3, $4, $5)`,
      [orgId, server, name, `${safe}__${name}`, readOnly],
    );
  }
  await ok(
    victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
      tools: [
        { sourceKind: "mcp", sourceId: crmId, tool: WHOAMI },
        { sourceKind: "mcp", sourceId: crmId, tool: CREATE },
        { sourceKind: "mcp", sourceId: docsId, tool: ECHO },
      ],
    }),
  );

  personalKey = await ok(
    victor.request("POST", "/api/v1/keychain", {
      scope: "personal",
      kind: "api_key",
      name: "Víctor CRM key",
      value: "VICTOR-KEY-CANARY",
      allowedHosts: ["api.crm.example"],
    }),
    201,
  );
  await ok(
    victor.request("PUT", `/api/v1/keychain/${personalKey.id}/agents`, { agentIds: [scoutId, victorBot] }),
  );

  dmId = (await ok(victor.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] })))
    .id;
  groupDmId = (
    await ok(
      victor.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: samId },
          { kind: "agent", id: scoutId },
        ],
      }),
    )
  ).id;
  channelId = (await ok(victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" })))
    .id;
  await ok(victor.request("POST", `/api/v1/channels/${channelId}/members`, { kind: "user", id: samId }));
  await ok(victor.request("POST", `/api/v1/channels/${channelId}/members`, { kind: "agent", id: scoutId }));
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("memberAccountAllowed: DM, unshared AI chat or an active share", () => {
  it("decides the three cases and refuses everything else", () => {
    expect(memberAccountAllowed({ scopeKind: "dm", aiChatShared: null, hasShare: false })).toBe(true);
    expect(memberAccountAllowed({ scopeKind: "ai_chat", aiChatShared: false, hasShare: false })).toBe(true);
    expect(memberAccountAllowed({ scopeKind: "ai_chat", aiChatShared: true, hasShare: false })).toBe(false);
    expect(memberAccountAllowed({ scopeKind: "ai_chat", aiChatShared: null, hasShare: false })).toBe(false);
    expect(memberAccountAllowed({ scopeKind: "dm_shared", aiChatShared: null, hasShare: false })).toBe(false);
    expect(memberAccountAllowed({ scopeKind: "channel", aiChatShared: null, hasShare: false })).toBe(false);
    expect(memberAccountAllowed({ scopeKind: "channel", aiChatShared: null, hasShare: true })).toBe(true);
    expect(memberAccountAllowed({ scopeKind: "dm_shared", aiChatShared: null, hasShare: true })).toBe(true);
  });
});

describe("member-account tools follow the audience rule on every delivery", () => {
  it("Víctor's DM with Scout: logical connector tools, list and call, his key and the org connector", async () => {
    const ev = await turnIn(victor, dmId);
    expect(ev.turn.tools).toEqual(
      expect.arrayContaining([
        WHOAMI,
        CREATE,
        ECHO,
        "ocw_connector_list",
        "ocw_connector_call",
        "ocw_http_request",
      ]),
    );
    // ocw_connector_call carries the strictest flags of the turn's per-member tools (create_record changes things).
    expect(ev.turn.toolFlags.ocw_connector_call).toEqual({ untrustedOutput: true, sideEffecting: true });
    expect(ev.turn.toolFlags[WHOAMI]).toEqual({ untrustedOutput: true, sideEffecting: false });
    expect(ev.turn.withheld).toBeUndefined();
  });

  it("a channel with Víctor and Sam: withheld member_account, one entry per connector and key; the org tool stays", async () => {
    const ev = await turnIn(victor, channelId);
    expect(ev.turn.tools).toContain(ECHO);
    for (const t of [WHOAMI, CREATE, ...STATIC]) expect(ev.turn.tools).not.toContain(t);
    expect(ev.turn.withheld).toEqual([crmWithheld(), keyWithheld()]);
    // Never a value anywhere in the delivery.
    expect(JSON.stringify(ev)).not.toContain("VICTOR-KEY-CANARY");
  });

  it("a group DM (two humans) is not a private chat: withheld", async () => {
    const ev = await turnIn(victor, groupDmId);
    expect(ev.turn.tools).not.toContain(WHOAMI);
    expect(ev.turn.tools).not.toContain("ocw_http_request");
    expect(ev.turn.withheld).toEqual([crmWithheld(), keyWithheld()]);
  });

  it("Sam asking in the channel: no member-account entry of Víctor's (his key is never Sam's), Sam's own connector withheld", async () => {
    const ev = await turnIn(sam, channelId, "@scout what's new?");
    expect(ev.turn.tools).not.toContain("ocw_http_request");
    expect(ev.turn.withheld).toEqual([crmWithheld()]);
  });

  it("Víctor's AI chat nobody else reads, with Scout: offered; once shared with Sam: withheld", async () => {
    const created = await ok(
      victor.request("POST", "/api/v1/ai-chats", {
        clientMessageId: cid(),
        body: "Check my CRM",
        model: PLAN_MODEL,
      }),
      201,
    );
    const chatId = (created.chat as Json).id as string;
    await settled((created.generation as Json).id as string);
    await ok(victor.request("POST", `/api/v1/ai-chats/${chatId}/agents`, { agentId: scoutId }), 201);

    const alone = await turnInAiChat(victor, chatId);
    expect(alone.turn.tools).toEqual(
      expect.arrayContaining([WHOAMI, "ocw_connector_call", "ocw_http_request"]),
    );
    expect(alone.turn.withheld).toEqual([]);

    await ok(
      victor.request("POST", `/api/v1/ai-chats/${chatId}/grants`, {
        subject: { kind: "user", id: samId },
        level: "chat",
      }),
      201,
    );
    const shared = await turnInAiChat(victor, chatId);
    for (const t of [WHOAMI, CREATE, ...STATIC]) expect(shared.turn.tools).not.toContain(t);
    expect(shared.turn.withheld).toEqual(expect.arrayContaining([crmWithheld(), keyWithheld()]));
  });

  it("an active share for the connector in the channel offers it; revoking it bites at call time", async () => {
    const revoke = await share(victorId, channelId, "connector", crmId);
    const ev = await turnIn(victor, channelId);
    expect(ev.turn.tools).toEqual(expect.arrayContaining([WHOAMI, CREATE, "ocw_connector_call"]));
    expect(ev.turn.withheld).toEqual([keyWithheld()]);

    const now = () =>
      stack.built.core.db.withTenant({ organizationId: orgId, userId: victorId }, (tx) =>
        currentTurnTools(
          tx,
          createPermissionService(stack.built.core),
          { agentId: scoutId, humanUserId: victorId, conversationKind: "channel", conversationId: channelId },
          stack.built.core.env,
        ),
      );
    expect((await now()).tools).toContain(WHOAMI);
    await revoke();
    expect((await now()).tools).not.toContain(WHOAMI);
    // The gate re-decides it for the delivered turn too.
    const gate = await cellCall("POST", "/tool-calls", {
      eventId: ev.eventId,
      agentId: scoutId,
      tool: WHOAMI,
      params: {},
    });
    expect(gate.body).toMatchObject({ allowed: false, reason: "policy_changed" });
  });

  it("a share of the personal key offers ocw_http_request in the channel; a unit key is offered there anyway", async () => {
    const revoke = await share(victorId, channelId, "vault_item", personalKey.id);
    const shared = await turnIn(victor, channelId);
    expect(shared.turn.tools).toContain("ocw_http_request");
    expect(shared.turn.withheld).toEqual([crmWithheld()]);
    await revoke();

    const orgKey = await ok(
      victor.request("POST", "/api/v1/keychain", {
        scope: "unit",
        unitId: null,
        kind: "api_key",
        name: "Org ERP",
        value: "ORG-KEY-CANARY",
        allowedHosts: ["erp.example"],
      }),
      201,
    );
    await ok(victor.request("PUT", `/api/v1/keychain/${orgKey.id}/agents`, { agentIds: [scoutId] }));
    const ev = await turnIn(victor, channelId);
    expect(ev.turn.tools).toContain("ocw_http_request");
    // The personal key is still withheld by name, even though the tool stays offered for the unit key.
    expect(ev.turn.withheld).toEqual([crmWithheld(), keyWithheld()]);
    await ok(victor.request("DELETE", `/api/v1/keychain/${orgKey.id}`));
  });
});

describe("flags and the cell-wide view", () => {
  it("ocw_connector_list taints once a per-member connector is listed (third-party tool descriptions)", async () => {
    const ev = await turnIn(victor, dmId);
    expect(ev.turn.toolFlags.ocw_connector_list).toEqual({ untrustedOutput: true, sideEffecting: false });
    const turn = (await su.query("select * from app.agent_turns where event_id = $1", [ev.eventId])).rows[0];
    await stack.built.core.db.withTenant({ organizationId: orgId, userId: victorId }, (tx) =>
      claimToolCall(tx, stack.built.core, {
        cell: { organizationId: orgId, cellId: orgId, credentialId: "env", source: "env" },
        turn: {
          eventId: turn.event_id,
          organizationId: turn.organization_id,
          agentId: turn.agent_id,
          userId: turn.user_id,
          conversationId: turn.conversation_id,
          conversationKind: turn.conversation_kind,
          messageId: turn.message_id,
          tools: turn.tools,
          toolFlags: turn.tool_flags,
          toolCalls: turn.tool_calls,
          webCalls: turn.web_calls,
          tainted: turn.tainted,
          createdAt: turn.created_at,
        },
        tool: "ocw_connector_list",
        flags: ev.turn.toolFlags.ocw_connector_list,
        web: false,
        sourceKind: "builtin",
        sourceId: null,
        target: null,
        reason: null,
      }),
    );
    expect(
      (await su.query("select tainted from app.agent_turns where event_id = $1", [ev.eventId])).rows[0]
        .tainted,
    ).toBe(true);
  });

  it("with keys only, the list names handles people wrote: trusted", async () => {
    const msg = await ok(
      victor.request("POST", `/api/v1/conversations/${(await personalDm()) as string}/messages`, {
        body: "hi",
      }),
    );
    const ev = await deliveryOf(msg.id as string);
    expect(ev.turn.tools).toEqual(expect.arrayContaining(["ocw_http_request", "ocw_connector_list"]));
    expect(ev.turn.tools).not.toContain("ocw_connector_call");
    expect(ev.turn.toolFlags.ocw_connector_list).toEqual({ untrustedOutput: false, sideEffecting: false });
  });

  it("/cell alsoAllow: the three static names, never a per-member logical name; keys alone add list and http", async () => {
    const agents = (await cellCall("GET", "/cell")).body?.agents as Json[];
    const scout = agents.find((a) => a.id === scoutId)?.capabilities.tools as string[];
    expect(scout).toEqual(expect.arrayContaining([...STATIC, ECHO]));
    expect(scout.filter((t) => t.startsWith(`${CRM}__`))).toEqual([]);
    const mine = agents.find((a) => a.id === victorBot)?.capabilities.tools as string[];
    expect(mine).toEqual(expect.arrayContaining(["ocw_connector_list", "ocw_http_request"]));
    expect(mine).not.toContain("ocw_connector_call");
  });
});

let victorPersonalDm = "";
async function personalDm(): Promise<string> {
  if (!victorPersonalDm) {
    victorPersonalDm = (
      await su.query(
        `select c.id from app.conversations c join app.conversation_members m on m.conversation_id = c.id
         where c.kind = 'dm' and m.member_kind = 'agent' and m.member_id = $1 limit 1`,
        [victorBot],
      )
    ).rows[0].id as string;
  }
  return victorPersonalDm;
}
