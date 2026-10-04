---
phase: 02-identity-and-organization
plan: 02
subsystem: organization (authorization), api, web
status: complete
tags: [authorization, resolver, permissions, audit, fast-check, rbac]
requires: [02-01]
provides:
  - "Pure resolveEffectivePermissions/decide: the PRD intersection Org ∩ Dept ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device with explicit-deny precedence"
  - "createPermissionService (decide/can/assertCan/filter/viewerCan/requirePermission/myPermissions) and recordAuthzDenial: the contract wave 3 migrates against"
  - "policy.ts relation grants, preconditions and pure resource builders for every resource type"
  - "AuthzDeniedError: 403 with {permission, layer, reason}, or 404 with no details when hidden"
  - "authz.denied audited in its own transaction for denied mutations (Pitfall 4)"
  - "installAuthz route registry (config.authz on every route, undecided 2xx recorded, warn mode) exposed as BuiltApp.authz"
  - "guard.test.ts static legacy-check guard over apps/api and apps/web"
  - "GET /api/v1/me/permissions; GET /api/v1/members decided by member.read"
  - "Web usePermissions/usePermissionCheck/useCan; rail and settings entries gated by permission"
affects: [02-04, 02-05, 02-06, 02-07, 02-08, 02-09, 02-10, 02-11, 02-12, 02-13, 02-14, 02-15]
tech-stack:
  added: []
  patterns:
    - "Pure resolver over loaded facts; facts.ts is the only DB code; per-request memo in a module-level WeakMap"
    - "Denied-mutation audit in a separate withTenant from the error handler"
    - "Route declares config.authz; the permission service marks the request decided"
    - "Literal role matrix + fast-check properties as the reviewable policy"
key-files:
  created:
    - apps/api/src/modules/organization/permissions/resolve.ts
    - apps/api/src/modules/organization/permissions/policy.ts
    - apps/api/src/modules/organization/permissions/facts.ts
    - apps/api/src/modules/organization/permissions/service.ts
    - apps/api/src/modules/organization/permissions/errors.ts
    - apps/api/src/modules/organization/permissions/resolve.test.ts
    - apps/api/src/modules/organization/permissions/facts.int.test.ts
    - apps/api/src/modules/organization/permissions/guard.test.ts
    - apps/api/src/modules/organization/members.ts
    - apps/api/src/authz.ts
    - apps/api/src/authz.test.ts
    - apps/web/lib/permissions.ts
  modified:
    - apps/api/src/app.ts
    - apps/api/src/modules/organization/index.ts
    - apps/api/src/modules/chat/index.ts
    - apps/api/src/modules/chat/chat.int.test.ts
    - apps/web/components/shell/nav.ts
    - apps/web/components/shell/nav-list.tsx
    - apps/web/components/settings/settings-nav.ts
    - apps/web/components/settings/settings-sidebar.tsx
decisions:
  - "Channel preconditions (private/archived/not a member) only judge channel and channel_member resources, so organization-scope answers (/me/permissions) keep channel.post and channel.members.add"
  - "A hidden denial (404) carries no details, so a private channel's existence never leaks; the denial is still audited"
  - "The device_revoked precondition stays on device.* and work_session.create/prompt/approve only (single source); read, interrupt and archive of a session on a revoked device stay possible"
  - "Facts and rules load sequentially inside a transaction (pg rejects concurrent queries on one client)"
  - "Resolution.principalDenied carries permission org.read; decide() rewrites it to the requested permission"
metrics:
  duration: "~40 min"
  completed: "2026-10-04"
  tasks: 3
  files: 20
actuals:
  tokens: 26800
  tasks: 3
  commits: 4
---

# Phase 2 Plan 02: Permission resolver, enforcement rails and permission-gated UI Summary

One pure resolver now decides authorization. Channel archive is the first real route on it: admins archive any channel, owners archive their own, everyone else gets a 403 with `{permission, layer, reason}`, and the denial is audited after the rollback. The full PRD intersection is proven by a hand-written role matrix and 8 fast-check properties. Every route can declare `config.authz` and is tracked. A static guard catches legacy role checks, and the web hides navigation the caller cannot use.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `9766300` | feat(02-02): decide channel archive with the permission resolver; audit denials |
| 2 | `ccd0182` | feat(02-02): complete the resolver intersection with units, leads, allow/deny rules, agent-for-human, tool and device |
| 3 | `98882ec` | feat(02-02): route authz registry, legacy-check guard, /me/permissions and permission-gated navigation |

## Contract for wave 3 (final exported signatures, verbatim)

All of these are re-exported from `apps/api/src/modules/organization/index.ts`. Other modules import them only from `"../organization"`.

### service.ts

