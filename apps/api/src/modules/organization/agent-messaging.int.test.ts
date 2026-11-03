import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";
import { messagingDecision } from "./agent-messaging";
import { createPermissionService } from "./index";

/**
 * Phase 07.7 (A2A-02, D-02, D-04, P-03 … P-05, ADR-0027): who may consult whom is resolver data. The organization switch
 * "Bots may consult each other" (`GET/PUT /api/v1/agent-messaging`) and the per-bot consult rules
 * (`GET/PUT /api/v1/agents/:id/messaging`) write ordinary `agent.message` rules through 07.3's audited helpers; the
 * canonical decision (`messagingDecision`, the call 07.7-04's consult route makes) reads them with the target's
 * visibility for the human the asking bot acts for. Real PostgreSQL + Redis; no model, no cell.
 *
 * Cast: Víctor (admin, setup), Sam (standard, no unit), Lee (org role lead, lead of Ops), Pat (standard, member of Ops).
 * Bots: Archie and Bea (organization team bots), Opsy (unit persona of Ops), Pebble (Víctor's personal bot).
 */

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let lee: TestClient;
let orgId: string;
let victorId: string;
let samId: string;
let leeId: string;
let patId: string;
let opsId: string;
let archie: string;
let bea: string;
let opsy: string;
let pebble: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as Json).error as { code: string; message: string; details?: Json };
}

