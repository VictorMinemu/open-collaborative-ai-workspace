import type { FastifyReply, FastifyRequest } from "fastify";
import type { Core } from "../../core";
import { safeEqual, sha256Hex } from "../../lib/crypto";
import { HttpError, unauthorized } from "../../lib/errors";

/** Authenticated OpenClaw cell (MVP 0: one cell per organization; cellId = organizationId). */
export interface CellPrincipal {
  organizationId: string;
  cellId: string;
  /** `agent_credentials.id`, or `env` for the operator bootstrap token. */
  credentialId: string;
  source: "db" | "env";
}

declare module "fastify" {
  interface FastifyRequest {
    cell?: CellPrincipal;
  }
}

const FAILURE_AUDIT_INTERVAL_MS = 10_000;

/**
 * Bearer cell-token authentication for the Agent Channel API (A2.5). Two sources:
 * 1. tokens minted in Settings › Bots runtime → `agent_credentials` (SHA-256 only), looked up before the
 *    tenant is known through the SECURITY DEFINER `app.lookup_agent_credential`;
 * 2. the operator bootstrap token `OCW_CELL_TOKEN` / `OCW_CELL_TOKEN_FILE`, compared in constant time and
 *    bound to the instance's organization (so docker compose needs no manual step).
 * The token grants Agent Channel API scope only; it never reaches /api/v1.
 */
export function createCellAuth(core: Core) {
  const envToken = core.env.OCW_CELL_TOKEN ?? null;
  let envOrg: string | null = null;
  let lastFailureAudit = 0;

  async function authenticate(authorization: string | undefined): Promise<CellPrincipal | null> {
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice(7).trim();
    if (token.length < 32 || token.length > 512) return null;
    const cred = await core.db.lookups.agentCredentialByTokenHash(sha256Hex(token));
    if (cred && cred.agentId === null) {
      return {
        organizationId: cred.organizationId,
        cellId: cred.organizationId,
        credentialId: cred.credentialId,
        source: "db",
      };
    }
    if (envToken && safeEqual(token, envToken)) {
      envOrg ??= await core.identity.instanceOrganizationId();
      if (!envOrg) {
        throw new HttpError(503, "setup_required", "The workspace has not been set up yet; retry later");
      }
      return { organizationId: envOrg, cellId: envOrg, credentialId: "env", source: "env" };
    }
    return null;
  }

  /** Audit a rejected credential (throttled; the org is the instance org when one exists). */
  async function auditFailure(req: FastifyRequest) {
    const now = Date.now();
    if (now - lastFailureAudit < FAILURE_AUDIT_INTERVAL_MS) return;
    lastFailureAudit = now;
    const org = envOrg ?? (await core.identity.instanceOrganizationId().catch(() => null));
    if (!org) return;
    await core.db
      .withTenant({ organizationId: org, userId: null }, (tx) =>
        core.audit.record(tx, {
          action: "agent_channel.auth_failed",
          resourceType: "agent_cell",
          resourceId: org,
          result: "denied",
          actorKind: "system",
          clientKind: "agent",
          metadata: { route: req.routeOptions.url ?? req.url, ip: req.ip },
        }),
      )
      .catch((err: unknown) => req.log.warn({ err }, "could not audit agent channel auth failure"));
  }

  /** Fastify preHandler / onRequest hook: 401 unless a valid cell token is presented; sets `req.cell`. */
  const requireCell = async (req: FastifyRequest, _reply: FastifyReply) => {
    const cell = await authenticate(req.headers.authorization);
    if (!cell) {
      await auditFailure(req);
      throw unauthorized("A valid cell token is required", "invalid_cell_token");
    }
    req.cell = cell;
  };

  return { authenticate, requireCell, auditFailure };
}

export type CellAuth = ReturnType<typeof createCellAuth>;

export function cellOf(req: FastifyRequest): CellPrincipal {
  if (!req.cell) throw new Error("cellOf() called without the requireCell hook");
  return req.cell;
}
