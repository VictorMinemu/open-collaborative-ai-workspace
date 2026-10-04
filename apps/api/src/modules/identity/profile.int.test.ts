import type { ServerFrame } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

let stack: TestStack;
let su: pg.Client;
let orgId: string;
let alexId: string;
let admin: TestClient;
let alex: TestClient;
let generalId: string;
let messageId: string;

// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed JSON bodies
const body = (r: { body: unknown }) => r.body as any;

const streamRows = async (afterSeq: number) =>
  (
    await su.query(
      "select seq, type, payload from app.stream_events where stream_id = $1 and seq > $2 order by seq",
      [`org:${orgId}`, afterSeq],
    )
  ).rows as Array<{ seq: string | number; type: string; payload: unknown }>;

const lastStreamSeq = async () =>
  Number(
    (
      await su.query("select coalesce(max(seq), 0)::int as n from app.stream_events where stream_id = $1", [
        `org:${orgId}`,
      ])
    ).rows[0].n,
  );

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
  expect(setup.status).toBe(200);
  orgId = body(setup).organization.id;

  const inv = await admin.request("POST", "/api/v1/invitations", {
    email: "alex@example.test",
    role: "developer",
  });
  alex = new TestClient(stack.baseUrl);
  const accepted = await alex.request("POST", `/api/v1/invitations/${body(inv).id}/accept`, {
    name: "Alex Kim",
    password: "another-long-password",
  });
  expect(accepted.status).toBe(200);
  alexId = body(accepted).user.id;

  const channels = await admin.request("GET", "/api/v1/channels");
  generalId = body(channels).channels[0].id;
  const posted = await alex.request("POST", `/api/v1/conversations/${generalId}/messages`, {
    body: "hello all",
  });
  expect(posted.status).toBe(200);
  messageId = body(posted).id;
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("my profile (ORG-06)", () => {
  it("reads the profile", async () => {
    const res = await alex.request("GET", "/api/v1/me/profile");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: alexId,
      displayName: "Alex Kim",
      email: "alex@example.test",
      avatarUrl: null,
      statusEmoji: null,
      statusText: null,
      role: "developer",
    });
  });

  it("edits name, avatar and status; chat, the directory, audit and member.updated all follow", async () => {
    const before = await lastStreamSeq();
    const frames: ServerFrame[] = [];
    const stop = await stack.built.core.realtime.listen(`org:${orgId}`, (f) => frames.push(f));
    try {
      const res = await alex.request("PATCH", "/api/v1/me/profile", {
        displayName: "Alex K.",
        avatarUrl: "🦊",
        statusEmoji: "🌴",
        statusText: "Back Monday",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        userId: alexId,
        displayName: "Alex K.",
        avatarUrl: "🦊",
        statusEmoji: "🌴",
        statusText: "Back Monday",
        role: "developer",
      });

      const u = (await su.query("select name, image from auth.user where id = $1", [alexId])).rows[0];
      expect(u).toEqual({ name: "Alex K.", image: "🦊" });
      const m = (
        await su.query(
          "select display_name, avatar_url, status_emoji, status_text from app.org_members where user_id = $1",
          [alexId],
        )
      ).rows[0];
      expect(m).toEqual({
        display_name: "Alex K.",
        avatar_url: "🦊",
        status_emoji: "🌴",
        status_text: "Back Monday",
      });

      const members = body(await admin.request("GET", "/api/v1/members")).members as Array<
        Record<string, unknown>
      >;
      expect(members.find((x) => x.userId === alexId)).toMatchObject({
        displayName: "Alex K.",
        statusEmoji: "🌴",
        statusText: "Back Monday",
      });

      const page = body(await admin.request("GET", `/api/v1/conversations/${generalId}/messages`));
      const msg = (page.messages as Array<{ id: string; author: { displayName: string } }>).find(
        (x) => x.id === messageId,
      );
      expect(msg?.author.displayName).toBe("Alex K.");

      const audit = (
        await su.query(
          "select organization_id, user_id, resource_id, metadata from app.audit_events where action = 'user.profile_updated'",
        )
      ).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ organization_id: orgId, user_id: alexId, resource_id: alexId });
      const changed = ["avatarUrl", "displayName", "statusEmoji", "statusText"];
      expect([...audit[0].metadata.fields].sort()).toEqual(changed);

      // Exactly one member.updated row, appended after the PATCH, with the changed field names.
      const rows = await streamRows(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("member.updated");
      expect(Number(rows[0]?.seq)).toBeGreaterThan(before);
      const payload = rows[0]?.payload as { userId: string; changed: string[] };
      expect(payload.userId).toBe(alexId);
      expect([...payload.changed].sort()).toEqual(changed);

      // The live listener got the same frame.
      await until(() => frames.some((f) => f.op === "ev" && f.type === "member.updated"));
      const frame = frames.find((f) => f.op === "ev" && f.type === "member.updated");
      expect(frame).toMatchObject({ op: "ev", topic: `org:${orgId}`, seq: Number(rows[0]?.seq) });
      expect((frame as { data: unknown }).data).toEqual(payload);
    } finally {
      await stop();
    }
  });

  it("rejects non-https or script avatars and emits nothing", async () => {
    const before = await lastStreamSeq();
    for (const avatarUrl of [
      "http://tracker.example/x.png",
      "javascript:alert(1)",
      "data:image/png;base64,AA",
    ]) {
      const res = await alex.request("PATCH", "/api/v1/me/profile", { avatarUrl });
      expect(res.status, avatarUrl).toBe(400);
      expect(body(res).error.code).toBe("validation_error");
    }
    expect((await alex.request("PATCH", "/api/v1/me/profile", {})).status).toBe(400);
    expect(await streamRows(before)).toEqual([]);
  });

  it("an https avatar works, and null clears status", async () => {
    const res = await alex.request("PATCH", "/api/v1/me/profile", {
      avatarUrl: "https://images.example.test/alex.png",
      statusEmoji: null,
      statusText: null,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      avatarUrl: "https://images.example.test/alex.png",
      statusEmoji: null,
      statusText: null,
    });
    const audit = (
      await su.query(
        "select metadata from app.audit_events where action = 'user.profile_updated' order by occurred_at desc limit 1",
      )
    ).rows[0];
    expect([...audit.metadata.fields].sort()).toEqual(["avatarUrl", "statusEmoji", "statusText"]);
  });

  it("an unchanged PATCH writes no audit and no event", async () => {
    const before = await lastStreamSeq();
    const audits = async () =>
      Number(
        (
          await su.query(
            "select count(*)::int as n from app.audit_events where action = 'user.profile_updated'",
          )
        ).rows[0].n,
      );
    const n = await audits();
    const res = await alex.request("PATCH", "/api/v1/me/profile", { displayName: "Alex K." });
    expect(res.status).toBe(200);
    expect(await audits()).toBe(n);
    expect(await streamRows(before)).toEqual([]);
  });

  it("requires a signed-in user and declares authz", async () => {
    const anon = new TestClient(stack.baseUrl);
    expect((await anon.request("GET", "/api/v1/me/profile")).status).toBe(401);
    expect((await anon.request("PATCH", "/api/v1/me/profile", { displayName: "x" })).status).toBe(401);
    expect(stack.built.authz.routes.get("GET /api/v1/me/profile")).toBe("user");
    expect(stack.built.authz.routes.get("PATCH /api/v1/me/profile")).toBe("user");
    expect(stack.built.authz.undecided.map((u) => u.url)).not.toContain("/api/v1/me/profile");
  });
});
