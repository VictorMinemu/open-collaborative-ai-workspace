CREATE TABLE "app"."board_cards" (
	"message_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"rank" text NOT NULL,
	"waiting_on" text DEFAULT 'none' NOT NULL,
	"title" text NOT NULL,
	"title_source" text DEFAULT 'heuristic' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"number" integer,
	"fields" jsonb DEFAULT '{}' NOT NULL,
	"external_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_cards_waiting_on_check" CHECK ("waiting_on" in ('none','us','customer','both')),
	CONSTRAINT "board_cards_title_source_check" CHECK ("title_source" in ('user','heuristic','auto')),
	CONSTRAINT "board_cards_title_len_check" CHECK (char_length("title") between 1 and 200),
	CONSTRAINT "board_cards_rank_len_check" CHECK (char_length("rank") between 1 and 128),
	CONSTRAINT "board_cards_number_check" CHECK ("number" is null or "number" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."board_columns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rank" text NOT NULL,
	"category" text NOT NULL,
	"default_waiting_on" text,
	"external_state_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_columns_id_conversation_uq" UNIQUE("id","conversation_id"),
	CONSTRAINT "board_columns_category_check" CHECK ("category" in ('backlog','started','done','cancelled')),
	CONSTRAINT "board_columns_default_waiting_on_check" CHECK ("default_waiting_on" is null or "default_waiting_on" in ('none','us','customer','both')),
	CONSTRAINT "board_columns_name_len_check" CHECK (char_length("name") between 1 and 60),
	CONSTRAINT "board_columns_rank_len_check" CHECK (char_length("rank") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "app"."boards" (
	"conversation_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"template_id" uuid,
	"prefix" text,
	"naming_rule" text,
	"fields" jsonb DEFAULT '[]' NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boards_prefix_check" CHECK ("prefix" is null or "prefix" ~ '^[A-Z0-9]{1,8}$'),
	CONSTRAINT "boards_naming_rule_len_check" CHECK ("naming_rule" is null or char_length("naming_rule") <= 120),
	CONSTRAINT "boards_last_number_check" CHECK ("last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."record_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"unit_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"prefix" text,
	"naming_rule" text,
	"fields" jsonb DEFAULT '[]' NOT NULL,
	"columns" jsonb DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_templates_name_len_check" CHECK (char_length("name") between 1 and 80),
	CONSTRAINT "record_templates_prefix_check" CHECK ("prefix" is null or "prefix" ~ '^[A-Z0-9]{1,8}$'),
	CONSTRAINT "record_templates_naming_rule_len_check" CHECK ("naming_rule" is null or char_length("naming_rule") <= 120)
);
--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD COLUMN "layout" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_id_conversation_uq" UNIQUE("id","conversation_id");--> statement-breakpoint
CREATE INDEX "board_cards_column_rank_idx" ON "app"."board_cards" ("organization_id","conversation_id","column_id","rank" COLLATE "C");--> statement-breakpoint
CREATE UNIQUE INDEX "board_cards_number_uq" ON "app"."board_cards" ("conversation_id","number") WHERE number is not null;--> statement-breakpoint
CREATE INDEX "board_columns_conv_idx" ON "app"."board_columns" ("organization_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_columns_conv_name_uq" ON "app"."board_columns" ("conversation_id",lower("name"));--> statement-breakpoint
CREATE INDEX "record_templates_unit_idx" ON "app"."record_templates" ("organization_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_templates_name_uq" ON "app"."record_templates" ("organization_id","unit_id",lower("name")) NULLS NOT DISTINCT;--> statement-breakpoint
ALTER TABLE "app"."board_cards" ADD CONSTRAINT "board_cards_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."board_cards" ADD CONSTRAINT "board_cards_message_fk" FOREIGN KEY ("message_id","conversation_id") REFERENCES "app"."messages"("id","conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."board_cards" ADD CONSTRAINT "board_cards_column_fk" FOREIGN KEY ("column_id","conversation_id") REFERENCES "app"."board_columns"("id","conversation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."board_cards" ADD CONSTRAINT "board_cards_board_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."boards"("conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."board_columns" ADD CONSTRAINT "board_columns_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."board_columns" ADD CONSTRAINT "board_columns_board_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."boards"("conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."boards" ADD CONSTRAINT "boards_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."boards" ADD CONSTRAINT "boards_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."boards" ADD CONSTRAINT "boards_template_id_record_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "app"."record_templates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."record_templates" ADD CONSTRAINT "record_templates_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."record_templates" ADD CONSTRAINT "record_templates_unit_id_org_units_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "app"."org_units"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_layout_check" CHECK ("layout" in ('text','board'));--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_layout_kind_check" CHECK ("layout" = 'text' or "kind" = 'channel');--> statement-breakpoint
-- Hand-written (drizzle 1.0.0-rc.4 has no column collation builder; same practice as identity_org and chat_workspace).
-- Phase 07.1 (D-05, Pitfall 1): fractional-indexing keys use 0-9A-Za-z and must sort by byte, exactly like
-- JavaScript's default sort, whatever the cluster's default collation is. The tables are new and empty here.
-- `record_templates_name_uq` above is NULLS NOT DISTINCT by hand too: organization-wide templates (unit_id null)
-- collide like any other pair.
ALTER TABLE "app"."board_columns" ALTER COLUMN "rank" TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "app"."board_cards" ALTER COLUMN "rank" TYPE text COLLATE "C";