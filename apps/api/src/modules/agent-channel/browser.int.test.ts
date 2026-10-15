import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { createSandboxEventsConsumer, type SandboxdClient } from "../sandbox";

/**
 * 07.8-14 (BRW-01, BRW-03, SBX-04; D-05, D-07, D-09, D-11, D-12, D-13; P-06, P-10, P-18; R2, R8, R9): the bots'
 * browser routes. A bot opens and reads a page only through the Control Plane: decided like a sandbox call (kind
 * `browser`), counted against the shared budget of 40, audited by host only, and read through the API's second pass.
 * Acting on a signed-in page needs the requester's approval every time; D-13 asks before signed-in data leaves for
 * another host. Real PostgreSQL + Redis; the in-memory sandboxd with its fake site (P-13).
 */

const LEAK = "OCW-SENTINEL-PW-5521";
const ACT = "ocw_browser_act";
const OPEN = "ocw_browser_open";
let s: SandboxStack;

const browser = (name: string, ev: Json, body: Json = {}, opts: { agentId?: string; token?: string } = {}) =>
  s.cell(
    `/browser/${name}`,
    { eventId: ev.eventId, agentId: opts.agentId ?? s.scoutId, ...body },
    opts.token,
  );

const setBotBrowser = (agentId: string, on: boolean) =>
  s.su.query(
    "update app.agents set capabilities = capabilities || jsonb_build_object('browser', $2::boolean) where id = $1",
    [agentId, on],
  );

