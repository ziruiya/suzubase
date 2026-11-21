ALTER TYPE "public"."field_type" ADD VALUE 'lookup' BEFORE 'layout';--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "lookup" jsonb;
--> statement-breakpoint
GRANT UPDATE (target_app_id, target_record_id) ON record_references TO suzubase_runtime;
