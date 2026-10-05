# Work Zone: several agents in one session (research, 2026-10-05)

**Question:** run several agents (2× Codex, Claude Code + Codex, …) inside one Work Zone session, each on its own task, reachable from an agent strip at the top of the session.
**Recommendation:** one session holds N **agent lanes**. Each lane is today's `WorkSession` (one runtime, one queue, one approval set, one `ws:<id>` stream) running in **its own git worktree and branch**. A new parent row groups the lanes. Native sub-agents are shown nested inside their lane. A coordinator that spawns lanes comes later. This keeps "one execution authority per working tree" by construction and reuses everything that already ships.

## 0. What exists today (repo facts)

- One `WorkSession` = one runtime + one conversation + queue + approvals + stream `ws:<id>` with its own seq and `lastLocalSeq` (`packages/db/src/schema/app.ts:711-790`, `packages/contracts/src/work-session.ts`). The arbiter serializes on the session row lock (`apps/api/src/modules/work-session/service.ts:61,238`).
- Optional worktree per session: `<repo>/.ocw-worktrees/<sessionId>` on branch `ocw/<id12>` (`apps/local-runtime/src/git.ts:235-256`, `daemon.ts:205-211`). The UI toggle is "Isolated worktree" (`apps/web/components/work-zone/new-session-dialog.tsx:313`).
- **Gap:** nothing stops two non-worktree sessions from running on the same project path. The guard is planned in Phase 9 SC3 ("second session … offered a worktree").
- Adapters: Codex runs one `app-server` process per session (`codex/codex-runtime.ts:1`). Sub-agents are collapsed: Claude drops `parent_tool_use_id` text (`claude/mapper.ts:143`), and Codex `collabAgentToolCall` becomes an "Agent" tool card (`codex/mapper.ts:67`).
- Prior research already set the rule "parallelism = multiple sessions in separate worktrees" (`.planning/research/FEATURES.md:209`). The PRD forbids several agents writing the same tree (`docs/prd/PRD.md:948,3491`).
- Reusable UI: `RuntimeLogo`, `StatusDot`, `StatusChip` (`apps/web/components/work-zone/meta.tsx`) and the session header/panels in `session-view.tsx`.

## 1. Execution models

