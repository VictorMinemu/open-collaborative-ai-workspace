import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type Res } from "../../testing-sandbox";
import {
  type LiveSocket,
  type LiveStack,
  lastState,
  liveSocket,
  startLiveStack,
  waitFor,
  waitState,
} from "./live-testing";
import { browserSessionAad } from "./sessions";

/**
 * 07.8-21 Task 1 (BRW-03, BRW-04; D-07, D-08, D-11 F-10, D-12 U-3 U-6, P-09, R1, R9): Sam signs in for his bot without
 * the bot ever seeing it. In Sam's DM with Scout, the bot asks (`/browser/signin`), the API posts one platform-owned
 * `browser` card and holds the page; Sam takes control in the live view, the (fake) site signs him in, Sam hands back;
 * the API exports the page's state, site-locks the page, seals the state for Sam × Scout × the site, turns the card
 * "Signed in" and gives the bot a card-action turn for Sam. The sealed state appears nowhere but in its secret.
 * Real PostgreSQL and Redis, the in-memory sandboxd.
 */

const SENTINEL = "OCW-SENTINEL-COOKIE-3307";
const HOST = "panel.fake.test";

let l: LiveStack;
const responses: string[] = [];

beforeAll(async () => {
  l = await startLiveStack();
});
afterAll(async () => {
  await l?.stop();
});

const fakeContext = (contextId: string) =>
  l.s.sandboxd.stats().browser.contexts.find((c) => c.contextId === contextId);
