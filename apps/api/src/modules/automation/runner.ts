import type { Core } from "../../core";
import type { AutomationSeamDeps } from "./actions";

/**
 * The runner (07.6-09 fills this file): the one-minute `automation.tick` over `app.due_automations`, the
 * `automation.fire` worker (re-decides the target and the limits, then the action kind's `fire`), the built-in
 * `agent_turn` kind and the no-reply sweep. Until then it registers nothing: runs stay `queued` (Run now enqueues
 * `automation.fire` jobs that wait for this worker).
 */
export function registerRunner(_core: Core, _deps: AutomationSeamDeps): void {}
