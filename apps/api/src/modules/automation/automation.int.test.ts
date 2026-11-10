import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  ({ client: sam } = await invite(stack, ana, "sam@example.test", "Sam Lee", "standard"));
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
      // 07.17 (PD-17, PD-18): the fan-out settings as counts, off for a 07.16-shaped body.
      fanOut: false,
      perRun: 10,
      perDay: 100,
      escalationCount: 0,
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
    // Phase 07.17 (D-01, D-11, AFO-01, E22): every 5 minutes is the default minimum; every 4 is still refused.
    const everyFive = await ok(
      victor.request("POST", "/api/v1/automations/schedule-preview", {
        cron: "*/5 * * * *",
        timeZone: "Europe/Madrid",
      }),
    );
    expect(everyFive.ok).toBe(true);
    expect(everyFive.next).toHaveLength(3);
    const [a, b] = (everyFive.next as string[]).map((t) => Date.parse(t));
    expect(b! - a!).toBe(5 * 60_000);
    expect(
      await ok(
        victor.request("POST", "/api/v1/automations/schedule-preview", {
          cron: "*/4 * * * *",
          timeZone: "Europe/Madrid",
        }),
      ),
    ).toEqual({ ok: false, code: "schedule_too_frequent", minMinutes: 5 });
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
  // A lead's webhook trigger now creates its endpoint (07.6-10, webhooks.int.test.ts).
  it("refuses a mail trigger with 400 trigger_unavailable, leaving nothing", async () => {
    const countBefore = Number((await su.query("select count(*) from app.automations")).rows[0].count);
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
      "mailbox_key_not_usable", // 07.6-11: through the mail adapter (an unknown key), still leaving nothing
    );
    expect(Number((await su.query("select count(*) from app.automations")).rows[0].count)).toBe(countBefore);
    expect(await audits("automation.created")).toHaveLength(countBefore);
  });
});