async function control(path: string, body: Json = {}): Promise<void> {
  const res = await fetch(`${l.s.sandboxd.url}/__control${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}
const keep = <T extends Res>(r: T): T => {
  responses.push(JSON.stringify(r.body));
  return r;
};
const requestsOf = async (contextId: string) =>
  (await l.s.su.query("select * from app.browser_signin_requests where context_id = $1", [contextId]))
    .rows as Json[];
const contextRow = async (contextId: string) =>
  (await l.s.su.query("select * from app.browser_contexts where id = $1", [contextId])).rows[0] as Json;
const auditsOf = async (actions: string[], since: Date) =>
  (
    await l.s.su.query(
      "select action, actor_kind, actor_id, user_id, metadata from app.audit_events where action = any($1) and occurred_at >= $2 order by occurred_at, id",
      [actions, since.toISOString()],
    )
  ).rows as Json[];
/** Polls an async condition (every 50 ms, 5 s at most). */
async function until(fn: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const card = async (messageId: string, who = l.s.sam) =>
  keep((await who.request("GET", `/api/v1/cards/${messageId}`)) as Res);

/** Every text-like column of every table that holds `needle`, as `schema.table.column`. */
async function columnsHolding(needle: string): Promise<string[]> {
  const cols = (
    await l.s.su.query(
      `select table_schema, table_name, column_name from information_schema.columns
        where table_schema in ('app', 'auth')
          and (data_type in ('text', 'jsonb', 'json', 'character varying') or udt_name in ('_text', '_varchar'))`,
    )
  ).rows as Array<{ table_schema: string; table_name: string; column_name: string }>;
  const found: string[] = [];
  for (const c of cols) {
    const n = (
      await l.s.su.query(
        `select count(*)::int as n from "${c.table_schema}"."${c.table_name}" where "${c.column_name}"::text like $1`,
        [`%${needle}%`],
      )
    ).rows[0].n as number;
    if (n > 0) found.push(`${c.table_schema}.${c.table_name}.${c.column_name}`);
  }
  return found;
}

describe("Sam signs in for Scout by typing in the page himself (tracer)", () => {
  let ev: Json;
  let contextId: string;
  let messageId: string;
  let sam: LiveSocket;
  const started = new Date(Date.now() - 1000);

  it("the bot asks: one platform `browser` card for the page's host, the page held 15 minutes", async () => {
    ev = await l.s.turnOf(l.s.sam, l.s.samDm);
    expect(ev.turn.tools).toContain("ocw_browser_signin");
    contextId = await l.open(ev, `https://${HOST}/login`);
    const r = keep(await l.browser("signin", ev, { reason: "I need the orders dashboard" }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ posted: true, host: HOST });

    const all = await requestsOf(contextId);
    const req = all[0] as Json;
    const others = all.slice(1);
    expect(others).toHaveLength(0);
    expect(req).toMatchObject({
      status: "waiting",
      host: HOST,
      requester_user_id: l.s.samId,
      event_id: ev.eventId,
    });
    const left = new Date(req.expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan(14 * 60_000);
    expect(left).toBeLessThanOrEqual(15 * 60_000);
    messageId = req.card_message_id as string;
    const row = (await l.s.su.query("select * from app.message_cards where message_id = $1", [messageId]))
      .rows[0] as Json;
    expect(row).toMatchObject({
      kind: "browser",
      platform_owned: true,
      status: "pending",
      agent_id: l.s.scoutId,
    });

    const shown = (await ok(card(messageId))) as Json;
    expect(shown).toMatchObject({
      kind: "browser",
      title: `Sign in to ${HOST}`,
      status: "pending",
      platformOwned: true,
      browserSignIn: { contextId, host: HOST, secure: true, requesterId: l.s.samId, status: "waiting" },
    });
    expect(shown.fields).toEqual([
      { label: "Site", value: HOST },
      { label: "Why", value: "I need the orders dashboard" },
    ]);
    expect(shown.viewerCan).toContain("sign_in");
    expect(shown.browserSignIn.expiresAt).toBe(new Date(req.expires_at).toISOString());
    const body = (await l.s.su.query("select body from app.messages where id = $1", [messageId])).rows[0]
      .body;
    expect(body).toBe(`Scout needs someone to sign in to ${HOST} to continue.`);

    expect(fakeContext(contextId)).toMatchObject({ held: true, holdReason: "signin" });
    expect(await contextRow(contextId)).toMatchObject({ state: "paused", paused_for: "signin" });

    // The same call again in the turn: the same card.
    const again = keep(await l.browser("signin", ev, { reason: "I need the orders dashboard" }));
    expect(again.status).toBe(200);
    expect(await requestsOf(contextId)).toHaveLength(1);
    expect(
      (await l.s.su.query("select count(*)::int as n from app.message_cards where kind = 'browser'")).rows[0]
        .n,
    ).toBe(1);
  });

  it("Sam takes control (the card reads Signing in…), the site signs him in, Sam hands back: sealed for him alone", async () => {
    sam = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    try {
      await waitFor(() => lastState(sam));
      sam.send({ type: "take" });
      await waitState(sam, "controlling");
      await until(async () => (await requestsOf(contextId))[0]?.status === "signing_in");
      expect(((await ok(card(messageId))) as Json).browserSignIn.status).toBe("signing_in");

      // The person typed in the page; the fake site now holds a session cookie (the sentinel is its value).
      await control("/browser/signed-in", { contextId, cookieValue: SENTINEL, expires: 2_000_000_000 });
      sam.send({ type: "release" });
      await until(async () => (await requestsOf(contextId))[0]?.status === "signed_in");
      const req = (await requestsOf(contextId))[0] as Json;
      expect(req).toMatchObject({ status: "signed_in" });
      expect(req.session_id).toBeTruthy();
      expect(l.s.sandboxd.stats().calls.contextExportState ?? 0).toBeGreaterThanOrEqual(1);

      // One sealed secret and one owner-only row for (Sam, Scout, the site).
      const sessions = (
        await l.s.su.query("select * from app.browser_sessions where user_id = $1", [l.s.samId])
      ).rows as Json[];
      expect(sessions).toHaveLength(1);
      const session = sessions[0] as Json;
      expect(session).toMatchObject({ agent_id: l.s.scoutId, site_key: HOST, id: req.session_id });
      const secret = (
        await l.s.su.query("select kind, organization_id from app.secrets where id = $1", [session.secret_id])
      ).rows[0] as Json;
      expect(secret).toEqual({ kind: "browser_session", organization_id: l.s.orgA });
      const aad = browserSessionAad({
        organizationId: l.s.orgA,
        userId: l.s.samId,
        agentId: l.s.scoutId,
        siteKey: HOST,
      });
      const core = l.s.stack.built.core;
      const opened = await core.db.withTenant({ organizationId: l.s.orgA, userId: l.s.samId }, (tx) =>
        core.secrets.revealSealed(tx, session.secret_id, aad),
      );
      expect(JSON.parse(opened).cookies.map((c: Json) => c.value)).toEqual(["OCW-SENTINEL-COOKIE-3307"]);
      for (const wrong of [
        browserSessionAad({
          organizationId: l.s.orgA,
          userId: l.s.alexId,
          agentId: l.s.scoutId,
          siteKey: HOST,
        }),
        browserSessionAad({
          organizationId: l.s.orgA,
          userId: l.s.samId,
          agentId: l.s.victorId,
          siteKey: HOST,
        }),
        browserSessionAad({
          organizationId: l.s.orgA,
          userId: l.s.samId,
          agentId: l.s.scoutId,
          siteKey: "x.test",
        }),
      ]) {
        await expect(
          core.db.withTenant({ organizationId: l.s.orgA, userId: l.s.samId }, (tx) =>
            core.secrets.revealSealed(tx, session.secret_id, wrong),
          ),
        ).rejects.toThrow();
      }

      // The page is now Sam's signed-in page: site-locked in sandboxd, linked to the session, no longer held.
      expect(fakeContext(contextId)).toMatchObject({ siteLock: HOST, held: false });
      expect(await contextRow(contextId)).toMatchObject({ session_id: req.session_id, paused_for: null });

      // The card reads Signed in (with the session's expiry), announced to the conversation's readers.
      const shown = (await ok(card(messageId))) as Json;
      expect(shown.status).toBe("succeeded");
      expect(shown.browserSignIn).toMatchObject({ status: "signed_in" });
      expect(Date.parse(shown.browserSignIn.sessionExpiresAt)).toBe(new Date(session.expires_at).getTime());
      expect(shown.viewerCan).not.toContain("sign_in");
      const updates = (
        await l.s.su.query(
          "select payload from app.stream_events where stream_id = $1 and type = 'message.updated' and payload->'message'->>'id' = $2 order by seq",
          [`conv:${l.s.samDm}`, messageId],
        )
      ).rows.map((r) => r.payload as Json);
      expect(updates.at(-1)?.message.card.browserSignIn.status).toBe("signed_in");

      // The bot hears it as Sam's card-action turn: the outcome and the host, nothing else.
      const actions = (
        await l.s.su.query(
          "select payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2",
          [`cell:${l.s.orgA}`, messageId],
        )
      ).rows.map((r) => r.payload as Json);
      expect(actions).toHaveLength(1);
      expect((actions[0] as Json).cardAction).toMatchObject({
        kind: "browser",
        outcome: "approved",
        signIn: { status: "signed_in", host: HOST },
      });
      expect((actions[0] as Json).message.author.id).toBe(l.s.samId);
      expect((actions[0] as Json).message.text).toBe(`Sam Lee signed in to ${HOST}.`);

      // Audits carry ids and the host only.
      const audits = await auditsOf(
        [
          "browser.signin_requested",
          "browser.takeover_started",
          "browser.takeover_ended",
          "browser.signin_decided",
          "browser_session.sealed",
        ],
        started,
      );
      expect(audits.map((a) => a.action)).toEqual([
        "browser.signin_requested",
        "browser.takeover_started",
        "browser.takeover_ended",
        "browser_session.sealed",
        "browser.signin_decided",
      ]);
      for (const a of audits) {
        for (const [key, value] of Object.entries(a.metadata as Json)) {
          expect(
            [
              "requestId",
              "contextId",
              "eventId",
              "host",
              "messageId",
              "reason",
              "sessionId",
              "agentId",
              "site",
              "outcome",
            ],
            `${a.action}.${key}`,
          ).toContain(key);
          if (typeof value === "string" && !["host", "site", "reason", "outcome"].includes(key)) {
            expect(value, `${a.action}.${key}`).toMatch(/^[0-9a-f-]{36}$/);
          }
        }
      }
      expect(audits.find((a) => a.action === "browser.signin_decided")?.metadata).toMatchObject({
        outcome: "signed_in",
        host: HOST,
      });
    } finally {
      sam.close();
    }
  });

  it("the sealed state is nowhere but in its secret: no column, audit row, stream event, log line or response", async () => {
    expect(await columnsHolding(SENTINEL)).toEqual([]);
    expect(l.s.logs.filter((line) => line.includes(SENTINEL))).toEqual([]);
    expect(responses.filter((r) => r.includes(SENTINEL))).toEqual([]);
    const sessions = keep((await l.s.sam.request("GET", "/api/v1/browser-sessions")) as Res);
    expect(JSON.stringify(sessions.body)).not.toContain(SENTINEL);
    // The bot's own answers say nothing of it either.
    const snap = keep(await l.browser("snapshot", ev));
    expect(codeOf(snap) ?? "ok").not.toContain(SENTINEL);
    expect(JSON.stringify(snap.body)).not.toContain(SENTINEL);
  });
});

