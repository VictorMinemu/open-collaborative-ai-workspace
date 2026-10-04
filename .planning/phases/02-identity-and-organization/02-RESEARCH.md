# Phase 2: Identity and Organization - Research

**Researched:** 2026-10-04
**Domain:** Authorization (role model, org hierarchy, one effective-permission resolver), better-auth sessions/JWT/JWKS, realtime auth, admin console
**Confidence:** HIGH for the code inventory and better-auth internals (read from the installed 1.7.6 source), MEDIUM for the design recommendations (they are choices, not facts)

## User Constraints

<user_constraints>
No `02-CONTEXT.md` exists (discuss-phase has not run). Nothing below is a locked user decision; these are the
constraints that bind this phase from ROADMAP.md, AGENTS.md and the owner's standing directives.

### Binding scope (ROADMAP.md › Phase 2, verbatim success criteria)
1. User resets their password (email when SMTP is configured, admin-issued link otherwise) and views and revokes their active sessions, each carrying the device/client identifier that Phase 1 already records on messages and audit rows
2. Admin creates and rearranges Organization → Department → Team → Project (including moving units), assigns members with one of Standard User / Developer / Team Lead-Manager / Organization Admin (replacing the MVP 0 owner/admin/member roles), Team Leads can invite and revoke invitations, and users, roles, units and memberships are managed from CRUD pages in the admin console (extending Settings › Members)
3. A single `resolveEffectivePermissions` intersection (Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device) with explicit-deny precedence decides every route, and every Phase 1 route (setup, invitations, channels, messages, bots, providers, devices, Work Zone, realtime subscription) is migrated to it with no ad-hoc role or membership check left
4. API and WebSocket connections authenticate with short-lived JWTs verifiable against a JWKS endpoint; the Phase 1 cookie-authenticated WebSocket moves to short-lived JWT/JWKS verification without breaking reconnect and replay
5. Users view and edit their own profile (display name, avatar, status) and see other members' profiles; hierarchy, role, membership, session-revocation and failed sign-in attempts are audited (same transaction where there is a domain write), closing the gaps left by the Phase 1 audit (SLICE-06); every later phase audits the sensitive actions it introduces

### Owner directives (memory + AGENTS.md Developer Profile)
- Full autonomy: decide, build and merge; surface only critical uncovered decisions.
- No paid or metered service (none is needed here).
- Regressions are the top frustration: existing users must keep every capability they have today after the role migration; existing tests stay green.
- Keep it proportional: the phase is meant to be agent-executed in 1–2 days. No speculative mechanisms.

### Claude's Discretion (everything not listed above)
Role/unit semantics, hierarchy storage, permission vocabulary, token transport, UI layout, plan decomposition.

### Deferred Ideas (OUT OF SCOPE, from ROADMAP)
RT-01 subscription re-evaluation on membership change (Phase 3), presence (Phase 3), object storage / avatar upload (Phase 4), Ed25519 device identity and RFC 8628 device grant (Phase 8, DEV-02), per-Work-Session permission bits (Phase 10, PRD §29), policies/skills/MCP permissions (MVP 4).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md) | Current state (traceability) | Research support |
|----|-------------|------------------|------------------|
| AUTH-04 | User can reset their password (email when SMTP configured, admin-issued link otherwise) | Pending: "No password reset" | §Pattern 7 (better-auth `reset-password` verification row + our own routes), nodemailer behind a `Mailer` port |
| AUTH-05 | User can view and revoke their active sessions; every session carries a device/client identifier used for message attribution (PRD §15) | Partial: "Messages and audit rows carry client kind + session id; no session list or revoke" | §Pattern 6 (session `client_kind`/`client_label` columns set by a `session.create.before` hook, own list/revoke routes, Redis revocation fan-out), hard-coded `"web"` sites listed in the inventory |
| AUTH-06 | API, WebSocket and daemon connections are authenticated with short-lived JWTs verified against a JWKS endpoint; identity is provided by better-auth embedded in the API | Pending: "Cookie sessions and hashed bearer tokens; no JWT/JWKS" | §Pattern 5 (better-auth `jwt` plugin, jose verifier, WS subprotocol token, device-token → device JWT exchange) |
| ORG-01 | Admin can create and manage the hierarchy Organization → Department → Team → Project, including moving units (PRD §7) | Pending: "No hierarchy" | §Pattern 3 (`app.org_units` adjacency + materialized `uuid[]` path, per-org advisory lock for moves) |
| ORG-02 | Admin can assign users to units with one of the four roles (PRD §6) | Partial: "Org roles owner/admin/member set at invite; not the four PRD roles, no unit assignment" | §Pattern 2 (org role = persona, unit membership with `member`/`lead`), §Data migration |
| ORG-03 | A single `resolveEffectivePermissions` … with explicit-deny precedence, and every route uses it (PRD §61, §82) | Pending: "Ad-hoc role and membership checks per route" | §Pattern 1 (pure resolver + facts loader), §Ad-hoc check inventory (every site with file:line), §Pattern 4 (route-coverage guard) |
| ORG-04 | Admin console provides CRUD pages for users, roles, departments, teams, projects and memberships (PRD §81 minimal) | Partial: "Settings › Members lists members and manages invitations" | §Admin console UX |
| ORG-05 | Every sensitive action … writes an audit event in the same transaction … | Partial: "failed sign-in not audited; later actions" | §Audit additions table, §Pitfall 4 (denied mutations roll back their own audit row) |
| ORG-06 | User can view and edit their profile (display name, avatar, status) and see other members' profiles | Pending: "No profile editing" | §Pattern 8 (auth-plane tx updates `auth.user` + `app.org_members` + audit) |

**PRD section numbers in REQUIREMENTS.md are stale.** The current `docs/prd/PRD.md` numbers are: roles §7 (line 309), hierarchy §8 (line 377), effective permissions §65 "Policies" (lines 2036-2063), admin console §85 (line 2601), security model §86 (line 2649), audit log §88 (line 2693), permission complexity §109.3 (line 3524) [VERIFIED: docs/prd/PRD.md, read this session]. The planner should cite these, not §6/§7/§61/§81/§82/§84.
</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

- Principle 6: effective permission = Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device; upper-level restrictions win; explicit deny beats allow.
- Principle 12: every sensitive action emits an audit event with actor, agent, user, device, resource, action, result, timestamp, organization, session.
- Principle 2: agents are first-class principals; every permission test runs for user and agent principals.
- Principle 11: stable IDs, never names, for cross-references (unit ids, not unit names, in paths and rules).
- Tenant isolation is a test target: every new org-scoped table needs a cross-tenant test (the enumerator test needs a seed fixture row per new table, deviation A-2).
- The app connects as `ocw_app` (no RLS bypass); tenant context via transaction-scoped `set_config`; `withTenant()` is the only entrypoint.
- Contracts first: permission enum, roles, DTOs live in `packages/contracts` as Zod; no duplicated DTOs.
- Integration tests hit a real PostgreSQL (testcontainers), never DB mocks. Write the failing test before the fix.
- No `any`, no `@ts-ignore` without a comment and issue link.
- Never weaken a permission check, RLS policy or approval gate to make a test pass.
- Never log absolute host paths, prompt contents with credentials, provider keys (add tokens: never log JWTs).
- Plan mode is required for changes under `apps/api/` that touch permissions, policies, audit or tenant isolation, and for any schema migration (CLAUDE.md). This phase is all of those.
- ADR for every architectural decision (`docs/adr/0007-…`), English, Conventional Commits, `pnpm verify` before every commit.
- `minimumReleaseAge: 10080` (7 days) in `pnpm-workspace.yaml` [VERIFIED: pnpm-workspace.yaml:7]: new dependencies resolve to versions at least 7 days old.

## Summary

MVP 0 authorizes with three hand-rolled mechanisms: a `requireRole("owner", "admin")` preHandler, inline `auth.role === "owner" || auth.role === "admin"` comparisons, and per-route membership/ownership helpers (`canRead`, `getMembership`, `canUseDevice`, `assertCanApprove`). There are 13 role comparison sites and about 25 membership/ownership decisions across 7 API files, plus 6 role checks in the web app, and better-auth's organization plugin silently acts as a second authority because invitations are created through `auth.api.createInvitation({ headers })`, which runs the plugin's own `hasPermission` and rejects unknown role names [VERIFIED: better-auth/dist/plugins/organization/routes/crud-invites.mjs:95-122]. The inventory below lists every site with file:line.

The recommended design keeps better-auth for authentication only (users, credentials, sessions, invitations, JWKS) and moves every authorization decision into one pure function in the organization module, fed by a per-request facts loader. The model is grants minus denies: each member has one organization role (the four PRD personas), unit memberships add `lead` authority over a unit subtree, resource relations add owner, creator and member grants, and every layer (Org → Department → Team → Project → User → Agent → Tool → Device) can only remove permissions. That is the PRD intersection with explicit-deny precedence in a form that can be explained and property-tested. The hierarchy lives in `app.org_units` (adjacency plus a materialized `uuid[]` ancestor path, no Postgres extension) under the existing generic RLS. Enforcement is mechanical. `AuthContext.role` is deleted, so any leftover check fails typecheck. Every route declares an authz mode, and in tests a successful response without a resolver decision fails. A static guard test bans the old patterns.

For AUTH-06, add better-auth's `jwt` plugin (EdDSA keys in a new `auth.jwks` table, `/api/auth/token`, `/api/auth/jwks`). The API verifies tokens with `jose` against an in-process cached JWKS. The browser WebSocket presents the JWT as a `Sec-WebSocket-Protocol` entry, verified before the upgrade, so the frame protocol, reconnect and replay are untouched. The daemon exchanges its existing hashed device token for a 10-minute device JWT before each Device Link connect. Password reset reuses better-auth's `reset-password` verification rows: a self-service email goes out when `OCW_SMTP_URL` is set, otherwise an admin issues a 24-hour single-use link. Session list and revoke are our own routes because better-auth's `/list-sessions` returns session tokens.

**Primary recommendation:** run a tracer wave first. It contains the contracts and schema, the data migration (owner/admin to Organization Admin, member to Developer), the pure resolver with table-driven and property tests, the coverage guard and one migrated route. After that, fan out by module with strict file ownership: chat, agents/cell, devices/Work Zone, organization admin API, JWT/WS, sessions/password/profile, then two web plans, then e2e and the ADR.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Credentials, sessions, invitations, JWKS signing keys | API (identity module, `ocw_auth` role, schema `auth`) | — | better-auth tables; `ocw_app` has no privileges on `auth` |
| Org role, unit memberships, hierarchy, deny rules | Database (schema `app`, tenant RLS) | API (organization module writes) | Domain data, org-scoped, covered by the RLS enumerator |
| Authorization decision (`resolveEffectivePermissions`) | API (organization module, pure function) | — | One authority; RLS stays tenant-only (ARCHITECTURE.md §6) |
| UI gating (show/hide buttons) | Browser | API (`me.permissions`, per-resource `viewerCan`) | Browser never recomputes policy; it renders server decisions |
| JWT issuance | API (better-auth `jwt` plugin) | — | Same keys for user and device tokens |
| JWT verification | API (REST, `/ws`, `/runtime/ws`) | — | `jose` + cached JWKS, no DB round-trip for the signature |
| Token acquisition/refresh | Browser (token manager), Local Runtime daemon (exchange) | — | Short-lived tokens fetched just before connecting |
| Session revocation fan-out | API + Redis pub/sub | — | Closes sockets in every API instance immediately |
| Audit | API (same tx as the write; own tx for sign-in failures and denials) | — | Server-side only (PITFALLS: client-emitted audit is forgeable) |
| Password reset email | API (`Mailer` port, nodemailer SMTP adapter) | — | Optional; admin link otherwise |

