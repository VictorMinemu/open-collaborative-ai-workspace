-- Phase 07.6 review A (LO-01): the 30-day retention now also clears `automation_events.thread_key`. For a webhook it is
-- the value at the owner's `threadKeyPointer` (often an e-mail address, a customer id or a ticket title), so it is
-- outside content like the subject, sender and bodies. Rows purged before this release get their key cleared first,
-- then `automation_events_purged_check` also requires `thread_key is null` once `content_purged_at` is set. Only
-- purged rows change (`thread_key` → null); a later item can no longer follow up on a purged one.
-- Chained after 20261102205627_automation_events_board_card_idx (earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): restore the previous check (the cleared keys are not restored):
--   ALTER TABLE app.automation_events DROP CONSTRAINT automation_events_purged_check, ADD CONSTRAINT
--   automation_events_purged_check CHECK (content_purged_at is null or (subject is null and sender is null and
--   body_text is null and body_json is null));
UPDATE "app"."automation_events" SET "thread_key" = null WHERE "content_purged_at" is not null AND "thread_key" is not null;--> statement-breakpoint
ALTER TABLE "app"."automation_events" DROP CONSTRAINT "automation_events_purged_check", ADD CONSTRAINT "automation_events_purged_check" CHECK ("content_purged_at" is null or ("subject" is null and "sender" is null and "body_text" is null
        and "body_json" is null and "thread_key" is null));
