import type { FastifyRequest } from "fastify";

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

/** Record that the resolver decided this request (called by the permission service). */
export function markDecided(req: FastifyRequest): void {
  req.authzDecided = true;
}
