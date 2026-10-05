---
phase: 03-realtime-presence-and-latency
plan: 03
subsystem: web
status: complete
tags: [realtime, presence, rt-04, ui, work-zone, chat]
requires:
  - 03-01 presence tracer (usePresence, PresenceDot, PresenceStack, usePresentPeople, sub.presence opt-in, e2e actors)
provides:
  - Presence dots, present-first ordering and "N here now" in the channel members dialog
  - Work Zone session header viewers stack (desktop and mobile) from `ws:<id>` presence
  - use-live-session subscribes `ws:<id>` with `presence: true`
affects: [03-04, 03-05, 03-06]
tech-stack:
  added: []
  patterns:
    - "Surfaces read presence from the view's own opt-in subscription; the members dialog reads the channel view's `conv:` data, never a background subscription"
key-files:
  created:
    - .planning/phases/03-realtime-presence-and-latency/screenshots/presence-members-{1440,390}{,-dark}.png
    - .planning/phases/03-realtime-presence-and-latency/screenshots/workzone-presence-{1440,390}{,-dark}.png
  modified:
    - apps/web/components/chat/members-dialog.tsx
    - apps/web/components/work-zone/session-view.tsx
    - apps/web/lib/use-live-session.ts
    - e2e/tests/presence.spec.ts
    - e2e/tests/work-zone.spec.ts
decisions:
  - "The session header no longer shows your own avatar: viewers exclude you (plan), and participants who are not watching show dimmed with 'not here'"
  - "Members dialog shows a muted '· Active' / '· Away' label next to the handle and appends it to the row's aria-label, so the state is not colour-only"
  - "'N here now' counts everyone present on the topic except you, matching the channel header stack count"
metrics:
  duration: "~25 min"
  completed: "2026-10-04"
  tasks: 2
  files: 13
actuals:
  tokens: 9000
  tasks: 2
  commits: 3
---

# Phase 3 Plan 03: Presence in the member list and the Work Zone header Summary

The channel members dialog now shows who is here now: a green or amber dot on present members, present people listed first, and "N here now" in the description. The Work Zone session header shows who else is watching the session, on desktop and on mobile, and a viewer who closes the session disappears within 3 s.

## What was built

- **Members dialog** (`members-dialog.tsx`):
  - reads `usePresence("conv:<id>")`, i.e. the channel view's own opt-in subscription;
  - `PresenceDot` on the avatar corner, Away avatars dimmed, muted "· Active / · Away" after the handle;
  - People ordered Active, Away, then the rest (stable sort, so each group keeps its order);
  - rows carry `data-testid="member-presence"`, `data-user-id`, `data-state` (online, away or offline);
  - " · N here now" (`members-here-now`) in the description when N > 0.
  - Bots, the add flow, the profile sheet and the existing test ids are unchanged. `PresenceDot` needed no size variant.
- **Work Zone header** (`session-view.tsx`, `use-live-session.ts`):
  - `useLiveSession` subscribes `ws:<id>` with `{ presence: true }` (the 03-01 deviation requires this).
  - `SessionHeader` renders `PresenceStack` from `usePresentPeople("ws:<id>", { excludeUserId: me, resolve })`. It shows up to 4 avatars, 2 below 640 px, and the label is "N watching now". `resolve` takes the name from participants first, then `/members`, and the avatar from `/members`.
  - From md up, participants (creator and prompt authors) who are not watching follow as dimmed, grayscale avatars with a "Name · not here" tooltip.
  - The stack is visible on mobile and sits before the status chip.

## Screenshots (reviewed with Read)

`.planning/phases/03-realtime-presence-and-latency/screenshots/`:
- `presence-members-1440.png`: dots sit on the bottom-right of the avatars without clipping. Sam (Active) and you (Active) come before Rio (not here, no dot). "3 members · 1 here now." stays on one line.
- `presence-members-1440-dark.png`: the green dot reads clearly against the dark dialog because the ring separates it from the avatar.
- `presence-members-390.png` / `presence-members-390-dark.png`: in the bottom sheet the description wraps after "when you", while "· 1 here now" stays together (nowrap). Rows are 44 px tall (≥ 40 px tap target).
- `workzone-presence-1440.png` / `-dark`: Sam's avatar with its green dot is vertically centred with the "Ready" chip and the actions menu.
- `workzone-presence-390.png` / `-dark`: the stack sits before the Queue/Changes buttons. The title truncates first, and the actions menu stays on-screen (the spec asserts this with a bounding-box check). The dot is readable in dark mode.

## Verification

- `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh presence.spec`: setup + desktop + mobile, **3 passed** (10.4 s / 9.5 s).
- `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh work-zone`: setup + desktop + mobile, **3 passed** (11.9 s / 12.3 s). The existing approval, queue, changes and list assertions are intact.
- `ls screenshots | grep -c "^presence-members-"` → 4; `grep -c "^workzone-presence-"` → 4.
- `pnpm verify`: exit 0, 56 files / 555 tests passed. It was run before each task commit.
- Full `bash scripts/e2e-isolated.sh`: **37 passed** (2.2 min), none flaky or skipped.
- Demo untouched: `localhost:4000/health` 200 and `localhost:3000/login` 200 after the runs. No compose command was run apart from what the isolated script does.
- Acceptance greps all match: `usePresence`, `member-presence` and `here now` in members-dialog.tsx; `usePresentPeople` and `ws:` in session-view.tsx; `member-presence` and `presence-members-` in presence.spec.ts; `workzone-presence-` and `presence-avatar` in work-zone.spec.ts.

## Deviations from Plan

1. **[Instruction from orchestrator] `apps/web/lib/use-live-session.ts` modified (not in `files_modified`).** Since 03-01, presence is opt-in per subscription. Without `{ presence: true }` on the `ws:<id>` subscription the header would never receive presence. Commit 20ed080.
2. **[Rule 2 - test fidelity] Absent member added in presence.spec.** The spec channel had only two people, and both were present, so "listed before people who are not here" could not be proven. A local actor `RIO` (rio@ocw.test, developer) is created through `ensureMember` and added to the channel through the API before Sam joins. The member order (by join time) is therefore admin, Rio, Sam, and present-first must move Sam above Rio. `actors.ts` is unchanged. Commit 4b180d1.
3. **[Rule 2 - a11y] Visible state label.** The dialog adds a muted "· Active / · Away" after the handle and appends it to the row's aria-label, so the state is not conveyed by colour alone. The existing `View <name>'s profile` role-name lookup still matches as a substring (admin-members.spec passes in the full run). Commit 4b180d1.
4. **Behaviour note:** the session header used to show every participant including you. Per the plan, you are now excluded, so a session nobody else is watching or prompting shows no avatars.

### Process notes
- The e2e runs regenerate other specs' screenshots (setup-*, workzone-devices/session/changes-*, and 03-01's presence-header-*) into the phase folder. These were discarded or restored with `git checkout -- <file>`, and only this plan's 8 screenshots were committed.
- The dimmed "not here" participants path has no e2e scenario: Sam never prompts, so no absent participant appears. Its rendering is type-checked, and it only shows at ≥ md.

## Known Stubs

None.

## Threat Flags

None. Names and avatars come from `/members` and the channel member list, which the viewer already reads. Everything is rendered as React text or through the existing avatar components.

## Self-Check: PASSED

- Files exist: members-dialog.tsx, session-view.tsx, use-live-session.ts, presence.spec.ts, work-zone.spec.ts, and 8 screenshots (presence-members-* ×4, workzone-presence-* ×4).
- Commits exist: 4b180d1, 20ed080.
