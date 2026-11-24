import { randomUUID } from "node:crypto";
import type { AccountsSyncFrame, AccountUsageSnapshot } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { pairDevice } from "../../testing-workzone";
import { applySlotsSync, selectAccount } from "./index";

/**
 * Phase 07.18-13 (D-02, D-09, D-13, PD-11, PD-25, E11, E13): a device's `accounts.sync` keeps its slot rows in step.
 * A slot nobody started from Settings arrives disabled (`origin: device_cli`) and only an admin makes it usable, on
 * that device only; a slot that disappears leaves the pool; the credential state, plan and usage follow the report;
 * another device's or organization's slots never change; an unchanged sync writes nothing.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

let stack: TestStack;
let su: pg.Client;
let victor: TestClient; // admin of org A
let eve: TestClient; // admin of org B
let orgA = "";
let orgB = "";

interface Dev {
  device: FakeDevice;
  deviceId: string;
}
let d: Dev; // service device of org A
let e: Dev; // another service device of org A
let f: Dev; // a device of org B

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function connect(owner: TestClient, name: string): Promise<Dev> {
  const paired = await pairDevice(stack, owner, name);
  const device = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, {
    host: "service",
    accountPool: 1,
  });
  return { device, deviceId: paired.deviceId };
}

const report = (slotId: string, label: string, over: Json = {}) => ({
  slotId,
  label,
  origin: "cli",
  signedIn: true,
  planType: "pro",
  usage: null,
  ...over,
});

const sync = (dev: Dev, codexSlots: Json[]) => dev.device.send({ type: "accounts.sync", codexSlots });

const slotRows = async (deviceId: string, live = true) =>
  (
    await su.query(
      `select * from app.account_pool_accounts where device_id = $1 ${live ? "and removed_at is null" : ""} order by created_at, id`,
      [deviceId],
    )
  ).rows as Json[];

const rowBySlot = async (deviceId: string, slotId: string) =>
  (
    await su.query(
      "select * from app.account_pool_accounts where device_id = $1 and slot_id = $2 order by created_at desc limit 1",
      [deviceId, slotId],
    )
  ).rows[0] as Json | undefined;

const auditFor = async (org: string, resourceId: string) =>
  (
    await su.query(
      "select action, device_id, metadata from app.audit_events where organization_id = $1 and resource_id = $2 order by occurred_at, id",
      [org, resourceId],
    )
  ).rows as Json[];

const inOrgA = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  stack.built.core.db.withTenant({ organizationId: orgA, userId: null }, fn);

const snapshot = (usedPercent: number): AccountUsageSnapshot => ({
  windows: [{ kind: "primary", usedPercent, resetsAt: "2026-12-01T10:00:00.000Z" }],
  at: "2026-11-24T10:00:00.000Z",
});

async function joinAs(email: string, name: string) {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgA = setup.organization.id;
  let eveId: string;
  [eve, eveId] = await joinAs("eve@example.test", "Eve Black");
  orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);

  d = await connect(victor, "Build server D");
  e = await connect(victor, "Build server E");
  f = await connect(eve, "Evil server F");
}, 240_000);

afterAll(async () => {
  for (const dev of [d, e, f]) await dev?.device.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

beforeEach(async () => {
  // Each case starts from devices without slots (the sync is the device's whole list).
  for (const dev of [d, e, f]) sync(dev, []);
  await eventually(async () => {
    const r = await su.query(
      "select count(*)::int as n from app.account_pool_accounts where kind = 'device_slot' and removed_at is null",
    );
    return r.rows[0].n === 0;
  });
});

describe("a device's slots and the pool stay in step (07.18-13 T2)", () => {
  it("a slot nobody started arrives disabled (device_cli), audited slot_reported; enabled, it serves only its device", async () => {
    const slotId = randomUUID();
    sync(d, [report(slotId, "cli@acme")]);
    const row = await eventually(() => rowBySlot(d.deviceId, slotId));
    expect(row).toMatchObject({
      provider: "chatgpt",
      kind: "device_slot",
      label: "cli@acme",
      enabled: false,
      origin: "device_cli",
      credential_state: "ok",
      plan_type: "pro",
      removed_at: null,
    });
    const audit = await auditFor(orgA, row.id);
    expect(audit.map((a) => a.action)).toEqual(["account_pool.account_added", "account_pool.slot_reported"]);
    expect(audit[1]).toMatchObject({
      device_id: d.deviceId,
      metadata: {
        provider: "chatgpt",
        deviceId: d.deviceId,
        slotId,
        label: "cli@acme",
        origin: "device_cli",
      },
    });

    // Disabled: never selected, on any device.
    const none = await inOrgA((tx) =>
      selectAccount(tx, {
        provider: "chatgpt",
        deviceId: d.deviceId,
        consumer: "work_zone",
        now: new Date(),
      }),
    );
    expect("none" in none && none.none).toBe(true);

    await ok(victor.request("PATCH", `/api/v1/account-pool/accounts/${row.id}`, { enabled: true }));
    const onD = await inOrgA((tx) =>
      selectAccount(tx, {
        provider: "chatgpt",
        deviceId: d.deviceId,
        consumer: "work_zone",
        now: new Date(),
      }),
    );
    expect("row" in onD ? onD.row.id : null).toBe(row.id);
    const onE = await inOrgA((tx) =>
      selectAccount(tx, {
        provider: "chatgpt",
        deviceId: e.deviceId,
        consumer: "work_zone",
        now: new Date(),
      }),
    );
    expect("none" in onE && onE.none).toBe(true);
  });

  it("a slot that disappears from the sync leaves the pool, audited account_removed (device_reported)", async () => {
    const keep = randomUUID();
    const gone = randomUUID();
    sync(d, [report(keep, "keep@acme"), report(gone, "gone@acme")]);
    const goneRow = await eventually(() => rowBySlot(d.deviceId, gone));
    await eventually(() => rowBySlot(d.deviceId, keep));

    sync(d, [report(keep, "keep@acme")]);
    const removed = await eventually(async () => {
      const r = await rowBySlot(d.deviceId, gone);
      return r?.removed_at ? r : undefined;
    });
    expect(removed.id).toBe(goneRow.id);
    expect((await rowBySlot(d.deviceId, keep))?.removed_at).toBeNull();
    const audit = await auditFor(orgA, goneRow.id);
    expect(audit.at(-1)).toMatchObject({
      action: "account_pool.account_removed",
      device_id: d.deviceId,
      metadata: { provider: "chatgpt", kind: "device_slot", reason: "device_reported", label: "gone@acme" },
    });
    const pool = await ok(victor.request("GET", "/api/v1/account-pool"));
    expect((pool.chatgpt.accounts as Json[]).map((a) => a.id)).not.toContain(goneRow.id);
  });

  it("signedIn false needs a sign-in, true is ok again; plan and usage are stored; an admin's label is kept", async () => {
    const slotId = randomUUID();
    sync(d, [report(slotId, "device-label")]);
    const row = await eventually(() => rowBySlot(d.deviceId, slotId));
    // The admin renames and enables it: the device's label never replaces the admin's.
    await ok(
      victor.request("PATCH", `/api/v1/account-pool/accounts/${row.id}`, {
        label: "Ops team",
        enabled: true,
      }),
    );

    sync(d, [report(slotId, "device-label", { signedIn: false })]);
    await eventually(async () => (await rowBySlot(d.deviceId, slotId))?.credential_state === "needs_sign_in");
    const pool = await ok(victor.request("GET", "/api/v1/account-pool"));
    expect((pool.chatgpt.accounts as Json[]).find((a) => a.id === row.id)?.status).toBe("needs_sign_in");

    sync(d, [report(slotId, "another-label", { signedIn: true, planType: "plus", usage: snapshot(42) })]);
    const back = await eventually(async () => {
      const r = await rowBySlot(d.deviceId, slotId);
      return r?.credential_state === "ok" && r.plan_type === "plus" ? r : undefined;
    });
    expect(back.label).toBe("Ops team");
    expect(back.usage).toEqual(snapshot(42));
    expect(back.usage_at).not.toBeNull();
    const actions = (await auditFor(orgA, row.id)).map((a) => a.action);
    expect(actions.filter((a) => a === "account_pool.account_updated").length).toBeGreaterThanOrEqual(3);
  });

  it("a sync from device E naming D's slots changes D's rows not at all; one from another organization never touches A", async () => {
    const slotId = randomUUID();
    sync(d, [report(slotId, "d@acme")]);
    const dRow = await eventually(() => rowBySlot(d.deviceId, slotId));

    sync(e, [report(slotId, "e@acme", { signedIn: false })]);
    sync(e, [report(slotId, "e@acme", { signedIn: true, planType: "team" })]);
    const eRow = await eventually(() => rowBySlot(e.deviceId, slotId));
    expect(eRow.id).not.toBe(dRow.id);
    expect(eRow.label).toBe("e@acme");

    sync(f, [report(slotId, "evil@acme", { planType: "enterprise" })]);
    const fRow = await eventually(() => rowBySlot(f.deviceId, slotId));
    expect(fRow.organization_id).toBe(orgB);

    const dNow = await rowBySlot(d.deviceId, slotId);
    expect(dNow).toEqual(dRow);
    const aSlots = (
      await su.query("select device_id from app.account_pool_accounts where organization_id = $1", [orgA])
    ).rows.map((r) => r.device_id as string);
    expect(aSlots).not.toContain(f.deviceId);
    const pool = await ok(eve.request("GET", "/api/v1/account-pool"));
    expect((pool.chatgpt.accounts as Json[]).map((a) => a.id)).toEqual([fRow.id]);
  });

  it("the same sync twice writes nothing the second time; a running sign-in's slot and an unknown signed-out slot are left alone", async () => {
    const slotId = randomUUID();
    const frame: AccountsSyncFrame = {
      type: "accounts.sync",
      codexSlots: [
        {
          slotId,
          label: "same@acme",
          origin: "cli",
          signedIn: true,
          planType: "pro",
          usage: snapshot(10),
        },
      ],
    };
    const first = await inOrgA((tx) => applySlotsSync(tx, stack.built.core.audit, d, frame));
    expect(first.created.length).toBe(1);
    const before = await rowBySlot(d.deviceId, slotId);
    const auditBefore = await auditFor(orgA, before!.id);

    const second = await inOrgA((tx) => applySlotsSync(tx, stack.built.core.audit, d, frame));
    expect(second).toEqual({ created: [], updated: [], removed: [] });
    expect(await rowBySlot(d.deviceId, slotId)).toEqual(before);
    expect(await auditFor(orgA, before!.id)).toEqual(auditBefore);

    const signingIn = randomUUID();
    const signedOut = randomUUID();
    const third = await inOrgA((tx) =>
      applySlotsSync(
        tx,
        stack.built.core.audit,
        d,
        {
          type: "accounts.sync",
          codexSlots: [
            ...frame.codexSlots,
            { ...frame.codexSlots[0]!, slotId: signingIn, origin: "server" },
            { ...frame.codexSlots[0]!, slotId: signedOut, signedIn: false },
          ],
        },
        { signingIn: new Set([signingIn]) },
      ),
    );
    expect(third).toEqual({ created: [], updated: [], removed: [] });
    expect(await rowBySlot(d.deviceId, signingIn)).toBeUndefined();
    expect(await rowBySlot(d.deviceId, signedOut)).toBeUndefined();
    expect((await slotRows(d.deviceId)).length).toBe(1);
  });
});
