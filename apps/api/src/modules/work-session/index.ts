import type { ApiModule, Core } from "../../core";

/**
 * work-session module — TODO(B3): work sessions, prompt queue, approvals, diff, interrupt. Register the `ws` topic authorizer: core.realtime.registerTopicAuthorizer("ws", ...).
 *
 * Already wired in app.ts: implement routes inside register(); they are mounted under /api/v1.
 * Use core.identity.requireUser as preHandler, core.db.withTenant(tenant(req), …) for every query,
 * core.audit.record(tx, …) for sensitive actions and core.realtime.appendEvent(tx, topic, type, payload).
 */
export function createWorkSessionModule(_core: Core): ApiModule {
  return {
    name: "work-session",
    register(_app) {
      // TODO(B3)
    },
  };
}
