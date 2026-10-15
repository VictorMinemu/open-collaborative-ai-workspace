import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "./lib/crypto";
import type { TestClient } from "./testing";
import { type ConnectorsStack, type Json, ok, type Res, startConnectorsStack } from "./testing-connectors";
import type { FakeDevice } from "./testing-device";
import { CLAUDE_CATALOG, CODEX_CATALOG, connectWithProject, invite, pairDevice } from "./testing-workzone";

/**
 * 07.5-15 (C-02, APPROVE-01…04): the phase's cross-tenant matrix. Every route 07.5 added or changed is enumerated from
 * the authz registry (the policy routes, the approvals inbox with the new kinds, the Agent Channel Work Zone routes and
 * the three agent-action routes that now decide approvals); each has a case in which organization B (its admin Eve, or
 * its cell) aims at organization A's rules, requests, turns, projects and devices, and gets 404, 403, `unknown_turn`, a
 * refusal or an empty list — never A's data. A route added later without a case fails the test.
 *
 * Organization A: Víctor (admin), Sam (standard, asks), Dev (developer with a device and a project), the team bot
 * Keeper, one org MCP server "Notes" with `write_note`, a Sales unit with a rule, a pending `tool.call` request in Sam's
 * DM and a pending `work_zone.start` proposal in Dev's DM. Organization B: Eve (admin), her cell token and bot Watcher.
 */

const CELL_TOKEN = "ocw-test-cell-token-tool-approvals-cross-tenant-0123";
const NOTES = "m7c6b5a4d";
const WRITE = `${NOTES}__write_note`;

let s: ConnectorsStack;
let su: pg.Client;
let dev: TestClient;
let device: FakeDevice | null = null;
let deviceId = "";
let projectId = "";
let keeperId = "";
let sales = "";
let orgRuleId = "";
let unitRuleId = "";
let toolCallId = "";
let workZoneId = "";
let samEvent = "";
let devEvent = "";
let tokenB = "";
let watcherId = "";
let eveEvent = "";

async function cell(path: string, body: unknown, token = CELL_TOKEN): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

async function status(res: Promise<Res>, expected: number): Promise<Json> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(expected);
  return (r.body ?? {}) as Json;
}

const codeOf = (body: Json) => (body.error as Json | undefined)?.code as string | undefined;

/** A delivered turn of `agentId` for the message `who` posts in `conversationId` (from the cell stream). */
async function turnOf(
  who: TestClient,
  conversationId: string,
  agentId: string,
  org: string,
): Promise<string> {
  await su.query("delete from app.agent_usage_daily");
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `please ${randomUUID().slice(0, 6)}`,
    }),
  );
  for (let i = 0; i < 50; i++) {
    const rows = (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
        [`cell:${org}`, msg.id, agentId],
      )
    ).rows;
    if (rows.length === 1) return rows[0].payload.eventId as string;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no delivered turn");
}

/** Everything of organization A that organization B must never change. */
const snapshotA = async () =>
  JSON.stringify(
    await Promise.all(
      [
        "select id, mode, version from app.tool_approval_policies where organization_id = $1 order by id",
        "select id, status, decided_by, consumed_at from app.approval_requests where organization_id = $1 order by id",
        "select id from app.tool_call_approvals where organization_id = $1 order by id",
        "select id, work_session_id from app.work_zone_proposals where organization_id = $1 order by id",
        "select id from app.work_sessions where organization_id = $1 order by id",
        "select count(*)::int as n from app.agent_tool_calls where organization_id = $1",
      ].map(async (q) => (await su.query(q, [s.orgA])).rows),
    ),
  );

