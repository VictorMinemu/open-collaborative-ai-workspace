import type { ApiModule, App } from "../../core";
import type { IdentityService } from "../identity";
import { registerGateway } from "./gateway";
import type { RealtimeService } from "./service";

export {
  createRealtimeService,
  type RealtimeService,
  type ReplayResult,
  type TopicAuthorizer,
} from "./service";

/** Mounts `GET /ws` at the root (no /api/v1 prefix). */
export function createRealtimeModule(deps: {
  realtime: RealtimeService;
  identity: IdentityService;
  allowedOrigins: Set<string>;
}): ApiModule {
  return {
    name: "realtime",
    prefix: "",
    register(app: App) {
      registerGateway(app, deps);
    },
  };
}