```ts
export type PrincipalRef =                       // defined in facts.ts, re-exported by service.ts
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; onBehalfOfUserId?: string }
  | { kind: "cell"; cellId: string }
  | { kind: "device"; deviceId: string };

export interface DecideOptions {
  /** Deny as 404 (the caller must not learn the resource exists), e.g. `channel.read`. */
  hideAs404?: boolean;
  /** Decide for another principal than the request's (e.g. an agent acting for a human). */
  as?: PrincipalRef;
  /** The resource the human is checked against when `as` is an agent acting on behalf of a user. */
  onBehalfOfResource?: ResourceFacts;
}

export interface PermissionService {
  /** Decide without a request (background jobs, tests). Loads facts in `tx`. */
  decide(
    tx: Tx,
    principal: PrincipalRef,
    permission: Permission,
    resource?: ResourceFacts,
    onBehalfOfResource?: ResourceFacts,
  ): Promise<{ allowed: boolean; denial?: AuthzDenial }>;
  can(
    req: FastifyRequest,
    tx: Tx,
    permission: Permission,
    resource?: ResourceFacts,
    opts?: DecideOptions,
  ): Promise<boolean>;
  /** Throws AuthzDeniedError (403 with the denial, or 404 when `hideAs404`). */
  assertCan(
    req: FastifyRequest,
    tx: Tx,
    permission: Permission,
    resource?: ResourceFacts,
    opts?: DecideOptions,
  ): Promise<void>;
  /** The items the caller may `permission`; facts load once, then one in-memory decision per item. */
  filter<T>(
    req: FastifyRequest,
    tx: Tx,
    items: readonly T[],
    permission: Permission,
    toResource: (item: T) => ResourceFacts,
  ): Promise<T[]>;
  /** The subset of `candidates` the caller holds on `resource` (drives per-resource `viewerCan`). */
  viewerCan(
    req: FastifyRequest,
    tx: Tx,
    resource: ResourceFacts,
    candidates: readonly Permission[],
  ): Promise<Permission[]>;
  /** Fastify preHandler: asserts an organization-scope permission in its own short transaction. */
  requirePermission(permission: Permission): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** The signed-in user's role and organization-scope effective set (+ `account.manage` on themselves). */
  myPermissions(req: FastifyRequest, tx: Tx): Promise<MyPermissions>;
}

export interface PermissionDeps { db: TenantDb; audit: AuditService }
export function createPermissionService(deps: PermissionDeps): PermissionService;   // pass `core`
export async function recordAuthzDenial(deps: PermissionDeps, req: FastifyRequest, err: AuthzDeniedError): Promise<void>;
export function principalOf(req: FastifyRequest): PrincipalRef;      // req.auth → user, req.cell → cell, req.device → device
export function principalTenant(req: FastifyRequest): TenantCtx;     // cells/devices act with userId null
```

### policy.ts (pure builders)

```ts
export function orgResource(): ResourceFacts;
export function unitResource(u: { id: string; path: readonly string[] }): ResourceFacts;
export function userResource(targetUserId: string, principalUserId: string | null): ResourceFacts;
export function memberResource(targetUserId: string, principalUserId: string | null): ResourceFacts;
export interface ChannelFacts {
  visibility: "public" | "private";
  archived: boolean;
  viewerRole: "owner" | "member" | null;
}
export function channelResource(c: ChannelFacts): ResourceFacts;
export function channelMemberResource(c: ChannelFacts, targetIsViewer: boolean): ResourceFacts;
export function deviceResource(
  d: { ownerUserId: string; shared: boolean; revoked: boolean },
  principalUserId: string | null,
): ResourceFacts;
export function workSessionResource(
  s: { createdBy: string; deviceOwnerUserId: string | null; deviceRevoked: boolean; tool?: string | null },
  principalUserId: string | null,
): ResourceFacts;
export function invitationResource(
  i: { inviterId: string | null; role: OrgRole },
  principalUserId: string | null,
): ResourceFacts;
// also exported: RELATION_PERMISSIONS, MISSING_REASON, PRECONDITIONS, precondition()
```

### errors.ts, resolve.ts, authz.ts

