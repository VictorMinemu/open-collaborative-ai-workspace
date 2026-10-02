import type { ApiModule, Core } from "../../core";

/**
 * agent module — TODO(B2): bots (agents), model providers (secrets via core.secrets), allowed models, OpenClaw provisioning.
 *
 * Already wired in app.ts: implement routes inside register(); they are mounted under /api/v1.
 * Use core.identity.requireUser as preHandler, core.db.withTenant(tenant(req), …) for every query,
 * core.audit.record(tx, …) for sensitive actions and core.realtime.appendEvent(tx, topic, type, payload).
 */
export function createAgentModule(_core: Core): ApiModule {
  return {
    name: "agent",
    register(_app) {
      // TODO(B2)
    },
  };
}
