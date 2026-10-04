import type { AuthzDenial, Permission } from "@ocw/contracts";
import type { TenantCtx, TenantDb, Tx } from "@ocw/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { markDecided } from "../../../authz";
import { unauthorized } from "../../../lib/errors";
import type { AuditService } from "../../audit";
import { AuthzDeniedError } from "./errors";
import { loadPrincipalFacts, loadRules, type PrincipalRef } from "./facts";
import { orgResource } from "./policy";
import {
  decide as decideFacts,
  type OnBehalfOf,
  type PrincipalFacts,
  type ResourceFacts,
  type RuleFact,
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
  /** Fastify preHandler: asserts an organization-scope permission in its own short transaction. */
  requirePermission(permission: Permission): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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

  async function decideForRequest(
    req: FastifyRequest,
    tx: Tx,
    permission: Permission,
    resource: ResourceFacts,
    opts: DecideOptions,
  ) {
    markDecided(req);
    const ref = opts.as ?? principalOf(req);
    const load = (r: PrincipalRef) => principalFacts(req, tx, r);
    const [p, rules, obo] = await Promise.all([
      load(ref),
      requestRules(req, tx),
      onBehalfOf(load, ref, resource, opts.onBehalfOfResource),
    ]);
    return decideFacts(p, resource, rules, permission, obo);
  }

  const service: PermissionService = {
    async decide(tx, principal, permission, resource = orgResource(), onBehalfOfResource) {
      const load = (r: PrincipalRef) => loadPrincipalFacts(tx, r);
      const [p, rules, obo] = await Promise.all([
        load(principal),
        loadRules(tx),
        onBehalfOf(load, principal, resource, onBehalfOfResource),
      ]);
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
