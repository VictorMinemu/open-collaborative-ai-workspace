# Work Zone runtime controls inventory

Every option Claude Code and Codex expose to a session, and every element of the reference session screen,
with its status in the platform, why, and the evidence (requirement WZC-06, Phase 03.2). Decision record:
[ADR-0013](../adr/0013-work-zone-session-settings-protocol.md); Full access path:
[ADR-0012](../adr/0012-full-access-mode-and-shared-devices.md).

The inventory is **code**, not this page: `packages/contracts/src/runtime-controls/` (`RUNTIME_CONTROL_INVENTORY`).
The web renders a control only when `isExposed(area, uiKey)` is true, and the API's controls
(`apps/api/src/modules/work-session/controls.ts`) refuse anything whose row is not exposed with the reason
`not_confirmed`. Two tests keep the three in step:

- `packages/contracts/src/runtime-controls/inventory-doc.test.ts`: the tables below equal the code inventory.
- `apps/api/src/modules/work-session/inventory-parity.test.ts`: with every other layer wide open (full catalog,
  most permissive policy, device opted in, owner, grain), the API offers only options whose row is exposed.

## Pinned runtime versions

The rows were checked, and the fixtures recorded, against:

| Runtime | Version | Fixtures |
| --- | --- | --- |
| Claude Code | CLI 2.1.289, Claude Agent SDK 0.3.282 | `apps/local-runtime/src/claude/__fixtures__/claude-code-2.1.289.{settings.sdk.jsonl,catalog.json}` (plus the 2.1.287 plan-read lifecycle fixture) |
| Codex | `codex app-server` 0.160.0 (stable API, `experimentalApi` off) | `apps/local-runtime/src/codex/__fixtures__/codex-0.160.0.{plan-read.rpc.jsonl,supervised-write.rpc.jsonl,model-list.json}` |

Codex auto-updated to 0.160.1 on the recording machine; types, fixtures and `PINNED_RUNTIME_VERSIONS` stay on
0.160.0 (recorded with the still-installed 0.160.0 binary). A device running 0.160.1 reports that version in its
catalog. Re-pinning is a follow-up chore (refresh procedure below).

## How a status is decided

- **exposed**: ships in Phase 03.2 and is confirmed by the runtime's types, a probe without a turn, or a recorded
  fixture at the pinned version. The evidence column names which.
- **deferred**: possible, but not in 03.2; the reason says why (out of the reference layout, needs a later phase,
  experimental API, or not proven by a fixture yet). Deferred controls are never rendered and never offered.
- **impossible**: no programmatic path, or deprecated by the runtime.

A row moves from `deferred` to `exposed` only together with its evidence. Two exposed rows are not proven against a
real runtime: Full access (both runtimes) and Codex Auto's reviewer behaviour. Their fixtures would cost a
subscription turn in bypass mode or an unrecorded reviewer turn; the owner checks them by hand (manual-only row
in `.planning/phases/03.2-work-zone-session-controls/03.2-VALIDATION.md`).

## Refreshing after a runtime upgrade

1. Install the new runtime next to the pinned one (do not overwrite the pinned binary until the refresh is done).
2. Codex: regenerate the app-server types with `node apps/local-runtime/scripts/generate-codex-types.mjs --codex <path>`
   and review the diff of `apps/local-runtime/src/codex/generated/` (new, removed or experimental fields).
3. Re-run the probes and recorders in a throwaway git repository, at most one subscription turn per runtime and
   never in Full access:
   - Claude Code: `pnpm --filter @ocw/local-runtime exec tsx scripts/record-fixture.ts --scenario catalog` (no turn)
     and `--scenario settings` (one turn).
   - Codex: `pnpm --filter @ocw/local-runtime exec tsx scripts/record-codex-fixture.ts --scenario model-list`
     (no turn) and `--scenario supervised-write` (one turn), with `--codex <path>` for a specific binary.
4. Update `PINNED_RUNTIME_VERSIONS` and the rows in `packages/contracts/src/runtime-controls/` (status, reason,
   evidence) to what the new fixtures show; run `pnpm --filter @ocw/local-runtime test`.
