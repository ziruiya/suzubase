ALTER TABLE "app_versions" ADD COLUMN "field_edits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app_versions" ADD COLUMN "form_layout" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app_versions" ADD COLUMN "migration_report" jsonb;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "archived_data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD COLUMN "can_read_archived_fields" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
GRANT UPDATE (field_edits, form_layout, migration_report) ON app_versions TO suzubase_runtime;
GRANT UPDATE (schema_version, archived_data) ON records TO suzubase_runtime;
GRANT UPDATE (can_read_archived_fields) ON tenant_members TO suzubase_runtime;
