import type { ApiModule, App } from "../../core";
import type { RedisBus } from "../../lib/redis";
import type { IdentityService } from "../identity";
import { registerGateway } from "./gateway";
import { createPresenceStore } from "./presence";

export { PRESENCE_RATE_LIMIT, SESSION_RECHECK_MS } from "./gateway";
export {
  createPresenceStore,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_TTL_MS,
  type PresenceMember,
  type PresenceStore,
  presenceKey,
} from "./presence";

import type { RealtimeService } from "./service";

export {
  createRealtimeService,
  REVOCATION_CHANNEL,
  REVOKED_SID_TTL_SECONDS,
  type RealtimeService,
  type ReplayResult,
  type RevocationEvent,
  type RevocationReason,
  type TopicAuthorizer,
  topicChannel,
} from "./service";

/** Mounts `GET /ws` at the root (no /api/v1 prefix). */
export function createRealtimeModule(deps: {
  realtime: RealtimeService;
  identity: IdentityService;
  allowedOrigins: Set<string>;
  /** Presence store backend (RT-04): Redis sorted sets, deltas on the topic channels. */
  bus: RedisBus;
  /** Open-socket session recheck interval (default 5 minutes; tests lower it). */
  sessionRecheckMs?: number;
  /**
   * Presence heartbeat, entry TTL and per-socket change limit (defaults 15 s / 45 s / PRESENCE_RATE_LIMIT; tests
   * lower them).
   */
  presence?: { heartbeatMs?: number; ttlMs?: number; rateLimit?: { max: number; windowMs: number } };
}): ApiModule {
  const store = createPresenceStore({ bus: deps.bus, ttlMs: deps.presence?.ttlMs });
  return {
    name: "realtime",
    prefix: "",
    register(app: App) {
      registerGateway(app, {
        realtime: deps.realtime,
        identity: deps.identity,
        allowedOrigins: deps.allowedOrigins,
        presence: store,
        sessionRecheckMs: deps.sessionRecheckMs,
        heartbeatMs: deps.presence?.heartbeatMs,
        presenceRateLimit: deps.presence?.rateLimit,
      });
    },
  };
}