5. Regenerate the tables of this page:
   `pnpm exec tsx packages/contracts/src/runtime-controls/render-doc.ts --write`, then `pnpm verify`.

Never edit the text between the markers by hand: the next `--write` replaces it and the test fails until it does.

## Inventory

<!-- inventory:start -->

### Claude Code

| Control | Status | Reason | Evidence |
| --- | --- | --- | --- |
| Model list (per subscription) | exposed | Reported by the runtime per account; the picker renders only this catalog (D-08) | Query.initializationResult().models / supportedModels(): sdk.d.ts:2998-3004; fixture claude-code-2.1.289.catalog.json (12 rows, no turn) |
| Switch model | exposed | Applied between turns with setModel in streaming input mode (D-07, D-14); every init reports the effective model (D-15) | Query.setModel(): sdk.d.ts:2887-2893; fixture claude-code-2.1.289.settings.sdk.jsonl: setModel("sonnet") → init model claude-sonnet-5-5 |
| Effort (Low / Medium / High / Extra High / Max) | exposed | Levels from ModelInfo.supportedEffortLevels; applied between turns with applyFlagSettings({ effortLevel }) (only scalar keys, never permissions). The SDK init does not echo effort, so the readback is the applied value | applyFlagSettings: sdk.d.ts:1905-1916, 2920-2944; fixture claude-code-2.1.289.settings.sdk.jsonl: applyFlagSettings({effortLevel:"low"}) accepted, turn ran |
| Ultracode | deferred | Starts multi-agent work inside the runtime; deferred to the multi-agent phase (D-09, Pitfall 6) | Settings.ultracode: sdk.d.ts:8851-8853 |
| Ultrathink (prompt keyword) | deferred | A prompt keyword, not a setting; offered only if a recorded fixture proves it works through the SDK (D-09) | CLI 2.1.282 strings (ultrathink_effort); code.claude.com/docs/en/model-config |
| Thinking budget (on / off / tokens) | deferred | Start-only option and setMaxThinkingTokens is deprecated; not in the reference layout | Options.thinking: sdk.d.ts:1891-1903, 2894-2919 |
| Context window 200k / 1M | exposed | Only where the runtime accepts both values (at 2.1.289: claude-opus-4-6 only); elsewhere the fixed value is shown (D-10) | Probe setModel(id / id[1m]) + getContextUsage().maxTokens; sdk.d.ts:1706-1713, 3716; fixture claude-code-2.1.289.catalog.json |
| Context usage indicator | deferred | Nice-to-have read-only indicator; not needed for the controls | Query.getContextUsage(): sdk.d.ts:3938-3961 |
| Fast mode on / off | exposed | Metered (paid usage credits, not the plan limits); org policy default off; applied with applyFlagSettings({ fastMode }) and shown disabled with the runtime's reason from init fast_mode_disabled_reason (sdk_opt_in_required before opt-in, extra_usage_disabled on this account per research) (D-11) | Settings.fastMode / fast_mode_state: sdk.d.ts:766-776, 8861-8869, 4529-4532; fixture claude-code-2.1.289.settings.sdk.jsonl: init fast_mode_state off / sdk_opt_in_required |
| Plan mode | exposed | Already shipped; read-only planning | permissionMode 'plan': sdk.d.ts:1982-1998; fixture claude-code-2.1.287.plan-read.sdk.jsonl |
| Supervised (permission mode default) | exposed | Already shipped; every edit and command asks | PermissionMode 'default': sdk.d.ts:2479-2481 |
| Auto-accept edits (permission mode acceptEdits) | exposed | Already shipped; edits run, commands ask | PermissionMode 'acceptEdits': sdk.d.ts:2479-2481 |
| Auto (permission mode auto) | exposed | Offered only for models with supportsAutoMode; the runtime confirmed it: after setPermissionMode('auto') the status frame and the next system/init report permissionMode auto | PermissionMode 'auto', ModelInfo.supportsAutoMode: sdk.d.ts:1420-1423, 2858-2864, 9019-9021; fixture claude-code-2.1.289.settings.sdk.jsonl |
| Full access (bypassPermissions) | exposed | ADR-0012 path: org policy ∩ device opt-in ∩ grain (server) and the daemon's own opt-in check (device); offered only on opted-in devices | Adapter path: claude-runtime.ts launchOptions + relaunch with resume between turns (bypassPermissions + allowDangerouslySkipPermissions, secret deny rules and PreToolUse hook kept), unauthorized bypass init aborts; PermissionMode 'bypassPermissions': sdk.d.ts:1987-2003; real-turn check manual-only (03.2-VALIDATION.md) |
| dontAsk permission mode | deferred | Denies anything not pre-approved instead of asking; no platform mode maps to it yet | PermissionMode 'dontAsk': sdk.d.ts:2479-2481 |
| Fallback model | deferred | Start-only option, not in the reference layout | Options.fallbackModel: sdk.d.ts:1675-1681 |
| Slash commands that change settings (/model, /effort, /fast, /permissions) | exposed | Intercepted and routed through the policy-checked, audited settings path (D-13, P-10); the adapter refuses them as a backstop (slash_command_refused) | supportedCommands() / system/init.slash_commands: sdk.d.ts:2998, 3719, 9200-9222; refuseSlashCommand in claude-runtime.ts |
| Slash commands passed through (/compact, /context, /usage, /cost, /init, /review) | exposed | Allowlist sent as a prompt; every other command is refused with a notice (Pitfall 3) | code.claude.com/docs/en/agent-sdk/slash-commands |
| Interrupt | exposed | Already shipped | Query.interrupt(): sdk.d.ts:2851-2857 |
| Session title model (Haiku, one-shot query) | exposed | Automatic session titles (D-18): a separate one-shot query with `haiku` on the device owner's login, isolated from the session: no tools (deny-all canUseTool), default mode (plan swaps Haiku for Sonnet), bypass disabled, no filesystem settings or MCP servers, not persisted, empty temp directory, thinking off | Options.tools ~1637, persistSession ~1814, thinking ~1903, maxTurns ~1930, settingSources ~2249, strictMcpConfig ~2298, systemPrompt ~2400 (sdk.d.ts); fixture claude-code-2.1.289.title.sdk.jsonl |
| Rewind files | deferred | Changes the working tree outside a turn; needs its own approval design | Query.rewindFiles(): sdk.d.ts:3010-3016 |
| MCP server status | deferred | Not part of the session controls | Query.mcpServerStatus(): sdk.d.ts:3010-3016 |

