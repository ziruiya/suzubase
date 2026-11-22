-- Gate 3 Wave B (G3-06..G3-09): import jobs, migration channel, provenance.
-- apps gain an activation state: an application restored by an import stays
-- 'import-pending' (invisible through every ACL-scoped read path, which all
-- filter on activation_state = 'active') until the import job is activated.
ALTER TABLE "apps" ADD COLUMN "activation_state" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_activation_state_check" CHECK ("activation_state" IN ('active', 'import-pending'));
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"source_export_id" text,
	"source_instance_id" text,
	"source_tenant_id" text,
	"source_app_id" text,
	"source_app_code" text,
	"package_sha256" text NOT NULL,
	"package_bytes" integer NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"stage" text DEFAULT 'uploaded' NOT NULL,
	"target_app_id" uuid,
	"duplicate_of" uuid,
	"duplicate_confirmed" boolean DEFAULT false NOT NULL,
	"entity_mapping" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organization_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dependency_decisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completion" text,
	"report" jsonb,
	"error_report" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"execute_requested" boolean DEFAULT false NOT NULL,
	"execute_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "import_jobs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "import_jobs_status_check" CHECK ("status" IN ('uploaded','validating','staging','ready','activated','failed','cancelled')),
	CONSTRAINT "import_jobs_completion_check" CHECK ("completion" IS NULL OR "completion" IN ('complete','pending'))
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_target_app_fk" FOREIGN KEY ("tenant_id","target_app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON import_jobs TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON import_jobs TO suzubase_runtime;
--> statement-breakpoint
CREATE INDEX "import_jobs_duplicate_idx" ON "import_jobs" ("tenant_id", "package_sha256", "status");
--> statement-breakpoint
CREATE TABLE "migration_audit_log" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"import_job_id" uuid NOT NULL,
	"target_app_id" uuid,
	"operator_id" uuid NOT NULL,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text,
	"field_surface" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_audit_log_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "migration_audit_log" ADD CONSTRAINT "migration_audit_log_job_fk" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "public"."import_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "migration_audit_log" ADD CONSTRAINT "migration_audit_log_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE migration_audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON migration_audit_log TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON migration_audit_log TO suzubase_runtime;
--> statement-breakpoint
CREATE INDEX "migration_audit_log_job_idx" ON "migration_audit_log" ("tenant_id", "import_job_id", "created_at");
--> statement-breakpoint
-- Migration provenance (contracts 4 SS4.5.3): every migrated record, comment
-- and history event carries import_job_id + source_actor_id + source_timestamp;
-- the actual operator is the row's created_by / author_id / actor_id and is
-- additionally written to migration_audit_log for every channel write.
ALTER TABLE "records" ADD COLUMN "import_job_id" uuid;
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "source_actor_id" text;
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "source_actor_name" text;
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "source_timestamp" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "source_record_no" text;
--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_import_job_fk" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "public"."import_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "records_import_job_idx" ON "records" ("tenant_id", "import_job_id");
--> statement-breakpoint
ALTER TABLE "record_comments" ADD COLUMN "import_job_id" uuid;
--> statement-breakpoint
ALTER TABLE "record_comments" ADD COLUMN "source_actor_id" text;
--> statement-breakpoint
ALTER TABLE "record_comments" ADD COLUMN "source_actor_name" text;
--> statement-breakpoint
ALTER TABLE "record_comments" ADD COLUMN "source_timestamp" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_import_job_fk" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "public"."import_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "record_events" ADD COLUMN "import_job_id" uuid;
--> statement-breakpoint
ALTER TABLE "record_events" ADD COLUMN "source_actor_id" text;
--> statement-breakpoint
ALTER TABLE "record_events" ADD COLUMN "source_timestamp" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "record_events" ADD CONSTRAINT "record_events_import_job_fk" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "public"."import_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Migration tokens (decision 7): issued only by tenant administrators, bound to
-- one import job and (once staging creates it) its single target application.
-- Expiry is the earlier of 24 hours after issue and the job reaching a terminal
-- state (activated / failed / cancelled); the terminal-state half is enforced
-- inside verify_migration_token, the 24h half by expires_at. No renewal.
CREATE TABLE "authentication"."migration_tokens" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"import_job_id" uuid NOT NULL,
	"target_app_id" uuid,
	"issued_by" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "migration_tokens_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "migration_tokens_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "authentication"."migration_tokens" ADD CONSTRAINT "migration_tokens_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "authentication"."migration_tokens" ADD CONSTRAINT "migration_tokens_job_fk" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "public"."import_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "authentication"."migration_tokens" ADD CONSTRAINT "migration_tokens_issued_by_fk" FOREIGN KEY ("tenant_id","issued_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE authentication.migration_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON authentication.migration_tokens TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT (tenant_id, id, import_job_id, target_app_id, issued_by, expires_at, created_at, revoked_at),
  INSERT, UPDATE (revoked_at, target_app_id) ON authentication.migration_tokens TO suzubase_runtime;
--> statement-breakpoint
CREATE FUNCTION authentication.verify_migration_token(lookup_hash text)
RETURNS TABLE (tenant_id uuid, user_id uuid, import_job_id uuid, target_app_id uuid, expires_at timestamp with time zone)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.tenant_id, t.issued_by, t.import_job_id, COALESCE(t.target_app_id, j.target_app_id), t.expires_at
  FROM authentication.migration_tokens t
  JOIN public.import_jobs j ON j.tenant_id = t.tenant_id AND j.id = t.import_job_id
  JOIN public.tenant_members m ON m.tenant_id = t.tenant_id AND m.user_id = t.issued_by
  WHERE t.secret_hash = lookup_hash AND t.revoked_at IS NULL AND t.expires_at > now()
    AND m.disabled_at IS NULL
    AND j.status NOT IN ('activated', 'failed', 'cancelled')
    AND (t.target_app_id IS NULL OR j.target_app_id IS NULL OR t.target_app_id = j.target_app_id)
$$;
REVOKE ALL ON FUNCTION authentication.verify_migration_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authentication.verify_migration_token(text) TO suzubase_runtime;