| Option | Who does it this way (source) | One authority per tree? | Verdict |
|---|---|---|---|
| **(a) N runtimes, one worktree + branch each** | Conductor: "its own workspace, branch, files, terminal, diff" [1]. Crystal/Nimbalyst: one worktree per session, Claude + Codex [2]. Claude Squad: tmux + one worktree per instance [3]. Vibe Kanban: "each workspace gives an agent a branch, a terminal, and a dev server" [4]. Cursor `/best-of-n`: one worktree per model, compares but never merges [5]. Codex app: worktrees for parallel chats, keeps the 15 most recent, "handoff" back to local [6]. T3 Code: Shift-click several models → "each selection starts a separate thread and worktree" [7] | **Yes**: each tree has exactly one runtime | **Base model** |
| (a′) N runtimes on one shared tree | Conductor's "one workspace" mode: "agents in the same workspace can edit the same files" [8] | **No** | Reject. Possible exception later: read-only lanes (plan mode) |
| **(b) One runtime with native sub-agents** | Claude Agent SDK 0.3.282 (pinned): `agents?: Record<string, AgentDefinition>` with `model`, `tools`, `permissionMode`, `effort`, `background`; the Agent tool takes `isolation: "worktree" \| "remote"`; `canUseTool` receives `agentID`; `task_started` / `task_progress` / `task_notification` events (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:38-110,277-279,5908-5975`; `sdk-tools.d.ts:786`). Claude **agent teams** are experimental and are **not spawned in Agent SDK / `-p` sessions** [9]. Codex sub-agents are on by default, capped by `agents.max_concurrent_threads_per_session`, and "operate in the same working directory" with the parent's sandbox [10]. The pinned protocol (codex 0.160.0 fixtures) has `collabAgentToolCall` (spawnAgent / sendInput / wait / closeAgent / …), `Thread.parentThreadId` and `SubAgentSource.thread_spawn` (`apps/local-runtime/src/codex/generated/v2/*`) | One process owns the tree, but its sub-agents may write in parallel inside it (Codex: same directory). This happens inside the runtime and is invisible to the arbiter | Single provider only, and a lane cannot be addressed directly. **Show sub-agents as nested sub-lanes, read-only** |
| (c) Coordinator agent | T3 Code orchestrator MCP: `delegate_task` creates an app-owned child thread on any provider; a child can only narrow modes; the parent's history is not copied; launches pick `worktree` / `existing_worktree` / `root` [11] | Yes, if every child gets its own worktree | **Later**: a platform tool `work_agent.spawn` exposed through the Control Plane (permissions, audit), never a provider-native team |

## 2. Data model (proposal)

- **New parent `work_session_groups`** (shown as "Session" in the UI). Fields: `id, organization_id, project_id, device_id, title, base_ref, base_sha, created_by, max_agents, status` (status is derived: any lane waiting_approval > running > idle). Existing `work_sessions` gain `group_id` and are shown as "Agent". The migration backfills one group per existing session (1:1), so nothing changes in behaviour. That is the regression guard.
- **Per lane (existing row plus new columns):** `label` (task nickname), `color`, `runtime`, `model`, `permission_mode`, `branch`, `worktree` (always true when the group has more than one lane), `base_sha`, `parent_lane_id` + `origin` (`user` / `fork` / `coordinator`), usage totals. Queue, approvals, presence, stream and `lastLocalSeq` stay per lane, unchanged.
- **Events:** keep `ws:<laneId>` per lane with its own seq. Add a light `wsg:<groupId>` stream (lane added/removed/renamed, status, pending approvals, unread hints) so the strip stays live without subscribing to N full streams. The client subscribes to the group stream, the active lane, and a second lane in split view.
- **Execution-authority invariant:** at most one live lane per `(device, project root checkout)`, enforced by a partial unique index or a row lock in the API plus a `cwd → lane` map in the daemon that rejects a second runtime. Every other lane uses `.ocw-worktrees/<laneId>`. Git itself refuses the same branch in two worktrees [6].
- **Compare and merge (on device, repo-relative paths only):** per-lane diff against `base_sha` (extends the existing GET /diff), lane A ↔ lane B via `git diff ocw/a...ocw/b`, conflict preview with `git merge-tree --write-tree` (does not touch any tree) [12]. Actions: *Apply to base* (squash or merge into `base_ref` only when no lane holds the root checkout), *Open PR* (later), *Discard lane* (removes the worktree). Never auto-merge.
- **Limits and cost:** device `maxConcurrentAgents`, reported in the device hello and capped by org policy. Lanes over the cap stay `queued` (needs a contracts status or reason). Per-lane usage comes from `prompt.completed` usage and is summed per group in the header.

## 3. UI (agent strip)

```text
1440 ┌─ ← Fix login flow · web-app · Víctor's MacBook ────────── (VM)(AL)+2  Share  ⋯ ┐
     │ [✳ Auth refactor ● Opus 5.5] [◎ Tests ◐ gpt-5.x ²] [✳ Docs ! Sonnet] [+ Agent] [⫼ Compare] │
     ├─ stream of the active lane ───────────────────────┬─ Queue · Changes · Diff A↔B ──┤
     │ ▸ sub-agent: "scan auth tests" (nested, read-only)│                               │
     │ composer: model · effort · permission (03.2) · Send│                               │
 390 ┌─ ← Fix login flow                        ⋯ ┐
     │ [◎ Tests ◐ ▾]  3 agents · 1 needs you      │  → tap opens a bottom sheet with every lane
```

- **Tab anatomy:** runtime logo, task label, short model name, status dot (running pulse, amber `!` waiting approval, grey idle, red failed, hollow host offline), unread badge (events after the viewer's last-read seq per lane), branch in the tooltip. Overflow scrolls sideways and adds a "+N" menu. Keys: `Mod+1…9`, `Ctrl+Tab`. This follows Claude Code's agent panel (select a row, Enter to open and message that teammate directly, idle rows collapse into "N idle agents") [9] and the Codex `/agent` switcher and IDE background-agent panel [10].
- **"+ Agent" popover:** runtime + model picker (the 03.2 component), task label, first prompt, base = session base or "fork from lane X", permission mode capped by org policy. A worktree is implied. "Same prompt to several models" works like T3 Shift-click [7] / Cursor best-of-n [5] and opens Compare.
- **Compare (≥1280 px):** two columns, each with its own stream and composer, plus a "Diff A↔B" panel. Below 1280 a segmented A/B toggle replaces it. Mobile has no split view.
- **Composer:** always targets the active lane. Its controls are the 03.2 per-lane menus. Approval banners and notifications name the lane ("Codex · Tests needs approval").
- **390 px:** one pill under the header showing the active lane, lane count and needs-attention count. Tapping it opens a bottom sheet with all lanes (status, model, unread). Approvals from other lanes show as a toast with "Open".

## 4. Requirements, limitations, pending decisions

**Requirements:** Phase 9 one-runtime-per-tree guard; the Phase 10 arbiter, queue and approvals per lane (already per row); the 03.2 capability-driven composer; daemon concurrency cap and worktree setup hook (install deps, copy `.env.example`, never real `.env`); a `wsg:` stream; group-level permissions (inherit the session grains; spawning a lane needs the create-session grain); audit `work_lane.created / applied / discarded`.

**Limitations:**
- **Plan limits are shared.** Claude Pro/Max limits (5-hour session window plus weekly) are shared across Claude and Claude Code [13]. Codex local messages and cloud tasks share a 5-hour window [14]. N lanes on one login use the quota N times faster, so the strip must show usage.
- **Device load (measured on this Mac, 2026-10-05, not a vendor figure):** `claude` ≈ 330 MB RSS and `codex` ≈ 90–190 MB per process. Dev servers, test runners and a dependency install per worktree dominate CPU, RAM and disk.
- **Merge conflicts:** these grow with lanes touching the same files (Claude docs: "Two teammates editing the same file leads to overwrites" [9]). Mitigation: merge-tree preview and file-overlap warnings between lanes.
- **Approval fan-out:** N lanes means N times the prompts. Claude docs flag teammate permission prompts as friction [9]. Approvals stay per lane, with a group "needs you" count.
- **Native sub-agents run inside one tree with no platform arbitration.** Accept them because one runtime holds the authority, and render them read-only.

**Pending decisions (recommended default first):**
1. Max lanes: **4 per session, device cap 4 running, extra lanes queue** / 2 (cheaper) / unlimited (risky on laptops).
2. Lanes talk to each other: **not in v1** / v2 through a platform tool (audited; a message from another agent can never approve anything, as Claude does [9]).
3. Merge: **manual "Apply" (squash into the base branch after a conflict preview) + "Open PR"** / auto-merge (rejected).
4. Root checkout: **when a session has more than one lane, every lane uses a worktree** / the first lane keeps the root.
5. Naming: **UI "Session" ⊃ "Agents", code `work_session_groups` ⊃ `work_sessions`** / rename tables (higher migration risk).
6. Read-only reviewer lane on a sibling's tree (plan mode): **later** / now.
7. Placement: **new phase after Phase 11** (needs Phase 9 guard + Phase 10 core) / an MVP slice right after 03.2 that reuses today's sessions as lanes.

## 5. Confirmed vs needs validation

| Claim | Status |
|---|---|
| SDK `agents`, `AgentDefinition` fields, `isolation: worktree`, `agentID` in `canUseTool`, task events | Confirmed in pinned `.d.ts` 0.3.282 |
| Claude agent teams unavailable in Agent SDK sessions | Confirmed [9] |
| Codex sub-agents share the working dir; concurrency key | Confirmed [10] |
| One `codex app-server` process can host several threads at once | **Needs validation.** The protocol tags every notification with `threadId` (`generated/v2/*Notification.ts`), but the README does not say so [15]. Keep one process per lane |
| Codex `collabAgentToolCall` events reach our adapter at 0.160.0 | Mapped in code; **needs a recorded fixture** |
| T3 `delegate_task` child shares or isolates the parent's worktree | **Needs validation** (doc covers launches, not delegation) [11] |
| RAM per runtime, worktree install cost | **Needs measurement** on a reference laptop with 4 lanes |
| `git merge-tree --write-tree` available on supported hosts (Git ≥ 2.38) | **Needs a preflight check** [12] |

## Sources

[1] https://www.conductor.build/docs/ · [2] https://nimbalyst.com/crystal/ , https://nimbalyst.com/parallel-claude-code-sessions/ · [3] https://github.com/smtg-ai/claude-squad · [4] https://github.com/BloopAI/vibe-kanban · [5] https://cursor.com/docs/configuration/worktrees · [6] https://learn.chatgpt.com/docs/environments/git-worktrees · [7] https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md · [8] https://www.conductor.build/docs/concepts/parallel-agents · [9] https://code.claude.com/docs/en/agent-teams · [10] https://learn.chatgpt.com/docs/agent-configuration/subagents · [11] https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md , .../core-graph-and-data-model.md · [12] https://git-scm.com/docs/git-merge-tree · [13] https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan · [14] https://developers.openai.com/codex/pricing · [15] https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
