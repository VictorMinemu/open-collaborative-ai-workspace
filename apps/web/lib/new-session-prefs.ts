import type { RuntimeId } from "@ocw/contracts";

/**
 * What the New session dialog opens on next time: the repository and the agent the viewer last started a session
 * with. A per-viewer convenience in this browser only (never shared, never trusted: the dialog re-checks the repository
 * against `GET /projects` and the agent against the device). Permission modes are never remembered, so a riskier mode
 * is never preselected.
 */
export type NewSessionPrefs = { projectId?: string; runtime?: RuntimeId };

const KEY = "ocw.workZone.newSession";
const RUNTIME_IDS: readonly RuntimeId[] = ["claude-code", "codex"];

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readNewSessionPrefs(storage: Storage | null = browserStorage()): NewSessionPrefs {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as { projectId?: unknown; runtime?: unknown } | null;
    const out: NewSessionPrefs = {};
    if (typeof v?.projectId === "string" && v.projectId.length <= 64) out.projectId = v.projectId;
    if (RUNTIME_IDS.includes(v?.runtime as RuntimeId)) out.runtime = v?.runtime as RuntimeId;
    return out;
  } catch {
    return {};
  }
}

export function saveNewSessionPrefs(
  prefs: Required<NewSessionPrefs>,
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ projectId: prefs.projectId, runtime: prefs.runtime }));
  } catch {
    // Private mode or blocked site data: the dialog falls back to its default choice.
  }
}
