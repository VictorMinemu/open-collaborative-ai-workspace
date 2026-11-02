-- Phase 07.6 review A (MD-07): the mention path's inbound lookup (`inboundRooted`: `message_id IN (…) OR
-- board_card_message_id IN (…)`, on every @bot and every run delivery) had an index on `message_id` only, so the OR
-- scanned the organization's `automation_events` (rows are kept; only their content is purged). A partial index on
-- `board_card_message_id` lets PostgreSQL answer it with a BitmapOr of two index scans. No row changes.
-- Chained after 20261030071644_bots_off_automation_backfill (earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP INDEX app.automation_events_board_card_idx;
CREATE INDEX "automation_events_board_card_idx" ON "app"."automation_events" ("board_card_message_id") WHERE board_card_message_id is not null;
