import type { RuntimeControlRow } from "./index";

/**
 * Inventory B: Codex through `codex app-server` 0.160.0 (stable API only, experimentalApi false). Statuses confirmed
 * by the fixtures in apps/local-runtime/src/codex/__fixtures__/ (codex-cli 0.160.0): `plan-read`, `supervised-write`
 * (one subscription turn) and `model-list` (no turn).
 */
const row = (
  control: string,
  status: RuntimeControlRow["status"],
  uiKey: string | null,
  reason: string,
  evidence: string,
): RuntimeControlRow => ({ area: "codex", control, status, reason, evidence, uiKey });

export const CODEX_CONTROLS: readonly RuntimeControlRow[] = [
  row(
    "Model list (model/list)",
    "exposed",
    "model.list",
    "Works without a thread or turn for the ChatGPT account; the picker renders only this catalog (D-08)",
    "model/list → Model: v2/Model.ts, v2/ModelListResponse.ts; fixture codex-0.160.0.model-list.json (8 models); codex/catalog.ts",
  ),
  row(
    "Switch model (turn/start.model)",
    "exposed",
    "model.switch",
    "Stable override on the next turn/start, sticky for later turns (D-07, D-14)",
    "turn/start.model: v2/TurnStartParams.ts (stable); codex-runtime.test.ts",
  ),
  row(
    "Reasoning effort",
    "exposed",
    "effort",
    "Per model from supportedReasoningEfforts; an open set validated against the catalog (Pitfall 7)",
    "turn/start.effort: ReasoningEffort.ts; Model.supportedReasoningEfforts in fixture codex-0.160.0.model-list.json; effort 'low' sent in codex-0.160.0.supervised-write.rpc.jsonl",
  ),
  row(
    "Ultra effort",
    "deferred",
    "effort.ultra",
    "Proactive multi-agent behaviour; deferred to the multi-agent phase (D-09)",
    "experimental v2/TurnStartParams.ts (multiAgentMode → effort 'ultra')",
  ),
  row(
    "Reasoning summary",
    "deferred",
    null,
    "Not in the reference layout",
    "turn/start.summary: ReasoningSummary.ts",
  ),
  row(
    "Fast mode (service tier priority)",
    "exposed",
    "fast.mode",
    "Only where the model lists the priority tier; uses ChatGPT plan limits at about 2.5x; org policy default off (D-11)",
    "turn/start.serviceTier (sticky; never serviceTierForTurn): v2/TurnStartParams.ts; Model.serviceTiers 'priority' in fixture codex-0.160.0.model-list.json",
  ),
  row(
    "Ultrafast service tier",
    "deferred",
    null,
    "About 8x subscription limits and only on some models; not in the reference layout",
    "Model.serviceTiers (ultrafast): v2/ModelServiceTier.ts; developers.openai.com/codex/speed",
  ),
  row(
    "Context window (display only)",
    "exposed",
    "context.window",
    "Display only: not selectable on Codex; reported after a turn as session.settings.contextWindow (D-10)",
    "thread/tokenUsage/updated → ThreadTokenUsage.modelContextWindow (258400 in fixture codex-0.160.0.plan-read.rpc.jsonl): v2/ThreadTokenUsage.ts",
  ),
  row(
    "Effective settings readback",
    "exposed",
    null,
    "thread/settings/updated is mapped to session.settings; at 0.160.0 turn/start overrides emit none, so the adapter synthesizes the readback from what it sent (A5)",
    "v2/ThreadSettingsUpdatedNotification.ts, v2/ThreadStartResponse.ts; no thread/settings/updated in codex-0.160.0.supervised-write.rpc.jsonl",
  ),
  row(
    "Approval policy",
    "exposed",
    null,
    "Mapped from the platform permission mode (never 'never' outside full access)",
    "AskForApproval: v2/AskForApproval.ts",
  ),
  row(
    "Sandbox",
    "exposed",
    null,
    "Mapped from the platform permission mode (danger-full-access only through ADR-0012)",
    "SandboxMode / SandboxPolicy: v2/SandboxMode.ts, v2/SandboxPolicy.ts",
  ),
  row(
    "Plan mode (read-only sandbox)",
    "exposed",
    "mode.plan",
    "Read-only sandbox, approvals on request, reviewed by the user",
    "thread/start.sandbox 'read-only': v2/SandboxMode.ts; fixture codex-0.160.0.plan-read.rpc.jsonl; codex/mode-policy.ts",
  ),
  row(
    "Supervised (read-only sandbox + untrusted approvals)",
    "exposed",
    "mode.default",
    "Read-only sandbox + untrusted approvals + user reviewer: Codex asked for approval before the write and the decline left no file (D-12)",
    "fixture codex-0.160.0.supervised-write.rpc.jsonl: item/fileChange/requestApproval before any write, declined, fileChange 'declined'; AskForApproval 'untrusted': v2/AskForApproval.ts; codex/mode-policy.ts",
  ),
  row(
    "Auto-accept edits (workspace-write + on-request)",
    "exposed",
    "mode.acceptEdits",
    "Workspace-write limited to the working tree, approvals on request, reviewed by the user",
    "v2/SandboxMode.ts, v2/AskForApproval.ts; codex/mode-policy.ts",
  ),
  row(
    "Auto (auto review: approvalsReviewer auto_review)",
    "exposed",
    "mode.auto",
    "runtime review (auto_review); behaviour not fixtured: workspace-write + on-request with Codex's risk-based reviewer answering approval requests",
    "approvalsReviewer: v2/ApprovalsReviewer.ts; 0.160.0 accepts and reports auto_review (ThreadStartResponse in codex-0.160.0.plan-read.rpc.jsonl); codex/mode-policy.ts",
  ),
  row(
    "Full access (danger-full-access + never)",
    "exposed",
    "mode.fullAccess",
    "ADR-0012 path: org policy ∩ device opt-in ∩ grain; adapters report it only on opted-in devices (Plan 06)",
    "sandboxPolicy dangerFullAccess + approvalPolicy never: v2/SandboxPolicy.ts; ADR-0012",
  ),
  row(
    "Permission profiles",
    "deferred",
    null,
    "Selecting one is an experimental field",
    "permissionProfile/list: v2/PermissionProfileSummary.ts",
  ),
  row(
    "Native plan collaboration mode",
    "deferred",
    null,
    "Experimental (collaborationMode); plan stays the read-only sandbox",
    "CollaborationMode.ts, ModeKind.ts (experimental)",
  ),
  row(
    "Personality",
    "impossible",
    null,
    "Deprecated by Codex: it no longer selects a style",
    "turn/start.personality @deprecated: v2/TurnStartParams.ts",
  ),
  row(
    "Slash commands that change settings (/model, /effort, /fast, /permissions)",
    "exposed",
    "slash.settings",
    "Handled by the platform settings path (D-13, P-10)",
    "No slash-command API in app-server: ClientRequest.ts method list",
  ),
  row(
    "Slash commands passed through (/compact only)",
    "exposed",
    "slash.passthrough",
    "/compact maps to the native thread/compact/start (a non-steerable compaction turn); everything else is refused",
    "thread/compact/start: v2/ThreadCompactStartParams.ts, NonSteerableTurnKind 'compact' (0.160.0 schema); codex-runtime.test.ts",
  ),
  row("Interrupt", "exposed", "interrupt", "Already shipped", "turn/interrupt: ClientRequest.ts"),
];
