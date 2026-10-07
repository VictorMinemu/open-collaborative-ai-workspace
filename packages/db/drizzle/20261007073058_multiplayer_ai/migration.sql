CREATE TABLE "app"."ai_chat_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid,
	"level" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "ai_chat_grants_subject_kind_check" CHECK ("subject_kind" in ('user','unit','org')),
	CONSTRAINT "ai_chat_grants_subject_check" CHECK (("subject_kind" = 'org') = ("subject_id" is null)),
	CONSTRAINT "ai_chat_grants_level_check" CHECK ("level" in ('chat','view'))
);
--> statement-breakpoint
CREATE TABLE "app"."ai_message_context" (
	"message_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"access" text NOT NULL,
	"grant_id" uuid,
	"level" text,
	"addressed" boolean DEFAULT false NOT NULL,
	"answered_by_generation_id" uuid,
	"skip_reason" text,
	"model" jsonb,
	"tools" jsonb DEFAULT '{}' NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_message_context_author_kind_check" CHECK ("author_kind" in ('user','agent')),
	CONSTRAINT "ai_message_context_access_check" CHECK ("access" in ('owner','grant','agent_member')),
	CONSTRAINT "ai_message_context_level_check" CHECK ("level" is null or "level" in ('owner','chat'))
);
--> statement-breakpoint
CREATE TABLE "app"."message_card_follows" (
	"organization_id" uuid NOT NULL,
	"message_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_card_follows_pkey" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."message_cards" (
	"message_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"fields" jsonb DEFAULT '[]' NOT NULL,
	"status" text NOT NULL,
	"actions" jsonb DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"decision" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_cards_kind_check" CHECK ("kind" in ('work_zone','approval','report','artifact','automation','deployment','pr','generic')),
	CONSTRAINT "message_cards_status_check" CHECK ("status" in ('info','pending','running','succeeded','failed','cancelled')),
	CONSTRAINT "message_cards_title_len_check" CHECK (char_length("title") <= 200),
	CONSTRAINT "message_cards_decision_check" CHECK ("decision" is null or "decision" in ('approved','denied'))
);
--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
CREATE INDEX "agents_unit_idx" ON "app"."agents" ("organization_id","unit_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_chat_grants_active_uq" ON "app"."ai_chat_grants" ("conversation_id","subject_kind",coalesce("subject_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "ai_chat_grants_subject_idx" ON "app"."ai_chat_grants" ("organization_id","subject_kind","subject_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "ai_chat_grants_conv_idx" ON "app"."ai_chat_grants" ("organization_id","conversation_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "ai_message_context_queue_idx" ON "app"."ai_message_context" ("organization_id","conversation_id","created_at") WHERE addressed and answered_by_generation_id is null and skip_reason is null;--> statement-breakpoint
CREATE INDEX "ai_message_context_answered_idx" ON "app"."ai_message_context" ("answered_by_generation_id");--> statement-breakpoint
CREATE INDEX "message_card_follows_user_idx" ON "app"."message_card_follows" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "message_cards_conv_idx" ON "app"."message_cards" ("organization_id","conversation_id");--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_unit_id_org_units_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "app"."org_units"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."ai_chat_grants" ADD CONSTRAINT "ai_chat_grants_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_chat_grants" ADD CONSTRAINT "ai_chat_grants_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_message_context" ADD CONSTRAINT "ai_message_context_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_message_context" ADD CONSTRAINT "ai_message_context_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_message_context" ADD CONSTRAINT "ai_message_context_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_message_context" ADD CONSTRAINT "ai_message_context_grant_id_ai_chat_grants_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "app"."ai_chat_grants"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_message_context" ADD CONSTRAINT "ai_message_context_TfCJ8DLlUbSc_fkey" FOREIGN KEY ("answered_by_generation_id") REFERENCES "app"."ai_generations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."message_card_follows" ADD CONSTRAINT "message_card_follows_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_card_follows" ADD CONSTRAINT "message_card_follows_message_id_message_cards_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."message_cards"("message_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD CONSTRAINT "message_cards_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD CONSTRAINT "message_cards_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD CONSTRAINT "message_cards_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."message_cards" ADD CONSTRAINT "message_cards_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id");--> statement-breakpoint
ALTER TABLE "app"."agents" DROP CONSTRAINT "agents_owner_scope_check", ADD CONSTRAINT "agents_owner_scope_check" CHECK (("scope" <> 'personal' or "owner_user_id" is not null));--> statement-breakpoint
ALTER TABLE "app"."notifications" DROP CONSTRAINT "notifications_kind_check", ADD CONSTRAINT "notifications_kind_check" CHECK ("kind" in ('mention','channel','here','dm','group_dm','thread_reply','ai_chat_shared','card_updated'));