// ---------------------------------------------------------------- Task 3: every way a sign-in can end

const CRM = "crm.fake.test";

/** A fresh page on `host` in Sam's DM and the bot's sign-in request for it; returns the turn, page and card. */
async function asked(host = CRM) {
  const closing = await l.s.turnOf(l.s.sam, l.s.samDm);
  const closed = await l.browser("close", closing);
  expect([200, 404]).toContain(closed.status);
  // These cases are about how a sign-in ends, not D-13: Task 1 loaded Sam's session in this DM, which made its member
  // data sticky (07.8-28, #292). Each case starts as if Scout's history in Sam's DM had been reset.
  await l.s.su.query("delete from app.agent_member_data where agent_id = $1 and conversation_id = $2", [
    l.s.scoutId,
    l.s.samDm,
  ]);
  const ev = await l.s.turnOf(l.s.sam, l.s.samDm);
  const contextId = (await ok(l.browser("open", ev, { url: `https://${host}/login` }))).contextId as string;
  await ok(l.browser("signin", ev, { reason: "Read the open invoices" }));
  const req = (await requestsOf(contextId))[0] as Json;
  return { ev, contextId, messageId: req.card_message_id as string };
}
const cardActionsOf = async (messageId: string) =>
  (
    await l.s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2",
      [`cell:${l.s.orgA}`, messageId],
    )
  ).rows.map((r) => r.payload as Json);
