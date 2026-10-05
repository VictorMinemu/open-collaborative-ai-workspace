---
schema_version: 1
open_count: 3
waived_count: 0
fixed_count: 0
total_count: 3
last_updated: 2026-10-05T01:53:53.338Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-01: SMOKE_ONLY=mention,dm real-cell smoke not run to PASS: Docker VM out of memory (~1 GB available, swap full); the smoke cell is OOM-killed while booting | open |  | 2026-10-05T01:30:27.229Z |  |
| 2 | 03.1 | stub | apps/api/src/modules/bot-capabilities/turn-policy.ts | 187 | 03.1-03: turn.memory is always [] (planned extension point; 03.1-07 loads the human's DM memories) | open |  | 2026-10-05T01:53:53.261Z |  |
| 3 | 03.1 | stub | apps/api/src/modules/bot-capabilities/turn-policy.ts | 182 | 03.1-03: turnPolicy does not meter turns yet (planned extension point; 03.1-05 adds the atomic daily counter and deliver:false at the limit) | open |  | 2026-10-05T01:53:53.338Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-01: SMOKE_ONLY=mention,dm real-cell smoke not run to PASS: Docker VM out of memory (~1 GB available, swap full); the smoke cell is OOM-killed while booting",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T01:30:27.229Z",
    "resolved_at": null
  },
  {
    "id": 2,
    "kind": "stub",
    "phase": "03.1",
    "file": "apps/api/src/modules/bot-capabilities/turn-policy.ts",
    "line": 187,
    "description": "03.1-03: turn.memory is always [] (planned extension point; 03.1-07 loads the human's DM memories)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T01:53:53.261Z",
    "resolved_at": null
  },
  {
    "id": 3,
    "kind": "stub",
    "phase": "03.1",
    "file": "apps/api/src/modules/bot-capabilities/turn-policy.ts",
    "line": 182,
    "description": "03.1-03: turnPolicy does not meter turns yet (planned extension point; 03.1-05 adds the atomic daily counter and deliver:false at the limit)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T01:53:53.338Z",
    "resolved_at": null
  }
]
````
