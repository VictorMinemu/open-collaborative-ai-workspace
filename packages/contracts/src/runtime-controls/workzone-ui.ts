import type { RuntimeControlRow } from "./index";

/**
 * The Work Zone session screen of the owner's reference (D-16, D-17, `reference/ref-*.png`). Elements whose data
 * exists today are built (evidence: the component and its test id, exercised by `e2e/tests/work-zone-layout.spec.ts`);
 * elements that need new data are listed as deferred, never faked.
 */
const row = (r: Omit<RuntimeControlRow, "area">): RuntimeControlRow => ({ area: "workzone-ui", ...r });

export const WORKZONE_UI_CONTROLS: readonly RuntimeControlRow[] = [
  row({
    control: "Sidebar: sessions grouped by project",
    status: "exposed",
    uiKey: "ui.sidebar.groups",
    reason: "Active rows sorted by project, each with its project badge and name (Plan 10)",
    evidence:
      'apps/web/components/work-zone/session-sidebar.tsx data-testid="session-row" / "row-project"; WorkSession.projectId',
  }),
  row({
    control: "Sidebar: status with duration (Working 5m)",
    status: "exposed",
    uiKey: "ui.sidebar.status",
    reason: "Status plus runningSince on every session; 'Needs approval' in the warning tone (Plan 10)",
    evidence:
      'apps/web/components/work-zone/session-sidebar.tsx data-testid="row-status"; WorkSession.runningSince',
  }),
  row({
    control: "Sidebar: branch and diff stat",
    status: "exposed",
    uiKey: "ui.sidebar.diffstat",
    reason: "Branch and the last diff.result totals on every session (Plan 10)",
    evidence:
      'apps/web/components/work-zone/session-sidebar.tsx data-testid="row-branch" / "row-diffstat"; WorkSession.diffStat',
  }),
  row({
    control: "Sidebar: Settled group with 'Show N more'",
    status: "exposed",
    uiKey: "ui.sidebar.settled",
    reason: "Ended, failed and idle-for-a-day sessions, collapsible, 10 rows at a time (Plan 10)",
    evidence:
      'apps/web/components/work-zone/session-sidebar.tsx data-testid="settled-group" / "settled-more"',
  }),
  row({
    control: "Sidebar: search",
    status: "exposed",
    uiKey: "ui.sidebar.search",
    reason: "Filters the listed sessions by title or project (Plan 10)",
    evidence: 'apps/web/components/work-zone/session-sidebar.tsx data-testid="session-search"',
  }),
  row({
    control: "Header: breadcrumb (project / session title)",
    status: "exposed",
    uiKey: "ui.header.breadcrumb",
    reason: "Project and title already exist (Plan 10)",
    evidence:
      'apps/web/components/work-zone/session-view.tsx data-testid="session-title"; WorkSession.projectName',
  }),
  row({
    control: "Header: actions (Add action, Open, Commit push & PR)",
    status: "deferred",
    uiKey: "ui.header.actions",
    reason: "Add action / Open / Commit, push & PR need git and editor integration not in scope",
    evidence: "reference/ref-4-layout.png",
  }),
  row({
    control: "Header: Full access badge",
    status: "exposed",
    uiKey: "ui.header.fullaccess",
    reason: "Persistent badge for every controller (D-04)",
    evidence: 'apps/web/components/work-zone/full-access-badge.tsx data-testid="full-access-badge"; ADR-0012',
  }),
  row({
    control: "Stream: collapsible 'Worked for Xm Ys' turn summaries",
    status: "exposed",
    uiKey: "ui.stream.turn-summary",
    reason: "Prompt dispatch / completion times and prompt.started / prompt.completed events (Plan 10)",
    evidence: 'apps/web/components/work-zone/turn-summary.tsx data-testid="turn-summary"',
  }),
  row({
    control: "Stream: grouped tool calls",
    status: "exposed",
    uiKey: "ui.stream.tool-groups",
    reason: "tool.started / tool.completed events already exist (Plan 10)",
    evidence: 'apps/web/components/work-zone/event-stream.tsx data-testid="tool-group"',
  }),
  row({
    control: "Stream: final message time and copy",
    status: "exposed",
    uiKey: "ui.stream.message-footer",
    reason: "assistant.message event time (Plan 10)",
    evidence: 'apps/web/components/work-zone/event-stream.tsx data-testid="copy-message" / "message-time"',
  }),
  row({
    control: "Stream: sub-agent lanes",
    status: "deferred",
    uiKey: "ui.stream.subagents",
    reason: "Needs sub-agent events; multi-agent phase (WORKZONE-MULTI-AGENT.md)",
    evidence: "reference/ref-4-layout.png; .planning/research/WORKZONE-MULTI-AGENT.md",
  }),
  row({
    control: "Stream: 'N changed files +a −b · Open diff' card",
    status: "exposed",
    uiKey: "ui.stream.changes-card",
    reason: "diff.result after every turn, rolled up by top-level folder (Plan 10)",
    evidence:
      'apps/web/components/work-zone/changes-card.tsx data-testid="changes-card" / "open-diff"; work_session.changes',
  }),
  row({
    control: "Floating agent bar (N agent working · View · Stop)",
    status: "exposed",
    uiKey: "ui.agent-bar",
    reason: "One agent per session today: status + interrupt (Plan 10)",
    evidence:
      'apps/web/components/work-zone/agent-bar.tsx data-testid="agent-bar" / "interrupt"; POST /work-sessions/:id/interrupt',
  }),
  row({
    control: "Composer: model / reasoning / permission chips",
    status: "exposed",
    uiKey: "ui.composer.chips",
    reason: "Driven by GET /work-sessions/:id/controls (Plans 01, 09)",
    evidence:
      'apps/web/components/work-zone/composer.tsx data-testid="composer-controls"; reference/ref-1.png, ref-2.png, ref-3.png',
  }),
  row({
    control: "Composer: attachments",
    status: "deferred",
    uiKey: "ui.composer.attach",
    reason: "Needs file uploads, Phase 4 (prompt images are not wired end to end yet)",
    evidence: "reference/ref-4-layout.png; PromptPayload.images (device side only)",
  }),
  row({
    control: "Footer strip (worktree, diff stat, branch)",
    status: "exposed",
    uiKey: "ui.footer.strip",
    reason: "Worktree flag, device, branch and diff stat exist (Plan 10)",
    evidence: 'apps/web/components/work-zone/session-footer.tsx data-testid="session-footer"',
  }),
  row({
    control: "Turn minimap rail",
    status: "deferred",
    uiKey: "ui.minimap",
    reason: "Turn navigation rail; deferred until long-session navigation is planned",
    evidence: "reference/ref-4-layout.png",
  }),
];