const sessionsOf = async (site: string) =>
  (await l.s.su.query("select id from app.browser_sessions where site_key = $1", [site])).rows as Json[];
const decide = (messageId: string, outcome: "approved" | "denied", who = l.s.sam) =>
  who.request("POST", `/api/v1/cards/${messageId}/decision`, { outcome }) as Promise<Res>;

describe("every way a sign-in ends: skipped, expired, refused takes, stopped (Task 3)", () => {
  it("“Not now” by Sam: skipped, the page released, the bot hears the skipped sentence in Sam's turn", async () => {
    const { contextId, messageId } = await asked();
    expect(codeOf(await decide(messageId, "approved"))).toBe("card_not_decidable");
    expect((await decide(messageId, "denied", l.s.alex)).status).toBe(404);
    const shown = await ok(decide(messageId, "denied"));
    expect(shown).toMatchObject({ status: "cancelled", browserSignIn: { status: "skipped" } });
    expect(shown.viewerCan).not.toContain("sign_in");
    expect((await requestsOf(contextId))[0]).toMatchObject({ status: "skipped" });
    expect(await contextRow(contextId)).toMatchObject({ paused_for: null, state: "live" });
    await waitFor(() => fakeContext(contextId)?.held === false);
    const [action, ...more] = await cardActionsOf(messageId);
    expect(more).toHaveLength(0);
    expect(action?.cardAction).toMatchObject({ outcome: "denied", signIn: { status: "skipped", host: CRM } });
    expect(action?.message.text).toBe(`Sam Lee chose not to sign in to ${CRM}.`);
    expect(action?.message.author.id).toBe(l.s.samId);
    expect(await sessionsOf(CRM)).toEqual([]);
    // Once only.
    expect(codeOf(await decide(messageId, "denied"))).toBe("card_already_decided");
  });

  it("another turn while a sign-in waits on the page: 409 signin_pending, no second card", async () => {
    const { contextId } = await asked();
    const next = await l.s.turnOf(l.s.sam, l.s.samDm);
    const r = await l.browser("signin", next, { reason: "Again please" });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("signin_pending");
    expect(await requestsOf(contextId)).toHaveLength(1);
  });

  it("15 minutes without a sign-in: expired, the hold released, no turn; an expired card's take answers expired", async () => {
    const { ev, contextId, messageId } = await asked();
    const res = await l.s.stack.built.browser.sweeper.runOnce(Date.now() + 16 * 60_000);
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect((await requestsOf(contextId))[0]).toMatchObject({ status: "expired" });
    const shown = await ok(card(messageId));
    expect(shown).toMatchObject({ status: "cancelled", browserSignIn: { status: "expired" } });
    expect(shown.viewerCan).not.toContain("sign_in");
    expect(await contextRow(contextId)).toMatchObject({ paused_for: null, held_until: null });
    expect(fakeContext(contextId)?.held).toBe(false);
    expect(await cardActionsOf(messageId)).toEqual([]);
    // The page goes (the bot's close): Open on the expired card cannot take it any more.
    await ok(l.browser("close", ev));
    const socket = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    try {
      await waitFor(() => lastState(socket));
      socket.send({ type: "take" });
      const refused = await waitFor(() => socket.json.find((f) => f.type === "refused"), 3000).catch(
        () => null,
      );
      // A page that ended answers `ended` at once (the socket closes); a live one refuses the take as expired.
      if (refused) expect(refused).toMatchObject({ op: "take", reason: "expired" });
      else expect(lastState(socket)).toMatchObject({ state: "ended" });
    } finally {
      socket.close();
    }
  });

  it("refused takes: the bot's owner (not the requester) → not_allowed; Sam's other device while he controls → someone_else", async () => {
    const { contextId, messageId } = await asked();
    const owner = await liveSocket(l.s.stack.baseUrl, await l.s.victor.token(), contextId);
    const first = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    const second = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    try {
      await waitFor(() => lastState(owner) && lastState(first) && lastState(second));
      owner.send({ type: "take" });
      expect(await waitFor(() => owner.json.find((f) => f.type === "refused"))).toMatchObject({
        reason: "not_allowed",
      });
      first.send({ type: "take" });
      await waitState(first, "controlling");
      second.send({ type: "take" });
      expect(await waitFor(() => second.json.find((f) => f.type === "refused"))).toMatchObject({
        reason: "someone_else",
      });
      expect(((await ok(card(messageId))) as Json).browserSignIn.status).toBe("signing_in");
      // Handing back without signing in seals nothing: the card waits again.
      first.send({ type: "release" });
      await waitState(first, "paused");
      expect((await requestsOf(contextId))[0]).toMatchObject({ status: "waiting", session_id: null });
      expect(await sessionsOf(CRM)).toEqual([]);
    } finally {
      owner.close();
      first.close();
      second.close();
    }
  });

  it("the kill switch during a takeover: the lease ends, the card reads stopped (kill_switch), nothing is sealed", async () => {
    const { contextId, messageId } = await asked("billing.fake.test");
    const sam = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    try {
      sam.send({ type: "take" });
      await waitState(sam, "controlling");
      await control("/browser/signed-in", { contextId, cookieValue: "KILLED-NOT-SEALED" });
      await ok(l.s.victor.request("POST", "/api/v1/sandbox/kill") as Promise<Res>);
      await waitState(sam, "ended", 6000);
      expect(lastState(sam)).toMatchObject({ endReason: "kill_switch" });
      const [req] = await requestsOf(contextId);
      expect(req).toMatchObject({ status: "stopped", stop_reason: "kill_switch", session_id: null });
      const shown = await ok(card(messageId));
      expect(shown).toMatchObject({
        status: "cancelled",
        browserSignIn: { status: "stopped", stopReason: "kill_switch" },
      });
      expect(await sessionsOf("billing.fake.test")).toEqual([]);
      expect(await columnsHolding("KILLED-NOT-SEALED")).toEqual([]);
      expect(await cardActionsOf(messageId)).toEqual([]);
    } finally {
      sam.close();
      await ok(l.s.victor.request("POST", "/api/v1/sandbox/resume") as Promise<Res>);
    }
  });
});

