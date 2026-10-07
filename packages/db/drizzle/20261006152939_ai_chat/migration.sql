CREATE TABLE "app"."ai_chat_policies" (
	"organization_id" uuid PRIMARY KEY,
	"chatgpt_plan_enabled" boolean DEFAULT true NOT NULL,
	"org_keys_enabled" boolean DEFAULT true NOT NULL,
	"plan_allowed_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"org_key_daily_generations" integer DEFAULT 200,
	"org_key_daily_cost_micros" bigint,
	"plan_daily_generations" integer,
	"concurrent_generations_per_user" integer DEFAULT 3 NOT NULL,
	"max_context_tokens" integer DEFAULT 64000 NOT NULL,
	"web_enabled" boolean DEFAULT true NOT NULL,
	"title_models" jsonb DEFAULT '{}' NOT NULL,
	"chatgpt_host_id" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."ai_chat_shares" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"title" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"attachment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."ai_chats" (
	"conversation_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title_source" text DEFAULT 'heuristic' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"use_personal_instructions" boolean DEFAULT true NOT NULL,
	"tools" jsonb DEFAULT '{"web":false}' NOT NULL,
	"last_model" jsonb,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_chats_title_source_check" CHECK ("title_source" in ('user','heuristic','auto')),
	CONSTRAINT "ai_chats_instructions_len_check" CHECK (char_length("instructions") <= 8000)
);
--> statement-breakpoint
CREATE TABLE "app"."ai_generations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_message_id" uuid,
	"assistant_message_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"error_param" text,
	"finish_reason" text,
	"partial_text" text DEFAULT '' NOT NULL,
	"instance_id" text NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"web_used" boolean DEFAULT false NOT NULL,
	"source_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ai_generations_backend_check" CHECK ("backend" in ('chatgpt_plan','org_key','mock')),
	CONSTRAINT "ai_generations_status_check" CHECK ("status" in ('running','completed','stopped','failed','interrupted'))
);
--> statement-breakpoint
CREATE TABLE "app"."ai_usage_daily" (
	"organization_id" uuid,
	"user_id" uuid,
	"day" date,
	"backend_class" text,
	"generations" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros_usd" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_daily_pkey" PRIMARY KEY("organization_id","user_id","day","backend_class"),
	CONSTRAINT "ai_usage_daily_backend_class_check" CHECK ("backend_class" in ('org_key','chatgpt_plan'))
);
--> statement-breakpoint
CREATE TABLE "app"."ai_usage_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"backend" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cached_input_tokens" integer,
	"reasoning_tokens" integer,
	"estimated" boolean DEFAULT false NOT NULL,
	"cost_micros_usd" bigint,
	"price_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_records_kind_check" CHECK ("kind" in ('chat','title'))
);
--> statement-breakpoint
CREATE TABLE "app"."ai_user_preferences" (
	"organization_id" uuid,
	"user_id" uuid,
	"instructions" text DEFAULT '' NOT NULL,
	"default_model" jsonb,
	"web_default" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_user_preferences_pkey" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "ai_user_preferences_instructions_len_check" CHECK (char_length("instructions") <= 8000)
);
--> statement-breakpoint
CREATE TABLE "app"."user_model_credentials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret_id" uuid,
	"issued_client_id" text,
	"subject" text,
	"email" text,
	"plan_type" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"access_expires_at" timestamp with time zone,
	"status" text NOT NULL,
	"last_error" text,
	"welcome_seen_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_model_credentials_provider_check" CHECK ("provider" in ('chatgpt_plan')),
	CONSTRAINT "user_model_credentials_status_check" CHECK ("status" in ('connected','needs_reconnect','not_eligible','plan_usage_disabled'))
);
--> statement-breakpoint
ALTER TABLE "app"."model_providers" ADD COLUMN "secret_ref" jsonb;--> statement-breakpoint
CREATE INDEX "ai_chat_shares_conversation_idx" ON "app"."ai_chat_shares" ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "ai_chats_owner_activity_idx" ON "app"."ai_chats" ("organization_id","owner_user_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_generations_one_running_uq" ON "app"."ai_generations" ("conversation_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "ai_generations_requester_started_idx" ON "app"."ai_generations" ("organization_id","requester_user_id","started_at");--> statement-breakpoint
CREATE INDEX "ai_generations_assistant_message_idx" ON "app"."ai_generations" ("organization_id","assistant_message_id");--> statement-breakpoint
CREATE INDEX "ai_generations_heartbeat_idx" ON "app"."ai_generations" ("heartbeat_at") WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_records_generation_kind_uq" ON "app"."ai_usage_records" ("generation_id","kind");--> statement-breakpoint
CREATE INDEX "ai_usage_records_org_time_idx" ON "app"."ai_usage_records" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_records_requester_time_idx" ON "app"."ai_usage_records" ("organization_id","requester_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_model_credentials_org_user_provider_uq" ON "app"."user_model_credentials" ("organization_id","user_id","provider");--> statement-breakpoint
ALTER TABLE "app"."ai_chat_policies" ADD CONSTRAINT "ai_chat_policies_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_chat_shares" ADD CONSTRAINT "ai_chat_shares_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_chat_shares" ADD CONSTRAINT "ai_chat_shares_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_chats" ADD CONSTRAINT "ai_chats_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_chats" ADD CONSTRAINT "ai_chats_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_generations" ADD CONSTRAINT "ai_generations_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_generations" ADD CONSTRAINT "ai_generations_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_generations" ADD CONSTRAINT "ai_generations_assistant_message_id_messages_id_fkey" FOREIGN KEY ("assistant_message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_usage_records" ADD CONSTRAINT "ai_usage_records_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_user_preferences" ADD CONSTRAINT "ai_user_preferences_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."user_model_credentials" ADD CONSTRAINT "user_model_credentials_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."user_model_credentials" ADD CONSTRAINT "user_model_credentials_secret_id_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "app"."secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."message_versions" DROP CONSTRAINT "message_versions_kind_check", ADD CONSTRAINT "message_versions_kind_check" CHECK ("kind" in ('edit','delete','regenerate'));