import type { ApiModule, Core } from "../../core";

/**
 * chat module — TODO(B1): channels, threads, messages, mentions, conversation membership. Register the `conv` topic authorizer here: core.realtime.registerTopicAuthorizer("conv", ...).
 *
 * Already wired in app.ts: implement routes inside register(); they are mounted under /api/v1.
 * Use core.identity.requireUser as preHandler, core.db.withTenant(tenant(req), …) for every query,
 * core.audit.record(tx, …) for sensitive actions and core.realtime.appendEvent(tx, topic, type, payload).
 */
export function createChatModule(_core: Core): ApiModule {
  return {
    name: "chat",
    register(_app) {
      // TODO(B1)
    },
  };
}