describe("a sign-in signal, not just a cookie (07.8-28, WINDOWS #284)", () => {
  it("a site that set a cookie before Sam took control: a hand back that changed nothing seals nothing and the card waits; signing in for real then seals", async () => {
    const site = "consent.fake.test";
    const { contextId, messageId } = await asked(site);
    await control("/browser/pre-cookie", { contextId, name: "consent", value: "accepted" });
    const sam = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    try {
      await waitFor(() => lastState(sam));
      sam.send({ type: "take" });
      await waitState(sam, "controlling");
      await until(async () => (await requestsOf(contextId))[0]?.status === "signing_in");
      // Sam only looked: the site's state is what it was when he took control.
      sam.send({ type: "release" });
      await until(async () => (await requestsOf(contextId))[0]?.status === "waiting");
      expect(await sessionsOf(site)).toEqual([]);
      expect(((await ok(card(messageId))) as Json).browserSignIn.status).toBe("waiting");
      expect(await cardActionsOf(messageId)).toEqual([]);

      // He takes control again and signs in: the session cookie is new, so the hand back seals.
      sam.send({ type: "take" });
      await waitState(sam, "controlling");
      await control("/browser/signed-in", { contextId, cookieValue: "consent-site-session" });
      sam.send({ type: "release" });
      await until(async () => (await requestsOf(contextId))[0]?.status === "signed_in");
      expect(await sessionsOf(site)).toHaveLength(1);
    } finally {
      sam.close();
    }
    // Closing that page reads nothing of it: the closing turn gets no member data and the DM does not become sticky
    // (#292), so the bot can still open another site there without an approval.
    const next = await l.s.turnOf(l.s.sam, l.s.samDm);
    await ok(l.browser("close", next));
    const marked = await l.s.su.query(
      "select (select member_data from app.agent_turns where event_id = $1) as turn, (select count(*)::int from app.agent_member_data where agent_id = $2 and conversation_id = $3) as sticky",
      [next.eventId, l.s.scoutId, l.s.samDm],
    );
    expect(marked.rows[0]).toEqual({ turn: false, sticky: 0 });
    await ok(l.browser("open", next, { url: `https://${CRM}/` }));
    await ok(l.browser("close", next));
  });

  it("a page that cannot be locked after the seal ends at once, never silently: closed in sandboxd, audited with lockFailed; the next open loads the session locked", async () => {
    const site = "locks.fake.test";
    const since = new Date(Date.now() - 1000);
    const { contextId } = await asked(site);
    const sam = await liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    try {
      await waitFor(() => lastState(sam));
      sam.send({ type: "take" });
      await waitState(sam, "controlling");
      await control("/browser/signed-in", { contextId, cookieValue: "locks-site-session" });
      await control("/browser/fail-lock");
      sam.send({ type: "release" });
      await until(async () => (await requestsOf(contextId))[0]?.status === "signed_in");
    } finally {
      sam.close();
    }
    expect(await contextRow(contextId)).toMatchObject({ end_reason: "crashed" });
    expect(fakeContext(contextId)).toBeUndefined();
    const audited = await auditsOf(["browser.closed", "browser.signin_decided"], since);
    expect(
      audited.find((a) => a.action === "browser.closed" && a.metadata.contextId === contextId)?.metadata,
    ).toMatchObject({ reason: "crashed", lockFailed: true });
    expect(
      audited.find((a) => a.action === "browser.signin_decided" && a.metadata.contextId === contextId)
        ?.metadata,
    ).toMatchObject({ outcome: "signed_in", lockFailed: true });
    expect(await sessionsOf(site)).toHaveLength(1);
    // The bot's next page on that site loads the session, locked from its start.
    const next = await l.s.turnOf(l.s.sam, l.s.samDm);
    const opened = await ok(l.browser("open", next, { url: `https://${site}/home` }));
    expect(opened).toMatchObject({ host: site, signedIn: true });
    expect(fakeContext(opened.contextId as string)).toMatchObject({ siteLock: site, loadedState: true });
    await ok(l.browser("close", next));
  });
});
