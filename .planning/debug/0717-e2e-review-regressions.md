---
status: awaiting_human_verify
trigger: "CI pipeline 255 (head f5ae0f16) e2e: (1) ai-chat-agents / ai-chat-multiplayer-day freshBackend 'create @backend' fails; (2) automation-fan-out.spec.ts:461 run answered but openedSoFar stays 0"
created: 2026-11-10T00:00:00Z
updated: 2026-11-10T15:40:00Z
---

## Current Focus

hypothesis: confirmed for both (see Resolution)
test: CI e2e on the pushed head (desktop + mobile): ai-chat-agents, ai-chat-multiplayer-day, automation-fan-out
expecting: all three green; the fan-out spec may still fail further down (never executed past line 461 on CI)
next_action: owner pushes and runs CI e2e; on a later failure in automation-fan-out, read its error-context in /home/ocw-ci/artifacts/<n>-e2e-<viewport>

reasoning_checkpoint:
  hypothesis: "(1) 4e4511a9 answers 409 username_taken for POST /agents username=backend because the shared e2e org has a Backend team. (2) The fake cell reads the org_secret ERP through /connectors/call, which proxies only per-member/org-account modes, so it gets 409 not_in_turn, replies the refusal on the run card (run answered) and never calls /conversations/open."
  confirming_evidence:
    - "freshBackend posts username 'backend'; ensureUnit('team','Backend') in the same org; isUnitHandle() in agent create/rename (diff 4e4511a9)"
    - "the new WR-04 integration test fails on the 4e4511a9 agent module with 409 username_taken @yard-crew, passes on the restored one"
    - "CI 252 ran 4a7ece52 (pre-review) and already failed fan-out :461 the same way, so no review fix introduced (2)"
    - "integration test: run turn offers <safe>__list_records and ocw_conversation_open; /connectors/call answers 409 not_in_turn for org_secret; /tool-calls allows and taints; open then opens 2"
    - "CI 255 trace: run answered 1.4 s after creation, tainted false, opened 0, consistent with a refused list and no open"
    - "fake unit test reproduces the proxy call path (red) and passes with the in-cell path (green)"
  falsification_test: "(2) if CI still shows opened 0 with a turn whose tools include the ERP list tool, the in-cell path is not the whole cause"
  fix_rationale: "(1) restore pre-07.17 bot create/rename (mention precedence already resolves the clash; escalation keeps the shadow rule). (2) the product is right per ADR-0025/0036 (org_secret renders in the cell); the fake now does what OpenClaw does for such a server"
  blind_spots: "the e2e was not run locally (owner's demo DB); the rest of the fan-out spec after line 461 has never executed on CI; approval policies left by other specs could gate the ERP tool"
  candidate_causes:
    - "code (product): a review fix (CR-01, WR-02, WR-06, WR-07, WR-08) drops the open tool or refuses the open. Eliminated: 252 on 4a7ece52 fails the same way"
    - "test harness (fake cell): wrong channel for an org_secret MCP server. Confirmed"
    - "config/data: the ERP server not ready, or its tool not granted, so the tool is missing from the turn. Eliminated: recordErpTools sets status ready, grantErp grants it, and the int test shows the tool offered"
  and_gate: "no: (1) and (2) are independent; (2) needs only the proxy refusal"

## Symptoms

expected: (1) creating bot @backend succeeds as before; (2) Run now opens 2 conversations (openedSoFar = 2)
actual: (1) "create @backend expected true, received false"; (2) run answered, openedSoFar 0 within 30 s
errors: Playwright assertion failures in e2e (desktop and mobile)
reproduction: CI e2e pipeline 255
started: after the code-review fix commits f85eafc4..f418362d (pre-review head 4a7ece52 passed)

## Eliminated

- hypothesis: a code-review fix (CR-01 history, WR-07 slot, WR-06 HMAC, WR-08 partial PATCH, WR-02 waiting) introduced the fan-out failure
  evidence: CI 252 ran the pre-review head 4a7ece52 and failed automation-fan-out.spec.ts:461 identically on desktop and mobile
  timestamp: 2026-11-10

- hypothesis: the ERP list tool is missing from the run turn (server not ready / not granted / evicted by WR-07)
  evidence: recordErpTools sets status ready; the integration test shows the run turn offers <safe>__list_records with ocw_conversation_open (few tools, no eviction)
  timestamp: 2026-11-10

## Evidence

