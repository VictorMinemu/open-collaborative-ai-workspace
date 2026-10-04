# Stage A handoff — platform core

Read this first, then `01-BUILD-SPEC.md`. Deviations: `01-DEVIATIONS.md`. Rule: **add modules, pages and
tables; avoid editing shared files**, except the one-line registration points listed below.

## Run it

```bash
corepack enable                 # pnpm 12.8.1 via packageManager (global pnpm is 11: use `corepack pnpm` if needed)
pnpm install
pnpm setup:env                  # once: writes .env with random secrets, prints the setup token (refuses to overwrite)
```

**Full stack (Docker):** `docker compose up -d --build --wait`

| Service | Address |
| --- | --- |
| web | http://localhost:3000 |
| api | http://localhost:4000 (`/health`, `/docs` OpenAPI) |
| postgres | 127.0.0.1:54329 |
| redis | 127.0.0.1:63799 |

`migrate` is one-shot. It bootstraps the roles as superuser, runs the Drizzle migrations as `ocw_migrator`,
then runs the FORCE RLS step. The compose project name is the directory name, so each worktree gets its
own stack. Host ports are configurable in `.env`: `OCW_WEB_PORT`, `OCW_API_PORT`, `OCW_POSTGRES_PORT`,
`OCW_REDIS_PORT`.

**Dev mode (hot reload):**

```bash
docker compose up -d --wait postgres redis migrate
pnpm dev                        # turbo: api (node --watch + tsx, reads ../../.env) on :4000, web (next dev) on :3000
pnpm db:migrate                 # host-side migrate after adding tables (uses MIGRATE_SUPERUSER_URL etc. from .env)
```

**First login:** open `/setup` and paste `OCW_SETUP_TOKEN` from `.env`. The stack left running by Stage A
is already set up by the E2E run:

- Email: `admin@ocw.test`
- Password: `e2e-admin-password-123`
- Org: Autofy Labs

