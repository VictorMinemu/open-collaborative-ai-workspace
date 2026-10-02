import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import { HealthResponse } from "@ocw/contracts";
import { createTenantDb } from "@ocw/db";
import scalar from "@scalar/fastify-api-reference";
import { drizzle } from "drizzle-orm/node-postgres";
import Fastify, { type FastifyError } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import pg from "pg";
import { decodeKey, type Env } from "./config/env";
import type { ApiModule, App, Core } from "./core";
import { createChatAgentBridge } from "./lib/chat-agent-bridge";
import { HttpError } from "./lib/errors";
import { RedisBus } from "./lib/redis";
import { createEnvFileSecretStore } from "./lib/secret-store";
import { createAgentModule } from "./modules/agent";
import { createAgentChannelModule } from "./modules/agent-channel";
import { createAuditService } from "./modules/audit";
import { createChatModule } from "./modules/chat";
import { createDeviceModule } from "./modules/device";
import { createAuth, createIdentityModule, IdentityService } from "./modules/identity";
import { createOrganizationModule } from "./modules/organization";
import { createRealtimeModule, createRealtimeService } from "./modules/realtime";
import { createSecretsModule, createSecretsService } from "./modules/secrets";
import { createWorkSessionModule } from "./modules/work-session";

export const API_VERSION = "0.1.0";

export interface BuiltApp {
  app: App;
  core: Core;
  close(): Promise<void>;
}

export async function buildApp(env: Env, opts: { logger?: boolean } = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
          },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ---------------------------------------------------------------- infrastructure
  const db = createTenantDb(env.DATABASE_URL);
  const authPool = new pg.Pool({ connectionString: env.AUTH_DATABASE_URL, max: 5 });
  const authDb = drizzle({ client: authPool });
  const bus = await RedisBus.connect(env.REDIS_URL);
  const encryptionKey = decodeKey(env.OCW_ENCRYPTION_KEY);
  if (!encryptionKey) throw new Error("OCW_ENCRYPTION_KEY is invalid");

  // ---------------------------------------------------------------- core services (explicit wiring)
  const secretStore = createEnvFileSecretStore();
  const audit = createAuditService();
  const realtime = createRealtimeService({ db, bus });
  const identity = new IdentityService(createAuth(env, authDb), authDb, env);
  const secrets = createSecretsService({ key: encryptionKey, audit });
  const chatAgent = createChatAgentBridge();
  const core: Core = {
    env,
    log: app.log,
    db,
    bus,
    secretStore,
    audit,
    realtime,
    identity,
    secrets,
    chatAgent,
  };

  const allowedOrigins = new Set([
    env.OCW_PUBLIC_WEB_URL,
    env.OCW_PUBLIC_API_URL,
    ...env.OCW_TRUSTED_ORIGINS,
  ]);

  // ---------------------------------------------------------------- plugins
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  await app.register(swagger, {
    openapi: {
      info: { title: "Open Collaborative AI Workspace API", version: API_VERSION },
      components: {
        securitySchemes: { session: { type: "apiKey", in: "cookie", name: "ocw.session_token" } },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(scalar, { routePrefix: "/docs" });

  app.setErrorHandler((err: FastifyError & { body?: { code?: string; message?: string } }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: { code: "validation_error", message: "Request validation failed", details: err.validation },
      });
    }
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status < 500) {
      // better-auth APIError and Fastify client errors (rate limit, bad JSON, …)
      const code = err.body?.code ?? err.code ?? "error";
      const message = err.body?.message ?? err.message;
      return reply.status(status).send({ error: { code: String(code).toLowerCase(), message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong" } });
  });

  // ---------------------------------------------------------------- health
  app.get(
    "/health",
    { schema: { tags: ["system"], response: { 200: HealthResponse, 503: HealthResponse } } },
    async (_req, reply) => {
      const [dbOk, redisOk] = await Promise.all([
        db.ping().then(
          () => "ok" as const,
          () => "error" as const,
        ),
        bus.ping().then(
          () => "ok" as const,
          () => "error" as const,
        ),
      ]);
      const status = dbOk === "ok" && redisOk === "ok" ? "ok" : "error";
      return reply
        .status(status === "ok" ? 200 : 503)
        .send({ status, version: API_VERSION, checks: { db: dbOk, redis: redisOk } });
    },
  );

  // ---------------------------------------------------------------- module registry
  // Add a module: implement apps/api/src/modules/<name>/index.ts and add ONE line here.
  // Modules are mounted under /api/v1 unless they set `prefix`.
  const modules: ApiModule[] = [
    createIdentityModule({ identity, db, audit, realtime, apiUrl: env.OCW_PUBLIC_API_URL }),
    createOrganizationModule(core),
    createRealtimeModule({ realtime, identity, allowedOrigins }),
    createSecretsModule(),
    createChatModule(core), // B1
    createAgentModule(core), // B2
    createAgentChannelModule(core), // B2
    createDeviceModule(core), // B3
    createWorkSessionModule(core), // B3
  ];
  for (const m of modules) {
    await app.register(async (scope) => m.register(scope as unknown as App), {
      prefix: m.prefix ?? "/api/v1",
    });
  }

  return {
    app,
    core,
    async close() {
      await app.close();
      for (const m of modules) await m.close?.();
      await Promise.allSettled([db.close(), authPool.end(), bus.close()]);
    },
  };
}
