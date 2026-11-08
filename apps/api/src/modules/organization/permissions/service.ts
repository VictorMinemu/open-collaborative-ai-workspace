import { type AuthzDenial, type MyPermissions, Permission } from "@ocw/contracts";
import { orgMembers, type TenantCtx, type TenantDb, type Tx } from "@ocw/db";
import { isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { markDecided } from "../../../authz";
import { unauthorized } from "../../../lib/errors";
import type { AuditService } from "../../audit";
import { AuthzDeniedError } from "./errors";
import { loadPrincipalFacts, loadPrincipalFactsMany, loadRules, type PrincipalRef } from "./facts";
import { orgResource, userResource } from "./policy";
import {
  decide as decideFacts,
  type OnBehalfOf,
  type PrincipalFacts,
  type ResourceFacts,
  type RuleFact,
  resolveEffectivePermissions,
} from "./resolve";

export type { PrincipalRef } from "./facts";

export interface DecideOptions {
  /** Deny as 404 (the caller must not learn the resource exists), e.g. `channel.read`. */
  hideAs404?: boolean;
  /** Decide for another principal than the request's (e.g. an agent acting for a human). */
  as?: PrincipalRef;
  /** The resource the human is checked against when `as` is an agent acting on behalf of a user. */
  onBehalfOfResource?: ResourceFacts;
}

/** Decisions over preloaded people (`PermissionService.usersDecider`). */
export interface UsersDecider {
  /**
   * The people (sorted user ids) among `candidates` who hold `permission`, each on their own `resourceFor(userId)`: what
   * `usersAllowed` returns for these candidates. Deactivated members, ids outside the tenant and ids the decider was not
   * loaded with are never returned (fail closed).
   */
  allowed(
    candidates: readonly string[],
    permission: Permission,
    resourceFor: (userId: string) => ResourceFacts,
  ): string[];
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
  /**
   * Request-less `filter` for background and event-time decisions (readable sets, notifications): the
   * principal's facts and the rules load once, then one in-memory decision per item.
   */
  filterFor<T>(
    tx: Tx,
    principal: PrincipalRef,
    items: readonly T[],
    permission: Permission,
    toResource: (item: T) => ResourceFacts,
  ): Promise<T[]>;
  /**
   * The people (sorted user ids) who hold `permission`, each on their own `resourceFor(userId)` (relations differ per
   * person): reader counts and deciders (Phase 07.2). `"members"` = every active member of the tenant. Rules load once,
   * facts in two queries; deactivated members and ids outside the tenant are never returned.
   */
  usersAllowed(
    tx: Tx,
    a: {
      candidates: readonly string[] | "members";
      permission: Permission;
      resourceFor: (userId: string) => ResourceFacts;
    },
  ): Promise<string[]>;
  /**
   * `usersAllowed` for many resources at once (the live session fan-out, WINDOWS #311): the facts of `userIds` and the
   * rules load once (three queries), then every `allowed` call decides in memory exactly as `usersAllowed` does.
   */
  usersDecider(tx: Tx, userIds: readonly string[]): Promise<UsersDecider>;
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

export interface PermissionDeps {
  db: TenantDb;
  audit: AuditService;
}

// ---------------------------------------------------------------- per-request memo

interface RequestFacts {
  principals: Map<string, Promise<PrincipalFacts>>;
  rules?: Promise<RuleFact[]>;
}

/** Module level so every module's service instance shares one load per request. */
const memo = new WeakMap<FastifyRequest, RequestFacts>();

function memoOf(req: FastifyRequest): RequestFacts {
  let m = memo.get(req);
  if (!m) {
    m = { principals: new Map() };
    memo.set(req, m);
  }
  return m;
}

const refKey = (ref: PrincipalRef) =>
  ref.kind === "user"
    ? `user:${ref.userId}`
    : ref.kind === "agent"
      ? `agent:${ref.agentId}`
      : ref.kind === "cell"
        ? `cell:${ref.cellId}`
        : `device:${ref.deviceId}`;

function principalFacts(req: FastifyRequest, tx: Tx, ref: PrincipalRef): Promise<PrincipalFacts> {
  const m = memoOf(req);
  const key = refKey(ref);
  let p = m.principals.get(key);
  if (!p) {
    p = loadPrincipalFacts(tx, ref);
    m.principals.set(key, p);
  }
  return p;
}

function requestRules(req: FastifyRequest, tx: Tx): Promise<RuleFact[]> {
  const m = memoOf(req);
  m.rules ??= loadRules(tx);
  return m.rules;
}

/** The request's principal: the signed-in user, the OpenClaw cell or the paired device. */
export function principalOf(req: FastifyRequest): PrincipalRef {
  if (req.auth) return { kind: "user", userId: req.auth.userId };
  if (req.cell) return { kind: "cell", cellId: req.cell.cellId };
  if (req.device) return { kind: "device", deviceId: req.device.deviceId };
  throw unauthorized();
}

/** Tenant context of the request's principal (cells and devices act without a user). */
export function principalTenant(req: FastifyRequest): TenantCtx {
  if (req.auth) return { organizationId: req.auth.organizationId, userId: req.auth.userId };
  if (req.cell) return { organizationId: req.cell.organizationId, userId: null };
  if (req.device) return { organizationId: req.device.organizationId, userId: null };
  throw unauthorized();
}

// ---------------------------------------------------------------- service

/** Stateless; create one per module (`createPermissionService(core)`). */
export function createPermissionService(deps: PermissionDeps): PermissionService {
  async function onBehalfOf(
    load: (ref: PrincipalRef) => Promise<PrincipalFacts>,
    ref: PrincipalRef,
    resource: ResourceFacts,
    onBehalfOfResource: ResourceFacts | undefined,
  ): Promise<OnBehalfOf | undefined> {
    if (ref.kind !== "agent" || !ref.onBehalfOfUserId) return undefined;
    const principal = await load({ kind: "user", userId: ref.onBehalfOfUserId });
    return { principal, resource: onBehalfOfResource ?? resource };
  }

  /** Principal facts, rules and the on-behalf-of human for this request (memoised per request). */
  async function requestFacts(req: FastifyRequest, tx: Tx, resource: ResourceFacts, opts: DecideOptions) {
    markDecided(req);
    const ref = opts.as ?? principalOf(req);
    const load = (r: PrincipalRef) => principalFacts(req, tx, r);
    // Sequential on purpose: every load shares the transaction's single connection.
    const p = await load(ref);
    const rules = await requestRules(req, tx);
    const obo = await onBehalfOf(load, ref, resource, opts.onBehalfOfResource);
    return { p, rules, obo };
  }

  async function decideForRequest(
    req: FastifyRequest,
    tx: Tx,
    permission: Permission,
    resource: ResourceFacts,
    opts: DecideOptions,
  ) {
    const { p, rules, obo } = await requestFacts(req, tx, resource, opts);
    return decideFacts(p, resource, rules, permission, obo);
  }

  const service: PermissionService = {
    async decide(tx, principal, permission, resource = orgResource(), onBehalfOfResource) {
      const load = (r: PrincipalRef) => loadPrincipalFacts(tx, r);
      const p = await load(principal);
      const rules = await loadRules(tx);
      const obo = await onBehalfOf(load, principal, resource, onBehalfOfResource);
      return decideFacts(p, resource, rules, permission, obo);
    },

    async can(req, tx, permission, resource = orgResource(), opts = {}) {
      return (await decideForRequest(req, tx, permission, resource, opts)).allowed;
    },

    async assertCan(req, tx, permission, resource = orgResource(), opts = {}) {
      const res = await decideForRequest(req, tx, permission, resource, opts);
      if (!res.allowed) {
        throw new AuthzDeniedError(
          res.denial ?? { permission, layer: "role", reason: "missing_permission" },
          {
            ...(opts.hideAs404 ? { hideAs404: true } : {}),
          },
        );
      }
    },

    async filter(req, tx, items, permission, toResource) {
      if (items.length === 0) {
        markDecided(req);
        return [];
      }
      const ref = principalOf(req);
      const p = await principalFacts(req, tx, ref);
      const rules = await requestRules(req, tx);
      markDecided(req);
      return items.filter((item) => decideFacts(p, toResource(item), rules, permission).allowed);
    },

    async filterFor(tx, principal, items, permission, toResource) {
      if (items.length === 0) return [];
      const p = await loadPrincipalFacts(tx, principal);
      const rules = await loadRules(tx);
      return items.filter((item) => decideFacts(p, toResource(item), rules, permission).allowed);
    },

    async usersAllowed(tx, { candidates, permission, resourceFor }) {
      const ids =
        candidates === "members"
          ? (
              await tx
                .select({ userId: orgMembers.userId })
                .from(orgMembers)
                .where(isNull(orgMembers.deactivatedAt))
            ).map((m) => m.userId)
          : candidates;
      if (ids.length === 0) return [];
      return (await service.usersDecider(tx, ids)).allowed(ids, permission, resourceFor);
    },

    async usersDecider(tx, userIds) {
      const people: Map<string, PrincipalFacts> =
        userIds.length === 0 ? new Map() : await loadPrincipalFactsMany(tx, userIds);
      const rules: RuleFact[] = people.size === 0 ? [] : await loadRules(tx);
      return {
        allowed(candidates, permission, resourceFor) {
          // Over the loaded people (ids as the database prints them), as `usersAllowed` always iterated.
          const wanted = new Set(candidates.map((id) => id.toLowerCase()));
          const allowed: string[] = [];
          for (const p of people.values()) {
            if (p.deactivated || !wanted.has(p.id)) continue;
            if (decideFacts(p, resourceFor(p.id), rules, permission).allowed) allowed.push(p.id);
          }
          return allowed.sort();
        },
      };
    },

    async viewerCan(req, tx, resource, candidates) {
      const { p, rules, obo } = await requestFacts(req, tx, resource, {});
      return candidates.filter((perm) => decideFacts(p, resource, rules, perm, obo).allowed);
    },

    async myPermissions(req, tx) {
      const ref = principalOf(req);
      if (ref.kind !== "user") throw unauthorized();
      const { p, rules } = await requestFacts(req, tx, orgResource(), {});
      if (!p.orgRole) {
        throw new AuthzDeniedError({ permission: "org.read", layer: "user", reason: "not_a_member" });
      }
      const held = new Set(resolveEffectivePermissions(p, orgResource(), rules).permissions);
      if (decideFacts(p, userResource(ref.userId, ref.userId), rules, "account.manage").allowed) {
        held.add("account.manage");
      }
      return { role: p.orgRole, permissions: Permission.options.filter((perm) => held.has(perm)) };
    },

    requirePermission(permission) {
      return async (req) => {
        await deps.db.withTenant(principalTenant(req), (tx) =>
          service.assertCan(req, tx, permission, orgResource()),
        );
      };
    },
  };
  return service;
}

/**
 * Writes `authz.denied` in its OWN transaction: the request's transaction already rolled back with the
 * thrown error (Pitfall 4). Never throws; a failure is logged.
 */
export async function recordAuthzDenial(
  deps: PermissionDeps,
  req: FastifyRequest,
  err: AuthzDeniedError,
): Promise<void> {
  let ctx: TenantCtx;
  try {
    ctx = principalTenant(req);
  } catch {
    return;
  }
  const { denial } = err;
  const actor = req.auth
    ? { actorKind: "user" as const, userId: req.auth.userId, sessionId: req.auth.sessionId }
    : req.cell
      ? { actorKind: "agent" as const, actorId: req.cell.cellId, userId: null, clientKind: "agent" }
      : {
          actorKind: "device" as const,
          actorId: req.device?.deviceId ?? null,
          deviceId: req.device?.deviceId ?? null,
          userId: null,
        };
  try {
    await deps.db.withTenant(ctx, (tx) =>
      deps.audit.record(tx, {
        action: "authz.denied",
        resourceType: "route",
        resourceId: req.routeOptions.url ?? req.url,
        result: "denied",
        ...actor,
        metadata: {
          permission: denial.permission,
          layer: denial.layer,
          reason: denial.reason,
          ruleId: denial.ruleId ?? null,
          unitId: denial.unitId ?? null,
          method: req.method,
        },
      }),
    );
  } catch (error) {
    req.log.warn({ err: error }, "could not audit an authorization denial");
  }
}
