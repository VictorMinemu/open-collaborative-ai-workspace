CREATE TABLE "app"."agent_template_versions" (
	"organization_id" uuid NOT NULL,
	"template_id" uuid,
	"version" integer,
	"instructions" text NOT NULL,
	"model_provider" text NOT NULL,
	"model_id" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"tool_grants" jsonb DEFAULT '[]' NOT NULL,
	"required_connector_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"unit_vault_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_template_versions_pkey" PRIMARY KEY("template_id","version"),
	CONSTRAINT "agent_template_versions_version_check" CHECK ("version" >= 1),
	CONSTRAINT "agent_template_versions_tool_grants_check" CHECK (jsonb_typeof("tool_grants") = 'array' and jsonb_array_length("tool_grants") <= 64),
	CONSTRAINT "agent_template_versions_ids_check" CHECK (cardinality("required_connector_ids") <= 16 and cardinality("unit_vault_item_ids") <= 16)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"unit_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"current_version" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_templates_current_version_check" CHECK ("current_version" >= 1),
	CONSTRAINT "agent_templates_name_len_check" CHECK (char_length("name") between 1 and 80),
	CONSTRAINT "agent_templates_description_len_check" CHECK (char_length("description") <= 500)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_vault_grants" (
	"organization_id" uuid NOT NULL,
	"agent_id" uuid,
	"vault_item_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_vault_grants_pkey" PRIMARY KEY("agent_id","vault_item_id")
);
--> statement-breakpoint
CREATE TABLE "app"."connector_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"status" text NOT NULL,
	"secret_id" uuid,
	"issuer" text,
	"client_id" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"account_label" text,
	"access_expires_at" timestamp with time zone,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "connector_connections_org_user_server_uq" UNIQUE("organization_id","user_id","server_id"),
	CONSTRAINT "connector_connections_status_check" CHECK ("status" in ('connected','needs_reconnect')),
	CONSTRAINT "connector_connections_account_label_len_check" CHECK ("account_label" is null or char_length("account_label") <= 200),
	CONSTRAINT "connector_connections_last_error_len_check" CHECK ("last_error" is null or char_length("last_error") <= 64)
);
--> statement-breakpoint
CREATE TABLE "app"."connector_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_id" uuid,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_oauth_clients_server_issuer_uq" UNIQUE("server_id","issuer"),
	CONSTRAINT "connector_oauth_clients_method_check" CHECK ("method" in ('pre_registered','cimd','dcr'))
);
--> statement-breakpoint
CREATE TABLE "app"."member_account_shares" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"readers_at_grant" integer NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "member_account_shares_resource_kind_check" CHECK ("resource_kind" in ('connector','vault_item')),
	CONSTRAINT "member_account_shares_readers_check" CHECK ("readers_at_grant" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."vault_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" uuid,
	"unit_id" uuid,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"kind" text NOT NULL,
	"injection" jsonb NOT NULL,
	"allowed_hosts" text[] NOT NULL,
	"allowed_path_prefix" text,
	"token_url" text,
	"secret_ref" jsonb NOT NULL,
	"value_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "vault_items_org_handle_uq" UNIQUE("organization_id","handle"),
	CONSTRAINT "vault_items_scope_check" CHECK ("scope" in ('personal','unit')),
	CONSTRAINT "vault_items_scope_owner_check" CHECK (("scope" = 'personal' and "owner_user_id" is not null and "unit_id" is null)
        or ("scope" = 'unit' and "owner_user_id" is null)),
	CONSTRAINT "vault_items_kind_check" CHECK ("kind" in ('api_key','basic','oauth')),
	CONSTRAINT "vault_items_handle_check" CHECK ("handle" ~ '^k_[a-z2-7]{10}$'),
	CONSTRAINT "vault_items_name_len_check" CHECK (char_length("name") between 1 and 80),
	CONSTRAINT "vault_items_allowed_hosts_check" CHECK (cardinality("allowed_hosts") between 1 and 16),
	CONSTRAINT "vault_items_injection_check" CHECK (jsonb_typeof("injection") = 'object'),
	CONSTRAINT "vault_items_secret_ref_check" CHECK (jsonb_typeof("secret_ref") = 'object'
        and coalesce("secret_ref" ->> 'provider', '') in ('db','env','file','openbao'))
);
--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "egress_private_hosts" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."mcp_server_tools" ADD COLUMN "input_schema" jsonb;--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD COLUMN "auth_mode" text DEFAULT 'org_secret' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD COLUMN "member_header_name" text;--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD COLUMN "member_header_prefix" text;--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD COLUMN "oauth_scopes" text[];--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD COLUMN "oauth_status" text;--> statement-breakpoint
CREATE INDEX "agent_template_versions_org_idx" ON "app"."agent_template_versions" ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_templates_unit_idx" ON "app"."agent_templates" ("organization_id","unit_id");--> statement-breakpoint
CREATE INDEX "agent_vault_grants_item_idx" ON "app"."agent_vault_grants" ("organization_id","vault_item_id");--> statement-breakpoint
CREATE INDEX "agents_template_idx" ON "app"."agents" ("organization_id","template_id") WHERE template_id is not null;--> statement-breakpoint
CREATE INDEX "connector_connections_server_idx" ON "app"."connector_connections" ("server_id");--> statement-breakpoint
CREATE INDEX "connector_oauth_clients_org_idx" ON "app"."connector_oauth_clients" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_account_shares_active_uq" ON "app"."member_account_shares" ("user_id","conversation_id","resource_kind","resource_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "member_account_shares_conversation_idx" ON "app"."member_account_shares" ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "vault_items_owner_idx" ON "app"."vault_items" ("organization_id","owner_user_id") WHERE scope = 'personal';--> statement-breakpoint
CREATE INDEX "vault_items_unit_idx" ON "app"."vault_items" ("organization_id","unit_id") WHERE scope = 'unit';--> statement-breakpoint
ALTER TABLE "app"."agent_template_versions" ADD CONSTRAINT "agent_template_versions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_template_versions" ADD CONSTRAINT "agent_template_versions_template_id_agent_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "app"."agent_templates"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_templates" ADD CONSTRAINT "agent_templates_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_templates" ADD CONSTRAINT "agent_templates_unit_id_org_units_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "app"."org_units"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."agent_vault_grants" ADD CONSTRAINT "agent_vault_grants_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_vault_grants" ADD CONSTRAINT "agent_vault_grants_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_vault_grants" ADD CONSTRAINT "agent_vault_grants_vault_item_id_vault_items_id_fkey" FOREIGN KEY ("vault_item_id") REFERENCES "app"."vault_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_template_id_agent_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "app"."agent_templates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."connector_connections" ADD CONSTRAINT "connector_connections_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."connector_connections" ADD CONSTRAINT "connector_connections_server_id_mcp_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "app"."mcp_servers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."connector_connections" ADD CONSTRAINT "connector_connections_secret_id_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "app"."secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."connector_oauth_clients" ADD CONSTRAINT "connector_oauth_clients_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."connector_oauth_clients" ADD CONSTRAINT "connector_oauth_clients_server_id_mcp_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "app"."mcp_servers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."connector_oauth_clients" ADD CONSTRAINT "connector_oauth_clients_client_secret_id_secrets_id_fkey" FOREIGN KEY ("client_secret_id") REFERENCES "app"."secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."member_account_shares" ADD CONSTRAINT "member_account_shares_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."member_account_shares" ADD CONSTRAINT "member_account_shares_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."vault_items" ADD CONSTRAINT "vault_items_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."vault_items" ADD CONSTRAINT "vault_items_unit_id_org_units_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "app"."org_units"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_template_version_check" CHECK ("template_version" is null or "template_version" >= 1);--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_egress_private_hosts_check" CHECK (cardinality("egress_private_hosts") <= 64);--> statement-breakpoint
ALTER TABLE "app"."mcp_server_tools" ADD CONSTRAINT "mcp_server_tools_input_schema_size_check" CHECK ("input_schema" is null or octet_length("input_schema"::text) <= 16384);--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD CONSTRAINT "mcp_servers_auth_mode_check" CHECK ("auth_mode" in ('org_secret','per_member_oauth','per_member_secret'));--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD CONSTRAINT "mcp_servers_auth_mode_transport_check" CHECK ("auth_mode" = 'org_secret' or "transport" <> 'sandboxed-stdio');--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD CONSTRAINT "mcp_servers_oauth_status_check" CHECK ("oauth_status" is null or "oauth_status" in ('ready','needs_client','https_required','error'));--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" DROP CONSTRAINT "agent_tool_calls_source_kind_check", ADD CONSTRAINT "agent_tool_calls_source_kind_check" CHECK ("source_kind" in ('builtin','mcp','plugin','vault'));