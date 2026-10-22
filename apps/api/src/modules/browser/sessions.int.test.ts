import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type Res } from "../../testing-sandbox";
import { type LiveStack, liveSocket, startLiveStack, waitState } from "./live-testing";
import { browserSessionAad, keepForSite, sealSession } from "./sessions";

/**
 * 07.8-21 Task 2 (BRW-04; D-08, D-11, D-12 U-3, D-13, P-09, P-18, R7): a member's sealed session is reused only by that
 * member's turns with that bot, where 07.4's member-account rule allows, site-locked with `member_data` set in the
 * same transaction; it rolls on every signed-in call, expires, is purged, revoked, and the database refuses it to
 * anyone else. Real PostgreSQL and Redis, the in-memory sandboxd.
 */

const HOST = "panel.fake.test";

let l: LiveStack;
let alexDm: string;
let other: { id: string; dm: string };

beforeAll(async () => {
  l = await startLiveStack();
  alexDm = (
    await ok(
      l.s.alex.request("POST", "/api/v1/dms", {
        participants: [{ kind: "agent", id: l.s.scoutId }],
      }) as Promise<Res>,
    )
  ).id as string;
  other = await l.s.newBot("Other");
  await l.s.su.query(
    "update app.agents set capabilities = capabilities || jsonb_build_object('browser', true) where id = $1",
    [other.id],
  );
});
afterAll(async () => {
  await l?.stop();
});

const core = () => l.s.stack.built.core;
const asMember = <T>(userId: string, fn: Parameters<ReturnType<typeof core>["db"]["withTenant"]>[1]) =>
  core().db.withTenant({ organizationId: l.s.orgA, userId }, fn) as Promise<T>;
/** A sealed session of `userId` with `agentId` for `site`, through the module's own seal (as the member). */
async function seal(userId: string, agentId: string, site = HOST, value = "loaded-1"): Promise<string> {
  const kept = keepForSite(
    JSON.stringify({
      cookies: [{ name: "fake_session", value, domain: site, path: "/", expires: 2_000_000_000 }],
      origins: [],
    }),
    site,
  );
  if (!kept) throw new Error("no state");
  const r = await asMember<{ sessionId: string }>(userId, (tx) =>
    sealSession(tx, core(), { userId, agentId, siteKey: site, kept, contextId: null }),
  );
  return r.sessionId;
}
const sessionRow = async (id: string) =>
  (await l.s.su.query("select * from app.browser_sessions where id = $1", [id])).rows[0] as Json | undefined;
const secretRow = async (id: string) =>
  (await l.s.su.query("select id, ciphertext from app.secrets where id = $1", [id])).rows[0] as
    | Json
    | undefined;
const contextRow = async (id: string) =>
  (await l.s.su.query("select * from app.browser_contexts where id = $1", [id])).rows[0] as Json;
const fakeContext = (id: string) => l.s.sandboxd.stats().browser.contexts.find((c) => c.contextId === id);
const turnRow = async (eventId: string) =>
  (await l.s.su.query("select member_data from app.agent_turns where event_id = $1", [eventId]))
    .rows[0] as Json;
const audits = async (action: string, resourceId: string) =>
  (
    await l.s.su.query(
      "select actor_kind, user_id, agent_id, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at, id",
      [action, resourceId],
    )
  ).rows as Json[];
