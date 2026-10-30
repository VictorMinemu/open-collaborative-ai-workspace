-- Phase 07.6 (D-01, D-02, D-04, D-05, D-06, D-07, D-10; UI-SPEC R1, R2, R4; ADR-0028): automations and watched
-- records. Creates `automations` (standing orders: bot, instructions, trigger, target by stable ids, run-as person =
-- creator by `automations_run_as_creator_check`, budget, breaker; one digest per person), `automation_runs` (unique per
-- scheduled instant and per inbound item), `automation_drafts` (the stored action of an `automation.create` approval),
-- `webhook_endpoints` (global `public_id`, sealed `webhook_secret` ids, tombstone), `mailboxes` (IMAP cursor, keychain
-- item), `automation_events` (inbound items, exactly one source, unique per source by external id, capped untrusted
-- text), `watched_records` / `watched_record_changes` (D-04; the changes are append-only for the app role in
-- post-migrate), `work_session_memory` (a session's memory summary state; its unit comes from 07.9's
-- `work_project_repos`, which this migration does not touch, D-10) and `work_memory_prefs`. Adds the automation caps
-- to `bot_policies`, `status_label` / `notices` to `message_cards`, the `webhook_secret` secret kind, and the usage
-- kinds `digest` / `session_summary` to `ai_usage_records` (those carry `subject_id` and no generation or
-- conversation; `chat` / `title` keep both, by the same check). Adds `(organization_id, id)` keys to `mcp_servers` and
-- `vault_items` and `(message_id, conversation_id)` to `board_cards` as composite FK targets. Tenant isolation comes
-- from post-migrate (every `app` table with `organization_id`), with the ids-only SECURITY DEFINER functions the job
-- ticks and the public webhook route use. Every composite `SET NULL` is narrowed to its own column (PostgreSQL 15+;
-- drizzle has no builder), so `organization_id` is never nulled. No existing row changes value.
-- Chained after 20261028214642_runtime_updates (earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.watched_record_changes, app.watched_records,
-- app.automation_runs, app.automation_events, app.mailboxes, app.webhook_endpoints, app.automation_drafts,
-- app.automations, app.work_session_memory, app.work_memory_prefs; delete `digest` / `session_summary` usage rows and
-- `webhook_secret` secrets, restore both kind checks and the two NOT NULLs; drop the added columns and constraints.
CREATE TABLE "app"."automation_drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_as_user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instructions" text NOT NULL,
	"schedule_cron" text NOT NULL,
	"time_zone" text NOT NULL,
	"target_kind" text NOT NULL,
	"conversation_id" uuid,
	"thread_root_message_id" uuid,
	"max_runs_per_day" integer DEFAULT 24 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"automation_id" uuid,
	"edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_drafts_name_len_check" CHECK (char_length("name") between 1 and 120),
	CONSTRAINT "automation_drafts_instructions_len_check" CHECK (char_length("instructions") between 1 and 4000),
	CONSTRAINT "automation_drafts_schedule_len_check" CHECK (char_length("schedule_cron") between 9 and 120 and char_length("time_zone") between 1 and 64),
	CONSTRAINT "automation_drafts_target_check" CHECK (("target_kind" = 'dm' and "conversation_id" is null and "thread_root_message_id" is null)
        or ("target_kind" = 'channel' and "conversation_id" is not null and "thread_root_message_id" is null)
        or ("target_kind" = 'thread' and "conversation_id" is not null and "thread_root_message_id" is not null)),
	CONSTRAINT "automation_drafts_max_runs_per_day_check" CHECK ("max_runs_per_day" between 1 and 288),
	CONSTRAINT "automation_drafts_status_check" CHECK ("status" in ('pending','applied','discarded','expired'))
);
--> statement-breakpoint
CREATE TABLE "app"."automation_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"source" text NOT NULL,
	"webhook_endpoint_id" uuid,
	"mailbox_id" uuid,
	"external_id" text NOT NULL,
	"thread_key" text,
	"subject" text,
	"sender" text,
	"body_text" text,
	"body_json" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text NOT NULL,
	"reason" text,
	"message_id" uuid,
	"board_card_message_id" uuid,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"last_duplicate_at" timestamp with time zone,
	"content_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_events_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "automation_events_webhook_external_uq" UNIQUE("webhook_endpoint_id","external_id"),
	CONSTRAINT "automation_events_mailbox_external_uq" UNIQUE("mailbox_id","external_id"),
	CONSTRAINT "automation_events_source_check" CHECK (("source" = 'webhook' and "webhook_endpoint_id" is not null and "mailbox_id" is null)
        or ("source" = 'mail' and "mailbox_id" is not null and "webhook_endpoint_id" is null)),
	CONSTRAINT "automation_events_external_id_len_check" CHECK (char_length("external_id") between 1 and 998),
	CONSTRAINT "automation_events_thread_key_len_check" CHECK ("thread_key" is null or char_length("thread_key") <= 998),
	CONSTRAINT "automation_events_subject_len_check" CHECK ("subject" is null or char_length("subject") <= 500),
	CONSTRAINT "automation_events_sender_len_check" CHECK ("sender" is null or char_length("sender") <= 320),
	CONSTRAINT "automation_events_body_text_len_check" CHECK ("body_text" is null or char_length("body_text") <= 32768),
	CONSTRAINT "automation_events_body_json_size_check" CHECK ("body_json" is null or octet_length("body_json"::text) <= 131072),
	CONSTRAINT "automation_events_result_check" CHECK ("result" in ('accepted','not_run')),
	CONSTRAINT "automation_events_reason_len_check" CHECK ("reason" is null or char_length("reason") <= 64),
	CONSTRAINT "automation_events_duplicate_count_check" CHECK ("duplicate_count" >= 0),
	CONSTRAINT "automation_events_purged_check" CHECK ("content_purged_at" is null or ("subject" is null and "sender" is null and "body_text" is null
        and "body_json" is null))
);
--> statement-breakpoint
CREATE TABLE "app"."automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"inbound_event_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"anchor_message_id" uuid,
	"board_card_message_id" uuid,
	"agent_event_id" uuid,
	"tainted" boolean DEFAULT false NOT NULL,
	"delivered_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_trigger_check" CHECK ("trigger" in ('schedule','webhook','mail','manual')),
	CONSTRAINT "automation_runs_status_check" CHECK ("status" in ('queued','delivered','answered','skipped','failed','no_reply')),
	CONSTRAINT "automation_runs_scheduled_check" CHECK (("trigger" = 'schedule') = ("scheduled_for" is not null)),
	CONSTRAINT "automation_runs_inbound_check" CHECK ("inbound_event_id" is null or "trigger" in ('webhook','mail')),
	CONSTRAINT "automation_runs_reason_len_check" CHECK ("reason" is null or char_length("reason") <= 64)
);
--> statement-breakpoint
CREATE TABLE "app"."automations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_as_user_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"action_kind" text DEFAULT 'agent_turn' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"trigger_kind" text NOT NULL,
	"schedule_cron" text,
	"time_zone" text,
	"target_kind" text NOT NULL,
	"conversation_id" uuid,
	"thread_root_message_id" uuid,
	"board_column_id" uuid,
	"inbound_action" text,
	"inbound_ask_bot" boolean DEFAULT true NOT NULL,
	"inbound_config" jsonb DEFAULT '{}' NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"max_runs_per_day" integer DEFAULT 24 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_by" uuid,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "automations_run_as_creator_check" CHECK ("run_as_user_id" = "created_by"),
	CONSTRAINT "automations_name_len_check" CHECK (char_length("name") between 1 and 120),
	CONSTRAINT "automations_instructions_len_check" CHECK (char_length("instructions") <= 4000),
	CONSTRAINT "automations_action_kind_check" CHECK ("action_kind" in ('agent_turn','digest')),
	CONSTRAINT "automations_trigger_kind_check" CHECK ("trigger_kind" in ('schedule','webhook','mail')),
	CONSTRAINT "automations_target_kind_check" CHECK ("target_kind" in ('channel','thread','dm','board')),
	CONSTRAINT "automations_status_check" CHECK ("status" in ('active','paused','needs_attention')),
	CONSTRAINT "automations_schedule_check" CHECK (("trigger_kind" = 'schedule' and "schedule_cron" is not null and "time_zone" is not null
          and char_length("schedule_cron") between 9 and 120 and char_length("time_zone") between 1 and 64)
        or ("trigger_kind" <> 'schedule' and "schedule_cron" is null and "time_zone" is null)),
	CONSTRAINT "automations_target_check" CHECK (("target_kind" = 'dm' and "conversation_id" is null and "thread_root_message_id" is null
          and "board_column_id" is null)
        or ("target_kind" = 'channel' and "conversation_id" is not null and "thread_root_message_id" is null
          and "board_column_id" is null)
        or ("target_kind" = 'thread' and "conversation_id" is not null and "thread_root_message_id" is not null
          and "board_column_id" is null)
        or ("target_kind" = 'board' and "conversation_id" is not null and "board_column_id" is not null
          and "thread_root_message_id" is null)),
	CONSTRAINT "automations_inbound_check" CHECK (("inbound_action" is not null) = ("trigger_kind" in ('webhook','mail'))
        and ("inbound_action" is null or "inbound_action" in ('post','board_card'))
        and ("inbound_action" is distinct from 'board_card' or "target_kind" = 'board')),
	CONSTRAINT "automations_digest_check" CHECK ("action_kind" <> 'digest' or ("trigger_kind" = 'schedule' and "target_kind" = 'dm')),
	CONSTRAINT "automations_max_runs_per_day_check" CHECK ("max_runs_per_day" between 1 and 288),
	CONSTRAINT "automations_consecutive_failures_check" CHECK ("consecutive_failures" >= 0),
	CONSTRAINT "automations_version_check" CHECK ("version" >= 1),
	CONSTRAINT "automations_paused_reason_len_check" CHECK ("paused_reason" is null or char_length("paused_reason") <= 200),
	CONSTRAINT "automations_config_check" CHECK (jsonb_typeof("inbound_config") = 'object' and jsonb_typeof("config") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app"."mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL CONSTRAINT "mailboxes_automation_uq" UNIQUE,
	"owner_user_id" uuid NOT NULL,
	"vault_item_id" uuid,
	"host" text NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"poll_interval_minutes" integer DEFAULT 5 NOT NULL,
	"uid_validity" bigint,
	"last_uid" bigint,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_new_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "mailboxes_host_len_check" CHECK (char_length("host") between 1 and 253),
	CONSTRAINT "mailboxes_port_check" CHECK ("port" between 1 and 65535),
	CONSTRAINT "mailboxes_folder_len_check" CHECK (char_length("folder") between 1 and 200),
	CONSTRAINT "mailboxes_poll_interval_check" CHECK ("poll_interval_minutes" in (5,10,15,30,60)),
	CONSTRAINT "mailboxes_status_check" CHECK ("status" in ('active','auth_failed','unreachable','paused')),
	CONSTRAINT "mailboxes_last_new_count_check" CHECK ("last_new_count" >= 0),
	CONSTRAINT "mailboxes_last_error_code_len_check" CHECK ("last_error_code" is null or char_length("last_error_code") <= 64)
);
--> statement-breakpoint
CREATE TABLE "app"."watched_record_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"watched_record_id" uuid NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"before_hash" text,
	"after_hash" text NOT NULL,
	"message_id" uuid,
	CONSTRAINT "watched_record_changes_source_check" CHECK ("source" in ('access','schedule','write','manual')),
	CONSTRAINT "watched_record_changes_before_hash_check" CHECK ("before_hash" is null or "before_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "watched_record_changes_after_hash_check" CHECK ("after_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app"."watched_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"card_message_id" uuid NOT NULL CONSTRAINT "watched_records_card_uq" UNIQUE,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"read_tool" text NOT NULL,
	"write_tool" text,
	"note_tool" text,
	"id_arg" text NOT NULL,
	"fields" jsonb NOT NULL,
	"snapshot" jsonb,
	"snapshot_hash" text,
	"last_written_hash" text,
	"check_as_user_id" uuid NOT NULL,
	"check_interval_minutes" integer DEFAULT 60 NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"last_status" text DEFAULT 'ok' NOT NULL,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watched_records_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "watched_records_external_ref_len_check" CHECK (char_length("external_ref") between 1 and 200),
	CONSTRAINT "watched_records_tools_len_check" CHECK (char_length("read_tool") between 1 and 200
        and ("write_tool" is null or char_length("write_tool") between 1 and 200)
        and ("note_tool" is null or char_length("note_tool") between 1 and 200)),
	CONSTRAINT "watched_records_id_arg_len_check" CHECK (char_length("id_arg") between 1 and 100),
	CONSTRAINT "watched_records_fields_check" CHECK (jsonb_typeof("fields") = 'array'),
	CONSTRAINT "watched_records_snapshot_hash_check" CHECK ("snapshot_hash" is null or "snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "watched_records_last_written_hash_check" CHECK ("last_written_hash" is null or "last_written_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "watched_records_interval_check" CHECK ("check_interval_minutes" in (15,30,60,240,1440)),
	CONSTRAINT "watched_records_last_status_check" CHECK ("last_status" in ('ok','changed','not_connected','unreachable','error')),
	CONSTRAINT "watched_records_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"automation_id" uuid,
	"public_id" text NOT NULL CONSTRAINT "webhook_endpoints_public_id_uq" UNIQUE,
	"secret_id" uuid,
	"previous_secret_id" uuid,
	"previous_valid_until" timestamp with time zone,
	"secret_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_rejected_at" timestamp with time zone,
	"last_rejected_reason" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "webhook_endpoints_public_id_check" CHECK ("public_id" ~* '^[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "webhook_endpoints_rejected_reason_check" CHECK ("last_rejected_reason" is null
        or "last_rejected_reason" in ('signature','timestamp','too_large','rate_limited'))
);
--> statement-breakpoint
CREATE TABLE "app"."work_memory_prefs" (
	"organization_id" uuid,
	"user_id" uuid,
	"auto_propose" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_memory_prefs_pkey" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."work_session_memory" (
	"work_session_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid,
	"status" text NOT NULL,
	"approval_id" uuid,
	"summarized_seq" bigint,
	"auto" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_session_memory_status_check" CHECK ("status" in ('writing','proposed','failed')),
	CONSTRAINT "work_session_memory_error_code_len_check" CHECK ("error_code" is null or char_length("error_code") <= 64)
);
--> statement-breakpoint
ALTER TABLE "app"."ai_usage_records" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "max_automations_per_user" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "min_schedule_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "max_inbound_per_hour" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "max_runs_per_day_cap" integer DEFAULT 96 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD COLUMN "status_label" text;--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD COLUMN "notices" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_usage_records" ALTER COLUMN "generation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_usage_records" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."board_cards" ADD CONSTRAINT "board_cards_message_conversation_uq" UNIQUE("message_id","conversation_id");--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD CONSTRAINT "mcp_servers_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "app"."vault_items" ADD CONSTRAINT "vault_items_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_records_subject_kind_uq" ON "app"."ai_usage_records" ("subject_id","kind") WHERE subject_id is not null;--> statement-breakpoint
CREATE INDEX "automation_drafts_run_as_idx" ON "app"."automation_drafts" ("organization_id","run_as_user_id","status");--> statement-breakpoint
CREATE INDEX "automation_drafts_event_idx" ON "app"."automation_drafts" ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "automation_drafts_agent_idx" ON "app"."automation_drafts" ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "automation_drafts_conversation_idx" ON "app"."automation_drafts" ("organization_id","conversation_id") WHERE conversation_id is not null;--> statement-breakpoint
CREATE INDEX "automation_drafts_automation_idx" ON "app"."automation_drafts" ("automation_id") WHERE automation_id is not null;--> statement-breakpoint
CREATE INDEX "automation_events_thread_idx" ON "app"."automation_events" ("organization_id","thread_key");--> statement-breakpoint
CREATE INDEX "automation_events_message_idx" ON "app"."automation_events" ("message_id") WHERE message_id is not null;--> statement-breakpoint
CREATE INDEX "automation_events_retention_idx" ON "app"."automation_events" ("received_at") WHERE content_purged_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_scheduled_uq" ON "app"."automation_runs" ("automation_id","scheduled_for") WHERE scheduled_for is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_inbound_uq" ON "app"."automation_runs" ("automation_id","inbound_event_id") WHERE inbound_event_id is not null;--> statement-breakpoint
CREATE INDEX "automation_runs_delivered_idx" ON "app"."automation_runs" ("status","delivered_at") WHERE status = 'delivered';--> statement-breakpoint
CREATE INDEX "automation_runs_automation_idx" ON "app"."automation_runs" ("automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_runs_anchor_idx" ON "app"."automation_runs" ("anchor_message_id") WHERE anchor_message_id is not null;--> statement-breakpoint
CREATE INDEX "automation_runs_inbound_event_idx" ON "app"."automation_runs" ("inbound_event_id") WHERE inbound_event_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "automations_digest_uq" ON "app"."automations" ("organization_id","run_as_user_id") WHERE action_kind = 'digest';--> statement-breakpoint
CREATE INDEX "automations_due_idx" ON "app"."automations" ("next_run_at") WHERE status = 'active' and trigger_kind = 'schedule';--> statement-breakpoint
CREATE INDEX "automations_run_as_idx" ON "app"."automations" ("organization_id","run_as_user_id");--> statement-breakpoint
CREATE INDEX "automations_agent_idx" ON "app"."automations" ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "automations_conversation_idx" ON "app"."automations" ("organization_id","conversation_id") WHERE conversation_id is not null;--> statement-breakpoint
CREATE INDEX "automations_board_column_idx" ON "app"."automations" ("board_column_id") WHERE board_column_id is not null;--> statement-breakpoint
CREATE INDEX "mailboxes_vault_item_idx" ON "app"."mailboxes" ("organization_id","vault_item_id") WHERE vault_item_id is not null;--> statement-breakpoint
CREATE INDEX "mailboxes_due_idx" ON "app"."mailboxes" ("next_poll_at") WHERE status in ('active','unreachable');--> statement-breakpoint
CREATE INDEX "watched_record_changes_record_idx" ON "app"."watched_record_changes" ("organization_id","watched_record_id","detected_at");--> statement-breakpoint
CREATE INDEX "watched_record_changes_message_idx" ON "app"."watched_record_changes" ("message_id") WHERE message_id is not null;--> statement-breakpoint
CREATE INDEX "watched_records_due_idx" ON "app"."watched_records" ("next_check_at");--> statement-breakpoint
CREATE INDEX "watched_records_conversation_idx" ON "app"."watched_records" ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "watched_records_agent_idx" ON "app"."watched_records" ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "watched_records_mcp_server_idx" ON "app"."watched_records" ("organization_id","mcp_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_automation_uq" ON "app"."webhook_endpoints" ("automation_id") WHERE automation_id is not null;--> statement-breakpoint
CREATE INDEX "work_session_memory_unit_idx" ON "app"."work_session_memory" ("organization_id","unit_id") WHERE unit_id is not null;--> statement-breakpoint
ALTER TABLE "app"."automation_drafts" ADD CONSTRAINT "automation_drafts_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_drafts" ADD CONSTRAINT "automation_drafts_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_drafts" ADD CONSTRAINT "automation_drafts_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_drafts" ADD CONSTRAINT "automation_drafts_thread_root_fk" FOREIGN KEY ("thread_root_message_id","conversation_id") REFERENCES "app"."messages"("id","conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_drafts" ADD CONSTRAINT "automation_drafts_automation_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "app"."automations"("organization_id","id") ON DELETE SET NULL ("automation_id");--> statement-breakpoint
ALTER TABLE "app"."automation_events" ADD CONSTRAINT "automation_events_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_events" ADD CONSTRAINT "automation_events_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_events" ADD CONSTRAINT "automation_events_webhook_endpoint_fk" FOREIGN KEY ("organization_id","webhook_endpoint_id") REFERENCES "app"."webhook_endpoints"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_events" ADD CONSTRAINT "automation_events_mailbox_fk" FOREIGN KEY ("organization_id","mailbox_id") REFERENCES "app"."mailboxes"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_anchor_message_id_messages_id_fkey" FOREIGN KEY ("anchor_message_id") REFERENCES "app"."messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_automation_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "app"."automations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_inbound_event_fk" FOREIGN KEY ("organization_id","inbound_event_id") REFERENCES "app"."automation_events"("organization_id","id") ON DELETE SET NULL ("inbound_event_id");--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_thread_root_fk" FOREIGN KEY ("thread_root_message_id","conversation_id") REFERENCES "app"."messages"("id","conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_board_column_fk" FOREIGN KEY ("board_column_id","conversation_id") REFERENCES "app"."board_columns"("id","conversation_id");--> statement-breakpoint
ALTER TABLE "app"."mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mailboxes" ADD CONSTRAINT "mailboxes_automation_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "app"."automations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mailboxes" ADD CONSTRAINT "mailboxes_vault_item_fk" FOREIGN KEY ("organization_id","vault_item_id") REFERENCES "app"."vault_items"("organization_id","id") ON DELETE SET NULL ("vault_item_id");--> statement-breakpoint
ALTER TABLE "app"."watched_record_changes" ADD CONSTRAINT "watched_record_changes_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."watched_record_changes" ADD CONSTRAINT "watched_record_changes_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."watched_record_changes" ADD CONSTRAINT "watched_record_changes_record_fk" FOREIGN KEY ("organization_id","watched_record_id") REFERENCES "app"."watched_records"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."watched_records" ADD CONSTRAINT "watched_records_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."watched_records" ADD CONSTRAINT "watched_records_card_fk" FOREIGN KEY ("card_message_id","conversation_id") REFERENCES "app"."board_cards"("message_id","conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."watched_records" ADD CONSTRAINT "watched_records_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."watched_records" ADD CONSTRAINT "watched_records_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."watched_records" ADD CONSTRAINT "watched_records_mcp_server_fk" FOREIGN KEY ("organization_id","mcp_server_id") REFERENCES "app"."mcp_servers"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_automation_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "app"."automations"("organization_id","id") ON DELETE SET NULL ("automation_id");--> statement-breakpoint
ALTER TABLE "app"."work_memory_prefs" ADD CONSTRAINT "work_memory_prefs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_session_memory" ADD CONSTRAINT "work_session_memory_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_session_memory" ADD CONSTRAINT "work_session_memory_session_fk" FOREIGN KEY ("organization_id","work_session_id") REFERENCES "app"."work_sessions"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_session_memory" ADD CONSTRAINT "work_session_memory_unit_fk" FOREIGN KEY ("organization_id","unit_id") REFERENCES "app"."org_units"("organization_id","id") ON DELETE SET NULL ("unit_id");--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_max_automations_per_user_check" CHECK ("max_automations_per_user" between 0 and 1000);--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_min_schedule_minutes_check" CHECK ("min_schedule_minutes" between 1 and 1440);--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_max_inbound_per_hour_check" CHECK ("max_inbound_per_hour" between 1 and 3600);--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_max_runs_per_day_cap_check" CHECK ("max_runs_per_day_cap" between 1 and 288);--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD CONSTRAINT "message_cards_status_label_len_check" CHECK ("status_label" is null or char_length("status_label") between 1 and 24);--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD CONSTRAINT "message_cards_notices_check" CHECK (jsonb_typeof("notices") = 'array' and jsonb_array_length("notices") <= 3);--> statement-breakpoint
ALTER TABLE "app"."ai_usage_records" DROP CONSTRAINT "ai_usage_records_kind_check", ADD CONSTRAINT "ai_usage_records_kind_check" CHECK (("kind" in ('chat','title') and "generation_id" is not null and "conversation_id" is not null)
        or ("kind" in ('digest','session_summary') and "subject_id" is not null and "generation_id" is null));--> statement-breakpoint
ALTER TABLE "app"."secrets" DROP CONSTRAINT "secrets_kind_check", ADD CONSTRAINT "secrets_kind_check" CHECK ("kind" in ('provider_api_key','mcp_credential','user_model_credential','connector_credential','vault_item','browser_session','webhook_secret'));