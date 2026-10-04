import type { FastifyRequest } from "fastify";
import type { App } from "./core";

/**
 * Route authorization declarations (ORG-03, research §Pattern 4). Every route declares `config.authz`:
 * `public` (no principal), or the principal kind whose request the permission resolver decides.
 */
export type AuthzMode = "public" | "user" | "cell" | "device";

declare module "fastify" {
  interface FastifyContextConfig {
    authz?: AuthzMode;
  }
  interface FastifyRequest {
    /** Set by the permission service once the resolver decided this request. */
    authzDecided?: boolean;
  }
}

export interface AuthzRegistry {
  /** `METHOD url` → declared mode (undefined = not declared yet). */
  routes: Map<string, AuthzMode | undefined>;
  /** Non-public 2xx answers sent without a resolver decision (warn mode). */
  undecided: Array<{ method: string; url: string; status: number }>;
  strict: boolean;
}

/** Record that the resolver decided this request (called by the permission service). */
export function markDecided(req: FastifyRequest): void {
  req.authzDecided = true;
}

const DECIDED_MODES = new Set<AuthzMode>(["user", "cell", "device"]);

/**
 * Install BEFORE any module registers routes. Records every route's declaration and checks every answer:
 * a route declared `user`, `cell` or `device` that answers 2xx without a resolver decision is recorded and
 * logged (warn mode) or turned into a 500 (strict mode, switched on for tests in 02-15).
 */
export function installAuthz(app: App, opts: { strict: boolean }): AuthzRegistry {
  const registry: AuthzRegistry = { routes: new Map(), undecided: [], strict: opts.strict };

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") continue; // Fastify's automatic HEAD twin of every GET
      registry.routes.set(`${method} ${route.url}`, route.config?.authz);
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const mode = req.routeOptions.config?.authz;
    if (!mode || !DECIDED_MODES.has(mode) || reply.statusCode >= 300 || req.authzDecided) return payload;
    const url = req.routeOptions.url ?? req.url;
    if (registry.strict) {
      throw new Error(`${req.method} ${url} answered ${reply.statusCode} without a permission decision`);
    }
    registry.undecided.push({ method: req.method, url, status: reply.statusCode });
    req.log.warn({ method: req.method, route: url }, "route answered without a permission decision");
    return payload;
  });

  return registry;
}
