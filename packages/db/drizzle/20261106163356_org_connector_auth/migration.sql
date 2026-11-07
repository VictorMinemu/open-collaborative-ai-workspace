-- Phase 07.14 (D-01, D-06, D-15; ADR-0036): organization connector auth, additive only. `mcp_servers_auth_mode_check`
-- admits `org_oauth` and `org_client_credentials` (every existing server keeps its mode; the transport check already
-- refuses any mode but `org_secret` on the stdio sandbox). `mcp_servers.auth_failure` is the last organization sign-in
-- failure, null on every existing row, one of the eight closed codes otherwise. `app.connector_org_connections` holds the
-- organization's one account per server (tenant RLS from post-migrate.sql; the composite FK carries the organization).
-- Rollback (as ocw_migrator, only while no server uses an organization mode): drop the new table
-- app.connector_org_connections, then ALTER TABLE app.mcp_servers DROP CONSTRAINT mcp_servers_auth_failure_check, DROP
-- COLUMN auth_failure, DROP CONSTRAINT mcp_servers_auth_mode_check, ADD CONSTRAINT mcp_servers_auth_mode_check CHECK
-- (auth_mode in ('org_secret','per_member_oauth','per_member_secret'));
CREATE TABLE "app"."connector_org_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"secret_id" uuid,
	"issuer" text,
	"client_id" text,
	"token_endpoint" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"account_label" text,
	"access_expires_at" timestamp with time zone,
	"last_error" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "connector_org_connections_org_server_uq" UNIQUE("organization_id","server_id"),
	CONSTRAINT "connector_org_connections_status_check" CHECK ("status" in ('connected','needs_reconnect')),
	CONSTRAINT "connector_org_connections_method_check" CHECK ("method" in ('oauth','client_credentials')),
	CONSTRAINT "connector_org_connections_account_label_len_check" CHECK ("account_label" is null or char_length("account_label") <= 200),
	CONSTRAINT "connector_org_connections_last_error_len_check" CHECK ("last_error" is null or char_length("last_error") <= 64),
	CONSTRAINT "connector_org_connections_client_id_len_check" CHECK ("client_id" is null or char_length("client_id") <= 256),
	CONSTRAINT "connector_org_connections_token_endpoint_len_check" CHECK ("token_endpoint" is null or char_length("token_endpoint") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD COLUMN "auth_failure" text;--> statement-breakpoint
ALTER TABLE "app"."connector_org_connections" ADD CONSTRAINT "connector_org_connections_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."connector_org_connections" ADD CONSTRAINT "connector_org_connections_secret_id_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "app"."secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."connector_org_connections" ADD CONSTRAINT "connector_org_connections_mcp_server_fk" FOREIGN KEY ("organization_id","server_id") REFERENCES "app"."mcp_servers"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" ADD CONSTRAINT "mcp_servers_auth_failure_check" CHECK ("auth_failure" is null or "auth_failure" in ('https_required','discovery_failed','issuer_mismatch','token_endpoint_untrusted','pkce_unsupported','client_registration_unavailable','scope_rejected','token_exchange_failed'));--> statement-breakpoint
ALTER TABLE "app"."mcp_servers" DROP CONSTRAINT "mcp_servers_auth_mode_check", ADD CONSTRAINT "mcp_servers_auth_mode_check" CHECK ("auth_mode" in ('org_secret','per_member_oauth','per_member_secret','org_oauth','org_client_credentials'));