```ts
export class AuthzDeniedError extends HttpError {
  readonly denial: AuthzDenial;
  readonly hidden: boolean;
  constructor(denial: AuthzDenial, opts?: { hideAs404?: boolean; message?: string });
}
// 403: code = denial.reason, or "forbidden" for missing_permission / denied_by_rule; details = denial
// 404: code "not_found", no details

export function resolveEffectivePermissions(p: PrincipalFacts, r: ResourceFacts, rules: readonly RuleFact[], onBehalfOf?: OnBehalfOf): Resolution;
export function decide(p, r, rules, permission: Permission, onBehalfOf?): { allowed: boolean; denial?: AuthzDenial };
// types Relation, ResourceState, ResourceType, PrincipalFacts, ResourceFacts, RuleFact, OnBehalfOf, Resolution exactly as in the plan's interface block

export type AuthzMode = "public" | "user" | "cell" | "device";      // FastifyContextConfig.authz, FastifyRequest.authzDecided
export interface AuthzRegistry { routes: Map<string, AuthzMode | undefined>; undecided: Array<{ method: string; url: string; status: number }>; strict: boolean }
export function installAuthz(app: App, opts: { strict: boolean }): AuthzRegistry;   // BuiltApp.authz
export function markDecided(req: FastifyRequest): void;
```

### Route pattern (the tracer, `chat/index.ts` archive)

```ts
{ config: { authz: "user" }, preHandler: requireUser, schema: … }
const conv = await getChannel(tx, req.params.id);
if (!conv) throw notFound("Channel not found");
const membership = await getMembership(tx, conv.id, "user", auth.userId);
const res = channelResource({ visibility: conv.visibility, archived: conv.archivedAt !== null, viewerRole: membership?.role ?? null });
await perms.assertCan(req, tx, "channel.read", res, { hideAs404: true });
// … domain 400s …
await perms.assertCan(req, tx, "channel.archive", res);
```

`can` / `assertCan` / `filter` / `viewerCan` / `myPermissions` / `requirePermission` all call `markDecided(req)`. A route whose decision is not in the service must call `markDecided` itself, or 02-15 strict mode answers 500.

## Resolver semantics as implemented