beforeAll(async () => {
  s = await startConnectorsStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  su = s.su;
  // ---- organization A
  ({ client: dev } = await invite(s.stack, s.victor, "dev@example.test", "Dev Ortiz", "developer"));
  sales = (
    await ok(s.victor.request("POST", "/api/v1/units", { kind: "department", name: "Sales", parentId: null }))
  ).id as string;
  await ok(s.victor.request("POST", `/api/v1/units/${sales}/members`, { userId: s.samId }));
  keeperId = (
    await ok(
      s.victor.request("POST", "/api/v1/agents", {
        name: "Keeper",
        username: "keeper",
        instructions: "You are Keeper.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;
  const notesId = randomUUID();
  await su.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
     values ($1, $2, 'Notes', $3, 'streamable-http', 'https://notes.example.test/mcp', 'ready', 'org_secret')`,
    [notesId, s.orgA, NOTES],
  );
  await su.query(
    `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
     values ($1, $2, 'write_note', $3, false)`,
    [s.orgA, notesId, WRITE],
  );
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${keeperId}/capabilities`, {
      tools: [{ sourceKind: "mcp", sourceId: notesId, tool: WRITE }],
    }),
  );
  orgRuleId = (
    await ok(
      s.victor.request("POST", "/api/v1/tool-approval-policies", {
        scopeUnitId: null,
        toolPattern: WRITE,
        mode: "always",
        approverKind: "requester",
      }),
      201,
    )
  ).id as string;
  unitRuleId = (
    await ok(
      s.victor.request("POST", "/api/v1/tool-approval-policies", {
        scopeUnitId: sales,
        toolPattern: "ocw_http_request",
        mode: "always",
        approverKind: "admins",
      }),
      201,
    )
  ).id as string;

  // A pending tool.call request in Sam's DM with Keeper.
  const samDm = (
    await ok(s.sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] }))
  ).id as string;
  samEvent = await turnOf(s.sam, samDm, keeperId, s.orgA);
  const asked = await cell("/tool-calls", {
    eventId: samEvent,
    agentId: keeperId,
    tool: WRITE,
    toolCallId: randomUUID(),
    params: {},
    arguments: { text: "organization A's note" },
  });
  expect(asked.body, JSON.stringify(asked.body)).toMatchObject({ reason: "approval_required" });
  toolCallId = asked.body?.approval.id as string;

  // A pending Work Zone proposal in Dev's DM with Keeper, on Dev's device.
  const paired = await pairDevice(s.stack, dev, "Dev's laptop");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(s.stack, dev, paired.token, {
    localId: "lp_ledger",
    name: "ledger-api",
  }));
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], false);
  for (let i = 0; i < 100; i++) {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    if ((r.rows[0].runtime_catalog as unknown[]).length === 2) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const devDm = (
    await ok(dev.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] }))
  ).id as string;
  devEvent = await turnOf(dev, devDm, keeperId, s.orgA);
  const proposed = await cell("/work-zone/proposals", {
    eventId: devEvent,
    agentId: keeperId,
    projectId,
    deviceId,
    prompt: "Fix the ledger rounding",
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  workZoneId = proposed.body?.approvalId as string;
  expect(workZoneId).toBeTruthy();

  // ---- organization B: Eve's cell and her bot Watcher, with a turn of her own.
  tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
  await su.query(
    "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
    [s.orgB, sha256Hex(tokenB)],
  );
  watcherId = (
    await ok(
      s.eve.request("POST", "/api/v1/agents", {
        name: "Watcher",
        username: "watcher",
        instructions: "You are Watcher.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;
  const eveDm = (
    await ok(s.eve.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: watcherId }] }))
  ).id as string;
  eveEvent = await turnOf(s.eve, eveDm, watcherId, s.orgB);
}, 240_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await s?.stop();
});

