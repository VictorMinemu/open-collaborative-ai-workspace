import { z } from "zod";
import { CLAUDE_CODE_CONTROLS } from "./claude-code";
import { CODEX_CONTROLS } from "./codex";
import { WORKZONE_UI_CONTROLS } from "./workzone-ui";

/**
 * Runtime controls inventory (Phase 03.2, WZC-06, P-09): every option Claude Code and Codex expose, and every
 * element of the reference session layout (D-17), with its status in the platform, why, and the evidence. It is
 * CODE, not prose: the web renders a control only when `isExposed(area, uiKey)` is true, and Plan 11 writes
 * `docs/workzone/runtime-controls-inventory.md` from it with a parity test. A row moves from `deferred` to
 * `exposed` only with its evidence (e.g. a recorded fixture at the pinned version).
 */

export const RuntimeControlArea = z.enum(["claude-code", "codex", "workzone-ui"]);
export type RuntimeControlArea = z.infer<typeof RuntimeControlArea>;

/** `exposed` = ships in 03.2; `deferred` = possible, not yet; `impossible` = no programmatic path or forbidden. */
export const RuntimeControlStatus = z.enum(["exposed", "deferred", "impossible"]);
export type RuntimeControlStatus = z.infer<typeof RuntimeControlStatus>;

export interface RuntimeControlRow {
  area: RuntimeControlArea;
  control: string;
  status: RuntimeControlStatus;
  reason: string;
  /** Type, line or source that proves the path (e.g. `sdk.d.ts:2887-2893`, `v2/TurnStartParams.ts`). */
  evidence: string;
  /** Key the web gates on; null = no UI element of its own (mapped through another control). */
  uiKey: string | null;
}

/** The runtime versions the inventory was checked against (fixtures are recorded at these versions). */
export const PINNED_RUNTIME_VERSIONS = {
  "claude-code": { cli: "2.1.289", sdk: "0.3.282" },
  codex: { cli: "0.160.0" },
} as const;

export const RUNTIME_CONTROL_INVENTORY: readonly RuntimeControlRow[] = [
  ...CLAUDE_CODE_CONTROLS,
  ...CODEX_CONTROLS,
  ...WORKZONE_UI_CONTROLS,
];

/** Status of the row with `uiKey` in `area`, or null when there is none. */
export function controlStatus(area: RuntimeControlArea, uiKey: string): RuntimeControlStatus | null {
  return RUNTIME_CONTROL_INVENTORY.find((r) => r.area === area && r.uiKey === uiKey)?.status ?? null;
}

/** The web may render the control (an unknown key is never exposed). */
export function isExposed(area: RuntimeControlArea, uiKey: string): boolean {
  return controlStatus(area, uiKey) === "exposed";
}
