import { auditEvents, type Tx, tenantOf } from "@ocw/db";

/** PRD audit fields: actor, agent, user, device, resource, action, result, timestamp, organization, session. */
export interface AuditEventInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  result?: "success" | "denied" | "error";
  actorKind?: "user" | "agent" | "system" | "device";
  actorId?: string | null;
  userId?: string | null;
  agentId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  clientKind?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditService {
  /**
   * Write an audit row in the SAME transaction as the action (the `tx` parameter is mandatory by design).
   * Organization comes from the tenant context of `tx`; actor, session and client default to the tx context.
   */
  record(tx: Tx, event: AuditEventInput): Promise<void>;
}

/** Values an audit row falls back to: the tenant context of the transaction it is written in. */
export interface AuditDefaults {
  userId?: string | null;
  sessionId?: string | null;
  clientKind?: string | null;
}

/**
 * `defaults` is the transaction's tenant context (or, for older callers, just the default user id). Explicit
 * event values always win, including an explicit null for session or client.
 */
export function toAuditRow(
  organizationId: string,
  defaults: AuditDefaults | string | null,
  e: AuditEventInput,
) {
  const d: AuditDefaults =
    typeof defaults === "object" && defaults !== null ? defaults : { userId: defaults };
  const userId = e.userId ?? d.userId ?? null;
  return {
    organizationId,
    actorKind: e.actorKind ?? (userId ? "user" : "system"),
    actorId: e.actorId ?? userId ?? null,
    agentId: e.agentId ?? null,
    userId: userId ?? null,
    deviceId: e.deviceId ?? null,
    sessionId: (e.sessionId === undefined ? d.sessionId : e.sessionId) ?? null,
    clientKind: (e.clientKind === undefined ? d.clientKind : e.clientKind) ?? null,
    resourceType: e.resourceType,
    resourceId: e.resourceId ?? null,
    action: e.action,
    result: e.result ?? "success",
    metadata: e.metadata ?? {},
  } as const;
}

export function createAuditService(): AuditService {
  return {
    async record(tx, event) {
      const ctx = tenantOf(tx);
      await tx.insert(auditEvents).values(toAuditRow(ctx.organizationId, ctx, event));
    },
  };
}
