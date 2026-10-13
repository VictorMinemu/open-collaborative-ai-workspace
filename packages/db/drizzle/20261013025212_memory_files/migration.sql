CREATE TABLE "app"."approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"action_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_for_user_id" uuid,
	"event_id" uuid,
	"card_message_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"card_warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"consumed_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"result_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_mode_check" CHECK ("mode" in ('server_apply','grant')),
	CONSTRAINT "approval_requests_status_check" CHECK ("status" in ('pending','approved','denied','applied','failed','expired')),
	CONSTRAINT "approval_requests_action_hash_check" CHECK ("action_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "approval_requests_decision_note_len_check" CHECK ("decision_note" is null or char_length("decision_note") <= 280),
	CONSTRAINT "approval_requests_card_warnings_check" CHECK (cardinality("card_warnings") <= 3)
);
--> statement-breakpoint
CREATE TABLE "app"."memory_file_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"personal_owner_user_id" uuid,
	"version" integer NOT NULL,
	"op" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"lines_added" integer DEFAULT 0 NOT NULL,
	"lines_removed" integer DEFAULT 0 NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" uuid,
	"on_behalf_of_user_id" uuid,
	"approval_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_file_revisions_file_version_uq" UNIQUE("file_id","version"),
	CONSTRAINT "memory_file_revisions_op_check" CHECK ("op" in ('create','update','append','rename','delete','restore')),
	CONSTRAINT "memory_file_revisions_author_kind_check" CHECK ("author_kind" in ('user','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "app"."memory_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"personal_owner_user_id" uuid,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"bytes" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by_kind" text NOT NULL,
	"updated_by_id" uuid,
	"on_behalf_of_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_files_content_size_check" CHECK (octet_length("content") <= 262144),
	CONSTRAINT "memory_files_path_len_check" CHECK (char_length("path") <= 255),
	CONSTRAINT "memory_files_updated_by_kind_check" CHECK ("updated_by_kind" in ('user','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "app"."memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"personal_owner_user_id" uuid,
	"file_id" uuid,
	"path" text NOT NULL,
	"op" text NOT NULL,
	"base_version" integer,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"findings" jsonb DEFAULT '[]' NOT NULL,
	"reader_count" integer NOT NULL,
	"tainted" boolean NOT NULL,
	"reason" text,
	"requested_by_agent_id" uuid,
	"requested_for_user_id" uuid,
	"event_id" uuid,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_proposals_op_check" CHECK ("op" in ('create','replace','append')),
	CONSTRAINT "memory_proposals_content_size_check" CHECK (octet_length("content") <= 262144),
	CONSTRAINT "memory_proposals_reason_len_check" CHECK ("reason" is null or char_length("reason") <= 280)
);
--> statement-breakpoint
CREATE TABLE "app"."memory_scopes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"agent_id" uuid,
	"owner_user_id" uuid,
	"unit_id" uuid,
	"personal_owner_user_id" uuid,
	"origin" text DEFAULT 'app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_scopes_kind_check" CHECK ("kind" in ('personal','agent','unit','org')),
	CONSTRAINT "memory_scopes_shape_check" CHECK (("kind" = 'personal' and "agent_id" is not null and "owner_user_id" is not null and "unit_id" is null)
        or ("kind" = 'agent' and "agent_id" is not null and "owner_user_id" is null and "unit_id" is null)
        or ("kind" = 'unit' and "unit_id" is not null and "agent_id" is null and "owner_user_id" is null)
        or ("kind" = 'org' and "agent_id" is null and "owner_user_id" is null and "unit_id" is null)),
	CONSTRAINT "memory_scopes_origin_check" CHECK ("origin" in ('app','legacy_notes'))
);
--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD COLUMN "platform_owned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."permission_rules" ADD COLUMN "path_prefix" text;--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "app"."approval_requests" ("organization_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "approval_requests_resource_idx" ON "app"."approval_requests" ("organization_id","kind","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_card_message_uq" ON "app"."approval_requests" ("card_message_id") WHERE card_message_id is not null;--> statement-breakpoint
CREATE INDEX "memory_file_revisions_scope_idx" ON "app"."memory_file_revisions" ("organization_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_files_scope_path_uq" ON "app"."memory_files" ("scope_id",lower("path")) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "memory_files_scope_idx" ON "app"."memory_files" ("organization_id","scope_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "memory_proposals_scope_idx" ON "app"."memory_proposals" ("organization_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_scopes_personal_uq" ON "app"."memory_scopes" ("organization_id","agent_id","owner_user_id") WHERE kind = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_scopes_agent_uq" ON "app"."memory_scopes" ("organization_id","agent_id") WHERE kind = 'agent';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_scopes_unit_uq" ON "app"."memory_scopes" ("organization_id","unit_id") WHERE kind = 'unit';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_scopes_org_uq" ON "app"."memory_scopes" ("organization_id") WHERE kind = 'org';--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_requested_by_agent_id_agents_id_fkey" FOREIGN KEY ("requested_by_agent_id") REFERENCES "app"."agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_card_message_id_messages_id_fkey" FOREIGN KEY ("card_message_id") REFERENCES "app"."messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."memory_file_revisions" ADD CONSTRAINT "memory_file_revisions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_file_revisions" ADD CONSTRAINT "memory_file_revisions_file_id_memory_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "app"."memory_files"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_file_revisions" ADD CONSTRAINT "memory_file_revisions_approval_fk" FOREIGN KEY ("approval_request_id") REFERENCES "app"."approval_requests"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."memory_files" ADD CONSTRAINT "memory_files_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_files" ADD CONSTRAINT "memory_files_scope_id_memory_scopes_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "app"."memory_scopes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_proposals" ADD CONSTRAINT "memory_proposals_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_proposals" ADD CONSTRAINT "memory_proposals_scope_id_memory_scopes_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "app"."memory_scopes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_proposals" ADD CONSTRAINT "memory_proposals_file_id_memory_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "app"."memory_files"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."memory_proposals" ADD CONSTRAINT "memory_proposals_requested_by_agent_id_agents_id_fkey" FOREIGN KEY ("requested_by_agent_id") REFERENCES "app"."agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_scopes" ADD CONSTRAINT "memory_scopes_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_scopes" ADD CONSTRAINT "memory_scopes_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."memory_scopes" ADD CONSTRAINT "memory_scopes_unit_id_org_units_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "app"."org_units"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD CONSTRAINT "message_cards_decision_note_len_check" CHECK ("decision_note" is null or char_length("decision_note") <= 280);--> statement-breakpoint
ALTER TABLE "app"."permission_rules" ADD CONSTRAINT "permission_rules_path_prefix_check" CHECK ("path_prefix" is null or ("permission" like 'memory.%' and "path_prefix" like '%/'));--> statement-breakpoint
-- Hand-written (drizzle has no builder for STORED generated tsvector columns; same practice as chat_workspace).
-- Phase 07.2 (D-03, ADR-0016): memory search over the path words (`/ - _ .` read as spaces, weight A) and the content
-- in the three existing configurations (never re-created here). Kept out of the drizzle schema like
-- `messages.search_tsv`: only the memory search reads it, with raw SQL, always restricted to readable files.
alter table app.memory_files add column search_tsv tsvector generated always as (
  setweight(to_tsvector('app.ocw_simple', translate(path, '/-_.', '    ')), 'A')
  || to_tsvector('app.ocw_simple', content) || to_tsvector('app.ocw_es', content)
  || to_tsvector('app.ocw_en', content)) stored;--> statement-breakpoint
create index memory_files_search_gin on app.memory_files using gin (search_tsv);