describe("governance (Task 4, D-07, P-04, R12): managers pause and delete, never edit, resume or run", () => {
  let id: string;
  const due = async () =>
    (await su.query("select id from app.due_automations(1000, now() + interval '30 days')")).rows.map(
      (r) => r.id as string,
    );

  beforeAll(async () => {
    id = (await ok(victor.request("POST", "/api/v1/automations", weekly({ name: "Pipeline review" })), 201))
      .automation.id;
  });

  it("Ana lists everyone's automations with who they run as; Sam may not ask for everyone's", async () => {
    const all = await ok(ana.request("GET", "/api/v1/automations?scope=all"));
    expect(all.canManage).toBe(true);
    const row = (all.automations as Json[]).find((a) => a.id === id);
    expect(row?.runAs).toEqual({ id: victorId, displayName: "Víctor Ruiz" });
    expect(row?.viewerCan).toEqual(["pause", "delete"]);
    expect((await ok(ana.request("GET", "/api/v1/automations"))).automations).toEqual([]);
    await fails(sam.request("GET", "/api/v1/automations?scope=all"), 403, "not_allowed");
  });

  it("Ana pauses it (audited as her, off the due list) but gets 403 on edit, resume and Run now", async () => {
    expect(await due()).toContain(id);
    const paused = await ok(ana.request("POST", `/api/v1/automations/${id}/pause`));
    expect(paused.status).toBe("paused");
    expect(paused.pausedBy).toEqual({ id: anaId, displayName: "Ana Díaz" });
    expect(paused.nextRunAt).not.toBeNull();
    expect(await due()).not.toContain(id);
    const [audit] = await audits("automation.paused", id);
    expect(audit!.user_id).toBe(anaId);
    expect(audit!.metadata).toEqual({ automationId: id, runAsUserId: victorId, previousStatus: "active" });

    await fails(ana.request("POST", `/api/v1/automations/${id}/resume`), 403, "not_allowed");
    await fails(
      ana.request("PATCH", `/api/v1/automations/${id}`, {
        expectedVersion: paused.version,
        name: "Mine now",
      }),
      403,
      "not_allowed",
    );
    await fails(ana.request("POST", `/api/v1/automations/${id}/run`), 403, "not_allowed");
    await fails(victor.request("POST", `/api/v1/automations/${id}/run`), 409, "automation_inactive");
  });

  it("only Víctor resumes it, which resets the breaker and puts it back on the due list", async () => {
    await su.query("update app.automations set consecutive_failures = 2 where id = $1", [id]);
    const resumed = await ok(victor.request("POST", `/api/v1/automations/${id}/resume`));
    expect(resumed.status).toBe("active");
    expect(resumed.consecutiveFailures).toBe(0);
    expect(resumed.pausedBy).toBeNull();
    expect(await due()).toContain(id);
    const [audit] = await audits("automation.resumed", id);
    expect(audit!.user_id).toBe(victorId);
    expect(audit!.metadata).toEqual({ automationId: id, previousStatus: "paused" });
  });

  it("Sam, another member, gets 404 on every route of Víctor's automation", async () => {
    await fails(sam.request("GET", `/api/v1/automations/${id}`), 404);
    await fails(sam.request("PATCH", `/api/v1/automations/${id}`, { expectedVersion: 1, name: "x" }), 404);
    await fails(sam.request("POST", `/api/v1/automations/${id}/pause`), 404);
    await fails(sam.request("POST", `/api/v1/automations/${id}/resume`), 404);
    await fails(sam.request("POST", `/api/v1/automations/${id}/run`), 404);
    await fails(sam.request("GET", `/api/v1/automations/${id}/runs`), 404);
    await fails(sam.request("DELETE", `/api/v1/automations/${id}`), 404);
    await fails(eve.request("DELETE", `/api/v1/automations/${id}`), 404);
  });

  it("Víctor's edits check the version; a new schedule recomputes the next run, a rename keeps it", async () => {
    const current = await ok(victor.request("GET", `/api/v1/automations/${id}`));
    await fails(
      victor.request("PATCH", `/api/v1/automations/${id}`, { expectedVersion: 1, name: "Stale" }),
      409,
      "version",
    );
    const rescheduled = (
      await ok(
        victor.request("PATCH", `/api/v1/automations/${id}`, {
          expectedVersion: current.version,
          trigger: { kind: "schedule", schedule: { cron: "0 9 * * 1", timeZone: "Australia/Sydney" } },
        }),
      )
    ).automation as Json;
    expect(rescheduled.version).toBe(current.version + 1);
    expect(rescheduled.nextRunAt).not.toBe(current.nextRunAt);
    expect(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Australia/Sydney",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(rescheduled.nextRunAt)),
    ).toBe("Mon 09:00");
    const renamed = (
      await ok(
        victor.request("PATCH", `/api/v1/automations/${id}`, {
          expectedVersion: rescheduled.version,
          name: "Pipeline review (APAC)",
        }),
      )
    ).automation as Json;
    expect(renamed.nextRunAt).toBe(rescheduled.nextRunAt);
    const updates = await audits("automation.updated", id);
    expect(updates.map((u) => u.metadata.changed)).toEqual([["trigger"], ["name"]]);
    expect(JSON.stringify(updates)).not.toMatch(/APAC|Pipeline/);
    await fails(
      victor.request("PATCH", `/api/v1/automations/${id}`, {
        expectedVersion: renamed.version,
        target: { kind: "channel", conversationId: ops },
      }),
      400,
      "agent_not_member",
    );
  });

  it("Run now queues a manual run and exactly one ids-only automation.fire job in the same transaction", async () => {
    const { runId } = await ok(victor.request("POST", `/api/v1/automations/${id}/run`), 202);
    const run = (await su.query("select * from app.automation_runs where id = $1", [runId])).rows[0];
    expect(run).toMatchObject({
      automation_id: id,
      trigger: "manual",
      status: "queued",
      scheduled_for: null,
    });
    const jobs = (
      await su.query("select data from pgboss.job where name = 'automation.fire' and data->>'runId' = $1", [
        runId,
      ])
    ).rows;
    expect(jobs.map((j) => j.data)).toEqual([{ organizationId: orgA, runId }]);
    const [audit] = await audits("automation.run_started", id);
    expect(audit!.metadata).toEqual({ automationId: id, runId, trigger: "manual" });
    const runEvents = (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'automation_run.updated'",
        [`user:${victorId}`],
      )
    ).rows.map((r) => r.payload);
    expect(runEvents).toContainEqual({ automationId: id, runId });
  });

  it("lists runs newest first, 30 a page with a cursor; at the daily budget Run now records a skipped run", async () => {
    for (let i = 1; i <= 31; i++) {
      await su.query(
        `insert into app.automation_runs (organization_id, automation_id, trigger, status, created_at)
         values ($1, $2, 'manual', 'answered', now() - make_interval(secs => $3))`,
        [orgA, id, i],
      );
    }
    const first = await ok(victor.request("GET", `/api/v1/automations/${id}/runs`));
    expect(first.runs).toHaveLength(30);
    const times = (first.runs as Json[]).map((r) => Date.parse(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(first.runs[0].status).toBe("queued");
    expect(first.nextCursor).toBe(first.runs[29].id);
    const second = await ok(
      victor.request("GET", `/api/v1/automations/${id}/runs?before=${first.nextCursor}`),
    );
    expect(second.runs).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const managerView = await ok(ana.request("GET", `/api/v1/automations/${id}/runs`));
    expect(managerView.runs).toHaveLength(30);
    await fails(eve.request("GET", `/api/v1/automations/${id}/runs`), 404);

    const jobsBefore = Number(
      (await su.query("select count(*) from pgboss.job where name = 'automation.fire'")).rows[0].count,
    );
    const { runId } = await ok(victor.request("POST", `/api/v1/automations/${id}/run`), 202);
    expect(
      (await su.query("select status, reason from app.automation_runs where id = $1", [runId])).rows,
    ).toEqual([{ status: "skipped", reason: "runs_per_day" }]);
    expect(
      Number(
        (await su.query("select count(*) from pgboss.job where name = 'automation.fire'")).rows[0].count,
      ),
    ).toBe(jobsBefore);
  });

  it("Ana deletes it: 204, audited as her with whose it was, announced to Víctor, gone with its runs", async () => {
    const res = await ana.request("DELETE", `/api/v1/automations/${id}`);
    expect(res.status).toBe(204);
    const [audit] = await audits("automation.deleted", id);
    expect(audit!.user_id).toBe(anaId);
    expect(audit!.metadata).toMatchObject({
      automationId: id,
      runAsUserId: victorId,
      triggerKind: "schedule",
    });
    await fails(victor.request("GET", `/api/v1/automations/${id}`), 404);
    expect(
      Number(
        (await su.query("select count(*) from app.automation_runs where automation_id = $1", [id])).rows[0]
          .count,
      ),
    ).toBe(0);
    expect((await userEvents(victorId, id)).length).toBeGreaterThanOrEqual(5);
  });
});

describe("targets are decided for the creator and the bot (Task 4, P-08)", () => {
  it("refuses a bot outside the target, a target the creator can't post in and a disabled bot", async () => {
    await fails(
      victor.request(
        "POST",
        "/api/v1/automations",
        weekly({ target: { kind: "channel", conversationId: ops } }),
      ),
      400,
      "agent_not_member",
    );
    await fails(
      victor.request(
        "POST",
        "/api/v1/automations",
        weekly({ target: { kind: "channel", conversationId: announcements } }),
      ),
      400,
      "target_not_postable",
    );
    await fails(
      victor.request("POST", "/api/v1/automations", weekly({ agentId: oldBotId })),
      400,
      "agent_unavailable",
    );
    // Someone else's personal bot reads exactly like an unavailable one.
    await fails(
      sam.request("POST", "/api/v1/automations", weekly({ agentId: personalBotId, target: { kind: "dm" } })),
      400,
      "agent_unavailable",
    );
  });

  it("a personal bot delivers only to its owner's DM", async () => {
    await fails(
      victor.request("POST", "/api/v1/automations", weekly({ agentId: personalBotId })),
      400,
      "personal_bot_target",
    );
    const dm = await ok(
      victor.request(
        "POST",
        "/api/v1/automations",
        weekly({ name: "Morning plan", agentId: personalBotId, target: { kind: "dm" } }),
      ),
      201,
    );
    expect(dm.automation.target.kind).toBe("dm");
    expect(dm.automation.target.label).toMatch(/^Your DM with /);
    expect(dm.automation.agent.personal).toBe(true);
  });

  it("a board target needs a column of that board; a targeted column can't be deleted (409)", async () => {
    await fails(
      victor.request(
        "POST",
        "/api/v1/automations",
        weekly({ target: { kind: "board", conversationId: orders, columnId: intakeColumn } }),
      ),
      400,
      "target_not_postable",
    );
    await fails(
      victor.request(
        "POST",
        "/api/v1/automations",
        weekly({ target: { kind: "channel", conversationId: orders } }),
      ),
      400,
      "target_not_postable",
    );
    const board = await ok(
      victor.request(
        "POST",
        "/api/v1/automations",
        weekly({
          name: "Order intake",
          target: { kind: "board", conversationId: orders, columnId: ordersColumn },
        }),
      ),
      201,
    );
    expect(board.automation.target).toMatchObject({
      kind: "board",
      conversationId: orders,
      columnId: ordersColumn,
    });
    expect(board.automation.target.label).toMatch(/^orders board · /);
    await fails(
      ana.request("DELETE", `/api/v1/boards/${orders}/columns/${ordersColumn}`),
      409,
      "board_column_has_automations",
    );
  });

  it("a column an automation is moved to while it is being deleted is still 409, never a 500 (07.6 review A HI-03)", async () => {
    await ok(
      ana.request("POST", `/api/v1/boards/${orders}/columns`, { name: "Racing", category: "started" }),
    );
    const racing = ((await ok(ana.request("GET", `/api/v1/boards/${orders}`))).columns as Json[]).find(
      (c) => c.name === "Racing",
    )?.id as string;
    const made = await ok(
      victor.request(
        "POST",
        "/api/v1/automations",
        weekly({
          name: "Racing intake",
          target: { kind: "board", conversationId: orders, columnId: ordersColumn },
        }),
      ),
      201,
    );
    // Another session points the automation at the column and has not committed yet (it holds the column's key).
    const other = new pg.Client({ connectionString: stack.db.superuserUrl });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("update app.automations set board_column_id = $2 where id = $1", [
        made.automation.id,
        racing,
      ]);
      const deleting = ana.request("DELETE", `/api/v1/boards/${orders}/columns/${racing}`);
      // The delete is waiting on that session's lock before the other one commits.
      await vi.waitFor(
        async () => {
          const waiting = await su.query(
            "select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
          );
          expect(waiting.rowCount).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 50 },
      );
      await other.query("commit");
      await fails(deleting, 409, "board_column_has_automations");
    } finally {
      await other.end();
    }
    await ok(victor.request("DELETE", `/api/v1/automations/${made.automation.id}`), 204);
    await ok(ana.request("DELETE", `/api/v1/boards/${orders}/columns/${racing}`));
  });

  it("saving an automation into a column that is deleted meanwhile is 400 target_not_postable, never a 500 (HI-03)", async () => {
    await ok(
      ana.request("POST", `/api/v1/boards/${orders}/columns`, { name: "Leaving", category: "started" }),
    );
    const leaving = ((await ok(ana.request("GET", `/api/v1/boards/${orders}`))).columns as Json[]).find(
      (c) => c.name === "Leaving",
    )?.id as string;
    const other = new pg.Client({ connectionString: stack.db.superuserUrl });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("delete from app.board_columns where id = $1", [leaving]);
      const saving = victor.request(
        "POST",
        "/api/v1/automations",
        weekly({ name: "Too late", target: { kind: "board", conversationId: orders, columnId: leaving } }),
      );
      await vi.waitFor(
        async () => {
          const waiting = await su.query(
            "select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
          );
          expect(waiting.rowCount).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 50 },
      );
      await other.query("commit");
      await fails(saving, 400, "target_not_postable");
    } finally {
      await other.end();
    }
  });

  it("target options list the bot's places with the reason a place can't be picked, boards with columns", async () => {
    const opts = await ok(victor.request("GET", `/api/v1/automations/target-options?agentId=${scoutId}`));
    const byId = new Map((opts.conversations as Json[]).map((c) => [c.conversationId, c]));
    expect(byId.get(sales)).toMatchObject({
      name: "sales",
      layout: "text",
      disabledReason: null,
      columns: [],
    });
    expect(byId.get(ops)?.disabledReason).toBe("agent_not_member");
    expect(byId.get(announcements)?.disabledReason).toBe("target_not_postable");
    expect(byId.get(orders)?.layout).toBe("board");
    expect(byId.get(orders)?.disabledReason).toBeNull();
    expect(((byId.get(orders)?.columns ?? []) as Json[]).map((c) => c.id)).toContain(ordersColumn);
    expect(
      (await ok(victor.request("GET", `/api/v1/automations/target-options?agentId=${personalBotId}`)))
        .conversations,
    ).toEqual([]);
    await fails(sam.request("GET", `/api/v1/automations/target-options?agentId=${personalBotId}`), 404);
  });
});

