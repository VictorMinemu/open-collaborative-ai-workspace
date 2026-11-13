import { randomUUID } from "node:crypto";
import type { SandboxdEventsResponse } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import type { SandboxdClient } from "./client";
import { createSandboxEventsConsumer, type SandboxEventsConsumer } from "./events";

/**
 * 07.8-11 Task 3 (SBX-01; D-01, D-09; T-07.8-11-05): the API's reader of sandboxd's event feed. One API process at a
 * time consumes (advisory lock); every event is applied to its organization at most once, guarded by the durable
 * `sandbox_event_cursor` row the same transaction advances, so a replay after an API restart never double-counts CPU
 * or repeats an audit. Then the caps the mirrored usage drives (daily CPU, total disk), the orphan `starting` slot and
 * the purge of a deleted bot's sandbox.
 */

let s: SandboxStack;
const consumers: SandboxEventsConsumer[] = [];
/** Not the app's key: these tests drive their own consumers (the app starts none under NODE_ENV=test). */
const KEY = 0x7e57_0711;
const MiB = 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);

function consumer(client?: SandboxdClient, lockKey = KEY, waitMs = 0): SandboxEventsConsumer {
  const c = createSandboxEventsConsumer(s.stack.built.core, {
    client: client ?? (s.stack.built.sandbox.client as SandboxdClient),
    lockKey,
    waitMs,
  });
  consumers.push(c);
  return c;
}

const target = (agentId: string, orgId = s.orgA) => ({ orgId, agentId });
const emit = (e: Json): number => s.sandboxd.fake.emit(e);
const usage = (agentId: string, cpuMs: number, diskBytes = 0) =>
  emit({ type: "usage", target: target(agentId), cpuMs, diskBytes });

async function cpuOf(agentId: string, day = today()): Promise<number> {
  const { rows } = await s.su.query(
    "select cpu_ms::int as ms from app.sandbox_usage_daily where agent_id = $1 and day = $2",
    [agentId, day],
  );
  return rows[0]?.ms ?? 0;
}

async function cursorOf(orgId = s.orgA): Promise<{ boot_id: string; seq: number } | undefined> {
  const { rows } = await s.su.query(
    "select boot_id, seq::int as seq from app.sandbox_event_cursor where organization_id = $1",
    [orgId],
  );
  return rows[0];
}

async function boxOf(agentId: string, kind = "sbx"): Promise<Json | undefined> {
  const { rows } = await s.su.query(
    "select state, stop_reason, disk_bytes::bigint::text as disk from app.bot_sandboxes where agent_id = $1 and kind = $2",
    [agentId, kind],
  );
  return rows[0];
}

const audits = async (action: string, agentId: string) =>
  (
    await s.su.query(
      "select actor_kind, actor_id, user_id, result, metadata from app.audit_events where action = $1 and agent_id = $2 order by occurred_at",
      [action, agentId],
    )
  ).rows as Json[];

async function execOf(bot: { id: string; dm: string }): Promise<Res> {
  const ev = await s.turnOf(s.sam, bot.dm, bot.id);
  return s.cell("/sandbox/exec", { eventId: ev.eventId, agentId: bot.id, argv: ["true"] });
}

async function until(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met in time");
}

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
}, 240_000);

// A failed test never leaves a consumer holding the lock for the next one.
afterEach(async () => {
  for (const c of consumers.splice(0)) await c.stop().catch(() => {});
});

afterAll(async () => {
  try {
    for (const c of consumers) await c.stop().catch(() => {});
  } finally {
    await s?.stop();
  }
});

describe("one consumer per database (advisory lock)", () => {
  it("two API processes: exactly one holds the lock; the other takes over once it is released", async () => {
    const a = consumer();
    const b = consumer();
    expect((await a.runOnce()).locked).toBe(true);
    expect((await b.runOnce()).locked).toBe(false);
    expect([a.holdsLock(), b.holdsLock()]).toEqual([true, false]);
    await a.stop();
    expect((await b.runOnce()).locked).toBe(true);
    await b.stop();
  });

  it("started, it applies events as they come; stopped, it ends its long poll at once", async () => {
    const bot = await s.newBot("Loop Bot");
    const c = consumer(undefined, KEY, 20_000);
    c.start();
    usage(bot.id, 25);
    await until(async () => (await cpuOf(bot.id)) === 25);
    const t0 = Date.now();
    await c.stop();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(c.holdsLock()).toBe(false);
  });
});