describe("organization B never reaches what 07.5 added for organization A (C-02)", () => {
  it("every 07.5 route has an org-B case; A's rules, requests, proposals and sessions are unchanged", async () => {
    const before = await snapshotA();
    const A_WORDS = [
      "Sales",
      "Notes",
      NOTES,
      "Keeper",
      "ledger-api",
      "Dev's laptop",
      "organization A's note",
    ];
    const clean = (body: unknown) => {
      const text = JSON.stringify(body);
      for (const w of A_WORDS) expect(text, w).not.toContain(w);
      for (const id of [
        orgRuleId,
        unitRuleId,
        toolCallId,
        workZoneId,
        projectId,
        deviceId,
        sales,
        samEvent,
      ]) {
        expect(text, id).not.toContain(id);
      }
    };
    const aIds = [toolCallId, workZoneId];
    const eve = s.eve;

    const cases: Record<string, () => Promise<void>> = {
      // ---- the policy routes (07.5-03)
      "GET /api/v1/tool-approval-policies/access": async () => {
        clean(await status(eve.request("GET", "/api/v1/tool-approval-policies/access"), 200));
      },
      "GET /api/v1/tool-approval-policies": async () => {
        const page = await status(eve.request("GET", "/api/v1/tool-approval-policies?scope=org"), 200);
        expect(page.policies).toEqual([]);
        clean(page);
        await status(eve.request("GET", `/api/v1/tool-approval-policies?scope=${sales}`), 404);
      },
      "POST /api/v1/tool-approval-policies": async () => {
        await status(
          eve.request("POST", "/api/v1/tool-approval-policies", {
            scopeUnitId: sales,
            toolPattern: "ocw_http_request",
            mode: "always",
            approverKind: "admins",
          }),
          404,
        );
      },
      "PATCH /api/v1/tool-approval-policies/:p": async () => {
        for (const id of [orgRuleId, unitRuleId]) {
          await status(
            eve.request("PATCH", `/api/v1/tool-approval-policies/${id}`, {
              expectedVersion: 1,
              mode: "never",
            }),
            404,
          );
        }
      },
      "DELETE /api/v1/tool-approval-policies/:p": async () => {
        for (const id of [orgRuleId, unitRuleId]) {
          await status(eve.request("DELETE", `/api/v1/tool-approval-policies/${id}?expectedVersion=1`), 404);
        }
      },
      "GET /api/v1/tool-approval-policies/history": async () => {
        const h = await status(eve.request("GET", "/api/v1/tool-approval-policies/history?scope=org"), 200);
        expect(h).toEqual({ items: [], nextCursor: null });
        await status(eve.request("GET", `/api/v1/tool-approval-policies/history?scope=${sales}`), 404);
      },
      // ---- the approvals inbox with the 07.5 kinds (07.5-06, -07, -08)
      "GET /api/v1/approvals": async () => {
        for (const role of ["decider", "requester"]) {
          for (const kinds of ["tool.call", "work_zone.start", "tool.call,work_zone.start"]) {
            for (const st of ["pending", "approved", "denied", "applied"]) {
              const list = await status(
                eve.request("GET", `/api/v1/approvals?role=${role}&status=${st}&kinds=${kinds}`),
                200,
              );
              expect((list.items as Json[]).map((i) => i.id)).toEqual([]);
              clean(list);
            }
          }
        }
      },
      "GET /api/v1/approvals/:p": async () => {
        for (const id of aIds) clean(await status(eve.request("GET", `/api/v1/approvals/${id}`), 404));
      },
      "POST /api/v1/approvals/:p/decision": async () => {
        const hashes = (
          await su.query("select id, action_hash from app.approval_requests where id = any($1::uuid[])", [
            aIds,
          ])
        ).rows as Array<{ id: string; action_hash: string }>;
        for (const { id, action_hash } of hashes) {
          for (const outcome of ["approved", "denied"]) {
            clean(
              await status(
                eve.request("POST", `/api/v1/approvals/${id}/decision`, { outcome, actionHash: action_hash }),
                404,
              ),
            );
          }
        }
      },
      // ---- the Agent Channel Work Zone routes (07.5-08)
      "POST /agent-channel/v1/work-zone/projects": async () => {
        // B's cell with A's turns: unknown.
        for (const eventId of [devEvent, samEvent]) {
          for (const agentId of [keeperId, watcherId]) {
            const r = await status(cell("/work-zone/projects", { eventId, agentId }, tokenB), 404);
            expect(codeOf(r)).toBe("unknown_turn");
          }
        }
        // B's own turn never lists A's projects or devices.
        const own = await cell("/work-zone/projects", { eventId: eveEvent, agentId: watcherId }, tokenB);
        expect([200, 409], JSON.stringify(own.body)).toContain(own.status);
        if (own.status === 200) expect(own.body?.projects).toEqual([]);
        clean(own.body);
      },
      "POST /agent-channel/v1/work-zone/proposals": async () => {
        const body = { projectId, deviceId, prompt: "Delete everything" };
        for (const agentId of [keeperId, watcherId]) {
          const r = await status(
            cell("/work-zone/proposals", { eventId: devEvent, agentId, ...body }, tokenB),
            404,
          );
          expect(codeOf(r)).toBe("unknown_turn");
        }
        // B's own turn naming A's project and device: refused, nothing stored, never A's names.
        const own = await cell(
          "/work-zone/proposals",
          { eventId: eveEvent, agentId: watcherId, ...body },
          tokenB,
        );
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect(own.body?.refused).toBeTruthy();
        expect(own.body?.approvalId).toBeUndefined();
        clean(own.body);
      },
      // ---- the three agent-action routes that decide approvals (07.5-11)
      "POST /agent-channel/v1/tool-calls": async () => {
        for (const agentId of [keeperId, watcherId]) {
          const r = await status(
            cell(
              "/tool-calls",
              {
                eventId: samEvent,
                agentId,
                tool: WRITE,
                toolCallId: randomUUID(),
                params: {},
                arguments: { text: "organization A's note" },
              },
              tokenB,
            ),
            200,
          );
          expect(r).toMatchObject({ allowed: false, reason: "unknown_turn" });
          expect(r.approval).toBeUndefined();
        }
      },
      "POST /agent-channel/v1/connectors/call": async () => {
        for (const agentId of [keeperId, watcherId]) {
          const r = await status(
            cell(
              "/connectors/call",
              { eventId: samEvent, agentId, connector: NOTES, tool: "write_note", arguments: { text: "x" } },
              tokenB,
            ),
            403,
          );
          expect(codeOf(r)).toBe("no_trigger");
        }
      },
      "POST /agent-channel/v1/http-requests": async () => {
        for (const agentId of [keeperId, watcherId]) {
          const r = await status(
            cell(
              "/http-requests",
              {
                eventId: samEvent,
                agentId,
                handle: "k_abcdefghij",
                method: "POST",
                url: "https://example.test/x",
                body: "x",
              },
              tokenB,
            ),
            403,
          );
          expect(codeOf(r)).toBe("no_trigger");
        }
      },
    };

    const exact = new Set([
      "/agent-channel/v1/tool-calls",
      "/agent-channel/v1/connectors/call",
      "/agent-channel/v1/http-requests",
    ]);
    const owned = (k: string) => {
      const path = k.split(" ")[1] ?? "";
      return (
        path.startsWith("/api/v1/tool-approval-policies") ||
        path.startsWith("/api/v1/approvals") ||
        path.startsWith("/agent-channel/v1/work-zone") ||
        exact.has(path)
      );
    };
    const routeKey = (k: string) => k.replace(/:[A-Za-z]+/gu, ":p");
    const registered = [...s.stack.built.authz.routes.keys()]
      .filter((k) => !k.startsWith("HEAD "))
      .filter(owned)
      .map(routeKey)
      .sort();
    expect(registered).toEqual(Object.keys(cases).sort());
    for (const run of Object.values(cases)) await run();
    expect(await snapshotA()).toBe(before);
    // A's two requests are still pending, undecided, unconsumed.
    const rows = (
      await su.query(
        "select status, decided_by, consumed_at from app.approval_requests where id = any($1::uuid[])",
        [aIds],
      )
    ).rows;
    expect(rows).toEqual([
      { status: "pending", decided_by: null, consumed_at: null },
      { status: "pending", decided_by: null, consumed_at: null },
    ]);
  });
});
