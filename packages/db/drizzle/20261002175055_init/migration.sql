CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TABLE "app"."agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."agents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"avatar_url" text,
	"description" text,
	"instructions" text NOT NULL,
	"model_provider" text NOT NULL,
	"model_id" text NOT NULL,
	"runtime" text DEFAULT 'openclaw' NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"status_message" text,
	"runtime_ref" jsonb DEFAULT '{}' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"agent_id" uuid,
	"user_id" uuid,
	"device_id" uuid,
	"session_id" text,
	"client_kind" text,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "app"."conversation_members" (
	"conversation_id" uuid,
	"organization_id" uuid NOT NULL,
	"member_kind" text,
	"member_id" uuid,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "conversation_members_pkey" PRIMARY KEY("conversation_id","member_kind","member_id")
);
--> statement-breakpoint
CREATE TABLE "app"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"slug" text,
	"topic" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"parent_conversation_id" uuid,
	"root_message_id" uuid,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."device_enrollments" (
	"code_hash" text PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"runtime_info" jsonb DEFAULT '[]' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"thread_id" uuid,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"client_kind" text,
	"session_id" text,
	"client_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."model_providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret_id" uuid,
	"allowed_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."org_members" (
	"id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
	"organization_id" uuid,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"email" text,
	"avatar_url" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_pkey" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"local_id" text NOT NULL,
	"name" text NOT NULL,
	"git_remote" text,
	"default_branch" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."secrets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."stream_events" (
	"stream_id" text,
	"seq" bigint,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stream_events_pkey" PRIMARY KEY("stream_id","seq")
);
--> statement-breakpoint
CREATE TABLE "app"."streams" (
	"id" text PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"work_session_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decision" text,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."work_prompts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"work_session_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"origin_device_id" uuid,
	"body" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."work_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"runtime" text DEFAULT 'claude-code' NOT NULL,
	"model" text,
	"permission_mode" text DEFAULT 'default' NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"title" text NOT NULL,
	"created_by" uuid NOT NULL,
	"runtime_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."instance_setup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"singleton" boolean DEFAULT true NOT NULL UNIQUE,
	"organization_id" uuid NOT NULL,
	"redeemed_by" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"team_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"active_organization_id" uuid
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_credentials_org_idx" ON "app"."agent_credentials" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_username_uq" ON "app"."agents" ("organization_id","username");--> statement-breakpoint
CREATE INDEX "audit_events_org_time_idx" ON "app"."audit_events" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "conversation_members_member_idx" ON "app"."conversation_members" ("organization_id","member_kind","member_id");--> statement-breakpoint
CREATE INDEX "conversations_org_kind_idx" ON "app"."conversations" ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_slug_uq" ON "app"."conversations" ("organization_id","slug") WHERE kind = 'channel' and slug is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_thread_root_uq" ON "app"."conversations" ("organization_id","root_message_id") WHERE root_message_id is not null;--> statement-breakpoint
CREATE INDEX "device_enrollments_org_idx" ON "app"."device_enrollments" ("organization_id");--> statement-breakpoint
CREATE INDEX "devices_org_idx" ON "app"."devices" ("organization_id");--> statement-breakpoint
CREATE INDEX "messages_conv_seq_idx" ON "app"."messages" ("organization_id","conversation_id","seq");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "app"."messages" ("organization_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_org_provider_uq" ON "app"."model_providers" ("organization_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_device_local_uq" ON "app"."projects" ("device_id","local_id");--> statement-breakpoint
CREATE INDEX "secrets_org_idx" ON "app"."secrets" ("organization_id");--> statement-breakpoint
CREATE INDEX "stream_events_org_idx" ON "app"."stream_events" ("organization_id");--> statement-breakpoint
CREATE INDEX "streams_org_idx" ON "app"."streams" ("organization_id");--> statement-breakpoint
CREATE INDEX "work_approvals_session_idx" ON "app"."work_approvals" ("organization_id","work_session_id");--> statement-breakpoint
CREATE INDEX "work_prompts_session_idx" ON "app"."work_prompts" ("organization_id","work_session_id","position");--> statement-breakpoint
CREATE INDEX "work_sessions_org_idx" ON "app"."work_sessions" ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "auth"."account" ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_org_idx" ON "auth"."invitation" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_uq" ON "auth"."member" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "auth"."session" ("user_id");--> statement-breakpoint
ALTER TABLE "app"."agent_credentials" ADD CONSTRAINT "agent_credentials_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."audit_events" ADD CONSTRAINT "audit_events_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."conversation_members" ADD CONSTRAINT "conversation_members_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."device_enrollments" ADD CONSTRAINT "device_enrollments_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."model_providers" ADD CONSTRAINT "model_providers_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."model_providers" ADD CONSTRAINT "model_providers_secret_id_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "app"."secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."org_members" ADD CONSTRAINT "org_members_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."org_members" ADD CONSTRAINT "org_members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_device_id_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "app"."devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD CONSTRAINT "secrets_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."stream_events" ADD CONSTRAINT "stream_events_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."streams" ADD CONSTRAINT "streams_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_approvals" ADD CONSTRAINT "work_approvals_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_approvals" ADD CONSTRAINT "work_approvals_work_session_id_work_sessions_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "app"."work_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD CONSTRAINT "work_prompts_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD CONSTRAINT "work_prompts_work_session_id_work_sessions_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "app"."work_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_device_id_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "app"."devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;