1. **Principal gate.** A deactivated user (layer `user`, `deactivated`), a disabled or deleted agent (`agent`, `agent_disabled`) or a revoked device (`device`, `device_revoked`) gets an empty set. A user without an `org_members` row in the tenant counts as deactivated.
2. **Grants.** These come from the role's `ROLE_PERMISSIONS`, from `AGENT_/CELL_/DEVICE_PERMISSIONS` for other principals, from `LEAD_PERMISSIONS` when a lead unit is on the resource path, and from relation grants. For users, relation grants are kept only on the role's surfaces; other principals keep them only inside their own set. Allow rules add grants too, but never a `NON_DELEGABLE_PERMISSIONS` entry.
3. **Rule applicability.** The subject must match: `everyone` means users and agents, `role` means users with that role, and `user`/`agent` match by id. The scope must be the organization, or a unit on the resource path or on one of the principal's unit paths. If the rule has a tool, it must equal `resource.tool`.
4. **Denials.** Each grant is checked against the preconditions first (layer `resource`, or `device`). Then the first matching deny applies, in the order org → units (shallowest first) → user → agent → tool, ties broken by rule id. Every deny removes the grant, whatever granted it.
5. **onBehalfOf.** An agent's set is intersected with the human's set on the human's resource. Each removed permission carries the human's denial.

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/modules/chat/chat.int.test.ts` | 18 passed, including the "archive is decided by the resolver" describe (5 tests) and "organization: permissions for the caller" (2 tests). Mutation check: with the error handler's `recordAuthzDenial` call disabled, the audit test fails |
| `pnpm exec vitest run --project unit …/permissions/resolve.test.ts` | 34 passed: 4 matrix roles plus 2 meta checks, 11 relation cases, 10 lead/rule/agent cases, and 8 `fc.assert` properties at numRuns 300. No counterexample. Mutation checks: the suite catches non-delegable allows (2 failures), allow overriding deny (2), a removed confused-deputy intersection (2), ignored principal unit paths (4) and relation grants without the surface filter (3) |
| `pnpm exec vitest run --project integration …/permissions/facts.int.test.ts` | 7 passed (lead paths, deactivation, cross-tenant user, agents, devices, cell, rules tenant-scoped) |
| `pnpm exec vitest run --project unit apps/api/src/authz.test.ts …/permissions/guard.test.ts` | 8 passed. Mutation check: removing the `channel-view.tsx` marker and breaking the `device/routes.ts` plan id makes the guard fail, listing `file:line` for each hit |
| `pnpm verify` (after each task) | exit 0 every time. Final run: biome 364 files clean, turbo typecheck 8/8, **40 files / 365 tests passed** |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `COMPOSE_PROJECT_NAME=t3code-81d72154 bash scripts/e2e-isolated.sh` | **11 passed (31.8 s)**, exit 0: setup, then bots, chat, codex-subscription, smoke and work-zone at desktop 1440 and mobile 390. The admin still sees every nav and settings entry. After the run, ports 4290/3290 were free and the lock was released |

Acceptance greps: `resolve.ts` and `policy.ts` have 0 `@ocw/db|fastify` hits. `assertCan(req, tx, "channel.archive"` appears in `chat/index.ts`, and `recordAuthzDenial` in `app.ts`. `createPermissionService` is exported from `organization/index.ts`. `fc.assert` appears 8 times, and the literal `EXPECTED` table has 4 role keys. `NON_DELEGABLE_PERMISSIONS` appears in `resolve.ts`. `installAuthz(app, { strict: false })` (line 166) comes before `for (const m of modules)` (line 208). `requirePermission("member.read")` is in `members.ts`, `"/me/permissions"` in `organization/index.ts`, the three hooks in `lib/permissions.ts`, and both settings permissions in `settings-nav.ts`.

### Demo stack (hard rule)

| Check | Before | After |
|-------|--------|-------|
| `curl localhost:4000/health` | 200 | 200 |
| `curl localhost:3000/login` | 200 | 200 |
| `apps/web/.next/BUILD_ID` (t3code worktree) | LBiwKQtn4F2yq0QBxWCGq | LBiwKQtn4F2yq0QBxWCGq |
| `ocw-demo-openclaw` | running, started 2026-10-04T15:54:27Z | running, started 2026-10-04T15:54:27Z |
| demo `app.org_members` roles | (unmigrated, per 02-01) | member:3, owner:1 (unchanged) |

No `docker compose down/rm/stop/restart`, no `db:migrate` against the default `.env`, no `demo:*`, no bind on :4000/:3000.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Channel preconditions also fired on non-channel resources**
- **Found during:** Task 2 (matrix design)
- **Issue:** The plan's precondition list only looks at relations and state. With it, `channel.post`, `channel.members.add` and agent `channel.read` were denied (`not_a_member`) on `orgResource()`. `/me/permissions` would then miss `channel.post` for everyone.
- **Fix:** Channel preconditions now apply only to `channel` and `channel_member` resources.
- **Commit:** `ccd0182`

**2. [Rule 2 - Security] A 404 denial carries no details**
- The plan says `details = denial` for every AuthzDeniedError. For `hideAs404`, details are left out, so `private_channel` never reaches a caller who must not learn the channel exists. The denial stays on the error for the audit, and a test asserts the body has no `private_channel`.

**3. [Rule 1 - Bug] Concurrent queries on one transaction client**
- **Found during:** Task 3 (pg printed `DeprecationWarning: Calling client.query() when the client is already executing a query`)
- **Fix:** Facts, rules and on-behalf-of loads now run sequentially in `facts.ts` and `service.ts`. Today this is a deprecation warning; in pg@9 it would be an error.
- **Commit:** `98882ec`

**4. [Rule 3 - Environment] e2e from this worktree needs the demo's compose project name**
- `scripts/e2e-isolated.sh` resolves `docker compose` against the directory name. From `ocw-02-02`, `docker compose ps` finds nothing, so the script would run `docker compose up -d --wait postgres redis` and start a second stack. The run used `COMPOSE_PROJECT_NAME=t3code-81d72154`, which `docker compose ps` confirmed targets the running postgres/redis. The script still touched only `ocw_e2e` and Redis DB 9. Suggestion for 02-15 or the orchestrator: pin the project name inside the script (`export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-t3code-81d72154}`) or pass `-p`.

**5. Interpretation: the device-layer precondition keeps the Task 1 list**
- Task 2 says "state device_revoked denies workzone-surface permissions … keep a single source". The single source in `PRECONDITIONS` still covers `device.*` plus `work_session.create/prompt/approve`. Denying `work_session.read/interrupt/archive` on a revoked device would hide session history and block cleanup, which is a regression for 02-05.

**6. Placement of the /me/permissions and /members integration checks**
- These checks were added to `chat.int.test.ts`, which this plan owns. `identity.int.test.ts` may be edited by 02-03, which runs in parallel.

**7. TDD ordering**
- Each task's tests were written right after its implementation and committed together (one `feat` commit per task), not as separate RED commits. To show the tests bite, each suite was mutation-checked: the audit call, 5 resolver mutations, and the guard markers. All were caught.

## Notes for wave 3

- `chat/index.ts` keeps its `authz-legacy: 02-04` marker. Its other routes (remove member and others) still hold interim checks.
- `filter()` uses only the request principal. If an agent acting for a human needs a list, call `viewerCan`/`can` with `as`.
- `requirePermission` opens its own short `withTenant`. The facts it loads are memoised for the handler's transaction.
- Nav entries gated by a permission are hidden while `/me/permissions` loads (never flash). The admin sees every entry once it resolves.

## Known Stubs

None.

## Threat Flags

None. The new surface (`GET /api/v1/me/permissions` and `authz.denied` audit rows) is covered by T-02-02-04/05/06.

## Self-Check: PASSED