- timestamp: 2026-11-10
  checked: e2e/tests/ai-chat-agents.spec.ts freshBackend; ai-chat-multiplayer-day.spec.ts ensureUnit("team","Backend")
  found: freshBackend posts username "backend" explicitly; the shared e2e org has a team "Backend" (handle backend); 4e4511a9 added isUnitHandle() -> 409 username_taken on create and rename
  implication: problem (1) root cause confirmed by code

- timestamp: 2026-11-10
  checked: CI artifacts on hetzner-ci (woodpecker-dind /home/ocw-ci/artifacts); origin branch reflog
  found: pipeline 252 (artifacts 13:14/13:24 UTC; 4a7ece52 was pushed 12:19 UTC, next push 13:26 UTC) already failed automation-fan-out.spec.ts:461 on desktop AND mobile with the same "conversations opened expected 2 received 0"; 252 had no ai-chat-* failures; 255 adds ai-chat-agents and ai-chat-multiplayer-day (mobile)
  implication: problem (2) predates the review fixes (pre-review head 4a7ece52 fails too); review-fix hypotheses CR-01/WR-02/WR-06/WR-07/WR-08 cannot be the introducer. Problem (1) is new in 255, consistent with WR-04.

- timestamp: 2026-11-10
  checked: trace.zip of 255 mobile (GET /automations/:id/runs bodies)
  found: run created 14:02:00.013, answered 14:02:01.403, tainted false, opened 0, anchor in the runs thread
  implication: the fake cell replied on the run within 1.4 s without a successful open call

- timestamp: 2026-11-10
  checked: e2e/support/watched.ts registerFakeErp (default: static Authorization header = org_secret); agent-channel/connectors.ts connectorTool (inArray authMode CONNECTOR_PROXY_MODES); contracts connectors.ts (usesConnectorProxy = every mode but org_secret); mcp/service.ts cellMcpServers (org_secret rendered in the cell)
  found: the fake's answerFanOutRun reads the ERP with ocw_connector_call -> /connectors/call, which refuses an org_secret server (not_in_turn); the real cell calls such a server itself after /tool-calls
  implication: the fake harness is wrong, the product is right

- timestamp: 2026-11-10
  checked: new integration test conversations-open.int.test.ts "the e2e scenario's ERP (PD-22)"
  found: run turn tools contain <safe>__list_records and ocw_conversation_open; /connectors/call -> 409 not_in_turn, turn untainted, 0 rows; /tool-calls allowed, turn tainted; open -> 2 opened, outsideContent true
  implication: mechanism reproduced at the API with the e2e inputs

- timestamp: 2026-11-10
  checked: new fake-cell-plugin unit test (in-cell path) before the fake fix
  found: red (the fake sent /connectors/call, typing, messages; no /tool-calls, no ERP call, no open)
  implication: harness bug reproduced; green after the fix

## Resolution

root_cause: (1) 4e4511a9 (WR-04) refused bot usernames equal to a team/department handle (409 username_taken), breaking freshBackend's @backend beside the e2e Backend team; (2) pre-existing since 07.17-18, not a review fix: the e2e fake cell read the org_secret fake ERP through the connector proxy (/connectors/call), which serves only per-member and organization-account modes and answers 409 not_in_turn, so the fake replied the refusal (run answered) and never called ocw_conversation_open
fix: (1) agent/index.ts restored to its pre-WR-04 version (no unit-handle check on create/rename); escalation shadow rule kept; ADR-0039 amendment and 07.17-REVIEW fix log updated. (2) fake cell reads a server GET /cell renders the OpenClaw way (/tool-calls gate, tools/call on the server with rendered headers via the new mcpHostMap, /tool-calls/:id/result); spec sets mcpHostMap
verification: fan-out-config.int.test.ts 14/14 (WR-04 test red on the old module); conversations-open.int.test.ts 23/23; fake-cell-plugin.test.ts 23/23 (new test red before the fake fix); openclaw-channel 727/727; typecheck --force 11/11; lint 0 errors (4 pre-existing warnings in local-runtime). e2e not run locally; needs CI
files_changed: [apps/api/src/modules/agent/index.ts, apps/api/src/modules/automation/fan-out-config.int.test.ts, docs/adr/0039-automation-fan-out-and-team-mentions.md, .planning/phases/07.17-automation-fan-out-and-team-mentions/07.17-REVIEW.md, apps/api/src/modules/agent-channel/conversations-open.int.test.ts, e2e/support/fake-cell-plugin.ts, e2e/support/fake-cell-plugin.test.ts, e2e/tests/automation-fan-out.spec.ts]
oracle_type: specified (HTTP status/username for (1); opened rows and request sequence for (2))
