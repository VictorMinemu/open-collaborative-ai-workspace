---
status: awaiting_human_verify
trigger: "PR #28 (07.1) Woodpecker mobile e2e: module-gating.spec.ts:388 'Bots off' fails at line 480, expectOff(/chat/dm/<botDm>) -> '/chat/dm/<id> never renders dm-view' (dm-view flashed before module-off). Desktop passes; main 579d97d passed."
created: 2026-10-12T00:00:00Z
updated: 2026-10-12T19:30:00Z
---

## Current Focus

bug_class: Heisenbug (timing-dependent, deterministic mechanism once the ordering occurs) -> reproduction under CPU throttle + delayed permissions; SBFL skipped (flaky spectrum)
hypothesis: torn read between DmView (gate) and DmConversation (renderer). DmView passes through to DmConversation while the DM is unknown; DmConversation reads useDms() itself. TanStack v5 useQuery returns getOptimisticResult (current cache state) at render time but notifies subscribers via setTimeout(0) batches. When another query DmConversation observes (agents, attachments config, directory) flushes after /dms has landed in the cache but before the /dms flush reaches DmView, DmConversation re-renders alone, sees the bot DM and renders dm-view; DmView only swaps to the skeleton/off state on its own (later) flush.
test: fix = DmView passes the DM it decided on (and the list status) to DmConversation as props, so the renderer can never see a newer DM than the gate; verify the probe/regression no longer records dm-view
expecting: zero dm-view appearances under cpu x6 + perms delay, both projects; revert brings it back
next_action: human verify: push wt/07.1-ci (or merge into feat/phase-07.1-boards) and confirm the Woodpecker e2e mobile workflow passes module-gating.spec.ts; then archive this session to resolved/ and add the knowledge-base entry

reasoning_checkpoint:
  hypothesis: "DmConversation renders dm-view for a bot DM whose Bots decision is still loading because it reads the DM list itself; TanStack's useQuery returns the cache's current state at render while notifying subscribers in setTimeout(0) batches, so a conversation-only query (agents / attachments config / members) flushing right after /dms lands re-renders DmConversation alone with the bot DM before DmView's own flush re-runs the gate"
  confirming_evidence:
    - "probe timeline: +dm-view at 622 ms, -dm-view at 630 ms, module-off only at 2064 ms when /me/permissions answered: dm-view existed while the decision was `loading` (DmView would have returned DmSkeleton)"
    - "holding /agents,/attachments/config,/members with /dms and answering them together (/dms last) + CPU x4: 10/10 flashes on desktop and mobile; regression test RED 8/8 (4 repeats x 2 projects) with the CI message"
    - "useBaseQuery.js returns observer.getOptimisticResult (current query state); notifyManager.js schedules each batch with setTimeout(0)"
  falsification_test: "after making DmConversation render only the DM DmView decided on (props, no own useDms), the same held burst + CPU x4 must show zero dm-view on every load on both projects; reverting the fix must bring the failure back"
  fix_rationale: "the gate and the renderer then share one snapshot: the conversation can never see a DM (or list status) newer than the decision taken over it, so a child-only re-render can only repeat what the gate already allowed"
  blind_spots: "CI itself cannot be run from here (Woodpecker API needs auth); CI's exact interleaving is inferred from the local reproduction with the identical error message"
  candidate_causes:
    - "code: torn read between DmView (gate) and DmConversation (own useDms) [confirmed]"
    - "environment: CI runner slower (CPU) and /me/permissions slower than /dms on a database filled by earlier specs, which widens the window [contributing trigger, not a cause]"
    - "data: failed or stale /me/permissions turning into `on` (P-08) [eliminated]"
  and_gate: "yes: the flash needs the code defect AND an ordering where /dms lands with a conversation-only read before the gate's flush while permissions are still pending; the environment only supplies the ordering, so the fix targets the code defect, which removes the flash under every ordering"

known_pattern_candidate: none (knowledge base has no matching entry)

## Symptoms

