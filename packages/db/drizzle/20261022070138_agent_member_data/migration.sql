-- Phase 07.8 (07.8-28; D-11, D-13, P-11; WINDOWS #292, ADR-0029): member data is sticky per (bot, conversation).
-- Once a member's sealed browser session was loaded in a turn of a bot in a conversation, the bot's history there may
-- hold what it read signed in, so every later turn of that bot in that conversation starts with
-- `agent_turns.member_data` (the floors, download routing, import refusal). One row per (organization, bot,
-- conversation): the site keys (hosts only) whose sessions were loaded there and the first such turn. Tenant isolation
-- comes from post-migrate (every `app` table with `organization_id`); the FKs are composite with the organization
-- (07.4 #169) and cascade with the bot or the conversation. Backfill: every (bot, conversation) with a turn that has
-- `member_data` gets its row, with the sites of the sessions its pages loaded (an empty list when the session is gone:
-- then every host needs the requester's approval, fail closed). The migrator bypasses RLS, so owner-only sessions count.
-- Chained after 20261022061052_browser_context_opened_host (P-17: earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.agent_member_data.
CREATE TABLE "app"."agent_member_data" (
	"organization_id" uuid,
	"agent_id" uuid,
	"conversation_id" uuid,
	"sites" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_member_data_pkey" PRIMARY KEY("organization_id","agent_id","conversation_id"),
	CONSTRAINT "agent_member_data_sites_check" CHECK (cardinality("sites") <= 64)
);
--> statement-breakpoint
ALTER TABLE "app"."agent_member_data" ADD CONSTRAINT "agent_member_data_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_member_data" ADD CONSTRAINT "agent_member_data_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_member_data" ADD CONSTRAINT "agent_member_data_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "app"."agent_member_data" ("organization_id", "agent_id", "conversation_id", "sites", "first_event_id")
SELECT t."organization_id", t."agent_id", t."conversation_id",
       coalesce((
         SELECT (array_agg(DISTINCT s."site_key"))[1:64]
           FROM "app"."browser_contexts" c
           JOIN "app"."browser_sessions" s ON s."organization_id" = c."organization_id" AND s."id" = c."session_id"
          WHERE c."organization_id" = t."organization_id" AND c."agent_id" = t."agent_id"
            AND c."conversation_id" = t."conversation_id"
       ), '{}'::text[]),
       (array_agg(t."event_id" ORDER BY t."created_at", t."event_id"))[1]
  FROM "app"."agent_turns" t
 WHERE t."member_data"
   AND EXISTS (SELECT 1 FROM "app"."conversations" v
                WHERE v."organization_id" = t."organization_id" AND v."id" = t."conversation_id")
 GROUP BY t."organization_id", t."agent_id", t."conversation_id"
ON CONFLICT DO NOTHING;
