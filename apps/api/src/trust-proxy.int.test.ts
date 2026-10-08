import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";

/**
 * SELF-05 / D-18 (T-07-05-03): the client IP comes from X-Forwarded-For only when OCW_TRUST_PROXY says so. A forged
 * header must not change the IP in the sign-in audit nor give a client a fresh sign-in rate-limit bucket.
 */

const ADMIN = {
  name: "Ada Admin",
  email: "ada@example.test",
  password: "correct-horse-battery",
  orgName: "Acme",
};
const SPOOFED = "203.0.113.77";
const OTHER = "198.51.100.9";
/** Low enough to reach in a test; each stack starts with a fresh Redis, so buckets start empty. */
const LIMIT = 3;

async function failedSignIn(stack: TestStack, xff: string) {
  const res = await fetch(`${stack.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3999", "x-forwarded-for": xff },
    body: JSON.stringify({ email: ADMIN.email, password: "definitely-the-wrong-one" }),
  });
  return res.status;
}

async function auditedIps(stack: TestStack): Promise<unknown[]> {
  const su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  try {
    const { rows } = await su.query<{ ip: unknown }>(
      "select metadata->'ip' as ip from app.audit_events where action = 'user.sign_in_failed' order by occurred_at",
    );
    return rows.map((r) => r.ip);
  } finally {
    await su.end();
  }
}

async function bootstrap(env: Record<string, string>) {
  const stack = await startTestStack({ env: { OCW_SIGNIN_RATE_LIMIT_PER_MINUTE: String(LIMIT), ...env } });
  const setup = await new TestClient(stack.baseUrl).request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
  });
  expect(setup.status).toBe(200);
  return stack;
}

describe("OCW_TRUST_PROXY unset (default false)", () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await bootstrap({});
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("ignores a forged X-Forwarded-For in the sign-in audit", async () => {
    expect(await failedSignIn(stack, SPOOFED)).toBe(401);
    const ips = await auditedIps(stack);
    expect(ips).toHaveLength(1);
    expect(typeof ips[0]).toBe("string");
    expect(ips[0]).not.toBe(SPOOFED);
  });

  it("keeps one rate-limit bucket per connection whatever the header says", async () => {
    // One attempt was spent above; rotating the forged address does not open a new bucket.
    expect(await failedSignIn(stack, OTHER)).toBe(401);
    expect(await failedSignIn(stack, "192.0.2.1")).toBe(401);
    expect(await failedSignIn(stack, "192.0.2.2")).toBe(429);
  });
});

describe("OCW_TRUST_PROXY=1 (one hop, behind Caddy)", () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await bootstrap({ OCW_TRUST_PROXY: "1" });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("records the proxy-supplied client IP in the sign-in audit", async () => {
    expect(await failedSignIn(stack, SPOOFED)).toBe(401);
    expect(await auditedIps(stack)).toEqual([SPOOFED]);
  });

  it("keys the sign-in rate limit on that client IP", async () => {
    expect(await failedSignIn(stack, SPOOFED)).toBe(401);
    expect(await failedSignIn(stack, SPOOFED)).toBe(401);
    expect(await failedSignIn(stack, SPOOFED)).toBe(429);
    // Another client behind the same proxy has its own bucket.
    expect(await failedSignIn(stack, OTHER)).toBe(401);
  });
});
