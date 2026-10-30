import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";

/**
 * 07.6-05 (AUTO-01, AUTO-02, D-01, D-07, P-04, P-07 … P-10, R12, R13): the automation entity as a REST resource over
 * real PostgreSQL + Redis. Organization A: Ana Díaz (admin, `automation.manage`), Víctor Ruiz and Sam Lee (standard),
 * Marta Gil (lead, `automation.webhook`); the team bot Scout is a member of #sales, #announcements and the orders
 * board, not of #ops; Víctor is a member of #sales, #ops and the orders board, not of #announcements. Organization B:
 * Eve (admin). Every automation runs as its creator; managers govern, never run as someone else.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

let stack: TestStack;
let su: pg.Client;
let ana: TestClient;
let victor: TestClient;
let sam: TestClient;
let marta: TestClient;
let eve: TestClient;
let orgA: string;
let anaId: string;
let victorId: string;
let samId: string;
let scoutId: string;
let personalBotId: string;
let oldBotId: string;
let sales: string;
let ops: string;
let announcements: string;
let orders: string;
let ordersColumn: string;
let intake: string;
let intakeColumn: string;

async function ok(res: Promise<Res> | Res, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body ?? {}) as Json;
}

async function fails(res: Promise<Res> | Res, status: number, code?: string): Promise<Json> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect((r.body as Json | null)?.error?.code, JSON.stringify(r.body)).toBe(code);
  return (r.body ?? {}) as Json;
}

const weekly = (extra: Json = {}): Json => ({
  name: "Weekly sales report",
  agentId: scoutId,
  instructions: "Summarise this week's closed deals and post the totals per rep.",
  trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
  target: { kind: "channel", conversationId: sales },
  ...extra,
});

const audits = async (action: string, resourceId?: string) =>
  (
    await su.query(
      `select resource_id, user_id, actor_id, metadata from app.audit_events
       where action = $1 and organization_id = $2 ${resourceId ? "and resource_id = $3" : ""}
       order by occurred_at`,
      resourceId ? [action, orgA, resourceId] : [action, orgA],
    )
  ).rows as Array<{ resource_id: string; user_id: string; actor_id: string; metadata: Json }>;

const userEvents = async (userId: string, automationId: string) =>
  (
    await su.query(
      `select payload from app.stream_events
       where stream_id = $1 and type = 'automation.updated' and payload->>'automationId' = $2 order by seq`,
      [`user:${userId}`, automationId],
    )
  ).rows.map((r) => r.payload as Json);

/** The next Friday 17:00 in Madrid after `from`, found without cron-parser (CET = 16:00Z, CEST = 15:00Z). */
function nextFridayFivePmMadrid(from: Date): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let i = 0; i < 15; i++) {
    for (const hour of [15, 16]) {
      const t = new Date(day.getTime() + i * 86_400_000 + hour * 3_600_000);
      if (t <= from) continue;
      const parts = Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]));
      if (parts.weekday === "Fri" && parts.hour === "17" && parts.minute === "00") return t.toISOString();
    }
  }
  throw new Error("no Friday found");
}

