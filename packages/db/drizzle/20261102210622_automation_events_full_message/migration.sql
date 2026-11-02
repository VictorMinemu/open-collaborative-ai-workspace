-- Phase 07.6 review A (LO-05): the full-text reply the platform posts after an inbound card (`inbound:<event>:full`,
-- up to 16 000 characters of outside text) is outside content too, so it is recorded on its event as
-- `automation_events.full_message_id` (FK to the message, `ON DELETE SET NULL` like `message_id`; partial index for
-- the mention path's lookup). A turn whose history window holds only that reply (the card just outside it) now starts
-- tainted. Events posted before this release get the id of their full-text reply when it exists; nothing else changes.
-- Chained after 20261102205808_automation_events_purge_thread_key (earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): ALTER TABLE app.automation_events DROP COLUMN full_message_id;
ALTER TABLE "app"."automation_events" ADD COLUMN "full_message_id" uuid;--> statement-breakpoint
CREATE INDEX "automation_events_full_message_idx" ON "app"."automation_events" ("full_message_id") WHERE full_message_id is not null;--> statement-breakpoint
ALTER TABLE "app"."automation_events" ADD CONSTRAINT "automation_events_full_message_id_messages_id_fkey" FOREIGN KEY ("full_message_id") REFERENCES "app"."messages"("id") ON DELETE SET NULL;--> statement-breakpoint
UPDATE "app"."automation_events" e SET "full_message_id" = m."id"
FROM "app"."messages" m
WHERE e."message_id" IS NOT NULL
  AND m."organization_id" = e."organization_id"
  AND m."author_kind" = 'agent'
  AND m."client_message_id" = 'inbound:' || e."id"::text || ':full';
