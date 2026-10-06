import type { ApiModule, Core } from "../../core";
import { createConversationAccess } from "../chat";
import type { OnlineSet } from "../realtime";
import { registerNotificationRoutes } from "./routes";
import { createNotificationService } from "./service";

export { computeRecipients, type RecipientsInput } from "./recipients";
export { MENTIONS_FILTER_KINDS, unreadCountFor } from "./service";
export { snippetOf } from "./snippet";

/**
 * Notification module (PRD Notification service, CHAT-08, D-02 in-app only): observes chat messages through the
 * chat-events seam (chat never imports this module), writes ids-only notifications in the message transaction and
 * serves the inbox: `GET /notifications`, `POST /notifications/read`.
 */
export function createNotificationModule(core: Core, deps: { online: OnlineSet }): ApiModule {
  const access = createConversationAccess(core);
  const service = createNotificationService(core, { online: deps.online, access });
  core.chatEvents.onMessagePosted(service.onPosted);
  core.chatEvents.onMessageEdited(service.onEdited);
  core.chatEvents.onConversationRead(service.onRead);
  return {
    name: "notification",
    register(app) {
      registerNotificationRoutes(app, { core, access });
    },
  };
}
