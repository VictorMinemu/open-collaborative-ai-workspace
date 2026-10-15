-- Phase 07.8 (07.8-10, SBX-02, D-11 F-7): a file a bot shares from its sandbox (`ocw_sandbox_share`) is stored as a
-- `pending` attachment of the turn's conversation with the bot as uploader, and the reply posted for that turn links
-- it. `event_id` names the turn (`agent_turns.event_id`); null for every upload made by a person. Abandoned shares are
-- swept by the existing attachment sweeper (pending for 24 h). Additive and nullable: no backfill, existing rows keep
-- null. Chained after 20261015141842_bot_sandboxes_browser (P-17: never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP INDEX app.attachments_org_event_idx; ALTER TABLE app.attachments DROP
-- COLUMN event_id.
ALTER TABLE "app"."attachments" ADD COLUMN "event_id" uuid;--> statement-breakpoint
CREATE INDEX "attachments_org_event_idx" ON "app"."attachments" ("organization_id","event_id") WHERE event_id is not null;
