ALTER TYPE "public"."field_type" ADD VALUE 'autoNumber' BEFORE 'attachment';--> statement-breakpoint
CREATE TABLE "auto_number_counters" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"next_value" bigint NOT NULL,
	CONSTRAINT "auto_number_counters_tenant_id_app_id_field_id_scope_pk" PRIMARY KEY("tenant_id","app_id","field_id","scope")
);
--> statement-breakpoint
CREATE TABLE "issued_auto_numbers" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"number" bigint NOT NULL,
	CONSTRAINT "issued_auto_numbers_tenant_id_app_id_field_id_scope_number_pk" PRIMARY KEY("tenant_id","app_id","field_id","scope","number")
);
--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "auto_number" jsonb;--> statement-breakpoint
ALTER TABLE "auto_number_counters" ADD CONSTRAINT "auto_number_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_number_counters" ADD CONSTRAINT "auto_number_counters_tenant_id_app_id_field_id_fields_tenant_id_app_id_field_id_fk" FOREIGN KEY ("tenant_id","app_id","field_id") REFERENCES "public"."fields"("tenant_id","app_id","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_auto_numbers" ADD CONSTRAINT "issued_auto_numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_auto_numbers" ADD CONSTRAINT "issued_auto_numbers_tenant_id_app_id_field_id_scope_auto_number_counters_tenant_id_app_id_field_id_scope_fk" FOREIGN KEY ("tenant_id","app_id","field_id","scope") REFERENCES "public"."auto_number_counters"("tenant_id","app_id","field_id","scope") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE auto_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE issued_auto_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON auto_number_counters TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON issued_auto_numbers TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON auto_number_counters, issued_auto_numbers TO suzubase_runtime;
GRANT UPDATE (next_value) ON auto_number_counters TO suzubase_runtime;