expected: deep link /chat/dm/<botDm> with Bots off for the member shows module-off (data-module=bots) and never renders data-testid=dm-view
actual: module-off eventually appears, but the MutationObserver (watchFlashes) recorded dm-view first
errors: "Error: /chat/dm/<id> never renders dm-view" (module-gating.spec.ts:480, test at :388)
reproduction: Woodpecker e2e mobile project, both attempts; desktop passes; main 579d97d passed; 07.1-14 local isolated run passed both projects
started: PR #28 (feat/phase-07.1-boards, acb47fda)

## Eliminated

- hypothesis: /me/permissions fails in CI (P-08 turns a failure into `on`) and the conversation shows until a refetch succeeds
  evidence: probe reproduces the flash with /me/permissions returning 200 (only delayed); dm-view appeared and vanished while permissions were still pending (status `loading`), so `on` was never reached. Failure path itself (failPermsOnce) did not flash in the probe either.
  timestamp: 2026-10-12
- hypothesis: stale permission data (HTTP cache, server cache, persisted query cache)
  evidence: no query persistence/hydration in apps/web (providers.tsx: plain QueryClient), no service worker, myPermissions has no cache; the flash happens before any permissions response arrives.
  timestamp: 2026-10-12

## Evidence

- timestamp: 2026-10-12
  checked: isolated run, module-gating.spec.ts --project=mobile, unmodified
  found: 6/6 pass locally (bot DM unread check on)
  implication: needs CI-like timing to reproduce

- timestamp: 2026-10-12
  checked: throwaway probe e2e/tests/zz-probe-flash.spec.ts (Bots off member, deep link /chat/dm/<botDm>, MutationObserver timeline + network log), variants baseline, perms+1500, dms+1500, me+1500, cpu x6, cpu x12, cpu x6 perms+1500, cpu x6 dms+1500, failPermsOnce (mobile)
  found: only `cpu x6 perms+1500` flashed: `622 +dm-view | 630 -dm-view | 2064 +module-off`; /dms, /agents, /members, /threads all answered at ~579 ms, /me/permissions at 2062 ms
  implication: dm-view rendered with the bot DM known while bots was still `loading` (DmView would have shown DmSkeleton). DmView's gate and DmConversation disagreed about the DM for one commit.

- timestamp: 2026-10-12
  checked: @tanstack/query-core 5.103.2 notifyManager.js, @tanstack/react-query useBaseQuery.js
  found: useBaseQuery returns observer.getOptimisticResult(options) computed from the query's current cache state at render; subscribers are notified through notifyManager batches scheduled with setTimeout(0), one batch per query dispatch
  implication: a component re-rendered by query A's flush reads query B's new data before B's own flush re-renders B's other subscribers (here: the parent gate)

- timestamp: 2026-10-12
  checked: apps/web/components/chat/dm-view.tsx DmView/DmConversation
  found: DmView gates only when `dm` is known; with /dms pending it renders DmConversation, which calls useDms() on its own and renders dm-view once dm+bot are known (line 437/545). DmConversation also observes useAgents, useAttachmentsConfig, useOrgDirectory that resolve in the same burst.
  implication: the gate decision and the data it is based on live in different components; the child can render a bot DM the parent never gated

- timestamp: 2026-10-12
  checked: other useModule / ModuleGate call sites
  found: ModuleGate never mounts children until `on`; DmView is the only gate that mounts its child while undecided (decision needs the DM list)
  implication: fix is local to dm-view.tsx

- timestamp: 2026-10-12
  checked: probe flash rate per load, permissions delayed + CPU throttle only (n=8..12 loads each)
  found: desktop 0/24 (x6/1500, x4/1000, x8/1000); mobile 2/8, 5/8, 4/8, 1/12 (x2/1000), 5/12 (x4/1000), 3/12 (x4/3000), 1/12 (x6/1000)
  implication: matches CI (mobile only) but too random for a regression test

