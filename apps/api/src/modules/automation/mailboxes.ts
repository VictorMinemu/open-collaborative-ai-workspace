import type { Mailbox } from "@ocw/contracts";
import type { App, Core } from "../../core";
import { HttpError } from "../../lib/errors";
import type { AutomationSeamDeps, TriggerAdapter } from "./actions";

const unavailable = () => new HttpError(400, "trigger_unavailable", "Mail triggers aren't available yet");

/**
 * The mail trigger's mailbox (07.6-11 fills this file): `onCreate` / `onUpdate` store the mailbox after the host and
 * Keychain-item checks, `onDelete` stops its polling, `view` shows it (never a credential). Until then a mail trigger
 * is refused with 400 `trigger_unavailable`.
 */
export const mailTrigger: TriggerAdapter<Mailbox> = {
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

/** The mailbox routes (07.6-11): `POST /mailboxes/test`, `GET /automations/:id/mailbox`. None until then. */
export function registerMailboxRoutes(_app: App, _core: Core, _deps: AutomationSeamDeps): void {}
