# Phase 4 — Screen review (1440 / 390, light / dark)

**Date:** 2026-10-06 · **Reviewer:** Plan 04-13 executor (the owner's final look is the `<human-check>` in 04-13 Task 3)
· D-08, P-09, 04-RESEARCH §Validation Architecture "Screenshots (owner review)".

**Source.** Every file below was regenerated from the final branch state by the phase-gate full isolated run
(`OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh --rebuild-web`, 153 passed, 2 skipped by design, 0 failed)
and the `chat-day` / `attachments` re-runs after the last fix, then read one by one with the Read tool. Sizes:
1440×900 desktop, 390×844 phone (2× DPR); `-dark` = dark theme. Captures come from a stack that every spec shares,
so lists hold many `xxx-mu…` test channels; that is data, not layout.

**Reference language.** Slack (sidebar sections, hover toolbar, thread panel, inbox) and the Work Zone layout
(`apps/web/components/work-zone/session-sidebar.tsx`: one 240 px column, quiet section labels, 14 px rows, a single
accent for state). Verdicts: **ok** (matches, nothing to change), **fixed** (a problem found in this review and fixed
in its owning component, recaptured), **follow-up** (a real but minor issue left for a later plan, with the reason).

## Fixes made in this review

| # | Problem | Where it showed | Fix (owning file) |
| --- | --- | --- | --- |
| F1 | Group DM stacked avatars: at 70 % each, the front avatar covered the back one's initial ("V" cut to a sliver) | `dm-group-*`, `chat-day-group-bot-*`, sidebar DM rows, All view | Both avatars 60 % of the box, front one with a 2 px background ring (`chat/principal-avatar.tsx`) |
| F2 | Composer placeholder wrapped to two lines on phones ("Message #design-muwk…" + a cut second line), growing the box (04-12 open item) | every 390 composer with a long channel / DM name | Placeholder stays on one line with an ellipsis (`placeholder:truncate`, `overflow-x-hidden text-ellipsis`; `chat/composer.tsx`). Chromium drops the ellipsis while the textarea is focused, so a focused composer clips instead; it never wraps |
| F3 | Lightbox opened from a thread on a phone had no backdrop: the thread sheet showed through and the white header was unreadable | `chat-day-lightbox-390` | Base UI skips a nested dialog's backdrop; the thread is a sheet on phones. `forceRender` on the lightbox backdrop (`chat/attachments/lightbox.tsx`), guarded by a `lightbox-backdrop` assertion in `chat-day.spec.ts` (RED on mobile without the fix, GREEN with it) |

## Screens

| Screen | File | Verdict | Notes |
| --- | --- | --- | --- |
| Grouped sidebar | `sidebar-grouped-1440.png` | ok | Organization / Product / Finance sections, "Mobile" team sub-label, muted unjoined rows, More channels |
| Grouped sidebar | `sidebar-grouped-1440-dark.png` | ok | Same; section labels and badges keep contrast |
| Grouped sidebar | `sidebar-grouped-390.png` | ok | Drawer; on the shared stack Organization fills the fold (Product and Finance below, asserted by the spec) |
| Grouped sidebar | `sidebar-grouped-390-dark.png` | ok | Same |
| Views: All | `views-all-1440.png` | fixed | Rows, unit chips, unread dots; group row avatars after F1 |
| Views: All | `views-all-1440-dark.png` | fixed | Same after F1 |
| Views: All | `views-all-390.png` | ok | Full-width rows, previews truncate with an ellipsis |
| Views: All | `views-all-390-dark.png` | ok | Same |
| Views: Mentions (inbox) | `inbox-1440.png` | ok | Actor, kind, conversation, thread tag, chipped snippet, unread dot, Mark all read |
| Views: Mentions (inbox) | `inbox-1440-dark.png` | ok | Same; mention chip amber stays readable |
| Views: Mentions (inbox) | `inbox-390.png` | ok | Mark all read collapses to an icon; snippet wraps cleanly |
| Views: Mentions (inbox) | `inbox-390-dark.png` | ok | Same |
| Views: Threads | `views-threads-1440.png` | follow-up | Cards, new-reply pill, last replies. Root text shows `@sam` as plain text while the channel shows a chip: the cards have no `MentionContext` (cosmetic; one provider in a later chat polish plan) |
| Views: Threads | `views-threads-1440-dark.png` | follow-up | Same as above |
| Views: Threads | `views-threads-390.png` | follow-up | Same as above; layout fits 390 |
| Views: Threads | `views-threads-390-dark.png` | follow-up | Same as above |
| Views: AI Chats | `views-ai-1440.png` | ok | Personal / Team badges, Browse bots |
| Views: AI Chats | `views-ai-1440-dark.png` | ok | Same |
| Views: AI Chats | `views-ai-390.png` | ok | Same; previews truncate |
| Views: AI Chats | `views-ai-390-dark.png` | ok | Same |
| Views: Saved | `saved-view-1440.png` | ok | Card with channel, Remove, Jump (the "Saved for later" toast is the action's confirmation) |
| Views: Saved | `saved-view-1440-dark.png` | ok | Same |
| Views: Saved | `saved-view-390.png` | ok | Same; Remove and Jump are full-size touch targets |
| Views: Saved | `saved-view-390-dark.png` | ok | Same |
| Views: segmented row (phone) | `views-segmented-390.png` | ok | Horizontally scrollable chips, All count badge |
| Views: segmented row (phone) | `views-segmented-390-dark.png` | ok | Same |
| Human DM | `dm-human-1440.png` | follow-up | Header, privacy note, intro. The sidebar keeps a 14 px scroll after the New message dialog returns focus, so the top "All" row sits half under the sticky "Chat" label; cosmetic, fix with the sidebar focus-return in a polish plan |
| Human DM | `dm-human-1440-dark.png` | follow-up | Same as above |
| Human DM | `dm-human-390.png` | fixed | Placeholder on one line after F2 |
| Human DM | `dm-human-390-dark.png` | fixed | Same after F2 |
| Group DM with bot | `dm-group-1440.png` | fixed | F1 stacked avatars; "3 members" shows its focus ring because the members popover just closed (correct focus return) |
| Group DM with bot | `dm-group-1440-dark.png` | fixed | Same after F1 |
| Group DM with bot | `dm-group-390.png` | fixed | F1 and F2 |
| Group DM with bot | `dm-group-390-dark.png` | fixed | F1 and F2 |
| Hover toolbar / touch sheet | `chat-edit-toolbar-1440.png` | ok | Quick reactions, reply, save, edit, more; never covers the author line |
| Hover toolbar / touch sheet | `chat-edit-toolbar-1440-dark.png` | ok | Same |
| Hover toolbar / touch sheet | `chat-edit-toolbar-390.png` | ok | Long-press sheet: preview, quick reactions (first focused), tall rows, destructive last |
| Hover toolbar / touch sheet | `chat-edit-toolbar-390-dark.png` | ok | Same |
| Reactions bar | `reactions-bar-1440.png` | ok | Chip with count, highlighted for the viewer, add-reaction button |
| Reactions bar | `reactions-bar-1440-dark.png` | ok | Same |
| Reactions bar | `reactions-bar-390.png` | ok | Same; no hover toolbar on touch |
| Reactions bar | `reactions-bar-390-dark.png` | ok | Same |
| Emoji picker | `reactions-picker-1440.png` | follow-up | Popover anchored to the toolbar. One wide glyph (🫡) bleeds past the last grid column; frimousse cell width, cosmetic |
| Emoji picker | `reactions-picker-1440-dark.png` | follow-up | Same as above |
| Emoji picker | `reactions-picker-390.png` | follow-up | Bottom sheet, 9 columns; same glyph bleed |
| Emoji picker | `reactions-picker-390-dark.png` | follow-up | Same as above |
| Edited state | `chat-edited-1440.png` | follow-up | Live text and marker. "(edited)" sits on its own line; Slack keeps it inline after the text. Cosmetic, keep for a renderer-aware inline marker |
| Edited state | `chat-edited-1440-dark.png` | follow-up | Same as above |
| Edited state | `chat-edited-390.png` | follow-up | Same as above |
| Edited state | `chat-edited-390-dark.png` | follow-up | Same as above |
| Deleted state | `chat-tombstone-1440.png` | ok | Tombstone with dashed trash avatar, thread summary kept |
| Deleted state | `chat-tombstone-1440-dark.png` | ok | Same |
| Deleted state | `chat-tombstone-390.png` | fixed | Composer on one line after F2 (focused, so clipped, see F2) |
| Deleted state | `chat-tombstone-390-dark.png` | fixed | Same |
| Pinned sheet | `pins-sheet-1440.png` | ok | Side sheet, "Pinned by …", Jump |
| Pinned sheet | `pins-sheet-1440-dark.png` | ok | Same |
| Pinned sheet | `pins-sheet-390.png` | ok | Bottom sheet with handle |
| Pinned sheet | `pins-sheet-390-dark.png` | ok | Same |
| Notification prefs | `settings-notifications-1440.png` | ok | Pop-ups, channel default, DND presets and custom time |
| Notification prefs | `settings-notifications-1440-dark.png` | ok | Same |
| Notification prefs | `settings-notifications-390.png` | ok | Buttons stack; switches keep full-height rows |
| Notification prefs | `settings-notifications-390-dark.png` | ok | Same |
| Notify menu | `notify-menu-1440.png` | ok | Mark read/unread, levels with Default hint, Mute with its consequence |
| Notify menu | `notify-menu-1440-dark.png` | ok | Same |
| Notify menu | `notify-menu-390.png` | ok | Menu fits the viewport, aligned to the bell |
| Notify menu | `notify-menu-390-dark.png` | ok | Same |
| Search palette | `search-palette-1440.png` | ok | Accent-less query, two highlighted terms, keyboard hints |
| Search palette | `search-palette-1440-dark.png` | ok | Same; marks stay legible on dark |
| Search palette | `search-palette-390.png` | ok | Full-screen sheet, Cancel, "See all results" pinned at the bottom |
| Search palette | `search-palette-390-dark.png` | ok | Same |
| Search results | `search-results-1440.png` | ok | In / From chips, count, grouped by channel |
| Search results | `search-results-1440-dark.png` | ok | Same |
| Search results | `search-results-390.png` | ok | Chips wrap onto two rows |
| Search results | `search-results-390-dark.png` | ok | Same |
| Attachment upload (tray) | `attachments-upload-1440.png` | follow-up | Tray thumbnail with remove. The local Garage completes the upload before the capture, so the progress ring itself is not in the image (asserted by `attachments.spec.ts`: `aria-valuenow` 100); capture mid-upload with a throttled route later |
| Attachment upload (tray) | `attachments-upload-1440-dark.png` | follow-up | Same as above |
| Attachment upload (tray) | `attachments-upload-390.png` | follow-up | Same as above |
| Attachment upload (tray) | `attachments-upload-390-dark.png` | follow-up | Same as above |
| Image grid | `attachments-grid-1440.png` | ok | Rendition preview at its aspect ratio, capped width |
| Image grid | `attachments-grid-1440-dark.png` | ok | Same |
| Image grid | `attachments-grid-390.png` | fixed | Full-width preview; composer on one line after F2 |
| Image grid | `attachments-grid-390-dark.png` | fixed | Same |
| File card | `attachments-file-card-1440.png` | ok | PDF icon, name, type and size, download |
| File card | `attachments-file-card-1440-dark.png` | ok | Same |
| File card | `attachments-file-card-390.png` | ok | Card spans the column |
| File card | `attachments-file-card-390-dark.png` | ok | Same |
| Lightbox | `attachments-lightbox-1440.png` | ok | Name, dimensions and size, download, close; dark backdrop |
| Lightbox | `attachments-lightbox-1440-dark.png` | ok | Same |
| Lightbox | `attachments-lightbox-390.png` | ok | Edge-to-edge image, header in the safe area |
| Lightbox | `attachments-lightbox-390-dark.png` | ok | Same |
| Permalink highlight | `permalink-highlight-1440.png` | ok | Steady tint with accent bar, Jump to latest |
| Permalink highlight | `permalink-highlight-1440-dark.png` | ok | Same |
| Permalink highlight | `permalink-highlight-390.png` | ok | Same; the floating pill overlaps one line while scrolling, as Slack's |
| Permalink highlight | `permalink-highlight-390-dark.png` | ok | Same |
| Jump to latest | `permalink-jump-latest-1440.png` | ok | Live end after the jump, the new live message at the bottom |
| Jump to latest | `permalink-jump-latest-1440-dark.png` | ok | Same |
| Jump to latest | `permalink-jump-latest-390.png` | ok | Same |
| Jump to latest | `permalink-jump-latest-390-dark.png` | ok | Same |
| Renderer, code-heavy message | `renderer-chat-1440.png` | ok | Shiki block with language and copy, table with a chip, list, quote, link |
| Renderer, code-heavy message | `renderer-chat-1440-dark.png` | ok | github-dark theme readable |
| Renderer, code-heavy message | `renderer-chat-390.png` | ok | Wide lines scroll inside the block; the table fits |
| Renderer, code-heavy message | `renderer-chat-390-dark.png` | ok | Same |
| Renderer in the Work Zone | `renderer-workzone-1440.png` | ok | Same component in the session stream |
| Renderer in the Work Zone | `renderer-workzone-1440-dark.png` | ok | Same |
| Renderer in the Work Zone | `renderer-workzone-390.png` | ok | Code scrolls horizontally inside the block |
| Renderer in the Work Zone | `renderer-workzone-390-dark.png` | ok | Same |

## The chat day (04-13 Task 1)

| Step | File | Verdict | Notes |
| --- | --- | --- | --- |
| Mention sent | `chat-day-mention-1440.png`, `chat-day-mention-390.png` | ok | `@sam` chip in the author's view |
| Notification | `chat-day-notification-1440.png` (+`-dark`), `chat-day-notification-390.png` (+`-dark`) | ok | Mentions view, count badge, channel mention badge |
| Landed on the message | `chat-day-landed-1440.png`, `chat-day-landed-390.png` | ok | Highlighted root under the New divider |
| Thread reply with a file | `chat-day-thread-file-1440.png` (+`-dark`), `chat-day-thread-file-390.png` (+`-dark`) | ok | Pasted PNG preview in the thread |
| Lightbox from the thread | `chat-day-lightbox-1440.png`, `chat-day-lightbox-390.png` | fixed | F3 |
| Reaction and pin | `chat-day-reaction-pin-1440.png`, `chat-day-reaction-pin-390.png` | ok | 👍 1 on the reply, Pinned label and header count |
| Group DM with the bot | `chat-day-group-bot-1440.png`, `chat-day-group-bot-390.png` | fixed | F1, F2; bot reply at the top level |
| Search | `chat-day-search-1440.png` (+`-dark`), `chat-day-search-390.png` (+`-dark`) | ok | "migracion" finds "migración" |
| Mark unread, second tab | `chat-day-mark-unread-1440.png`, `chat-day-mark-unread-390.png` | ok | Badge back on the other tab |
| Live edit | `chat-day-edited-1440.png`, `chat-day-edited-390.png` | ok | New text and "(edited)" on Sam's page |

## Follow-ups (not fixed in Phase 4)

1. Threads view cards render mentions as plain text (no `MentionContext` in `views/`).
2. "(edited)" on its own line instead of inline after the text.
3. Emoji picker: wide glyphs bleed past the last grid column (frimousse cell width).
4. Upload progress mid-flight is not captured (the local Garage is too fast); add a throttled-route capture.
5. Sidebar keeps a small scroll offset after the New message dialog returns focus at 1440.
6. On phones, a channel header with presence, Pinned and the bell leaves little room for the name (04-10 open
   item); a compact header menu would help.
7. The macOS click-to-focus on a desktop notification and the real dock badge stay manual checks (signed build).
