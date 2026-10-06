import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import { HealthResponse, WS_PROTOCOL } from "@ocw/contracts";
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
import { type AuthzRegistry, installAuthz } from "./authz";
import { decodeKey, type Env } from "./config/env";
import type { ApiModule, App, Core } from "./core";
import { createChatAgentBridge } from "./lib/chat-agent-bridge";
import { createChatEvents } from "./lib/chat-events";
import { HttpError } from "./lib/errors";
import { RedisBus } from "./lib/redis";
import { createEnvFileSecretStore, type SecretStore } from "./lib/secret-store";
import { createAgentModule } from "./modules/agent";
import { createAgentChannelModule } from "./modules/agent-channel";
import { createArtifactModule } from "./modules/artifact";
import { createAuditService } from "./modules/audit";
import { createBotCapabilitiesModule } from "./modules/bot-capabilities";
import { createChatModule, createConversationAccess } from "./modules/chat";
import { createDeviceModule, type DeviceHub } from "./modules/device";
import { createAuth, createIdentityModule, IdentityService } from "./modules/identity";
import { createMcpModule } from "./modules/mcp";
import { createNotificationModule } from "./modules/notification";
import { AuthzDeniedError, createOrganizationModule, recordAuthzDenial } from "./modules/organization";
import { createPluginsModule } from "./modules/plugins";
import { createOnlineSet, createRealtimeModule, createRealtimeService } from "./modules/realtime";
import { createSearchModule } from "./modules/search";
import { createSecretsModule, createSecretsService } from "./modules/secrets";
import { createWorkSessionModule } from "./modules/work-session";

export const API_VERSION = "0.1.0";

export interface BuiltApp {
  app: App;
  core: Core;
  /** Route authz declarations and undecided answers (warn mode; strict for tests from 02-15). */
  authz: AuthzRegistry;
  /** The Device Link hub (tests reach its session handler, e.g. `onAccessChanged`). */
  deviceHub: DeviceHub;
  close(): Promise<void>;
}

export async function buildApp(
  env: Env,
  opts: {
    logger?: boolean /** Test hook: capture log lines. */;
    logStream?: { write(msg: string): void };
    /** Test hook: resolve env/file SecretReferences from these values instead of process.env. */
    secretStore?: SecretStore;
  } = {},
): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              // The browser WebSocket carries its access JWT here (ocw.auth.<jwt>), T-02-08-04.
              'req.headers["sec-websocket-protocol"]',
              'res.headers["set-cookie"]',
              // Attachment routes redirect to presigned URLs; a signed query string is a bearer credential.
              "res.headers.location",
            ],
            ...(opts.logStream ? { stream: opts.logStream } : {}),
          },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ---------------------------------------------------------------- infrastructure
  const onIdleError = (pool: string) => (err: Error) =>
    app.log.warn({ err, pool }, "postgres dropped an idle connection; it will reconnect on next use");
  const db = createTenantDb(env.DATABASE_URL, { onIdleError: onIdleError("app") });
  const authPool = new pg.Pool({ connectionString: env.AUTH_DATABASE_URL, max: 5 });
  authPool.on("error", onIdleError("auth"));
  authPool.on("connect", (client) => {
    client.on("error", onIdleError("auth"));
  });
  const authDb = drizzle({ client: authPool });
  const bus = await RedisBus.connect(env.REDIS_URL);
  const encryptionKey = decodeKey(env.OCW_ENCRYPTION_KEY);
  if (!encryptionKey) throw new Error("OCW_ENCRYPTION_KEY is invalid");

  // ---------------------------------------------------------------- core services (explicit wiring)
  const secretStore = opts.secretStore ?? createEnvFileSecretStore();
  const audit = createAuditService();
  const realtime = createRealtimeService({ db, bus });
  const identity = new IdentityService(createAuth(env, authDb), authDb, env, realtime);
  const secrets = createSecretsService({ key: encryptionKey, audit });
  const chatAgent = createChatAgentBridge();
  const chatEvents = createChatEvents();
  // Organization-level online set (@here, CHAT-08): maintained by the realtime gateway, read by notifications.
  const online = createOnlineSet(bus);
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
    chatEvents,
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
  await app.register(websocket, {
    options: {
      maxPayload: 256 * 1024,
      // Select the application protocol, never the `ocw.auth.<jwt>` entry: browsers fail a handshake that
      // offered subprotocols and got none back (Pitfall 2), and the token must not be echoed (T-02-08-04).
      handleProtocols: (protocols: Set<string>) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "Open Collaborative AI Workspace API", version: API_VERSION },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "ocw.session_token" },
          cellToken: {
            type: "http",
            scheme: "bearer",
            description: "OpenClaw cell token (Agent Channel API)",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(scalar, { routePrefix: "/docs" });

  app.setErrorHandler(
    async (err: FastifyError & { body?: { code?: string; message?: string } }, req, reply) => {
      if (err instanceof AuthzDeniedError && req.method !== "GET" && req.method !== "HEAD") {
        // The request transaction already rolled back; the denial is audited in its own (Pitfall 4).
        await recordAuthzDenial({ db, audit }, req, err);
      }
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
    },
  );

  // ---------------------------------------------------------------- authorization coverage
  // Before any route below: records every route's config.authz and every undecided non-public 2xx. Strict
  // in tests (an undecided 2xx becomes a 500 and fails the suite); production and dev keep warn-and-record,
  // so a missed declaration degrades to a log line instead of an outage (T-02-15-03).
  const authz = installAuthz(app, { strict: env.NODE_ENV === "test" });

  // ---------------------------------------------------------------- health
  app.get(
    "/health",
    {
      config: { authz: "public" },
      schema: { tags: ["system"], response: { 200: HealthResponse, 503: HealthResponse } },
    },
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
  const deviceModule = createDeviceModule(core); // B3: owns the Device Link hub used by work-session
  const modules: ApiModule[] = [
    createIdentityModule({
      identity,
      db,
      audit,
      realtime,
      apiUrl: env.OCW_PUBLIC_API_URL,
      signInRatePerMinute: env.OCW_SIGNIN_RATE_LIMIT_PER_MINUTE,
    }),
    createOrganizationModule(core),
    createRealtimeModule({ realtime, identity, allowedOrigins, bus, online }),
    createSecretsModule(),
    createChatModule(core), // B1
    createNotificationModule(core, { online }), // Phase 4: mentions, DMs, threads, @channel/@here (CHAT-08)
    createArtifactModule(core, { access: createConversationAccess(core) }), // Phase 4: attachments (ADR-0015)
    createSearchModule(core), // Phase 4: full-text search (CHAT-11, D-04)
    createAgentModule(core), // B2
    createBotCapabilitiesModule(core), // Phase 3.1: capabilities, bot policy, governance
    createMcpModule(core), // Phase 3.1: MCP server registry (D-13)
    createPluginsModule(core), // Phase 3.1: OpenClaw Marketplace (D-14)
    createAgentChannelModule(core), // B2
    deviceModule, // B3
    createWorkSessionModule(core, deviceModule.hub), // B3
  ];
  for (const m of modules) {
    await app.register(async (scope) => m.register(scope as unknown as App), {
      prefix: m.prefix ?? "/api/v1",
    });
  }

  return {
    app,
    core,
    authz,
    deviceHub: deviceModule.hub,
    async close() {
      await app.close();
      for (const m of modules) await m.close?.();
      await Promise.allSettled([db.close(), authPool.end(), bus.close()]);
    },
  };
}
