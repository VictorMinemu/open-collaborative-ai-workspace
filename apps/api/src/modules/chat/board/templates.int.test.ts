import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../../testing";

/**
 * Phase 07.1-07 (BOARD-06, BOARD-04; D-06, D-07, D-08, P-08): record templates over real PostgreSQL + Redis.
 * The tracer: Dana, lead of the Ops team, creates a "Case file" template; Víctor creates `#cases` in Ops from it and
 * its first card is titled `EXP-0001 · Acme · Broken pump`. Then the permission matrix, the scope rule, validation,
 * versions, snapshot independence and tenant isolation.
 */

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let dana: TestClient;
let danaId: string;
let operations: string;
let ops: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** The error of a failed request, asserting its status. */
async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as Json).error as Json;
}

async function invite(
  email: string,
  role: string,
  name: string,
): Promise<{ client: TestClient; id: string }> {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id as string };
}

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
const join = (unitId: string, userId: string, role: "member" | "lead") =>
  ok(victor.request("POST", `/api/v1/units/${unitId}/members`, { userId, role }));

const CASE_RULE = "{prefix}-{seq:0000} · {field:customer} · {summary}";
const caseFile = (unitId: string | null, extra: Json = {}) => ({
  unitId,
  name: "Case file",
  prefix: "EXP",
  namingRule: CASE_RULE,
  fields: [{ key: "customer", label: "Customer", type: "text", required: true }],
  columns: [
    { name: "Intake", category: "backlog" },
    { name: "Waiting for customer", category: "started", defaultWaitingOn: "customer" },
    { name: "Closed", category: "done" },
    { name: "Dropped", category: "cancelled" },
  ],
  ...extra,
});

const boardChannel = (as: TestClient, name: string, extra: Json) =>
  as.request("POST", "/api/v1/channels", { name, layout: "board", visibility: "public", ...extra });
const snapshot = (as: TestClient, id: string) => ok(as.request("GET", `/api/v1/boards/${id}`));
const card = (as: TestClient, boardId: string, body: Json) =>
  as.request("POST", `/api/v1/boards/${boardId}/cards`, { clientMessageId: randomUUID(), ...body });

const auditsOf = async (actions: string[]) =>
  (
    await su.query(
      "select action, metadata from app.audit_events where action = any($1) order by occurred_at",
      [actions],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: dana, id: danaId } = await invite("dana@example.test", "lead", "Dana Lead"));
  operations = await unit("department", "Operations", null);
  ops = await unit("team", "Ops", operations);
  await join(ops, danaId, "lead");
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("record templates (tracer)", () => {
  it("Dana's Case file template names the first card of #cases `EXP-0001 · Acme · Broken pump`", async () => {
    const template = await ok(dana.request("POST", "/api/v1/record-templates", caseFile(ops)));
    expect(template).toMatchObject({
      unitId: ops,
      name: "Case file",
      description: "",
      prefix: "EXP",
      namingRule: CASE_RULE,
      fields: [{ key: "customer", label: "Customer", type: "text", required: true }],
      version: 1,
    });
    expect(template.columns).toEqual([
      { name: "Intake", category: "backlog", defaultWaitingOn: null },
      { name: "Waiting for customer", category: "started", defaultWaitingOn: "customer" },
      { name: "Closed", category: "done", defaultWaitingOn: null },
      { name: "Dropped", category: "cancelled", defaultWaitingOn: null },
    ]);

    const channel = await ok(boardChannel(victor, "cases", { unitId: ops, templateId: template.id }));
    expect(channel).toMatchObject({ name: "cases", layout: "board" });
    expect(channel.unit?.id).toBe(ops);
    const boardId = channel.id as string;

    const snap = await snapshot(victor, boardId);
    expect(snap.board).toMatchObject({
      conversationId: boardId,
      templateId: template.id,
      prefix: "EXP",
      namingRule: CASE_RULE,
      fields: template.fields,
    });
    expect(snap.columns.map((c: Json) => [c.name, c.category, c.defaultWaitingOn])).toEqual([
      ["Intake", "backlog", null],
      ["Waiting for customer", "started", "customer"],
      ["Closed", "done", null],
      ["Dropped", "cancelled", null],
    ]);

    const first = await ok(
      card(victor, boardId, { description: "Broken pump\nPump 3", fields: { customer: "Acme" } }),
    );
    expect(first).toMatchObject({
      title: "EXP-0001 · Acme · Broken pump",
      number: 1,
      columnId: snap.columns[0].id,
    });
    const second = await ok(
      card(victor, boardId, { description: "Leaking valve", fields: { customer: "Globex" } }),
    );
    expect(second).toMatchObject({ title: "EXP-0002 · Globex · Leaking valve", number: 2 });
    const missing = await fails(card(victor, boardId, { description: "No customer" }), 400);
    expect(missing.code).toBe("invalid_field_values");

    const waiting = snap.columns[1] as Json;
    const moved = await ok(
      victor.request("PATCH", `/api/v1/boards/${boardId}/cards/${first.messageId}`, {
        expectedVersion: first.version,
        move: { columnId: waiting.id, afterCardId: null },
      }),
    );
    expect(moved).toMatchObject({ columnId: waiting.id, waitingOn: "customer" });

    const audits = await auditsOf(["record_template.created", "channel.created"]);
    expect(audits.find((a) => a.action === "record_template.created")?.metadata).toEqual({
      templateId: template.id,
      unitId: ops,
      version: 1,
      fieldCount: 1,
      columnCount: 4,
    });
    expect(
      audits.find((a) => a.action === "channel.created" && a.metadata.name === "cases")?.metadata,
    ).toMatchObject({ layout: "board", templateId: template.id, unitId: ops });
    const text = JSON.stringify(audits.filter((a) => a.action === "record_template.created"));
    for (const secret of ["Case file", "EXP", "Customer", "{field:customer}"])
      expect(text).not.toContain(secret);
  });
});
