---
phase: quick-261002-fns
plan: 01
status: complete
subsystem: planning
tags: [roadmap, requirements, mvp0, restructure]
requires: []
provides:
  - "Phase 1 = MVP 0 — Multiplayer AI Chat Slice (22 requirements)"
  - "SLICE-01..05 requirements; v1 total 127"
affects: [".planning/ROADMAP.md", ".planning/REQUIREMENTS.md", ".planning/STATE.md", ".planning/PROJECT.md"]
tech-stack:
  added: []
  patterns: []
key-files:
  created: []
  modified:
    - .planning/REQUIREMENTS.md
    - .planning/ROADMAP.md
    - .planning/STATE.md
    - .planning/PROJECT.md
decisions:
  - "Phase 1 restructured into the MVP 0 slice (multiplayer AI chat on docker compose up); Phases 2/3/6 narrowed, FOUND-07 to Phase 7, v1 total 127, numbering 1-12 unchanged"
  - "Debounce tuning for addressed-while-idle responses moved to the Phase 1 research note (follows MULTI-04)"
metrics:
  duration: "~5 min"
  completed: 2026-10-02
actuals:
  tokens: 4200
  tasks: 3
  commits: 3
---

# Quick 261002-fns: Roadmap restructure, Phase 1 becomes MVP 0 — Summary

Phase 1 is now "MVP 0 — Multiplayer AI Chat Slice" (22 requirements including the new SLICE-01..05). Phases 2, 3 and 6 were narrowed, FOUND-07 moved to Phase 7 and the v1 total went from 122 to 127. Phase numbering 1–12 is unchanged and every requirement is still Pending.

## Per-phase requirement counts

| Phase | Requirements | Count |
|-------|--------------|-------|
| 1 MVP 0 — Multiplayer AI Chat Slice | FOUND-01..06, SLICE-01..05, AUTH-01..03, ORG-05, RT-01/02/05, MULTI-02/03/04/08 | 22 |
| 2 Identity and Organization | AUTH-04..06, ORG-01..04, ORG-06 | 8 |
| 3 Realtime Presence and Latency | RT-03, RT-04 | 2 |
| 4 Chat | CHAT-01..14 | 14 |
| 5 Direct AI Chat | AICHAT-01..09 | 9 |
| 6 Sharing, Shared-Context Safety and Agents in Conversations | MULTI-01/05/06/07, AGENT-01..04 | 8 |
| 7 Self-hosted Release | SELF-01..07, FOUND-07 | 8 |
| 8 | DEV-01..07 | 7 |
| 9 | RUNTIME-01..10, DESK-01..05 | 15 |
| 10 | WZ-01..16 | 16 |
| 11 | WZUI-01..10, DESK-06/07 | 12 |
| 12 | ART-01..06 | 6 |
| **Total** | | **127** |

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1 REQUIREMENTS.md: SLICE section and remapped traceability | 799718b | .planning/REQUIREMENTS.md |
| 2 ROADMAP.md: MVP 0 Phase 1, narrowed 2/3/6, FOUND-07 in 7, coverage 127 | e65db5d | .planning/ROADMAP.md |
| 3 STATE.md and PROJECT.md: MVP 0 focus and decision | 5f2bda9 | .planning/STATE.md, .planning/PROJECT.md |

## Cross-reference fixes (Phases 8–12)

These two edits are the only changes inside Phases 8–12:
- Phase 8 **Depends on** now reads "builds on Phase 2 permissions and Phase 1 streams" (was Phase 3 streams).
- Phase 10 **Research** now reads "reuses the Phase 1 arbiter shape" (was Phase 6).

## Deviations from Plan

- **Orchestrator amendment, applied as instructed:** the Phase 1 **Research:** note in ROADMAP.md also lists "debounce tuning for addressed-while-idle responses", because it moved from Phase 6 to Phase 1 along with MULTI-04. The Phase 6 Research note follows the plan text, which already drops debounce tuning.

Otherwise the plan was executed as written.

## Verification

- Task 1 gate: `TASK1_OK`
- Task 2 gate: `TASK2_OK`
- Task 3 gate: `TASK3_OK`
- `git diff --quiet HEAD~3 -- AGENTS.md CLAUDE.md`: no changes to AGENTS.md or CLAUDE.md
- Files changed across the 3 commits: only PROJECT.md, REQUIREMENTS.md, ROADMAP.md and STATE.md
- `grep -cE '^\| [A-Z]+-[0-9]+ \| Phase [0-9]+ \| Pending \|$' .planning/REQUIREMENTS.md` → 127 (nothing marked complete)
- The ROADMAP diff for Phases 8–12 contains only the two cross-reference lines above
- Post-commit deletion check: no deletions

## Notes

- `requirements.mark-complete` was not run, on purpose: the plan's `requirements: []` is empty and all v1 IDs stay Pending.
- I left the ROADMAP "MVP 1 boundary" paragraph ("Phases 1–7 complete MVP 1") unchanged because it is still correct: MVP 1 is built on top of MVP 0.

## Self-Check: PASSED

- FOUND: .planning/REQUIREMENTS.md, .planning/ROADMAP.md, .planning/STATE.md, .planning/PROJECT.md
- FOUND commits: 799718b, e65db5d, 5f2bda9
