---
phase: 05-direct-ai-chat
plan: 14
subsystem: web
status: complete
tags: [ai-chat, ui-review, accessibility, keyboard, playwright, d-08, flaky-tests]
requires: ["05-13"]
provides:
  - "e2e/tests/ai-chat-visual.spec.ts: 17 AI chat screens × 1440/390 × light/dark with layout invariants, plus a keyboard/screen-reader test"
  - "AiEmptyState (New chat greeting + four starters) and AiComposerApi.fill()"
  - "05-UI-REVIEW.md with before/ and final review-*.png (68 each)"
affects: [ai-chat, chat-sidebar, shell-nav, work-zone-control-surface, bots-provider-badge]
tech-stack:
  added: []
  patterns:
    - "Soft-asserted layout invariants before every review capture"
    - "ControlSurface finalFocus (desktop popovers only)"
    - "AI chat live-failure tracking anchored on the first snapshot or a send from the page"
key-files:
  created:
    - e2e/tests/ai-chat-visual.spec.ts
    - apps/web/components/ai-chat/ai-empty-state.tsx
    - apps/web/app/(app)/share/ai/layout.tsx
    - .planning/phases/05-direct-ai-chat/05-UI-REVIEW.md
  modified:
    - apps/web/components/ai-chat/{ai-chat-view,ai-composer,ai-message,ai-message-list,model-picker,tools-menu,regenerate-menu,generation-error}.tsx
    - apps/web/components/ai-chat/admin/ai-chat-policy-settings.tsx
    - apps/web/components/chat/views/ai-chats-view.tsx
    - apps/web/components/bots/provider-bits.tsx
    - apps/web/components/shell/nav.ts
    - apps/web/components/work-zone/control-surface.tsx
    - apps/web/lib/ai-chat-queries.ts
    - apps/web/app/(app)/chat/chat.css
    - e2e/tests/{ai-chat-list,ai-chat-stop}.spec.ts
decisions:
  - "The header stays full width (Work Zone ref-4); only the conversation column and the composer are centered"
  - "Earlier answers reveal their actions on hover/focus on pointer devices only; the latest answer and touch keep them visible"
  - "Menus around the composer return focus to it on a desktop; phone sheets return to their trigger so the keyboard never pops up"
  - "The member's bots get a quiet pill row above their chats on /chat/ai; the full Bots list stays below unchanged"
metrics:
  duration: "about 3 h"
  completed: 2026-10-07
actuals:
  tokens: 12000
  tasks: 3
  commits: 8
---

# Phase 5 Plan 14: AI chat polish, review and accessibility pass Summary

**The whole AI chat surface was walked at 1440/390 in light and dark: 17 screens and states, 68 captures before and 68
after, with layout invariants checked on every capture. Ten review findings were fixed, among them a New chat with a
greeting and four starters, quiet METERED badges, the shared snapshot inside the Chat section and the bots above a long
chat list. The chat now works fully from the keyboard and reads quietly to screen readers. Three known intermittent e2e
failures were root-caused and fixed: 79/79 under `--repeat-each=3` on desktop and mobile.**

## What changed

- **Review walk (Task 1):** `ai-chat-visual.spec.ts` walks these screens and states:
  - new chat, streaming, stopped and finished;
  - the model picker, tools and regenerate menus;
  - chat settings;
  - the usage-limit dialog and card;
  - the list, the sidebar or drawer, the share dialog and the shared snapshot;
  - Settings › AI chat and Settings › Models › AI chats and Usage.

  Before each capture it soft-asserts five invariants: nothing scrolls sideways, the composer is in the viewport, the
  column is at most 800 px at 1440, every visible control has a name, and the icon buttons resolve by name. Pickers
  must be sheets at 390. The before set passed every invariant (9/9), so the defects were visual and copy only.
- **Polish (Task 2):** F1–F10 in `05-UI-REVIEW.md`:
  - `AiEmptyState`: "What can I help with, Sam?" and four starters that only fill the composer. At 1440 they are pills
    under the centered composer; at 390 they are a 2 × 2 grid of 56 px cards above the composer at the bottom.
  - METERED is a quiet outlined badge, still on every organization model.
  - "Not available yet" is muted text, not a warning.
  - Earlier answers show their actions on hover or focus.
  - The streaming caret is smaller and does not pulse under reduced motion.
  - On the usage-limit card, the organization model is a link-style button.
  - The shared snapshot sits in the Chat section: chat sidebar, active rail item, "Chat" in the phone top bar. This
    closes the 05-13 open item.
  - `/chat/ai` shows a pill row of bots above the chats. This closes the 05-10 open item.
  - In policy settings, METERED flows inline after the label.
  - The spec parks the pointer before each capture.
- **Keyboard and screen readers (Task 3):**
  - The conversation is `role="log"` with `aria-live="polite"`. A streaming answer is `aria-busy` until it ends, and
    the caret is `aria-hidden`.
  - On a desktop, closing the model picker, tools menu or regenerate menu with Esc returns focus to the composer.
  - Stop and New chat's first send keep focus in the composer.
  - A keyboard test runs on both widths. It covers the starters, Shift+Enter, the Tab order with focus rings, opening
    and closing the menus, sending with Enter, stopping with Esc, `aria-busy` and the caret under reduced motion.

