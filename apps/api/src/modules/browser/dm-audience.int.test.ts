import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * 07.8 hardening (07.8-28 candidate 7; D-13, #292): a DM's human audience is fixed at creation. Member data loaded by a
 * bot in a DM is guarded by approvals its one human requester decides, so no path may add a second human to a bot DM
 * (or a third to a human DM): not the channel member routes (any role, the organization admin included), not a join,
 * not a mention, not an AI chat grant or participant route, and not another organization. Another member opening a DM
 * with the same bot gets their own conversation. Real PostgreSQL + Redis, fake sandboxd.
 */

let s: SandboxStack;
let humanDm: string;

const humansOf = async (conversationId: string) =>
  (
    await s.su.query(
      "select member_id from app.conversation_members where conversation_id = $1 and member_kind = 'user' order by member_id",
      [conversationId],
    )
  ).rows.map((r: Json) => r.member_id as string);

beforeAll(async () => {
  s = await startSandboxStack();
  humanDm = (
    await ok(
      s.sam.request("POST", "/api/v1/dms", {
        participants: [{ kind: "user", id: s.alexId }],
      }) as Promise<Res>,
    )
  ).id as string;
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

describe("a DM never gains a human participant", () => {
  it("Sam's DM with a team bot holds exactly one human, Sam", async () => {
    expect(await humansOf(s.samDm)).toEqual([s.samId]);
    expect(await humansOf(humanDm)).toEqual([s.samId, s.alexId].sort());
  });

  it("the channel member routes refuse every caller, the organization admin included", async () => {
    for (const conversationId of [s.samDm, humanDm]) {
      for (const [who, add] of [
        [s.sam, s.victorId],
        [s.victor, s.alexId],
        [s.victor, s.victorId],
        [s.alex, s.victorId],
      ] as Array<[TestClient, string]>) {
        const res = (await who.request("POST", `/api/v1/channels/${conversationId}/members`, {
          kind: "user",
          id: add,
        })) as Res;
        expect([403, 404]).toContain(res.status);
      }
    }
    expect(await humansOf(s.samDm)).toEqual([s.samId]);
    expect(await humansOf(humanDm)).toEqual([s.samId, s.alexId].sort());
  });

  it("joining is refused for non-participants (the admin, another member)", async () => {
    for (const who of [s.victor, s.alex]) {
      const res = (await who.request("POST", `/api/v1/channels/${s.samDm}/join`)) as Res;
      expect([403, 404]).toContain(res.status);
    }
    const res = (await s.victor.request("POST", `/api/v1/channels/${humanDm}/join`)) as Res;
    expect([403, 404]).toContain(res.status);
    expect(await humansOf(s.samDm)).toEqual([s.samId]);
    expect(await humansOf(humanDm)).toEqual([s.samId, s.alexId].sort());
  });

  it("mentioning a person in the DM adds nobody", async () => {
    await ok(
      s.sam.request("POST", `/api/v1/conversations/${s.samDm}/messages`, {
        body: "@alex @victor please look at this",
        mentions: [
          { kind: "user", id: s.alexId },
          { kind: "user", id: s.victorId },
        ],
      }) as Promise<Res>,
    );
    expect(await humansOf(s.samDm)).toEqual([s.samId]);
  });

  it("the AI chat grant and participant routes do not reach a DM", async () => {
    for (const conversationId of [s.samDm, humanDm]) {
      const grant = (await s.sam.request("POST", `/api/v1/ai-chats/${conversationId}/grants`, {
        subject: { kind: "user", id: s.victorId },
        level: "chat",
      })) as Res;
      expect([403, 404]).toContain(grant.status);
      const bot = (await s.sam.request("POST", `/api/v1/ai-chats/${conversationId}/agents`, {
        agentId: s.scoutId,
      })) as Res;
      expect([403, 404]).toContain(bot.status);
    }
    expect(await humansOf(s.samDm)).toEqual([s.samId]);
    expect(await humansOf(humanDm)).toEqual([s.samId, s.alexId].sort());
  });

  it("another member opening a DM with the same bot gets their own conversation", async () => {
    const alexDm = (
      await ok(
        s.alex.request("POST", "/api/v1/dms", {
          participants: [{ kind: "agent", id: s.scoutId }],
        }) as Promise<Res>,
      )
    ).id as string;
    expect(alexDm).not.toBe(s.samDm);
    expect(await humansOf(alexDm)).toEqual([s.alexId]);
    expect(await humansOf(s.samDm)).toEqual([s.samId]);
  });

  it("another organization's admin reaches neither DM", async () => {
    for (const conversationId of [s.samDm, humanDm]) {
      for (const path of [
        `/api/v1/channels/${conversationId}/join`,
        `/api/v1/channels/${conversationId}/members`,
      ]) {
        const res = (await s.eve.request("POST", path, { kind: "user", id: s.eveId })) as Res;
        expect(res.status).toBe(404);
      }
    }
    expect(await humansOf(s.samDm)).toEqual([s.samId]);
  });

  it("across the database, no bot DM has more than one human and no DM more than two", async () => {
    const { rows } = await s.su.query(
      `select c.id,
              count(*) filter (where m.member_kind = 'user')::int as humans,
              count(*) filter (where m.member_kind = 'agent')::int as bots
         from app.conversations c join app.conversation_members m on m.conversation_id = c.id
        where c.kind = 'dm'
        group by c.id`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows as Json[]) {
      if (r.bots > 0) expect(r).toMatchObject({ humans: 1, bots: 1 });
      else expect(r.humans).toBe(2);
    }
  });
});
