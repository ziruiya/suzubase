CREATE TABLE "record_search_values" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "record_search_values_tenant_id_app_id_record_id_field_id_kind_pk" PRIMARY KEY("tenant_id","app_id","record_id","field_id","kind")
);
--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "search_mode" text;--> statement-breakpoint
ALTER TABLE "record_search_values" ADD CONSTRAINT "record_search_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_search_values" ADD CONSTRAINT "record_search_values_tenant_id_app_id_record_id_records_tenant_id_app_id_id_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_search_values" ADD CONSTRAINT "record_search_values_tenant_id_app_id_field_id_fields_tenant_id_app_id_field_id_fk" FOREIGN KEY ("tenant_id","app_id","field_id") REFERENCES "public"."fields"("tenant_id","app_id","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_search_values_prefix_idx" ON "record_search_values" USING btree ("tenant_id","app_id","field_id","kind","value" text_pattern_ops);
--> statement-breakpoint
ALTER TABLE record_search_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON record_search_values TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON record_search_values TO suzubase_runtime;
