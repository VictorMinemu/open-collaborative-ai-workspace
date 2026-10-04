import Fastify from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { type AuthzRegistry, installAuthz, markDecided } from "./authz";
import type { App } from "./core";

const apps: App[] = [];

async function miniApp(strict: boolean): Promise<{ app: App; registry: AuthzRegistry }> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as App;
  apps.push(app);
  const registry = installAuthz(app, { strict });
  app.get("/public", { config: { authz: "public" } }, async () => ({ ok: true }));
  app.get("/undeclared", async () => ({ ok: true }));
  app.get("/undecided", { config: { authz: "user" } }, async () => ({ ok: true }));
  app.get("/decided", { config: { authz: "user" } }, async (req) => {
    markDecided(req);
    return { ok: true };
  });
  app.get("/denied", { config: { authz: "user" } }, async (_req, reply) =>
    reply.status(403).send({ no: true }),
  );
  await app.register(
    async (scope) => {
      scope.post("/cell", { config: { authz: "cell" } }, async () => ({ ok: true }));
    },
    { prefix: "/api/v1" },
  );
  await app.ready();
  return { app, registry };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("route authz registry", () => {
  it("records every route with its declaration (undefined when absent), without HEAD twins", async () => {
    const { registry } = await miniApp(false);
    expect(registry.routes.get("GET /public")).toBe("public");
    expect(registry.routes.has("GET /undeclared")).toBe(true);
    expect(registry.routes.get("GET /undeclared")).toBeUndefined();
    expect(registry.routes.get("GET /undecided")).toBe("user");
    expect(registry.routes.get("POST /api/v1/cell")).toBe("cell");
    expect([...registry.routes.keys()].some((k) => k.startsWith("HEAD "))).toBe(false);
  });

  it("warn mode records a non-public 2xx answered without a decision and still answers", async () => {
    const { app, registry } = await miniApp(false);
    expect((await app.inject({ method: "GET", url: "/undecided" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/cell" })).statusCode).toBe(200);
    expect(registry.undecided).toEqual([
      { method: "GET", url: "/undecided", status: 200 },
      { method: "POST", url: "/api/v1/cell", status: 200 },
    ]);
  });

  it("strict mode turns an undecided 2xx into a 500", async () => {
    const { app, registry } = await miniApp(true);
    expect((await app.inject({ method: "GET", url: "/undecided" })).statusCode).toBe(500);
    expect(registry.undecided).toEqual([]);
  });

  it("decided routes, public routes, undeclared routes and non-2xx answers are not recorded", async () => {
    for (const strict of [false, true]) {
      const { app, registry } = await miniApp(strict);
      expect((await app.inject({ method: "GET", url: "/decided" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/public" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/undeclared" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/denied" })).statusCode).toBe(403);
      expect(registry.undecided).toEqual([]);
    }
  });
});
