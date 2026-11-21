ALTER TABLE "apps" ADD COLUMN "local_drafts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "local_drafts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "time_zone" text DEFAULT 'Asia/Tokyo' NOT NULL;
--> statement-breakpoint
GRANT UPDATE (local_drafts, time_zone) ON tenants TO suzubase_runtime;
GRANT UPDATE (local_drafts) ON apps TO suzubase_runtime;
