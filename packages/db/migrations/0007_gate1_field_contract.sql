ALTER TYPE "public"."field_type" ADD VALUE 'multiline' BEFORE 'number';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'radio';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'checkbox';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'select';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'multiselect';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'date';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'time';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'datetime';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'url';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'phone';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'email';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'user';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'organization';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'group';--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "options" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
GRANT UPDATE (required) ON fields TO suzubase_runtime;
