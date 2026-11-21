ALTER TABLE "app_versions" ADD COLUMN "view_configuration" jsonb DEFAULT '{"views":[],"defaultId":null}'::jsonb NOT NULL;
--> statement-breakpoint
GRANT UPDATE (view_configuration) ON app_versions TO suzubase_runtime;