describe("events mirror sandboxd's state and usage", () => {
  it("state: disk_full, idle and a crash are mirrored and audited with their reasons; user and kill are not re-audited", async () => {
    const bot = await s.newBot("State Bot");
    const c = consumer();
    await c.runOnce();
    emit({ type: "state", target: target(bot.id), kind: "sbx", state: "disk_full", reason: "disk_full" });
    await c.runOnce();
    expect(await boxOf(bot.id)).toMatchObject({ state: "disk_full", stop_reason: "disk_full" });
    emit({ type: "state", target: target(bot.id), kind: "sbx", state: "stopped", reason: "idle" });
    await c.runOnce();
    expect(await boxOf(bot.id)).toMatchObject({ state: "stopped", stop_reason: "idle" });
    // A stop sandboxd did not ask for: the container crashed.
    emit({ type: "state", target: target(bot.id), kind: "sbx", state: "stopped", reason: null });
    await c.runOnce();
    expect(await boxOf(bot.id)).toMatchObject({ state: "stopped", stop_reason: null });
    emit({ type: "state", target: target(bot.id), kind: "sbx", state: "stopped", reason: "user" });
    emit({ type: "state", target: target(bot.id), kind: "sbx", state: "killed", reason: "kill_switch" });
    emit({ type: "state", target: target(bot.id), kind: "sbx", state: "running", reason: null });
    await c.runOnce();
    expect(await boxOf(bot.id)).toMatchObject({ state: "running", stop_reason: null });
    const rows = await audits("sandbox.stopped", bot.id);
    expect(rows.map((r) => r.metadata)).toEqual([
      { kind: "sbx", reason: "disk_full" },
      { kind: "sbx", reason: "idle" },
      { kind: "sbx", reason: "crashed" },
    ]);
    expect(rows[0]).toMatchObject({ actor_kind: "system", user_id: null });
    await c.stop();
  });

  it("usage: CPU adds to today's row, disk updates the mirror", async () => {
    const bot = await s.newBot("Usage Bot");
    const c = consumer();
    usage(bot.id, 1500, 4096);
    usage(bot.id, 500, 8192);
    await c.runOnce();
    expect(await cpuOf(bot.id)).toBe(2000);
    expect((await boxOf(bot.id))?.disk).toBe("8192");
    await c.stop();
  });

  it("egress: one audit per (bot, host, allowed) per hour, with the host only", async () => {
    const bot = await s.newBot("Egress Bot");
    const c = consumer();
    for (const allowed of [true, true, false, true]) {
      emit({ type: "egress", target: target(bot.id), kind: "sbx", host: "api.example.com", allowed });
    }
    emit({ type: "egress", target: target(bot.id), kind: "sbx", host: "other.example.com", allowed: true });
    await c.runOnce();
    const rows = await audits("sandbox.egress", bot.id);
    expect(rows.map((r) => [r.metadata, r.result])).toEqual([
      [{ kind: "sbx", host: "api.example.com", allowed: true }, "success"],
      [{ kind: "sbx", host: "api.example.com", allowed: false }, "denied"],
      [{ kind: "sbx", host: "other.example.com", allowed: true }, "success"],
    ]);
    expect(rows[0]).toMatchObject({ actor_kind: "agent", actor_id: bot.id, user_id: null });
    await c.stop();
  });

  it("browser events go to the handlers other modules register, inside the transaction, never twice", async () => {
    const bot = await s.newBot("Browser Bot");
    const seen: string[] = [];
    const handler = async (_tx: unknown, e: Json) => {
      seen.push(`${e.event}:${e.host}`);
    };
    const c1 = consumer();
    c1.onEvent("browser", handler);
    emit({
      type: "browser",
      target: target(bot.id),
      contextId: randomUUID(),
      event: "navigated",
      host: "example.com",
    });
    await c1.runOnce();
    expect(seen).toEqual(["navigated:example.com"]);
    await c1.stop();
    const c2 = consumer();
    c2.onEvent("browser", handler);
    await c2.runOnce();
    expect(seen).toEqual(["navigated:example.com"]);
    await c2.stop();
  });
});