### Codex

| Control | Status | Reason | Evidence |
| --- | --- | --- | --- |
| Model list (model/list) | exposed | Works without a thread or turn for the ChatGPT account; the picker renders only this catalog (D-08) | model/list → Model: v2/Model.ts, v2/ModelListResponse.ts; fixture codex-0.160.0.model-list.json (8 models); codex/catalog.ts |
| Switch model (turn/start.model) | exposed | Stable override on the next turn/start, sticky for later turns (D-07, D-14) | turn/start.model: v2/TurnStartParams.ts (stable); codex-runtime.test.ts |
| Reasoning effort | exposed | Per model from supportedReasoningEfforts; an open set validated against the catalog (Pitfall 7) | turn/start.effort: ReasoningEffort.ts; Model.supportedReasoningEfforts in fixture codex-0.160.0.model-list.json; effort 'low' sent in codex-0.160.0.supervised-write.rpc.jsonl |
| Ultra effort | deferred | Proactive multi-agent behaviour; deferred to the multi-agent phase (D-09) | experimental v2/TurnStartParams.ts (multiAgentMode → effort 'ultra') |
| Reasoning summary | deferred | Not in the reference layout | turn/start.summary: ReasoningSummary.ts |
| Fast mode (service tier priority) | exposed | Only where the model lists the priority tier; uses ChatGPT plan limits at about 2.5x; org policy default off (D-11) | turn/start.serviceTier (sticky; never serviceTierForTurn): v2/TurnStartParams.ts; Model.serviceTiers 'priority' in fixture codex-0.160.0.model-list.json |
| Ultrafast service tier | deferred | About 8x subscription limits and only on some models; not in the reference layout | Model.serviceTiers (ultrafast): v2/ModelServiceTier.ts; developers.openai.com/codex/speed |
| Context window (display only) | exposed | Display only: not selectable on Codex; reported after a turn as session.settings.contextWindow (D-10) | thread/tokenUsage/updated → ThreadTokenUsage.modelContextWindow (258400 in fixture codex-0.160.0.plan-read.rpc.jsonl): v2/ThreadTokenUsage.ts |
| Effective settings readback | exposed | thread/settings/updated is mapped to session.settings; at 0.160.0 turn/start overrides emit none, so the adapter synthesizes the readback from what it sent (A5) | v2/ThreadSettingsUpdatedNotification.ts, v2/ThreadStartResponse.ts; no thread/settings/updated in codex-0.160.0.supervised-write.rpc.jsonl |
| Approval policy | exposed | Mapped from the platform permission mode (never 'never' outside full access) | AskForApproval: v2/AskForApproval.ts |
| Sandbox | exposed | Mapped from the platform permission mode (danger-full-access only through ADR-0012) | SandboxMode / SandboxPolicy: v2/SandboxMode.ts, v2/SandboxPolicy.ts |
| Plan mode (read-only sandbox) | exposed | Read-only sandbox, approvals on request, reviewed by the user | thread/start.sandbox 'read-only': v2/SandboxMode.ts; fixture codex-0.160.0.plan-read.rpc.jsonl; codex/mode-policy.ts |
| Supervised (read-only sandbox + untrusted approvals) | exposed | Read-only sandbox + untrusted approvals + user reviewer: Codex asked for approval before the write and the decline left no file (D-12) | fixture codex-0.160.0.supervised-write.rpc.jsonl: item/fileChange/requestApproval before any write, declined, fileChange 'declined'; AskForApproval 'untrusted': v2/AskForApproval.ts; codex/mode-policy.ts |
| Auto-accept edits (workspace-write + on-request) | exposed | Workspace-write limited to the working tree, approvals on request, reviewed by the user | v2/SandboxMode.ts, v2/AskForApproval.ts; codex/mode-policy.ts |
| Auto (auto review: approvalsReviewer auto_review) | exposed | runtime review (auto_review); behaviour not fixtured: workspace-write + on-request with Codex's risk-based reviewer answering approval requests | approvalsReviewer: v2/ApprovalsReviewer.ts; 0.160.0 accepts and reports auto_review (ThreadStartResponse in codex-0.160.0.plan-read.rpc.jsonl); codex/mode-policy.ts |
| Full access (danger-full-access + never) | exposed | ADR-0012 path: org policy ∩ device opt-in ∩ grain (server) and the daemon's own opt-in check (device); offered only on opted-in devices | Adapter path: codexModePolicy('fullAccess') → approvalPolicy never + sandboxPolicy dangerFullAccess per turn/start (thread/start danger-full-access), unrestricted readback outside a fullAccess turn aborts it; v2/SandboxPolicy.ts; real-turn check manual-only (03.2-VALIDATION.md) |
| Permission profiles | deferred | Selecting one is an experimental field | permissionProfile/list: v2/PermissionProfileSummary.ts |
| Native plan collaboration mode | deferred | Experimental (collaborationMode); plan stays the read-only sandbox | CollaborationMode.ts, ModeKind.ts (experimental) |
| Personality | impossible | Deprecated by Codex: it no longer selects a style | turn/start.personality @deprecated: v2/TurnStartParams.ts |
| Slash commands that change settings (/model, /effort, /fast, /permissions) | exposed | Handled by the platform settings path (D-13, P-10) | No slash-command API in app-server: ClientRequest.ts method list |
| Slash commands passed through (/compact only) | exposed | /compact maps to the native thread/compact/start (a non-steerable compaction turn); everything else is refused | thread/compact/start: v2/ThreadCompactStartParams.ts, NonSteerableTurnKind 'compact' (0.160.0 schema); codex-runtime.test.ts |
| Interrupt | exposed | Already shipped | turn/interrupt: ClientRequest.ts |
| Session title model (GPT-6-Luna, ephemeral thread) | exposed | Automatic session titles (D-18): an ephemeral `gpt-6-luna` thread on its own short-lived app-server on the device owner's ChatGPT login, isolated from the session: read-only sandbox, untrusted approvals (every request declined), any tool item interrupts, effort low, empty temp directory | thread/start.ephemeral + baseInstructions: v2/ThreadStartParams.ts; turn/start.effort + summary: v2/TurnStartParams.ts; fixture codex-0.160.0.title.rpc.jsonl |

