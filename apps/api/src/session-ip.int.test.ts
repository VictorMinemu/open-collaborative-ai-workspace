import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";

/**
 * SELF-05 / D-18 (07-08): better-auth reads `X-Forwarded-For` by itself when it stores a session's IP (it trusts a
 * single-value header unless told otherwise), independently of Fastify's OCW_TRUST_PROXY. The API hands it the
 * client IP Fastify resolved instead, so the session list shows the same address as the sign-in audit and a client
 * reaching the API directly cannot plant one. Covered: setup, sign-in and invitation acceptance (every path that
 * creates a session).
 */

const ADMIN = {
  name: "Ada Admin",
  email: "ada-ip@example.test",
  password: "correct-horse-battery",
  orgName: "Acme",
};
const SPOOFED = "203.0.113.77";
const OTHER = "198.51.100.9";
const THIRD = "192.0.2.44";

async function sessionIp(stack: TestStack, email: string): Promise<string | null> {
  const su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  try {
    const { rows } = await su.query<{ ip: string | null }>(
      `select s.ip_address as ip from auth.session s join auth."user" u on u.id = s.user_id
        where u.email = $1 order by s.created_at desc limit 1`,
      [email],
    );
    return rows[0]?.ip ?? null;
  } finally {
    await su.end();
  }
}

/** Setup, a second sign-in and an invitation acceptance, each with its own forged X-Forwarded-For. */
async function exercise(stack: TestStack) {
  const admin = new TestClient(stack.baseUrl);
  const setup = await admin.request(
    "POST",
    "/api/v1/setup",
    { token: TEST_SETUP_TOKEN, ...ADMIN },
    { headers: { "x-forwarded-for": SPOOFED } },
  );
  expect(setup.status).toBe(200);
  const setupIp = await sessionIp(stack, ADMIN.email);

  const again = new TestClient(stack.baseUrl);
  const signIn = await again.request(
    "POST",
    "/api/auth/sign-in/email",
    { email: ADMIN.email, password: ADMIN.password },
    { headers: { "x-forwarded-for": OTHER } },
  );
  expect(signIn.status).toBe(200);
  const signInIp = await sessionIp(stack, ADMIN.email);

  const invitee = `invitee-${Date.now()}@example.test`;
  const inv = await admin.request("POST", "/api/v1/invitations", { email: invitee, role: "standard" });
  expect(inv.status).toBe(200);
  const accepted = await new TestClient(stack.baseUrl).request(
    "POST",
    `/api/v1/invitations/${(inv.body as { id: string }).id}/accept`,
    { name: "Ivy Invitee", password: "a-long-enough-password" },
    { headers: { "x-forwarded-for": THIRD } },
  );
  expect(accepted.status).toBe(200);
  const inviteIp = await sessionIp(stack, invitee);
  return { setupIp, signInIp, inviteIp };
}

describe("session IP with OCW_TRUST_PROXY unset (API reached directly)", () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("stores the connection's address, never a forged X-Forwarded-For", async () => {
    const ips = await exercise(stack);
    expect(ips).toEqual({ setupIp: "127.0.0.1", signInIp: "127.0.0.1", inviteIp: "127.0.0.1" });
  });
});

describe("session IP with OCW_TRUST_PROXY=1 (behind Caddy)", () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack({ env: { OCW_TRUST_PROXY: "1" } });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("stores the client IP the proxy forwarded, like the sign-in audit", async () => {
    const ips = await exercise(stack);
    expect(ips).toEqual({ setupIp: SPOOFED, signInIp: OTHER, inviteIp: THIRD });
  });
});
