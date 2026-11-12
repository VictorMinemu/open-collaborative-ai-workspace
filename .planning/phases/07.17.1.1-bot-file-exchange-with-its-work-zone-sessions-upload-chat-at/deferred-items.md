# Deferred items: phase 07.17.1.1

Things found during execution that are outside the plan that found them. Not fixed there.

## From 07.17.1.1-14 (browser end to end)

1. **The chat file card's download control is 32 px on phones.** `apps/web/components/chat/attachments/file-card.tsx`
   uses `size-8` for `file-download`, with no `max-md:size-11` like the composer's paperclip and send button. The
   exchange journey taps it on the 390 project, but does not assert 44 px on it, because that would fail on existing
   UI that this plan does not own. Suggested fix: `max-md:size-11` on the link (the card row is 56 px tall, so the row
   does not grow).
2. **The Work Zone Changes panel is not axe-checked.** `changes-panel.tsx` shows its `+N` counts and the `U`/`M`
   letters in `text-success` at 12 px. `--success` is `oklch(0.65 0.17 155)` in light, which works out to about 3.3:1
   on white, below AA's 4.5:1 for small text. This is calculated, not measured. The spec runs axe on the session
   header, which earlier phases already proved, and checks the changes list by content only. A later polish plan
   should darken the token for text use (or use `text-foreground` with a coloured letter), then add axe on
   `[data-testid="changes-panel"]`.