### Work Zone UI

| Control | Status | Reason | Evidence |
| --- | --- | --- | --- |
| Sidebar: sessions grouped by project | exposed | Active rows sorted by project, each with its project badge and name (Plan 10) | apps/web/components/work-zone/session-sidebar.tsx data-testid="session-row" / "row-project"; WorkSession.projectId |
| Sidebar: status with duration (Working 5m) | exposed | Status plus runningSince on every session; 'Needs approval' in the warning tone (Plan 10) | apps/web/components/work-zone/session-sidebar.tsx data-testid="row-status"; WorkSession.runningSince |
| Sidebar: branch and diff stat | exposed | Branch and the last diff.result totals on every session (Plan 10) | apps/web/components/work-zone/session-sidebar.tsx data-testid="row-branch" / "row-diffstat"; WorkSession.diffStat |
| Sidebar: Settled group with 'Show N more' | exposed | Ended, failed and idle-for-a-day sessions, collapsible, 10 rows at a time (Plan 10) | apps/web/components/work-zone/session-sidebar.tsx data-testid="settled-group" / "settled-more" |
| Sidebar: search | exposed | Filters the listed sessions by title or project (Plan 10) | apps/web/components/work-zone/session-sidebar.tsx data-testid="session-search" |
| Header: breadcrumb (project / session title) | exposed | Project and title already exist (Plan 10) | apps/web/components/work-zone/session-view.tsx data-testid="session-title"; WorkSession.projectName |
| Header: actions (Add action, Open, Commit push & PR) | deferred | Add action / Open / Commit, push & PR need git and editor integration not in scope | reference/ref-4-layout.png |
| Header: Full access badge | exposed | Persistent badge for every controller (D-04) | apps/web/components/work-zone/full-access-badge.tsx data-testid="full-access-badge"; ADR-0012 |
| Stream: collapsible 'Worked for Xm Ys' turn summaries | exposed | Prompt dispatch / completion times and prompt.started / prompt.completed events (Plan 10) | apps/web/components/work-zone/turn-summary.tsx data-testid="turn-summary" |
| Stream: grouped tool calls | exposed | tool.started / tool.completed events already exist (Plan 10) | apps/web/components/work-zone/event-stream.tsx data-testid="tool-group" |
| Stream: final message time and copy | exposed | assistant.message event time (Plan 10) | apps/web/components/work-zone/event-stream.tsx data-testid="copy-message" / "message-time" |
| Stream: sub-agent lanes | deferred | Needs sub-agent events; multi-agent phase (WORKZONE-MULTI-AGENT.md) | reference/ref-4-layout.png; .planning/research/WORKZONE-MULTI-AGENT.md |
| Stream: 'N changed files +a −b · Open diff' card | exposed | diff.result after every turn, rolled up by top-level folder (Plan 10) | apps/web/components/work-zone/changes-card.tsx data-testid="changes-card" / "open-diff"; work_session.changes |
| Floating agent bar (N agent working · View · Stop) | exposed | One agent per session today: status + interrupt (Plan 10) | apps/web/components/work-zone/agent-bar.tsx data-testid="agent-bar" / "interrupt"; POST /work-sessions/:id/interrupt |
| Composer: model / reasoning / permission chips | exposed | Driven by GET /work-sessions/:id/controls (Plans 01, 09) | apps/web/components/work-zone/composer.tsx data-testid="composer-controls"; reference/ref-1.png, ref-2.png, ref-3.png |
| Composer: attachments | deferred | Needs file uploads, Phase 4 (prompt images are not wired end to end yet) | reference/ref-4-layout.png; PromptPayload.images (device side only) |
| Footer strip (worktree, diff stat, branch) | exposed | Worktree flag, device, branch and diff stat exist (Plan 10) | apps/web/components/work-zone/session-footer.tsx data-testid="session-footer" |
| Turn minimap rail | deferred | Turn navigation rail; deferred until long-session navigation is planned | reference/ref-4-layout.png |

<!-- inventory:end -->
