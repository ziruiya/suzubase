ALTER TYPE "public"."field_type" ADD VALUE 'table' BEFORE 'related';--> statement-breakpoint
CREATE TABLE "record_table_rows" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"row_order" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "record_table_rows_tenant_id_app_id_record_id_field_id_row_id_pk" PRIMARY KEY("tenant_id","app_id","record_id","field_id","row_id"),
	CONSTRAINT "record_table_rows_tenant_id_app_id_record_id_field_id_row_order_unique" UNIQUE("tenant_id","app_id","record_id","field_id","row_order"),
	CONSTRAINT "record_table_rows_data_object" CHECK (jsonb_typeof("record_table_rows"."data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "table" jsonb;--> statement-breakpoint
ALTER TABLE "record_table_rows" ADD CONSTRAINT "record_table_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_table_rows" ADD CONSTRAINT "record_table_rows_record_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_table_rows" ADD CONSTRAINT "record_table_rows_field_fk" FOREIGN KEY ("tenant_id","app_id","field_id") REFERENCES "public"."fields"("tenant_id","app_id","field_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE record_table_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON record_table_rows TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON record_table_rows TO suzubase_runtime;