describe("replay after an API restart never double-counts (T-07.8-11-05)", () => {
  it("consumer 2 re-reads the same boot from seq 0: CPU, cursor and audits stay; seq 4 is applied once", async () => {
    const bot = await s.newBot("Replay Bot");
    const c1 = consumer();
    await c1.runOnce();
    usage(bot.id, 100);
    usage(bot.id, 100);
    emit({ type: "egress", target: target(bot.id), kind: "sbx", host: "replay.example.com", allowed: true });
    const third = usage(bot.id, 100);
    const first = await c1.runOnce();
    expect(first.applied).toBe(4);
    expect(await cpuOf(bot.id)).toBe(300);
    expect((await cursorOf())?.seq).toBe(third);
    await c1.stop();

    // A fresh process: no memory of consumer 1, it starts at seq 0 of the same boot.
    const c2 = consumer();
    const replay = await c2.runOnce();
    expect(replay.applied).toBe(0);
    expect(replay.skipped).toBeGreaterThanOrEqual(4);
    expect(await cpuOf(bot.id)).toBe(300);
    expect((await cursorOf())?.seq).toBe(third);
    expect(await audits("sandbox.egress", bot.id)).toHaveLength(1);

    const fourth = usage(bot.id, 50);
    expect((await c2.runOnce()).applied).toBe(1);
    expect(await c2.runOnce()).toMatchObject({ applied: 0 });
    expect(await cpuOf(bot.id)).toBe(350);
    expect((await cursorOf())?.seq).toBe(fourth);
    await c2.stop();
  });

  it("a new sandboxd boot is read from its first event; the cursor moves to it and the policy is pushed again", async () => {
    const bot = await s.newBot("Boot Bot");
    const c = consumer();
    usage(bot.id, 1);
    await c.runOnce();
    const before = await cursorOf();
    expect(before).toBeDefined();
    s.sandboxd.fake.reset();
    expect(s.sandboxd.fake.policyOf(s.orgA)).toBeNull();
    const seq = usage(bot.id, 10);
    expect(seq).toBe(1);
    expect((await c.runOnce()).applied).toBe(1);
    expect(await cpuOf(bot.id)).toBe(11);
    const after = await cursorOf();
    expect(after?.boot_id).not.toBe(before?.boot_id);
    expect(after?.seq).toBe(1);
    expect(s.sandboxd.fake.policyOf(s.orgA)).toEqual({ killed: false });
    await c.stop();
  });

  it("an old boot's events, replayed after a new boot, are skipped", async () => {
    const bee = (
      await ok(
        s.eve.request("POST", "/api/v1/agents", {
          name: "Bee",
          username: "bee",
          instructions: "You are Bee.",
          modelProvider: "mock",
          modelId: "mock-1",
        }) as Promise<Res>,
      )
    ).id as string;
    const A = randomUUID();
    const B = randomUUID();
    const ev = (seq: number, cpuMs: number) => ({
      type: "usage" as const,
      seq,
      at: new Date().toISOString(),
      target: { orgId: s.orgB, agentId: bee },
      cpuMs,
      diskBytes: 0,
    });
    const script: SandboxdEventsResponse[] = [
      { bootId: A, events: [ev(1, 5)], nextSeq: 1 },
      { bootId: B, events: [ev(1, 7)], nextSeq: 1 },
      { bootId: A, events: [ev(2, 999)], nextSeq: 2 },
    ];
    // The consumer reads the feed's raw body (`stream`) and parses each event on its own (07.17.1.1.2-11, E25).
    const stub = {
      async call(op: string) {
        if (op === "policy") return { ok: true };
        throw new Error(`unexpected ${op}`);
      },
      async stream(op: string) {
        if (op !== "events") throw new Error(`unexpected stream ${op}`);
        return new Response(JSON.stringify(script.shift() ?? { bootId: B, events: [], nextSeq: 1 })).body;
      },
    } as unknown as SandboxdClient;
    const c = consumer(stub, KEY + 1);
    for (let i = 0; i < 3; i++) await c.runOnce();
    expect(await cpuOf(bee)).toBe(12);
    expect(await cursorOf(s.orgB)).toEqual({ boot_id: B, seq: 1 });
    await c.stop();
  });

  it("an event for a bot outside its organization changes nothing and does not stop the feed", async () => {
    const bot = await s.newBot("Mixed Bot");
    const c = consumer();
    await c.runOnce();
    // Organization B's target naming organization A's bot: the id does not resolve in B's tenant.
    emit({ type: "usage", target: { orgId: s.orgB, agentId: bot.id }, cpuMs: 777, diskBytes: 0 });
    usage(bot.id, 3);
    await c.runOnce();
    expect(await cpuOf(bot.id)).toBe(3);
    await c.stop();
  });
});

