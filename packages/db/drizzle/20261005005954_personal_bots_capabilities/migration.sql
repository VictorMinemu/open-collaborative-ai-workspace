CREATE TABLE "app"."agent_limit_notices" (
	"organization_id" uuid NOT NULL,
	"agent_id" uuid,
	"conversation_id" uuid,
	"day" date,
	CONSTRAINT "agent_limit_notices_pkey" PRIMARY KEY("agent_id","conversation_id","day")
);
--> statement-breakpoint
CREATE TABLE "app"."agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memories_text_len_check" CHECK (char_length("text") <= 500)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid,
	"target" text,
	"decision" text NOT NULL,
	"reason" text,
	"status" text,
	"result_count" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_tool_calls_source_kind_check" CHECK ("source_kind" in ('builtin','mcp','plugin')),
	CONSTRAINT "agent_tool_calls_decision_check" CHECK ("decision" in ('allowed','denied')),
	CONSTRAINT "agent_tool_calls_status_check" CHECK ("status" is null or "status" in ('ok','error','blocked'))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_turns" (
	"event_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"conversation_kind" text NOT NULL,
	"message_id" uuid NOT NULL,
	"tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"tool_flags" jsonb DEFAULT '{}' NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"web_calls" integer DEFAULT 0 NOT NULL,
	"tainted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agent_usage_daily" (
	"organization_id" uuid,
	"agent_id" uuid,
	"day" date,
	"turns" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_usage_daily_pkey" PRIMARY KEY("organization_id","agent_id","day")
);
--> statement-breakpoint
CREATE TABLE "app"."bot_policies" (
	"organization_id" uuid PRIMARY KEY,
	"capabilities" jsonb DEFAULT '{}' NOT NULL,
	"search_provider" text DEFAULT 'duckduckgo' NOT NULL,
	"max_personal_bots_per_user" integer DEFAULT 3 NOT NULL,
	"personal_daily_limit_max" integer DEFAULT 100 NOT NULL,
	"personal_allowed_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."bot_tool_grants" (
	"organization_id" uuid NOT NULL,
	"agent_id" uuid,
	"source_kind" text,
	"source_id" uuid,
	"tool_name" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_tool_grants_pkey" PRIMARY KEY("agent_id","source_kind","source_id","tool_name"),
	CONSTRAINT "bot_tool_grants_source_kind_check" CHECK ("source_kind" in ('mcp','plugin'))
);
--> statement-breakpoint
CREATE TABLE "app"."cell_plugin_tools" (
	"organization_id" uuid NOT NULL,
	"plugin_row_id" uuid,
	"name" text,
	"description" text,
	"side_effecting" boolean DEFAULT true NOT NULL,
	CONSTRAINT "cell_plugin_tools_pkey" PRIMARY KEY("plugin_row_id","name")
);
--> statement-breakpoint
CREATE TABLE "app"."cell_plugins" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"package_name" text NOT NULL,
	"plugin_id" text,
	"version" text NOT NULL,
	"channel" text NOT NULL,
	"publisher" text,
	"artifact_sha256" text NOT NULL,
	"npm_integrity" text,
	"artifact_url" text,
	"risk" text NOT NULL,
	"risk_reasons" jsonb DEFAULT '[]' NOT NULL,
	"declared" jsonb DEFAULT '{}' NOT NULL,
	"status" text NOT NULL,
	"status_detail" text,
	"org_enabled" boolean DEFAULT true NOT NULL,
	"personal_allowed" boolean DEFAULT false NOT NULL,
	"trusted_chaining" boolean DEFAULT false NOT NULL,
	"flow_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_plugins_channel_check" CHECK ("channel" in ('official','community')),
	CONSTRAINT "cell_plugins_risk_check" CHECK ("risk" in ('low','medium','high','refuse')),
	CONSTRAINT "cell_plugins_status_check" CHECK ("status" in ('approved','installing','installed','failed','uninstalling','uninstalled'))
);
--> statement-breakpoint
CREATE TABLE "app"."mcp_server_tools" (
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"name" text,
	"openclaw_name" text NOT NULL,
	"title" text,
	"description" text,
	"read_only" boolean DEFAULT false NOT NULL,
	"destructive" boolean DEFAULT false NOT NULL,
	CONSTRAINT "mcp_server_tools_pkey" PRIMARY KEY("server_id","name")
);
--> statement-breakpoint
CREATE TABLE "app"."mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"safe_name" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"sandbox_server" text,
	"headers" jsonb DEFAULT '[]' NOT NULL,
	"org_enabled" boolean DEFAULT true NOT NULL,
	"personal_allowed" boolean DEFAULT false NOT NULL,
	"trusted_chaining" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_detail" text,
	"probed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_transport_check" CHECK ("transport" in ('streamable-http','sse','sandboxed-stdio')),
	CONSTRAINT "mcp_servers_status_check" CHECK ("status" in ('pending','probing','ready','error'))
);
--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "scope" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "capabilities" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD COLUMN "dm_key" text;--> statement-breakpoint
CREATE INDEX "agent_memories_owner_idx" ON "app"."agent_memories" ("organization_id","agent_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_org_event_idx" ON "app"."agent_tool_calls" ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "agent_turns_org_agent_time_idx" ON "app"."agent_turns" ("organization_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "app"."agents" ("organization_id","owner_user_id") WHERE scope = 'personal' and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "cell_plugins_org_package_uq" ON "app"."cell_plugins" ("organization_id","package_name") WHERE status <> 'uninstalled';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_dm_key_uq" ON "app"."conversations" ("organization_id","dm_key") WHERE kind = 'dm';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_org_safe_name_uq" ON "app"."mcp_servers" ("organization_id","safe_name");--> statement-breakpoint
ALTER TABLE "app"."agent_limit_notices" ADD CONSTRAINT "agent_limit_notices_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_memories" ADD CONSTRAINT "agent_memories_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD CONSTRAINT "agent_turns_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD CONSTRAINT "agent_turns_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_usage_daily" ADD CONSTRAINT "agent_usage_daily_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_usage_daily" ADD CONSTRAINT "agent_usage_daily_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_tool_grants" ADD CONSTRAINT "bot_tool_grants_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_tool_grants" ADD CONSTRAINT "bot_tool_grants_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."cell_plugin_tools" ADD CONSTRAINT "cell_plugin_tools_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."cell_plugin_tools" ADD CONSTRAINT "cell_plugin_tools_plugin_row_id_cell_plugins_id_fkey" FOREIGN KEY ("plugin_row_id") REFERENCES "app"."cell_plugins"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."cell_plugins" ADD CONSTRAINT "cell_plugins_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mcp_server_tools" ADD CONSTRAINT "mcp_server_tools_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mcp_server_tools" ADD CONSTRAINT "mcp_server_tools_server_id_mcp_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "app"."mcp_servers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD CONSTRAINT "mcp_servers_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_scope_check" CHECK ("scope" in ('team','personal'));--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_owner_scope_check" CHECK (("scope" = 'personal') = ("owner_user_id" is not null));