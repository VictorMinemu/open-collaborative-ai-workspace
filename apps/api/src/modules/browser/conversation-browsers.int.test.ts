import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, ok, type Res } from "../../testing-sandbox";
import { type LiveStack, startLiveStack } from "./live-testing";
import { keepForSite, sealSession } from "./sessions";

/**
 * 07.8-26 (BRW-02, BRW-03, BRW-04; UI-SPEC Surface 1b, Surface 2): what the web needs to show a conversation's live
 * browsers and to word the sign-in card for every reader.
 *
 * - `GET /api/v1/conversations/:id/browsers`: the open pages of the conversation and of its threads that the viewer
 *   may watch (the resolver's `browser.watch`, as the live view decides it). A person who cannot read the conversation,
 *   and another organization, get 404; a page with a member's sealed session is listed only for that member (D-12 U-2).
 * - The sign-in link names its requester and when it was decided (the same for every reader).
 *
 * Real PostgreSQL and Redis, the in-memory sandboxd.
 */

const HOST = "panel.fake.test";

let l: LiveStack;

beforeAll(async () => {
  l = await startLiveStack();
});
afterAll(async () => {
  await l?.stop();
});

const list = (who: LiveStack["s"]["sam"], conversationId: string) =>
  who.request("GET", `/api/v1/conversations/${conversationId}/browsers`) as Promise<Res>;
const items = async (who: LiveStack["s"]["sam"], conversationId: string) =>
  ((await ok(list(who, conversationId))) as Json).items as Json[];

describe("the conversation's open pages (the live chip)", () => {
  it("a reader sees Scout's open page of #ops with its host and the bot; it goes once the page closes", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev, `https://${HOST}/orders?id=7`);
    const shown = await items(l.s.sam, l.ops);
    const row = shown.find((r) => r.contextId === contextId);
    expect(row).toEqual({
      contextId,
      host: HOST,
      secure: true,
      bot: { id: l.s.scoutId, displayName: expect.any(String), avatarUrl: null },
      threadRootId: null,
    });
    // Hosts only: the page's path and query never leave the API.
    expect(JSON.stringify(shown)).not.toContain("orders");
    // Alex reads #ops too: he may watch it.
    expect((await items(l.s.alex, l.ops)).map((r) => r.contextId)).toContain(contextId);

    await ok(l.browser("close", ev));
    expect((await items(l.s.sam, l.ops)).map((r) => r.contextId)).not.toContain(contextId);
  });

  it("a page opened in a thread of #ops is listed with its thread's root", async () => {
    const root = await ok(
      l.s.sam.request("POST", `/api/v1/conversations/${l.ops}/messages`, {
        body: `thread root ${randomUUID().slice(0, 6)}`,
      }) as Promise<Res>,
    );
    const threadTurn = await ok(
      l.s.sam.request("POST", `/api/v1/conversations/${l.ops}/messages`, {
        body: `@scout look in the thread ${randomUUID().slice(0, 6)}`,
        threadRootId: root.id,
      }) as Promise<Res>,
    );
    const rows = (
      await l.s.su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2",
        [`cell:${l.s.orgA}`, threadTurn.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    const ev = rows[0].payload as Json;
    const contextId = await l.open(ev);
    const row = (await items(l.s.sam, l.ops)).find((r) => r.contextId === contextId);
    expect(row?.threadRootId).toBe(root.id);
    await ok(l.browser("close", ev));
  });

  it("someone who cannot read the conversation, and another organization, get 404 (never an empty list)", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    // Víctor owns Scout but does not read #ops; Nia neither reads it nor owns the bot; Eve is organization B's admin.
    for (const who of [l.s.victor, l.nia, l.s.eve]) {
      const r = await list(who, l.ops);
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain(contextId);
    }
    expect((await list(l.s.sam, randomUUID())).status).toBe(404);
    await ok(l.browser("close", ev));
  });

  it("a page with Sam's sealed session is listed for Sam only (D-12 U-2)", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const kept = keepForSite(
      JSON.stringify({
        cookies: [{ name: "fake_session", value: "v", domain: HOST, path: "/", expires: 2_000_000_000 }],
        origins: [],
      }),
      HOST,
    );
    if (!kept) throw new Error("no state");
    const core = l.s.stack.built.core;
    const { sessionId } = await core.db.withTenant({ organizationId: l.s.orgA, userId: l.s.samId }, (tx) =>
      sealSession(tx, core, {
        userId: l.s.samId,
        agentId: l.s.scoutId,
        siteKey: HOST,
        kept,
        contextId: null,
      }),
    );
    const session = { id: sessionId };
    await l.s.su.query("update app.browser_contexts set session_id = $2 where id = $1", [
      contextId,
      session.id,
    ]);
    expect((await items(l.s.sam, l.ops)).map((r) => r.contextId)).toContain(contextId);
    expect((await items(l.s.alex, l.ops)).map((r) => r.contextId)).not.toContain(contextId);
    await l.s.su.query("update app.browser_contexts set session_id = null where id = $1", [contextId]);
    await l.s.su.query("delete from app.browser_sessions where id = $1", [session.id]);
    await ok(l.browser("close", ev));
  });
});

describe("the sign-in link names its requester and when it was decided", () => {
  it("waiting: the requester's name; Not now: decided now, the same for every reader", async () => {
    const ev = await l.s.turnOf(l.s.sam, l.s.samDm);
    const closed = await l.browser("close", ev);
    expect([200, 404]).toContain(closed.status);
    const contextId = (await ok(l.browser("open", ev, { url: `https://${HOST}/login` }))).contextId as string;
    await ok(l.browser("signin", ev, { reason: "Read the orders" }));
    const req = (
      await l.s.su.query("select card_message_id from app.browser_signin_requests where context_id = $1", [
        contextId,
      ])
    ).rows[0] as Json;
    const messageId = req.card_message_id as string;
    const before = (await ok(l.s.sam.request("GET", `/api/v1/cards/${messageId}`) as Promise<Res>)) as Json;
    expect(before.browserSignIn).toMatchObject({ status: "waiting", requesterName: "Sam Lee" });
    expect(before.browserSignIn.decidedAt ?? null).toBeNull();

    await ok(
      l.s.sam.request("POST", `/api/v1/cards/${messageId}/decision`, { outcome: "denied" }) as Promise<Res>,
    );
    const after = (await ok(l.s.sam.request("GET", `/api/v1/cards/${messageId}`) as Promise<Res>)) as Json;
    expect(after.browserSignIn).toMatchObject({ status: "skipped", requesterName: "Sam Lee" });
    expect(Date.parse(after.browserSignIn.decidedAt)).toBeGreaterThan(Date.now() - 60_000);
  });
});
