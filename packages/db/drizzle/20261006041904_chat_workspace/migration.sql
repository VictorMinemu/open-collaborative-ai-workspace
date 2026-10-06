CREATE TABLE "app"."attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"uploader_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"declared_type" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint NOT NULL,
	"sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"scan_status" text DEFAULT 'not_scanned' NOT NULL,
	"width" integer,
	"height" integer,
	"has_renditions" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "attachments_status_check" CHECK ("status" in ('pending','ready','rejected','deleted')),
	CONSTRAINT "attachments_scan_status_check" CHECK ("scan_status" in ('not_scanned'))
);
--> statement-breakpoint
CREATE TABLE "app"."message_pins" (
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"pinned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_pins_pkey" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "app"."message_reactions" (
	"organization_id" uuid NOT NULL,
	"message_id" uuid,
	"conversation_id" uuid NOT NULL,
	"emoji" text,
	"member_kind" text,
	"member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_pkey" PRIMARY KEY("message_id","emoji","member_kind","member_id"),
	CONSTRAINT "message_reactions_emoji_len_check" CHECK (char_length("emoji") <= 32),
	CONSTRAINT "message_reactions_member_kind_check" CHECK ("member_kind" in ('user','agent'))
);
--> statement-breakpoint
CREATE TABLE "app"."message_saves" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_saves_pkey" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "app"."message_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]' NOT NULL,
	"edited_by_kind" text NOT NULL,
	"edited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_versions_kind_check" CHECK ("kind" in ('edit','delete')),
	CONSTRAINT "message_versions_edited_by_kind_check" CHECK ("edited_by_kind" in ('user','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "app"."notification_prefs" (
	"organization_id" uuid,
	"user_id" uuid,
	"dnd_until" timestamp with time zone,
	"desktop_enabled" boolean DEFAULT true NOT NULL,
	"web_enabled" boolean DEFAULT true NOT NULL,
	"default_level" text DEFAULT 'mentions' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_pkey" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "notification_prefs_default_level_check" CHECK ("default_level" in ('all','mentions','nothing'))
);
--> statement-breakpoint
CREATE TABLE "app"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"thread_root_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_kind_check" CHECK ("kind" in ('mention','channel','here','dm','group_dm','thread_reply')),
	CONSTRAINT "notifications_actor_kind_check" CHECK ("actor_kind" in ('user','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "app"."thread_reads" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"root_message_id" uuid,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_reads_pkey" PRIMARY KEY("user_id","root_message_id")
);
--> statement-breakpoint
ALTER TABLE "app"."conversation_members" ADD COLUMN "notify_level" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."conversation_members" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
CREATE INDEX "attachments_org_conv_idx" ON "app"."attachments" ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "attachments_org_message_idx" ON "app"."attachments" ("organization_id","message_id");--> statement-breakpoint
CREATE INDEX "attachments_sweep_idx" ON "app"."attachments" ("status","created_at") WHERE purged_at is null and status in ('pending','rejected','deleted');--> statement-breakpoint
CREATE INDEX "conversations_org_unit_idx" ON "app"."conversations" ("organization_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_group_key_uq" ON "app"."conversations" ("organization_id","dm_key") WHERE kind = 'group';--> statement-breakpoint
CREATE INDEX "message_reactions_org_conv_idx" ON "app"."message_reactions" ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "message_saves_org_user_idx" ON "app"."message_saves" ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_versions_message_version_uq" ON "app"."message_versions" ("message_id","version");--> statement-breakpoint
CREATE INDEX "message_versions_org_message_idx" ON "app"."message_versions" ("organization_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_message_uq" ON "app"."notifications" ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "notifications_org_user_created_idx" ON "app"."notifications" ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "app"."notifications" ("organization_id","user_id","conversation_id") WHERE read_at is null;--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_unit_id_org_units_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "app"."org_units"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."message_pins" ADD CONSTRAINT "message_pins_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_pins" ADD CONSTRAINT "message_pins_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_pins" ADD CONSTRAINT "message_pins_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_reactions" ADD CONSTRAINT "message_reactions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_saves" ADD CONSTRAINT "message_saves_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_saves" ADD CONSTRAINT "message_saves_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_versions" ADD CONSTRAINT "message_versions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_versions" ADD CONSTRAINT "message_versions_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."notification_prefs" ADD CONSTRAINT "notification_prefs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD CONSTRAINT "notifications_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD CONSTRAINT "notifications_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD CONSTRAINT "notifications_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."thread_reads" ADD CONSTRAINT "thread_reads_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."thread_reads" ADD CONSTRAINT "thread_reads_root_message_id_messages_id_fkey" FOREIGN KEY ("root_message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."conversation_members" ADD CONSTRAINT "conversation_members_notify_level_check" CHECK ("notify_level" in ('default','all','mentions','nothing'));--> statement-breakpoint
-- Hand-written (drizzle has no builder for extensions, text search configurations or STORED generated
-- tsvector columns; same practice as identity_org). Search: D-04, ADR-0016, 04-RESEARCH §Code Examples.
-- `search_tsv` is deliberately not in the drizzle schema: only the search module reads it, with raw SQL.
create extension if not exists unaccent with schema app;--> statement-breakpoint
create extension if not exists pg_trgm with schema app;--> statement-breakpoint
create text search configuration app.ocw_simple (copy = pg_catalog.simple);--> statement-breakpoint
alter text search configuration app.ocw_simple alter mapping for hword, hword_part, word with app.unaccent, simple;--> statement-breakpoint
create text search configuration app.ocw_es (copy = pg_catalog.spanish);--> statement-breakpoint
alter text search configuration app.ocw_es alter mapping for hword, hword_part, word with app.unaccent, spanish_stem;--> statement-breakpoint
create text search configuration app.ocw_en (copy = pg_catalog.english);--> statement-breakpoint
alter text search configuration app.ocw_en alter mapping for hword, hword_part, word with app.unaccent, english_stem;--> statement-breakpoint
alter table app.messages add column search_tsv tsvector generated always as (
  setweight(to_tsvector('app.ocw_simple', body), 'A')
  || to_tsvector('app.ocw_es', body) || to_tsvector('app.ocw_en', body)) stored;--> statement-breakpoint
create index messages_search_gin on app.messages using gin (search_tsv);--> statement-breakpoint
create index org_members_name_trgm on app.org_members using gin (display_name app.gin_trgm_ops);--> statement-breakpoint
create index conversations_name_trgm on app.conversations using gin (name app.gin_trgm_ops);--> statement-breakpoint
create index agents_name_trgm on app.agents using gin (name app.gin_trgm_ops);
