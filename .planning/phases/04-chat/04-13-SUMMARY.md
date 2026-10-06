---
phase: 04-chat
plan: 13
subsystem: chat
status: complete
tags: [e2e, playwright, regression, screenshots, adr, docs, validation]
requires:
  - phase: 04-chat
    provides: "Plans 04-01 … 04-12 (edit/delete, renderer, permalinks, storage, reactions/pins/saves, search, DMs, sidebar, notifications, unread, preferences, attachments)"
provides:
  - "Cross-feature chat-day e2e (desktop + mobile) on a fresh isolated stack with its own Garage"
  - "Full regression green on the final branch state (153 e2e passed, 1917 unit/integration/web tests)"
  - "04-UI-REVIEW.md with 116 verdict rows at 1440/390 light/dark"
  - "ADR-0016 (search + renderer); AGENTS.md, DEMO.md, CHAT traceability and 04-VALIDATION sign-off"
affects: [phase-05-ai-chats, phase-07-reverse-proxy, phase-12-artifacts]
tech-stack:
  added: []
  patterns:
    - "Phase-gate spec: one serial two-context scenario that crosses every slice, per-project bots, unique search token"
    - "Base UI dialogs nested in a sheet need forceRender on their backdrop"
key-files:
  created:
    - e2e/tests/chat-day.spec.ts
    - .planning/phases/04-chat/04-UI-REVIEW.md
    - docs/adr/0016-chat-search-and-renderer.md
  modified:
    - apps/web/components/chat/principal-avatar.tsx
    - apps/web/components/chat/composer.tsx
    - apps/web/components/chat/attachments/lightbox.tsx
    - e2e/tests/work-zone-title.spec.ts
    - e2e/tests/search.spec.ts
    - e2e/tests/work-zone.spec.ts
    - AGENTS.md
    - docs/DEMO.md
    - .planning/REQUIREMENTS.md
    - .planning/phases/04-chat/04-VALIDATION.md
    - .planning/phases/04-chat/screenshots/ (Phase 4 captures regenerated)
key-decisions:
  - "Sam is the second member of the chat day (as the plan says); the spec marks his notifications read first so counts start at zero on the shared stack"
  - "The bot in the group DM answers through FakeCellPlugin (the isolated API has no test routes, 04-02)"
  - "Lightbox backdrop uses forceRender: Base UI drops a nested dialog's backdrop and the phone thread is a sheet"
  - "work-zone-title asserts the tab title with an optional unread-count prefix instead of an exact string"
requirements-completed: [CHAT-02, CHAT-04, CHAT-05, CHAT-06, CHAT-07, CHAT-08, CHAT-09, CHAT-10, CHAT-11, CHAT-12, CHAT-13, CHAT-14]
duration: 85min
completed: 2026-10-06
actuals:
  tokens: 24000
  tasks: 3
  commits: 6
---

# Phase 4 Plan 13: Chat phase gate Summary

**Two members spend a whole chat day (group DM with a bot, mention → inbox → jump, thread reply with a pasted image, lightbox, reaction, pin, accent-less search, mark unread on a second tab, live edit) on a fresh isolated stack; the full regression passes on desktop and mobile after three UI fixes and three test-isolation fixes; every Phase 4 screen has a recorded verdict; ADR-0016, AGENTS.md, DEMO.md, the CHAT traceability and the validation contract are signed off.**

## Performance

- **Duration:** about 85 min (05:43 → 07:08)
- **Tasks:** 3/3
- **Files:** 3 created, 10 modified, Phase 4 captures regenerated

## Accomplishments

- `e2e/tests/chat-day.spec.ts` passes on desktop and mobile on a fresh stack (no `--keep-db`): 3 passed, 10 `chat-day-*-390` captures.
- Full regression on the final branch state, all green (see Gate results).
- `04-UI-REVIEW.md`: 26 required screens × 1440/390 × light/dark + the chat-day steps, 116 verdict rows; 3 fixed, 7 follow-ups.
- ADR-0016; AGENTS.md (199 lines, no GSD block touched); DEMO.md Phase 4 section with the `pnpm setup:env --add-missing` + `docker compose up -d garage` upgrade; CHAT-02 and CHAT-04…14 delivered with evidence; 04-VALIDATION `status: validated`.

## Gate results (final branch state)

| Suite | Result |
|---|---|
| `pnpm verify` | lint clean, typecheck 8/8, 139 files / 1917 tests |
| `pnpm typecheck --force` | 8/8 |
| desktop (`env -u ELECTRON_RUN_AS_NODE`, temp `OCW_HOME`) | 10 files / 67 tests |
| `@ocw/local-runtime` | 17 files / 286 tests |
| `@ocw/openclaw-channel` | 15 files / 203 tests |
| `node --test 'infra/**/*.test.mjs' 'scripts/**/*.test.mjs'` | 80 passed (infra alone 76) |
| full isolated e2e `--rebuild-web` (all specs) | 153 passed, 2 skipped by design (desktop-only `attachments-api`, `realtime-latency`), 0 failed, 0 flaky |
| `chat-day` on a fresh stack | 3 passed |

Run history: full run 1 had 3 failures (work-zone-title ×2, search palette mobile), fixed below; full runs 2 and 3 were clean (153/2/0).

Demo baseline, before (05:43) and after (07:06), identical: `/health` → `{"status":"ok",…,"db":"ok","redis":"ok"}`, `/login` → 200, `ocw-demo-openclaw` → `9099607e6f87 Up … (healthy)`.

## Task Commits

