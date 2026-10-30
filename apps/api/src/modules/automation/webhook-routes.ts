import type { App, Core } from "../../core";
import type { AutomationSeamDeps } from "./actions";

/**
 * The webhook routes (07.6-10 fills this file): `GET /automations/:id/webhook`, `POST /automations/:id/webhook/rotate`
 * and the public `POST /hooks/:publicId`. Until then it registers no route.
 */
export function registerWebhookRoutes(_app: App, _core: Core, _deps: AutomationSeamDeps): void {}
