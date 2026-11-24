import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { invite, pairDevice } from "../../testing-workzone";
import type { DeviceAccountHandler } from "../device";

/**
 * Phase 07.18-10 (D-09, PD-09, E10, E11): usage readings a runtime reports reach the pool only for an account a live
 * session of the reporting device uses, or a slot of that very device; the device's other account frames reach the one
 * account handler, and acks of `account.*` commands go to it, never to the session handler.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const setupToken = (fill: string) => ["sk", "ant", "oat01", fill.repeat(48)].join("-");

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let orgId: string;

interface Dev {
  device: FakeDevice;
  deviceId: string;
  projectId: string;
}
let mine: Dev;
let theirs: Dev;

async function ok(res: Promise<{ status: number; body: Json | null }>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function connectDevice(name: string, project: string): Promise<Dev> {
  const paired = await pairDevice(stack, sam, name);
  const device = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, { accountPool: 1 });
  device.send({
    type: "projects.sync",
    projects: [{ localId: `lp_${project}`, name: project, gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  const projects = (await ok(sam.request("GET", "/api/v1/projects"))).projects as Json[];
  return { device, deviceId: paired.deviceId, projectId: projects.find((p) => p.name === project)!.id };
}

const addToken = async (label: string, fill: string) =>
  (
    await ok(
      victor.request("POST", "/api/v1/account-pool/claude/accounts", { label, token: setupToken(fill) }),
    )
  ).id as string;

/** A live session on `dev` (on the pool's first ready account). */
async function liveSession(dev: Dev): Promise<string> {
  const session = await ok(
    sam.request("POST", "/api/v1/work-sessions", { projectId: dev.projectId, runtime: "claude-code" }),
  );
  const frame = await dev.device.command("session.start", session.id);
  dev.device.ack(frame.id);
  dev.device.event(session.id, { type: "session.state", status: "idle" });
  await eventually(
    async () =>
      (await su.query("select status from app.work_sessions where id = $1", [session.id])).rows[0]
        ?.status === "idle",
  );
  return session.id as string;
}

const usageOf = async (id: string) =>
  (await su.query("select usage, usage_at from app.account_pool_accounts where id = $1", [id])).rows[0] as Json;

const insertSlot = async (deviceId: string, label: string) => {
  const slotId = randomUUID();
  const id = (
    await su.query(
      "insert into app.account_pool_accounts (organization_id, provider, kind, label, device_id, slot_id) values ($1, 'chatgpt', 'device_slot', $2, $3, $4) returning id",
      [orgId, label, deviceId, slotId],
    )
  ).rows[0].id as string;
  return { id, slotId };
};

const snapshot = (usedPercent: number) => ({
  windows: [
    { kind: "five_hour", usedPercent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    { kind: "seven_day", usedPercent: 12, resetsAt: null },
  ],
  at: new Date().toISOString(),
});

/** Every frame `dev` sent before this returns has been handled (one link, frames in order). */
async function settle(dev: Dev, sessionId: string) {
  const marker = `marker-${randomUUID()}`;
  dev.device.event(sessionId, { type: "assistant.message", messageId: marker, text: marker });
  await eventually(async () => {
    const r = await su.query(
      "select 1 from app.stream_events where stream_id = $1 and payload->'event'->>'messageId' = $2",
      [`ws:${sessionId}`, marker],
    );
    return r.rows.length > 0;
  });
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: sam } = await invite(stack, victor, "sam@example.test", "Sam", "developer"));
  mine = await connectDevice("Mine", "mine-repo");
  theirs = await connectDevice("Theirs", "theirs-repo");
  orgId = (await su.query("select organization_id from app.devices where id = $1", [mine.deviceId])).rows[0]
    .organization_id as string;
}, 180_000);