describe("caps and webhook rights (Task 4, P-09)", () => {
  it("refuses a webhook trigger without automation.webhook and runs per day above the workspace cap", async () => {
    await fails(
      sam.request("POST", "/api/v1/automations", {
        ...weekly({ target: { kind: "dm" } }),
        trigger: { kind: "webhook" },
        inbound: { action: "post", askBot: true, config: {} },
      }),
      403,
      "webhook_not_allowed",
    );
    // Phase 07.17 (D-11): the default cap is 288 a day; an organization whose admin chose 96 still caps at 96.
    await su.query(
      "insert into app.bot_policies (organization_id, max_runs_per_day_cap) values ($1, 96) on conflict (organization_id) do update set max_runs_per_day_cap = 96",
      [orgA],
    );
    try {
      const tooMany = await fails(
        sam.request("POST", "/api/v1/automations", weekly({ target: { kind: "dm" }, maxRunsPerDay: 97 })),
        400,
      );
      expect(tooMany.error.details).toEqual({ max: 96 });
    } finally {
      await su.query("update app.bot_policies set max_runs_per_day_cap = 288 where organization_id = $1", [
        orgA,
      ]);
    }
  });

  it("the 11th automation of one person is refused with 409 automation_cap", async () => {
    for (let i = 1; i <= 10; i++) {
      await ok(
        sam.request("POST", "/api/v1/automations", weekly({ name: `Sam ${i}`, target: { kind: "dm" } })),
        201,
      );
    }
    await fails(
      sam.request("POST", "/api/v1/automations", weekly({ name: "Sam 11", target: { kind: "dm" } })),
      409,
      "automation_cap",
    );
    expect((await ok(sam.request("GET", "/api/v1/automations"))).usage).toEqual({ used: 10, max: 10 });
  });

  it("options tell who may create and add webhooks, with the caps and the usable bots", async () => {
    const samOpts = await ok(sam.request("GET", "/api/v1/automations/options"));
    expect(samOpts.canCreate).toBe(true);
    expect(samOpts.canWebhook).toBe(false);
    expect(samOpts.caps).toEqual({
      maxAutomationsPerUser: 10,
      used: 10,
      minScheduleMinutes: 5,
      maxInboundPerHour: 30,
      maxRunsPerDayCap: 288,
    });
    const samBots = new Map((samOpts.bots as Json[]).map((b) => [b.id, b]));
    expect(samBots.get(scoutId)).toEqual({
      id: scoutId,
      displayName: "Scout",
      personal: false,
      unitName: null,
      ready: true,
    });
    expect(samBots.has(oldBotId)).toBe(false);
    expect(samBots.has(personalBotId)).toBe(false);
    expect(samOpts.botDailyLimit[scoutId]).toBe(100);

    expect((await ok(marta.request("GET", "/api/v1/automations/options"))).canWebhook).toBe(true);
    const victorBots = (await ok(victor.request("GET", "/api/v1/automations/options"))).bots as Json[];
    expect(victorBots.find((b) => b.id === personalBotId)?.personal).toBe(true);
  });
});
