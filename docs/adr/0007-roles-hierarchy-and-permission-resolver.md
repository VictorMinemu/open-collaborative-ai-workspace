# ADR-0007: Four organization roles, a unit hierarchy and one permission resolver

- **Status:** Accepted
- **Date:** 2026-10-04
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

MVP 0 authorized requests with three hand-rolled mechanisms: a `requireRole("owner", "admin")`
preHandler, inline `auth.role === …` comparisons, and per-module membership and ownership helpers
(`canRead`, `requireReadable`, `canUseDevice`, `assertCanApprove`, …). There were 13 role comparisons and
about 25 membership or ownership decisions across 7 API files, plus 6 role checks in the web app.
better-auth's organization plugin acted as a second authority, because invitations went through its own
`hasPermission`. Roles were `owner | admin | member`, not the PRD personas.

The PRD requires four roles (§7: Standard User, Developer, Team Lead/Manager, Organization Admin), an
Organization → Department → Team → Project hierarchy (§8), and one effective permission computed as the
intersection Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device, where upper-level
restrictions win and explicit deny beats allow (§65, AGENTS.md principle 6). Phase 2 success criterion 3
adds that every Phase 1 route must use that one function, with no ad-hoc role or membership check left.

## Decision

**Authentication and authorization are split.** better-auth authenticates (users, credentials, sessions,
invitations, JWKS) and never authorizes. `auth.member` only records that a user belongs to the
organization. The role lives in `app.org_members.role`, the single source of truth.

**Roles.** Each member has one organization role, the PRD persona: `standard | developer | lead | admin`
(a `CHECK` constraint enforces the set). It decides what the person can use anywhere: Work Zone needs
`developer`, team management needs `lead`, the admin console needs `admin`. MVP 0 data was migrated
without losing a capability (D-06): `owner` and `admin` became `admin`, and `member` became `developer`,
because MVP 0 members could use Work Zone. An organization always keeps one active admin (409 otherwise).
Invitations carry a role under a ceiling: nobody grants a role above their own, and only admins grant
`lead` or `admin`.

**Hierarchy.** Units live in `app.org_units` (department, team, project) with `parent_id` and a
materialized `uuid[]` ancestor path, without the `ltree` extension (D-07). Allowed parents: a department
sits at the top or under a department, a team under a department or a team, and a project under a team
or a department. Structural changes take a per-organization advisory lock, so two concurrent moves cannot
create a cycle. A move rewrites the paths of the subtree in one statement. Hierarchy projects are
`org_units` rows of kind `project`; `app.projects` keeps meaning device repositories. Unit memberships
(`app.unit_memberships`) are `member` or `lead`. Only users whose organization role is `lead` or `admin`
can lead a unit, and leading a unit grants team authority over its subtree. The generic RLS
`tenant_isolation` policy covers both tables; no hierarchy logic lives in RLS.

**One resolver.** `resolveEffectivePermissions(principal, resource, rules, onBehalfOf?)` in
`apps/api/src/modules/organization/permissions/resolve.ts` is a pure function over facts loaded once per
request by `facts.ts`; it reads nothing during the decision.

- *Principal gate:* a deactivated member, a disabled agent or a revoked device gets an empty set, with the
  User, Agent or Device layer recorded.
- *Grants* = role permissions ∪ lead permissions when the principal leads a unit on the resource's path ∪
  relation grants (owner, creator, member, device owner, inviter, self), filtered by the surface of the
  principal's role ∪ explicit allow rules.
- *Removals:* resource-state preconditions (archived channel, private channel the principal is not in,
  revoked device) and explicit deny rules, ordered by layer (Org, then each unit on the path from the top
  down, then User, Agent, Tool, Device), remove a permission whatever granted it. The first matching layer
  is reported as `{permission, layer, reason}`.
- *Agents:* an agent acting for a human gets `agent ∩ human`, so a bot never exceeds the person who
  mentioned it.

**Explicit rules (D-02).** `app.permission_rules` holds deny and allow rules scoped to the organization or
a unit subtree, for everyone, a role, a user or an agent, on an exact permission or a `prefix.*`. Allow
rules can never grant a non-delegable permission (the admin and runtime surfaces). Admins manage them
through an API; the UI is a read-only listing.

**HTTP mapping.** A denied read of a resource the caller cannot see answers 404 (a private channel stays
invisible). A denied mutation of a visible resource answers 403 with `{permission, layer, reason}`, and the
denial is audited in its own transaction so the rollback does not erase it. Lists filter row by row
through the same function. The web never re-implements policy: it reads `/me/permissions` and per-resource
`viewerCan` arrays.

**Enforcement rails**, so that SC3 is enforced by the build and not by review:

1. `AuthContext` has no `role` field and the `requireRole` preHandler is gone, so a new role check does not
   compile.
2. Every route declares `config.authz` (`public`, `user`, `cell` or `device`). A test asserts that every
   route declares one and that the public set equals an explicit allowlist. Under `NODE_ENV=test` a
   non-public route that answers 2xx without a resolver decision becomes a 500, so every integration and
   e2e suite fails on it. Production records and logs the event instead of failing the request.
3. A static guard (`guard.test.ts`) fails on role comparisons against an org-role literal, `isAdmin`,
   `useIsAdmin`, the deleted helper names and any leftover migration marker in `apps/api` and `apps/web`.

## Consequences

- Every authorization question has one answer and one place to change it. The role matrix and eight
  fast-check properties (deny precedence, monotonicity, agent ⊆ human, …) test that place directly.
- Custom roles and unit-scoped personas ("Developer only in Team Alpha") can arrive later behind the same
  function: the resolver already takes the resource's unit path. In Phase 2 every Phase 1 resource lives
  at the organization root, so unit scope only matters for unit management and rules.
- The effective-permission viewer and a rules editor (PRD §109.3) are deferred. Rules are API-managed.
- Re-evaluating live realtime subscriptions when memberships change (RT-01) is Phase 3. Today a topic
  subscription is decided when it is opened.
- Policies, skills and MCP permissions (MVP 4) and per-Work-Session permission bits (Phase 10) extend the
  permission vocabulary in `packages/contracts`, not the decision procedure.
- Adding a public route is a deliberate change to the allowlist in `apps/api/src/authz.int.test.ts`.
