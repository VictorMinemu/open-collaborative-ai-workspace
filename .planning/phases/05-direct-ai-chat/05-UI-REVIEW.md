# Phase 5: AI chat screen review (1440 / 390, light / dark)

**Date:** 2026-10-06 · **Reviewer:** Plan 05-14 executor. The owner's final look is the `<human-check>` in 05-14 Task 2.
References: D-08, the 05-14 design direction and P-09.

**Source.** `e2e/tests/ai-chat-visual.spec.ts` walks 17 AI chat screens and states. It captures each one in four
variants: 1440×900 desktop and 390×844 phone (2× DPR), each in light and dark (the `-dark` files). That gives 68 files.
`screenshots/before/review-*.png` was taken on the code merged from 05-13, before any fix. `screenshots/review-*.png`
was taken on the final code. Both sets ran on a fresh isolated stack (`scripts/e2e-isolated.sh --rebuild-web
ai-chat-visual`) and were read one by one. Before every capture the spec checks the layout invariants (soft asserts,
so one broken screen never hides the rest):

- Nothing scrolls sideways.
- The composer lies inside the viewport.
- At 1440 the conversation column is at most 800 px wide (it is 768).
- Every visible button, link, option or switch has an accessible name.
- The icon-only controls resolve by name (Send, Stop writing, Tools, Model, Copy answer, Regenerate, Chat options).
- Pickers and menus are bottom sheets at 390.

The invariants already held on the before set (9/9 passed). The fixes below are visual and copy issues the invariants
cannot see. The Echo answers come from the harness fake: it collapses the prompt's line breaks, so the numbered list and
quote render inline. That is test data, not layout.

**Reference language.** Two references: the Work Zone / T3 Code layout (`03.2-.../reference/ref-4-layout.png`, a
borderless header, a centered ~760 px column, right-aligned user bubbles, full-width answers, and the composer card with
model chip, attach and one round send button), and ChatGPT / Claude.ai (a calm New chat with starters, quiet answer
footers). Verdicts:
- **ok:** matches the references; nothing to change.
- **fixed:** a problem found here and fixed in its owning component, then recaptured.
- **note:** a deliberate choice or a minor point left for the owner.

## Fixes made in this review

| # | Problem | Where it showed | Fix (owning file) |
| --- | --- | --- | --- |
| F1 | New chat was a bare heading over an empty page: no name, no starters. At 390 the heading floated in a large gap above the composer | `new-chat-*` | `AiEmptyState`: "What can I help with, Sam?", the privacy line, and four starters that only fill the composer (`ai-empty-state.tsx`, `ai-chat-view.tsx`, `ai-composer.tsx` `fill()`). At 1440 the composer is centered with pill starters under it. At 390 the composer stays at the bottom and a 2 × 2 grid of 56 px cards sits above it. The first version clipped "Summarize a document" at 390, so the icons are hidden on phones |
| F2 | METERED was a filled amber pill on every organization row, the chip and the settings, which was the loudest thing in the picker | `model-picker-*`, settings | A quiet outlined badge: border and text only, no fill, in both badges (`model-picker.tsx` `MeteredBadge`, `bots/provider-bits.tsx`). Still on every organization model (T-05-14-02) |
| F3 | "Not available yet" on Company knowledge, MCP and Skills was in warning amber, so three rows read as errors | `tools-menu-*`, `chat-settings-*` | Muted text for `not_available_yet`. Amber stays for reasons the member can act on, such as an admin turning a tool off (`tools-menu.tsx`) |
| F4 | Every earlier answer kept its copy button in view, so long chats got noisy | `finished-*`, `stopped-*` | On mouse and trackpad, earlier answers show their actions on hover or keyboard focus with a 150 ms fade (no fade under reduced motion). The latest answer and every touch screen always show them. The usage line never moves (`ai-message.tsx`, `ai-message-list.tsx`, `chat/chat.css`) |
| F5 | The streaming caret was a 12 px block dot that kept pulsing under `prefers-reduced-motion` | `streaming-*` | 10 px with lower contrast, `motion-reduce:animate-none` (`ai-message.tsx`) |
| F6 | On the usage-limit card at 390, "Use an organization model" was a ghost button on its own line and read as plain text | `usage-limit-card-390*` | A link-styled button in the accent colour. "Manage usage" stays the outlined action (`generation-error.tsx`) |
| F7 | The shared snapshot page had no chat sidebar, no rail section was active, and the phone top bar said "Autofy Labs" (05-13 open item) | `share-view-*` | `app/(app)/share/ai/layout.tsx` renders the chat sidebar beside the snapshot. `nav.ts` gains `also: ["/share/ai"]`, so Chat is active and titled on the share page |
| F8 | On `/chat/ai` the bot DMs sat below the member's chats, which page by 30, so a long history hid the bots (05-10 open item) | `ai-chats-list-*` | A quiet row of bot pills (avatar, name, unread dot) above "Your chats". The full Bots list with previews stays below, unchanged (`chat/views/ai-chats-view.tsx`) |
| F9 | In Settings › Models › AI chats, METERED sat alone on its own line under "Organization models per member per day" | `settings-models-ai-chats-*` | The badge now flows inline after the label's last word. It wraps with the text only when the line is full (`admin/ai-chat-policy-settings.tsx`) |
| F10 | Captures picked up whatever the pointer last hovered (the header "…" button looked pressed) | `streaming-1440`, `finished-1440`, `usage-limit-card-1440` | The spec parks the pointer on an empty edge before each 1440 capture (`ai-chat-visual.spec.ts`) |