afterAll(async () => {
  for (const d of [mine, theirs]) await d?.device.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

beforeEach(async () => {
  await su.query("update app.account_pool_accounts set removed_at = now() where removed_at is null");
});

describe("account.usage reaches the pool only for what the device's own sessions use (D-09, PD-09, E11)", () => {
  it("a token account a live session of this device uses: stored with its time, shown to admins", async () => {
    const a = await addToken("A", "A");
    const id = await liveSession(mine);
    const usage = snapshot(64);
    const before = Date.now();
    mine.device.send({ type: "account.usage", accountId: a, usage });
    await settle(mine, id);
    const row = await usageOf(a);
    expect(row.usage).toEqual(usage);
    expect(new Date(row.usage_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const view = await ok(victor.request("GET", "/api/v1/account-pool"));
    expect((view.claude.accounts as Json[]).find((x) => x.id === a)?.usage).toEqual(usage);
  });

  it("a slot of this device: stored; a slot of another device: nothing", async () => {
    await addToken("A", "A");
    const id = await liveSession(mine);
    const own = await insertSlot(mine.deviceId, "Own slot");
    const foreign = await insertSlot(theirs.deviceId, "Their slot");
    mine.device.send({ type: "account.usage", slotId: own.slotId, usage: snapshot(30) });
    mine.device.send({ type: "account.usage", slotId: foreign.slotId, usage: snapshot(99) });
    await settle(mine, id);
    expect((await usageOf(own.id)).usage).toEqual(expect.objectContaining({ windows: snapshot(30).windows }));
    expect(await usageOf(foreign.id)).toEqual({ usage: null, usage_at: null });
  });

  it("an account no session of this device uses, or another organization's: nothing stored (E10)", async () => {
    const a = await addToken("A", "A");
    const b = await addToken("B", "B");
    const id = await liveSession(mine);
    // B serves a session on the other device only.
    await su.query("update app.account_pool_accounts set enabled = false where id = $1", [a]);
    const onTheirs = await liveSession(theirs);
    expect(
      (await su.query("select pool_account_id from app.work_sessions where id = $1", [onTheirs])).rows[0]
        .pool_account_id,
    ).toBe(b);
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `other-${orgB}`,
    ]);
    const foreign = (
      await su.query(
        "insert into app.account_pool_accounts (organization_id, provider, kind, label, cell_profile_id) values ($1, 'chatgpt', 'cell_profile', 'Theirs', 'openai:theirs-usage') returning id",
        [orgB],
      )
    ).rows[0].id as string;
    mine.device.send({ type: "account.usage", accountId: b, usage: snapshot(50) });
    mine.device.send({ type: "account.usage", accountId: foreign, usage: snapshot(50) });
    await settle(mine, id);
    expect(await usageOf(b)).toEqual({ usage: null, usage_at: null });
    expect(await usageOf(foreign)).toEqual({ usage: null, usage_at: null });
  });
});

describe("the device's account frames have one handler (PD-09)", () => {
  it("accounts.sync and account.login reach the handler when it has them, and are ignored when not", async () => {
    await addToken("A", "A");
    const id = await liveSession(mine);
    const hub = stack.built.deviceHub;
    const wired = hub.accountHandler;
    expect(wired).not.toBeNull();
    const slotId = randomUUID();
    const sync = { type: "accounts.sync", codexSlots: [] };
    const login = { type: "account.login", requestId: randomUUID(), slotId, phase: "failed" };

    // The default handler (no slots, no sign-ins yet: plan 13) ignores both; the link stays up.
    mine.device.send(sync);
    mine.device.send(login);
    await settle(mine, id);
    expect(mine.device.closed).toBe(false);

    const seen: string[] = [];
    const spy: DeviceAccountHandler = {
      ...wired,
      onAccountsSync: async (device, frame) => {
        seen.push(`${device.deviceId}:${frame.type}:${frame.codexSlots.length}`);
      },
      onAccountLogin: async (device, frame) => {
        seen.push(`${device.deviceId}:${frame.type}:${frame.slotId}`);
      },
    };
    hub.setAccountHandler(spy);
    try {
      mine.device.send(sync);
      mine.device.send(login);
      await settle(mine, id);
      expect(seen).toEqual([`${mine.deviceId}:accounts.sync:0`, `${mine.deviceId}:account.login:${slotId}`]);
    } finally {
      if (wired) hub.setAccountHandler(wired);
    }
  });

  it("an ack of an account.login or account.logout command reaches onAccountCommandResult, never the session handler", async () => {
    const hub = stack.built.deviceHub;
    const wired = hub.accountHandler;
    const results: Array<{ kind: string; ok: boolean; error: string | null }> = [];
    hub.setAccountHandler({
      ...wired,
      onAccountCommandResult: async (_device, command, okAck, error) => {
        results.push({ kind: command.kind, ok: okAck, error });
      },
    });
    const sessions = hub.sessionHandler!;
    const onCommandResult = vi.spyOn(sessions, "onCommandResult");
    try {
      const slotId = randomUUID();
      await stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
        await hub.enqueue(tx, {
          deviceId: mine.deviceId,
          workSessionId: null,
          kind: "account.login",
          payload: { provider: "chatgpt", slotId, label: "ops" },
        });
        await hub.enqueue(tx, {
          deviceId: mine.deviceId,
          workSessionId: null,
          kind: "account.logout",
          payload: { slotId },
        });
      });
      const loginCmd = await mine.device.next((f) => f.type === "command" && f.kind === "account.login");
      const logoutCmd = await mine.device.next((f) => f.type === "command" && f.kind === "account.logout");
      mine.device.ack(loginCmd.id as string);
      mine.device.ack(logoutCmd.id as string, false, "not signed in");
      await eventually(async () => results.length === 2);
      expect(results).toEqual([
        { kind: "account.login", ok: true, error: null },
        { kind: "account.logout", ok: false, error: "not signed in" },
      ]);
      expect(
        onCommandResult.mock.calls.filter(([, cmd]) => cmd.kind === "account.login" || cmd.kind === "account.logout"),
      ).toHaveLength(0);
    } finally {
      onCommandResult.mockRestore();
      if (wired) hub.setAccountHandler(wired);
    }
  });
});