## Stabilised e2e specs

| Spec | Root cause | Fix | Commit |
| --- | --- | --- | --- |
| ai-chat-list rename/archive (`--repeat-each`, mobile) | The list pages by 30, so after repeats the week and older chats fell to page 2. On desktop, the title was clicked while the loading header was still showing (same test id, but not renamable) | `reveal()` presses Load more until the row shows; the spec waits for the chat's title before clicking it | 832549c |
| ai-chat-stop regenerate (mobile) | A fast regenerate could complete before the transient `streaming` check ran | The second question is `[[slow]]`, so streaming always lasts about 4 s and is observable | 832549c |
| ai-chat-plan-errors "dialog opens once" (mobile) | Product bug. A fresh page replays the chat's events before its snapshot, so a failed answer rendered as streaming for a moment and counted as a live failure: the dialog reopened after a reload | A streaming render counts as live only after the snapshot or a send from this page (`useAiChat().live`) | d4aab73 |

Baseline before the fixes (`--repeat-each=3`, three specs, both projects): **6 failed / 68 passed**. The failures were
ai-chat-list ×5 (desktop focus ×2, mobile not-found ×3) and the mobile stop regenerate ×1. After the fixes: **79/79**,
with no flakes.

## Verification

- `ai-chat-visual` (Task 2 verify, `--rebuild-web`, screenshots): 9/9.
- Task 3 verify set (`ai-chat-visual ai-chat.spec ai-chat-models ai-chat-stop ai-chat-tools`, `--rebuild-web`):
  **37/37**, with no skips or flakes.
- Stability (`ai-chat-list ai-chat-stop ai-chat-plan-errors --repeat-each=3`): **79/79**.
- Final regression (`ai-chat chat-sidebar bots.spec personal-bots team-bot-dm work-zone-controls`): **101/101** on
  desktop and mobile. That covers every ai-chat-* spec plus the shared areas touched here. No skips, no flakes.
- `pnpm verify`: lint, typecheck (8/8) and 2305 unit tests in 170 files, all green.
- Acceptance greps: `role="log"` is in `ai-message-list.tsx`, `motion-reduce` is in `ai-message.tsx`, and
  `export function AiEmptyState` exists.

## Commits

1. `14044a0` test(e2e): the review walk and the before captures (Task 1)
2. `d4aab73` fix(web): the reload no longer reopens the usage-limit dialog (plan-errors root cause)
3. `832549c` test(e2e): ai-chat-list and ai-chat-stop no longer depend on earlier chats or timing
4. `7dad1af` feat(web): the review polish, AiEmptyState, `05-UI-REVIEW.md` and the captures (Task 2)
5. `d38d11a` feat(web): the keyboard and screen-reader pass, plus the keyboard test (Task 3)
6. `ffdf78c` docs: the other AI chat spec captures, refreshed after the polish
7. `98e0002` docs: the ai-chat-list repeat-each todo moved to done

## Deviations from Plan

1. **[Scope, requested by the orchestrator] Flaky e2e work.** The plan did not include these fixes; the orchestrator
   asked for them. One was a real product bug: the usage-limit dialog came back after a reload (Rule 1). The fix
   touches `lib/ai-chat-queries.ts`, which is outside the plan's file list.
2. **[Requested open items] Files outside the list.** The share-page layout (`app/(app)/share/ai/layout.tsx`) and
   `shell/nav.ts` (the `also` alias) close the share-page item. `bots/provider-bits.tsx` gets the same quiet METERED
   look as the picker. `admin/ai-chat-policy-settings.tsx` gets the badge flow. `work-zone/control-surface.tsx` gets an
   optional `finalFocus` prop; it defaults to off, so the Work Zone is unchanged. `chat/chat.css` gets the hover
   reveal. None of this changes a route, a test id or a permission.
3. **[Test] The keyboard test runs on both projects, not desktop only.** A skipped mobile test would fail the verify
   rule. On phones, sheets return focus to their trigger instead of the composer, and the test asserts exactly that.
4. **[Test] Review data.** The visual spec creates a team bot "Review Scout" and Sam's DM with it, so the bots row
   is captured. It archives its chats in `afterAll`.

## Known Stubs

None.

## Open notes for the owner

- The header stays full width, as in the Work Zone; only the column and the composer are centered.
- Bots appear twice on `/chat/ai`: the pill row at the top and the full list below it, which shows previews and unread
  state. If you prefer only one, the pill row can show only when the list is long.
- The `<human-check>` remains yours: open `05-UI-REVIEW.md` and the `review-*` captures.

## Windows Ledger

No entries: no stubs, skipped tests, unrun verifies or open deviations.

## Self-Check: PASSED

The key files exist: the spec, `ai-empty-state.tsx`, the share layout, `05-UI-REVIEW.md`, and 68 `review-*.png` plus
68 `before/review-*.png`. All seven commits are on `wt/05-14`.
