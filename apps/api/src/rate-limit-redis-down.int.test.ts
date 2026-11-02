import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";

/**
 * 07.6 review A HI-02: every rate-limited route counts in Redis, so losing Redis must not lock people out. With the
 * stack's Redis stopped, sign-in still answers at once and its limit still holds (counted in this instance's memory
 * until Redis is back), instead of hanging on the client's offline queue or failing with a 500.
 */

const ADMIN = {
  name: "Ada Admin",
  email: "ada@example.test",
  password: "correct-horse-battery",
  orgName: "Acme",
};
const LIMIT = 3;

let stack: TestStack;

async function signIn(password: string): Promise<{ status: number; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${stack.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3999" },
    body: JSON.stringify({ email: ADMIN.email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  await res.text();
  return { status: res.status, ms: Date.now() - started };
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_SIGNIN_RATE_LIMIT_PER_MINUTE: String(LIMIT) } });
  const setup = await new TestClient(stack.baseUrl).request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
  });
  expect(setup.status).toBe(200);
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

describe("rate-limited routes with Redis down (07.6 review A HI-02)", () => {
  it("sign-in answers quickly and its limit still applies while Redis is stopped", async () => {
    await stack.redis.stop();
    const ok = await signIn(ADMIN.password);
    expect(ok.status).toBe(200);
    expect(ok.ms).toBeLessThan(3_000);
    const answers: number[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const r = await signIn("definitely-the-wrong-one");
      expect(r.ms).toBeLessThan(3_000);
      answers.push(r.status);
    }
    // Four attempts in the window with a limit of three: the last is refused, not let through.
    expect(answers.slice(0, LIMIT - 1).every((s) => s === 401)).toBe(true);
    expect(answers.at(-1)).toBe(429);
  }, 60_000);
});
