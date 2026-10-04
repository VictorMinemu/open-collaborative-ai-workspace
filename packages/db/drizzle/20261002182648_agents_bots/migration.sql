ALTER TABLE "app"."agents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."model_providers" ADD COLUMN "key_hint" text;--> statement-breakpoint
ALTER TABLE "app"."model_providers" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "app"."model_providers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DROP INDEX "app"."agents_org_username_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_username_uq" ON "app"."agents" ("organization_id","username") WHERE deleted_at is null;