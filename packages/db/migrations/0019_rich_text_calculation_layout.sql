ALTER TYPE "public"."field_type" ADD VALUE 'richText';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'calculation';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'layout';--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "formula" jsonb;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "layout_element" jsonb;