async function insertBot(
  organizationId: string,
  name: string,
  extra: { scope?: "team" | "personal"; ownerUserId?: string; unitId?: string } = {},
): Promise<string> {
  return (
    await su.query(
      `insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, status, scope,
                               owner_user_id, unit_id)
       values ($1, $2, $3, 'Help', 'mock', 'mock-1', 'ready', $4, $5, $6) returning id`,
      [
        organizationId,
        name,
        `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
        extra.scope ?? "team",
        extra.ownerUserId ?? null,
        extra.unitId ?? null,
      ],
    )
  ).rows[0].id as string;
}

/** Every `agent.message` row of an organization (superuser view). */
const messagingRows = async (organizationId = orgId) =>
  (
    await su.query(
      `select * from app.permission_rules where organization_id = $1 and permission = 'agent.message'
        order by created_at, id`,
      [organizationId],
    )
  ).rows as Json[];

const switchRows = async (organizationId = orgId) =>
  (await messagingRows(organizationId)).filter(
    (r) =>
      r.scope_unit_id === null &&
      r.subject_kind === "everyone" &&
      r.tool === null &&
      r.effect === "allow" &&
      r.path_prefix === null,
  );

const auditRows = async (action: string) =>
  (
    await su.query(
      "select * from app.audit_events where organization_id = $1 and action = $2 order by occurred_at, id",
      [orgId, action],
    )
  ).rows as Json[];

const ruleEvents = async (organizationId = orgId) =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'permission_rules.updated' order by seq",
      [`org:${organizationId}`],
    )
  ).rows as Json[];

/** The canonical decision (P-05): `source` consults `target` on behalf of `human`. */
async function decision(source: string, human: string, target: string, organizationId = orgId) {
  return stack.built.core.db.withTenant({ organizationId, userId: human }, (tx) =>
    messagingDecision(tx, createPermissionService(stack.built.core), {
      sourceAgentId: source,
      humanUserId: human,
      targetAgentId: target,
    }),
  );
}

const setSwitch = (as: TestClient, enabled: boolean) =>
  as.request("PUT", "/api/v1/agent-messaging", { enabled });

beforeAll(async () => {
  stack = await startTestStack();
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
    "Sam Standard",
    "standard",
  ));
  ({ client: lee, userId: leeId } = await invite(stack, victor, "lee@example.test", "Lee Lead", "lead"));
  ({ userId: patId } = await invite(stack, victor, "pat@example.test", "Pat Ops", "standard"));
  opsId = (
    await ok(victor.request("POST", "/api/v1/units", { kind: "department", name: "Ops", parentId: null }))
  ).id;
  await ok(victor.request("POST", `/api/v1/units/${opsId}/members`, { userId: leeId, role: "lead" }));
  await ok(victor.request("POST", `/api/v1/units/${opsId}/members`, { userId: patId }));

  archie = await insertBot(orgId, "Archie");
  bea = await insertBot(orgId, "Bea");
  opsy = await insertBot(orgId, "Opsy", { unitId: opsId });
  pebble = await insertBot(orgId, "Pebble", { scope: "personal", ownerUserId: victorId });
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("the organization switch: closed by default, one audited rule (D-04, P-03)", () => {
  it("closed by default → the admin turns it on → the canonical decision is allowed → off closes it again", async () => {
    const closed = await decision(archie, samId, bea);
    expect(closed.allowed).toBe(false);
    expect(closed.denial).toMatchObject({ permission: "agent.message", layer: "role" });

    expect(await ok(victor.request("GET", "/api/v1/agent-messaging"))).toEqual({
      enabled: false,
      canManage: true,
    });

    const createdBefore = (await auditRows("permission_rule.created")).length;
    const eventsBefore = (await ruleEvents()).length;
    expect(await ok(setSwitch(victor, true))).toEqual({ enabled: true, canManage: true });
    const rows = await switchRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_id: null, created_by: victorId });
    expect(await messagingRows()).toHaveLength(1);
    const created = (await auditRows("permission_rule.created")).slice(createdBefore);
    expect(created).toHaveLength(1);
    expect(created[0]?.resource_id).toBe(rows[0]?.id);
    expect(created[0]?.metadata).toMatchObject({ via: "agent_messaging" });
    expect((await ruleEvents()).length).toBe(eventsBefore + 1);

    expect((await decision(archie, samId, bea)).allowed).toBe(true);

    // Idempotent: on again writes nothing.
    expect(await ok(setSwitch(victor, true))).toEqual({ enabled: true, canManage: true });
    expect(await switchRows()).toHaveLength(1);
    expect((await auditRows("permission_rule.created")).length).toBe(createdBefore + 1);
    expect((await ruleEvents()).length).toBe(eventsBefore + 1);

    // A hand-written duplicate goes with the switch (one audit per row, one event).
    await su.query(
      `insert into app.permission_rules (organization_id, subject_kind, permission, effect)
       values ($1, 'everyone', 'agent.message', 'allow')`,
      [orgId],
    );
    const deletedBefore = (await auditRows("permission_rule.deleted")).length;
    expect(await ok(setSwitch(victor, false))).toEqual({ enabled: false, canManage: true });
    expect(await switchRows()).toHaveLength(0);
    const deleted = (await auditRows("permission_rule.deleted")).slice(deletedBefore);
    expect(deleted).toHaveLength(2);
    for (const d of deleted) expect(d.metadata).toMatchObject({ via: "agent_messaging" });
    expect((await ruleEvents()).length).toBe(eventsBefore + 2);
    expect((await decision(archie, samId, bea)).allowed).toBe(false);

    // Off again: nothing to do.
    await ok(setSwitch(victor, false));
    expect((await auditRows("permission_rule.deleted")).length).toBe(deletedBefore + 2);
    expect((await ruleEvents()).length).toBe(eventsBefore + 2);
  });

  it("only admins see and change the switch: a unit lead and a standard member get 403 and nothing changes", async () => {
    const before = await messagingRows();
    for (const c of [sam, lee]) {
      expect((await fails(c.request("GET", "/api/v1/agent-messaging"), 403)).details).toMatchObject({
        permission: "rule.read",
      });
      expect((await fails(setSwitch(c, true), 403)).details).toMatchObject({ permission: "rule.manage" });
    }
    expect(await messagingRows()).toEqual(before);
  });

  it("a malformed body is 400 validation_error and writes nothing", async () => {
    const before = await messagingRows();
    for (const body of [{}, { enabled: "yes" }, { enabled: null }]) {
      expect((await fails(victor.request("PUT", "/api/v1/agent-messaging", body), 400)).code).toBe(
        "validation_error",
      );
    }
    expect(await messagingRows()).toEqual(before);
  });
});

describe("target visibility for the human through real rows and facts (D-02, P-05)", () => {
  beforeAll(async () => {
    await ok(setSwitch(victor, true));
  });
  afterAll(async () => {
    await ok(setSwitch(victor, false));
  });

  it("a unit persona of Ops is consultable only for people who see it (members, its lead, admins)", async () => {
    expect(await decision(archie, samId, opsy)).toEqual({
      allowed: false,
      denial: { permission: "agent.message", layer: "resource", reason: "unit_agent" },
    });
    for (const human of [patId, leeId, victorId])
      expect((await decision(archie, human, opsy)).allowed).toBe(true);
    // The organization bot stays consultable for Sam.
    expect((await decision(archie, samId, bea)).allowed).toBe(true);
  });

  it("a personal bot is never a target for someone who does not own it", async () => {
    for (const human of [samId, leeId]) {
      expect((await decision(archie, human, pebble)).denial).toEqual({
        permission: "agent.message",
        layer: "resource",
        reason: "personal_bot",
      });
    }
  });

  it("Sam with 07.3's Bots module off is refused, everyone else keeps it", async () => {
    const bots = (enabled: boolean) =>
      victor.request("PUT", "/api/v1/module-access", {
        module: "bots",
        scopeUnitId: null,
        subject: { kind: "user", userId: samId },
        enabled,
      });
    await ok(bots(false));
    try {
      expect((await decision(archie, samId, bea)).denial).toMatchObject({
        permission: "agent.message",
        layer: "user",
        reason: "denied_by_rule",
      });
      expect((await decision(archie, patId, bea)).allowed).toBe(true);
    } finally {
      await ok(bots(true));
    }
    expect((await decision(archie, samId, bea)).allowed).toBe(true);
  });

  it("a deleted or unknown target is denied", async () => {
    expect((await decision(archie, samId, "00000000-0000-4000-8000-000000000000")).denial).toMatchObject({
      permission: "agent.message",
      reason: "agent_not_found",
    });
  });
});

type Outbound = { mode: "default" | "any" | "only" | "none"; allow?: string[]; deny?: string[] };

const messagingBody = (outbound: Outbound, consultable = true) => ({
  outbound: { mode: outbound.mode, allow: outbound.allow ?? [], deny: outbound.deny ?? [] },
  inbound: { consultable },
});
const getBot = (as: TestClient, id: string) => as.request("GET", `/api/v1/agents/${id}/messaging`);
const putBot = (as: TestClient, id: string, outbound: Outbound, consultable = true) =>
  as.request("PUT", `/api/v1/agents/${id}/messaging`, messagingBody(outbound, consultable));

/** A bot's own rows (P-04): organization scope, `agent.message`, subject the bot or everyone with tool agent:<bot>. */
const ownRows = async (agentId: string) =>
  (await messagingRows()).filter(
    (r) =>
      r.scope_unit_id === null &&
      ((r.subject_kind === "agent" && r.subject_id === agentId) ||
        (r.subject_kind === "everyone" && r.tool === `agent:${agentId}`)),
  );

const shape = (rows: Json[]) =>
  rows
    .map((r) => ({ subject: r.subject_kind, tool: r.tool, effect: r.effect }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function ref(agentId: string) {
  const row = (await su.query("select name, username from app.agents where id = $1", [agentId])).rows[0];
  return { id: agentId, handle: row.username as string, displayName: row.name as string };
}

const counts = async () => ({
  created: (await auditRows("permission_rule.created")).length,
  deleted: (await auditRows("permission_rule.deleted")).length,
  events: (await ruleEvents()).length,
});

describe("per-bot consult rules: GET/PUT /api/v1/agents/:id/messaging (D-04, P-04)", () => {
  afterAll(async () => {
    for (const id of [archie, bea]) await ok(putBot(victor, id, { mode: "default" }));
    await ok(setSwitch(victor, false));
  });

  it("no rows: the default view says nobody can be consulted right now", async () => {
    expect(await ok(getBot(victor, archie))).toEqual({
      agentId: archie,
      orgDefault: false,
      outbound: { mode: "default", allow: [], deny: [] },
      inbound: { consultable: true },
      effective: { kind: "none", targets: [] },
      canManage: true,
    });
  });

  it("only → any + never ask → none: exact row diffs, one audit per row, one event per changed PUT", async () => {
    let before = await counts();
    const only = await ok(putBot(victor, archie, { mode: "only", allow: [bea] }));
    expect(only.outbound).toEqual({ mode: "only", allow: [await ref(bea)], deny: [] });
    expect(only.effective).toEqual({ kind: "some", targets: [await ref(bea)] });
    expect(shape(await ownRows(archie))).toEqual([
      { subject: "agent", tool: `agent:${bea}`, effect: "allow" },
    ]);
    let after = await counts();
    expect(after).toEqual({
      created: before.created + 1,
      deleted: before.deleted,
      events: before.events + 1,
    });
    const [createdOnly] = (await auditRows("permission_rule.created")).slice(-1);
    expect(createdOnly?.metadata).toMatchObject({ via: "agent_messaging", agentId: archie });

    before = after;
    const any = await ok(putBot(victor, archie, { mode: "any", deny: [bea] }));
    expect(any.outbound).toEqual({ mode: "any", allow: [], deny: [await ref(bea)] });
    // Every other team bot (the Ops persona included: the summary is the agent pass) except Bea.
    expect(any.effective).toEqual({ kind: "some", targets: [await ref(opsy)] });
    expect(shape(await ownRows(archie))).toEqual(
      shape([
        { subject_kind: "agent", tool: null, effect: "allow" },
        { subject_kind: "agent", tool: `agent:${bea}`, effect: "deny" },
      ]),
    );
    after = await counts();
    expect(after).toEqual({
      created: before.created + 2,
      deleted: before.deleted + 1,
      events: before.events + 1,
    });

    const none = await ok(putBot(victor, archie, { mode: "none" }));
    expect(none.outbound).toEqual({ mode: "none", allow: [], deny: [] });
    expect(none.effective).toEqual({ kind: "none", targets: [] });
    expect(shape(await ownRows(archie))).toEqual([{ subject: "agent", tool: null, effect: "deny" }]);
  });

  it("inbound off on Bea: one everyone deny on agent:<Bea>, and Archie's summary drops her", async () => {
    await ok(putBot(victor, archie, { mode: "any" }));
    expect((await ok(getBot(victor, archie))).effective).toEqual({
      kind: "any",
      targets: [await ref(bea), await ref(opsy)],
    });
    const off = await ok(putBot(victor, bea, { mode: "default" }, false));
    expect(off.inbound).toEqual({ consultable: false });
    expect(shape(await ownRows(bea))).toEqual([
      { subject: "everyone", tool: `agent:${bea}`, effect: "deny" },
    ]);
    expect((await ok(getBot(victor, archie))).effective).toEqual({
      kind: "some",
      targets: [await ref(opsy)],
    });
    // Archie's own rows are untouched by Bea's PUT.
    expect(shape(await ownRows(archie))).toEqual([{ subject: "agent", tool: null, effect: "allow" }]);
    await ok(putBot(victor, bea, { mode: "default" }, true));
    expect(await ownRows(bea)).toEqual([]);
  });

  it("the org switch shows as orgDefault and opens the default mode", async () => {
    await ok(putBot(victor, archie, { mode: "default" }));
    await ok(setSwitch(victor, true));
    const view = await ok(getBot(victor, archie));
    expect(view.orgDefault).toBe(true);
    expect(view.outbound.mode).toBe("default");
    expect(view.effective.kind).toBe("any");
    await ok(setSwitch(victor, false));
  });

  it("a PUT identical to the current state writes nothing", async () => {
    await ok(putBot(victor, archie, { mode: "only", allow: [bea, opsy] }, false));
    const before = await counts();
    const rows = (await ownRows(archie)).map((r) => r.id).sort();
    await ok(putBot(victor, archie, { mode: "only", allow: [opsy, bea.toUpperCase()] }, false));
    expect(await counts()).toEqual(before);
    expect((await ownRows(archie)).map((r) => r.id).sort()).toEqual(rows);
    await ok(putBot(victor, archie, { mode: "default" }));
  });

  it("only the bot's own rows change: other rules, other bots, the switch and unit or authorless rows survive", async () => {
    await ok(setSwitch(victor, true));
    const unrelated = [
      // An admin rule on another grain.
      `insert into app.permission_rules (organization_id, subject_kind, subject_id, permission, effect, created_by)
       values ($1, 'user', '${samId}', 'bot.read', 'deny', '${victorId}') returning id`,
      // Another bot's agent.message row.
      `insert into app.permission_rules (organization_id, subject_kind, subject_id, permission, effect, created_by)
       values ($1, 'agent', '${bea}', 'agent.message', 'allow', '${victorId}') returning id`,
      // A unit-scoped agent.message rule naming Archie: never read or written as a per-bot setting (Pitfall 10).
      `insert into app.permission_rules (organization_id, scope_unit_id, subject_kind, subject_id, permission, effect)
       values ($1, '${opsId}', 'agent', '${archie}', 'agent.message', 'deny') returning id`,
      // The authorless org-scope deny 07.7-02's backfill writes next to a complete Bots-off set.
      `insert into app.permission_rules (organization_id, subject_kind, permission, effect)
       values ($1, 'everyone', 'agent.message', 'deny') returning id`,
    ];
    const keep: string[] = [];
    for (const q of unrelated) keep.push((await su.query(q, [orgId])).rows[0].id as string);
    // 07.3's unit-scoped Bots rows (agent.message included).
    const botsOps = (enabled: boolean) =>
      victor.request("PUT", "/api/v1/module-access", {
        module: "bots",
        scopeUnitId: opsId,
        subject: { kind: "everyone" },
        enabled,
      });
    await ok(botsOps(false));
    const moduleRows = (
      await su.query(
        "select id from app.permission_rules where organization_id = $1 and scope_unit_id = $2",
        [orgId, opsId],
      )
    ).rows.map((r) => r.id as string);
    const survivors = [...keep, ...moduleRows, ...(await switchRows()).map((r) => r.id as string)];
    try {
      await ok(putBot(victor, archie, { mode: "any", deny: [bea] }, false));
      await ok(putBot(victor, archie, { mode: "none" }));
      await ok(putBot(victor, archie, { mode: "default" }));
      const ids = new Set(
        (await su.query("select id from app.permission_rules where organization_id = $1", [orgId])).rows.map(
          (r) => r.id as string,
        ),
      );
      for (const id of survivors) expect(ids.has(id), id).toBe(true);
      // The view never counts the unit-scoped row: Archie is in the default mode.
      expect((await ok(getBot(victor, archie))).outbound.mode).toBe("default");
    } finally {
      await su.query("delete from app.permission_rules where id = any($1::uuid[])", [keep]);
      await ok(botsOps(true));
      await ok(setSwitch(victor, false));
    }
  });

  it("refuses targets that are not live team bots of this organization (400), writing nothing", async () => {
    const ghost = await insertBot(orgId, "Ghost");
    await su.query("update app.agents set deleted_at = now() where id = $1", [ghost]);
    const before = await counts();
    const rows = await messagingRows();
    for (const target of [archie, pebble, ghost, randomUUID()]) {
      expect((await fails(putBot(victor, archie, { mode: "only", allow: [target] }), 400)).code).toBe(
        "invalid_agent_messaging",
      );
      expect((await fails(putBot(victor, archie, { mode: "any", deny: [target] }), 400)).code).toBe(
        "invalid_agent_messaging",
      );
    }
    // The contract refuses impossible combinations.
    expect((await fails(putBot(victor, archie, { mode: "only" }), 400)).code).toBe("validation_error");
    expect((await fails(putBot(victor, archie, { mode: "none", deny: [bea] }), 400)).code).toBe(
      "validation_error",
    );
    expect(await counts()).toEqual(before);
    expect(await messagingRows()).toEqual(rows);

    // The bot itself must be a live team bot: personal, deleted and unknown ids are 404.
    for (const id of [pebble, ghost, randomUUID()]) {
      expect((await fails(getBot(victor, id), 404)).code).toBe("bot_not_found");
      expect((await fails(putBot(victor, id, { mode: "any" }), 404)).code).toBe("bot_not_found");
    }
  });

  it("only admins: a lead of the bot's unit and a standard member get 403 on GET and PUT", async () => {
    const rows = await messagingRows();
    for (const c of [sam, lee]) {
      for (const id of [archie, opsy]) {
        expect((await fails(getBot(c, id), 403)).details).toMatchObject({ permission: "rule.read" });
        expect((await fails(putBot(c, id, { mode: "any" }), 403)).details).toMatchObject({
          permission: "rule.manage",
        });
      }
    }
    expect(await messagingRows()).toEqual(rows);
  });

  it("CR-B-05: more than 100 per-target rules never make the sheet a 500; /permission-rules refuses the 101st", async () => {
    const many: string[] = [];
    for (let i = 0; i < 102; i++) many.push(await insertBot(orgId, `Yy${String(i).padStart(3, "0")}`));
    const tool = (id: string) => `agent:${id}`;
    try {
      // Rows from before the cap (or a race): 101 never-ask rows on Archie.
      for (const id of many.slice(0, 101)) {
        await su.query(
          `insert into app.permission_rules (organization_id, subject_kind, subject_id, permission, tool, effect)
           values ($1, 'agent', $2, 'agent.message', $3, 'deny')`,
          [orgId, archie, tool(id)],
        );
      }
      const view = await ok(getBot(victor, archie));
      expect(view.outbound.deny).toHaveLength(101);
      await su.query("delete from app.permission_rules where subject_id = $1 and tool = $2", [
        archie,
        tool(many[100] as string),
      ]);
      const refused = await fails(
        victor.request("POST", "/api/v1/permission-rules", {
          subjectKind: "agent",
          subjectId: archie,
          permission: "agent.message",
          tool: tool(many[101] as string),
          effect: "deny",
        }),
        409,
      );
      expect(refused.code).toBe("agent_rule_limit");
      expect((await ownRows(archie)).filter((r) => r.effect === "deny")).toHaveLength(100);
    } finally {
      await su.query(
        "delete from app.permission_rules where subject_id = $1 and permission = 'agent.message'",
        [archie],
      );
      await su.query("update app.agents set deleted_at = now() where id = any($1::uuid[])", [many]);
    }
  });

  it("CR-B-06: 'only' bots that were all deleted read as default, so the sheet saves back what it shows", async () => {
    const gone = await insertBot(orgId, "Gone");
    try {
      await ok(putBot(victor, archie, { mode: "only", allow: [gone] }));
      await su.query("update app.agents set deleted_at = now() where id = $1", [gone]);
      const view = await ok(getBot(victor, archie));
      expect(view.outbound).toEqual({ mode: "default", allow: [], deny: [] });
      // Saving exactly what the sheet shows (inbound flipped) works and removes the dangling row.
      await ok(putBot(victor, archie, view.outbound, false));
      expect(shape(await ownRows(archie))).toEqual([
        { subject: "everyone", tool: `agent:${archie}`, effect: "deny" },
      ]);
    } finally {
      await ok(putBot(victor, archie, { mode: "default" }));
    }
  });

  it("the summary names at most 50 targets, in display-name order", async () => {
    const many: string[] = [];
    for (let i = 0; i < 55; i++) many.push(await insertBot(orgId, `Zz${String(i).padStart(2, "0")}`));
    try {
      await ok(putBot(victor, archie, { mode: "any" }));
      const view = await ok(getBot(victor, archie));
      expect(view.effective.kind).toBe("any");
      expect(view.effective.targets).toHaveLength(50);
      expect(view.effective.targets.slice(0, 2)).toEqual([await ref(bea), await ref(opsy)]);
      expect(view.effective.targets.map((t: Json) => t.id)).not.toContain(archie);
    } finally {
      await su.query("update app.agents set deleted_at = now() where id = any($1::uuid[])", [many]);
      await ok(putBot(victor, archie, { mode: "default" }));
    }
  });
});

/** A client whose membership moved to a fresh organization B, as its admin (module-access.int.test.ts). */
async function otherOrgAdmin(): Promise<{ client: TestClient; orgB: string; userB: string }> {
  const { client, userId: userB } = await invite(
    stack,
    victor,
    `eve-${randomUUID().slice(0, 8)}@example.test`,
    "Eve",
    "standard",
  );
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userB]);
  await su.query("delete from app.org_members where user_id = $1", [userB]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userB,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userB],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userB]);
  return { client, orgB, userB };
}

describe("tenant isolation (C-02)", () => {
  let eve: { client: TestClient; orgB: string; userB: string };

  beforeAll(async () => {
    eve = await otherOrgAdmin();
  });

  it("organization B's switch never changes organization A's decisions or view", async () => {
    expect(await ok(setSwitch(eve.client, true))).toEqual({ enabled: true, canManage: true });
    expect(await switchRows(eve.orgB)).toHaveLength(1);
    expect(await switchRows()).toHaveLength(0);
    expect((await decision(archie, samId, bea)).allowed).toBe(false);
    expect(await ok(victor.request("GET", "/api/v1/agent-messaging"))).toEqual({
      enabled: false,
      canManage: true,
    });
    await ok(setSwitch(eve.client, false));
    expect(await switchRows(eve.orgB)).toHaveLength(0);
  });

  it("another organization's bot is 404 on both routes and refused as a target (400)", async () => {
    const zed = await insertBot(eve.orgB, "Zed");
    expect((await fails(getBot(victor, zed), 404)).code).toBe("bot_not_found");
    expect((await fails(putBot(victor, zed, { mode: "any" }), 404)).code).toBe("bot_not_found");
    expect((await fails(getBot(eve.client, archie), 404)).code).toBe("bot_not_found");
    expect((await fails(putBot(eve.client, archie, { mode: "none" }), 404)).code).toBe("bot_not_found");
    expect((await fails(putBot(victor, archie, { mode: "only", allow: [zed] }), 400)).code).toBe(
      "invalid_agent_messaging",
    );
    expect((await fails(putBot(eve.client, zed, { mode: "any", deny: [bea] }), 400)).code).toBe(
      "invalid_agent_messaging",
    );
    expect(await messagingRows(eve.orgB)).toEqual([]);
    expect(await ownRows(archie)).toEqual([]);
  });
});