1. **Task 1** `2f35f67` test(e2e): a whole chat day for two members across every Phase 4 slice
2. **Task 2** `e51f76a` fix(web): readable group DM avatars, one-line composer placeholder on phones, lightbox backdrop inside the thread sheet
3. **Task 2** `a3ce3e3` test(e2e): full-suite regression fixes on the shared isolated stack
4. **Task 2** `d54b1a3` docs(04-13): Phase 4 screen review with final-state captures (+ work-zone todo moved to done)
5. **Task 3** `23b45c1` docs: ADR-0016, AGENTS.md, DEMO.md, CHAT traceability, validation sign-off

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 1 - Bug] Lightbox opened from a thread on a phone had no backdrop.** Base UI renders no backdrop for a nested dialog, and on phones the thread panel is a sheet, so the viewer was see-through and its white header unreadable. `forceRender` on the backdrop (`chat/attachments/lightbox.tsx`) plus a `lightbox-backdrop` test id; `chat-day.spec` asserts it (RED on mobile without the fix, GREEN with it). Commit e51f76a.
2. **[Rule 1 - UX] Group DM stacked avatars hid the back initial** (70 % each). Now 60 % with a 2 px ring (`chat/principal-avatar.tsx`). Commit e51f76a.
3. **[Rule 1 - UX] Composer placeholder wrapped to two lines on phones** (04-12 open item). `placeholder:truncate` + `overflow-x-hidden text-ellipsis` (`chat/composer.tsx`); Chromium clips instead of ellipsizing while focused. Commit e51f76a.
4. **[Rule 1 - Regression in a test] work-zone-title expected an exact tab title**, but 04-11 prefixes the unread-mentions count (`(2) …`) and Sam had mentions from other specs on the shared stack. Assertions accept the optional prefix. Commit a3ce3e3.
5. **[Rule 1 - Test isolation] search.spec palette People** expected the bot "Sammy Scout" among the 5 people shown for "sam"; with every spec's Sams on one stack it fell off the overview. The bot is now found by "sammy" (the person check still uses "sam"). Commit a3ce3e3.
6. **[Folded todo] work-zone.spec retry idempotency** (2026-10-06 todo): a retry gets its own device name and the archive cleanup has a 15 s bound so revocation runs. Todo moved to done; why archive hung on CI stays open. Commit a3ce3e3 / d54b1a3.
7. **[Spec] Captures.** The chat-day spec waits out the 200 ms lightbox transition and scrolls the unread row into the mark-unread capture (shared stacks push it below the fold).
8. **[Scope] REQUIREMENTS coverage line** ("42 Delivered, 48 Partial…") was already stale before this plan (the table now has 157 rows incl. 10 "Complete"); only the CHAT rows and "Last updated" were changed.

### CLAUDE.md
- No migration and no permission, policy, RLS or audit change. The three product fixes are presentational (web only).
- `.env` was symlinked only for the isolated e2e and removed afterwards; never read. The demo, its ports, the `ocw` DB, `~/.ocw-demo`, OCW.app/daemon and OpenClaw containers were never touched; the only compose lifecycle was the harness's own `ocw-e2e-storage`.
- `wt/04-13` is outside the executor's agent-branch allow-list; I committed there as instructed. STATE.md/ROADMAP.md untouched (orchestrator closes the phase).

## Known Stubs

None.

## Open items (follow-ups from the review)

- Threads view cards show mentions as plain text (no `MentionContext` in `views/`).
- "(edited)" sits on its own line instead of inline.
- Emoji picker: wide glyphs bleed past the last grid column.
- Upload progress mid-flight is not captured (local Garage too fast).
- Sidebar keeps a small scroll offset after the New message dialog returns focus (1440).
- Phone channel header with presence + Pinned + bell leaves little room for the name.
- Manual: owner visual review of `04-UI-REVIEW.md`; signed-build notification click and real dock badge (Pitfall 11).
- CI run of the e2e on the PR (not run here; local isolated runs only).

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/web/components/chat/attachments/lightbox.tsx --description "04-13: lightbox backdrop forceRender (Base UI skips nested dialog backdrops; phone thread is a sheet)"
gsd windows append --kind deviation --phase 04 --file e2e/tests/work-zone-title.spec.ts --description "04-13: tab-title assertions accept the 04-11 unread-count prefix"
gsd windows append --kind deviation --phase 04 --file e2e/tests/search.spec.ts --description "04-13: palette bot found by 'sammy'; 'sam' overflows the 5-person overview on a shared stack"
gsd windows append --kind todo --phase 04 --file apps/web/components/chat/views/threads-view.tsx --description "04-13 review: Threads view cards render @mentions as plain text (no MentionContext)"
gsd windows append --kind todo --phase 04 --file apps/web/components/chat/message-list.tsx --description "04-13 review: (edited) marker on its own line instead of inline"
gsd windows append --kind todo --phase 04 --file e2e/tests/attachments.spec.ts --description "04-13 review: capture upload progress mid-flight with a throttled route"
gsd windows append --kind unrun-verify --phase 04 --file apps/desktop/src/main/index.ts --description "Signed-build notification click-to-focus and dock badge remain manual checks (Pitfall 11)"
```

## Self-Check: PASSED

- FOUND: e2e/tests/chat-day.spec.ts, .planning/phases/04-chat/04-UI-REVIEW.md, docs/adr/0016-chat-search-and-renderer.md
- FOUND commits: 2f35f67, e51f76a, a3ce3e3, d54b1a3, 23b45c1
- `ls .planning/phases/04-chat/screenshots/chat-day-*-390.png | wc -l` → 10; `grep -c "| ok \|| fixed \|| follow-up "` → 116; `status: validated`; AGENTS.md 199 lines; `git diff main -- docs/adr/0003-…` → 0
