CREATE TABLE "deployment_instance" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "deployment_instance_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT INTO "deployment_instance" ("id", "instance_id") OVERRIDING SYSTEM VALUE VALUES (1, gen_random_uuid()) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "deployment_instance" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY instance_read ON "deployment_instance" TO suzubase_runtime USING (true);
--> statement-breakpoint
GRANT SELECT ON "deployment_instance" TO suzubase_runtime;
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot_cutoff" timestamp with time zone,
	"manifest" jsonb,
	"package_sha256" text,
	"package_bytes" integer,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone,
	CONSTRAINT "export_jobs_tenant_id_app_id_id_pk" PRIMARY KEY("tenant_id","app_id","id"),
	CONSTRAINT "export_jobs_status_check" CHECK ("status" IN ('queued','running','sealed','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_tenant_id_requested_by_tenant_members_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON export_jobs TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON export_jobs TO suzubase_runtime;
--> statement-breakpoint
CREATE INDEX "export_jobs_queue_idx" ON "export_jobs" ("tenant_id", "status", "created_at");
