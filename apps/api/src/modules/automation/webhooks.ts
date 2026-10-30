import type { Automation } from "@ocw/contracts";
import { HttpError } from "../../lib/errors";
import type { TriggerAdapter } from "./actions";

/** The webhook part of the automation DTO: its public id and URL (never the secret). */
export type WebhookView = NonNullable<Automation["trigger"]["webhook"]>;

const unavailable = () => new HttpError(400, "trigger_unavailable", "Webhook triggers aren't available yet");

/**
 * The webhook trigger's endpoint (07.6-10 fills this adapter): `onCreate` makes the endpoint and its sealed signing
 * secret (returned once as `webhookSecret`), `onUpdate` keeps it, `onDelete` tombstones it (410) and removes its
 * secrets, `view` shows the public id and URL. Until then a webhook trigger is refused with 400 `trigger_unavailable`,
 * so no automation can exist without its endpoint.
 */
export const webhookTrigger: TriggerAdapter<WebhookView> = {
  async onCreate() {
    throw unavailable();
  },
  async onUpdate() {
    throw unavailable();
  },
  async onDelete() {},
  async view() {
    return null;
  },
};
