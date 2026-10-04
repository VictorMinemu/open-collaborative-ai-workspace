CREATE TABLE "app"."org_units" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" uuid[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_units_kind_check" CHECK ("kind" in ('department','team','project'))
);
--> statement-breakpoint
CREATE TABLE "app"."permission_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"scope_unit_id" uuid,
	"subject_kind" text NOT NULL,
	"subject_id" text,
	"permission" text NOT NULL,
	"tool" text,
	"effect" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_rules_subject_kind_check" CHECK ("subject_kind" in ('everyone','role','user','agent')),
	CONSTRAINT "permission_rules_effect_check" CHECK ("effect" in ('allow','deny'))
);
--> statement-breakpoint
CREATE TABLE "app"."unit_memberships" (
	"organization_id" uuid NOT NULL,
	"unit_id" uuid,
	"user_id" uuid,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_memberships_pkey" PRIMARY KEY("unit_id","user_id"),
	CONSTRAINT "unit_memberships_role_check" CHECK ("role" in ('member','lead'))
);
--> statement-breakpoint
CREATE TABLE "auth"."jwks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
ALTER TABLE "app"."org_members" ADD COLUMN "status_emoji" text;--> statement-breakpoint
ALTER TABLE "app"."org_members" ADD COLUMN "status_text" text;--> statement-breakpoint
ALTER TABLE "app"."org_members" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "client_kind" text;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "client_label" text;--> statement-breakpoint
CREATE INDEX "org_units_parent_idx" ON "app"."org_units" ("organization_id","parent_id");--> statement-breakpoint
CREATE INDEX "org_units_path_gin" ON "app"."org_units" USING gin ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "org_units_sibling_name_uq" ON "app"."org_units" ("organization_id","parent_id",lower("name")) NULLS NOT DISTINCT;--> statement-breakpoint
CREATE INDEX "permission_rules_org_idx" ON "app"."permission_rules" ("organization_id");--> statement-breakpoint
CREATE INDEX "unit_memberships_user_idx" ON "app"."unit_memberships" ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "app"."org_units" ADD CONSTRAINT "org_units_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."org_units" ADD CONSTRAINT "org_units_parent_id_org_units_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "app"."org_units"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."permission_rules" ADD CONSTRAINT "permission_rules_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."permission_rules" ADD CONSTRAINT "permission_rules_scope_unit_id_org_units_id_fkey" FOREIGN KEY ("scope_unit_id") REFERENCES "app"."org_units"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."unit_memberships" ADD CONSTRAINT "unit_memberships_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."unit_memberships" ADD CONSTRAINT "unit_memberships_unit_id_org_units_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "app"."org_units"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."unit_memberships" ADD CONSTRAINT "unit_memberships_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;