## Standard Stack

### Core (already installed, use as-is)
| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| better-auth | 1.7.6 [VERIFIED: apps/api/package.json] | Sessions, credentials, invitations storage, `jwt` plugin (JWKS + `/token` + server `signJWT`), `reset-password` | Already embedded; `jwt` ships in-package [VERIFIED: node_modules/better-auth/dist/plugins/jwt/] |
| @better-auth/core | 1.7.6 | `runWithTransaction` / `getCurrentAdapter` for same-tx audit (proven in Phase 1 SPIKE, deviation A-6) | Already used |
| jose | 6.2.12 [VERIFIED: pnpm-lock.yaml:3287, transitive of better-auth] | `createLocalJWKSet`, `jwtVerify` | Add as a **direct** dependency of `@ocw/api` at the locked version (no new download) |
| drizzle-orm / drizzle-kit | 1.0.0-rc.4 | New tables, `uuid().array()` path column, custom data migration | Already used |
| @fastify/websocket | 11.3.1 | `/ws` + `/runtime/ws`; pass `handleProtocols` through `options` | Already used |
| redis | 6.2.1 | Revocation pub/sub + revoked-sid deny-list | Already used (`RedisBus`) |
| zod | 4.6.5 | Permission enum, claims schema, all new DTOs | Already used |

### Supporting (new)
| Library | Version | Purpose | When |
|---------|---------|---------|------|
| nodemailer | 10.0.x (pnpm resolves the newest at least 7 days old) [WARNING: flagged as suspicious — verify before using.] | SMTP adapter behind a `Mailer` port | Only when `OCW_SMTP_URL` is set; reset emails (optionally invitation emails) |
| @types/nodemailer | 8.0.x [WARNING: flagged as suspicious — verify before using.] | Types | dev |
| fast-check | 4.10.x [WARNING: flagged as suspicious — verify before using.] | Property tests for the resolver and hierarchy invariants | dev, `apps/api` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| better-auth `jwt` plugin | `@better-auth/oauth-provider` 1.7.7 (separate package) | Full OIDC provider; needed for third-party clients or RFC 8628 later. Same `jwks` table, so adding it later costs nothing. Overkill for Phase 2 |
| `uuid[]` materialized path | `ltree` (ARCHITECTURE.md §6) | ltree needs `CREATE EXTENSION` (trusted, but this repo revokes `CREATE` on schema `public` from PUBLIC [VERIFIED: packages/db/sql/bootstrap.sql:39]), so it must be installed by the superuser bootstrap and is unavailable on managed PG without it. lquery pattern matching is not needed now. `uuid[]` with GIN is extension-free and Drizzle-native. Switching later is a column rewrite |
| `uuid[]` path | Closure table | More writes on move (delete/insert subtree × ancestors), no benefit at org scale |
| JWT via WS subprotocol | `?access_token=` query param | Token lands in access logs and proxies; avoid |
| JWT via WS subprotocol | First-frame `{op:"auth"}` | Allows unauthenticated upgrades and needs a frame state machine. Only worth it for in-band refresh, which we do not need (see Pattern 5) |
| Code constant `ROLE_PERMISSIONS` | `role_permissions` table | Needed only for custom roles (not in scope); the function signature stays the same |
| Own sessions routes | better-auth `/list-sessions`, `/revoke-session` | `/list-sessions` returns session tokens to the browser and `/revoke-session` takes the token, not the id [VERIFIED: better-auth/dist/api/routes/session.mjs:365-368, 379-407] |

**Installation:**
```bash
pnpm --filter @ocw/api add jose@6.2.12 nodemailer
pnpm --filter @ocw/api add -D @types/nodemailer fast-check
```

## Package Legitimacy Audit

Run with `gsd-tools query package-legitimacy check --ecosystem npm` on 2026-10-04.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| jose | npm | 6.2.12 published 2026-09-05; project 8+ yrs | ~174M/wk | github.com/panva/jose | [SUS] reason `too-new` (latest-version heuristic) | Approved in practice: already in the lockfile as a better-auth dependency, so no new artifact. Planner adds `checkpoint:human-verify` per protocol |
| nodemailer | npm | 10.0.14 published 2026-10-03; project 10+ yrs | ~29M/wk | github.com/nodemailer/nodemailer (MIT-0) | [SUS] `too-new` | Flagged; checkpoint before install. The 7-day gate picks ≤ 10.0.11 |
| @types/nodemailer | npm | 8.0.2 published 2026-09-15 | ~14M/wk | DefinitelyTyped | [SUS] `too-new` | Flagged; checkpoint |
| fast-check | npm | 4.10.2 published 2026-09-19 | ~60M/wk | github.com/dubzzz/fast-check | [SUS] `too-new` | Flagged; checkpoint |
| @better-auth/oauth-provider | npm | 1.7.7 published 2026-09-30 | ~2.4M/wk | github.com/better-auth/better-auth | [SUS] `too-new` | **Not recommended for this phase** (deferred) |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** jose, nodemailer, @types/nodemailer, fast-check. All four are long-established, high-download packages flagged only by the "latest version is recent" heuristic, and none has a `postinstall` script [VERIFIED: `npm view <pkg> scripts.postinstall` empty]. The planner still inserts one `checkpoint:human-verify` before the install task. Package names come from training knowledge plus registry confirmation, not Context7, so per protocol they stay at this flagged level.

## Ad-hoc Authorization Inventory (every site the plan must migrate)

All line numbers come from files read this session. "Decision" is what the resolver must reproduce, so that today's users lose nothing.

### API — role checks (13)
| # | File:line | Code (verbatim excerpt) | Route / use | Resolver permission |
|---|-----------|-------------------------|-------------|---------------------|
| R1 | `apps/api/src/modules/identity/service.ts:115-120` | `requireRole = (...roles: OrgRole[]) => …` / `if (!req.auth \|\| !roles.includes(req.auth.role)) throw forbidden("This action requires an admin");` | definition; **delete** | — |
| R2 | `identity/routes.ts:127` | `preHandler: identity.requireRole("owner", "admin"),` | GET `/api/v1/invitations` | `invitation.read` |
| R3 | `identity/routes.ts:136` | same | POST `/api/v1/invitations` | `invitation.create` + role ceiling |
| R4 | `identity/routes.ts:145` | same | DELETE `/api/v1/invitations/:id` | `invitation.revoke` (admin any; lead own) |
| R5 | `agent/index.ts:65` | `const admin = core.identity.requireRole("owner", "admin");` used at `:74` GET `/model-providers`, `:88` POST `/model-providers`, `:180` DELETE `/model-providers/:provider`, `:243` POST `/agents`, `:314` PATCH `/agents/:id`, `:407` DELETE `/agents/:id` | | `provider.manage`, `bot.manage` |
| R6 | `agent-channel/index.ts:72` | `const admin = core.identity.requireRole("owner", "admin");` used at `:99` GET `/api/v1/agent-cell`, `:108` POST `/api/v1/agent-cell/token`, `:153`/`:165`/`:187` GET/POST/DELETE `/api/v1/model-providers/:provider/auth` | | `cell.manage`, `provider.manage` |
| R7 | `chat/index.ts:294` | `const isAdmin = auth.role === "owner" \|\| auth.role === "admin";` | POST `/channels/:id/archive` | `channel.archive` (admin or channel owner) |
| R8 | `chat/index.ts:398` | same | DELETE `/channels/:id/members/:kind/:memberId` | `channel.members.remove` (self, channel owner, admin) |
| R9 | `device/routes.ts:233-235` | `const isAdmin = auth.role === "owner" \|\| auth.role === "admin";` | DELETE `/devices/:id` | `device.revoke` (owner or admin) |
| R10 | `work-session/routes.ts:46-48` | `function isAdmin(auth: AuthContext) { return auth.role === "owner" \|\| auth.role === "admin"; }` | used by R11 | — |
| R11 | `work-session/routes.ts:67-75` | `assertCanApprove`: creator, device owner or `isAdmin` | `:400` POST `/work-sessions/:id/approvals/:aid`, `:501` POST `/work-sessions/:id/archive` | `work_session.approve`, `work_session.archive` |
| R12 | `identity/service.ts:230-233`, `:265` | `this.auth.api.createInvitation({ headers: fromNodeHeaders(headers), … })`, `this.auth.api.cancelInvitation({ headers … })` | better-auth plugin runs its own `hasPermission` and rejects unknown roles | Replace with adapter writes inside our tx after the resolver decides |
| R13 | `identity/service.ts:61-81` | `authenticate()` reads `member.role` into `AuthContext.role` | every request | Remove `role` from `AuthContext` (core.ts:16-23) |

### API — membership / ownership / visibility decisions (~25)
| # | File:line | Decision today | Permission |
|---|-----------|----------------|------------|
| M1 | `chat/index.ts:60-65` | `conv` topic authorizer → `canRead` | `channel.read` |
| M2 | `chat/service.ts:71-74` | `canRead`: public channel or member | `channel.read` (moves into the policy; delete helper) |
| M3 | `chat/service.ts:77-91` | `requireReadable` / `requireWritable` | `channel.read` / `channel.post` |
| M4 | `chat/index.ts:201-242` | POST `/channels`: **no check** (any member) | `channel.create` |
| M5 | `chat/index.ts:250, 262, 276, 290, 350, 420, 466` | `canRead` → 404 | `channel.read` (404 on deny, no existence leak) |
| M6 | `chat/index.ts:321-341` | POST `/channels/:id/read`: **no check** | `channel.read` |
| M7 | `chat/index.ts:370-374` | add member requires being a member | `channel.members.add` |
| M8 | `chat/index.ts:438-442` | post requires membership; `:439` archived → 410 | `channel.post` (archived = resource-state deny) |
| M9 | `chat/index.ts:85-87` | agent mention auto-adds the bot ("members may add members") | `channel.members.add` evaluated for the poster |
| M10 | `chat/index.ts:107-115` | `providePostAgentMessage`: agent disabled → 403; agent not member → 403 | agent principal `channel.post` ∩ triggering human `channel.read` |
| M11 | `agent-channel/index.ts:38-43` | `requireActiveAgent` (disabled → 403) | Agent layer deny |
| M12 | `agent-channel/index.ts:46-62` | `requireMembership` (agent member of conv or parent) | agent `channel.read`/`channel.post` |
| M13 | `agent-channel/auth.ts:36-57, 82-89` | cell token → `CellPrincipal` | cell principal, `cell.sync` / `agent.act` |
| M14 | `agent/index.ts:66, 216, 225, 231` | `requireUser` only: GET `/models`, `/agents`, `/agents/:id` | `bot.read` |
| M15 | `organization/index.ts:28-35` | GET `/members`: `requireUser` only | `member.read` |
| M16 | `device/routes.ts:45-47` | `canUseDevice`: not revoked ∧ (owner ∨ shared) | `device.use` (Device layer) |
| M17 | `device/routes.ts:84-88` | `listUsableProjects` SQL filter owner/shared | `device.use` per row |
| M18 | `device/routes.ts:105-126` | POST `/devices/enrollments`: any member | `device.pair` |
| M19 | `device/routes.ts:181-187` | GET `/devices`: any member sees all devices | `device.read` |
| M20 | `device/routes.ts:200` | PATCH `/devices/:id`: owner only | `device.update` (owner relation) |
| M21 | `device/link.ts:46-58` | `/runtime/ws` bearer device token | device principal (JWT, Pattern 5) |
| M22 | `work-session/index.ts:25-34` | `ws` topic: any org member | `work_session.read` |
| M23 | `work-session/routes.ts:90, 231, 261, 349, 359, 369, 449` | list/get/prompt/edit/cancel/interrupt/diff: any member | `work_session.read` / `.prompt` / `.interrupt` |
| M24 | `work-session/routes.ts:115-120` | create: `canUseDevice` | `work_session.create` ∩ Device layer |
| M25 | `realtime/service.ts:52-53` | default `user` (self) and `org` (same org) authorizers | `self` relation, `org.read` |
| M26 | `identity/routes.ts:119` | GET `/me`: `requireUser` | `org.read` (returns `permissions`) |

