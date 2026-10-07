ALTER TABLE "app"."attachments" ADD COLUMN "work_prompt_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD COLUMN "large_bytes" integer;--> statement-breakpoint
CREATE INDEX "attachments_org_work_prompt_idx" ON "app"."attachments" ("organization_id","work_prompt_id");--> statement-breakpoint
CREATE INDEX "work_sessions_conversation_idx" ON "app"."work_sessions" ("organization_id","conversation_id");--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_work_prompt_id_work_prompts_id_fkey" FOREIGN KEY ("work_prompt_id") REFERENCES "app"."work_prompts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_one_link_check" CHECK ("message_id" is null or "work_prompt_id" is null);