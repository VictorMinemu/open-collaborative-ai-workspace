import type { ApiModule, App } from "../../core";
import type { RedisBus } from "../../lib/redis";
import type { IdentityService } from "../identity";
import { registerGateway } from "./gateway";
import { createOnlineSet, type OnlineSet } from "./online";
import { createPresenceStore } from "./presence";

export {
  authenticateUpgrade,
  PRESENCE_RATE_LIMIT,
  SESSION_RECHECK_MS,
  type UpgradeRefusal,
} from "./gateway";
export { createOnlineSet, type OnlineSet, onlineKey } from "./online";
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
  AUTHZ_INVALIDATION_CHANNEL,
  createRealtimeService,
  parseInvalidation,
  REVOCATION_CHANNEL,
  REVOKED_SID_TTL_SECONDS,
  type RealtimeService,
  type Reauthorization,
  type ReplayResult,
  type RevocationEvent,
  type RevocationReason,
  type SubscriptionInvalidation,
  type SubscriptionInvalidator,
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
  /** The organization online set for @here (CHAT-08); app.ts shares one with the notification module. */
  online?: OnlineSet;
}): ApiModule {
  const store = createPresenceStore({ bus: deps.bus, ttlMs: deps.presence?.ttlMs });
  const online = deps.online ?? createOnlineSet(deps.bus, deps.presence?.ttlMs);
  return {
    name: "realtime",
    prefix: "",
    register(app: App) {
      registerGateway(app, {
        realtime: deps.realtime,
        identity: deps.identity,
        allowedOrigins: deps.allowedOrigins,
        presence: store,
        online,
        sessionRecheckMs: deps.sessionRecheckMs,
        heartbeatMs: deps.presence?.heartbeatMs,
        presenceRateLimit: deps.presence?.rateLimit,
      });
    },
  };
}