describe("the organization's daily CPU and total disk (D-09 limits)", () => {
  it("at the daily CPU cap a new bot and a running bot get cpu_budget (no ensure); the next UTC day they run", async () => {
    const busy = await s.newBot("Busy Bot");
    expect((await execOf(busy)).status).toBe(200);
    const fresh = await s.newBot("Fresh Bot");
    await s.su.query("update app.sandbox_policies set cpu_minutes_per_day = 10 where organization_id = $1", [
      s.orgA,
    ]);
    await s.su.query(
      "insert into app.sandbox_usage_daily (organization_id, agent_id, day, cpu_ms) values ($1, $2, $3, 600000)",
      [s.orgA, busy.id, today()],
    );
    try {
      const ensureBefore = s.sandboxd.stats().calls.ensure ?? 0;
      for (const bot of [fresh, busy]) {
        const r = await execOf(bot);
        expect(r.status, bot.id).toBe(403);
        expect(codeOf(r)).toBe("cpu_budget");
      }
      expect(s.sandboxd.stats().calls.ensure ?? 0).toBe(ensureBefore);
      // Yesterday's minutes do not count today.
      await s.su.query(
        "update app.sandbox_usage_daily set day = (current_date - 1) where agent_id = $1 and day = $2",
        [busy.id, today()],
      );
      expect((await execOf(fresh)).status).toBe(200);
      expect((await execOf(busy)).status).toBe(200);
    } finally {
      await s.su.query(
        "update app.sandbox_policies set cpu_minutes_per_day = 600 where organization_id = $1",
        [s.orgA],
      );
      await s.su.query("delete from app.sandbox_usage_daily where agent_id = $1", [busy.id]);
    }
  });

  it("at the organization's total disk a new bot gets disk_full; a running bot keeps working", async () => {
    const running = await s.newBot("Disk Bot");
    expect((await execOf(running)).status).toBe(200);
    const next = await s.newBot("Next Bot");
    await s.su.query("update app.sandbox_policies set disk_total_mb = 64 where organization_id = $1", [
      s.orgA,
    ]);
    await s.su.query("update app.bot_sandboxes set disk_bytes = $2 where agent_id = $1 and kind = 'sbx'", [
      running.id,
      64 * MiB,
    ]);
    try {
      const r = await execOf(next);
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe("disk_full");
      expect((await execOf(running)).status).toBe(200);
    } finally {
      await s.su.query("update app.sandbox_policies set disk_total_mb = 51200 where organization_id = $1", [
        s.orgA,
      ]);
      await s.su.query("update app.bot_sandboxes set disk_bytes = 0 where agent_id = $1", [running.id]);
    }
  });

  it("an orphan `starting` row (the API died before recording the outcome) stops holding a slot after 5 minutes", async () => {
    await s.su.query("update app.bot_sandboxes set state = 'stopped' where organization_id = $1", [s.orgA]);
    await s.setPolicy({ maxSandboxes: 1 });
    const orphan = await s.newBot("Orphan Bot");
    const first = await s.newBot("First Bot");
    const second = await s.newBot("Second Bot");
    try {
      await s.su.query(
        `insert into app.bot_sandboxes (organization_id, agent_id, kind, state, updated_at)
         values ($1, $2, 'sbx', 'starting', now() - interval '10 minutes')`,
        [s.orgA, orphan.id],
      );
      expect((await execOf(first)).status).toBe(200);
      expect(await boxOf(orphan.id)).toMatchObject({ state: "unavailable", stop_reason: null });
      // A fresh reservation still holds its slot.
      await s.su.query("update app.bot_sandboxes set state = 'stopped' where agent_id = $1", [first.id]);
      await s.su.query(
        "update app.bot_sandboxes set state = 'starting', updated_at = now() where agent_id = $1",
        [orphan.id],
      );
      const r = await execOf(second);
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe("cap_reached");
    } finally {
      await s.setPolicy({ maxSandboxes: 10 });
      await s.su.query("update app.bot_sandboxes set state = 'stopped' where agent_id = $1", [orphan.id]);
    }
  });
});

