CREATE TABLE "csv_jobs" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"rows" jsonb NOT NULL,
	"headers" jsonb NOT NULL,
	"errors" jsonb NOT NULL,
	"lookup_columns" jsonb NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "csv_jobs_tenant_id_app_id_id_pk" PRIMARY KEY("tenant_id","app_id","id")
);
--> statement-breakpoint
ALTER TABLE "csv_jobs" ADD CONSTRAINT "csv_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_jobs" ADD CONSTRAINT "csv_jobs_tenant_id_user_id_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_jobs" ADD CONSTRAINT "csv_jobs_tenant_id_app_id_schema_version_app_versions_tenant_id_app_id_version_fk" FOREIGN KEY ("tenant_id","app_id","schema_version") REFERENCES "public"."app_versions"("tenant_id","app_id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE csv_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON csv_jobs TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON csv_jobs TO suzubase_runtime;
GRANT UPDATE (imported) ON csv_jobs TO suzubase_runtime;