### Web — role checks (replace with `useCan(permission)` or per-resource `viewerCan`)
| File:line | Code |
|-----------|------|
| `apps/web/lib/bots-queries.ts:41-45` | `useIsAdmin()` → `role === "owner" \|\| role === "admin"` (used in models-settings:44, bots-gallery:20, bots-runtime-settings:34, new-bot-sheet:39, bot-detail-sheet:45) |
| `apps/web/components/settings/members-settings.tsx:38-41, 43, 48` | `INVITE_ROLES` member/admin, `ROLE_ORDER` owner/admin/member, `isAdmin` |
| `apps/web/components/chat/channel-view.tsx:338-339` | `isAdmin`, `amOwner` → archive button |
| `apps/web/components/settings/devices-settings.tsx:155` | `isAdmin` → revoke button |
| `apps/web/components/work-zone/session-view.tsx:98-102` | approve allowed if creator/device owner/owner/admin |
| `apps/web/components/shell/workspace-switcher.tsx:52`, `chat/members-dialog.tsx:160` | display only (role label); update copy |

### Hard-coded client identifiers (AUTH-05: replace `"web"` with `auth.clientKind`)
`identity/service.ts:398`, `identity/routes.ts:86`, `chat/index.ts:451`, `work-session/routes.ts:181, 217`, `agent/index.ts:156, 196, 297, 391, 430`, `agent-channel/index.ts:139`, `agent-channel/provider-auth.ts:179, 223` [VERIFIED: grep + file reads this session]. The `"agent"` sites (agent-channel, subscription, service) stay as they are.

## Architecture Patterns

### System Architecture Diagram

```
 Browser (web / Electron window)                 Local Runtime daemon               OpenClaw cell
   │ cookie session (HttpOnly)                      │ device token (safeStorage→env)    │ cell token (unchanged)
   │                                                │                                    │
   │ GET /api/auth/token ──► better-auth jwt ──► EdDSA JWT (10 min, {sub,sid,org,ck})    │
   │                                                │ POST /api/v1/devices/token         │
   │                                                │   (Bearer device token) ──► signJWT{sub:deviceId, typ:device, aud:ocw:device-link}
   ▼                                                ▼                                    ▼
 ┌──────────────────────────────── Fastify API ─────────────────────────────────────────────────┐
 │ authn:  cookie session ─┐   Bearer JWT ─┐   WS subprotocol JWT ─┐   cell token ─┐            │
 │                         ▼               ▼                       ▼               ▼            │
 │                 Principal {kind: user|agent|cell|device, id, org, sid?, clientKind}          │
 │                         │      (jose verify vs cached JWKS; Redis revoked-sid check)         │
 │                         ▼                                                                    │
 │  route ──► facts loader (per request, memoized, inside withTenant tx as ocw_app)             │
 │              org_members(role, deactivated) · unit_memberships+paths · permission_rules      │
 │              + resource facts (channel, membership, device, session, agent)                  │
 │                         ▼                                                                    │
 │            resolveEffectivePermissions(principal, resource)  ── pure ──►                     │
 │              grants = role perms ∪ unit-lead perms ∪ relation grants                         │
 │              − denies(Org → Dept → Team → Project → User → Agent → Tool → Device)            │
 │                         ▼                                                                    │
 │            allow ──► handler writes + audit (same tx) ──► realtime append ──► Redis publish  │
 │            deny  ──► 404 (hidden) / 403 (visible) + denial audit in its own tx (mutations)   │
 │                                                                                              │
 │  admin/session actions ──► Redis `ocw:auth:revoked` {sid|userId} ──► /ws gateways close 4401 │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
        │ ocw_app (RLS: tenant only)                      │ ocw_auth (schema auth + audit/org_members)
        ▼                                                 ▼
   schema app: org_units, unit_memberships,          schema auth: user, session(+client_kind,label),
   permission_rules, org_members(+status, deact.)    account, verification, member, invitation, jwks
```

### Recommended Project Structure (new/changed files only)

```
packages/contracts/src/
├── permissions.ts          # Permission enum, OrgRole (4), UnitRole, ROLE_PERMISSIONS, AccessTokenClaims
├── organization.ts         # + OrgUnit, UnitKind, UnitMembership, PermissionRule, Member(+status, units)
└── identity.ts             # + SessionInfo, PasswordReset*, Profile*, MeResponse.permissions
packages/db/src/schema/
├── app.ts                  # + org_units, unit_memberships, permission_rules; org_members cols
└── auth.ts                 # + jwks; session.client_kind, session.client_label
packages/db/drizzle/<ts>_identity_org/       # generated DDL
packages/db/drizzle/<ts>_role_migration/     # custom: data migration (roles, invitations)
apps/api/src/modules/organization/
├── index.ts                # public interface (perms service, listMembers, …)
├── permissions/
│   ├── resolve.ts          # PURE: resolveEffectivePermissions, decide()
│   ├── policy.ts           # PURE: per-resource relation grants & preconditions
│   ├── facts.ts            # loads PrincipalFacts / ResourceFacts (Tx) — the only DB code
│   ├── service.ts          # can / assertCan / requirePermission / filter; per-request memo
│   ├── resolve.test.ts     # table-driven matrix + fast-check properties
│   └── guard.test.ts       # static "no ad-hoc checks" scan
├── units.ts                # units CRUD + move (advisory lock)
├── units.int.test.ts
├── members.ts              # role change, deactivate/reactivate, unit memberships
└── members.int.test.ts
apps/api/src/modules/identity/
├── auth.ts                 # + jwt plugin, session additionalFields, databaseHooks
├── authenticate.ts         # cookie OR bearer → Principal (split out of service.ts)
├── jwt.ts                  # AccessTokenVerifier (jose + JWKS cache), device token signer
├── invitations.ts          # split out of service.ts; adapter writes, no plugin authority
├── sessions.ts             # list / revoke / revoke-others + revocation publish
├── password.ts             # request (SMTP) / admin link / reset
├── profile.ts              # GET/PATCH me/profile, GET members/:id
└── routes.ts               # setup, me, better-auth allowlist (+token, jwks), failed sign-in audit
apps/api/src/lib/mailer.ts  # Mailer port + nodemailer SMTP adapter + in-memory fake
apps/api/src/authz.ts       # route authz registry (onRoute) + test-mode coverage hook
apps/local-runtime/src/device-link.ts       # fetch device JWT before connect
packages/realtime-client/src/client.ts     # getToken option, subprotocol, 4401 refresh-once
apps/web/lib/auth-token.ts                 # token manager (single-flight, refresh at T-60 s)
apps/web/lib/permissions.ts                # useCan()
apps/web/app/(auth)/reset-password/page.tsx
apps/web/app/(app)/settings/{organization,profile,security}/page.tsx
apps/web/components/settings/{org-structure,unit-detail,member-row,role-reference,profile-form,sessions-list}.tsx
```

### Pattern 1: Pure resolver over loaded facts (ORG-03)

**What:** One pure function decides. One loader gathers facts. One service composes them per request. No layer reads the DB during the decision.

**Semantics (prescriptive):**
1. **Principal gate (User / Agent / Device layers).** A deactivated user, a disabled or deleted agent, or a revoked device gets an empty set. The deny is recorded with its layer.
2. **Grants.**
   - `ROLE_PERMISSIONS[orgRole]` (org-wide persona).
   - ∪ `LEAD_PERMISSIONS` when the principal is `lead` of a unit on the resource's unit path. Unit-management actions use the target unit's path.
   - ∪ relation grants from `policy.ts` for the resource type: channel owner → archive/remove members, channel member → post/add members, session creator or device owner → approve/archive, device owner → update/revoke, self → profile/sessions.
3. **Preconditions** (resource state, also explicit denies): an archived channel denies `channel.post` and `channel.members.add`. A private channel the principal is not a member of denies `channel.read`. An offline device does not deny anything; it stays a 409 domain error, as today.
4. **Layer denies, top-down:** Org → each unit on the resource path (Department → Team → Project order, as stored) → User → Agent → Tool → Device. A deny comes from `permission_rules` whose scope contains the resource or the principal's unit membership and whose subject matches (everyone, role, user or agent), plus the state denies above. The first matching layer is recorded as `deniedBy`.
5. **Result:** `allowed(p) ⇔ p ∈ grants ∧ preconditions(p) ∧ ¬deny(p)`. Return `{ permissions: Set<Permission>, denied: Map<Permission, {layer, reason, ruleId?}> }`.
6. **Agent acting for a human** (bot reply after a mention): `effective = agentSet ∩ humanSet(conversation)`. This is the confused-deputy rule from PITFALLS §"model tool calls".

Every layer can only remove permissions. That is the PRD intersection, and "upper-level restrictions prevail" and "explicit deny beats allow" hold by construction: roles are the only source of allow, and there are no allow rules in Phase 2.

**Why `permission_rules` (deny-only) now:** without a persisted deny source, the Department, Team and Project layers can only grant, so the "intersection with explicit-deny precedence" cannot be demonstrated on real data. The table is small (`id, organization_id, scope_unit_id null=org, subject_kind, subject_id null, permission text (exact or `prefix.*`), effect 'deny', created_by, created_at`). Expose an admin-only API and keep the UI deferred (PRD §109.3 effective-permission viewer). See Open Question 2.

