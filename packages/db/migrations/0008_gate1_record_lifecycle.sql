CREATE TABLE "record_unique_values" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"normalized_value" text NOT NULL,
	"record_id" uuid NOT NULL,
	CONSTRAINT "record_unique_values_tenant_id_app_id_field_id_normalized_value_pk" PRIMARY KEY("tenant_id","app_id","field_id","normalized_value")
);
--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "unique_value" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "record_unique_values" ADD CONSTRAINT "record_unique_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_unique_values" ADD CONSTRAINT "record_unique_values_tenant_id_app_id_field_id_fields_tenant_id_app_id_field_id_fk" FOREIGN KEY ("tenant_id","app_id","field_id") REFERENCES "public"."fields"("tenant_id","app_id","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_unique_values" ADD CONSTRAINT "record_unique_values_tenant_id_app_id_record_id_records_tenant_id_app_id_id_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_unique_values_tenant_id_app_id_record_id_index" ON "record_unique_values" USING btree ("tenant_id","app_id","record_id");
--> statement-breakpoint
ALTER TABLE record_unique_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON record_unique_values TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON record_unique_values TO suzubase_runtime;
GRANT UPDATE (deleted_at, deleted_by) ON records TO suzubase_runtime;
