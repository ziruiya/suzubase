CREATE TYPE "public"."runtime_index_state" AS ENUM('building', 'available', 'failed');--> statement-breakpoint
CREATE TABLE "runtime_indexes" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"field_id" uuid NOT NULL,
	"field_type" "field_type" NOT NULL,
	"purpose" text NOT NULL,
	"reason" text NOT NULL,
	"state" "runtime_index_state" DEFAULT 'building' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone,
	"failure_reason" text,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"problem_count" integer DEFAULT 0 NOT NULL,
	"retire_requested" timestamp with time zone,
	"retire_reason" text,
	"retired_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "runtime_indexes_tenant_id_app_id_id_pk" PRIMARY KEY("tenant_id","app_id","id"),
	CONSTRAINT "runtime_index_purpose" CHECK ("runtime_indexes"."purpose" IN ('filter','sort','search'))
);
--> statement-breakpoint
ALTER TABLE "runtime_indexes" ADD CONSTRAINT "runtime_indexes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_indexes" ADD CONSTRAINT "runtime_indexes_tenant_id_app_id_field_id_fields_tenant_id_app_id_field_id_fk" FOREIGN KEY ("tenant_id","app_id","field_id") REFERENCES "public"."fields"("tenant_id","app_id","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_indexes" ADD CONSTRAINT "runtime_indexes_tenant_id_requested_by_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE runtime_indexes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON runtime_indexes TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON runtime_indexes TO suzubase_runtime;
GRANT UPDATE (reason, state, requested_by, requested_at, available_at, failure_reason, problems, problem_count,
  retire_requested, retire_reason, retired_at, last_used_at) ON runtime_indexes TO suzubase_runtime;
