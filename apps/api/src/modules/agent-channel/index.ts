import type { ApiModule, Core } from "../../core";

/**
 * agent-channel module — TODO(B2): Agent Channel API v1 for the OpenClaw plugin (bearer service token → core.db.lookups.agentCredentialByTokenHash).
 *
 * Already wired in app.ts: implement routes inside register(); they are mounted under /api/v1.
 * Use core.identity.requireUser as preHandler, core.db.withTenant(tenant(req), …) for every query,
 * core.audit.record(tx, …) for sensitive actions and core.realtime.appendEvent(tx, topic, type, payload).
 */
export function createAgentChannelModule(_core: Core): ApiModule {
  return {
    name: "agent-channel",
    register(_app) {
      // TODO(B2)
    },
  };
}
