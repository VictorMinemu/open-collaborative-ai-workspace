import type { IncomingMessage, ServerResponse } from "node:http";
import type { OrgRole } from "@ocw/contracts";
import type { TenantCtx, TenantDb } from "@ocw/db";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest, RawServerDefault } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Env } from "./config/env";
import type { ChatAgentBridge } from "./lib/chat-agent-bridge";
import type { RedisBus } from "./lib/redis";
import type { SecretStore } from "./lib/secret-store";
import type { AuditService } from "./modules/audit";
import type { IdentityService } from "./modules/identity";
import type { RealtimeService } from "./modules/realtime";
import type { SecretsService } from "./modules/secrets";

/** Authenticated principal attached to the request by `identity.requireUser`. */
export interface AuthContext {
  userId: string;
  organizationId: string;
  sessionId: string;
  role: OrgRole;
  name: string;
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Fastify instance with the Zod type provider (use this type in modules). */
export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * Shared platform services, constructed once in app.ts (explicit constructor wiring, no DI container).
 * Module factories receive this and return an ApiModule.
 */
export interface Core {
  env: Env;
  log: FastifyBaseLogger;
  db: TenantDb;
  bus: RedisBus;
  secretStore: SecretStore;
  audit: AuditService;
  realtime: RealtimeService;
  identity: IdentityService;
  secrets: SecretsService;
  /** Seam between chat (B1) and agent-channel (B2); see lib/chat-agent-bridge.ts. */
  chatAgent: ChatAgentBridge;
}

export interface ApiModule {
  name: string;
  /** Register routes (prefix /api/v1 is applied by app.ts unless `prefix` is set). */
  register(app: App): Promise<void> | void;
  prefix?: string;
  /** Optional shutdown hook. */
  close?(): Promise<void>;
}

/** Tenant context for withTenant() from an authenticated request. */
export function tenant(req: FastifyRequest): TenantCtx {
  if (!req.auth) throw new Error("tenant() called on an unauthenticated request; add preHandler requireUser");
  return { organizationId: req.auth.organizationId, userId: req.auth.userId };
}

/** Returns req.auth or throws (use after the requireUser preHandler). */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new Error("authOf() called on an unauthenticated request; add preHandler requireUser");
  return req.auth;
}
