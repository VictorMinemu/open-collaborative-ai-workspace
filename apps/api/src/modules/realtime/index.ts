import type { ApiModule, App } from "../../core";
import type { IdentityService } from "../identity";
import { registerGateway } from "./gateway";

export { SESSION_RECHECK_MS } from "./gateway";

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
} from "./service";

/** Mounts `GET /ws` at the root (no /api/v1 prefix). */
export function createRealtimeModule(deps: {
  realtime: RealtimeService;
  identity: IdentityService;
  allowedOrigins: Set<string>;
  /** Open-socket session recheck interval (default 5 minutes; tests lower it). */
  sessionRecheckMs?: number;
}): ApiModule {
  return {
    name: "realtime",
    prefix: "",
    register(app: App) {
      registerGateway(app, deps);
    },
  };
}