/** A test control of the in-memory sandboxd (no token). */
async function control(path: string, body: Json = {}): Promise<void> {
  const res = await fetch(`${s.sandboxd.url}/__control${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

const turnRow = async (eventId: string) =>
  (
    await s.su.query(
      "select tainted, tool_calls, sandbox_calls, member_data from app.agent_turns where event_id = $1",
      [eventId],
    )
  ).rows[0] as Json;

const contextRow = async (id: string) =>
  (await s.su.query("select * from app.browser_contexts where id = $1", [id])).rows[0] as Json;

const auditOf = async (action: string, where: { eventId?: string; contextId?: string }) =>
  (
    await s.su.query(
      `select agent_id, user_id, result, metadata from app.audit_events
        where action = $1 and ($2::text is null or metadata->>'eventId' = $2)
          and ($3::text is null or metadata->>'contextId' = $3) order by occurred_at, id`,
      [action, where.eventId ?? null, where.contextId ?? null],
    )
  ).rows as Json[];

const stepsOf = async (eventId: string) =>
  ((await s.su.query("select steps from app.bot_turn_activity where event_id = $1", [eventId])).rows[0]
    ?.steps ?? []) as Json[];

const callsOf = async (eventId: string) =>
  (
    await s.su.query(
      "select tool, target, decision, reason, status, approval_id from app.agent_tool_calls where event_id = $1 order by created_at",
      [eventId],
    )
  ).rows as Json[];

/** A DM of `who` with a bot. */
async function dmWith(who: TestClient, agentId: string): Promise<string> {
  return (
    await ok(
      who.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: agentId }] }) as Promise<Res>,
    )
  ).id as string;
}

/** One pass of sandboxd's event feed through the app's own `browser` handler (the app's consumer is off in tests). */
async function pumpEvents(): Promise<void> {
  const consumer = createSandboxEventsConsumer(s.stack.built.core, {
    client: s.stack.built.sandbox.client as SandboxdClient,
    lockKey: 0x0b0e_1400 + Math.floor(Math.random() * 1000),
    waitMs: 0,
  });
  consumer.onEvent("browser", s.stack.built.browser.onBrowserEvent);
  try {
    await consumer.runOnce({ waitMs: 0 });
  } finally {
    await consumer.stop();
  }
}

/** Every place a value must never reach: audit, ledger, activity, the stream, the API log. */
async function leakCount(sentinel: string): Promise<number> {
  const db = await s.su.query(
    `select (select count(*) from app.bot_turn_activity where steps::text like $1)
          + (select count(*) from app.audit_events where metadata::text like $1)
          + (select count(*) from app.agent_tool_calls where coalesce(reason, '') || coalesce(target, '') like $1)
          + (select count(*) from app.stream_events where payload::text like $1)
          + (select count(*) from app.browser_contexts where host like $1) as n`,
    [`%${sentinel}%`],
  );
  return Number(db.rows[0].n) + s.logs.filter((l) => l.includes(sentinel)).length;
}

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
  await setBotBrowser(s.scoutId, true);
});

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1: the tracer

describe("a bot opens a page and reads it through the Control Plane (tracer)", () => {
  it("open: 200 with the host; one context row with its host only; browser.opened by host; tainted; an `opened` step", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    expect(ev.turn.tools).toEqual(
      expect.arrayContaining([OPEN, "ocw_browser_snapshot", ACT, "ocw_browser_wait", "ocw_browser_close"]),
    );
    expect(ev.turn.tools).not.toContain("ocw_browser_signin");
    expect(ev.turn.maxSandboxCalls).toBe(40);

    const opened = await ok(browser("open", ev, { url: "https://panel.fake.test/app?token=abc" }));
    expect(opened).toMatchObject({ host: "panel.fake.test", secure: true, signedIn: false });
    expect(opened.contextId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = (
      await s.su.query("select * from app.browser_contexts where agent_id = $1 and event_id = $2", [
        s.scoutId,
        ev.eventId,
      ])
    ).rows as Json[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: opened.contextId,
      host: "panel.fake.test",
      secure: true,
      state: "live",
      requested_for_user_id: s.samId,
      conversation_id: s.samDm,
      closed_at: null,
    });
    expect(JSON.stringify(rows)).not.toMatch(/token=abc|\/app/u);

    const audits = await auditOf("browser.opened", { eventId: ev.eventId });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ agent_id: s.scoutId, user_id: s.samId, result: "success" });
    expect(audits[0]?.metadata).toMatchObject({ host: "panel.fake.test", contextId: opened.contextId });
    expect(JSON.stringify(audits)).not.toMatch(/token=abc|\/app/u);
    const decided = await auditOf("bot.tool_call", { eventId: ev.eventId });
    expect(decided.map((a) => a.metadata.target)).toEqual(["browser"]);
    expect(JSON.stringify(decided)).not.toMatch(/token=abc|\/app/u);

    expect(await turnRow(ev.eventId)).toMatchObject({ tainted: true, sandbox_calls: 1, tool_calls: 0 });
    const steps = await stepsOf(ev.eventId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      tool: OPEN,
      verb: "opened",
      target: "panel.fake.test",
      contextId: opened.contextId,
      signedIn: false,
      outcome: { kind: "ok" },
    });
    expect(JSON.stringify(steps)).not.toMatch(/token=abc|\/app/u);
    expect(await callsOf(ev.eventId)).toEqual([
      expect.objectContaining({ tool: OPEN, target: "browser", decision: "allowed", status: "ok" }),
    ]);
  });

  it("snapshot: the redacted page with refs; the leak control's value is replaced by the second pass and recorded as an incident with ids only", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const opened = await ok(browser("open", ev, { url: "https://panel.fake.test/login" }));
    const snap = await ok(browser("snapshot", ev));
    expect(snap).toMatchObject({
      contextId: opened.contextId,
      host: "panel.fake.test",
      truncated: false,
      signedIn: false,
    });
    expect(snap.text).toContain('- [r3] textbox "Password" = [redacted]');
    expect(snap.text).toContain('- [r4] button "Sign in"');

    await control("/browser/leak");
    const leaked = await ok(browser("snapshot", ev));
    expect(leaked.text).toContain('- [r3] textbox "Password" = [redacted]');
    expect(JSON.stringify(leaked)).not.toContain(LEAK);
    const incidents = await auditOf("browser.redaction_incident", { contextId: opened.contextId });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.metadata).toEqual({ eventId: ev.eventId, contextId: opened.contextId, nodes: 1 });
    expect(s.logs.some((l) => l.includes("redacted field") && l.includes(opened.contextId))).toBe(true);
    expect(await leakCount(LEAK)).toBe(0);

    const steps = await stepsOf(ev.eventId);
    expect(steps.map((st) => [st.verb, st.target, st.outcome.kind])).toEqual([
      ["opened", "panel.fake.test", "ok"],
      ["read_page", "panel.fake.test", "ok"],
      ["read_page", "panel.fake.test", "ok"],
    ]);
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(3);
  });

  it("a second open in the turn reuses the context; another member's turn with the bot gets its own", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const first = await ok(browser("open", ev, { url: "https://panel.fake.test/a" }));
    const again = await ok(browser("open", ev, { url: "https://panel.fake.test/b" }));
    expect(again.contextId).toBe(first.contextId);

    const alexDm = await dmWith(s.alex, s.scoutId);
    const evAlex = await s.turnOf(s.alex, alexDm);
    const alexOpen = await ok(browser("open", evAlex, { url: "https://panel.fake.test/a" }));
    expect(alexOpen.contextId).not.toBe(first.contextId);
    expect((await contextRow(alexOpen.contextId)).requested_for_user_id).toBe(s.alexId);
    const open = (
      await s.su.query(
        "select requested_for_user_id, count(*)::int as n from app.browser_contexts where agent_id = $1 and closed_at is null group by 1",
        [s.scoutId],
      )
    ).rows as Json[];
    for (const r of open) expect(r.n).toBe(1);
  });

  it("a `navigated` event from sandboxd moves the context's host and is audited by host only", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const opened = await ok(browser("open", ev, { url: "https://panel.fake.test/start" }));
    s.sandboxd.fake.emit({
      type: "browser",
      target: { orgId: s.orgA, agentId: s.scoutId },
      contextId: opened.contextId,
      event: "navigated",
      host: "idp.fake.test",
    });
    await pumpEvents();
    expect((await contextRow(opened.contextId)).host).toBe("idp.fake.test");
    const nav = (await auditOf("browser.navigated", { contextId: opened.contextId })).filter(
      (a) => a.metadata.host === "idp.fake.test",
    );
    expect(nav).toHaveLength(1);
    expect(nav[0]?.metadata).toEqual({ contextId: opened.contextId, host: "idp.fake.test" });
    expect(nav[0]).toMatchObject({ agent_id: s.scoutId, user_id: s.samId });
  });

  it("snapshot without an open page is 404 no_context and not counted", async () => {
    const other = await s.newBot(`Pager ${randomUUID().slice(0, 4)}`);
    await setBotBrowser(other.id, true);
    const ev = await s.turnOf(s.sam, other.dm, other.id);
    const r = await browser("snapshot", ev, {}, { agentId: other.id });
    expect(r.status).toBe(404);
    expect(codeOf(r)).toBe("no_context");
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(0);
    expect(await callsOf(ev.eventId)).toEqual([
      expect.objectContaining({ decision: "denied", reason: "no_context", target: "browser" }),
    ]);
  });
});
