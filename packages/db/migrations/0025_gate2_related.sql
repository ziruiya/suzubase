ALTER TYPE "public"."field_type" ADD VALUE 'related' BEFORE 'layout';--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "related" jsonb;