describe("deleting a bot purges its sandbox after the commit (D-01, R11)", () => {
  it("purged after the commit; its rows are gone", async () => {
    const bot = await s.newBot("Doomed Bot");
    expect((await execOf(bot)).status).toBe(200);
    const before = s.sandboxd.stats().calls.purge ?? 0;
    await ok(s.victor.request("DELETE", `/api/v1/agents/${bot.id}`) as Promise<Res>);
    await until(() => (s.sandboxd.stats().calls.purge ?? 0) === before + 1);
    expect(s.sandboxd.fake.stateOf(target(bot.id))).toBe("absent");
    await until(async () => (await boxOf(bot.id)) === undefined);
  });

  it("a failed purge is logged with ids, kept pending (absent, user) and retried by the next consumer pass", async () => {
    const bot = await s.newBot("Stubborn Bot");
    expect((await execOf(bot)).status).toBe(200);
    s.sandboxd.fake.setDown(true);
    try {
      await ok(s.victor.request("DELETE", `/api/v1/agents/${bot.id}`) as Promise<Res>);
      expect(await boxOf(bot.id)).toMatchObject({ state: "absent", stop_reason: "user" });
      await until(() => s.logs.some((l) => l.includes(bot.id) && l.includes("purge")));
    } finally {
      s.sandboxd.fake.setDown(false);
    }
    const line = s.logs.find((l) => l.includes(bot.id) && l.includes("purge")) ?? "";
    expect(line).not.toMatch(/ocw-(sbx|ws|brw)-|\/var\/lib/);
    const c = consumer();
    const before = s.sandboxd.stats().calls.purge ?? 0;
    usage(s.scoutId, 1);
    await c.runOnce();
    expect(s.sandboxd.stats().calls.purge ?? 0).toBe(before + 1);
    expect(await boxOf(bot.id)).toBeUndefined();
    await c.stop();
  });
});

