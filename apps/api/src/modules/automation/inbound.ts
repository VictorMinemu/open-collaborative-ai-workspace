import type { Core } from "../../core";
import type { AutomationSeamDeps } from "./actions";

/**
 * Inbound items (07.6-21 fills this file): the `automation.inbound` worker that posts a webhook or mail item as a
 * platform-owned thread, DM message or board card and then asks the bot (a read-only, tainted turn), plus the daily
 * content purge. Until then it registers nothing.
 */
export function registerInbound(_core: Core, _deps: AutomationSeamDeps): void {}