async function channel(name: string, opts: { victor: boolean; scout: boolean; layout?: "board" }) {
  const created = await ok(
    ana.request("POST", "/api/v1/channels", {
      name,
      visibility: "public",
      ...(opts.layout ? { layout: opts.layout } : {}),
    }),
  );
  const id = created.id as string;
  if (opts.victor) await ok(victor.request("POST", `/api/v1/channels/${id}/join`));
  if (opts.scout) {
    await ok(ana.request("POST", `/api/v1/channels/${id}/members`, { kind: "agent", id: scoutId }));
  }
  return id;
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  ana = new TestClient(stack.baseUrl);
  const setup = await ok(
    ana.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Ana Díaz",
      email: "ana@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgA = setup.organization.id;
  anaId = setup.user.id;
  ({ client: victor, userId: victorId } = await invite(
    stack,
    ana,
    "victor@example.test",
    "Víctor Ruiz",
    "standard",
  ));
  ({ client: sam, userId: samId } = await invite(stack, ana, "sam@example.test", "Sam Lee", "standard"));
  ({ client: marta } = await invite(stack, ana, "marta@example.test", "Marta Gil", "lead"));
  const { client: eveClient, userId: eveId } = await invite(
    stack,
    ana,
    "eve@example.test",
    "Eve Black",
    "standard",
  );
  eve = eveClient;

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

  const bot = async (name: string) =>
    (
      await ok(
        ana.request("POST", "/api/v1/agents", {
          name,
          instructions: `You are ${name}.`,
          modelProvider: "mock",
          modelId: "mock-1",
        }),
      )
    ).id as string;
  scoutId = await bot("Scout");
  oldBotId = await bot("Oldie");
  await su.query("update app.agents set status = 'ready' where id = $1", [scoutId]);
  personalBotId = (await ok(victor.request("POST", "/api/v1/agents/personal", {}))).agent.id;

  sales = await channel("sales", { victor: true, scout: true });
  ops = await channel("ops", { victor: true, scout: false });
  announcements = await channel("announcements", { victor: false, scout: true });
  orders = await channel("orders", { victor: true, scout: true, layout: "board" });
  ordersColumn = (await ok(ana.request("GET", `/api/v1/boards/${orders}`))).columns[0].id;
  intake = await channel("intake", { victor: true, scout: true, layout: "board" });
  intakeColumn = (await ok(ana.request("GET", `/api/v1/boards/${intake}`))).columns[0].id;
  await ok(ana.request("POST", `/api/v1/channels/${sales}/members`, { kind: "agent", id: oldBotId }));
  await su.query("update app.agents set status = 'disabled' where id = $1", [oldBotId]);
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("Víctor creates a weekly automation through REST (Task 1, tracer)", () => {
  let automationId: string;

  it("creates it as himself, with its next run in Madrid, audited by ids and announced on his stream", async () => {
    const before = new Date();
    const created = await ok(victor.request("POST", "/api/v1/automations", weekly()), 201);
    const a = created.automation as Json;
    automationId = a.id;
    expect(created.webhookSecret).toBeUndefined();
    expect(a.runAs).toEqual({ id: victorId, displayName: "Víctor Ruiz" });
    expect(a.status).toBe("active");
    expect(a.actionKind).toBe("agent_turn");
    expect(a.agent).toEqual({ id: scoutId, displayName: "Scout", personal: false });
    expect(a.trigger).toEqual({
      kind: "schedule",
      schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" },
      webhook: null,
      mailbox: null,
    });
    expect(a.target).toEqual({ kind: "channel", conversationId: sales, label: "#sales" });
    expect(a.nextRunAt).toBe(nextFridayFivePmMadrid(before));
    expect(a.version).toBe(1);
    expect(a.maxRunsPerDay).toBe(24);
    expect(a.lastRun).toBeNull();
    expect(a.viewerCan).toEqual(["edit", "run", "pause", "delete"]);

    const [audit, ...more] = await audits("automation.created", automationId);
    expect(more).toEqual([]);
    expect(audit!.user_id).toBe(victorId);
    expect(audit!.metadata).toEqual({
      automationId,
      agentId: scoutId,
      actionKind: "agent_turn",
      triggerKind: "schedule",
      targetKind: "channel",
      conversationId: sales,
    });
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/Weekly|closed deals/);
    expect(await userEvents(victorId, automationId)).toEqual([{ automationId }]);
  });

  it("lists and reads it with the usage against the cap; org B and another member get 404", async () => {
    const list = await ok(victor.request("GET", "/api/v1/automations"));
    expect(list.automations.map((x: Json) => x.id)).toEqual([automationId]);
    expect(list.usage).toEqual({ used: 1, max: 10 });
    expect(list.canManage).toBe(false);
    const one = await ok(victor.request("GET", `/api/v1/automations/${automationId}`));
    expect(one.id).toBe(automationId);
    await fails(eve.request("GET", `/api/v1/automations/${automationId}`), 404);
    await fails(sam.request("GET", `/api/v1/automations/${automationId}`), 404);
    expect((await ok(sam.request("GET", "/api/v1/automations"))).automations).toEqual([]);
  });

  it("previews the next three runs through the same code path as save", async () => {
    const preview = await ok(
      victor.request("POST", "/api/v1/automations/schedule-preview", {
        cron: "0 17 * * 5",
        timeZone: "Europe/Madrid",
      }),
    );
    expect(preview.ok).toBe(true);
    expect(preview.next).toHaveLength(3);
    const [first, second, third] = (preview.next as string[]).map((t) => Date.parse(t));
    expect(new Date(first!).toISOString()).toBe(nextFridayFivePmMadrid(new Date()));
    expect(second! - first!).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000);
    expect(third! - second!).toBeLessThanOrEqual(7 * 86_400_000 + 3_600_000);
    expect(
      await ok(
        victor.request("POST", "/api/v1/automations/schedule-preview", {
          cron: "*/5 * * * *",
          timeZone: "Europe/Madrid",
        }),
      ),
    ).toEqual({ ok: false, code: "schedule_too_frequent", minMinutes: 15 });
    expect(
      await ok(
        victor.request("POST", "/api/v1/automations/schedule-preview", {
          cron: "0 30 * * *",
          timeZone: "Europe/Madrid",
        }),
      ),
    ).toEqual({ ok: false, code: "invalid_cron" });
  });
});

describe("trigger seams (Task 2): webhook and mail triggers go through their adapters", () => {
  it("refuses a lead's webhook trigger and a mail trigger with 400 trigger_unavailable, leaving nothing", async () => {
    const countBefore = Number((await su.query("select count(*) from app.automations")).rows[0].count);
    await fails(
      marta.request("POST", "/api/v1/automations", {
        name: "Shopify orders",
        agentId: scoutId,
        instructions: "Read each order and flag the risky ones.",
        trigger: { kind: "webhook" },
        target: { kind: "dm" },
        inbound: { action: "post", askBot: true, config: { titlePointer: "/order/name" } },
      }),
      400,
      "trigger_unavailable",
    );
    await fails(
      victor.request("POST", "/api/v1/automations", {
        name: "Supplier inbox",
        agentId: scoutId,
        instructions: "Read each supplier mail and summarise it.",
        trigger: {
          kind: "mail",
          mailbox: {
            vaultItemId: randomUUID(),
            host: "imap.example.test",
            port: 993,
            folder: "INBOX",
            pollIntervalMinutes: 10,
          },
        },
        target: { kind: "channel", conversationId: sales },
        inbound: { action: "post", askBot: true, config: {} },
      }),
      400,
      "trigger_unavailable",
    );
    expect(Number((await su.query("select count(*) from app.automations")).rows[0].count)).toBe(countBefore);
    expect(await audits("automation.created")).toHaveLength(countBefore);
  });
});