## Screens

Verdict per variant: 1440 light · 1440 dark · 390 light · 390 dark.

| Screen | Files (`review-…`) | 1440 | 1440 dark | 390 | 390 dark | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| New chat (empty) | `new-chat-{1440,390}[-dark]` | fixed | fixed | fixed | fixed | F1. Model chip, tools and attach sit inside the composer card; "Using ChatGPT plan · Manage usage" under it |
| Streaming | `streaming-…` | fixed | fixed | fixed | fixed | F5. Stop is the one round icon button (Esc stops). The sidebar row shows the "answering" dot |
| Stopped | `stopped-…` | ok | ok | ok | ok | "Stopped" chip under the kept text; Send returns |
| Finished (two exchanges) | `finished-…` | fixed | fixed | ok | ok | F4. Right-aligned bubbles, full-width Markdown, footer `212 in · 32 out · GPT-6 Astra · ChatGPT plan`. Touch keeps every action visible |
| Model picker | `model-picker-…` | fixed | fixed | fixed | fixed | F2. Popover above the chip at 1440, bottom sheet at 390. Groups: plan / organization (METERED legend) / testing |
| Tools menu | `tools-menu-…` | fixed | fixed | fixed | fixed | F3. Web says where it runs ("Runs on your ChatGPT plan") |
| Regenerate menu | `regenerate-menu-…` | ok | ok | ok | ok | Same model / Regenerate with…, popover vs sheet |
| Chat settings | `chat-settings-…` | fixed | fixed | fixed | fixed | F3 in its tools list. Side sheet at 1440, bottom sheet at 390, Save / Cancel pinned. The instructions box takes focus on open |
| Usage-limit dialog | `usage-limit-dialog-…` | ok | ok | ok | ok | Manage usage is primary and focused. Organization model offered with METERED wording; bottom sheet at 390 |
| Usage-limit card | `usage-limit-card-…` | ok | ok | fixed | fixed | F6. Calm bordered card under the kept "Echo: hello" (not a red banner) |
| AI chats list | `ai-chats-list-…` | fixed | fixed | fixed | fixed | F8. Today group, model chips, row menu on hover at 1440 and always visible at 390 |
| Sidebar section / drawer | `sidebar-ai-chats-…` | ok | ok | ok | ok | Five most recent plus See all; on a phone the drawer opens with one tap from the top bar |
| Share dialog | `share-dialog-…` | ok | ok | ok | ok | Audience line, read-only note, highlighted fresh link with Copy, Revoke. Bottom sheet at 390 |
| Shared snapshot | `share-view-…` | fixed | fixed | fixed | fixed | F7. Banner (who and when), bubbles and answers in the same column, Read-only badge, no composer |
| Settings › AI chat | `settings-ai-chat-…` | ok | ok | ok | ok | ChatGPT plan card (Connected, Manage usage, Disconnect), preferences, usage |
| Settings › Models › AI chats | `settings-models-ai-chats-…` | fixed | fixed | fixed | fixed | F2, F9. Sticky Save bar; content scrolls under it |
| Settings › Models › Usage | `settings-models-usage-…` | ok | ok | ok | ok | Summary tiles, table at 1440, stacked rows at 390, the "estimated (~)" footnote |

## Accessibility pass (Task 3)

- **Keyboard.** A fresh New chat opens with the composer focused. Tab moves through tools, attach, model and Send in
  that order, each with a visible focus ring. Enter sends and Shift+Enter breaks a line. Esc stops a running answer.
  After a send, a stop, or closing the model picker or tools menu, focus is back in the composer. Guarded by the spec's
  keyboard test on desktop.
- **Screen readers.** The conversation is `role="log"` with `aria-live="polite"`. The streaming answer is `aria-busy`
  until it ends, so the finished answer is announced once rather than every delta. The caret has no live role of its
  own. Icon-only controls carry labels; the spec checks this on every capture.
- **Motion.** The caret pulse and the footer fade are off under `prefers-reduced-motion: reduce`.

## Notes for the owner

- **The header stays full width,** as in the Work Zone (ref-4 breadcrumb at the pane edge): title at the left, chat menu
  and New chat at the right. Only the column and the composer are centered.
- **Earlier answers keep the space of their hidden actions** on desktop, so the usage line does not jump on hover.
- **The bots appear twice on `/chat/ai`:** the pill row at the top and the full list below it, which shows previews and
  unread state. If you prefer only one, the pill row can show only when the list is long.
- **The Settings › Models METERED badge** still wraps onto the next line together with the label's last words when the
  label fills the line at 390. That is normal text flow.
