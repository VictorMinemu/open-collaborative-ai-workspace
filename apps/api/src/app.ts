import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import {
  DEVICE_LINK_MAX_DEVICE_FRAME_BYTES,
  HealthResponse,
  type RuntimeCompatibilityManifest,
  WS_PROTOCOL,
} from "@ocw/contracts";
import { createTenantDb } from "@ocw/db";
import scalar from "@scalar/fastify-api-reference";
import { drizzle } from "drizzle-orm/node-postgres";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import pg from "pg";
import { type AuthzRegistry, installAuthz } from "./authz";
import { decodeKey, type Env, fastifyTrustProxy } from "./config/env";
import type { ApiModule, App, Core } from "./core";
import { createChatAgentBridge } from "./lib/chat-agent-bridge";
import { createChatEvents } from "./lib/chat-events";
import { HttpError } from "./lib/errors";
import { createJobs } from "./lib/jobs";
import { redisRateLimitStore } from "./lib/rate-limit-store";
import { RedisBus } from "./lib/redis";
import { createEnvFileSecretStore, type SecretStore } from "./lib/secret-store";
import { createAgentModule } from "./modules/agent";
import {
  type BrowserBudgets,
  createAgentChannelModule,
  currentPhrase,
  type SandboxBudgets,
} from "./modules/agent-channel";
import { createAiChatModule } from "./modules/ai-chat";
import { type ApprovalService, createApprovalModule } from "./modules/approval";
import { createArtifactModule, type ObjectStorage } from "./modules/artifact";
import { createAuditService } from "./modules/audit";
import { createAutomationModule } from "./modules/automation";
import { createBotCapabilitiesModule, loadCatalog } from "./modules/bot-capabilities";
import { type BrowserModule, createBrowserModule } from "./modules/browser";
import { createChatModule, createConversationAccess } from "./modules/chat";
import { createConnectorsModule } from "./modules/connectors";
import { createDeviceModule, type DeviceHub } from "./modules/device";
import { createDigestModule } from "./modules/digest";
import { createAuth, createIdentityModule, IdentityService } from "./modules/identity";
import { createKeychainModule } from "./modules/keychain";
import { createMcpModule } from "./modules/mcp";
import { createMemoryModule, createMemoryService, type MemoryService } from "./modules/memory";
import { createModelGateway, createModelGatewayModule } from "./modules/model-gateway";
import { createNotificationModule } from "./modules/notification";
import {
  AuthzDeniedError,
  createOrganizationModule,
  createPermissionService,
  recordAuthzDenial,
} from "./modules/organization";
import { createPluginsModule } from "./modules/plugins";
import { createOnlineSet, createRealtimeModule, createRealtimeService } from "./modules/realtime";
import { createSandboxModule, pushPolicy, type SandboxModule } from "./modules/sandbox";
import { createSearchModule } from "./modules/search";
import { createSecretsModule, createSecretsService } from "./modules/secrets";
import { createToolApprovalModule, type ToolApprovalService } from "./modules/tool-approval";
import { createRecordWrites, createWatchedModule } from "./modules/watched";
import { createWorkMemoryModule } from "./modules/work-memory";
import {
  createWorkSessionAttachmentScope,
  createWorkSessionModule,
  type WorkSessionModule,
} from "./modules/work-session";
import { stripQueryStrings } from "./telemetry/redact";
import { API_VERSION } from "./version";

export { API_VERSION } from "./version";

export interface BuiltApp {
  app: App;
  core: Core;
  /** Route authz declarations and undecided answers (warn mode; strict for tests from 02-15). */
  authz: AuthzRegistry;
  /** The Device Link hub (tests reach its session handler, e.g. `onAccessChanged`). */
  deviceHub: DeviceHub;
  /** Attachment object storage, null when unconfigured (tests count its calls, e.g. none on the prompt submit path). */
  storage: ObjectStorage | null;
  /** The approve-and-apply primitive (07.2-06): later modules and tests register kinds on it. */
  approvals: ApprovalService;
  /** The memory domain (07.2-08): 07.2-09 registers its approval kind with it, 07.2-11 serves agents from it. */
  memory: MemoryService;
  /** Per-tool approval policies (07.5-03): the gate (07.5-07) and turn assembly (07.5-11) resolve through it. */
  toolApprovals: ToolApprovalService;
  /** Bot sandboxes (07.8-05): the domain service and the sandboxd client (null when not configured). */
  sandbox: SandboxModule;
  /** Bot browsers (07.8-14): the context module and its `browser` events handler (tests drive their own consumers). */
  browser: BrowserModule;
  /** The Work Zone session module (07.16-06): tests call its `start` with a bot's agent option. */
  workSession: WorkSessionModule;
  /** The registered modules' names, in registration order (wiring tests). */
  moduleNames: readonly string[];
  close(): Promise<void>;
}

