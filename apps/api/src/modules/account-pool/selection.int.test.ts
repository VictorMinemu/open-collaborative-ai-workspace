import { randomUUID } from "node:crypto";
import type { PoolProvider } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { sleep } from "../../testing-device";
import { invite, pairDevice } from "../../testing-workzone";
import { addClaudeToken, type PoolPorts, selectAccount, updatePoolPolicy } from "./index";

/**
 * `selectAccount` against the real database (Phase 07.18-09; D-04, D-06, PD-06, PD-07, PD-18; E1, E10): the
 * strategies, what is never chosen (disabled, removed, cooling, needs sign-in, another device's slot, another
 * organization's account), and two concurrent picks serialized on the policy row.
 */

const setupToken = (fill: string) => ["sk", "ant", "oat01", fill.repeat(48)].join("-");

let stack: TestStack;
let su: pg.Client;
let orgA = "";
let orgB = "";
let deviceX = "";
let deviceY = "";
let ports: PoolPorts;

const inOrg = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>) =>
  stack.built.core.db.withTenant({ organizationId, userId: null }, fn) as Promise<T>;

const add = (org: string, label: string, fill = label) =>
  inOrg(org, async (tx) => (await addClaudeToken(tx, ports, { label, token: setupToken(fill) })).id);

const pick = (org: string, provider: PoolProvider = "claude", deviceId: string | null = deviceX) =>
  inOrg(org, async (tx) => {
    const r = await selectAccount(tx, { provider, deviceId, consumer: "work_zone", now: new Date() });
    return "row" in r ? r.row.label : null;
  });

const strategy = (s: "failover" | "round_robin" | "weighted") =>
  inOrg(orgA, (tx) => updatePoolPolicy(tx, ports, "claude", { strategy: s }));

const set = (id: string, sql: string, params: unknown[] = []) =>
  su.query(`update app.account_pool_accounts set ${sql} where id = $1`, [id, ...params]);

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  ports = { audit: stack.built.core.audit, secrets: stack.built.core.secrets };
  const admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    name: "Víctor Ruiz",
    email: "victor@example.test",
    password: "correct-horse-battery",
    orgName: "Autofy Labs",
  });
  expect(setup.status).toBe(200);
  orgA = (setup.body!.organization as { id: string }).id;
  const { client: sam } = await invite(stack, admin, "sam@example.test", "Sam", "developer");
  deviceX = (await pairDevice(stack, sam, "X")).deviceId;
  deviceY = (await pairDevice(stack, sam, "Y")).deviceId;
  orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
    orgB,
    `other-${orgB}`,
  ]);
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

beforeEach(async () => {
  await su.query("update app.account_pool_accounts set removed_at = now() where removed_at is null");
  await su.query("delete from app.account_pool_policies");
});

describe("failover", () => {
  it("takes the first in the order; the next one only when the first may not serve", async () => {
    const a = await add(orgA, "A");
    await add(orgA, "B");
    expect(await pick(orgA)).toBe("A");
    expect(await pick(orgA)).toBe("A");
    await set(a, "enabled = false");
    expect(await pick(orgA)).toBe("B");
    await set(a, "enabled = true, cooldown_until = now() + interval '1 hour'");
    expect(await pick(orgA)).toBe("B");
    await set(a, "cooldown_until = now() - interval '1 second', credential_state = 'needs_sign_in'");
    expect(await pick(orgA)).toBe("B");
    await set(a, "credential_state = 'ok', removed_at = now()");
    expect(await pick(orgA)).toBe("B");
  });

  it("a token with scope bots never serves the Work Zone (PD-18)", async () => {
    await add(orgA, "A");
    await inOrg(orgA, (tx) => updatePoolPolicy(tx, ports, "claude", { scope: "bots" }));
    expect(await pick(orgA)).toBeNull();
  });
});

describe("round-robin and weighted", () => {
  it("round-robin: the least recently used, A then B", async () => {
    await add(orgA, "A");
    await add(orgA, "B");
    await strategy("round_robin");
    expect([await pick(orgA), await pick(orgA), await pick(orgA)]).toEqual(["A", "B", "A"]);
  });

  it("weighted 2/1 over three picks: A, B, A", async () => {
    await add(orgA, "A");
    const b = await add(orgA, "B");
    await su.query(
      "update app.account_pool_accounts set weight = 2 where label = 'A' and removed_at is null",
    );
    await set(b, "weight = 1");
    await strategy("weighted");
    expect([await pick(orgA), await pick(orgA), await pick(orgA)]).toEqual(["A", "B", "A"]);
  });

  it("two concurrent picks under round-robin take two different accounts (E1)", async () => {
    await add(orgA, "A");
    await add(orgA, "B");
    await strategy("round_robin");
    const slow = () =>
      inOrg(orgA, async (tx) => {
        const r = await selectAccount(tx, {
          provider: "claude",
          deviceId: deviceX,
          consumer: "work_zone",
          now: new Date(),
        });
        await sleep(200);
        return "row" in r ? r.row.label : null;
      });
    const labels = await Promise.all([slow(), slow()]);
    expect(new Set(labels)).toEqual(new Set(["A", "B"]));
  });
});

describe("never chosen", () => {
  it("a ChatGPT slot serves only its own device", async () => {
    await su.query(
      `insert into app.account_pool_accounts (organization_id, provider, kind, label, device_id, slot_id)
       values ($1, 'chatgpt', 'device_slot', 'Slot X', $2, $3)`,
      [orgA, deviceX, randomUUID()],
    );
    expect(await pick(orgA, "chatgpt", deviceY)).toBeNull();
    expect(await pick(orgA, "chatgpt", deviceX)).toBe("Slot X");
  });

  it("another organization's ready account is never chosen (E10)", async () => {
    await add(orgB, "B of other", "Z");
    expect(await pick(orgA)).toBeNull();
    expect(await pick(orgB)).toBe("B of other");
  });

  it("no usable account: the earliest reset among the cooling ones", async () => {
    const a = await add(orgA, "A");
    const b = await add(orgA, "B");
    await set(a, "cooldown_until = now() + interval '2 hours'");
    await set(b, "cooldown_until = $2", [new Date(Date.now() + 3_600_000).toISOString()]);
    const r = await inOrg(orgA, (tx) =>
      selectAccount(tx, { provider: "claude", deviceId: deviceX, consumer: "work_zone", now: new Date() }),
    );
    expect("none" in r && r.earliestReset?.toISOString()).toBe(
      (
        await su.query("select cooldown_until from app.account_pool_accounts where id = $1", [b])
      ).rows[0].cooldown_until.toISOString(),
    );
  });
});