For a fresh org, run `docker compose down -v` (this worktree's volume only).

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm verify` | Biome, `tsc` in every workspace (turbo), all Vitest projects. Must be green before commits. |
| `pnpm test:unit` | Fast unit tests only. |
| `pnpm test:integration` | testcontainers `postgres:18` + `redis:8` (Docker required). |
| `pnpm e2e` | Playwright against a running stack. Needs a fresh stack: the `setup` project redeems the token. |

E2E env:

- `OCW_E2E_BASE_URL` / `OCW_E2E_API_URL`: base URLs.
- `OCW_SETUP_TOKEN`: read from `.env` by default.
- `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/screenshots`: saves review shots.

Projects: `setup`, then `desktop` (1440×900) and `mobile` (390×844). Add specs in `e2e/tests/*.spec.ts`; both
`desktop` and `mobile` run every spec except `setup.spec.ts`. Specs assume the admin from `tests/env.ts`
(`ADMIN`) exists.
`compose.e2e.yaml` sets `OCW_MODEL_PROVIDER=mock`, which B2 must honour.

Test helpers:

- `@ocw/db/testing` → `startTestDatabase()` returns a migrated PG 18 with URLs for superuser, migrator,
  app and auth.
- `apps/api/src/testing.ts` → `startTestStack()` (full API on a random port + `TestClient` cookie jar) and
  `TEST_SETUP_TOKEN`.
- Template: `apps/api/src/identity.int.test.ts`.

## Repository map

```
packages/contracts         Zod for everything (Apache-2.0). Types derive from here; never duplicate DTOs.
packages/db                Drizzle schema (src/schema/{app,auth}.ts), migrations (drizzle/), sql/{bootstrap,post-migrate}.sql,
                           withTenant/tenantOf/lookups (src/tenant.ts), RLS enumerator test
packages/realtime-client   RealtimeClient (browser + Node), backoff, resume, gap replay, zustand/vanilla stores
apps/api/src/app.ts        explicit wiring + MODULE REGISTRY
apps/api/src/core.ts       Core services interface, ApiModule, tenant(req), authOf(req), AuthContext
apps/api/src/modules/*     identity · organization · audit · realtime · secrets (done); chat · agent · agent-channel ·
                           device · work-session (stubs, already registered)
apps/web                   Next 16 App Router, Tailwind 4, shadcn/Base UI in components/ui
e2e/                       Playwright
```

## API: adding or implementing a module

The stub modules `chat` (B1), `agent` and `agent-channel` (B2), and `device` and `work-session` (B3) are
**already registered** in `apps/api/src/app.ts` (the `modules` array). Implement the routes inside
`register()` in `apps/api/src/modules/<name>/index.ts`; routes mount under `/api/v1`. To mount at the root
(e.g. `/runtime/ws`), return `prefix: ""` and use full paths, or add a second module.

A brand-new module needs one more line in the `modules` array: `createXModule(core), // owner`.

Route pattern:

```ts
import { CreateChannelRequest, ChannelSummary } from "@ocw/contracts";
import { conversations } from "@ocw/db";
import { authOf, tenant, type ApiModule, type Core } from "../../core";
import { forbidden, notFound } from "../../lib/errors";

export function createChatModule(core: Core): ApiModule {
  return {
    name: "chat",
    register(app) {
      app.post("/channels", {
        preHandler: core.identity.requireUser,           // or core.identity.requireRole("owner", "admin")
        schema: { tags: ["chat"], body: CreateChannelRequest, response: { 200: ChannelSummary } },
      }, async (req) => core.db.withTenant(tenant(req), async (tx) => {
        const [row] = await tx.insert(conversations).values({ organizationId: authOf(req).organizationId, kind: "channel", ... }).returning();
        await core.audit.record(tx, { action: "channel.created", resourceType: "conversation", resourceId: row.id });
        await core.realtime.appendEvent(tx, `org:${authOf(req).organizationId}`, "conversation.created", row);
        return { ...row, isMember: true, memberCount: 1 };
      }));
    },
  };
}
```

- **Errors:** throw `HttpError` or the helpers `badRequest`, `unauthorized`, `forbidden`, `notFound`,
  `conflict`, `gone` from `apps/api/src/lib/errors.ts`. The client gets `{ error: { code, message } }`.
  Zod validation failures return 400 `validation_error`.
- **Response schemas are enforced** by the serializer. Return dates as ISO strings (timestamp columns use
  `mode: "string"`; convert with `new Date(x).toISOString()`).
- **Bearer auth (devices, OpenClaw plugin):** hash the token with `sha256Hex` (`lib/crypto.ts`), then call
  `core.db.lookups.deviceByTokenHash(h)`, `agentCredentialByTokenHash(h)` or
  `deviceEnrollmentByCodeHash(h)`. These run before the tenant is known. Then
  `core.db.withTenant({ organizationId, userId: null }, …)`.
- **Org secrets** (provider API keys): call `core.secrets.put(tx, { name, kind: "provider_api_key",
  provider, value })` and store the returned id. Inside a server tx only, `core.secrets.reveal(tx, id)`
  returns the value; it must never reach a response or a log. Operator secrets come from
  `core.secretStore.resolveSync({ provider: "env", key })`.
- **Members/users:** call `listMembers(tx)` or `memberDirectory(tx)` from `modules/organization`. Never
  query schema `auth` from domain code: `ocw_app` is denied there.

## DB: withTenant, audit, appendEvent

- `core.db.withTenant(ctx, async (tx, afterCommit) => …)` is the **only** entrypoint for `app.*` queries.
  It sets `app.organization_id` and `app.user_id` with transaction-scoped `set_config`; RLS does the
  rest. `afterCommit(cb)` runs only after COMMIT.
- `core.audit.record(tx, { action, resourceType, resourceId?, result?, actorKind?, agentId?, deviceId?, metadata? })`
  writes in the **same tx**. The org and user come from `tx` (`tenantOf(tx)`). Denied outcomes go in
  their own `withTenant` call.
- `core.realtime.appendEvent(tx, topic, type, payload)` allocates the next per-stream seq under a row lock,
  inserts into `stream_events`, and publishes to Redis **after commit**. It returns the seq. Snapshot
  endpoints should return `lastSeq: await core.realtime.lastSeq(tx, topic)` so clients subscribe with
  `afterSeq`.
- `core.realtime.publishEphemeral(topic, type, data)`: typing, deltas, presence. No seq, never persisted.
- Topics: `conv:<id>`, `user:<id>`, `org:<id>`, `ws:<id>`.
- Event type names: `EventTypes` and `EphemeralTypes` in `packages/contracts/src/realtime.ts`. Add new
  names there; payload schemas go next to their domain.

**New table checklist:**

1. Add it to `packages/db/src/schema/app.ts` with `organizationId: orgId()`.
2. Run `pnpm db:generate`, which writes `packages/db/drizzle/<ts>_<name>/`.
3. Add one fixture insert to `seedOrg()` in `packages/db/src/rls-isolation.int.test.ts`. The test fails
   until you do; it proves cross-tenant reads, writes and inserts fail.

RLS, FORCE, the policy and the `ocw_app` grants are applied automatically by `sql/post-migrate.sql`.
Append-only tables: add `REVOKE UPDATE, DELETE` lines there. Never weaken a policy to make a test pass.

## Realtime: topic authorizers

`user:<id>` (own id only) and `org:<id>` (own org only) are registered by default. Topics without an
authorizer are **denied**. Register yours in your module factory:

```ts
core.realtime.registerTopicAuthorizer("conv", async (auth, conversationId) =>
  core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
    // must check: conversation exists in this org (RLS ensures that) AND (public channel OR auth.userId is a member)
    return true;
  }));
core.realtime.registerTopicAuthorizer("ws", async (auth, workSessionId) => /* session visible to auth */ true);
```

Browser protocol (`GET /ws`, cookie session, Origin allowlist checked before upgrade):

- Client → server: `sub{topic, afterSeq}`, `unsub`, `ping`.
- Server → client: `ev{topic, seq, type, data}`, `eph`, `subscribed{lastSeq}`, `resync`, `err`, `pong`.
- Clients may send `eph` with type `user.*` (e.g. `user.typing`) on a topic they are subscribed to. The
  server injects `userId`.
- Sessions are re-checked every 5 minutes; a revoked session closes with code 4401.

Server-side listener (e.g. agent-channel fan-out): `await core.realtime.listen(topic, frame => …)` returns
an unsubscribe function.

## Web: adding a page or nav item

- **Nav:** add ONE entry to `NAV_ITEMS` in `apps/web/components/shell/nav.ts`, then create
  `apps/web/app/(app)/<slug>/page.tsx`. The rail, the mobile drawer and the title derive from that array.
  B1/B2/B3 replace the placeholder `page.tsx` of `/chat`, `/bots` and `/work-zone`.
- **Section sidebar** (e.g. the channel list): render `<SectionSidebar title actions>…</SectionSidebar>`
  followed by `<div className="flex min-w-0 flex-1 flex-col">…</div>`. On mobile it moves into the drawer
  automatically. Use `sectionItemClass(active)` for rows and `PageHeader` for the top bar.
- **Settings sub-page:** add one entry to `SETTINGS_SECTIONS` in
  `apps/web/components/settings/settings-nav.ts`, plus `app/(app)/settings/<slug>/page.tsx` (e.g. Models,
  Devices).
- **API calls:** use `api.get/post/del(path, { body, schema })` from `apps/web/lib/api.ts`. It is typed by
  contracts schemas, sends `credentials: "include"` and throws `ApiRequestError`. Put TanStack Query hooks
  in `lib/queries.ts` style (`queryKeys`, `useMe`, `useMembers`, …). Prefer your own
  `lib/<feature>-queries.ts` to avoid conflicts.
- **Realtime:** `useTopic(topic, listener, afterSeq?)`, `useRealtime()` (client, or null when signed out),
  `useRealtimeStatus()` from `apps/web/lib/realtime.tsx`.
- **UI:** shadcn (Base UI) components live in `apps/web/components/ui`. Add new ones there (written by
  hand; avoid running `shadcn add` concurrently with other agents). Empty states:
  `components/common/empty-state.tsx`.
- **Runtime config:** the API URL comes from `OCW_PUBLIC_API_URL` at request time
  (`useRuntimeConfig()`). Never use `NEXT_PUBLIC_*` for it.

## Shared-file etiquette for parallel agents

- **One-line touch points:** the `modules` array in `apps/api/src/app.ts` (only for brand-new modules),
  `NAV_ITEMS`, `SETTINGS_SECTIONS`, `EventTypes`, and `packages/contracts/src/index.ts` (export a new
  contracts file). For the last one, prefer extending the existing domain file.
- **Dependencies:** `corepack pnpm --filter <pkg> add <dep>` only. Don't run pnpm commands concurrently;
  if `pnpm-lock.yaml` conflicts, re-run `pnpm install`.
- **Commits:** commit only your own paths (`git add <your dirs>`), Conventional Commits with scope.
- **Migrations:** two agents generating migrations at once produce two timestamped folders. That is fine as
  long as they touch different tables. Run `pnpm db:generate` again if the snapshot complains.

## Known gaps / not done in Stage A

- No `/runtime/ws` Device Link gateway yet (B3), no `conv`/`ws` topic authorizers (B1/B3), no
  model-provider routes (B2). The contracts for all of them exist.
- No OpenTelemetry (`@fastify/otel`) and no GitHub Actions CI workflow.
- Failed sign-in attempts are not audited; only successful ones are.
- Rate limiting is per-route (30/min) on setup, accept and sign-in only.
- API image is ~1 GB (tsx at runtime, no bundle). Web image is ~400 MB (standalone).
- No ADRs written yet for the "research" stack rows (Drizzle/RLS, better-auth, realtime, web). That is
  owed by Phase 1.
- Docker Desktop has little free disk. Don't prune other projects' images or volumes; remove only images
  you built (`ocw-api:local`, `ocw-web:local`).
