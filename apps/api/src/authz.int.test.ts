import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { type AuthzMode, markDecided } from "./authz";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";

/**
 * SC3 / ORG-03 (02-15): no ad-hoc authorization check can be merged. Every route declares how it is
 * authorized, the public surface is an explicit allowlist, and in tests a non-public route that answers 2xx
 * without a resolver decision fails with a 500 (strict mode).
 */

/** The only routes that answer without a principal. Adding one is a reviewed change to this list. */
const PUBLIC_ROUTES = [
  "GET /health",
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-out",
  "GET /api/auth/get-session",
  "GET /api/auth/token",
  "GET /api/auth/jwks",
  "GET /api/v1/setup/status",
  "POST /api/v1/setup",
  "GET /api/v1/invitations/:id",
  "POST /api/v1/invitations/:id/accept",
  "GET /api/v1/auth/capabilities",
  "POST /api/v1/password-reset/request",
  "POST /api/v1/password-reset",
  "POST /api/v1/devices/enroll",
  // 07.4-10: the OAuth callback checks the member's session against the flow by hand; the CIMD document is public.
  "GET /api/v1/connectors/oauth/callback",
  "GET /api/v1/connectors/oauth/client-metadata.json",
].sort();

/** Framework documentation routes (Scalar / Swagger) carry no data and are excluded by prefix. */
const isDocs = (key: string) => / \/docs(\/|$)/.test(key);

let stack: TestStack;

beforeAll(async () => {
  stack = await startTestStack();
});
afterAll(async () => {
  await stack?.stop();
});

describe("route authorization coverage (strict in tests)", () => {
  it("runs in strict mode under NODE_ENV=test", () => {
    expect(stack.env.NODE_ENV).toBe("test");
    expect(stack.built.authz.strict).toBe(true);
  });

  it("every route declares config.authz", () => {
    const routes = [...stack.built.authz.routes].filter(([key]) => !isDocs(key));
    expect(routes.length).toBeGreaterThan(80);
    const undeclared = routes.filter(([, mode]) => mode === undefined).map(([key]) => key);
    expect(undeclared).toEqual([]);
  });

  it("the public routes equal the allowlist exactly", () => {
    const pub = [...stack.built.authz.routes]
      .filter(([key, mode]) => mode === "public" && !isDocs(key))
      .map(([key]) => key)
      .sort();
    expect(pub).toEqual(PUBLIC_ROUTES);
  });

  it("the three WebSocket routes declare their principal kind", () => {
    const modes = stack.built.authz.routes;
    expect(modes.get("GET /ws")).toBe<AuthzMode>("user");
    expect(modes.get("GET /runtime/ws")).toBe<AuthzMode>("device");
    expect(modes.get("GET /agent-channel/v1/ws")).toBe<AuthzMode>("cell");
  });

  it("a route that answers 2xx without a resolver decision fails with 500", async () => {
    const built = await buildApp(stack.env, { logger: false });
    try {
      built.app.get("/api/v1/zz-undecided", { config: { authz: "user" } }, async () => ({ ok: true }));
      built.app.get("/api/v1/zz-decided", { config: { authz: "user" } }, async (req) => {
        markDecided(req);
        return { ok: true };
      });
      await built.app.ready();
      expect((await built.app.inject({ method: "GET", url: "/api/v1/zz-undecided" })).statusCode).toBe(500);
      expect((await built.app.inject({ method: "GET", url: "/api/v1/zz-decided" })).statusCode).toBe(200);
      expect(built.authz.undecided).toEqual([]);
    } finally {
      await built.close();
    }
  });

  it("GET /api/v1/me still reports the organization role, read from org_members", async () => {
    const c = new TestClient(stack.baseUrl);
    const setup = await c.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    });
    expect(setup.status).toBe(200);
    // Cookie and Bearer JWT principals carry no role; both read it from the projection.
    expect((await c.request("GET", "/api/v1/me")).body).toMatchObject({ organization: { role: "admin" } });
    const jwt = await c.token();
    const bearer = await c.request("GET", "/api/v1/me", undefined, {
      noCookies: true,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(bearer.status).toBe(200);
    expect(bearer.body).toMatchObject({ organization: { role: "admin" } });
    expect(stack.built.authz.undecided).toEqual([]);
  });
});
