import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { TestClient } from "../../testing";
import { WEB_ORIGIN } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * 07.8-10 tracer (SBX-02, R2, UI-SPEC Surface 5; T-07.8-10-01/03/04): a bot writes a file in its sandbox and every
 * reader of its reply sees "Wrote reports/late.csv". write route → decision → sandboxd → audit → activity step →
 * `turn.activity` to the conversation's readers while the turn runs → reply posted → activity attached to the reply
 * (its `message.created` and every message list). Real PostgreSQL + Redis; the in-memory sandboxd (P-13).
 */

const SENTINEL = "OCW-SENTINEL-CONTENT-4410";
let s: SandboxStack;

interface Frame {
  op: string;
  topic?: string;
  type?: string;
  code?: string;
  data?: Json;
}

async function openSocket(client: TestClient) {
  const token = await client.token();
  const socket = new WebSocket(
    `${s.stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: Frame[] = [];
  socket.on("message", (m) => frames.push(JSON.parse(String(m)) as Frame));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    frames,
    sub: (topic: string) => socket.send(JSON.stringify({ op: "sub", topic })),
    close: () => socket.close(),
  };
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const write = (ev: Json, body: Json): Promise<Res> =>
  s.cell("/sandbox/write", { eventId: ev.eventId, agentId: s.scoutId, mode: "overwrite", ...body });

const reply = (ev: Json, text: string): Promise<Res> =>
  s.cell("/messages", {
    agentId: s.scoutId,
    conversationId: ev.conversation.id,
    threadRootMessageId: null,
    eventId: ev.eventId,
    text,
    idempotencyKey: `reply-${randomUUID()}`,
  });

const listOf = async (who: TestClient, conversationId: string): Promise<Json[]> =>
  (await ok(who.request("GET", `/api/v1/conversations/${conversationId}/messages?limit=50`) as Promise<Res>))
    .messages as Json[];

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
});

afterAll(async () => {
  await s?.stop();
});

describe("a bot writes a file and every reader sees it on the reply (tracer)", () => {
  it("streams turn.activity to readers only while running, then the reply carries `Wrote reports/late.csv`", async () => {
    const sam = await openSocket(s.sam);
    const alex = await openSocket(s.alex);
    try {
      const topic = `conv:${s.samDm}`;
      sam.sub(topic);
      alex.sub(topic);
      await waitFor(() => sam.frames.find((f) => f.op === "subscribed" && f.topic === topic));
      // Alex does not read Sam's DM: the gateway refuses the subscription.
      await waitFor(() => alex.frames.find((f) => f.op === "err" && f.topic === topic));

      const ev = await s.turnOf(s.sam, s.samDm);
      const content = `${SENTINEL}\n${"x".repeat(4096 - SENTINEL.length - 1)}`;
      const res = await ok(write(ev, { path: "reports/late.csv", content }));
      expect(res).toEqual({ path: "reports/late.csv", size: 4096 });

      const live = await waitFor(() =>
        sam.frames.find(
          (f) =>
            f.op === "eph" &&
            f.type === "turn.activity" &&
            f.data?.activity?.steps?.[0]?.outcome?.kind === "ok",
        ),
      );
      expect(live.data).toMatchObject({
        type: "turn.activity",
        conversationId: s.samDm,
        agentId: s.scoutId,
        activity: { eventId: ev.eventId, running: true, more: 0 },
      });
      expect(live.data?.activity.steps[0]).toMatchObject({
        tool: "ocw_sandbox_write",
        verb: "wrote",
        target: "reports/late.csv · 4 KB",
      });
      // The in-flight frame named what the bot did at that moment.
      expect(
        sam.frames.some(
          (f) => f.type === "turn.activity" && f.data?.activity?.current === "writing reports/late.csv",
        ),
      ).toBe(true);

      const posted = await ok(reply(ev, "The list is in reports/late.csv."));
      const created = await waitFor(() =>
        sam.frames.find(
          (f) => f.op === "ev" && f.type === "message.created" && f.data?.message?.id === posted.messageId,
        ),
      );
      expect(created.data?.message.activity).toMatchObject({ eventId: ev.eventId, running: false, more: 0 });
      expect(created.data?.message.activity.steps[0]).toMatchObject({
        verb: "wrote",
        target: "reports/late.csv · 4 KB",
      });

      const mine = (await listOf(s.sam, s.samDm)).find((m) => m.id === posted.messageId);
      expect(mine?.activity?.steps).toHaveLength(1);
      expect(mine?.activity?.steps[0]).toMatchObject({ verb: "wrote", target: "reports/late.csv · 4 KB" });
      // Human messages carry none.
      expect((await listOf(s.sam, s.samDm)).filter((m) => m.authorKind === "user" && m.activity)).toEqual([]);

      await sleep(200);
      expect(alex.frames.filter((f) => f.type === "turn.activity" || f.type === "message.created")).toEqual(
        [],
      );

      // Never content: not in the activity row, the audit, the ledger or the stream.
      const leaks = await s.su.query(
        `select (select count(*) from app.bot_turn_activity where steps::text like $1)
              + (select count(*) from app.audit_events where metadata::text like $1)
              + (select count(*) from app.stream_events where payload::text like $1) as n`,
        [`%${SENTINEL}%`],
      );
      expect(Number(leaks.rows[0].n)).toBe(0);
    } finally {
      sam.close();
      alex.close();
    }
  });

  it("in a channel, every reader's list shows the reply's activity, the bot's owner included", async () => {
    const ch = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", {
          name: `ops-${randomUUID().slice(0, 6)}`,
        }) as Promise<Res>,
      )
    ).id as string;
    await ok(
      s.victor.request("POST", `/api/v1/channels/${ch}/members`, {
        kind: "user",
        id: s.samId,
      }) as Promise<Res>,
    );
    await ok(
      s.victor.request("POST", `/api/v1/channels/${ch}/members`, {
        kind: "agent",
        id: s.scoutId,
      }) as Promise<Res>,
    );
    const msg = await ok(
      s.sam.request("POST", `/api/v1/conversations/${ch}/messages`, {
        body: "@scout list the late orders",
      }) as Promise<Res>,
    );
    const rows = (
      await s.su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2",
        [`cell:${s.orgA}`, msg.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    const ev = rows[0].payload as Json;
    await ok(write(ev, { path: "reports/late.csv", content: "id,late\n1,yes\n" }));
    const posted = await ok(
      s.cell("/messages", {
        agentId: s.scoutId,
        conversationId: ch,
        threadRootMessageId: msg.id,
        eventId: ev.eventId,
        text: "Done.",
        idempotencyKey: `reply-${randomUUID()}`,
      }),
    );
    for (const who of [s.sam, s.victor]) {
      const thread = await ok(who.request("GET", `/api/v1/messages/${msg.id}/thread`) as Promise<Res>);
      const found = [thread.root, ...(thread.replies as Json[])].find((m: Json) => m.id === posted.messageId);
      expect(found?.activity?.steps[0]).toMatchObject({ verb: "wrote", target: "reports/late.csv · 14 B" });
    }
  });

  it("51 calls in one turn: 50 steps and `more: 1` (the budget refusals are blocked steps)", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    for (let i = 0; i < 51; i++) await write(ev, { path: `n/${i}.txt`, content: "1" });
    const posted = await ok(reply(ev, "Wrote them."));
    const mine = (await listOf(s.sam, s.samDm)).find((m) => m.id === posted.messageId);
    expect(mine?.activity?.steps).toHaveLength(50);
    expect(mine?.activity?.more).toBe(1);
    expect(mine?.activity?.steps.filter((x: Json) => x.verb === "wrote")).toHaveLength(40);
    expect(mine?.activity?.steps.at(-1)).toMatchObject({
      verb: "blocked",
      outcome: { kind: "blocked", code: "budget_exhausted" },
    });
  });
});

describe("Watch needs an open page (07.8-22)", () => {
  it("a browser step says whether its page is still open when the reply is served; sandbox steps never say", async () => {
    await s.su.query(
      "update app.agents set capabilities = capabilities || jsonb_build_object('browser', true) where id = $1",
      [s.scoutId],
    );
    const ev = await s.turnOf(s.sam, s.samDm);
    const browser = (name: string, body: Json = {}) =>
      s.cell(`/browser/${name}`, { eventId: ev.eventId, agentId: s.scoutId, ...body });
    // A page left open by an earlier test of this file would be reused: start from none.
    expect([200, 404]).toContain((await browser("close")).status);
    const opened = await ok(browser("open", { url: "https://panel.fake.test/app" }));
    await ok(write(ev, { path: "notes/watch.txt", content: "ok" }));
    const posted = await ok(reply(ev, "The panel is open."));

    const stepsOf = async () =>
      ((await listOf(s.sam, s.samDm)).find((m) => m.id === posted.messageId)?.activity?.steps ??
        []) as Json[];
    let steps = await stepsOf();
    const open = steps.find((x) => x.verb === "opened");
    expect(open).toMatchObject({ contextId: opened.contextId, contextOpen: true });
    expect(steps.find((x) => x.verb === "wrote")?.contextOpen).toBeUndefined();

    const next = await s.turnOf(s.sam, s.samDm);
    expect((await s.cell("/browser/close", { eventId: next.eventId, agentId: s.scoutId })).status).toBe(200);
    steps = await stepsOf();
    expect(steps.find((x) => x.verb === "opened")).toMatchObject({ contextOpen: false });
    // Never stored: the row keeps the step as recorded.
    const { rows } = await s.su.query("select steps from app.bot_turn_activity where event_id = $1", [
      ev.eventId,
    ]);
    expect(JSON.stringify(rows[0]?.steps)).not.toContain("contextOpen");
  });
});

describe("POST /agent-channel/v1/sandbox/write", () => {
  it("create on an existing path is 409 busy; a refused path is 422 invalid_path; over 1 MB is 413 too_large", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await ok(write(ev, { path: "once.txt", content: "a", mode: "create" }));
    const again = await write(ev, { path: "once.txt", content: "b", mode: "create" });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe("busy");
    for (const path of ["/etc/passwd", "../up.txt", "a//b", "a\\b"]) {
      const bad = await write(ev, { path, content: "x" });
      expect(bad.status, path).toBe(422);
      expect(codeOf(bad)).toBe("invalid_path");
    }
    const big = await write(ev, { path: "big.txt", content: "x".repeat(1_048_577) });
    expect(big.status).toBe(413);
    expect(codeOf(big)).toBe("too_large");
  });

  it("an allowed write is one sandbox.file_written audit with agent, user, event and size, never the content or the path", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await ok(write(ev, { path: "secret-plan.md", content: SENTINEL }));
    const rows = (
      await s.su.query(
        "select actor_kind, actor_id, agent_id, user_id, result, metadata from app.audit_events where action = 'sandbox.file_written' and metadata->>'eventId' = $1",
        [ev.eventId],
      )
    ).rows as Json[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: s.scoutId,
      agent_id: s.scoutId,
      user_id: s.samId,
      result: "success",
    });
    expect(rows[0]?.metadata).toMatchObject({ eventId: ev.eventId, size: SENTINEL.length, pathLength: 14 });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("secret-plan");
  });
});

describe("POST /agent-channel/v1/sandbox/share without object storage", () => {
  it("is 503 service_unavailable before the decision: recorded and shown blocked, never counted", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await ok(write(ev, { path: "report.txt", content: "r" }));
    const r = await s.cell("/sandbox/share", { eventId: ev.eventId, agentId: s.scoutId, path: "report.txt" });
    expect(r.status).toBe(503);
    expect(codeOf(r)).toBe("service_unavailable");
    const turn = (
      await s.su.query("select sandbox_calls from app.agent_turns where event_id = $1", [ev.eventId])
    ).rows[0];
    expect(turn.sandbox_calls).toBe(1);
    const ledger = (
      await s.su.query(
        "select decision, reason from app.agent_tool_calls where event_id = $1 and tool = 'ocw_sandbox_share'",
        [ev.eventId],
      )
    ).rows;
    expect(ledger).toEqual([{ decision: "denied", reason: "service_unavailable" }]);
    const steps = (
      await s.su.query("select steps from app.bot_turn_activity where event_id = $1", [ev.eventId])
    ).rows[0].steps as Json[];
    expect(steps.at(-1)).toMatchObject({
      verb: "blocked",
      target: "report.txt",
      outcome: { kind: "blocked", code: "service_unavailable" },
    });
  });
});