export async function buildApp(
  env: Env,
  opts: {
    logger?: boolean /** Test hook: capture log lines. */;
    logStream?: { write(msg: string): void };
    /** Test hook: resolve env/file SecretReferences from these values instead of process.env. */
    secretStore?: SecretStore;
    /** Test hook: a lower Device Link frame limit (06.1-02); never read from the environment. */
    deviceFrameMaxBytes?: number;
    /** Test hook: a compatibility manifest other than the bundled one (07.11 PD-12); never read from the environment. */
    runtimeManifest?: RuntimeCompatibilityManifest;
    /** Test hook: shorter bot browser call deadlines (CI p64/p66); never read from the environment. */
    browserBudgetsMs?: BrowserBudgets;
    /** Test hook: shorter bot sandbox call budgets (CI p142/p164/p178); never read from the environment. */
    sandboxBudgetsMs?: SandboxBudgets;
    /** Test hook: shorter bot file transfer deadlines (07.17.1.1 PD-18); never read from the environment. */
    botFileDeadlineMs?: (bytes: number) => number;
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
            // Request logs (stdout and exported) never carry a query string: it can hold tokens (T-07-05-01).
            serializers: {
              // Fastify's default fields, minus the query string.
              req: (req: FastifyRequest) => ({
                method: req.method,
                url: req.url.split("?", 1)[0],
                version: req.headers["accept-version"] as string | undefined,
                host: req.host,
                remoteAddress: req.ip,
                remotePort: req.socket?.remotePort,
              }),
            },
            hooks: {
              // Free-text messages too, e.g. Fastify's "Route GET:/x?token=… not found".
              logMethod(args, method) {
                const clean = args.map((a) => (typeof a === "string" ? stripQueryStrings(a) : a));
                return method.apply(this, clean as Parameters<typeof method>);
              },
            },
            ...(opts.logStream ? { stream: opts.logStream } : {}),
          },
    // X-Forwarded-For only from configured proxies (SELF-05): it feeds req.ip, the sign-in audit and rate limit.
    trustProxy: fastifyTrustProxy(env.OCW_TRUST_PROXY),
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
  const secrets = createSecretsService({ key: encryptionKey, audit, store: secretStore });
  const chatAgent = createChatAgentBridge();
  const chatEvents = createChatEvents();
  // Organization-level online set (@here, CHAT-08): maintained by the realtime gateway, read by notifications.
  const online = createOnlineSet(bus);
  // Phase 07.6 (AUTO-01, D-07): pg-boss as ocw_app, no DDL. Created before the modules so their `register` can call
  // `work` / `schedule`; started on ready (after every module registered); stopped before the pool closes.
  const jobs = createJobs({
    connectionString: env.DATABASE_URL,
    workers: env.OCW_JOBS_WORKER === "on",
    log: app.log,
  });
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
    jobs,
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
  // 07.6-10: counted in Redis (RedisRateLimitStore), so every limit holds across replicas, the public webhook URL's
  // 60/min among them; the routes keep their own numbers. While Redis cannot answer (down, reconnecting, or slower
  // than 250 ms), hits are counted in this instance's memory: sign-in and device tokens keep working, still limited.
  await app.register(rateLimit, { global: false, store: redisRateLimitStore(bus.pub) });
  await app.register(websocket, {
    options: {
      // 256 KiB. The daemon bounds every diff.result under this (local-runtime/src/diff-frame.ts, 07.17.1.1 D-14):
      // a bigger device frame would close the link with 1009.
      maxPayload: DEVICE_LINK_MAX_DEVICE_FRAME_BYTES,
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
  // B3: owns the Device Link hub used by work-session.
  const deviceModule = createDeviceModule(core, {
    ...(opts.deviceFrameMaxBytes ? { maxFrameBytes: opts.deviceFrameMaxBytes } : {}),
    ...(opts.runtimeManifest ? { runtimeManifest: opts.runtimeManifest } : {}),
  });
  const modelGateway = createModelGateway(core); // Phase 5: the only place a LanguageModel is built (P-04)
  // Phase 4: attachments (ADR-0015); 06.1: a Work Zone session's images follow the session (P-04).
  const artifactModule = createArtifactModule(core, {
    access: createConversationAccess(core),
    scopes: { work_session: createWorkSessionAttachmentScope(core) },
  });
  // Phase 07.2: the approve-and-apply primitive (ADR-0023); memory (07.2), tool grants (07.5) and automations (07.6)
  // register their kinds on `approvals.service`.
  const approvals = createApprovalModule(core);
  // Phase 07.2: scoped memory files (MEM-01, MEM-02, MEM-07); proposals register on `approvals` (07.2-09).
  const memory = createMemoryService(core, { approvals: approvals.service });
  // Phase 07.5: per-tool approval policies; the catalog loader is injected (the module never imports bot-capabilities).
  const toolApproval = createToolApprovalModule(core, { approvals: approvals.service, loadCatalog });
  // B3; 06.1: image bytes; 07.5-08: built before the Agent Channel, which serves its Work Zone proposals, and registers
  // the `work_zone.start` kind on `approvals`.
  const workSession = createWorkSessionModule(core, deviceModule.hub, {
    storage: artifactModule.storage,
    approvals: approvals.service,
    ...(opts.botFileDeadlineMs ? { botFileDeadlineMs: opts.botFileDeadlineMs } : {}),
  });
  // Phase 07.8: bot sandboxes (D-02 (b), D-09, D-11); built before the Agent Channel, which serves the bots' sandbox
  // routes with its sandboxd client.
  const sandbox = createSandboxModule(core);
  // 07.8-14: the bots' browser contexts; sandboxd's `browser` events update them (host, crash, close).
  // 07.8-16: and serves the people's live view (frames from sandboxd, the gateway's origins, the activity phrase).
  const browser = createBrowserModule(core, {
    events: sandbox.events,
    client: sandbox.client,
    allowedOrigins,
    activityPhrase: currentPhrase,
  });
  // Phase 07.6 (ADR-0028): automations first, because the digest registers its action kind on their service. One
  // permission service for the four modules (stateless). Their jobs run on `core.jobs`.
  const perms = createPermissionService(core);
  const automation = createAutomationModule(core, {
    perms,
    approvals: approvals.service,
    modelGateway,
    memory,
  });
  const modules: ApiModule[] = [
    createIdentityModule({
      identity,
      db,
      audit,
      realtime,
      apiUrl: env.OCW_PUBLIC_API_URL,
      signInRatePerMinute: env.OCW_SIGNIN_RATE_LIMIT_PER_MINUTE,
    }),
    createOrganizationModule(core, { approvals: approvals.service }), // 07.2: a unit deletion closes its gone approvals
    createRealtimeModule({ realtime, identity, allowedOrigins, bus, online }),
    createSecretsModule(),
    createChatModule(core), // B1
    createNotificationModule(core, { online }), // Phase 4: mentions, DMs, threads, @channel/@here (CHAT-08)
    artifactModule,
    createSearchModule(core, { modelLabel: (ref) => modelGateway.labelOf(ref) }), // Phase 4: full-text search (CHAT-11, D-04); AI chats of their owner (05-10)
    createModelGatewayModule(core, modelGateway), // Phase 5: AI chat models and ChatGPT plan status
    createAiChatModule(core, { gateway: modelGateway, storage: artifactModule.storage }), // Phase 5: direct AI chat (AICHAT-02/03/07/08)
    // B2; 07.2: a bot deletion closes its pending approvals; 07.8-11: and purges its sandbox; 07.8-28: its sessions
    createAgentModule(core, { approvals: approvals.service, sandbox: sandbox.service, browser }),
    // Phase 3.1: capabilities, bot policy, governance; 07.2-11: notes on files; 07.8-11: the Sandbox and Browser rows
    createBotCapabilitiesModule(core, { memory, sandbox: sandbox.service }),
    createMcpModule(core), // Phase 3.1: MCP server registry (D-13)
    createConnectorsModule(core), // Phase 07.4: members' own connector accounts (D-01 … D-03, CONN-01 … CONN-03)
    // Phase 07.4: keys bots use by handle (D-04, CONN-05); 07.8 hardening: a private-host change re-pushes the sandbox
    // policy, as a settings change does.
    createKeychainModule(core, {
      onPrivateHostsChanged: (organizationId) => pushPolicy(core, sandbox.client, organizationId),
    }),
    createPluginsModule(core), // Phase 3.1: OpenClaw Marketplace (D-14)
    // B2; 06-10: model labels in persona history; 07.2-11: memory tools and memory files in the turn
    createAgentChannelModule(core, {
      modelLabel: (ref) => modelGateway.labelOf(ref),
      memory,
      workZone: workSession.proposals, // 07.5-08: Work Zone proposals (D-03)
      workSession, // 07.16-15: a bot's own Work Zone sessions, in its sponsor's name (PD-03)
      automations: automation.proposals, // 07.6-12: natural-language automation proposals (AUTO-03)
      fanOut: automation.fanOut, // 07.17-16: a fan-out run opens one conversation per new item (AFO-02)
      records: createRecordWrites(core), // 07.6-14: compare-and-set writes to watched records (AUTO-04)
      toolApproval: toolApproval.service, // 07.5-11: the approval decision of every agent action (D-04)
      sandbox, // 07.8-05: the sandboxd client of the bots' sandbox routes
      ...(opts.browserBudgetsMs ? { browserBudgets: opts.browserBudgetsMs } : {}),
      ...(opts.sandboxBudgetsMs ? { sandboxBudgets: opts.sandboxBudgetsMs } : {}),
    }),
    deviceModule, // B3
    workSession, // B3 (built above)
    approvals.module, // Phase 07.2: approvals inbox and decisions (MEM-06)
    createMemoryModule(core, memory), // Phase 07.2: memory scopes, files and history (MEM-01, MEM-02, MEM-07)
    toolApproval.module, // Phase 07.5: approval policies per tool (APPROVE-01)
    sandbox.module, // Phase 07.8: kill switch, settings, files, the events consumer (05, 11); packages from 18
    browser.module, // Phase 07.8-14: browser contexts (the bots' routes are the Agent Channel's)
    automation.module, // Phase 07.6: automations (AUTO-01 … AUTO-03)
    createWatchedModule(core, { perms }), // Phase 07.6: watched records (AUTO-04)
    // Phase 07.6: the personal digest (AUTO-05), a `digest` automation
    createDigestModule(core, {
      perms,
      approvals: approvals.service,
      modelGateway,
      automation: automation.service,
    }),
    // Phase 07.6: Work Zone → project memory (AUTO-06)
    createWorkMemoryModule(core, { perms, approvals: approvals.service, memory, modelGateway }),
  ];
  for (const m of modules) {
    await app.register(async (scope) => m.register(scope as unknown as App), {
      prefix: m.prefix ?? "/api/v1",
    });
  }
  // On ready, every module's `register` has run. A JobsSchemaError (the migrate service has not run for this release)
  // fails `listen` / `ready`; main.ts prints it and exits.
  app.addHook("onReady", async () => {
    await jobs.start();
  });

  return {
    app,
    core,
    authz,
    deviceHub: deviceModule.hub,
    storage: artifactModule.storage,
    approvals: approvals.service,
    memory,
    toolApprovals: toolApproval.service,
    sandbox,
    browser,
    workSession,
    moduleNames: modules.map((m) => m.name),
    async close() {
      await app.close();
      // In-flight handlers finish (up to 8 s, inside closeWithGrace's 10 s) before the pool they use closes.
      await jobs.stop();
      for (const m of modules) await m.close?.();
      await Promise.allSettled([db.close(), authPool.end(), bus.close()]);
    },
  };
}
