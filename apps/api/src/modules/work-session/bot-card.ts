import {
  type AgentCardField,
  type AgentCardNotice,
  type AgentCardStatus,
  type PermissionMode,
  type RuntimeId,
  WORK_SESSION_CARD_LABELS,
  type WorkSessionStatus,
  workSessionCardStatus,
  workSessionStepLabel,
} from "@ocw/contracts";
import { devices, projects, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";

/**
 * Phase 07.16 (D-12, PD-12; ADR-0031): the live card of a bot-started session, composed by the server. It is posted in
 * the asker's thread and read by every reader of the conversation (the `conv:` stream is shared), so every field is
 * viewer-neutral: the runtime, the repository's own name (never the team project's name, a per-viewer field), the
 * device's name, the effective model, the mode's label, a coarse step and the time it was composed. Never a prompt,
 * output, tool summary, error text or title (titles are prompt-derived). The start route (15) posts it; the `bot_sync`
 * handler (20) refreshes it.
 */

/** `permissionModeMeta(mode).label` of the web (apps/web/components/work-zone/meta.tsx): one label per mode. */
const MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  default: "Supervised",
  acceptEdits: "Auto-accept edits",
  plan: "Plan",
  auto: "Auto",
  fullAccess: "Full access",
};

const RUNTIME_LABEL: Readonly<Record<RuntimeId, string>> = { "claude-code": "Claude Code", codex: "Codex" };

/** What the card shows when the session names no model (the runtime's own default runs). */
const DEFAULT_MODEL_LABEL = "Default";

export interface WorkSessionCardSession {
  id: string;
  status: WorkSessionStatus;
  runtime: RuntimeId;
  model: string | null;
  permissionMode: PermissionMode;
  projectId: string;
  deviceId: string;
}

export interface WorkSessionCard {
  title: string;
  fields: AgentCardField[];
  status: AgentCardStatus;
  statusLabel?: string;
  notices?: AgentCardNotice[];
  /** The repository's name (the title's and the Project field's value). */
  projectName: string;
}

/** The card's fields for `s` (`turn` = prompts that have run so far), in `WORK_SESSION_CARD_LABELS` order. */
export async function composeWorkSessionCard(
  tx: Tx,
  s: WorkSessionCardSession,
  p: { turn: number; pendingApprovals: number },
): Promise<WorkSessionCard> {
  const [project] = await tx
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, s.projectId))
    .limit(1);
  const [device] = await tx
    .select({ name: devices.name })
    .from(devices)
    .where(eq(devices.id, s.deviceId))
    .limit(1);
  const projectName = project?.name ?? "Repository";
  const L = WORK_SESSION_CARD_LABELS;
  const fields: AgentCardField[] = [
    { label: L.runtime, value: RUNTIME_LABEL[s.runtime] },
    { label: L.project, value: projectName },
    { label: L.device, value: device?.name ?? "Device" },
    { label: L.model, value: s.model ?? DEFAULT_MODEL_LABEL },
    { label: L.mode, value: MODE_LABEL[s.permissionMode] },
    {
      label: L.step,
      value: workSessionStepLabel({ status: s.status, turn: p.turn, pendingApprovals: p.pendingApprovals }),
    },
    { label: L.updated, value: new Date().toISOString() },
  ];
  return {
    title: `Work Zone · ${projectName}`.slice(0, 200),
    fields: fields.map((f) => ({ label: f.label, value: f.value.slice(0, 500) })),
    ...workSessionCardStatus(s.status),
    projectName,
  };
}