async function control(path: string, body: Json = {}): Promise<void> {
  const res = await fetch(`${l.s.sandboxd.url}/__control${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}
/** Opens `url` in a fresh page of the turn (any open page of the turn's triple is closed by the bot first). */
async function openFresh(ev: Json, url = `https://${HOST}/orders`, agentId = l.s.scoutId) {
  const body = { eventId: ev.eventId, agentId };
  const closed = await l.s.cell("/browser/close", body);
  expect([200, 404]).toContain(closed.status);
  return l.s.cell("/browser/open", { ...body, url });
}

describe("reuse: only that member's turns with that bot load it, site-locked, member data in the same transaction", () => {
  let sessionId: string;

  it("Sam's next DM turn with Scout opens the site signed in; the page is locked to the host; the turn has member data", async () => {
    sessionId = await seal(l.s.samId, l.s.scoutId);
    const ev = await l.s.turnOf(l.s.sam, l.s.samDm);
    expect(ev.turn.tools).toContain("ocw_browser_signin");
    const opened = await ok(openFresh(ev));
    expect(opened).toMatchObject({ host: HOST, signedIn: true });
    const ctx = await contextRow(opened.contextId);
    expect(ctx.session_id).toBe(sessionId);
    expect(fakeContext(opened.contextId)).toMatchObject({
      loadedState: true,
      signedIn: true,
      siteLock: HOST,
    });
    expect((await turnRow(ev.eventId)).member_data).toBe(true);
    const used = await audits("browser_session.used", sessionId);
    expect(used.at(-1)?.metadata).toEqual({
      sessionId,
      agentId: l.s.scoutId,
      site: HOST,
      contextId: opened.contextId,
      eventId: ev.eventId,
    });
    expect((await sessionRow(sessionId))?.last_used_at).not.toBeNull();

    // A snapshot reads signed in; a cross-site open after member data needs Sam's approval (D-13).
    const snap = await ok(l.s.cell("/browser/snapshot", { eventId: ev.eventId, agentId: l.s.scoutId }));
    expect(snap.signedIn).toBe(true);
    const away = await l.s.cell("/browser/open", {
      eventId: ev.eventId,
      agentId: l.s.scoutId,
      url: "https://other.fake.test/",
    });
    expect(codeOf(away)).toBe("approval_required");
  });

  it("rolling re-seal: a signed-in call exports the page's state again and seals it in place", async () => {
    const ev = await l.s.turnOf(l.s.sam, l.s.samDm);
    const opened = await ok(openFresh(ev));
    const before = await sessionRow(sessionId);
    const cipherBefore = (await secretRow(before?.secret_id))?.ciphertext;
    await control("/browser/signed-in", {
      contextId: opened.contextId,
      cookieValue: "rolled-2",
      expires: 2_000_000_000,
    });
    await ok(l.s.cell("/browser/wait", { eventId: ev.eventId, agentId: l.s.scoutId, for: "time", ms: 1 }));
    const after = await sessionRow(sessionId);
    expect(after?.secret_id).toBe(before?.secret_id);
    expect((await secretRow(after?.secret_id))?.ciphertext).not.toBe(cipherBefore);
    const state = await asMember<string>(l.s.samId, (tx) =>
      core().secrets.revealSealed(
        tx,
        after?.secret_id,
        browserSessionAad({
          organizationId: l.s.orgA,
          userId: l.s.samId,
          agentId: l.s.scoutId,
          siteKey: HOST,
        }),
      ),
    );
    expect(JSON.parse(state).cookies.map((c: Json) => c.value)).toEqual(["rolled-2"]);
    // The bot's close seals once more before the page goes.
    const exportsBefore = l.s.sandboxd.stats().calls.contextExportState ?? 0;
    await ok(l.s.cell("/browser/close", { eventId: ev.eventId, agentId: l.s.scoutId }));
    expect(l.s.sandboxd.stats().calls.contextExportState ?? 0).toBe(exportsBefore + 1);
  });

  it("never crossing: Alex with Scout, Sam with another bot, Scout in #ops for Sam: nothing loaded, no sign-in in #ops", async () => {
    // Alex, same bot, same host.
    const alexEv = await l.s.turnOf(l.s.alex, alexDm);
    const alexOpen = await ok(openFresh(alexEv));
    expect(alexOpen.signedIn).toBe(false);
    expect(fakeContext(alexOpen.contextId)).toMatchObject({ loadedState: false, siteLock: null });
    expect((await contextRow(alexOpen.contextId)).session_id).toBeNull();
    // Sam, another bot (U-3: per member × site × bot).
    const otherEv = await l.s.turnOf(l.s.sam, other.dm, other.id);
    const otherOpen = await ok(openFresh(otherEv, `https://${HOST}/orders`, other.id));
    expect(otherOpen.signedIn).toBe(false);
    expect(fakeContext(otherOpen.contextId)?.loadedState).toBe(false);
    // Sam in #ops (a shared channel): the member-account rule says no.
    const opsEv = await l.turnIn(l.s.sam);
    expect(opsEv.turn.tools).toContain("ocw_browser_open");
    expect(opsEv.turn.tools).not.toContain("ocw_browser_signin");
    const opsOpen = await ok(openFresh(opsEv));
    expect(opsOpen.signedIn).toBe(false);
    expect((await contextRow(opsOpen.contextId)).session_id).toBeNull();
    const asked = await l.s.cell("/browser/signin", {
      eventId: opsEv.eventId,
      agentId: l.s.scoutId,
      reason: "Read the orders",
    });
    expect(asked.status).toBe(403);
    expect(codeOf(asked)).toBe("signin_not_allowed");
    expect(
      (
        await l.s.su.query("select count(*)::int as n from app.browser_signin_requests where event_id = $1", [
          opsEv.eventId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it("the database refuses it to everyone else: Alex and the admin read no row; their DELETE is 404", async () => {
    for (const userId of [l.s.alexId, l.s.victorId]) {
      const rows = await asMember<Json[]>(
        userId,
        async (tx) =>
          (await tx.execute((await import("drizzle-orm")).sql`select id from app.browser_sessions`))
            .rows as Json[],
      );
      expect(rows, userId).toEqual([]);
    }
    for (const who of [l.s.alex, l.s.victor, l.s.eve]) {
      const r = (await who.request("DELETE", `/api/v1/browser-sessions/${sessionId}`)) as Res;
      expect(r.status).toBe(404);
    }
    expect(await sessionRow(sessionId)).toBeDefined();
    const alexList = await ok(l.s.alex.request("GET", "/api/v1/browser-sessions") as Promise<Res>);
    expect(alexList.items).toEqual([]);
  });
});

describe("Keychain › Browser sessions: list, expiry, purge and revoke (R7)", () => {
  it("lists Sam's own sessions with site, bot, dates and status; never anything that could carry a cookie", async () => {
    const list = await ok(l.s.sam.request("GET", "/api/v1/browser-sessions") as Promise<Res>);
    const mine = (list.items as Json[]).find((i) => i.agentId === l.s.scoutId && i.site === HOST);
    expect(Object.keys(mine ?? {}).sort()).toEqual(
      ["agentId", "agentName", "createdAt", "expiresAt", "id", "lastUsedAt", "site", "status"].sort(),
    );
    expect(mine).toMatchObject({ agentName: "Scout", status: "active" });
    expect(JSON.stringify(list)).not.toMatch(/loaded-1|rolled-2|fake_session/);
  });

  it("an expired session is not loaded, lists as expired, asks again; 7 days later the sweep purges it with its secret", async () => {
    const id = await seal(l.s.samId, other.id, HOST, "old-1");
    await l.s.su.query(
      "update app.browser_sessions set expires_at = now() - interval '1 hour' where id = $1",
      [id],
    );
    const ev = await l.s.turnOf(l.s.sam, other.dm, other.id);
    const opened = await ok(openFresh(ev, `https://${HOST}/orders`, other.id));
    expect(opened.signedIn).toBe(false);
    expect(fakeContext(opened.contextId)?.loadedState).toBe(false);
    const list = await ok(l.s.sam.request("GET", "/api/v1/browser-sessions") as Promise<Res>);
    expect((list.items as Json[]).find((i) => i.id === id)?.status).toBe("expired");
    // The bot may ask again: the card says the saved sign-in expired.
    await ok(
      l.s.cell("/browser/signin", { eventId: ev.eventId, agentId: other.id, reason: "Read the orders" }),
    );
    const card = (
      await l.s.su.query(
        "select c.title, c.fields from app.browser_signin_requests r join app.message_cards c on c.message_id = r.card_message_id where r.event_id = $1",
        [ev.eventId],
      )
    ).rows[0] as Json;
    expect(card.title).toBe(`Sign in to ${HOST} again`);
    expect(card.fields).toContainEqual({ label: "What happened", value: "Your saved sign-in expired." });

    const secretId = (await sessionRow(id))?.secret_id as string;
    await l.s.su.query(
      "update app.browser_sessions set expires_at = now() - interval '8 days' where id = $1",
      [id],
    );
    await l.s.stack.built.browser.sweeper.runOnce();
    expect(await sessionRow(id)).toBeUndefined();
    expect(await secretRow(secretId)).toBeUndefined();
    expect((await audits("browser_session.purged", id)).map((a) => a.metadata)).toEqual([
      { sessionId: id, agentId: other.id, site: HOST },
    ]);
  });

  it("Sam revokes: 204, the secret is gone, the page that had it loaded ends, audited by ids and site", async () => {
    const id = await seal(l.s.samId, l.s.scoutId, "shop.fake.test", "revoke-1");
    const ev = await l.s.turnOf(l.s.sam, l.s.samDm);
    const opened = await ok(openFresh(ev, "https://shop.fake.test/cart"));
    expect(opened.signedIn).toBe(true);
    const secretId = (await sessionRow(id))?.secret_id as string;
    const r = (await l.s.sam.request("DELETE", `/api/v1/browser-sessions/${id}`)) as Res;
    expect(r.status).toBe(204);
    expect(await sessionRow(id)).toBeUndefined();
    expect(await secretRow(secretId)).toBeUndefined();
    expect(await contextRow(opened.contextId)).toMatchObject({ end_reason: "access_lost", session_id: null });
    expect(fakeContext(opened.contextId)).toBeUndefined();
    expect((await audits("browser_session.revoked", id)).map((a) => a.metadata)).toEqual([
      { sessionId: id, agentId: l.s.scoutId, site: "shop.fake.test" },
    ]);
  });
});

describe("clean-up with the bot and the member (WINDOWS #230)", () => {
  it("a hard-deleted bot takes its sessions and their secrets with it", async () => {
    const bot = await l.s.newBot("Temp");
    const id = await seal(l.s.samId, bot.id);
    const secretId = (await sessionRow(id))?.secret_id as string;
    await l.s.su.query("delete from app.agents where id = $1", [bot.id]);
    expect(await sessionRow(id)).toBeUndefined();
    expect(await secretRow(secretId)).toBeUndefined();
  });

  it("a member who leaves the organization (deactivated) loses every session and secret there", async () => {
    const inv = await ok(
      l.s.victor.request("POST", "/api/v1/invitations", {
        email: "rae@example.test",
        role: "standard",
      }) as Promise<Res>,
    );
    const { TestClient } = await import("../../testing");
    const rae = new TestClient(l.s.stack.baseUrl);
    const raeId = (
      await ok(
        rae.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
          name: "Rae Moss",
          password: "rae-long-password-123",
        }) as Promise<Res>,
      )
    ).user.id as string;
    const id = await seal(raeId, l.s.scoutId);
    const secretId = (await sessionRow(id))?.secret_id as string;
    const kept = await seal(l.s.samId, l.s.scoutId, "kept.fake.test");
    await l.s.su.query("update app.org_members set deactivated_at = now() where user_id = $1", [raeId]);
    expect(await sessionRow(id)).toBeUndefined();
    expect(await secretRow(secretId)).toBeUndefined();
    expect(await sessionRow(kept)).toBeDefined();
  });
});

describe("the bot page's Browser tab (UI-SPEC § 3.6)", () => {
  it("lists the pages the viewer may watch, private rows for a member's page, and host-level activity they can read", async () => {
    const ev = await l.s.turnOf(l.s.sam, l.s.samDm);
    const mine = await ok(openFresh(ev));
    expect(mine.signedIn).toBe(true);
    const opsEv = await l.turnIn(l.s.alex);
    const ops = await ok(openFresh(opsEv, "https://status.fake.test/"));
    // The bot moves that page to another host (WINDOWS #286): the row follows it, the activity keeps where it opened.
    await ok(
      l.s.cell("/browser/open", {
        eventId: opsEv.eventId,
        agentId: l.s.scoutId,
        url: "https://later.fake.test/",
      }),
    );
    expect((await contextRow(ops.contextId as string)).host).toBe("later.fake.test");

    const samView = await ok(l.s.sam.request("GET", `/api/v1/agents/${l.s.scoutId}/browser`) as Promise<Res>);
    const samRow = (samView.open as Json[]).find((r) => r.contextId === mine.contextId);
    expect(samRow).toMatchObject({
      host: HOST,
      privateFor: null,
      privateReason: null,
      viewerCan: { watch: true, control: true },
    });
    // 07.8-27: the conversation is named as the viewer reads it ("DM with you", "# ops"), never a raw id.
    expect(samRow?.conversation).toMatchObject({
      kind: "dm",
      name: "DM with you",
      route: `/chat/dm/${l.s.samDm}`,
    });
    const opsName = (await l.s.su.query("select name from app.conversations where id = $1", [l.ops])).rows[0]
      .name as string;
    expect((samView.open as Json[]).find((r) => r.contextId === ops.contextId)).toMatchObject({
      host: "later.fake.test",
      viewerCan: { watch: true, control: false },
      conversation: { kind: "channel", name: `# ${opsName}` },
    });
    // Víctor owns Scout but Sam's signed-in page is Sam's alone (U-2): a private row, no frames, no button.
    const owner = await ok(
      l.s.victor.request("GET", `/api/v1/agents/${l.s.scoutId}/browser`) as Promise<Res>,
    );
    expect((owner.open as Json[]).find((r) => r.contextId === mine.contextId)).toMatchObject({
      state: "private",
      privateFor: "Sam Lee",
      privateReason: "member_session",
      viewerCan: { watch: false, control: false },
      // Víctor does not read Sam's DM: it is named for whose it is, never "DM with you".
      conversation: { kind: "dm", name: "DM with Sam Lee" },
    });
    // Alex reads #ops, not Sam's DM: no row and no activity from it.
    const alex = await ok(l.s.alex.request("GET", `/api/v1/agents/${l.s.scoutId}/browser`) as Promise<Res>);
    expect((alex.open as Json[]).some((r) => r.contextId === mine.contextId)).toBe(false);
    // Alex's own DM pages are his; none of Sam's DM pages reaches him.
    const alexDmPages = (
      await l.s.su.query(
        "select count(*)::int as n from app.browser_contexts where conversation_id = $1 and host = $2",
        [alexDm, HOST],
      )
    ).rows[0].n as number;
    expect(
      (alex.activity as Json[]).filter((a) => a.conversation.kind === "dm" && a.host === HOST),
    ).toHaveLength(alexDmPages);
    expect((alex.activity as Json[]).some((a) => a.kind === "opened" && a.host === "status.fake.test")).toBe(
      true,
    );
    expect((alex.activity as Json[]).some((a) => a.host === "later.fake.test")).toBe(false);
    // Alex reads every conversation his activity names: his own DM reads "DM with you".
    for (const a of alex.activity as Json[]) {
      if (a.conversation.kind === "dm") expect(a.conversation.name).toBe("DM with you");
    }
    expect(JSON.stringify(alex)).not.toContain("/orders");
    // While Alex holds control of the #ops page, Sam sees it private.
    const socket = await liveSocket(l.s.stack.baseUrl, await l.s.alex.token(), ops.contextId);
    try {
      socket.send({ type: "take" });
      await waitState(socket, "controlling");
      const during = await ok(
        l.s.sam.request("GET", `/api/v1/agents/${l.s.scoutId}/browser`) as Promise<Res>,
      );
      expect((during.open as Json[]).find((r) => r.contextId === ops.contextId)).toMatchObject({
        state: "private",
        privateFor: "Alex Kim",
        privateReason: "takeover",
      });
    } finally {
      socket.close();
    }
    // Another organization's admin: the bot does not exist.
    expect(((await l.s.eve.request("GET", `/api/v1/agents/${l.s.scoutId}/browser`)) as Res).status).toBe(404);
  });
});

describe("cross-tenant guards derived from the authz registry (P-17, 07.4 #169)", () => {
  it("every people's browser route answers organization B with 404 (or its own empty list) and the set equals the registry's", async () => {
    const id = await seal(l.s.samId, l.s.scoutId, "tenant.fake.test");
    const routeKey = (k: string) => k.replace(/:[A-Za-z]+/gu, ":p");
    const cases: Record<string, () => Promise<void>> = {
      "GET /api/v1/browser-sessions": async () => {
        const r = await ok(l.s.eve.request("GET", "/api/v1/browser-sessions") as Promise<Res>);
        expect(r.items).toEqual([]);
      },
      "DELETE /api/v1/browser-sessions/:p": async () => {
        expect(((await l.s.eve.request("DELETE", `/api/v1/browser-sessions/${id}`)) as Res).status).toBe(404);
      },
      "GET /api/v1/agents/:p/browser": async () => {
        expect(((await l.s.eve.request("GET", `/api/v1/agents/${l.s.scoutId}/browser`)) as Res).status).toBe(
          404,
        );
      },
    };
    const registered = [...l.s.stack.built.authz.routes.keys()]
      .filter((k) => k.includes("/browser-sessions") || /\/agents\/:[A-Za-z]+\/browser$/u.test(k))
      .map(routeKey)
      .sort();
    expect(registered).toEqual(Object.keys(cases).sort());
    for (const [key, run] of Object.entries(cases)) {
      expect(l.s.stack.built.authz.routes.get(key.replace(":p", ":id")), key).toBe("user");
      await run();
    }
    expect(await sessionRow(id)).toBeDefined();
  });
});
