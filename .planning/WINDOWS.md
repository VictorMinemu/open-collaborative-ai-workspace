---
schema_version: 1
open_count: 6
waived_count: 0
fixed_count: 10
total_count: 16
last_updated: 2026-10-05T21:04:47.745Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-01: SMOKE_ONLY=mention,dm real-cell smoke not run to PASS: Docker VM out of memory (~1 GB available, swap full); the smoke cell is OOM-killed while booting | fixed |  | 2026-10-05T01:30:27.229Z | 2026-10-05T04:30:11.095Z |
| 2 | 03.1 | stub | apps/api/src/modules/bot-capabilities/turn-policy.ts | 187 | 03.1-03: turn.memory is always [] (planned extension point; 03.1-07 loads the human's DM memories) | fixed |  | 2026-10-05T01:53:53.261Z | 2026-10-05T03:34:12.241Z |
| 3 | 03.1 | stub | apps/api/src/modules/bot-capabilities/turn-policy.ts | 182 | 03.1-03: turnPolicy does not meter turns yet (planned extension point; 03.1-05 adds the atomic daily counter and deliver:false at the limit) | fixed |  | 2026-10-05T01:53:53.338Z | 2026-10-05T02:53:21.482Z |
| 4 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-04: SMOKE_ONLY=mention,dm,capabilities real-cell smoke not run to PASS locally: smoke cell OOM-killed during boot under the mandated --memory 1g cap (Docker VM ~0.9 GB available, swap full). Proven instead by the new CI cell-smoke job (offline, GitHub runner) | fixed |  | 2026-10-05T02:39:58.104Z | 2026-10-05T04:30:11.165Z |
| 5 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-04: SMOKE_ONLY=dm-isolation,capabilities real-cell smoke not run locally (same VM OOM under the 1 GB cap); transcript purge implemented defensively (reconciler + port, unit-tested) but OpenClaw's own behaviour on roster removal is unobserved until the CI cell-smoke job runs | fixed |  | 2026-10-05T02:45:08.390Z | 2026-10-05T04:30:11.235Z |
| 6 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-07: SMOKE_ONLY=memory,capabilities real-cell smoke not run locally (Docker VM cannot boot a smoke cell next to the demo; orchestrator rule). Scenario memory runs in the CI cell-smoke job; locally proven by plugin unit/contract tests and the fixture mapped through the built plugin | fixed |  | 2026-10-05T03:34:12.311Z | 2026-10-05T04:30:11.306Z |
| 7 | 03.1 | stub | apps/api/src/modules/agent-channel/index.ts |  | 03.1-11: /cell plugins is [] until 03.1-12 wires the approved list | fixed |  | 2026-10-05T04:53:52.880Z | 2026-10-05T06:50:12.949Z |
| 8 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-10: SMOKE_ONLY=mcp real-cell smoke not run locally (no OpenClaw container on the dev VM); proven by plugin/registry-model/integration tests; CI cell-smoke must show the mcp scenario lines listed in 03.1-10-SUMMARY | fixed |  | 2026-10-05T05:29:32.197Z | 2026-10-05T05:49:08.348Z |
| 9 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-12: SMOKE_ONLY=marketplace real-cell smoke not run locally (no OpenClaw container on the dev VM); proven by host CLI end-to-end, plugin/contract/integration tests; CI cell-smoke must show the marketplace lines listed in 03.1-12-SUMMARY | fixed |  | 2026-10-05T06:50:13.022Z | 2026-10-05T13:57:42.773Z |
| 10 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-14: SMOKE_ONLY=sandbox real-cell smoke not run locally (no OpenClaw container and <1 GB free on the dev VM); bridge proven by 21 node tests and a real hardened container with server-everything; CI cell-smoke must show the sandbox lines listed in 03.1-14-SUMMARY | fixed |  | 2026-10-05T13:58:55.002Z | 2026-10-05T14:54:04.675Z |
| 11 | 03.2 | stub | apps/api/src/modules/work-session/routes.ts |  | controlsContext uses DEFAULT_WORK_ZONE_POLICY and owner-only grain until Plan 04/05 | open |  | 2026-10-05T20:36:46.216Z |  |
| 12 | 03.2 | stub | apps/local-runtime/src/daemon.ts |  | hello/capabilities fullAccessOptIn hard-coded false until Plan 06 | open |  | 2026-10-05T20:36:46.287Z |  |
| 13 | 03.2 | stub | apps/api/src/modules/work-session/service.ts |  | dispatched turn mode = session mode; per-author cap (P-07) lands in Plan 04 | open |  | 2026-10-05T20:36:46.358Z |  |
| 14 | 03.2 | stub | packages/contracts/src/device.ts |  | Device.viewerMaxMode/grants and UpdateDeviceRequest.shareMaxMode not wired until Plan 05 | open |  | 2026-10-05T20:36:46.430Z |  |
| 15 | 03.2 | deviation | apps/local-runtime/src/codex/codex-runtime.ts |  | /compact completes via turn/completed (compaction is a non-steerable turn at 0.160.0); not fixtured | open |  | 2026-10-05T21:04:47.656Z |  |
| 16 | 03.2 | unrun-verify | packages/contracts/src/runtime-controls/codex.ts |  | Codex Auto (approvalsReviewer auto_review) exposed but its review behaviour is not fixtured | open |  | 2026-10-05T21:04:47.745Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-01: SMOKE_ONLY=mention,dm real-cell smoke not run to PASS: Docker VM out of memory (~1 GB available, swap full); the smoke cell is OOM-killed while booting",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T01:30:27.229Z",
    "resolved_at": "2026-10-05T04:30:11.095Z"
  },
  {
    "id": 2,
    "kind": "stub",
    "phase": "03.1",
    "file": "apps/api/src/modules/bot-capabilities/turn-policy.ts",
    "line": 187,
    "description": "03.1-03: turn.memory is always [] (planned extension point; 03.1-07 loads the human's DM memories)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T01:53:53.261Z",
    "resolved_at": "2026-10-05T03:34:12.241Z"
  },
  {
    "id": 3,
    "kind": "stub",
    "phase": "03.1",
    "file": "apps/api/src/modules/bot-capabilities/turn-policy.ts",
    "line": 182,
    "description": "03.1-03: turnPolicy does not meter turns yet (planned extension point; 03.1-05 adds the atomic daily counter and deliver:false at the limit)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T01:53:53.338Z",
    "resolved_at": "2026-10-05T02:53:21.482Z"
  },
  {
    "id": 4,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-04: SMOKE_ONLY=mention,dm,capabilities real-cell smoke not run to PASS locally: smoke cell OOM-killed during boot under the mandated --memory 1g cap (Docker VM ~0.9 GB available, swap full). Proven instead by the new CI cell-smoke job (offline, GitHub runner)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T02:39:58.104Z",
    "resolved_at": "2026-10-05T04:30:11.165Z"
  },
  {
    "id": 5,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-04: SMOKE_ONLY=dm-isolation,capabilities real-cell smoke not run locally (same VM OOM under the 1 GB cap); transcript purge implemented defensively (reconciler + port, unit-tested) but OpenClaw's own behaviour on roster removal is unobserved until the CI cell-smoke job runs",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T02:45:08.390Z",
    "resolved_at": "2026-10-05T04:30:11.235Z"
  },
  {
    "id": 6,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-07: SMOKE_ONLY=memory,capabilities real-cell smoke not run locally (Docker VM cannot boot a smoke cell next to the demo; orchestrator rule). Scenario memory runs in the CI cell-smoke job; locally proven by plugin unit/contract tests and the fixture mapped through the built plugin",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T03:34:12.311Z",
    "resolved_at": "2026-10-05T04:30:11.306Z"
  },
  {
    "id": 7,
    "kind": "stub",
    "phase": "03.1",
    "file": "apps/api/src/modules/agent-channel/index.ts",
    "line": null,
    "description": "03.1-11: /cell plugins is [] until 03.1-12 wires the approved list",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T04:53:52.880Z",
    "resolved_at": "2026-10-05T06:50:12.949Z"
  },
  {
    "id": 8,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-10: SMOKE_ONLY=mcp real-cell smoke not run locally (no OpenClaw container on the dev VM); proven by plugin/registry-model/integration tests; CI cell-smoke must show the mcp scenario lines listed in 03.1-10-SUMMARY",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T05:29:32.197Z",
    "resolved_at": "2026-10-05T05:49:08.348Z"
  },
  {
    "id": 9,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-12: SMOKE_ONLY=marketplace real-cell smoke not run locally (no OpenClaw container on the dev VM); proven by host CLI end-to-end, plugin/contract/integration tests; CI cell-smoke must show the marketplace lines listed in 03.1-12-SUMMARY",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T06:50:13.022Z",
    "resolved_at": "2026-10-05T13:57:42.773Z"
  },
  {
    "id": 10,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-14: SMOKE_ONLY=sandbox real-cell smoke not run locally (no OpenClaw container and <1 GB free on the dev VM); bridge proven by 21 node tests and a real hardened container with server-everything; CI cell-smoke must show the sandbox lines listed in 03.1-14-SUMMARY",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T13:58:55.002Z",
    "resolved_at": "2026-10-05T14:54:04.675Z"
  },
  {
    "id": 11,
    "kind": "stub",
    "phase": "03.2",
    "file": "apps/api/src/modules/work-session/routes.ts",
    "line": null,
    "description": "controlsContext uses DEFAULT_WORK_ZONE_POLICY and owner-only grain until Plan 04/05",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T20:36:46.216Z",
    "resolved_at": null
  },
  {
    "id": 12,
    "kind": "stub",
    "phase": "03.2",
    "file": "apps/local-runtime/src/daemon.ts",
    "line": null,
    "description": "hello/capabilities fullAccessOptIn hard-coded false until Plan 06",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T20:36:46.287Z",
    "resolved_at": null
  },
  {
    "id": 13,
    "kind": "stub",
    "phase": "03.2",
    "file": "apps/api/src/modules/work-session/service.ts",
    "line": null,
    "description": "dispatched turn mode = session mode; per-author cap (P-07) lands in Plan 04",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T20:36:46.358Z",
    "resolved_at": null
  },
  {
    "id": 14,
    "kind": "stub",
    "phase": "03.2",
    "file": "packages/contracts/src/device.ts",
    "line": null,
    "description": "Device.viewerMaxMode/grants and UpdateDeviceRequest.shareMaxMode not wired until Plan 05",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T20:36:46.430Z",
    "resolved_at": null
  },
  {
    "id": 15,
    "kind": "deviation",
    "phase": "03.2",
    "file": "apps/local-runtime/src/codex/codex-runtime.ts",
    "line": null,
    "description": "/compact completes via turn/completed (compaction is a non-steerable turn at 0.160.0); not fixtured",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T21:04:47.656Z",
    "resolved_at": null
  },
  {
    "id": 16,
    "kind": "unrun-verify",
    "phase": "03.2",
    "file": "packages/contracts/src/runtime-controls/codex.ts",
    "line": null,
    "description": "Codex Auto (approvalsReviewer auto_review) exposed but its review behaviour is not fixtured",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T21:04:47.745Z",
    "resolved_at": null
  }
]
````
