// The browser child's op deadlines (07.13 HI-01): one table for the child (`main.ts` races each op against it) and the
// parent (`child.ts` waits a little longer), so the child always answers first. Kept apart from `ops.ts`, which loads
// the engine and with it playwright-core: the daemon reads this at start, and only the browser may load playwright-core.

import { WORK_BROWSER_TIMEOUTS_MS } from "@ocw/contracts";
import type { AgentOp } from "./ops.js";

/** The child's deadline for one op: `open` and `openWithState` may launch Chromium first. */
export function opDeadlineMs(op: AgentOp): number {
  return op === "open" || op === "openWithState"
    ? WORK_BROWSER_TIMEOUTS_MS.launch + WORK_BROWSER_TIMEOUTS_MS.op
    : WORK_BROWSER_TIMEOUTS_MS.op;
}