**Example:**
```typescript
// apps/api/src/modules/organization/permissions/resolve.ts  (pure: no imports from @ocw/db or fastify)
import { type Permission, ROLE_PERMISSIONS, LEAD_PERMISSIONS } from "@ocw/contracts";

export type Layer = "org" | "unit" | "user" | "agent" | "tool" | "device" | "resource";
export interface Deny { layer: Layer; reason: string; ruleId?: string; unitId?: string }

export interface PrincipalFacts {
  kind: "user" | "agent" | "cell" | "device";
  id: string;
  orgRole: OrgRole | null;            // users only
  deactivated: boolean;               // users: org_members.deactivated_at; agents: disabled/deleted; devices: revoked
  leadOfUnitIds: ReadonlySet<string>; // unit_memberships.role = 'lead'
  memberUnitPaths: readonly (readonly string[])[]; // ancestor paths of every unit the user belongs to
  onBehalfOf?: PrincipalFacts;        // agent reply triggered by a human
}
export interface ResourceFacts {
  type: ResourceType;                 // 'organization' | 'unit' | 'channel' | 'device' | 'work_session' | …
  unitPath: readonly string[];        // [] = organization root (every Phase 1 resource)
  relations: ReadonlySet<Relation>;   // 'self' | 'owner' | 'creator' | 'member' | 'device_owner' | 'inviter'
  state: ReadonlySet<ResourceState>;  // 'archived' | 'private' | 'revoked' | …
  tool?: string;                      // Tool layer input (approvals); pass-through in Phase 2
}
export interface Rule { id: string; scopeUnitId: string | null; subject: Subject; permission: string }

export function resolveEffectivePermissions(p: PrincipalFacts, r: ResourceFacts, rules: readonly Rule[]) {
  const denied = new Map<Permission, Deny>();
  if (p.deactivated) return { permissions: new Set<Permission>(), denied, principalDenied: layerOf(p) };
  const grants = new Set<Permission>([...rolePerms(p), ...leadPerms(p, r), ...relationGrants(r)]);
  for (const perm of grants) {
    const d = precondition(perm, p, r) ?? firstRuleDeny(perm, p, r, rules) ?? toolDeny(perm, r) ?? deviceDeny(perm, r);
    if (d) denied.set(perm, d);
  }
  let permissions = new Set([...grants].filter((x) => !denied.has(x)));
  if (p.onBehalfOf) permissions = intersect(permissions, resolveEffectivePermissions(p.onBehalfOf, r, rules).permissions);
  return { permissions, denied };
}
```
*(Sketch: names are recommendations. `OrgRole` here is the NEW four-value enum defined in Pattern 2, not today's `["owner", "admin", "member"]`.)*

### Pattern 2: Role model and data migration (ORG-02)

**Recommendation (explainable in one sentence each):**
- **Organization role (one per member)** = the PRD persona: `standard | developer | lead | admin`. It decides what a person can use anywhere, for example Work Zone needs `developer`. Stored in `app.org_members.role`, which becomes the single source of truth. `auth.member.role` is no longer read.
- **Unit membership** = `(unit, user, role ∈ {member, lead})`. `lead` grants Team Lead/Manager authority (manage that unit's members, and later share projects and configure team agents) over the unit's subtree. `lead` is assignable only to users whose org role is `lead` or `admin`.
- Invitations carry an org role. A Team Lead can invite with role `standard` or `developer` only (role ceiling: an inviter can never grant a role above their own, and only admins grant `lead`/`admin`). A lead may revoke invitations they created. An admin may revoke any.
- Invariant: an organization always has at least one active `admin`. Demoting or deactivating the last admin returns 409.

Why not unit-scoped personas ("Developer only in Team Alpha")? In Phase 2 no resource lives in a unit yet: channels, devices, sessions and bots are all organization-root resources. A unit-scoped `developer` would therefore grant nothing visible, which is a confusing UX. The resolver already takes `resource.unitPath`, so unit-scoped personas can arrive later without a schema change.

**Current values that change** [VERIFIED: packages/contracts/src/common.ts:17]:
```typescript
export const OrgRole = z.enum(["owner", "admin", "member"]);
```
[VERIFIED: packages/db/src/schema/app.ts:47]:
```typescript
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
```
These are TypeScript-only enums: there is no DB CHECK constraint (`drizzle/20261002175055_init/migration.sql:131-140` has none) [VERIFIED], so the data migration is plain `UPDATE`s.

**Data migration (custom drizzle migration, forward-only, idempotent):**
```sql
-- owner/admin → admin; member → developer (MVP 0 members could use Work Zone: keep that capability)
UPDATE app.org_members SET role = CASE role WHEN 'owner' THEN 'admin' WHEN 'admin' THEN 'admin'
                                            WHEN 'member' THEN 'developer' ELSE role END;
UPDATE auth.invitation SET role = CASE role WHEN 'owner' THEN 'admin' WHEN 'admin' THEN 'admin'
                                           WHEN 'member' THEN 'developer' ELSE role END;
UPDATE auth.member SET role = 'member';   -- no longer an authority; better-auth requires a value
```
Also add `CHECK (role in ('standard','developer','lead','admin'))` on `app.org_members.role` in the same migration, now that values are clean. The migration runs as `ocw_migrator`, which owns both schemas [VERIFIED: bootstrap.sql:3-6 comments]. Login is unaffected: sessions, accounts and passwords are untouched.

Other places that hard-code the old values and must change in the same plan: `chat/service.ts:119` (`case when m.role = 'owner' then 'owner' else 'member' end` in `#general` seeding → map `admin` to channel owner), `identity/service.ts:39-41`, `:170`, `:194`, `auth.ts:85` (`creatorRole: "owner"` → `"member"`), `packages/db/src/rls-isolation.int.test.ts` seed (`'owner'`), `apps/api/src/identity.int.test.ts:73, 116, 137, 156`, `e2e/tests/chat.spec.ts:26`, `scripts/demo-seed.mjs:155` (`role: "member"`), `packages/contracts/src/agent-channel.ts:49` comment. The roster `role` sent to bots is `z.string()` on both sides [VERIFIED: contracts/agent-channel.ts:50, openclaw-channel/src/agent-channel-protocol.ts:44], so the new values do not break the cell.

### Pattern 3: Hierarchy storage (ORG-01)

```typescript
// packages/db/src/schema/app.ts (sketch)
export const orgUnits = appSchema.table("org_units", {
  id: id(),
  organizationId: orgId(),
  parentId: uuid("parent_id"),                 // null = top level (child of the organization)
  kind: text("kind", { enum: ["department", "team", "project"] }).notNull(),
  name: text("name").notNull(),
  /** Ancestor ids root→self (self last). Maintained only by organization/units.ts under the org lock. */
  path: uuid("path").array().notNull(),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("org_units_parent_idx").on(t.organizationId, t.parentId),
  index("org_units_path_gin").using("gin", t.path),
  uniqueIndex("org_units_sibling_name_uq").on(t.organizationId, t.parentId, sql`lower(${t.name})`).nullsNotDistinct(),
]);
export const unitMemberships = appSchema.table("unit_memberships", {
  organizationId: orgId(),
  unitId: uuid("unit_id").notNull().references(() => orgUnits.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["member", "lead"] }).notNull().default("member"),
  addedBy: uuid("added_by"),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.unitId, t.userId] }), index("unit_memberships_user_idx").on(t.organizationId, t.userId)]);
```
(`.using("gin", …)` and `.nullsNotDistinct()` on an expression index are [ASSUMED] for drizzle 1.0.0-rc.4. The planner must check the generated SQL and hand-edit the migration if needed.)

- **Kind rules:** department under the org root or a department; team under a department or a team; project under a team or a department; projects are leaves. Validate on create and on move.
- **Move algorithm:** in one transaction, `select pg_advisory_xact_lock(hashtextextended('org_units:' || $org, 0))` serializes structural changes per org, which prevents the A-under-B / B-under-A cycle race. Reject if the target is the unit itself or `target.path @> ARRAY[$id]` (a descendant). Then:
  ```sql
  UPDATE app.org_units SET path = $newParentPath || path[array_position(path, $id):]
  WHERE organization_id = $org AND path @> ARRAY[$id]::uuid[];
  UPDATE app.org_units SET parent_id = $newParentId, updated_at = now() WHERE id = $id;
  ```
- **Delete:** allowed only for units without child units. Unit memberships cascade, and the audit row lists the removed member ids. No archive state in Phase 2.
- **RLS:** the generic `tenant_isolation` policy is applied automatically because the tables have `organization_id` [VERIFIED: packages/db/sql/post-migrate.sql:22-43]. No hierarchy logic in RLS (ARCHITECTURE.md §6). Add seed rows for both tables to `rls-isolation.int.test.ts` (deviation A-2).
- **better-auth mapping:** better-auth `organization` = our organization root; `member` = "belongs to the org" (existence only). better-auth teams stay **disabled**: the `invitation.team_id` column exists but is unused. All hierarchy lives in `app`.
- **Naming collision:** `app.projects` already exists and means "a repository registered on a device" (Work Zone) [VERIFIED: packages/db/src/schema/app.ts:331-350]. Do **not** rename it in this phase. Hierarchy projects are `org_units` rows with `kind = 'project'`. In the UI, call the Work Zone ones "local projects" or "repositories" only if a screen shows both. Linking a device repository to a hierarchy project (`projects.org_unit_id`) is deferred.

### Pattern 4: Mechanical enforcement — "no ad-hoc check left"

Three independent guards, each cheap:
1. **Type-level:** delete `role` from `AuthContext` [VERIFIED: apps/api/src/core.ts:16-23] and delete `requireRole`. Every R-site in the inventory then fails `pnpm typecheck` until it is migrated.
2. **Route coverage (runtime, test mode):** an `onRoute` hook records every route's `config.authz ∈ {"public", "user", "cell", "device"}`. A unit test boots the app and asserts that every route declares one, and that the `public` set equals an explicit allowlist (health, docs, setup status/setup, public invitation lookup/accept, the better-auth allowlist, password reset request/complete, `/devices/enroll` with pairing code, JWKS). In `NODE_ENV=test` an `onSend` hook throws when a non-public route answers 2xx without a resolver decision recorded on `req`. The existing integration suites (chat, workzone, agent-channel, identity) then fail if any route skips the resolver.
3. **Static scan (`guard.test.ts`):** read `apps/api/src/modules/**/*.ts` (excluding `*.test.ts` and `organization/permissions/**`) and fail on `/\.role\s*[!=]==/`, `requireRole\(`, `isAdmin\(`, `ownerUserId\s*[!=]==`, `createdBy\s*[!=]==`, `canUseDevice\(`, `canRead\(`. Scan `apps/web/{components,lib,app}/**/*.tsx?` for `organization\.role\s*===`. During Wave 2 the test reads a shrinking allowlist file (`legacy-authz-allowlist.json`); each module plan deletes its entries, and the final plan asserts the list is empty.

```typescript
// apps/api/src/authz.ts (sketch)
declare module "fastify" {
  interface FastifyContextConfig { authz?: "public" | "user" | "cell" | "device" }
  interface FastifyRequest { authzDecided?: boolean }
}
export function installAuthzRegistry(app: App, registry: Map<string, string | undefined>, strict: boolean) {
  app.addHook("onRoute", (r) => { registry.set(`${r.method} ${r.url}`, r.config?.authz); });
  if (strict) app.addHook("onSend", async (req, reply, payload) => {
    const mode = req.routeOptions.config?.authz;
    if (mode && mode !== "public" && reply.statusCode < 300 && !req.authzDecided)
      throw new Error(`route ${req.method} ${req.routeOptions.url} answered without a resolver decision`);
    return payload;
  });
}
```

**Lists** (channels, devices, projects, work sessions) filter in memory with `can(...)` per row. Lists are small in MVP. This keeps one definition of "can read" and avoids a SQL twin that could drift.

**HTTP mapping:** a deny on reading a resource the principal cannot see → 404 (existing behaviour: private channels stay invisible). A deny on a mutation of a visible resource → 403 `{ code: "forbidden", details: { permission, layer, reason } }`.

**UI gating:** `MeResponse.permissions: Permission[]` (organization-scope effective set) plus a `viewerCan: Permission[]` field on `ChannelSummary`, `WorkSessionDetail` and `Device`, computed by the resolver. `useCan(p)` replaces every web role check. The browser never re-implements policy.

### Pattern 5: JWT / JWKS for API, WebSocket and daemon (AUTH-06)

**better-auth config** (options verified in `node_modules/better-auth/dist/plugins/jwt/types.d.mts` this session):
```typescript
jwt({
  jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" }, rotationInterval: 60 * 60 * 24 * 30, gracePeriod: 60 * 60 * 24 * 7 },
  jwt: {
    issuer: env.OCW_PUBLIC_API_URL,
    audience: env.OCW_PUBLIC_API_URL,
    expirationTime: "10m",
    // Default payload is the WHOLE user object (email, name, image) [VERIFIED: jwt/sign.mjs getJwtToken]. Minimise:
    definePayload: ({ session }) => ({ sid: session.id, org: session.activeOrganizationId, ck: session.clientKind ?? "web" }),
  },
  disableSettingJwtHeader: true, // otherwise every get-session signs a JWT and exposes `set-auth-jwt` [VERIFIED: jwt/index.mjs:197-209]
}),
```
- Add the `auth.jwks` table (`id, public_key, private_key, created_at, expires_at, alg, crv`) [VERIFIED: jwt/schema.mjs] to `schema/auth.ts` and to the drizzle adapter's `schema` map (`jwks: dbSchema.jwks`). Keys are minted lazily on the first `/jwks` or sign call. Private keys are encrypted with `BETTER_AUTH_SECRET` [VERIFIED: jwt/sign.mjs:61-65].
- Add `GET /api/auth/token` and `GET /api/auth/jwks` to the better-auth allowlist proxy [VERIFIED current allowlist: identity/routes.ts:25-29 — `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`, `GET /api/auth/get-session`].
- `activeOrganizationId` must be set at session creation (`databaseHooks.session.create.before` → the user's single active membership), so the `org` claim is always present.

**Verification (`identity/jwt.ts`):** do **not** use better-auth's server `verifyJWT` per request: it loads all keys from the DB on every call [VERIFIED: jwt/verify.mjs:20]. Build `jose.createLocalJWKSet(await auth.api.getJwks())`, cache it in memory, and on `ERR_JWKS_NO_MATCHING_KEY` re-fetch once (30-second cooldown). Call `jwtVerify(token, set, { issuer, audience, algorithms: ["EdDSA"] })`, then Zod-parse the claims (`AccessTokenClaims` in contracts), then check Redis `EXISTS ocw:auth:revoked-sid:<sid>`. User tokens and device tokens use different `aud` values, so neither verifies as the other (test this).

**REST:** `authenticate(req)` accepts `Authorization: Bearer <JWT>` or the session cookie. The web app keeps the cookie for REST: it is HttpOnly, revocation is instant and there is no token handling in JS. Tests prove that Bearer works on every user route. See Open Question 1.

**Browser WebSocket:** `new WebSocket(url, ["ocw.v1", "ocw.auth." + jwt])`. JWT characters (base64url plus `.`) are valid RFC 7230 token characters. In `onRequest` (before upgrade), keep the Origin allowlist, read `sec-websocket-protocol`, verify the `ocw.auth.*` entry, and reject with 401 before the upgrade, exactly as today [VERIFIED: realtime/gateway.ts:32-41]. Register `@fastify/websocket` with `options: { maxPayload, handleProtocols: (protocols) => protocols.has("ocw.v1") ? "ocw.v1" : false }`. The server must echo `ocw.v1`, because Chrome fails a handshake that requested subprotocols and got none back [ASSUMED], and it must never echo the token. Add `req.headers["sec-websocket-protocol"]` to the Fastify logger `redact` list [VERIFIED current list: app.ts:57].
- **The connection outlives the token by design.** The JWT authenticates the upgrade. After that the socket is tied to `sid`: the existing 5-minute recheck becomes "session `sid` still exists and is not expired" (an `ocw_auth` query by id), and an immediate close (4401) happens on the Redis `ocw:auth:revoked` message for that `sid`, or for that `userId` on deactivation. Reconnect fetches a fresh token, and replay is unchanged because the frame protocol is untouched.
- **`packages/realtime-client`:** add `getToken?: (opts?: { force?: boolean }) => Promise<string>`, call it in `open()` before constructing the socket, and widen `WebSocketCtor` to `new (url: string, protocols?: string | string[])`. On close 4401: if `getToken({ force: true })` succeeds, reconnect once; if it fails with 401, stop (signed out). The existing test "stops on 4401" changes accordingly [VERIFIED: realtime-client/src/client.test.ts:82-86].
- **`apps/web/lib/auth-token.ts`:** single-flight `GET /api/auth/token` (credentials: include). Cache `{ token, exp }` (decode `exp` without verifying) and refresh when fewer than 60 s remain. `RealtimeProvider` passes `getToken`.

**Daemon (Device Link):** add `POST /api/v1/devices/token` (authz `device`; Bearer device token checked through the existing `app.lookup_device_token` SECURITY DEFINER function [VERIFIED: post-migrate.sql:52-57]). It returns `auth.api.signJWT({ body: { payload: { sub: deviceId, org, typ: "device", aud: "ocw:device-link", exp: now + 600 } } })`. `signJWT` is a server-only endpoint that honours payload `aud`/`exp` overrides [VERIFIED: jwt/sign.mjs:75-111]. `apps/local-runtime/src/device-link.ts` fetches the token before each connect (it already sends `Authorization: Bearer` [VERIFIED: device-link.ts:102]). `/runtime/ws` verifies the JWT and re-checks that the device is not revoked (`withTenant({org})`). Revocation already closes the socket (`hub.disconnect(…, 4403, …)` [VERIFIED: device/routes.ts:254]).
- **Transition:** desktop apps built before this phase send the raw device token to `/runtime/ws`. Recommend `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` (default `true` in Phase 2; warn log + `device.legacy_token_used` audit at most once per device per hour; removed in Phase 8 with RFC 8628) so the demo Mac keeps working until rebuilt. See Open Question 3.

**Agent Channel cell token:** keep it as is (hashed, rotatable, server-to-server on an internal network, Agent Channel scope only [VERIFIED: agent-channel/auth.ts:23-30]). AUTH-06 names API, WebSocket and daemon, not the cell. Moving it later uses the same verifier.

### Pattern 6: Sessions with client identifier, list and revoke (AUTH-05)

- `session.additionalFields`: `clientKind` (`web|desktop|mobile`, `input: false`) and `clientLabel` (for example "Chrome on macOS"). Add matching columns to `auth.session` [VERIFIED current columns: packages/db/src/schema/auth.ts:21-37, which include `ipAddress`, `userAgent`, `activeOrganizationId`].
- `databaseHooks.session.create.before(session, ctx)`: derive `clientKind` from an optional `x-ocw-client` header, else from the User-Agent (`/ Electron\//` → `desktop`; the desktop window does not override the UA [VERIFIED: no setUserAgent in apps/desktop/src]). Derive `clientLabel` with a ~15-line regex for browser and OS families; do **not** add `ua-parser-js` (v2 is AGPL, v1 is unmaintained) [ASSUMED]. Set `activeOrganizationId`, and return `false` (block sign-in) when the user's org membership is deactivated. The hook signature `before(session, context: GenericEndpointContext | null)` returning `boolean | void | { data }` is [VERIFIED: @better-auth/core/dist/types/init-options.d.mts:1263-1274 region].
- `AuthContext` gains `clientKind`, which every audit/message write uses instead of `"web"` (inventory above). The ClientKind enum already includes desktop [VERIFIED: contracts/common.ts:20 — `export const ClientKind = z.enum(["web", "desktop", "mobile", "agent", "system"]);`].
- Routes: `GET /api/v1/me/sessions` → `{ id, clientKind, clientLabel, ipAddress, createdAt, lastActiveAt (updatedAt), current }`, **never `token`**. `DELETE /api/v1/me/sessions/:id` (must belong to the caller; 404 otherwise). `POST /api/v1/me/sessions/revoke-others`. Each deletes rows through the auth-plane adapter inside `runWithTransaction` with `auditVia(session.revoked)` in the same transaction, then after commit publishes `ocw:auth:revoked {sid}` and sets `ocw:auth:revoked-sid:<sid>` with TTL 900 s (longer than the JWT lifetime).
- Admin deactivation (`members.ts`): an `ocw_app` transaction sets `org_members.deactivated_at` + audit `member.deactivated`. After commit, identity deletes all of that user's sessions (`internalAdapter.deleteUserSessions`) and publishes `{userId}`. Security does not depend on the second step: the resolver's User layer denies every permission to a deactivated member, and `authenticate` rejects them.

### Pattern 7: Password reset (AUTH-04)

better-auth's `/reset-password` consumes a verification row `reset-password:<token>` whose `value` is the user id, updates the credential, and optionally deletes all sessions [VERIFIED: better-auth/dist/api/routes/password.mjs:148-170]. Reuse that storage and expose our own routes:
- **Admin-issued link** (always available): `POST /api/v1/members/:userId/password-reset-link` (`member.manage`). In an auth-plane transaction, `internalAdapter.createVerificationValue({ identifier: "reset-password:" + token, value: userId, expiresAt: now + 24 h })` plus `auditVia(password.reset_link_issued)`. Returns `{ link: WEB/reset-password?token=…, expiresAt }` once (copy dialog, the same UX as invitation links). Admins cannot issue a link for themselves; they use "change password" (out of scope; see Open Questions).
- **Self-service email** (only when `OCW_SMTP_URL` is set): `POST /api/v1/password-reset/request { email }` → `auth.api.requestPasswordReset({ body: { email, redirectTo: WEB/reset-password } })` with `emailAndPassword.sendResetPassword` wired to the `Mailer`. It always answers 200 (better-auth already simulates the lookup for unknown emails [VERIFIED: password.mjs:58-66]). Rate limited like sign-in.
- **Complete:** `POST /api/v1/password-reset { token, newPassword }` → `runWithTransaction(() => auth.api.resetPassword({ body }))` with `emailAndPassword.revokeSessionsOnPasswordReset: true` and `onPasswordReset: ({ user }) => auditVia(password.reset_completed)`, which joins the same transaction. Publish `{userId}` revocation after commit.
- `GET /api/v1/setup/status` (or a new public `GET /api/v1/auth/capabilities`) returns `{ passwordResetEmail: boolean }` so the login page shows either the email form or "Ask an admin for a reset link".
- `Mailer` port: `send({ to, subject, text, html })`. The nodemailer SMTP adapter is built from `OCW_SMTP_URL` + `OCW_MAIL_FROM`; tests use an in-memory fake. Fail fast at boot if the URL is set but invalid (env.ts style). Accept `OCW_SMTP_URL_FILE` as well (add to `SECRET_VARS` [VERIFIED pattern: config/env.ts:53-61]).

### Pattern 8: Profile (ORG-06)

- Fields: display name (existing `DisplayName` 1-80 [VERIFIED: contracts/identity.ts:6]); avatar = emoji **or** `https:` URL, the same model bot avatars already use [VERIFIED: chat/principal-avatar.tsx:45-50]; status = emoji + text up to 80 characters, clearable. Avatar upload waits for Phase 4 object storage, and the field shape stays the same.
- Storage: `auth.user.name`/`image` plus `app.org_members.display_name`/`avatar_url`, and new columns `status_emoji`, `status_text`, `deactivated_at`. Write all in one auth-plane transaction: `auth.api.updateUser` + `adapter.update({ model: "orgMember" })` + `auditVia(user.profile_updated)`. Extend the internal plugin schema [VERIFIED: identity/auth.ts:34-43] with the new orgMember fields, then append `member.updated` on `org:<id>` after commit so directories refresh. The chat directory reads `org_members.display_name` [VERIFIED: chat/directory.ts:33], so names update everywhere.
- `GET /api/v1/members/:userId` → profile (name, avatar, status, org role, units, joinedAt), `member.read`. Render `<img referrerPolicy="no-referrer">` for URL avatars to limit tracking.

### Audit additions (ORG-05)

| Action | Transaction | `result` |
|--------|-------------|----------|
| `user.sign_in_failed` | own tx (no domain write); org = the user's org when the email is known, else the instance org; metadata `{ email (lower-cased), ip, reason: status }`; volume bounded by the existing 30/min/IP limit [VERIFIED: identity/routes.ts:22] | `denied` |
| `user.signed_out` | own tx (session row already gone) | success |
| `session.revoked` (self / others / admin) | same auth-plane tx | success |
| `unit.created` / `unit.renamed` / `unit.moved` (from/to parent, kind) / `unit.deleted` | same `ocw_app` tx | success |
| `unit_membership.added` / `.removed` / `.role_changed` | same tx | success |
| `member.role_changed` (from, to) / `member.deactivated` / `member.reactivated` | same tx | success |
| `invitation.created` (now with role) / `invitation.revoked` | same auth-plane tx (existing) | success |
| `password.reset_link_issued` / `password.reset_requested` / `password.reset_completed` | same auth-plane tx | success |
| `user.profile_updated` (changed field names only) | same tx | success |
| `permission_rule.created` / `.deleted` | same tx | success |
| `authz.denied` on **mutations** (`{ permission, layer, reason, route }`) | **own tx** after rollback (see Pitfall 4) | `denied` |

Audit `result` values available today [VERIFIED: packages/db/src/schema/app.ts:72 — `result: text("result", { enum: ["success", "denied", "error"] }).notNull(),`]; actor kinds [VERIFIED: app.ts:62 — `actorKind: text("actor_kind", { enum: ["user", "agent", "system", "device"] }).notNull(),`].

### Admin console UX (ORG-04) — extend Settings

Settings nav today: Members, Models, Bots runtime, Devices [VERIFIED: apps/web/components/settings/settings-nav.ts:11-16]. Add **Organization**, **Profile** and **Security**. The Organization and Members entries only appear when `useCan` allows it.

1. **Settings › Members (extend existing page).** Rows show avatar, name, email, a role select (four roles, editable with `member.manage`, otherwise a read-only badge), unit chips, and a status pill (Active / Deactivated, filter toggle). The row menu has: Change role, Manage units, Create password reset link (copy dialog), Deactivate/Reactivate (confirm dialog that names what happens: sessions end, history kept). The invite form uses a role select limited by the inviter's ceiling. The pending invitations list already exists. A "What can each role do?" link opens a sheet with the role × capability matrix generated from `ROLE_PERMISSIONS`; this is the read-only "roles" CRUD, since custom roles are out of scope. Empty state (only the admin is present): "It's just you so far. Invite your team with a link — no email server needed." with the invite form focused.
2. **Settings › Organization (new).** Two panes at 1440 px (tree | unit detail); at 390 px the tree is a list and the detail opens as a sheet. The tree indents Department → Team → Project with kind icons and member counts. Actions: New department (top), "Add team/project" on a node, Rename inline, "Move to…" dialog with a parent picker that disables the node's own subtree and invalid kinds (no drag and drop: accessible and works on mobile), and Delete (disabled with a tooltip while the unit has children). Unit detail shows members with a Lead toggle, "Add people" (combobox of org members) and Remove. Empty state: "Mirror how your company is organised. Start with a department, then add teams and projects inside it." CTA "New department".
3. **Settings › Profile (new).** Avatar picker (emoji grid + URL field + initials preview), display name, status (emoji + text, Clear), email and role read-only.
4. **Settings › Security (new).** Sessions list (icon by client kind: Globe/Monitor/Smartphone, "Chrome on macOS · Desktop app", IP, last active, a "This device" badge), Revoke per row, and "Sign out everywhere else".
5. **Auth pages:** `/reset-password?token=` (new password + confirm, then redirect to `/login` with a toast); the login page gets a "Forgot password?" link that branches on `passwordResetEmail`.
6. **Member profile sheet:** clicking a member name or avatar (Members page, channel members dialog) opens the profile.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JWT signing, key storage and rotation | own key table + `crypto.sign` | better-auth `jwt` plugin (`jwks` table, lazy mint, `rotationInterval`, `gracePeriod`) | Encrypted private keys, JWKS endpoint, `kid` handling already done |
| JWT verification | manual base64 + `crypto.verify` | `jose.jwtVerify` + `createLocalJWKSet` | alg confusion, `exp`/`nbf`/`aud`/`iss` checks, kid selection |
| Reset tokens | own token table | better-auth verification rows + `resetPassword` (single use via `consumeVerificationValue`) | Race-safe consume, hashing, session revocation flag |
| Password hashing on reset | own scrypt | `ctx.password.hash` inside `resetPassword` | Same hasher as sign-in |
| SMTP | raw sockets | nodemailer | TLS/STARTTLS, auth, encoding |
| Property generators | ad-hoc random loops | fast-check | Shrinking gives minimal counterexamples for permission bugs |
| Same-tx audit in the auth plane | compensating deletes | `runWithTransaction` + `getCurrentAdapter` (Phase 1 SPIKE, deviation A-6) | Proven rollback |

**Key insight:** better-auth authenticates and stores, and it must never authorize. The moment an endpoint calls a better-auth plugin API with the user's headers, the plugin's own role model becomes a second, hidden authority (R12).

## Runtime State Inventory

This phase renames role values and changes the authentication transport, so this inventory applies.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | `app.org_members.role` (`owner/admin/member`), `auth.invitation.role` (pending and historical), `auth.member.role`; `app.conversation_members.role` is channel-level `owner/member` and **unchanged**; historical `audit_events.metadata.role` and `stream_events` `member.joined` payloads keep the old values (history, read-only) | **Data migration** (SQL above) + code edits; do not rewrite history |
| Live service config | OpenClaw cell: the roster `role` is per-mention data, not config; nothing stored | None (verified: `z.string()` on both sides) |
| OS-registered state | Desktop app (ad-hoc built `.app`) and its daemon send the raw device token on `/runtime/ws` | Legacy-token flag (Pattern 5) or rebuild the app; no OS registration changes |
| Secrets / env vars | `BETTER_AUTH_SECRET` now also encrypts the JWKS private keys: rotating it breaks signing until the `auth.jwks` rows are deleted. New optional `OCW_SMTP_URL`/`_FILE`, `OCW_MAIL_FROM`, `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` | Update `.env.example`, `scripts/setup-env.mjs` and `docs/DEMO.md`; document the rotation caveat |
| Build artifacts | Demo Postgres volume (migrated by the one-shot `migrate` service); CI images rebuilt per PR; installed desktop app (see OS-registered state) | Run `pnpm db:migrate` / `pnpm demo:reset`; rebuild the desktop app |

Redis keys: provider-auth flow state is unrelated. The new keys `ocw:auth:revoked-sid:*` and channel `ocw:auth:revoked` are created by this phase.

## Common Pitfalls

### Pitfall 1: Calling better-auth org plugin endpoints with user headers
**What goes wrong:** `createInvitation({ headers })` runs the plugin's `hasPermission` and rejects `developer`/`lead` with `ROLE_NOT_FOUND` [VERIFIED: crud-invites.mjs:95-122], and `cancelInvitation` does the same. Leads cannot invite even though our resolver allows it.
**How to avoid:** after `assertCan`, write `invitation` rows with `adapter.create/update` inside `runWithTransaction`.
**Warning sign:** a 403 from `/api/v1/invitations` with a better-auth error code.

### Pitfall 2: Chrome rejects the WS when no subprotocol is echoed
**What goes wrong:** the client requests `["ocw.v1", "ocw.auth.<jwt>"]` and the server does not select one, so the handshake fails in Chrome [ASSUMED].
**How to avoid:** `handleProtocols` selects `ocw.v1`. Never select the token entry. The e2e chat spec (live messages) is the regression test.

### Pitfall 3: Default JWT payload leaks PII
**What goes wrong:** without `definePayload`, the JWT carries the full user object (email, name, image) [VERIFIED: jwt/sign.mjs getJwtToken].
**How to avoid:** minimal claims `{ sub, sid, org, ck }` and a unit test that decodes a real token and asserts its exact key set.

### Pitfall 4: A denied mutation's audit row rolls back with it
**What goes wrong:** `assertCan` throws inside `withTenant`, the transaction rolls back, and the `authz.denied` row inserted in it disappears.
**How to avoid:** `assertCan` throws an `HttpError` carrying the denial. A Fastify `onError` hook (or the error handler) writes `authz.denied` in a **separate** `withTenant` transaction. Only for non-GET routes, to bound volume.

### Pitfall 5: Revoked session still holds a valid JWT or an open socket
**How to avoid:** Redis `revoked-sid` set with TTL ≥ JWT lifetime, checked on every Bearer verify; `ocw:auth:revoked` pub/sub closes sockets in every API instance; the 5-minute session recheck stays as a backstop. Test: revoke → next REST call with the old JWT gets 401, and the open WS closes with 4401 within 1 s.

### Pitfall 6: Concurrent unit moves create a cycle
**What goes wrong:** move A under B and B under A in parallel: each check passes on stale paths.
**How to avoid:** a per-org `pg_advisory_xact_lock` before reading paths. Add a property test (random create/move sequences keep `path[last] = id`, `path[:-1] = parent.path`, no cycles) and one concurrency integration test.

### Pitfall 7: Demoting the last admin locks the org out
**How to avoid:** inside the role-change/deactivate transaction, `select count(*) … where role='admin' and deactivated_at is null for update`; return 409 `last_admin`.

### Pitfall 8: Role migration silently removes Work Zone access
**What goes wrong:** mapping `member → standard` makes every existing teammate lose Work Zone (PRD: Work Zone is a Developer capability).
**How to avoid:** map `member → developer`. Integration test: seed MVP 0 roles, run the migration, assert the former member can still create a work session.

### Pitfall 9: `/list-sessions` and `/revoke-session` expose session tokens
**How to avoid:** never add them to the allowlist; use our own routes that select explicit columns (Pattern 6).

### Pitfall 10: `BETTER_AUTH_SECRET` rotation breaks JWT signing
**What goes wrong:** the private keys were encrypted with the old secret, so `signJWT` throws "Failed to decrypt private key" [VERIFIED: jwt/sign.mjs:65].
**How to avoid:** document it in DEMO/self-host docs: rotating the secret requires `DELETE FROM auth.jwks` (all JWTs become invalid, and clients refetch).

### Pitfall 11: The resolver becomes N+1 queries per list
**How to avoid:** the facts loader loads principal facts once per request (memo keyed by `req`) and resource relations in bulk for list endpoints (one membership query for all listed channels).

### Pitfall 12: The `projects` naming collision
**How to avoid:** hierarchy projects are `org_units(kind='project')`; never add hierarchy columns to `app.projects` in this phase; contract names `OrgUnit`/`UnitKind`, not `Project`.

## Code Examples

### Route usage after migration (chat archive, the tracer route)
```typescript
// apps/api/src/modules/chat/index.ts (sketch)
app.post("/channels/:id/archive",
  { config: { authz: "user" }, preHandler: requireUser, schema: { tags, params: IdParams, response: { 200: ChannelSummary } } },
  async (req) => core.db.withTenant(tenant(req), async (tx) => {
    const auth = authOf(req);
    const conv = await getChannel(tx, req.params.id);
    // 404 when channel.read is denied (existence hidden), 403 with {permission, layer} otherwise
    await core.perms.assertCan(req, tx, "channel.archive", conv && (await channelResource(tx, conv, auth)));
    if (conv!.slug === GENERAL_SLUG) throw badRequest("#general cannot be archived", "default_channel");
    // … unchanged write + audit + realtime …
  }));
```

### Org-scope preHandler (providers)
```typescript
const providers = core.perms.requirePermission("provider.manage"); // loads facts in a short withTenant, marks req.authzDecided
app.get("/model-providers", { config: { authz: "user" }, preHandler: providers, schema: { … } }, handler);
```

### Property tests (fast-check)
```typescript
import fc from "fast-check";
it("adding a deny rule never grants anything", () => {
  fc.assert(fc.property(arbPrincipal, arbResource, arbRules, arbRule, (p, r, rules, extra) => {
    const before = resolveEffectivePermissions(p, r, rules).permissions;
    const after = resolveEffectivePermissions(p, r, [...rules, extra]).permissions;
    return [...after].every((x) => before.has(x));
  }));
});
it("a deny at an ancestor unit beats any grant below it", () => { /* rule scoped to path[0] ⇒ ¬allowed */ });
it("deactivated principals get nothing", () => { /* ∀ p.deactivated ⇒ size 0 */ });
it("agent acting for a human never exceeds the human", () => { /* agent∩human ⊆ human */ });
it("order of assignments and rules does not matter", () => { /* shuffle invariance */ });
```
Plus a **table-driven matrix test**: for each of the four roles × each organization-scope permission, the expected boolean, written as a literal table in the test file. It is reviewed as the human-readable policy and doubles as the source of the "What can each role do?" sheet.

### WS gateway authentication (before upgrade)
```typescript
onRequest: async (req, reply) => {
  const origin = req.headers.origin;
  if (!origin || !deps.allowedOrigins.has(origin)) return reply.code(403).send(/* unchanged */);
  const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
  const token = offered.find((p) => p.startsWith("ocw.auth."))?.slice("ocw.auth.".length);
  const auth = token ? await deps.identity.verifyAccessToken(token) : null;  // jose + revoked-sid
  if (!auth) return reply.code(401).send({ error: { code: "unauthorized", message: "Sign in required" } });
  req.auth = auth;
},
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| better-auth `forgetPassword` | `requestPasswordReset` (`/request-password-reset`) | better-auth 1.x [VERIFIED: route list in 1.7.6 dist] | Use the new name |
| JWT in WS query string | Subprotocol or first-frame auth | community practice (Kubernetes uses a subprotocol bearer) [ASSUMED] | Keeps tokens out of URLs and logs |
| better-auth OIDC plugin | `@better-auth/oauth-provider` separate package (1.7.7) | 1.4+ [ASSUMED from registry dist-tags] | Defer; shares the `jwks` table |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Chrome fails a WS handshake that offered subprotocols when the server echoes none | Pattern 5, Pitfall 2 | Low: `handleProtocols` echoes `ocw.v1` anyway; e2e catches it |
| A2 | `@fastify/websocket` forwards `options.handleProtocols` to `ws` (v8 signature `(protocols: Set<string>, req)`) | Pattern 5 | Medium: fallback is the `?token=` param with log redaction |
| A3 | drizzle 1.0.0-rc.4 emits `USING gin` and `NULLS NOT DISTINCT` on the expression unique index | Pattern 3 | Low: hand-edit the generated SQL |
| A4 | `internalAdapter.deleteUserSessions` / `createVerificationValue` join an outer `runWithTransaction` like `signUpEmail` does (Phase 1 SPIKE) | Patterns 6–7 | Medium: prove with a rollback spike test in the plan (the same technique as the Phase 1 SPIKE) |
| A5 | `ua-parser-js` v2 is AGPL and v1 unmaintained, so a small regex is preferable | Pattern 6 | Low: cosmetic label only |
| A6 | Mapping `member → developer` is what the owner wants (it preserves today's Work Zone access) | Pattern 2 | Medium: if the owner wants `standard`, existing teammates lose Work Zone; confirm in discuss-phase |
| A7 | Org role = persona and unit role ∈ {member, lead} satisfies SC2's "assigns members with one of the four roles" | Pattern 2 | Medium: if unit-scoped personas are required, add `standard`/`developer` to the unit role enum (no other schema change) |
| A8 | Logging the attempted email on `user.sign_in_failed` is acceptable (standard IdP practice) | Audit | Low: switch to a hash |
| A9 | `onPasswordReset` runs inside the ALS transaction opened by our `runWithTransaction` | Pattern 7 | Medium: fallback is to audit in its own tx (no domain write left uncovered, since the password update already committed) |

## Open Questions (each has a recommended default; none blocks planning)

1. **Web REST: cookie or Bearer?**
   - Known: SC4 requires that API connections accept short-lived JWTs and that WS moves to JWT. Cookies are HttpOnly and revoke instantly.
   - **Default:** the API accepts both; the web keeps the cookie for REST and uses JWT for WS; the daemon and future mobile use JWT. Tests prove Bearer on every route. Alternative: the web also sends Bearer from the token manager (more change in `apps/web/lib/api.ts`, same server).
2. **Persisted deny rules (`permission_rules`) without a UI?**
   - **Default:** include the table, resolver support and an admin API, so explicit deny is real and testable at every grain. Defer the UI to the effective-permission viewer (PRD §109.3). Alternative: only state-based denies (deactivated, disabled, revoked, archived) in Phase 2; the unit grains would then grant only.
3. **Legacy device token on `/runtime/ws`.**
   - **Default:** accept it behind `OCW_ACCEPT_LEGACY_DEVICE_TOKEN=true` until Phase 8, audited once per device per hour, so the installed demo desktop keeps working. Alternative: hard switch and rebuild the desktop app.
4. **Change password while signed in** (not in AUTH-04, but users will expect it on the Security page).
   - **Default:** add `POST /api/v1/me/password` (current + new, revokes other sessions), about 30 lines, because admins otherwise cannot reset their own password. Mark it as an extra in the plan.
5. **Invite directly into a unit.**
   - **Default:** deferred. A lead invites to the org, then adds the person to the unit. No retrofit cost (the invitation row can carry a unit later).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | everything | ✓ | v24.21.0 | — |
| pnpm (corepack) | install/verify | ✓ | 12.8.1 | — |
| Docker | testcontainers (postgres:18, redis:8), e2e | ✓ | 29.6.2 Docker Desktop (disk heavily used: 47 GB volumes, 18 GB build cache) | `docker builder prune` (only build cache, as in deviation A-12) |
| PostgreSQL 18 | `uuid[]` + GIN, `uuidv7()` | ✓ (container) | 18 | — |
| SMTP server | self-service reset email | ✗ (optional) | — | Admin-issued link; tests use the in-memory `Mailer` fake |

**Missing dependencies with no fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 (projects `unit`, `integration`), Playwright 1.63.0 (e2e, desktop + mobile projects) [VERIFIED: package.json, vitest.config.ts] |
| Config file | `vitest.config.ts` (root), `e2e/playwright.config.ts` |
| Quick run command | `pnpm vitest run --project unit apps/api/src/modules/organization` |
| Integration (one file) | `pnpm vitest run --project integration apps/api/src/modules/organization/units.int.test.ts` |
| Full suite command | `pnpm verify` (lint + typecheck + unit + integration) and `pnpm --filter @ocw/local-runtime test` |
| E2E | `pnpm e2e` (CI job `e2e` with `OCW_MODEL_PROVIDER=mock`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ORG-03 | Role × permission matrix (literal table) | unit | `pnpm vitest run --project unit apps/api/src/modules/organization/permissions/resolve.test.ts` | ❌ Wave 0 |
| ORG-03 | Deny monotonicity, ancestor deny wins, deactivated ⇒ ∅, agent∩human ⊆ human, order invariance | unit (fast-check) | same file | ❌ |
| ORG-03 | No ad-hoc checks (static scan, API + web) | unit | `…/permissions/guard.test.ts` | ❌ |
| ORG-03 | Every route declares authz; public set = allowlist; 2xx without decision fails in test mode | unit + all integration suites | `apps/api/src/authz.test.ts`; `pnpm test:integration` | ❌ |
| ORG-03 | Deny paths per migrated route (standard cannot create sessions/pair devices, lead cannot manage providers, non-owner cannot archive a channel, approval by an unrelated developer → 403, bot not a member → 403) | integration | `chat.int.test.ts`, `workzone.int.test.ts`, `agent-channel.int.test.ts` (extend) | ✅ extend |
| ORG-03 | Cross-tenant: new tables return 0 rows across orgs | integration | `packages/db/src/rls-isolation.int.test.ts` (add seeds) | ✅ extend |
| ORG-02 | Data migration owner/admin→admin, member→developer; former member still creates a work session; invitations remapped | integration | `packages/db/src/role-migration.int.test.ts` | ❌ |
| ORG-02 | Role ceiling (lead cannot invite admin/lead), last-admin 409, lead manages only their subtree | integration | `organization/members.int.test.ts` | ❌ |
| ORG-01 | Create/rename/move/delete units, kind rules, cycle rejection, concurrent moves serialize, path invariants (property) | unit + integration | `organization/units.test.ts`, `units.int.test.ts` | ❌ |
| AUTH-06 | JWKS served; token claims exactly `{sub,sid,org,ck,iat,exp,iss,aud}`; Bearer on REST; device token cannot be used as a user token and vice versa; revoked sid → 401 | integration | `identity/jwt.int.test.ts` | ❌ |
| AUTH-06 | WS: foreign origin 403, no/expired token 401 before upgrade, subscribe + replay exactly once with JWT, revocation closes 4401 < 1 s | integration | `identity.int.test.ts` (rewrite the WS cases) | ✅ extend |
| AUTH-06 | realtime-client: getToken before connect, 4401 → refresh once then reconnect; refresh fails → stop | unit | `packages/realtime-client/src/client.test.ts` | ✅ extend |
| AUTH-06 | Daemon fetches a device JWT and connects; legacy token behaviour per flag | unit + integration | `apps/local-runtime/src/daemon.test.ts`, `workzone.int.test.ts` | ✅ extend |
| AUTH-05 | Session list has no token; clientKind desktop via Electron UA; revoke own only (other user's id → 404); revoke-others; audit row in same tx | integration | `identity/sessions.int.test.ts` | ❌ |
| AUTH-04 | Admin link: single use, 24 h expiry, sessions revoked, audit; self-service with fake Mailer; unknown email → 200 and no mail | integration | `identity/password.int.test.ts` | ❌ |
| ORG-05 | Failed sign-in audited (`denied`); denied mutation audited despite rollback; profile/unit/role/membership/session actions audited in the same tx (rollback spike) | integration | spread across the files above + `identity.int.test.ts` | ✅/❌ |
| ORG-06 | Profile edit updates the chat directory name; another member's profile visible; avatar URL must be https | integration | `identity/profile.int.test.ts` | ❌ |
| ORG-04 / UI | Admin creates a dept→team→project, moves a team, sets a role, adds a lead; teammate signs in and sees their role; reset link flow; revoke a session; edit profile; at 390 and 1440 px with screenshots | e2e | `e2e/tests/admin-console.spec.ts`, `e2e/tests/account.spec.ts` | ❌ |
| regression | Existing specs (setup, smoke, chat, bots, work-zone, codex-subscription) stay green with new roles | e2e | `pnpm e2e` | ✅ update role strings |

### Sampling Rate
- **Per task commit:** the unit project for the touched package plus the one integration file for the touched module.
- **Per wave merge:** `pnpm verify` + `pnpm --filter @ocw/local-runtime test`.
- **Phase gate:** `pnpm verify`, local-runtime and desktop suites, and `pnpm e2e` green. The legacy-authz allowlist must be empty and the coverage hook strict before `/gsd-verify-work 2`.

### Wave 0 Gaps
- [ ] `apps/api/src/modules/organization/permissions/resolve.test.ts` + `guard.test.ts`
- [ ] `apps/api/src/authz.test.ts` (route registry)
- [ ] `packages/db/src/role-migration.int.test.ts`
- [ ] Seed rows for `org_units`, `unit_memberships`, `permission_rules` in `rls-isolation.int.test.ts`
- [ ] `fast-check` dev dependency (behind the checkpoint)
- [ ] `TestClient.token()` helper (GET `/api/auth/token`) in `apps/api/src/testing.ts`; `Mailer` fake

## Security Domain

`security_enforcement: true`, ASVS level 1 [VERIFIED: .planning/config.json].

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | better-auth credentials (min 12 chars [VERIFIED: identity/auth.ts:77]); reset tokens single-use with 24 h admin / 1 h self expiry; failed sign-in audit; rate limit 30/min |
| V3 Session Management | yes | Session list/revoke; revoked-sid deny-list; WS bound to sid; sessions revoked on password reset and deactivation |
| V4 Access Control | yes | One resolver, deny by default, 404 for hidden resources, role ceiling, last-admin invariant, route coverage guard |
| V5 Input Validation | yes | Zod on every new body/param/claim; https-only avatar URLs; unit kind/parent validation |
| V6 Cryptography | yes | EdDSA (Ed25519) via better-auth + jose; private JWKS keys encrypted with the auth secret; never hand-rolled |
| V7 Error/Logging | yes | Audit table; redact `authorization`, `cookie`, `sec-websocket-protocol`; never log JWTs or reset tokens |
| V13 API/WebSocket | yes | Origin allowlist + JWT before upgrade; subprotocol echo excludes the token |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Team Lead escalates someone (or self) to admin | Elevation | Role ceiling in the policy + integration test |
| IDOR on `DELETE /me/sessions/:id` | Elevation | Filter by `user_id = auth.userId`, 404 otherwise |
| Stale JWT after revoke/deactivate | Spoofing | Redis revoked-sid check; short `exp` (10 min) |
| Reset link leaked (chat, screenshot) | Spoofing | Single use, 24 h, shown once, all sessions revoked on use, audited |
| Account enumeration via forgot-password | Info disclosure | Always 200; better-auth simulates the lookup |
| Cross-tenant unit move / membership | Tampering | RLS on all new tables; parent looked up inside `withTenant`; enumerator test |
| Hierarchy cycle via concurrent moves | Tampering/DoS | Per-org advisory lock + property test |
| Token in logs (WS subprotocol, query) | Info disclosure | Subprotocol + logger redact; no query tokens |
| Device JWT replayed as a user token | Spoofing | Distinct `aud`, Zod-validated `typ` |
| Audit flooding via failed sign-ins | DoS | Existing per-IP rate limit; one row per attempt is bounded |
| Avatar URL as tracking pixel | Info disclosure | https only, `referrerPolicy="no-referrer"`; upload in Phase 4 |
| Bot acting with a richer human's rights | Elevation | agent ∩ triggering-human intersection |

## Recommended Plan Decomposition (tracer first, file ownership)

| Wave | Plan | Owns (exclusive) | Depends |
|------|------|------------------|---------|
| 0 | **P01 Contracts + schema + migration** — `Permission`, new `OrgRole`, `UnitRole`, `ROLE_PERMISSIONS`, `AccessTokenClaims`, DTOs; `org_units`, `unit_memberships`, `permission_rules`, `org_members` columns, `auth.session` columns, `auth.jwks`; generated + custom data migration; RLS seeds; role-migration test; update role strings in tests/e2e/demo-seed (`checkpoint:human-verify` before installing fast-check) | `packages/contracts/src/{permissions,organization,identity,common,agent-channel}.ts`, `packages/db/**`, `scripts/demo-seed.mjs`, `e2e/tests/chat.spec.ts` | — |
| 1 | **P02 Resolver tracer** — pure resolver + policy + facts + perms service; `authz.ts` registry (coverage hook warn-only) + `guard.test.ts` with the legacy allowlist; delete `AuthContext.role`/`requireRole`; **split `identity/service.ts`** into `authenticate.ts`/`setup.ts`/`invitations.ts` (mechanical); migrate the channel-archive route end to end; `me.permissions`; web `useCan` replaces all six web role checks | `apps/api/src/{core,app,authz}.ts`, `modules/organization/permissions/**`, `modules/identity/{service,authenticate,setup,invitations,index}.ts`, `apps/web/lib/{permissions,bots-queries}.ts` + the 5 web call sites | P01 |
| 2 | **P03 Chat** — M1–M10, clientKind in chat | `modules/chat/**`, `lib/chat-agent-bridge.ts` | P02 |
| 2 | **P04 Agents + cell** — R5, R6, M11–M14 (cell/agent principals) | `modules/agent/**`, `modules/agent-channel/**` | P02 |
| 2 | **P05 Devices + Work Zone** — R9–R11, M16–M24, `viewerCan` on sessions/devices | `modules/device/{routes,index,hub}.ts`, `modules/work-session/**`, `modules/realtime/service.ts` | P02 |
| 2 | **P06 Organization admin API** — units CRUD/move, unit memberships, role change, deactivate/reactivate, last admin, invitations with roles + ceiling (R2–R4, R12), permission_rules API, audits | `modules/organization/{index,units,members,rules}.ts`, `modules/identity/invitations.ts`, invitation routes | P02 |
| 2 | **P07 JWT/WS/device token** — jwt plugin, `jwt.ts` verifier, allowlist `/token` `/jwks`, bearer in `authenticate.ts`, gateway subprotocol + revocation subscriber, realtime-client, web token manager, `/devices/token` + `/runtime/ws` JWT (`modules/device/link.ts`, new `device/token.ts`), daemon, legacy flag | `modules/identity/{auth,jwt,authenticate}.ts`, `modules/realtime/gateway.ts`, `modules/device/{link,token}.ts`, `packages/realtime-client/**`, `apps/web/lib/{auth-token,realtime}.tsx?`, `apps/local-runtime/src/device-link.ts` | P02 |
| 2 | **P08 Sessions, password, profile, sign-in audit** — session hook + client kind, `/me/sessions*`, revocation publish, failed sign-in + sign-out audit, password reset (Mailer, SMTP env), profile + member profile | `modules/identity/{sessions,password,profile,routes}.ts`, `lib/mailer.ts`, `config/env.ts`, `.env.example`, `scripts/setup-env.mjs` | P02; touches `auth.ts` options → coordinate with P07 (P07 owns `auth.ts`; P08 hands its hook/options as an exported function from `sessions.ts` that P07 wires, or P08 runs after P07) |
| 3 | **P09 Web admin console** — Members extended, Organization page, roles sheet, settings nav (all new entries) | `apps/web/components/settings/{members-settings,org-*,unit-*,role-*}.tsx`, `settings-nav.ts`, `app/(app)/settings/organization/**`, `lib/org-queries.ts` | P06 |
| 3 | **P10 Web account** — Profile, Security (sessions), reset-password page, forgot link, member profile sheet, user menu | `app/(app)/settings/{profile,security}/**`, `app/(auth)/reset-password/**`, `app/(auth)/login/page.tsx`, `components/settings/{profile-*,sessions-*}.tsx`, `components/shell/user-menu.tsx`, `lib/account-queries.ts` | P07, P08 |
| 4 | **P11 E2E, demo, ADR, strict guards** — new specs at 390/1440 with screenshots, demo seed hierarchy (Autofy → IT → Backend → Team Alpha), ADR-0007 (identity, roles, resolver, JWT), coverage hook strict, empty allowlist, `docs/DEMO.md` | `e2e/**`, `docs/**`, `scripts/demo-seed.mjs` | all |

**What can be deferred with no retrofit cost:** `@better-auth/oauth-provider` (shares `jwks`), RFC 8628 device grant (replaces only the credential behind `/devices/token`), cell-token JWT (same verifier), unit-scoped resources (`resource.unitPath` already exists), the deny-rule UI and effective-permission viewer, custom roles (`ROLE_PERMISSIONS` → table behind the same function), avatar upload, invitation emails, invite into a unit, audit log viewer, RT-01 re-evaluation.

**Must happen now (expensive later):** the role value migration, deleting `AuthContext.role`, the resolver + coverage guards, the `jwks` table and claim shape, the session `client_kind` column, the `org_units` path model and the deny-precedence semantics.

## Sources

### Primary (HIGH confidence, read this session)
- Repository code: `apps/api/src/**` (identity, organization, audit, realtime, chat, agent, agent-channel, device, work-session, core, app, testing, config/env), `packages/db/{src,sql,drizzle}`, `packages/contracts/src/*`, `packages/realtime-client/src/client.ts`, `apps/web/{lib,components/settings,components/chat,components/work-zone}`, `apps/local-runtime/src/device-link.ts`, `apps/desktop/src/main/*`, `e2e/tests/*`, `.github/workflows/ci.yml`, `vitest.config.ts`
- Installed better-auth 1.7.6 source: `dist/plugins/jwt/{index,sign,verify,types,schema,utils}.mjs`, `dist/api/routes/{password,session}.mjs`, `dist/db/internal-adapter.mjs`, `dist/plugins/organization/routes/crud-invites.mjs`; `@better-auth/core` `types/init-options.d.mts`
- `.planning/{REQUIREMENTS,ROADMAP,STATE}.md`, `.planning/research/{STACK,ARCHITECTURE,PITFALLS}.md`, Phase 1 `01-RESEARCH.md`, `01-DEVIATIONS.md`, `01-STAGE-A-HANDOFF.md`, `docs/prd/PRD.md` §7, §8, §29, §65, §85, §86, §88, §99, §109.3

### Secondary (MEDIUM)
- https://www.postgresql.org/docs/current/ltree.html: trusted module, label charset, GiST operators (used to reject ltree in favour of `uuid[]`)
- https://better-auth.com/docs/plugins/jwt: "not meant as a replacement for the session", jose `createRemoteJWKSet` verification, rotation options
- npm registry metadata (versions, publish dates, licenses) for jose, nodemailer, @types/nodemailer, fast-check, @better-auth/oauth-provider; gsd-tools package-legitimacy verdicts

### Tertiary (LOW, marked [ASSUMED])
- Chrome subprotocol-echo behaviour, `@fastify/websocket` `handleProtocols` passthrough, ua-parser-js licensing, drizzle `using("gin")`/`nullsNotDistinct` emission

## Metadata

**Confidence breakdown:**
- Code inventory and current behaviour: HIGH (every site read with line numbers)
- better-auth capabilities (jwt, reset, sessions, org plugin authority): HIGH (installed source read)
- Resolver/role/hierarchy design: MEDIUM (sound and testable, but these are design choices; A6/A7 need owner confirmation)
- JWT transport details: MEDIUM (A1/A2 to be confirmed by the first integration test)
- Pitfalls: HIGH for the verified ones, MEDIUM for the assumed ones

**Research date:** 2026-10-04
**Valid until:** 2026-11-03 (better-auth moves fast; re-check if it is bumped past 1.7.x)
