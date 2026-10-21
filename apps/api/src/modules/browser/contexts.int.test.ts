import { browserContexts } from "@ocw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import {
  type ContextTurn,
  closeContext,
  contextFor,
  holdContext,
  openContextOf,
  releaseHold,
  sessionLoadedFor,
  takeoverActive,
} from "./contexts";

/**
 * 07.8-14 (D-05, D-12, T-07.8-14-06): browser context rows. One open context per (bot, conversation, member), created
 * with the target's host only; every id is resolved inside the transaction's tenant (foreign keys bypass RLS, 07.4
 * #169), so another organization's turn creates nothing, and another organization's user reads no row.
 */

let s: SandboxStack;

const turnOf = (ev: Json, userId: string): ContextTurn => ({
  eventId: ev.eventId,
  agentId: ev.agent.id,
  conversationId: ev.conversation.id,
  userId,
  messageId: ev.message.id,
});

beforeAll(async () => {
  s = await startSandboxStack();
});

afterAll(async () => {
  await s?.stop();
});

describe("contextFor", () => {
  it("creates one context with the host only, then reuses it; the same bot for another member gets another", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const db = s.stack.built.core.db;
    const asSam = { organizationId: s.orgA, userId: s.samId };
    const first = await db.withTenant(asSam, (tx) =>
      contextFor(tx, { turn: turnOf(ev, s.samId), host: "panel.fake.test", secure: true }),
    );
    expect(first?.created).toBe(true);
    expect(first?.context).toMatchObject({ host: "panel.fake.test", state: "live", sessionSite: null });
    const again = await db.withTenant(asSam, (tx) =>
      contextFor(tx, { turn: turnOf(ev, s.samId), host: "other.fake.test", secure: true }),
    );
    expect(again).toMatchObject({
      created: false,
      context: { id: first?.context.id, host: "panel.fake.test" },
    });

    // A host is a host: never a path or credentials.
    const bad = await db.withTenant(asSam, (tx) =>
      contextFor(tx, { turn: turnOf(ev, s.samId), host: "panel.fake.test/x", secure: true }),
    );
    expect(bad).toBeNull();

    const alexTurn = { ...turnOf(ev, s.alexId) };
    const alex = await db.withTenant({ organizationId: s.orgA, userId: s.alexId }, (tx) =>
      contextFor(tx, { turn: alexTurn, host: "panel.fake.test", secure: true }),
    );
    expect(alex?.created).toBe(true);
    expect(alex?.context.id).not.toBe(first?.context.id);
  });

  it("hold, release and close move the row's state; a closed context is no longer the open one", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const db = s.stack.built.core.db;
    const asSam = { organizationId: s.orgA, userId: s.samId };
    const made = await db.withTenant(asSam, async (tx) => {
      const open = await openContextOf(tx, { agentId: s.scoutId, conversationId: s.samDm, userId: s.samId });
      return (
        open ??
        (await contextFor(tx, { turn: turnOf(ev, s.samId), host: "panel.fake.test", secure: true }))?.context
      );
    });
    if (!made) throw new Error("no context");
    await db.withTenant(asSam, (tx) => holdContext(tx, made.id, Date.now() + 15 * 60_000));
    let row = (await s.su.query("select * from app.browser_contexts where id = $1", [made.id]))
      .rows[0] as Json;
    expect(row).toMatchObject({ state: "paused", paused_for: "approval" });
    expect(Date.parse(row.held_until) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await db.withTenant(asSam, (tx) => releaseHold(tx, made.id))).toBe(true);
    row = (await s.su.query("select * from app.browser_contexts where id = $1", [made.id])).rows[0] as Json;
    expect(row).toMatchObject({ state: "live", paused_for: null, held_until: null });
    const closed = await db.withTenant(asSam, (tx) => closeContext(tx, made.id, "closed_by_bot"));
    expect(closed).toMatchObject({ state: "ended", endReason: "closed_by_bot" });
    expect(await db.withTenant(asSam, (tx) => closeContext(tx, made.id, "idle"))).toBeNull();
    const open = await db.withTenant(asSam, (tx) =>
      openContextOf(tx, { agentId: s.scoutId, conversationId: s.samDm, userId: s.samId }),
    );
    expect(open?.id).not.toBe(made.id);
  });
});

describe("tenant isolation (RLS, ids resolved inside withTenant)", () => {
  it("organization B's user reads none of organization A's contexts", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const db = s.stack.built.core.db;
    await db.withTenant({ organizationId: s.orgA, userId: s.samId }, (tx) =>
      contextFor(tx, { turn: turnOf(ev, s.samId), host: "panel.fake.test", secure: true }),
    );
    const inA = Number(
      (await s.su.query("select count(*) from app.browser_contexts where organization_id = $1", [s.orgA]))
        .rows[0].count,
    );
    expect(inA).toBeGreaterThan(0);
    const seenByEve = await db.withTenant({ organizationId: s.orgB, userId: s.eveId }, (tx) =>
      tx.select().from(browserContexts),
    );
    expect(seenByEve).toEqual([]);
  });

  it("organization A's turn ids in organization B's tenant create nothing (the agent and conversation do not resolve)", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const before = Number(
      (await s.su.query("select count(*) from app.browser_contexts where organization_id = $1", [s.orgB]))
        .rows[0].count,
    );
    const made = await s.stack.built.core.db.withTenant({ organizationId: s.orgB, userId: s.eveId }, (tx) =>
      contextFor(tx, { turn: turnOf(ev, s.eveId), host: "panel.fake.test", secure: true }),
    );
    expect(made).toBeNull();
    const after = Number(
      (await s.su.query("select count(*) from app.browser_contexts where organization_id = $1", [s.orgB]))
        .rows[0].count,
    );
    expect(after).toBe(before);
  });
});

describe("pure rules", () => {
  it("a session is loaded only for exactly its site; a takeover is active only while its lease runs", () => {
    expect(sessionLoadedFor({ sessionId: "s", sessionSite: "panel.fake.test" }, "panel.fake.test")).toBe(
      true,
    );
    expect(sessionLoadedFor({ sessionId: "s", sessionSite: "panel.fake.test" }, "evil.fake.test")).toBe(
      false,
    );
    expect(sessionLoadedFor({ sessionId: null, sessionSite: null }, "panel.fake.test")).toBe(false);
    expect(sessionLoadedFor({ sessionId: "s", sessionSite: null }, "panel.fake.test")).toBe(false);
    const soon = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(takeoverActive({ controllerUserId: "u", leaseExpiresAt: soon })).toBe(true);
    expect(takeoverActive({ controllerUserId: "u", leaseExpiresAt: past })).toBe(false);
    expect(takeoverActive({ controllerUserId: null, leaseExpiresAt: null })).toBe(false);
  });
});
