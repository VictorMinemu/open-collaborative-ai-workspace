CREATE TABLE "app"."device_commands" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"work_session_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "daemon_version" text;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "worktree" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "last_local_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "device_commands_device_status_idx" ON "app"."device_commands" ("organization_id","device_id","status","created_at");--> statement-breakpoint
ALTER TABLE "app"."device_commands" ADD CONSTRAINT "device_commands_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."device_commands" ADD CONSTRAINT "device_commands_device_id_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "app"."devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."device_commands" ADD CONSTRAINT "device_commands_work_session_id_work_sessions_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "app"."work_sessions"("id") ON DELETE CASCADE;