describe("a sandboxd restart forgets every policy: the API fails closed and pushes them again (07.8 policy fix)", () => {
  const policyCalls = (orgId: string) => s.sandboxd.stats().orgs[orgId]?.policy ?? 0;
  const calls = (op: string, orgId: string) => s.sandboxd.stats().orgs[orgId]?.[op] ?? 0;

  it("a killed organization's exec is still refused after the restart, and nothing starts, even through the client", async () => {
    const bot = await s.newBot("Killed Restart Bot");
    expect((await execOf(bot)).status).toBe(200);
    await ok(s.victor.request("POST", "/api/v1/sandbox/kill") as Promise<Res>);
    try {
      expect(s.sandboxd.fake.policyOf(s.orgA)).toEqual({ killed: true });
      s.sandboxd.fake.reboot();
      expect(s.sandboxd.fake.policyOf(s.orgA)).toBeNull();
      const stopped = s.sandboxd.fake.stateOf(target(bot.id));
      expect(stopped).toBe("killed");

      // The bot's own call: the API refuses before sandboxd (the kill switch in the database).
      const ensures = calls("ensure", s.orgA);
      const execs = calls("exec", s.orgA);
      const r = await execOf(bot);
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe("killed");
      expect([calls("ensure", s.orgA), calls("exec", s.orgA)]).toEqual([ensures, execs]);

      // Any call that does reach sandboxd: policy_missing → the client pushes the current policy (killed) and retries
      // once → still killed; the bot's sandbox never runs.
      const client = s.stack.built.sandbox.client as SandboxdClient;
      const err = await client.call("ensure", { target: target(bot.id) }).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "SandboxdRefusedError", code: "killed" });
      expect(s.sandboxd.fake.policyOf(s.orgA)).toEqual({ killed: true });
      expect(s.sandboxd.fake.stateOf(target(bot.id))).toBe("killed");
      expect(calls("ensure", s.orgA)).toBe(ensures + 2);
    } finally {
      await ok(s.victor.request("POST", "/api/v1/sandbox/resume") as Promise<Res>);
    }
  });

  it("a live organization's exec succeeds after one transparent re-push", async () => {
    const bot = await s.newBot("Live Restart Bot");
    expect((await execOf(bot)).status).toBe(200);
    s.sandboxd.fake.reboot();
    expect(s.sandboxd.fake.policyOf(s.orgA)).toBeNull();
    const pushes = policyCalls(s.orgA);
    const r = await execOf(bot);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "exited", exitCode: 0 });
    expect(policyCalls(s.orgA)).toBe(pushes + 1);
    expect(s.sandboxd.fake.policyOf(s.orgA)).toEqual({ killed: false });
    expect(s.sandboxd.fake.stateOf(target(bot.id))).toBe("running");
  });

  it("the consumer pushes every organization with sandboxes on a new boot id, even one with no event since", async () => {
    // Organization B has a sandbox row (it ran before) and sends no event after the restart.
    const bee = (
      await ok(
        s.eve.request("POST", "/api/v1/agents", {
          name: "Quiet Bee",
          username: "quietbee",
          instructions: "You are Quiet Bee.",
          modelProvider: "mock",
          modelId: "mock-1",
        }) as Promise<Res>,
      )
    ).id as string;
    await s.su.query(
      "insert into app.bot_sandboxes (organization_id, agent_id, kind, state) values ($1, $2, 'sbx', 'stopped')",
      [s.orgB, bee],
    );
    const c = consumer();
    await c.runOnce();
    s.sandboxd.fake.reboot();
    expect([s.sandboxd.fake.policyOf(s.orgA), s.sandboxd.fake.policyOf(s.orgB)]).toEqual([null, null]);
    const r = await c.runOnce();
    expect(r.applied).toBe(0);
    expect(s.sandboxd.fake.policyOf(s.orgB)).toEqual({ killed: false });
    expect(s.sandboxd.fake.policyOf(s.orgA)).toEqual({ killed: false });
    // The same boot again pushes nothing more.
    const pushes = policyCalls(s.orgB);
    await c.runOnce();
    expect(policyCalls(s.orgB)).toBe(pushes);
    await c.stop();
  });

  it("app.sandbox_organizations returns organization ids only, is not executable by PUBLIC and is by ocw_app", async () => {
    const res = await s.su.query("select * from app.sandbox_organizations(null, 10)");
    expect(res.fields.map((f) => f.name)).toEqual(["organization_id"]);
    expect(res.rows.map((r) => r.organization_id)).toEqual(expect.arrayContaining([s.orgA, s.orgB]));
    const priv = (
      await s.su.query(
        `select has_function_privilege('public', 'app.sandbox_organizations(uuid, integer)', 'execute') as pub,
                has_function_privilege('ocw_app', 'app.sandbox_organizations(uuid, integer)', 'execute') as app,
                p.prosecdef as definer
           from pg_proc p where p.oid = 'app.sandbox_organizations(uuid, integer)'::regprocedure`,
      )
    ).rows[0];
    expect(priv).toEqual({ pub: false, app: true, definer: true });
  });
});