- timestamp: 2026-10-12
  checked: probe holding the first /dms and the conversation's own reads (/agents, /attachments/config, /members) of each load and answering them together, /dms last, permissions held ~2.5 s (n=10 loads each)
  found: hold agents+dms: desktop 7/10, mobile 2/10; with CPU x4: desktop 10/10, mobile 10/10; hold all three+dms x4: 10/10 on both; hold attachments config+dms: desktop 8/10, mobile 2/10
  implication: confirmed mechanism: a conversation-only query landing in the same burst as /dms re-renders DmConversation alone after /dms is in the cache and before DmView's flush. Not mobile-specific; mobile's natural timing just hits it. Deterministic enough for a regression test.

- timestamp: 2026-10-12
  checked: new e2e "Bots off: a bot DM deep link never shows the conversation while the Bots decision is still loading" (module-gating.spec.ts), unfixed code, --repeat-each=4, both projects
  found: 8/8 failed with "Error: /chat/dm/<id> never renders dm-view" (the CI message)
  implication: deterministic RED regression test

- timestamp: 2026-10-12
  checked: fix applied (1344cdcc), web rebuilt; regression --repeat-each=5 both projects; ordering probe re-run (5 orderings x 10 loads x 2 projects)
  found: regression 10/10 pass; probe 0/100 loads flashed (was 77/100)
  implication: the fix removes the flash under every ordering that produced it

- timestamp: 2026-10-12
  checked: gates on b67b4d7c
  found: pnpm verify exit 0 (lint 0 errors, 4 pre-existing warnings in apps/local-runtime; guard ok; typecheck 8/8; vitest 227 files / 3259 tests); pnpm typecheck --force exit 0 (8/8, 0 cached); isolated e2e module-gating + module-access 19/19 (both projects); adjacent DM specs 37/37 (both projects)
  implication: no regression in the DM, bot and module-access surfaces

## Resolution

root_cause: "DmView (the Bots gate) and DmConversation (the renderer) each read the DM list. TanStack Query v5 useQuery renders the cache's current state but notifies subscribers in setTimeout(0) batches per query, so when a conversation-only read (/agents, /attachments/config, /members) landed right after /dms, DmConversation re-rendered alone with the bot DM and drew dm-view while DmView still held its pre-/dms decision; DmView swapped to the skeleton/off state one flush later. CI's slower runner (and a /me/permissions slower than /dms) produced that order on mobile."
fix: "DmView passes the DM it decided on and the list query state to DmConversation as props; DmConversation no longer calls useDms(). The renderer can only show a DM the gate has already allowed. P-08 untouched (only `off` hides; a failed fetch counts as on)."
oracle_type: implicit-plus-specified (the spec's existing never-flash oracle: a MutationObserver records every render of data-testid=dm-view from the first byte of the navigation)
verification:
  target_test: { result: pass, detail: "module-gating.spec.ts 'Bots off: a bot DM deep link never shows the conversation while the Bots decision is still loading' RED 8/8 (unfixed, --repeat-each=4, both projects) -> GREEN 10/10 (--repeat-each=5, both projects, 3 loads each)" }
  mutation_check: { result: skipped, reason_if_skipped: "no Stryker in the repo", mutant_killed: "manual: the pre-fix code (DmConversation reading useDms itself) is the mutant at the fix site and the regression test kills it 8/8" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, detail: "only the child's own list read is removed; it is replaced by props from the gate, no branch or behaviour removed" }
  adjacent_tests: { result: pass, detail: "isolated e2e both projects: module-gating + module-access 19/19; dms, team-bot-dm, permalinks, personal-bots, bot-memory, bot-limits, bot-capabilities, attachments, chat-day, renderer 37/37; pnpm verify 227 files / 3259 tests; pnpm typecheck --force 8/8 tasks, 0 cached" }
  revert_reconfirm: { result: pass, detail: "same tree without the fix: RED 8/8; with the fix: GREEN 10/10; ordering probe 77/100 flashes before vs 0/100 after (5 orderings x 10 loads x 2 projects)" }
  guardrail_verdict: accepted
files_changed:
  - apps/web/components/chat/dm-view.tsx
  - e2e/tests/module-gating.spec.ts
