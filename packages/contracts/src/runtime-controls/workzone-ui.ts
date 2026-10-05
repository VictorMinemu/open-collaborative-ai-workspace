import type { RuntimeControlRow } from "./index";

/**
 * The Work Zone session screen of the owner's reference (D-16, D-17, `reference/ref-*.png`). Elements whose data
 * exists today are built in this phase; elements that need new data are listed as deferred, never faked.
 */
const row = (r: Omit<RuntimeControlRow, "area">): RuntimeControlRow => ({ area: "workzone-ui", ...r });

export const WORKZONE_UI_CONTROLS: readonly RuntimeControlRow[] = [
  row({
    control: "Sidebar: sessions grouped by project",
    status: "exposed",
    uiKey: "ui.sidebar.groups",
    reason: "Sessions already carry their project (Plan 10)",
    evidence: "reference/ref-4-layout.png; WorkSession.projectId",
  }),
  row({
    control: "Sidebar: status with duration (Working 5m)",
    status: "exposed",
    uiKey: "ui.sidebar.status",
    reason: "Status plus runningSince on every session (Plan 10)",
    evidence: "WorkSession.status, WorkSession.runningSince",
  }),
  row({
    control: "Sidebar: branch and diff stat",
    status: "exposed",
    uiKey: "ui.sidebar.diffstat",
    reason: "Branch and the last diff.result totals on every session (Plan 10)",
    evidence: "WorkSession.branch, WorkSession.diffStat",
  }),
  row({
    control: "Header: breadcrumb (project / session title)",
    status: "exposed",
    uiKey: "ui.header.breadcrumb",
    reason: "Project and title already exist (Plan 10)",
    evidence: "reference/ref-4-layout.png; WorkSession.projectName, title",
  }),
  row({
    control: "Header: actions (Add action, Open, Commit push & PR)",
    status: "deferred",
    uiKey: "ui.header.actions",
    reason: "Need git write / editor integration on the device that does not exist yet",
    evidence: "reference/ref-4-layout.png",
  }),
  row({
    control: "Header: Full access badge",
    status: "exposed",
    uiKey: "ui.header.fullaccess",
    reason: "Persistent badge for every controller (D-04)",
    evidence: "WorkSession.fullAccess; ADR-0012",
  }),
  row({
    control: "Stream: collapsible 'Worked for Xm Ys' turn summaries",
    status: "exposed",
    uiKey: "ui.stream.turn-summary",
    reason: "Turn start / end events already exist (Plan 10)",
    evidence: "prompt.started / prompt.completed events",
  }),
  row({
    control: "Stream: grouped tool calls",
    status: "exposed",
    uiKey: "ui.stream.tool-groups",
    reason: "tool.started / tool.completed events already exist (Plan 10)",
    evidence: "SessionEvent tool.*",
  }),
  row({
    control: "Stream: sub-agent lanes",
    status: "deferred",
    uiKey: "ui.stream.subagents",
    reason: "Needs the multi-agent phase (WORKZONE-MULTI-AGENT.md)",
    evidence: ".planning/research/WORKZONE-MULTI-AGENT.md",
  }),
  row({
    control: "Stream: 'N changed files +a −b · Open diff' card",
    status: "exposed",
    uiKey: "ui.stream.changes-card",
    reason: "diff.result after every turn (Plan 10)",
    evidence: "work_session.changes event, WorkSession.diffStat",
  }),
  row({
    control: "Floating agent bar (N agent working · View · Stop)",
    status: "exposed",
    uiKey: "ui.agent-bar",
    reason: "One agent per session today: status + interrupt (Plan 10)",
    evidence: "reference/ref-4-layout.png; POST /work-sessions/:id/interrupt",
  }),
  row({
    control: "Composer: model / reasoning / permission chips",
    status: "exposed",
    uiKey: "ui.composer.chips",
    reason: "Driven by GET /work-sessions/:id/controls (Plans 01, 09)",
    evidence: "reference/ref-1.png, ref-2.png, ref-3.png; SessionControls",
  }),
  row({
    control: "Composer: attachments",
    status: "deferred",
    uiKey: "ui.composer.attach",
    reason: "Prompt images are not wired end to end yet",
    evidence: "PromptPayload.images (device side only)",
  }),
  row({
    control: "Footer strip (worktree, diff stat, branch)",
    status: "exposed",
    uiKey: "ui.footer.strip",
    reason: "Worktree flag, branch and diff stat exist (Plan 10)",
    evidence: "WorkSession.worktree, branch, diffStat",
  }),
  row({
    control: "Turn minimap rail",
    status: "deferred",
    uiKey: "ui.minimap",
    reason: "Not needed for the controls; revisit with long-session navigation",
    evidence: "reference/ref-4-layout.png",
  }),
];
